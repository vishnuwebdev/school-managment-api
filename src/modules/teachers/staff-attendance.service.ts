import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import { staffAttendance, teachers } from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { todayIso } from '../../shared/dates.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { csvLine } from '../../shared/csv.js';
import { hasTenantWideScope } from '../access/authorization.service.js';
import type { CalendarService } from '../calendar/calendar.service.js';
import type { LeaveService } from './leave.service.js';
import type { MarkAttendanceBody } from './leave.schemas.js';
import { fullName } from './support.js';

const inMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
};

/** Daily staff attendance: Present, Absent, Leave or Late, one mark per person per day. */
export class StaffAttendanceService {
  constructor(
    private readonly deps: Deps,
    private readonly leave: LeaveService,
    private readonly calendar: CalendarService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  /** Everyone expected on `date` with their mark (or none yet) and whether approved leave covers them. */
  async roster(tenantId: string, date: string, principal: Principal) {
    // A weekly off day or a whole-school holiday: nobody is expected, nothing to mark.
    const dayOff = await this.calendar.dayOff(tenantId, date, { kind: 'staff' });
    if (!hasTenantWideScope(principal, 'teachers.attendance.read'))
      return { date, day_off: dayOff, entries: [], summary: this.summarise([]) };
    const rows = await this.db
      .select({ t: teachers, a: staffAttendance })
      .from(teachers)
      .leftJoin(
        staffAttendance,
        and(
          eq(staffAttendance.tenantId, teachers.tenantId),
          eq(staffAttendance.teacherId, teachers.id),
          eq(staffAttendance.attendanceDate, date),
        ),
      )
      .where(
        and(
          eq(teachers.tenantId, tenantId),
          inArray(teachers.status, ['ACTIVE', 'ON_LEAVE']),
          or(isNull(teachers.joiningDate), lte(teachers.joiningDate, date)),
        ),
      )
      .orderBy(asc(teachers.lastName), asc(teachers.firstName));
    const onLeave = await this.leave.onLeaveOn(tenantId, date);
    const entries = rows.map((r) => ({
      teacher_id: r.t.id,
      teacher_number: r.t.teacherNumber,
      full_name: fullName(r.t),
      staff_type: r.t.staffType,
      department: r.t.department,
      status: r.a?.status ?? null,
      note: r.a?.note ?? null,
      on_approved_leave: onLeave.has(r.t.id),
    }));
    return { date, day_off: dayOff, entries, summary: this.summarise(entries.map((e) => e.status)) };
  }

  private summarise(statuses: (string | null)[]) {
    const n = (s: string) => statuses.filter((x) => x === s).length;
    return {
      total: statuses.length,
      present: n('PRESENT'),
      absent: n('ABSENT'),
      leave: n('LEAVE'),
      late: n('LATE'),
      unmarked: statuses.filter((x) => x === null).length,
    };
  }

  async mark(
    tenantId: string,
    date: string,
    input: z.infer<typeof MarkAttendanceBody>,
    principal: Principal,
    actor: Actor,
  ) {
    if (!hasTenantWideScope(principal, 'teachers.attendance.mark'))
      throw new NotFoundError('Staff');
    if (date > todayIso(this.deps.clock))
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'Attendance cannot be marked for a future date',
        { field: 'date' },
      );
    const off = await this.calendar.dayOff(tenantId, date, { kind: 'staff' });
    if (off)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        `Attendance cannot be marked on a ${off.reason === 'HOLIDAY' ? 'school holiday' : 'weekly off day'} (${off.name})`,
        { field: 'date', day_off: off },
      );
    const ids = input.entries.map((e) => e.teacher_id);
    if (new Set(ids).size !== ids.length)
      throw new ValidationError('The request is invalid', {
        location: 'body',
        issues: [{ path: 'entries', code: 'duplicate', message: 'A staff member appears twice' }],
      });
    const result = await this.db.transaction(async (tx) => {
      const found = await tx
        .select({ id: teachers.id, status: teachers.status })
        .from(teachers)
        .where(and(eq(teachers.tenantId, tenantId), inArray(teachers.id, ids)));
      if (found.length !== ids.length) throw new NotFoundError('Staff member');
      const bad = found.find((f) => f.status !== 'ACTIVE' && f.status !== 'ON_LEAVE');
      if (bad)
        throw new BusinessRuleError(
          'INVALID_STATE',
          'Attendance can only be marked for active staff',
          { teacher_id: bad.id, teacher_status: bad.status },
        );
      await tx
        .insert(staffAttendance)
        .values(
          input.entries.map((e) => ({
            tenantId,
            teacherId: e.teacher_id,
            attendanceDate: date,
            status: e.status,
            note: e.note ?? null,
            markedBy: actor.userId,
          })),
        )
        .onDuplicateKeyUpdate({
          set: {
            status: sql`VALUES(status)`,
            note: sql`VALUES(note)`,
            markedBy: sql`VALUES(marked_by)`,
            version: sql`${staffAttendance.version} + 1`,
          },
        });
      const summary = this.summarise(input.entries.map((e) => e.status));
      await recordChange(tx, actor, tenantId, {
        action: 'STAFF_ATTENDANCE_MARKED',
        entityType: 'staff_attendance',
        entityId: tenantId,
        event: 'staff_attendance.marked',
        after: { date, ...summary },
        payload: { date, marked: input.entries.length },
      });
      return summary;
    });
    return { date, marked: input.entries.length, summary: result };
  }

  /** Per-person counts for a month (everyone, or only the caller for non-approvers). */
  async monthly(tenantId: string, month: string, principal: Principal) {
    const { from, to } = inMonth(month);
    // Working days of the month for staff (weekly offs and whole-school holidays left out).
    const cal = await this.calendar.workingDays(tenantId, from, to, { kind: 'staff' });
    const calendar = { working_days: cal.working_days, off_days: cal.off_days };
    if (!hasTenantWideScope(principal, 'teachers.attendance.read')) return { month, ...calendar, rows: [] };
    const rows = await this.db
      .select({
        t: teachers,
        status: staffAttendance.status,
        n: sql<number>`COUNT(${staffAttendance.id})`,
      })
      .from(teachers)
      .leftJoin(
        staffAttendance,
        and(
          eq(staffAttendance.tenantId, teachers.tenantId),
          eq(staffAttendance.teacherId, teachers.id),
          sql`${staffAttendance.attendanceDate} BETWEEN ${from} AND ${to}`,
        ),
      )
      .where(
        and(
          eq(teachers.tenantId, tenantId),
          inArray(teachers.status, ['ACTIVE', 'ON_LEAVE', 'RESIGNED', 'RETIRED', 'INACTIVE']),
        ),
      )
      .groupBy(teachers.id, staffAttendance.status)
      .orderBy(asc(teachers.lastName), asc(teachers.firstName));
    const by = new Map<
      string,
      { teacher: (typeof rows)[number]['t']; c: Record<string, number> }
    >();
    for (const r of rows) {
      const e = by.get(r.t.id) ?? { teacher: r.t, c: {} };
      if (r.status) e.c[r.status] = Number(r.n);
      by.set(r.t.id, e);
    }
    return {
      month,
      ...calendar,
      rows: [...by.values()].map((e) => {
        const c = e.c;
        return {
          teacher_id: e.teacher.id,
          teacher_number: e.teacher.teacherNumber,
          full_name: fullName(e.teacher),
          present: c.PRESENT ?? 0,
          absent: c.ABSENT ?? 0,
          leave: c.LEAVE ?? 0,
          late: c.LATE ?? 0,
          marked_days: (c.PRESENT ?? 0) + (c.ABSENT ?? 0) + (c.LEAVE ?? 0) + (c.LATE ?? 0),
        };
      }),
    };
  }

  async exportCsv(tenantId: string, month: string, principal: Principal, actor: Actor) {
    const m = await this.monthly(tenantId, month, principal);
    const lines = [
      csvLine(['Staff no.', 'Name', 'Present', 'Absent', 'Leave', 'Late', 'Days marked']),
      ...m.rows.map((r) =>
        csvLine([
          r.teacher_number,
          r.full_name,
          r.present,
          r.absent,
          r.leave,
          r.late,
          r.marked_days,
        ]),
      ),
    ];
    await this.db.transaction(async (tx) => {
      await recordChange(tx, actor, tenantId, {
        action: 'STAFF_ATTENDANCE_EXPORTED',
        entityType: 'staff_attendance',
        entityId: tenantId,
        payload: { month, rows: m.rows.length },
      });
    });
    return lines.join('\n') + '\n';
  }

  /** The signed-in staff member's own marks for a month. */
  async mine(tenantId: string, month: string, principal: Principal) {
    const [t] = await this.db
      .select()
      .from(teachers)
      .where(
        and(eq(teachers.tenantId, tenantId), eq(teachers.membershipId, principal.membershipId)),
      );
    if (!t) throw new NotFoundError('Teacher');
    const { from, to } = inMonth(month);
    const rows = await this.db
      .select()
      .from(staffAttendance)
      .where(
        and(
          eq(staffAttendance.tenantId, tenantId),
          eq(staffAttendance.teacherId, t.id),
          sql`${staffAttendance.attendanceDate} BETWEEN ${from} AND ${to}`,
        ),
      )
      .orderBy(asc(staffAttendance.attendanceDate));
    return {
      month,
      days: rows.map((r) => ({ date: r.attendanceDate, status: r.status, note: r.note })),
      summary: this.summarise(rows.map((r) => r.status)),
    };
  }
}
