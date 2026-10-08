import { and, asc, count, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  enrollments,
  feeAdjustments,
  feeCategories,
  feeDemands,
  feePaymentPlans,
  paymentAllocations,
  schoolPayments,
  students,
} from '../../db/schema/index.js';
import type { Actor } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { ConflictError } from '../../shared/errors.js';
import { offsetOf, orderFrom, pageOf } from '../../shared/pagination.js';
import { systemActor } from '../../platform/context.js';
import type {
  ApplyLateFeesBody,
  DemandListQuery,
  DiscountBody,
  IssueDemandsBody,
} from './fees.schemas.js';
import { applyBp, fromMinor, maxBig, minBig, percentToBp, toMinor } from './money.js';
import {
  businessRule,
  daysBetween,
  effectiveStatusSql,
  ensureSettings,
  feeScope,
  inOwed,
  likeOf,
  loadDemand,
  lockDemands,
  moneyOf,
  netBeforeLate,
  outstandingOfMoney,
  outstandingSql,
  presentAdjustment,
  presentAllocation,
  presentDemand,
  readSettings,
  requireWide,
  schoolToday,
  staleVersion,
  statusAfter,
  studentMini,
  writeDemand,
  type Caller,
  type DemandRow,
  type SettingsRow,
} from './support.js';
import { NotFoundError } from '../../shared/errors.js';

/** Statuses in which a demand may still be adjusted (discounts, concessions, waivers). */
export const ADJUSTABLE = ['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] as const;
const CANCELLABLE = ['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] as const;
const stale = () => new ConflictError('CONFLICT', undefined, { reason: 'STALE_VERSION' });

type Reducible = 'discount' | 'concession' | 'waiver';

/**
 * Deducts `amount` from a locked demand as a discount, concession or waiver. The deduction can never
 * exceed the outstanding balance (paid money stays paid). Shared by direct discounts and applied
 * adjustments so there is one place that protects the balance.
 */
export async function reduceDemand(
  tx: Executor,
  d: DemandRow,
  kind: Reducible,
  amount: bigint,
  o: { today: string; now: Date },
) {
  if (!(ADJUSTABLE as readonly string[]).includes(d.status))
    throw businessRule('DEMAND_NOT_ADJUSTABLE', 'This demand can no longer be adjusted', {
      demand_status: d.status,
    });
  const m = moneyOf(d);
  const out = outstandingOfMoney(m);
  if (amount > out)
    throw businessRule(
      'EXCEEDS_OUTSTANDING',
      'The reduction is more than the outstanding balance of the demand',
      { outstanding_amount: fromMinor(out), requested_amount: fromMinor(amount) },
      'OPERATION_NOT_ALLOWED',
    );
  return writeDemand(tx, d, { [kind]: m[kind] + amount }, o);
}

/** The late fee a demand has earned today under the school's rule (integer minor units). */
export function lateFeeFor(s: SettingsRow, d: DemandRow, today: string): bigint {
  if (!s.lateFeeEnabled) return 0n;
  const late = daysBetween(d.dueDate, today) - s.lateFeeGraceDays;
  if (late <= 0) return 0n;
  const m = moneyOf(d);
  const base = netBeforeLate(m);
  const value = toMinor(s.lateFeeValue);
  let fee =
    s.lateFeeType === 'FIXED'
      ? value
      : s.lateFeeType === 'PERCENT'
        ? applyBp(base, percentToBp(s.lateFeeValue))
        : value * BigInt(late);
  if (s.lateFeeCap !== null) fee = minBig(fee, toMinor(s.lateFeeCap));
  return maxBig(fee, 0n);
}

/**
 * Fee demands: list/read, the explicit lifecycle commands (issue, cancel, write off) and the
 * adjustments that are not approval based (direct discount, late fees, the overdue sweep).
 * Every change writes audit + outbox with the same transaction as the balance change.
 *
 * Lock order: payment → demands in id order (demands are only ever locked in ascending id order).
 */
export class DemandService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  // ---- reads ----------------------------------------------------------------------------------------

  /** What one student has been billed, has paid and still owes (drafts and cancelled demands excluded). */
  async studentSummary(c: Caller, studentId: string) {
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const d = feeDemands;
    const owedNow = sql`${d.status} in ('ISSUED','PARTIALLY_PAID','OVERDUE')`;
    const [r] = await this.db
      .select({
        billed: sql<string>`coalesce(sum(${d.finalAmount}), 0)`,
        paid: sql<string>`coalesce(sum(${d.paidAmount}), 0)`,
        written_off: sql<string>`coalesce(sum(${d.writtenOffAmount}), 0)`,
        outstanding: sql<string>`coalesce(sum(case when ${owedNow} then ${outstandingSql} else 0 end), 0)`,
        overdue: sql<string>`coalesce(sum(case when ${owedNow} and ${d.dueDate} < ${today} then ${outstandingSql} else 0 end), 0)`,
        demands: sql<number>`count(*)`,
        open_demands: sql<number>`coalesce(sum(case when ${owedNow} and ${outstandingSql} > 0 then 1 else 0 end), 0)`,
        next_due: sql<
          string | null
        >`min(case when ${owedNow} and ${outstandingSql} > 0 then ${d.dueDate} end)`,
        currency: sql<string | null>`max(${d.currency})`,
      })
      .from(d)
      .where(
        and(
          eq(d.tenantId, c.tenantId),
          eq(d.studentId, studentId),
          feeScope(c.principal, 'fees.read', d),
          sql`${d.status} not in ('DRAFT','CANCELLED')`,
        ),
      );
    return {
      student_id: studentId,
      currency: r?.currency ?? null,
      billed: String(r?.billed ?? '0'),
      paid: String(r?.paid ?? '0'),
      written_off: String(r?.written_off ?? '0'),
      outstanding: String(r?.outstanding ?? '0'),
      overdue: String(r?.overdue ?? '0'),
      demands: Number(r?.demands ?? 0),
      open_demands: Number(r?.open_demands ?? 0),
      next_due_date: r?.next_due ?? null,
    };
  }

  async list(c: Caller, q: z.infer<typeof DemandListQuery>) {
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const d = feeDemands;
    const where = and(
      eq(d.tenantId, c.tenantId),
      feeScope(c.principal, 'fees.read', d),
      q.student_id ? eq(d.studentId, q.student_id) : undefined,
      q.assignment_id ? eq(d.studentFeeAssignmentId, q.assignment_id) : undefined,
      q.academic_year_id ? eq(d.academicYearId, q.academic_year_id) : undefined,
      q.fee_category_id ? eq(d.feeCategoryId, q.fee_category_id) : undefined,
      q.fee_component_id ? eq(d.feeComponentId, q.fee_component_id) : undefined,
      q.status ? sql`${effectiveStatusSql(today)} = ${q.status}` : undefined,
      q.due_from ? sql`${d.dueDate} >= ${q.due_from}` : undefined,
      q.due_to ? sql`${d.dueDate} <= ${q.due_to}` : undefined,
      q.class_id ? eq(enrollments.classId, q.class_id) : undefined,
      q.section_id ? eq(enrollments.sectionId, q.section_id) : undefined,
      q.search
        ? or(
            like(d.demandNumber, likeOf(q.search)),
            like(students.studentNumber, likeOf(q.search)),
            like(students.firstName, likeOf(q.search)),
            like(students.lastName, likeOf(q.search)),
          )
        : undefined,
    );
    const from = () =>
      this.db
        .select({ d, s: students, cat: feeCategories })
        .from(d)
        .innerJoin(students, and(eq(students.tenantId, d.tenantId), eq(students.id, d.studentId)))
        .innerJoin(
          feeCategories,
          and(eq(feeCategories.tenantId, d.tenantId), eq(feeCategories.id, d.feeCategoryId)),
        )
        .innerJoin(
          enrollments,
          and(eq(enrollments.tenantId, d.tenantId), eq(enrollments.id, d.enrollmentId)),
        )
        .where(where);
    const order = orderFrom(
      q,
      {
        due_date: d.dueDate,
        created_at: d.createdAt,
        demand_number: d.demandNumber,
        final_amount: d.finalAmount,
      },
      'due_date',
    );
    const [rows, [total]] = await Promise.all([
      from()
        .orderBy(order, q.order === 'asc' ? asc(d.id) : desc(d.id))
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db
        .select({ n: count() })
        .from(d)
        .innerJoin(students, and(eq(students.tenantId, d.tenantId), eq(students.id, d.studentId)))
        .innerJoin(
          enrollments,
          and(eq(enrollments.tenantId, d.tenantId), eq(enrollments.id, d.enrollmentId)),
        )
        .where(where),
    ]);
    return pageOf(
      rows.map((r) =>
        presentDemand(r.d, today, {
          student: studentMini(r.s),
          category: { id: r.cat.id, code: r.cat.code, name: r.cat.name },
        }),
      ),
      total?.n ?? 0,
      q,
    );
  }

  async get(c: Caller, id: string, ex: Executor = this.db) {
    const today = await schoolToday(ex, c.tenantId, this.deps.clock);
    const d = await loadDemand(ex, c.tenantId, id, c.principal, 'fees.read');
    const [s] = await ex
      .select()
      .from(students)
      .where(and(eq(students.tenantId, c.tenantId), eq(students.id, d.studentId)));
    const [cat] = await ex
      .select()
      .from(feeCategories)
      .where(and(eq(feeCategories.tenantId, c.tenantId), eq(feeCategories.id, d.feeCategoryId)));
    const allocs = await ex
      .select({ a: paymentAllocations, p: schoolPayments })
      .from(paymentAllocations)
      .innerJoin(
        schoolPayments,
        and(
          eq(schoolPayments.tenantId, paymentAllocations.tenantId),
          eq(schoolPayments.id, paymentAllocations.paymentId),
        ),
      )
      .where(
        and(eq(paymentAllocations.tenantId, c.tenantId), eq(paymentAllocations.feeDemandId, id)),
      )
      .orderBy(asc(paymentAllocations.createdAt), asc(paymentAllocations.id));
    const adjustments = await ex
      .select()
      .from(feeAdjustments)
      .where(and(eq(feeAdjustments.tenantId, c.tenantId), eq(feeAdjustments.feeDemandId, id)))
      .orderBy(asc(feeAdjustments.requestedAt), asc(feeAdjustments.id));
    const mini = s ? studentMini(s) : undefined;
    return {
      ...presentDemand(d, today, {
        student: mini,
        category: cat ? { id: cat.id, code: cat.code, name: cat.name } : undefined,
      }),
      allocations: allocs.map((r) => ({
        ...presentAllocation(r.a, { demandNumber: d.demandNumber, description: d.description }),
        payment: {
          id: r.p.id,
          payment_number: r.p.paymentNumber,
          method: r.p.method,
          status: r.p.status,
          received_on: r.p.receivedOn,
        },
      })),
      adjustments: adjustments.map((a) =>
        presentAdjustment(a, { student: mini, demandNumber: d.demandNumber }),
      ),
    };
  }

  // ---- issue -----------------------------------------------------------------------------------------

  private async issueLocked(tx: Executor, c: Caller, d: DemandRow, today: string, now: Date) {
    if (d.status !== 'DRAFT')
      throw businessRule('NOT_DRAFT', 'Only a draft demand can be issued', {
        demand_id: d.id,
        demand_status: d.status,
      });
    const m = moneyOf(d);
    const to = statusAfter({ status: 'ISSUED', dueDate: d.dueDate }, m, today);
    const { row } = await writeDemand(
      tx,
      d,
      {},
      {
        today,
        now,
        status: to,
        extra: { issuedAt: now, issuedBy: c.actor.userId },
      },
    );
    await recordChange(tx, c.actor, c.tenantId, {
      action: 'FEE_DEMAND_ISSUED',
      entityType: 'fee_demand',
      entityId: d.id,
      event: 'fee_demand.issued',
      before: { status: 'DRAFT' },
      after: { status: row.status, final_amount: row.finalAmount, due_date: row.dueDate },
      payload: {
        student_id: d.studentId,
        demand_number: d.demandNumber,
        final_amount: row.finalAmount,
        currency: row.currency,
        due_date: row.dueDate,
      },
    });
    return row;
  }

  async issue(c: Caller, id: string) {
    await this.db.transaction(async (tx) => {
      const today = await schoolToday(tx, c.tenantId, this.deps.clock);
      const d = await loadDemand(tx, c.tenantId, id, c.principal, 'fees.manage', 'update');
      await this.issueLocked(tx, c, d, today, this.deps.clock.now());
    });
    return this.get(c, id);
  }

  /** Issue many drafts in one transaction (all or none). */
  async issueMany(c: Caller, input: z.infer<typeof IssueDemandsBody>) {
    const ids = [...new Set(input.demand_ids)].sort();
    await this.db.transaction(async (tx) => {
      const visible = await tx
        .select({ id: feeDemands.id })
        .from(feeDemands)
        .where(
          and(
            eq(feeDemands.tenantId, c.tenantId),
            inArray(feeDemands.id, ids),
            feeScope(c.principal, 'fees.manage', feeDemands),
          ),
        );
      if (visible.length !== ids.length) throw new NotFoundError('Fee demand');
      const locked = await lockDemands(tx, c.tenantId, ids);
      const today = await schoolToday(tx, c.tenantId, this.deps.clock);
      const now = this.deps.clock.now();
      for (const id of ids) await this.issueLocked(tx, c, locked.get(id)!, today, now);
    });
    return { issued: ids.length, demand_ids: ids };
  }

  // ---- cancel / write off -------------------------------------------------------------------------------

  async cancel(c: Caller, id: string, reason: string, version?: number) {
    await this.db.transaction(async (tx) => {
      const d = await loadDemand(tx, c.tenantId, id, c.principal, 'fees.manage', 'update');
      if (staleVersion(d.version, version)) throw stale();
      if (!(CANCELLABLE as readonly string[]).includes(d.status))
        throw businessRule('NOT_CANCELLABLE', 'This demand cannot be cancelled', {
          demand_status: d.status,
        });
      if (toMinor(d.paidAmount) > 0n)
        throw businessRule(
          'HAS_PAYMENTS',
          'Money has been allocated to this demand. Refund or reverse the payment first.',
          { paid_amount: d.paidAmount },
          'OPERATION_NOT_ALLOWED',
        );
      const today = await schoolToday(tx, c.tenantId, this.deps.clock);
      const now = this.deps.clock.now();
      await writeDemand(
        tx,
        d,
        {},
        {
          today,
          now,
          status: 'CANCELLED',
          extra: { cancelledAt: now, cancelledBy: c.actor.userId, cancelReason: reason },
        },
      );
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_DEMAND_CANCELLED',
        entityType: 'fee_demand',
        entityId: id,
        event: 'fee_demand.cancelled',
        before: { status: d.status, final_amount: d.finalAmount },
        after: { status: 'CANCELLED' },
        reason,
        payload: { student_id: d.studentId, demand_number: d.demandNumber, from_status: d.status },
      });
    });
    return this.get(c, id);
  }

  /** Forgive the outstanding balance (not the same as paid). Needs reason + fees.waivers.approve. */
  async writeOff(c: Caller, id: string, reason: string, version?: number) {
    await this.db.transaction(async (tx) => {
      const d = await loadDemand(tx, c.tenantId, id, c.principal, 'fees.waivers.approve', 'update');
      if (staleVersion(d.version, version)) throw stale();
      if (!(['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] as string[]).includes(d.status))
        throw businessRule(
          'NOT_WRITABLE_OFF',
          'Only an issued demand with a balance can be written off',
          {
            demand_status: d.status,
          },
        );
      const m = moneyOf(d);
      const out = outstandingOfMoney(m);
      if (out <= 0n)
        throw businessRule('NOTHING_OUTSTANDING', 'There is no outstanding balance to write off');
      const today = await schoolToday(tx, c.tenantId, this.deps.clock);
      const now = this.deps.clock.now();
      const { row } = await writeDemand(
        tx,
        d,
        { writtenOff: m.writtenOff + out },
        {
          today,
          now,
          extra: { writtenOffAt: now, writtenOffBy: c.actor.userId, writeOffReason: reason },
        },
      );
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_DEMAND_WRITTEN_OFF',
        entityType: 'fee_demand',
        entityId: id,
        event: 'fee_demand.written_off',
        before: { status: d.status, written_off_amount: d.writtenOffAmount },
        after: { status: row.status, written_off_amount: row.writtenOffAmount },
        reason,
        payload: {
          student_id: d.studentId,
          demand_number: d.demandNumber,
          written_off: fromMinor(out),
          currency: d.currency,
        },
      });
    });
    return this.get(c, id);
  }

  // ---- direct discount --------------------------------------------------------------------------------------

  async discount(c: Caller, id: string, input: z.infer<typeof DiscountBody>) {
    await this.db.transaction(async (tx) => {
      const d = await loadDemand(tx, c.tenantId, id, c.principal, 'fees.waivers.approve', 'update');
      const m = moneyOf(d);
      const amount =
        input.value_type === 'AMOUNT'
          ? toMinor(input.value)
          : applyBp(m.original, percentToBp(input.value));
      if (amount <= 0n)
        throw businessRule(
          'ZERO_AMOUNT',
          'The discount works out to nothing',
          {},
          'OPERATION_NOT_ALLOWED',
        );
      const today = await schoolToday(tx, c.tenantId, this.deps.clock);
      const { row } = await reduceDemand(tx, d, 'discount', amount, {
        today,
        now: this.deps.clock.now(),
      });
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_DEMAND_DISCOUNTED',
        entityType: 'fee_demand',
        entityId: id,
        event: 'fee_demand.discounted',
        before: { discount_amount: d.discountAmount, final_amount: d.finalAmount },
        after: { discount_amount: row.discountAmount, final_amount: row.finalAmount },
        reason: input.reason,
        payload: {
          student_id: d.studentId,
          demand_number: d.demandNumber,
          discount: fromMinor(amount),
          currency: d.currency,
        },
      });
    });
    return this.get(c, id);
  }

  // ---- late fees ---------------------------------------------------------------------------------------------

  private async applyLateFeeLocked(
    tx: Executor,
    c: Caller,
    d: DemandRow,
    settings: SettingsRow,
    today: string,
    now: Date,
  ): Promise<'APPLIED' | 'UNCHANGED' | 'NOT_ELIGIBLE' | 'ON_PLAN'> {
    if (!(['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] as string[]).includes(d.status))
      return 'NOT_ELIGIBLE';
    const m = moneyOf(d);
    if (outstandingOfMoney(m) <= 0n) return 'NOT_ELIGIBLE';
    // A ltudent on an agreed payment plan is not charged late fees while the plan is honoured.
    const [plan] = await tx
      .select({ id: feePaymentPlans.id })
      .from(feePaymentPlans)
      .where(
        and(
          eq(feePaymentPlans.tenantId, d.tenantId),
          eq(feePaymentPlans.studentId, d.studentId),
          eq(feePaymentPlans.status, 'ACTIVE'),
        ),
      );
    if (plan) return 'ON_PLAN';
    const fee = lateFeeFor(settings, d, today);
    if (fee <= 0n) return 'NOT_ELIGIBLE';
    if (fee <= m.late) return 'UNCHANGED'; // a late fee never goes down by itself
    const { row } = await writeDemand(
      tx,
      d,
      { late: fee },
      {
        today,
        now,
        extra: { lateFeeAppliedAt: now },
      },
    );
    await recordChange(tx, c.actor, c.tenantId, {
      action: 'FEE_LATE_FEE_APPLIED',
      entityType: 'fee_demand',
      entityId: d.id,
      event: 'fee_demand.late_fee_applied',
      before: { late_fee_amount: d.lateFeeAmount, final_amount: d.finalAmount },
      after: { late_fee_amount: row.lateFeeAmount, final_amount: row.finalAmount },
      payload: {
        student_id: d.studentId,
        demand_number: d.demandNumber,
        late_fee_amount: row.lateFeeAmount,
        currency: d.currency,
        days_late: daysBetween(d.dueDate, today),
      },
    });
    return 'APPLIED';
  }

  async applyLateFee(c: Caller, id: string) {
    await ensureSettings(this.db, c.tenantId);
    await this.db.transaction(async (tx) => {
      const settings = await readSettings(tx, c.tenantId, 'share');
      if (!settings.lateFeeEnabled)
        throw businessRule(
          'LATE_FEE_DISABLED',
          'Late fees are not switched on for this school',
          {},
          'OPERATION_NOT_ALLOWED',
        );
      const d = await loadDemand(tx, c.tenantId, id, c.principal, 'fees.manage', 'update');
      const today = await schoolToday(tx, c.tenantId, this.deps.clock);
      const r = await this.applyLateFeeLocked(tx, c, d, settings, today, this.deps.clock.now());
      if (r === 'ON_PLAN')
        throw businessRule(
          'ON_PAYMENT_PLAN',
          'This ltudent is on an active payment plan, so no late fee is charged',
          {},
          'OPERATION_NOT_ALLOWED',
        );
      if (r === 'NOT_ELIGIBLE')
        throw businessRule(
          'NOT_YET_LATE',
          'This demand has no late fee yet (not past due plus the grace period, or nothing outstanding)',
          { due_date: d.dueDate, grace_days: settings.lateFeeGraceDays },
          'OPERATION_NOT_ALLOWED',
        );
    });
    return this.get(c, id);
  }

  /** Apply the late-fee rule to every overdue demand (or the listed ones), up to 500 per call. */
  async applyLateFees(c: Caller, input: z.infer<typeof ApplyLateFeesBody>) {
    requireWide(c.principal, 'fees.manage');
    await ensureSettings(this.db, c.tenantId);
    const settings = await readSettings(this.db, c.tenantId);
    if (!settings.lateFeeEnabled)
      throw businessRule(
        'LATE_FEE_DISABLED',
        'Late fees are not switched on for this school',
        {},
        'OPERATION_NOT_ALLOWED',
      );
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const candidates = await this.db
      .select({ id: feeDemands.id })
      .from(feeDemands)
      .where(
        and(
          eq(feeDemands.tenantId, c.tenantId),
          inOwed,
          sql`${outstandingSql} > 0`,
          sql`${feeDemands.dueDate} < ${today}`,
          input.demand_ids ? inArray(feeDemands.id, input.demand_ids) : undefined,
        ),
      )
      .orderBy(asc(feeDemands.id))
      .limit(500);
    const out = {
      considered: candidates.length,
      applied: 0,
      unchanged: 0,
      not_eligible: 0,
      on_payment_plan: 0,
      demand_ids: [] as string[],
    };
    if (!candidates.length) return out;
    await this.db.transaction(async (tx) => {
      const fresh = await readSettings(tx, c.tenantId, 'share');
      const locked = await lockDemands(
        tx,
        c.tenantId,
        candidates.map((r) => r.id),
      );
      const now = this.deps.clock.now();
      for (const id of [...locked.keys()].sort()) {
        const r = await this.applyLateFeeLocked(tx, c, locked.get(id)!, fresh, today, now);
        if (r === 'APPLIED') {
          out.applied++;
          out.demand_ids.push(id);
        } else if (r === 'UNCHANGED') out.unchanged++;
        else out.not_eligible++;
      }
    });
    return out;
  }

  // ---- overdue sweep ----------------------------------------------------------------------------------------------

  /**
   * Persist OVERDUE on issued demands that are past their due date (a job; reads already show them
   * as OVERDUE). Processes up to `limit` demands per call, in id order.
   */
  async sweepOverdue(tenantId: string, actor: Actor = systemActor(tenantId), limit = 500) {
    const today = await schoolToday(this.db, tenantId, this.deps.clock);
    const candidates = await this.db
      .select({ id: feeDemands.id })
      .from(feeDemands)
      .where(
        and(
          eq(feeDemands.tenantId, tenantId),
          inArray(feeDemands.status, ['ISSUED', 'PARTIALLY_PAID']),
          sql`${feeDemands.dueDate} < ${today}`,
          sql`${outstandingSql} > 0`,
        ),
      )
      .orderBy(asc(feeDemands.id))
      .limit(limit);
    if (!candidates.length) return { marked: 0, demand_ids: [] as string[] };
    const marked: string[] = [];
    await this.db.transaction(async (tx) => {
      const locked = await lockDemands(
        tx,
        tenantId,
        candidates.map((r) => r.id),
      );
      const now = this.deps.clock.now();
      for (const id of [...locked.keys()].sort()) {
        const d = locked.get(id)!;
        if (d.status !== 'ISSUED' && d.status !== 'PARTIALLY_PAID') continue;
        const m = moneyOf(d);
        if (outstandingOfMoney(m) <= 0n || d.dueDate >= today) continue;
        await writeDemand(tx, d, {}, { today, now, status: 'OVERDUE' });
        marked.push(id);
        await recordChange(tx, actor, tenantId, {
          action: 'FEE_DEMAND_OVERDUE',
          entityType: 'fee_demand',
          entityId: id,
          event: 'fee_demand.overdue',
          before: { status: d.status },
          after: { status: 'OVERDUE' },
          payload: {
            student_id: d.studentId,
            demand_number: d.demandNumber,
            due_date: d.dueDate,
            outstanding_amount: fromMinor(outstandingOfMoney(m)),
            currency: d.currency,
          },
        });
      }
    });
    return { marked: marked.length, demand_ids: marked };
  }
}
