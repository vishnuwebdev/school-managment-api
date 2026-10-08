import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  enrollments,
  feeDemands,
  feePaymentPlans,
  feePlanInstalments,
  feeReminders,
  guardians,
  OPEN_ENROLLMENT_STATUSES,
  paymentAllocations,
  REMINDER_STAGE,
  studentGuardians,
  type ReminderStage,
} from '../../db/schema/index.js';
import { recordChange } from '../../platform/record.js';
import { NotFoundError } from '../../shared/errors.js';
import { offsetOf, pageOf } from '../../shared/pagination.js';
import { loadStudent } from '../students/support.js';
import type {
  ArrearsQuery,
  CancelPlanBody,
  CreatePlanBody,
  PlanListQuery,
  RecordReminderBody,
  RunRemindersBody,
} from './collections.schemas.js';
import { fromMinor, toMinor } from './money.js';
import {
  businessRule,
  daysBetween,
  inOwed,
  outstandingSql,
  requireWide,
  schoolToday,
  studentMinis,
  type Caller,
} from './support.js';

const OPEN = [...OPEN_ENROLLMENT_STATUSES];
const MANAGE = 'fees.arrears.manage';
const ESCALATE = 'fees.arrears.escalate';

/** Days past the oldest due date at which the automatic steps become due. */
export const LADDER_DAYS = { FIRST_REMINDER: 14, SECOND_REMINDER: 45 } as const;
/** A longer plan needs the finance committee (a holder of fees.arrears.escalate). */
export const MAX_PLAN_INSTALMENTS = 6;

export type ArrearsStep = 'DUE_FIRST' | 'DUE_SECOND' | 'LETTER' | 'HANDOVER' | 'PLAN' | 'NONE';

/** The next ladder step for a ltudent. Pure, so the rules can be tested without a database. */
export function nextStep(days: number, last: ReminderStage | null, onPlan: boolean): ArrearsStep {
  if (onPlan) return 'PLAN';
  if (last === null) return days >= LADDER_DAYS.FIRST_REMINDER ? 'DUE_FIRST' : 'NONE';
  if (last === 'FIRST_REMINDER') return days >= LADDER_DAYS.SECOND_REMINDER ? 'DUE_SECOND' : 'NONE';
  if (last === 'SECOND_REMINDER') return 'LETTER';
  if (last === 'LETTER_OF_DEMAND') return 'HANDOVER';
  return 'NONE';
}

const STEP_STAGE: Record<string, ReminderStage> = {
  DUE_FIRST: 'FIRST_REMINDER',
  DUE_SECOND: 'SECOND_REMINDER',
  LETTER: 'LETTER_OF_DEMAND',
  HANDOVER: 'COLLECTIONS_HANDOVER',
};

type PlanRow = typeof feePaymentPlans.$inferSelect;
type InstalmentRow = typeof feePlanInstalments.$inferSelect;

interface Overdue {
  studentId: string;
  outstanding: bigint;
  oldest: string;
  demandCount: number;
}

/** Instalments with their derived status against what the family has paid since the plan began. */
export function planProgress(instalments: InstalmentRow[], paid: bigint, today: string) {
  let cumulative = 0n;
  const rows = [...instalments]
    .sort((a, b) => a.seq - b.seq)
    .map((i) => {
      cumulative += toMinor(i.amount);
      const status: 'PAID' | 'MISSED' | 'UPCOMING' =
        paid >= cumulative ? 'PAID' : i.dueDate < today ? 'MISSED' : 'UPCOMING';
      return {
        seq: i.seq,
        due_date: i.dueDate,
        amount: i.amount,
        status,
        covered_amount: fromMinor(paid >= cumulative ? toMinor(i.amount) : 0n),
      };
    });
  return {
    instalments: rows,
    all_paid: rows.length > 0 && rows.every((r) => r.status === 'PAID'),
    any_missed: rows.some((r) => r.status === 'MISSED'),
  };
}

/**
 * Arrears follow-up: the reminder ladder and payment plans. The portal records every step and
 * emits an event for the school's messaging service; it does not send messages itself.
 */
export class ArrearsService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  // ---- overdue position -------------------------------------------------------------------------

  private async overdueByStudent(
    ex: Executor,
    tenantId: string,
    today: string,
    opts: { classId?: string; sectionId?: string; studentId?: string; studentIds?: string[] } = {},
  ): Promise<Overdue[]> {
    const d = feeDemands;
    const rows = await ex
      .select({
        studentId: d.studentId,
        total: sql<string>`sum(${outstandingSql})`,
        oldest: sql<string>`min(${d.dueDate})`,
        n: count(),
      })
      .from(d)
      .innerJoin(
        enrollments,
        and(eq(enrollments.tenantId, d.tenantId), eq(enrollments.id, d.enrollmentId)),
      )
      .where(
        and(
          eq(d.tenantId, tenantId),
          inOwed,
          sql`${outstandingSql} > 0`,
          sql`${d.dueDate} < ${today}`,
          opts.classId ? eq(enrollments.classId, opts.classId) : undefined,
          opts.sectionId ? eq(enrollments.sectionId, opts.sectionId) : undefined,
          opts.studentId ? eq(d.studentId, opts.studentId) : undefined,
          opts.studentIds ? inArray(d.studentId, opts.studentIds) : undefined,
        ),
      )
      .groupBy(d.studentId)
      .orderBy(sql`min(${d.dueDate})`, asc(d.studentId));
    return rows.map((r) => ({
      studentId: r.studentId,
      outstanding: toMinor(r.total),
      oldest: String(r.oldest).slice(0, 10),
      demandCount: Number(r.n),
    }));
  }

  /** Last ladder step recorded in the current overdue cycle (on or after the oldest due date). */
  private async lastStages(ex: Executor, tenantId: string, rows: Overdue[]) {
    const out = new Map<string, { stage: ReminderStage; at: Date }>();
    if (!rows.length) return out;
    const oldest = new Map(rows.map((r) => [r.studentId, r.oldest]));
    const found = await ex
      .select()
      .from(feeReminders)
      .where(
        and(
          eq(feeReminders.tenantId, tenantId),
          inArray(feeReminders.studentId, [...oldest.keys()]),
        ),
      )
      .orderBy(asc(feeReminders.createdAt), asc(feeReminders.id));
    for (const r of found) {
      if (r.createdAt.toISOString().slice(0, 10) < (oldest.get(r.studentId) ?? '')) continue;
      out.set(r.studentId, { stage: r.stage, at: r.createdAt });
    }
    return out;
  }

  // ---- arrears list -----------------------------------------------------------------------------

  async arrears(c: Caller, q: z.infer<typeof ArrearsQuery>) {
    requireWide(c.principal, MANAGE);
    await this.evaluatePlans(c);
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const base = await this.overdueByStudent(this.db, c.tenantId, today, {
      classId: q.class_id,
      sectionId: q.section_id,
    });
    const ids = base.map((r) => r.studentId);
    const [last, plans, minis] = await Promise.all([
      this.lastStages(this.db, c.tenantId, base),
      this.activePlans(this.db, c.tenantId, ids),
      studentMinis(this.db, c.tenantId, ids),
    ]);
    const needle = q.search?.toLowerCase();
    let items = base.map((r) => {
      const days = daysBetween(r.oldest, today);
      const l = last.get(r.studentId) ?? null;
      const plan = plans.get(r.studentId) ?? null;
      return {
        r,
        days,
        last: l,
        plan,
        step: nextStep(days, l?.stage ?? null, plan !== null),
        mini: minis.get(r.studentId),
      };
    });
    const ladder = { DUE_FIRST: 0, DUE_SECOND: 0, LETTER: 0, HANDOVER: 0, PLAN: 0, NONE: 0 };
    for (const i of items) ladder[i.step]++;
    const totalOverdue = items.reduce((a, i) => a + i.r.outstanding, 0n);
    items = items.filter(
      (i) =>
        (!q.min_days_overdue || i.days >= q.min_days_overdue) &&
        (!q.step || i.step === q.step) &&
        (!needle ||
          i.mini?.full_name.toLowerCase().includes(needle) ||
          i.mini?.student_number.toLowerCase().includes(needle)),
    );
    const total = items.length;
    const pageItems = items.slice(offsetOf(q), offsetOf(q) + q.page_size);
    const pageIds = pageItems.map((i) => i.r.studentId);
    const [placement, contacts] = await Promise.all([
      this.placements(c.tenantId, pageIds),
      this.contacts(c.tenantId, pageIds),
    ]);
    return {
      ...pageOf(
        pageItems.map((i) => ({
          student: i.mini ?? null,
          class: placement.get(i.r.studentId) ?? null,
          guardian: contacts.get(i.r.studentId) ?? null,
          outstanding_amount: fromMinor(i.r.outstanding),
          demand_count: i.r.demandCount,
          oldest_due_date: i.r.oldest,
          days_overdue: i.days,
          last_step: i.last ? { stage: i.last.stage, at: i.last.at.toISOString() } : null,
          next_step: i.step,
          payment_plan_id: i.plan?.id ?? null,
        })),
        total,
        q,
      ),
      summary: {
        student_count: base.length,
        overdue_amount: fromMinor(totalOverdue),
        ladder,
        thresholds: { ...LADDER_DAYS, max_plan_instalments: MAX_PLAN_INSTALMENTS },
      },
    };
  }

  private async placements(tenantId: string, ids: string[]) {
    const out = new Map<string, { class_name: string; section_name: string | null }>();
    if (!ids.length) return out;
    const rows = await this.db
      .select({
        studentId: enrollments.studentId,
        className: academicClasses.name,
        sectionName: academicSections.name,
      })
      .from(enrollments)
      .innerJoin(
        academicClasses,
        and(
          eq(academicClasses.tenantId, enrollments.tenantId),
          eq(academicClasses.id, enrollments.classId),
        ),
      )
      .leftJoin(
        academicSections,
        and(
          eq(academicSections.tenantId, enrollments.tenantId),
          eq(academicSections.id, enrollments.sectionId),
        ),
      )
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          inArray(enrollments.studentId, ids),
          inArray(enrollments.status, OPEN),
        ),
      );
    for (const r of rows)
      out.set(r.studentId, { class_name: r.className, section_name: r.sectionName });
    return out;
  }

  private async contacts(tenantId: string, ids: string[]) {
    const out = new Map<string, { name: string; phone: string | null; email: string | null }>();
    if (!ids.length) return out;
    const rows = await this.db
      .select({
        studentId: studentGuardians.studentId,
        first: guardians.firstName,
        last: guardians.lastName,
        phone: guardians.phone,
        email: guardians.email,
      })
      .from(studentGuardians)
      .innerJoin(
        guardians,
        and(
          eq(guardians.tenantId, studentGuardians.tenantId),
          eq(guardians.id, studentGuardians.guardianId),
        ),
      )
      .where(
        and(
          eq(studentGuardians.tenantId, tenantId),
          inArray(studentGuardians.studentId, ids),
          eq(studentGuardians.isPrimary, true),
          eq(studentGuardians.status, 'ACTIVE'),
        ),
      );
    for (const r of rows)
      out.set(r.studentId, {
        name: `${r.first} ${r.last}`,
        phone: r.phone,
        email: r.email,
      });
    return out;
  }

  // ---- reminders ---------------------------------------------------------------------------------

  private async writeReminder(
    ex: Executor,
    c: Caller,
    o: Overdue,
    stage: ReminderStage,
    today: string,
    note: string | null,
    automatic: boolean,
  ) {
    const id = uuidv7();
    const days = daysBetween(o.oldest, today);
    await ex.insert(feeReminders).values({
      id,
      tenantId: c.tenantId,
      studentId: o.studentId,
      stage,
      outstandingAmount: fromMinor(o.outstanding),
      oldestDueDate: o.oldest,
      daysOverdue: days,
      note,
      createdBy: automatic ? null : c.actor.userId,
    });
    await recordChange(ex, c.actor, c.tenantId, {
      action: 'FEE_REMINDER_RECORDED',
      entityType: 'fee_reminder',
      entityId: id,
      event: 'fee_reminder.recorded',
      after: { student_id: o.studentId, stage, days_overdue: days },
      payload: {
        student_id: o.studentId,
        stage,
        outstanding_amount: fromMinor(o.outstanding),
        days_overdue: days,
        automatic,
      },
    });
    return id;
  }

  /** Record the automatic steps (first and second reminder) that have fallen due. */
  async runReminders(c: Caller, input: z.infer<typeof RunRemindersBody>) {
    requireWide(c.principal, MANAGE);
    await this.evaluatePlans(c);
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const base = await this.overdueByStudent(this.db, c.tenantId, today);
    const ids = base.map((r) => r.studentId);
    const [last, plans] = await Promise.all([
      this.lastStages(this.db, c.tenantId, base),
      this.activePlans(this.db, c.tenantId, ids),
    ]);
    const due = base
      .map((r) => ({
        r,
        step: nextStep(
          daysBetween(r.oldest, today),
          last.get(r.studentId)?.stage ?? null,
          plans.has(r.studentId),
        ),
      }))
      .filter((x) => x.step === 'DUE_FIRST' || x.step === 'DUE_SECOND')
      .slice(0, 500);
    const out = {
      dry_run: input.dry_run,
      first_reminders: 0,
      second_reminders: 0,
      student_ids: [] as string[],
    };
    for (const x of due) {
      if (x.step === 'DUE_FIRST') out.first_reminders++;
      else out.second_reminders++;
      out.student_ids.push(x.r.studentId);
    }
    if (input.dry_run || !due.length) return out;
    await this.db.transaction(async (tx) => {
      for (const x of due)
        await this.writeReminder(tx, c, x.r, STEP_STAGE[x.step]!, today, null, true);
    });
    return out;
  }

  /** Record one step by hand. Steps must follow the ladder; a letter or handover needs escalation rights. */
  async recordReminder(c: Caller, studentId: string, input: z.infer<typeof RecordReminderBody>) {
    requireWide(c.principal, MANAGE);
    if (input.stage === 'LETTER_OF_DEMAND' || input.stage === 'COLLECTIONS_HANDOVER')
      requireWide(c.principal, ESCALATE);
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    await loadStudent(this.db, c.tenantId, studentId, c.principal, 'fees.read');
    const [o] = await this.overdueByStudent(this.db, c.tenantId, today, { studentId });
    if (!o)
      throw businessRule(
        'NOTHING_OVERDUE',
        'This ltudent has no overdue fees, so there is nothing to follow up',
        {},
        'OPERATION_NOT_ALLOWED',
      );
    const last = (await this.lastStages(this.db, c.tenantId, [o])).get(studentId)?.stage ?? null;
    const have = last ? REMINDER_STAGE.indexOf(last) : -1;
    if (REMINDER_STAGE.indexOf(input.stage) !== have + 1)
      throw businessRule(
        'OUT_OF_ORDER',
        have + 1 >= REMINDER_STAGE.length
          ? 'Every step of the ladder has already been taken for this ltudent'
          : `The next step is ${REMINDER_STAGE[have + 1]!.replaceAll('_', ' ').toLowerCase()}`,
        { last_stage: last, next_stage: REMINDER_STAGE[have + 1] ?? null },
        'OPERATION_NOT_ALLOWED',
      );
    const id = await this.db.transaction((tx) =>
      this.writeReminder(tx, c, o, input.stage, today, input.note ?? null, false),
    );
    return { id, student_id: studentId, stage: input.stage };
  }

  async history(c: Caller, studentId: string) {
    requireWide(c.principal, MANAGE);
    await loadStudent(this.db, c.tenantId, studentId, c.principal, 'fees.read');
    const rows = await this.db
      .select()
      .from(feeReminders)
      .where(and(eq(feeReminders.tenantId, c.tenantId), eq(feeReminders.studentId, studentId)))
      .orderBy(desc(feeReminders.createdAt), desc(feeReminders.id))
      .limit(100);
    return {
      data: rows.map((r) => ({
        id: r.id,
        stage: r.stage,
        outstanding_amount: r.outstandingAmount,
        oldest_due_date: r.oldestDueDate,
        days_overdue: r.daysOverdue,
        note: r.note,
        automatic: r.createdBy === null,
        created_at: r.createdAt.toISOString(),
      })),
    };
  }

  // ---- payment plans -----------------------------------------------------------------------------

  private async activePlans(ex: Executor, tenantId: string, ids: string[]) {
    const out = new Map<string, PlanRow>();
    if (!ids.length) return out;
    const rows = await ex
      .select()
      .from(feePaymentPlans)
      .where(
        and(
          eq(feePaymentPlans.tenantId, tenantId),
          eq(feePaymentPlans.status, 'ACTIVE'),
          inArray(feePaymentPlans.studentId, ids),
        ),
      );
    for (const p of rows) out.set(p.studentId, p);
    return out;
  }

  /** Net amount allocated to a ltudent's fees since the plan was agreed (an instant, so time zones cannot shift it). */
  private async paidSince(ex: Executor, tenantId: string, studentId: string, since: Date) {
    const [r] = await ex
      .select({
        v: sql<string>`coalesce(sum(${paymentAllocations.allocatedAmount} - ${paymentAllocations.reversedAmount}), 0)`,
      })
      .from(paymentAllocations)
      .where(
        and(
          eq(paymentAllocations.tenantId, tenantId),
          eq(paymentAllocations.studentId, studentId),
          gte(paymentAllocations.createdAt, since),
        ),
      );
    return toMinor(r?.v ?? '0');
  }

  /**
   * Close active plans whose instalments are all covered (COMPLETED) or that missed one (BROKEN).
   * Idempotent; runs before the arrears and plan lists are read.
   */
  async evaluatePlans(c: Caller, limit = 500) {
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const active = await this.db
      .select()
      .from(feePaymentPlans)
      .where(and(eq(feePaymentPlans.tenantId, c.tenantId), eq(feePaymentPlans.status, 'ACTIVE')))
      .orderBy(asc(feePaymentPlans.id))
      .limit(limit);
    const out = { completed: 0, broken: 0 };
    for (const p of active) {
      const items = await this.db
        .select()
        .from(feePlanInstalments)
        .where(
          and(eq(feePlanInstalments.tenantId, c.tenantId), eq(feePlanInstalments.planId, p.id)),
        );
      const paid = await this.paidSince(this.db, c.tenantId, p.studentId, p.createdAt);
      const prog = planProgress(items, paid, today);
      const next = prog.all_paid ? 'COMPLETED' : prog.any_missed ? 'BROKEN' : null;
      if (!next) continue;
      const reason = next === 'COMPLETED' ? 'All instalments paid' : 'An instalment was missed';
      const changed = await this.db.transaction(async (tx) => {
        const res = await tx
          .update(feePaymentPlans)
          .set({
            status: next,
            brokenOn: next === 'BROKEN' ? today : null,
            closedReason: reason,
            version: sql`${feePaymentPlans.version} + 1`,
          })
          .where(
            and(
              eq(feePaymentPlans.tenantId, c.tenantId),
              eq(feePaymentPlans.id, p.id),
              eq(feePaymentPlans.status, 'ACTIVE'),
            ),
          );
        if (!res[0].affectedRows) return false;
        await recordChange(tx, c.actor, c.tenantId, {
          action: next === 'COMPLETED' ? 'FEE_PLAN_COMPLETED' : 'FEE_PLAN_BROKEN',
          entityType: 'fee_payment_plan',
          entityId: p.id,
          event: next === 'COMPLETED' ? 'fee_plan.completed' : 'fee_plan.broken',
          before: { status: 'ACTIVE' },
          after: { status: next },
          payload: { student_id: p.studentId },
        });
        return true;
      });
      if (changed) {
        if (next === 'COMPLETED') out.completed++;
        else out.broken++;
      }
    }
    return out;
  }

  private async presentPlan(c: Caller, p: PlanRow, today: string) {
    const items = await this.db
      .select()
      .from(feePlanInstalments)
      .where(and(eq(feePlanInstalments.tenantId, c.tenantId), eq(feePlanInstalments.planId, p.id)));
    const paid = await this.paidSince(this.db, c.tenantId, p.studentId, p.createdAt);
    const prog = planProgress(items, paid, today);
    return {
      id: p.id,
      student_id: p.studentId,
      status: p.status,
      total_amount: p.totalAmount,
      paid_amount: fromMinor(paid > toMinor(p.totalAmount) ? toMinor(p.totalAmount) : paid),
      start_date: p.startDate,
      note: p.note,
      broken_on: p.brokenOn,
      closed_reason: p.closedReason,
      instalments: prog.instalments,
      created_at: p.createdAt.toISOString(),
    };
  }

  async createPlan(c: Caller, input: z.infer<typeof CreatePlanBody>) {
    requireWide(c.principal, MANAGE);
    const exceeding = input.instalments.length > MAX_PLAN_INSTALMENTS;
    if (exceeding) {
      if (!input.exceeds_policy)
        throw businessRule(
          'EXCEEDS_POLICY',
          `A plan is limited to ${MAX_PLAN_INSTALMENTS} instalments. A longer plan needs the finance committee.`,
          { max_instalments: MAX_PLAN_INSTALMENTS },
          'OPERATION_NOT_ALLOWED',
        );
      requireWide(c.principal, ESCALATE);
    }
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    let total = 0n;
    for (const i of input.instalments) {
      const m = toMinor(i.amount);
      if (m <= 0n)
        throw businessRule(
          'AMOUNT_NOT_POSITIVE',
          'Every instalment must be more than zero',
          {},
          'OPERATION_NOT_ALLOWED',
        );
      if (i.due_date < today)
        throw businessRule(
          'DATE_IN_PAST',
          'An instalment cannot fall due in the past',
          { due_date: i.due_date },
          'OPERATION_NOT_ALLOWED',
        );
      total += m;
    }
    const planId = await this.db.transaction(async (tx) => {
      await loadStudent(tx, c.tenantId, input.student_id, c.principal, 'fees.read', {
        lock: true,
      });
      const [existing] = await tx
        .select({ id: feePaymentPlans.id })
        .from(feePaymentPlans)
        .where(
          and(
            eq(feePaymentPlans.tenantId, c.tenantId),
            eq(feePaymentPlans.studentId, input.student_id),
            eq(feePaymentPlans.status, 'ACTIVE'),
          ),
        );
      if (existing)
        throw businessRule(
          'PLAN_ALREADY_ACTIVE',
          'This ltudent already has an active payment plan. Cancel it before creating another.',
          { plan_id: existing.id },
          'OPERATION_NOT_ALLOWED',
        );
      const [o] = await this.overdueByStudent(tx, c.tenantId, today, {
        studentId: input.student_id,
      });
      if (!o)
        throw businessRule(
          'NOTHING_OVERDUE',
          'This ltudent has no overdue fees to put on a plan',
          {},
          'OPERATION_NOT_ALLOWED',
        );
      if (total > o.outstanding)
        throw businessRule(
          'PLAN_EXCEEDS_ARREARS',
          'The instalments add up to more than the overdue amount',
          { overdue_amount: fromMinor(o.outstanding), plan_total: fromMinor(total) },
          'OPERATION_NOT_ALLOWED',
        );
      const id = uuidv7();
      await tx.insert(feePaymentPlans).values({
        id,
        tenantId: c.tenantId,
        studentId: input.student_id,
        totalAmount: fromMinor(total),
        startDate: today,
        note: input.note ?? null,
        createdBy: c.actor.userId,
      });
      const sorted = [...input.instalments].sort((a, b) => a.due_date.localeCompare(b.due_date));
      await tx.insert(feePlanInstalments).values(
        sorted.map((i, n) => ({
          id: uuidv7(),
          tenantId: c.tenantId,
          planId: id,
          seq: n + 1,
          dueDate: i.due_date,
          amount: fromMinor(toMinor(i.amount)),
        })),
      );
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_PLAN_CREATED',
        entityType: 'fee_payment_plan',
        entityId: id,
        event: 'fee_plan.created',
        after: {
          student_id: input.student_id,
          total_amount: fromMinor(total),
          instalments: sorted.length,
          exceeds_policy: exceeding,
        },
        payload: { student_id: input.student_id, total_amount: fromMinor(total) },
      });
      return id;
    });
    return this.getPlan(c, planId);
  }

  async getPlan(c: Caller, id: string) {
    requireWide(c.principal, MANAGE);
    const [p] = await this.db
      .select()
      .from(feePaymentPlans)
      .where(and(eq(feePaymentPlans.tenantId, c.tenantId), eq(feePaymentPlans.id, id)));
    if (!p) throw new NotFoundError('Payment plan');
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const minis = await studentMinis(this.db, c.tenantId, [p.studentId]);
    return { ...(await this.presentPlan(c, p, today)), student: minis.get(p.studentId) ?? null };
  }

  async plans(c: Caller, q: z.infer<typeof PlanListQuery>) {
    requireWide(c.principal, MANAGE);
    await this.evaluatePlans(c);
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const where = and(
      eq(feePaymentPlans.tenantId, c.tenantId),
      q.status ? eq(feePaymentPlans.status, q.status) : undefined,
      q.student_id ? eq(feePaymentPlans.studentId, q.student_id) : undefined,
    );
    const [rows, [tot]] = await Promise.all([
      this.db
        .select()
        .from(feePaymentPlans)
        .where(where)
        .orderBy(desc(feePaymentPlans.createdAt), desc(feePaymentPlans.id))
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(feePaymentPlans).where(where),
    ]);
    const minis = await studentMinis(
      this.db,
      c.tenantId,
      rows.map((r) => r.studentId),
    );
    const data = [];
    for (const p of rows)
      data.push({
        ...(await this.presentPlan(c, p, today)),
        student: minis.get(p.studentId) ?? null,
      });
    return pageOf(data, Number(tot?.n ?? 0), q);
  }

  async cancelPlan(c: Caller, id: string, input: z.infer<typeof CancelPlanBody>) {
    requireWide(c.principal, MANAGE);
    await this.db.transaction(async (tx) => {
      const [p] = await tx
        .select()
        .from(feePaymentPlans)
        .where(and(eq(feePaymentPlans.tenantId, c.tenantId), eq(feePaymentPlans.id, id)))
        .for('update');
      if (!p) throw new NotFoundError('Payment plan');
      if (p.status !== 'ACTIVE')
        throw businessRule(
          'PLAN_NOT_ACTIVE',
          'Only an active plan can be cancelled',
          { status: p.status },
          'OPERATION_NOT_ALLOWED',
        );
      await tx
        .update(feePaymentPlans)
        .set({
          status: 'CANCELLED',
          closedReason: input.reason,
          version: sql`${feePaymentPlans.version} + 1`,
        })
        .where(and(eq(feePaymentPlans.tenantId, c.tenantId), eq(feePaymentPlans.id, id)));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_PLAN_CANCELLED',
        entityType: 'fee_payment_plan',
        entityId: id,
        event: 'fee_plan.cancelled',
        before: { status: 'ACTIVE' },
        after: { status: 'CANCELLED' },
        reason: input.reason,
        payload: { student_id: p.studentId },
      });
    });
    return this.getPlan(c, id);
  }
}
