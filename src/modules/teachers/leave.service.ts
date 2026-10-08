import { and, asc, count, desc, eq, inArray, lte, gte, ne, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import { leaveRequests, leaveTypes, teachers } from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { todayIso } from '../../shared/dates.js';
import {
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
} from '../../shared/errors.js';
import { offsetOf, orderFrom, pageOf } from '../../shared/pagination.js';
import { hasTenantWideScope } from '../access/authorization.service.js';
import type {
  CreateLeaveBody,
  CreateLeaveTypeBody,
  LeaveBalanceQuery,
  LeaveListQuery,
  UpdateLeaveTypeBody,
} from './leave.schemas.js';
import { addTeacherHistory, fullName } from './support.js';
import type { CalendarService } from '../calendar/calendar.service.js';
import { countDays } from '../calendar/calendar.rules.js';

type TypeRow = typeof leaveTypes.$inferSelect;
type LeaveRow = typeof leaveRequests.$inferSelect;

const DEFAULT_TYPES = [
  { code: 'CASUAL', name: 'Casual leave', annualQuota: 12, isPaid: true, sortOrder: 1 },
  { code: 'SICK', name: 'Sick leave', annualQuota: 10, isPaid: true, sortOrder: 2 },
  { code: 'UNPAID', name: 'Unpaid leave', annualQuota: null, isPaid: false, sortOrder: 3 },
];

const presentType = (t: TypeRow) => ({
  id: t.id,
  code: t.code,
  name: t.name,
  annual_quota: t.annualQuota,
  is_paid: t.isPaid,
  is_active: t.isActive,
  sort_order: t.sortOrder,
});

/** Inclusive calendar days between two ISO dates. */
export function daysBetween(start: string, end: string): number {
  const a = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
  const b = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10));
  return Math.round((b - a) / 86_400_000) + 1;
}

export class LeaveService {
  constructor(
    private readonly deps: Deps,
    private readonly calendar: CalendarService,
  ) {
    // Holidays / weekly off days changed → recount the leave they touch, in the same transaction.
    calendar.onChange((tx, tenantId, range, note, actor) =>
      this.recountForCalendar(tx, tenantId, range, note, actor),
    );
  }

  private get db() {
    return this.deps.db;
  }

  // ---- leave types ----------------------------------------------------------------------------

  private async ensureDefaults(tenantId: string) {
    const existing = await this.db
      .select({ id: leaveTypes.id })
      .from(leaveTypes)
      .where(eq(leaveTypes.tenantId, tenantId))
      .limit(1);
    if (existing.length) return;
    await this.db
      .insert(leaveTypes)
      .values(DEFAULT_TYPES.map((t) => ({ tenantId, ...t })))
      .onDuplicateKeyUpdate({ set: { code: sql`${leaveTypes.code}` } });
  }

  async listTypes(tenantId: string, includeInactive = false) {
    await this.ensureDefaults(tenantId);
    const rows = await this.db
      .select()
      .from(leaveTypes)
      .where(
        and(
          eq(leaveTypes.tenantId, tenantId),
          includeInactive ? undefined : eq(leaveTypes.isActive, true),
        ),
      )
      .orderBy(asc(leaveTypes.sortOrder), asc(leaveTypes.name));
    return rows.map(presentType);
  }

  async createType(tenantId: string, input: z.infer<typeof CreateLeaveTypeBody>, actor: Actor) {
    await this.ensureDefaults(tenantId);
    try {
      return await this.db.transaction(async (tx) => {
        const [ins] = await tx
          .insert(leaveTypes)
          .values({
            tenantId,
            code: input.code,
            name: input.name,
            annualQuota: input.annual_quota,
            isPaid: input.is_paid,
            sortOrder: input.sort_order,
          })
          .$returningId();
        const [row] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, ins!.id));
        await recordChange(tx, actor, tenantId, {
          action: 'LEAVE_TYPE_CREATED',
          entityType: 'leave_type',
          entityId: row!.id,
          after: presentType(row!),
        });
        return presentType(row!);
      });
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw new ConflictError('DUPLICATE_RESOURCE', 'A leave type with this code exists', {
          field: 'code',
        });
      throw err;
    }
  }

  async updateType(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateLeaveTypeBody>,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(leaveTypes)
        .where(and(eq(leaveTypes.id, id), eq(leaveTypes.tenantId, tenantId)))
        .for('update');
      if (!before) throw new NotFoundError('Leave type');
      await tx
        .update(leaveTypes)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.annual_quota !== undefined ? { annualQuota: input.annual_quota } : {}),
          ...(input.is_paid !== undefined ? { isPaid: input.is_paid } : {}),
          ...(input.is_active !== undefined ? { isActive: input.is_active } : {}),
          ...(input.sort_order !== undefined ? { sortOrder: input.sort_order } : {}),
        })
        .where(eq(leaveTypes.id, id));
      const [after] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, id));
      await recordChange(tx, actor, tenantId, {
        action: 'LEAVE_TYPE_UPDATED',
        entityType: 'leave_type',
        entityId: id,
        before: presentType(before),
        after: presentType(after!),
      });
      return presentType(after!);
    });
  }

  // ---- who the caller is ----------------------------------------------------------------------

  private async ownTeacher(ex: Executor, tenantId: string, principal: Principal) {
    const [t] = await ex
      .select()
      .from(teachers)
      .where(
        and(eq(teachers.tenantId, tenantId), eq(teachers.membershipId, principal.membershipId)),
      );
    return t ?? null;
  }

  /** Everyone's leave (approvers) or only the caller's own. */
  private seesAll(principal: Principal) {
    return hasTenantWideScope(principal, 'leave.read');
  }

  // ---- reads ----------------------------------------------------------------------------------

  private present(r: LeaveRow, t: TypeRow, tc: typeof teachers.$inferSelect) {
    return {
      id: r.id,
      teacher: { id: tc.id, teacher_number: tc.teacherNumber, full_name: fullName(tc) },
      leave_type: { id: t.id, code: t.code, name: t.name, is_paid: t.isPaid },
      start_date: r.startDate,
      end_date: r.endDate,
      days: r.days,
      reason: r.reason,
      status: r.status,
      decided_at: r.decidedAt?.toISOString() ?? null,
      decision_note: r.decisionNote,
      version: r.version,
      created_at: r.createdAt.toISOString(),
    };
  }

  private joined(ex: Executor) {
    return ex
      .select({ r: leaveRequests, t: leaveTypes, tc: teachers })
      .from(leaveRequests)
      .innerJoin(
        leaveTypes,
        and(
          eq(leaveTypes.tenantId, leaveRequests.tenantId),
          eq(leaveTypes.id, leaveRequests.leaveTypeId),
        ),
      )
      .innerJoin(
        teachers,
        and(
          eq(teachers.tenantId, leaveRequests.tenantId),
          eq(teachers.id, leaveRequests.teacherId),
        ),
      );
  }

  async get(tenantId: string, id: string, principal: Principal, ex: Executor = this.db) {
    const own = this.seesAll(principal) ? null : await this.ownTeacher(ex, tenantId, principal);
    if (!this.seesAll(principal) && !own) throw new NotFoundError('Leave request');
    const [row] = await this.joined(ex).where(
      and(
        eq(leaveRequests.id, id),
        eq(leaveRequests.tenantId, tenantId),
        own ? eq(leaveRequests.teacherId, own.id) : undefined,
      ),
    );
    if (!row) throw new NotFoundError('Leave request');
    return this.present(row.r, row.t, row.tc);
  }

  async list(tenantId: string, q: z.infer<typeof LeaveListQuery>, principal: Principal) {
    const all = this.seesAll(principal);
    const own = all ? null : await this.ownTeacher(this.db, tenantId, principal);
    if (!all && !own) return pageOf([], 0, q);
    const conds: (SQL | undefined)[] = [
      eq(leaveRequests.tenantId, tenantId),
      own ? eq(leaveRequests.teacherId, own.id) : undefined,
      q.teacher_id ? eq(leaveRequests.teacherId, q.teacher_id) : undefined,
      q.status ? eq(leaveRequests.status, q.status) : undefined,
      q.from ? gte(leaveRequests.endDate, q.from) : undefined,
      q.to ? lte(leaveRequests.startDate, q.to) : undefined,
    ];
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.joined(this.db)
        .where(where)
        .orderBy(
          orderFrom(
            q,
            { start_date: leaveRequests.startDate, created_at: leaveRequests.createdAt },
            'start_date',
          ),
          desc(leaveRequests.id),
        )
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(leaveRequests).where(where),
    ]);
    return pageOf(
      rows.map((r) => this.present(r.r, r.t, r.tc)),
      total?.n ?? 0,
      q,
    );
  }

  /** Quota, approved days and pending days per leave type for one calendar year. */
  async balance(
    tenantId: string,
    q: z.infer<typeof LeaveBalanceQuery>,
    principal: Principal,
    ex: Executor = this.db,
  ) {
    const own = await this.ownTeacher(ex, tenantId, principal);
    const teacherId = q.teacher_id ?? own?.id;
    if (!teacherId) throw new NotFoundError('Teacher');
    if (teacherId !== own?.id && !this.seesAll(principal)) throw new NotFoundError('Teacher');
    const year = q.year ?? new Date(this.deps.clock.now()).getUTCFullYear();
    const types = await this.listTypes(tenantId, false);
    const used = await ex
      .select({
        typeId: leaveRequests.leaveTypeId,
        status: leaveRequests.status,
        days: sql<number>`COALESCE(SUM(${leaveRequests.days}), 0)`,
      })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.tenantId, tenantId),
          eq(leaveRequests.teacherId, teacherId),
          inArray(leaveRequests.status, ['PENDING', 'APPROVED']),
          sql`YEAR(${leaveRequests.startDate}) = ${year}`,
        ),
      )
      .groupBy(leaveRequests.leaveTypeId, leaveRequests.status);
    const sum = (typeId: string, status: string) =>
      Number(used.find((u) => u.typeId === typeId && u.status === status)?.days ?? 0);
    return {
      teacher_id: teacherId,
      year,
      types: types.map((t) => {
        const approved = sum(t.id, 'APPROVED');
        const pending = sum(t.id, 'PENDING');
        return {
          leave_type: { id: t.id, code: t.code, name: t.name, is_paid: t.is_paid },
          annual_quota: t.annual_quota,
          approved_days: approved,
          pending_days: pending,
          remaining: t.annual_quota === null ? null : t.annual_quota - approved - pending,
        };
      }),
    };
  }

  // ---- requests -------------------------------------------------------------------------------

  async create(
    tenantId: string,
    input: z.infer<typeof CreateLeaveBody>,
    principal: Principal,
    actor: Actor,
  ) {
    const own = await this.ownTeacher(this.db, tenantId, principal);
    const onBehalf = !!input.teacher_id && input.teacher_id !== own?.id;
    if (onBehalf && !(principal.permissions.has('leave.approve') && this.seesAll(principal)))
      throw new AuthorizationError('PERMISSION_DENIED', undefined, { permission: 'leave.approve' });
    const teacherId = input.teacher_id ?? own?.id;
    if (!teacherId)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'No staff record is linked to your login, so you cannot request leave',
      );
    if (input.end_date < input.start_date)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'The end date cannot be before the start date',
        { field: 'end_date' },
      );
    if (daysBetween(input.start_date, input.end_date) > 366)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'Leave cannot span more than a year', {
        field: 'end_date',
      });
    // Weekly off days and holidays are never counted as leave.
    const days = await this.leaveDays(tenantId, input.start_date, input.end_date);
    if (days === 0)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'Every selected day is a weekly off day or a school holiday',
        { field: 'end_date' },
      );
    const id = await this.db.transaction(async (tx) => {
      const [teacher] = await tx
        .select()
        .from(teachers)
        .where(and(eq(teachers.id, teacherId), eq(teachers.tenantId, tenantId)))
        .for('update');
      if (!teacher) throw new NotFoundError('Teacher');
      if (teacher.status !== 'ACTIVE' && teacher.status !== 'ON_LEAVE')
        throw new BusinessRuleError('INVALID_STATE', 'Only active staff can request leave', {
          teacher_status: teacher.status,
        });
      const [type] = await tx
        .select()
        .from(leaveTypes)
        .where(
          and(
            eq(leaveTypes.id, input.leave_type_id),
            eq(leaveTypes.tenantId, tenantId),
            eq(leaveTypes.isActive, true),
          ),
        );
      if (!type) throw new NotFoundError('Leave type');
      await this.assertNoOverlap(tx, tenantId, teacherId, input.start_date, input.end_date);
      await this.assertBalance(tx, tenantId, teacherId, type, input.start_date, days);
      const [ins] = await tx
        .insert(leaveRequests)
        .values({
          tenantId,
          teacherId,
          leaveTypeId: type.id,
          startDate: input.start_date,
          endDate: input.end_date,
          days,
          reason: input.reason ?? null,
          createdBy: actor.userId,
        })
        .$returningId();
      await addTeacherHistory(tx, actor, tenantId, teacherId, {
        eventType: 'LEAVE_REQUESTED',
        effectiveDate: input.start_date,
        reason: input.reason ?? null,
        details: {
          leave_id: ins!.id,
          type: type.code,
          start: input.start_date,
          end: input.end_date,
          days,
        },
      });
      await recordChange(tx, actor, tenantId, {
        action: 'LEAVE_REQUESTED',
        entityType: 'leave_request',
        entityId: ins!.id,
        event: 'leave.requested',
        after: {
          teacher_id: teacherId,
          type: type.code,
          start: input.start_date,
          end: input.end_date,
          days,
        },
        payload: { teacher_id: teacherId, start_date: input.start_date, end_date: input.end_date },
      });
      return ins!.id;
    });
    return this.get(tenantId, id, principal);
  }

  private async assertNoOverlap(
    ex: Executor,
    tenantId: string,
    teacherId: string,
    start: string,
    end: string,
    exceptId?: string,
  ) {
    const [clash] = await ex
      .select({ id: leaveRequests.id, s: leaveRequests.startDate, e: leaveRequests.endDate })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.tenantId, tenantId),
          eq(leaveRequests.teacherId, teacherId),
          inArray(leaveRequests.status, ['PENDING', 'APPROVED']),
          lte(leaveRequests.startDate, end),
          gte(leaveRequests.endDate, start),
          exceptId ? ne(leaveRequests.id, exceptId) : undefined,
        ),
      )
      .limit(1);
    if (clash)
      throw new ConflictError('CONFLICT', 'These dates overlap another leave request', {
        leave_id: clash.id,
        start_date: clash.s,
        end_date: clash.e,
      });
  }

  private async assertBalance(
    ex: Executor,
    tenantId: string,
    teacherId: string,
    type: TypeRow,
    start: string,
    days: number,
    exceptId?: string,
  ) {
    if (type.annualQuota === null) return;
    const year = +start.slice(0, 4);
    const [used] = await ex
      .select({ n: sql<number>`COALESCE(SUM(${leaveRequests.days}), 0)` })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.tenantId, tenantId),
          eq(leaveRequests.teacherId, teacherId),
          eq(leaveRequests.leaveTypeId, type.id),
          inArray(leaveRequests.status, ['PENDING', 'APPROVED']),
          sql`YEAR(${leaveRequests.startDate}) = ${year}`,
          exceptId ? ne(leaveRequests.id, exceptId) : undefined,
        ),
      );
    const remaining = type.annualQuota - Number(used?.n ?? 0);
    if (days > remaining)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        `Not enough ${type.name.toLowerCase()} left: ${Math.max(remaining, 0)} day(s) remaining, ${days} requested`,
        { remaining: Math.max(remaining, 0), requested: days, year },
      );
  }

  private async lockOpen(tx: Executor, tenantId: string, id: string) {
    const [row] = await tx
      .select()
      .from(leaveRequests)
      .where(and(eq(leaveRequests.id, id), eq(leaveRequests.tenantId, tenantId)))
      .for('update');
    if (!row) throw new NotFoundError('Leave request');
    return row;
  }

  private async decide(
    tenantId: string,
    id: string,
    to: 'APPROVED' | 'REJECTED',
    note: string | undefined,
    principal: Principal,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const row = await this.lockOpen(tx, tenantId, id);
      if (row.status !== 'PENDING')
        throw new BusinessRuleError('INVALID_STATE', 'Only pending requests can be decided', {
          leave_status: row.status,
        });
      const [self] = await tx
        .select({ id: teachers.id })
        .from(teachers)
        .where(
          and(eq(teachers.tenantId, tenantId), eq(teachers.membershipId, principal.membershipId)),
        );
      if (self?.id === row.teacherId)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'You cannot decide your own leave request',
        );
      if (to === 'APPROVED') {
        const [type] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, row.leaveTypeId));
        if (type)
          await this.assertBalance(
            tx,
            tenantId,
            row.teacherId,
            type,
            row.startDate,
            row.days,
            row.id,
          );
      }
      await tx
        .update(leaveRequests)
        .set({
          status: to,
          decidedBy: actor.userId,
          decidedAt: this.deps.clock.now(),
          decisionNote: note ?? null,
          version: row.version + 1,
        })
        .where(eq(leaveRequests.id, id));
      await addTeacherHistory(tx, actor, tenantId, row.teacherId, {
        eventType: to === 'APPROVED' ? 'LEAVE_APPROVED' : 'LEAVE_REJECTED',
        effectiveDate: row.startDate,
        reason: note ?? null,
        details: { leave_id: id, start: row.startDate, end: row.endDate, days: row.days },
      });
      await recordChange(tx, actor, tenantId, {
        action: to === 'APPROVED' ? 'LEAVE_APPROVED' : 'LEAVE_REJECTED',
        entityType: 'leave_request',
        entityId: id,
        event: to === 'APPROVED' ? 'leave.approved' : 'leave.rejected',
        before: { status: row.status },
        after: { status: to },
        reason: note,
        payload: { teacher_id: row.teacherId, start_date: row.startDate, end_date: row.endDate },
      });
    });
    return this.get(tenantId, id, principal);
  }

  approve(
    tenantId: string,
    id: string,
    note: string | undefined,
    principal: Principal,
    actor: Actor,
  ) {
    return this.decide(tenantId, id, 'APPROVED', note, principal, actor);
  }

  reject(tenantId: string, id: string, note: string, principal: Principal, actor: Actor) {
    return this.decide(tenantId, id, 'REJECTED', note, principal, actor);
  }

  /** The requester (while pending, or approved and not yet started) or an approver cancels. */
  async cancel(
    tenantId: string,
    id: string,
    reason: string | undefined,
    principal: Principal,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const row = await this.lockOpen(tx, tenantId, id);
      const own = await this.ownTeacher(tx, tenantId, principal);
      const isOwner = own?.id === row.teacherId;
      const isApprover = principal.permissions.has('leave.approve') && this.seesAll(principal);
      if (!isOwner && !isApprover) throw new NotFoundError('Leave request');
      if (row.status !== 'PENDING' && row.status !== 'APPROVED')
        throw new BusinessRuleError('INVALID_STATE', 'This request is already closed', {
          leave_status: row.status,
        });
      if (row.status === 'APPROVED' && row.startDate <= todayIso(this.deps.clock) && !isApprover)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'Leave that has started can only be cancelled by an approver',
        );
      await tx
        .update(leaveRequests)
        .set({
          status: 'CANCELLED',
          version: row.version + 1,
          decisionNote: reason ?? row.decisionNote,
        })
        .where(eq(leaveRequests.id, id));
      await addTeacherHistory(tx, actor, tenantId, row.teacherId, {
        eventType: 'LEAVE_CANCELLED',
        effectiveDate: row.startDate,
        reason: reason ?? null,
        details: { leave_id: id },
      });
      await recordChange(tx, actor, tenantId, {
        action: 'LEAVE_CANCELLED',
        entityType: 'leave_request',
        entityId: id,
        event: 'leave.cancelled',
        before: { status: row.status },
        after: { status: 'CANCELLED' },
        reason,
        payload: { teacher_id: row.teacherId },
      });
    });
    return this.get(tenantId, id, principal);
  }

  /** Leave days in [start, end]: staff working days, so weekly offs and holidays are left out. */
  async leaveDays(tenantId: string, start: string, end: string, ex: Executor = this.db) {
    return (await this.calendar.workingDays(tenantId, start, end, { kind: 'staff' }, ex)).working_days;
  }

  /**
   * Recount open (pending / approved) leave after the school calendar changed.
   * `range` = the dates the change touched; 'all' = weekly off days changed, so
   * every open leave from the start of last year is recounted. Balances are
   * summed from `days`, so they follow automatically. Returns how many changed.
   */
  async recountForCalendar(
    tx: Executor,
    tenantId: string,
    range: { from: string; to: string } | 'all',
    note: string,
    actor: Actor,
  ): Promise<number> {
    const conds = [
      eq(leaveRequests.tenantId, tenantId),
      inArray(leaveRequests.status, ['PENDING', 'APPROVED']),
    ];
    if (range === 'all') conds.push(gte(leaveRequests.endDate, `${+todayIso(this.deps.clock).slice(0, 4) - 1}-01-01`));
    else conds.push(lte(leaveRequests.startDate, range.to), gte(leaveRequests.endDate, range.from));
    const open = await tx.select().from(leaveRequests).where(and(...conds)).for('update');
    if (!open.length) return 0;
    const from = open.reduce((m, r) => (r.startDate < m ? r.startDate : m), open[0]!.startDate);
    const to = open.reduce((m, r) => (r.endDate > m ? r.endDate : m), open[0]!.endDate);
    const [settings, holidays] = await Promise.all([
      this.calendar.settings(tenantId, tx),
      this.calendar.activeHolidays(tenantId, from, to, tx),
    ]);
    let changed = 0;
    for (const r of open) {
      const days = countDays(settings, holidays, r.startDate, r.endDate, { kind: 'staff' }).working_days;
      if (days === r.days) continue;
      changed++;
      await tx
        .update(leaveRequests)
        .set({ days, version: r.version + 1 })
        .where(and(eq(leaveRequests.tenantId, tenantId), eq(leaveRequests.id, r.id)));
      await addTeacherHistory(tx, actor, tenantId, r.teacherId, {
        eventType: 'LEAVE_RECOUNTED',
        effectiveDate: r.startDate,
        reason: note,
        details: { leave_id: r.id, start: r.startDate, end: r.endDate, days_before: r.days, days_after: days },
      });
      await recordChange(tx, actor, tenantId, {
        action: 'LEAVE_RECOUNTED',
        entityType: 'leave_request',
        entityId: r.id,
        event: 'leave.recounted',
        before: { days: r.days },
        after: { days },
        reason: note,
        payload: { teacher_id: r.teacherId, days_before: r.days, days_after: days },
      });
    }
    return changed;
  }

  /** Teachers with approved leave covering `date` (used to pre-fill staff attendance). */
  async onLeaveOn(tenantId: string, date: string, ex: Executor = this.db): Promise<Set<string>> {
    const rows = await ex
      .select({ teacherId: leaveRequests.teacherId })
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.tenantId, tenantId),
          eq(leaveRequests.status, 'APPROVED'),
          lte(leaveRequests.startDate, date),
          gte(leaveRequests.endDate, date),
        ),
      );
    return new Set(rows.map((r) => r.teacherId));
  }
}
