import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { z } from "zod";
import type { Deps } from "../../container.js";
import type { Executor } from "../../db/client.js";
import {
  academicClasses,
  academicSections,
  academicYears,
  enrollments,
  feeDemands,
  feeReceipts,
  feeSettings,
  feeStructures,
  OPEN_ENROLLMENT_STATUSES,
  schoolPayments,
  studentFeeAssignments,
  students,
  type PaymentPlan,
} from "../../db/schema/index.js";
import { recordChange } from "../../platform/record.js";
import { NotFoundError } from "../../shared/errors.js";
import { loadStudent } from "../students/support.js";
import {
  CHARGES_CODE,
  GRADE_LIKE,
  componentOf,
  ensureCategory,
  gradeCode,
  insertAssignment,
  insertPublishedStructure,
  isGradeCode,
  lapseEarlyPaymentDiscounts,
  periodsOf,
  rebuildGradeSchedule,
  scheduleStart,
  splitPlan,
  type Ctx,
  type Year,
} from "./learner-schedule.js";
import type {
  AddChargeBody,
  ChangePlanBody,
  GradeFeesBody,
  PlanSettingsBody,
  TrackerQuery,
} from "./learner-fees.schemas.js";
import { applyBp, fromMinor, percentToBp, toMinor } from "./money.js";
import { PLAN_LABELS, splitEven } from "./schedule.js";
import {
  businessRule,
  ensureSettings,
  feeScope,
  moneyOf,
  nextNumber,
  outstandingOfMoney,
  readSettings,
  requireWide,
  schoolToday,
  statusAfter,
  type Caller,
  type DemandRow,
  type SettingsRow,
} from "./support.js";

const OPEN = [...OPEN_ENROLLMENT_STATUSES];
const PLANS: PaymentPlan[] = ["MONTHLY", "TERMLY", "ANNUAL"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
const shortDate = (d: string) =>
  `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

/** State of one instalment as the learner account shows it. */
function stateOf(d: DemandRow, today: string) {
  const m = moneyOf(d);
  const out = outstandingOfMoney(m);
  if (d.status === "WAIVED") return "WAIVED";
  if (d.status === "WRITTEN_OFF") return "WRITTEN_OFF";
  if (out <= 0n) return "PAID";
  if (d.dueDate < today) return "OVERDUE";
  if (m.paid > 0n) return "PART_PAID";
  return d.dueDate === today ? "DUE" : "UPCOMING";
}

const presentLine = (d: DemandRow, today: string) => {
  const m = moneyOf(d);
  return {
    id: d.id,
    demand_number: d.demandNumber,
    label: d.periodLabel,
    description: d.description,
    due_date: d.dueDate,
    amount: d.finalAmount,
    original_amount: d.originalAmount,
    discount_amount: d.discountAmount,
    paid_amount: d.paidAmount,
    outstanding_amount: fromMinor(outstandingOfMoney(m)),
    state: stateOf(d, today),
  };
};

/**
 * Grade fees, learner payment plans, the fee tracker and the learner fee account — the simple
 * fee flow of the admin panel. Money still moves through the demand / payment engine.
 */
export class LearnerFeesService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  // ---- shared -------------------------------------------------------------------------------------

  private async year(
    ex: Executor,
    tenantId: string,
    id?: string,
  ): Promise<Year & { name: string }> {
    const [y] = await ex
      .select()
      .from(academicYears)
      .where(
        and(
          eq(academicYears.tenantId, tenantId),
          id ? eq(academicYears.id, id) : eq(academicYears.isCurrent, true),
        ),
      );
    if (!y) {
      if (id) throw new NotFoundError("Academic year");
      throw businessRule(
        "NO_CURRENT_YEAR",
        "Set a current academic year first",
      );
    }
    return {
      id: y.id,
      name: y.name,
      startDate: y.startDate,
      endDate: y.endDate,
    };
  }

  private async ctx(tx: Executor, c: Caller): Promise<Ctx> {
    return {
      tenantId: c.tenantId,
      actor: c.actor,
      now: this.deps.clock.now(),
      today: await schoolToday(tx, c.tenantId, this.deps.clock),
      settings: await readSettings(tx, c.tenantId),
    };
  }

  /** Published grade fee per class for a year: class id → structure + amount. */
  private async gradeFeesOf(ex: Executor, tenantId: string, yearId: string) {
    const rows = await ex
      .select()
      .from(feeStructures)
      .where(
        and(
          eq(feeStructures.tenantId, tenantId),
          eq(feeStructures.academicYearId, yearId),
          eq(feeStructures.status, "PUBLISHED"),
          like(feeStructures.code, GRADE_LIKE),
        ),
      );
    const out = new Map<
      string,
      { structure: (typeof rows)[number]; amount: string }
    >();
    for (const s of rows) {
      if (!s.academicClassId) continue;
      const comp = await componentOf(ex, tenantId, s.id);
      if (comp)
        out.set(s.academicClassId, { structure: s, amount: comp.amount });
    }
    return out;
  }

  private planDescription(plan: PaymentPlan, s: SettingsRow, year: Year) {
    const p = periodsOf(plan, s, year);
    if (plan === "MONTHLY") {
      const first = p[0]?.label.slice(0, 3) ?? "";
      const last = p[p.length - 1]?.label.slice(0, 3) ?? "";
      return `${p.length} equal instalments, due on the ${ordinal(s.monthlyDueDay)}, ${first} to ${last}.`;
    }
    if (plan === "TERMLY")
      return `${p.length} instalments, due at the start of each term (${p.map((x) => shortDate(x.dueDate)).join(", ")}).`;
    const pct = Number(s.annualDiscountPercent);
    return `One payment by ${p[0] ? shortDate(p[0].dueDate) : "the due date"}${pct > 0 ? `, with ${pct}% off` : ""}.`;
  }

  /** What one instalment of `annual` is on each plan (whole-year split, before any payment). */
  private planAmounts(annual: string, s: SettingsRow, year: Year) {
    const total = toMinor(annual);
    const bp = percentToBp(s.annualDiscountPercent);
    return Object.fromEntries(
      PLANS.map((plan) => {
        const n = periodsOf(plan, s, year).length || 1;
        const first = splitEven(total, n)[0]!;
        const amount = plan === "ANNUAL" ? first - applyBp(first, bp) : first;
        return [plan, { instalments: n, amount: fromMinor(amount) }];
      }),
    ) as Record<PaymentPlan, { instalments: number; amount: string }>;
  }

  private presentPlanSettings(s: SettingsRow, year: Year) {
    return {
      currency: s.currency,
      monthly_instalments: s.monthlyInstalments,
      monthly_due_day: s.monthlyDueDay,
      term_due_dates: s.termDueDates ?? null,
      annual_discount_percent: s.annualDiscountPercent,
      annual_pay_by: s.annualPayBy,
      default_payment_plan: s.defaultPaymentPlan,
      version: s.version,
      plans: PLANS.map((plan) => ({
        plan,
        label: PLAN_LABELS[plan],
        description: this.planDescription(plan, s, year),
        due_dates: periodsOf(plan, s, year).map((p) => ({
          label: p.label,
          due_date: p.dueDate,
        })),
      })),
    };
  }

  // ---- fee plans (grade fees) ---------------------------------------------------------------------

  /** GET /fees/grade-fees: every grade with its annual fee, the per-plan amounts and plan take-up. */
  async gradeFees(c: Caller, yearId?: string) {
    await ensureSettings(this.db, c.tenantId);
    const year = await this.year(this.db, c.tenantId, yearId);
    const settings = await readSettings(this.db, c.tenantId);
    const [classes, fees, learners, takeUp] = await Promise.all([
      this.db
        .select()
        .from(academicClasses)
        .where(
          and(
            eq(academicClasses.tenantId, c.tenantId),
            eq(academicClasses.status, "ACTIVE"),
          ),
        )
        .orderBy(asc(academicClasses.sequence), asc(academicClasses.name)),
      this.gradeFeesOf(this.db, c.tenantId, year.id),
      this.db
        .select({
          classId: enrollments.classId,
          n: sql<number>`count(distinct ${enrollments.studentId})`,
        })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.tenantId, c.tenantId),
            eq(enrollments.academicYearId, year.id),
            inArray(enrollments.status, OPEN),
          ),
        )
        .groupBy(enrollments.classId),
      this.db
        .select({
          classId: feeStructures.academicClassId,
          plan: studentFeeAssignments.paymentPlan,
          n: sql<number>`count(*)`,
        })
        .from(studentFeeAssignments)
        .innerJoin(
          feeStructures,
          and(
            eq(feeStructures.tenantId, studentFeeAssignments.tenantId),
            eq(feeStructures.id, studentFeeAssignments.feeStructureId),
          ),
        )
        .where(
          and(
            eq(studentFeeAssignments.tenantId, c.tenantId),
            eq(studentFeeAssignments.academicYearId, year.id),
            eq(studentFeeAssignments.status, "ACTIVE"),
            like(studentFeeAssignments.structureCode, GRADE_LIKE),
          ),
        )
        .groupBy(
          feeStructures.academicClassId,
          studentFeeAssignments.paymentPlan,
        ),
    ]);
    const learnerMap = new Map(learners.map((r) => [r.classId, Number(r.n)]));
    const totals: Record<PaymentPlan, number> = {
      MONTHLY: 0,
      TERMLY: 0,
      ANNUAL: 0,
    };
    const byClass = new Map<string, Record<PaymentPlan, number>>();
    for (const r of takeUp) {
      if (!r.classId || !r.plan) continue;
      const m = byClass.get(r.classId) ?? { MONTHLY: 0, TERMLY: 0, ANNUAL: 0 };
      m[r.plan] += Number(r.n);
      totals[r.plan] += Number(r.n);
      byClass.set(r.classId, m);
    }
    const plansSettings = this.presentPlanSettings(settings, year);
    return {
      academic_year: {
        id: year.id,
        name: year.name,
        start_date: year.startDate,
        end_date: year.endDate,
      },
      settings: plansSettings,
      plans: plansSettings.plans.map((p) => ({
        ...p,
        learners: totals[p.plan],
      })),
      grades: classes.map((k) => {
        const fee = fees.get(k.id);
        const counts = byClass.get(k.id) ?? {
          MONTHLY: 0,
          TERMLY: 0,
          ANNUAL: 0,
        };
        const amounts = fee
          ? this.planAmounts(fee.amount, settings, year)
          : null;
        return {
          class_id: k.id,
          name: k.displayName ?? k.name,
          learners: learnerMap.get(k.id) ?? 0,
          annual_fee: fee?.amount ?? null,
          version_no: fee?.structure.versionNo ?? null,
          plans: PLANS.map((plan) => ({
            plan,
            instalments: amounts?.[plan].instalments ?? null,
            amount: amounts?.[plan].amount ?? null,
            learners: counts[plan],
          })),
        };
      }),
    };
  }

  /**
   * PUT /fees/grade-fees: sets the annual fee of one or more grades. A grade's first fee bills every
   * learner already enrolled (on the school's default plan). Changing a fee publishes a new version;
   * with `update_existing`, learners already billed have what they still owe re-split at the new fee.
   */
  async setGradeFees(c: Caller, input: z.infer<typeof GradeFeesBody>) {
    requireWide(c.principal, "fees.manage");
    await ensureSettings(this.db, c.tenantId);
    const year = await this.year(this.db, c.tenantId, input.academic_year_id);
    const summary = {
      created: 0,
      updated: 0,
      unchanged: 0,
      learners_billed: 0,
      learners_resplit: 0,
    };
    await this.db.transaction(async (tx) => {
      const ctx = await this.ctx(tx, c);
      await tx
        .select()
        .from(feeSettings)
        .where(eq(feeSettings.tenantId, c.tenantId))
        .for("update");
      const categoryId = await ensureCategory(tx, ctx, "TUITION", "Tuition");
      const current = await this.gradeFeesOf(tx, c.tenantId, year.id);
      for (const f of input.fees) {
        const [klass] = await tx
          .select()
          .from(academicClasses)
          .where(
            and(
              eq(academicClasses.tenantId, c.tenantId),
              eq(academicClasses.id, f.class_id),
            ),
          );
        if (!klass) throw new NotFoundError("Grade");
        const old = current.get(klass.id);
        if (old && toMinor(old.amount) === toMinor(f.annual_fee)) {
          summary.unchanged++;
          continue;
        }
        const { structure, component } = await insertPublishedStructure(
          tx,
          ctx,
          {
            code: old?.structure.code ?? gradeCode(klass.code),
            name: `${klass.displayName ?? klass.name} fee`,
            yearId: year.id,
            yearStart: year.startDate,
            classId: klass.id,
            categoryId,
            componentName: "School fees",
            amount: f.annual_fee,
            frequency: "ANNUAL",
            supersedes: old?.structure,
          },
        );
        await recordChange(tx, c.actor, c.tenantId, {
          action: old ? "GRADE_FEE_CHANGED" : "GRADE_FEE_SET",
          entityType: "fee_structure",
          entityId: structure.id,
          event: "fee_structure.published",
          before: old ? { annual_fee: old.amount } : undefined,
          after: {
            class_id: klass.id,
            annual_fee: f.annual_fee,
            version_no: structure.versionNo,
          },
          payload: { code: structure.code, academic_year_id: year.id },
        });
        if (old) {
          summary.updated++;
          const assigned = await tx
            .select()
            .from(studentFeeAssignments)
            .where(
              and(
                eq(studentFeeAssignments.tenantId, c.tenantId),
                eq(studentFeeAssignments.feeStructureId, old.structure.id),
                eq(studentFeeAssignments.status, "ACTIVE"),
              ),
            )
            .orderBy(asc(studentFeeAssignments.id))
            .for("update");
          for (const a of assigned) {
            await tx
              .update(studentFeeAssignments)
              .set({ feeStructureId: structure.id, version: a.version + 1 })
              .where(eq(studentFeeAssignments.id, a.id));
            if (!input.update_existing) continue;
            await rebuildGradeSchedule(tx, ctx, {
              assignment: { ...a, feeStructureId: structure.id },
              structure,
              component,
              plan: a.paymentPlan ?? ctx.settings.defaultPaymentPlan,
              year,
              from: ctx.today > year.startDate ? ctx.today : year.startDate,
              reason: `Grade fee changed to ${f.annual_fee}`,
            });
            summary.learners_resplit++;
          }
        } else {
          summary.created++;
          const open = await tx
            .select()
            .from(enrollments)
            .where(
              and(
                eq(enrollments.tenantId, c.tenantId),
                eq(enrollments.academicYearId, year.id),
                eq(enrollments.classId, klass.id),
                inArray(enrollments.status, OPEN),
              ),
            )
            .orderBy(asc(enrollments.id));
          for (const e of open) {
            const a = await insertAssignment(
              tx,
              ctx,
              structure,
              e,
              ctx.settings.defaultPaymentPlan,
            );
            await rebuildGradeSchedule(tx, ctx, {
              assignment: a,
              structure,
              component,
              plan: a.paymentPlan!,
              year,
              from: scheduleStart(year, e.startDate),
              reason: "Grade fee set",
            });
            summary.learners_billed++;
          }
        }
      }
    });
    return { ...summary, ...(await this.gradeFees(c, year.id)) };
  }

  /** PATCH /fees/plan-settings: monthly count and due day, term dates, annual discount and due date. */
  async updatePlanSettings(c: Caller, input: z.infer<typeof PlanSettingsBody>) {
    requireWide(c.principal, "fees.settings.manage");
    await ensureSettings(this.db, c.tenantId);
    const year = await this.year(this.db, c.tenantId).catch(() => null);
    await this.db.transaction(async (tx) => {
      const before = await readSettings(tx, c.tenantId, "update");
      const set: Partial<typeof feeSettings.$inferInsert> = {
        version: before.version + 1,
        updatedBy: c.actor.userId,
      };
      if (input.monthly_instalments !== undefined)
        set.monthlyInstalments = input.monthly_instalments;
      if (input.monthly_due_day !== undefined)
        set.monthlyDueDay = input.monthly_due_day;
      if (input.term_due_dates !== undefined)
        set.termDueDates = input.term_due_dates;
      if (input.annual_discount_percent !== undefined)
        set.annualDiscountPercent = input.annual_discount_percent;
      if (input.annual_pay_by !== undefined)
        set.annualPayBy = input.annual_pay_by;
      if (input.default_payment_plan !== undefined)
        set.defaultPaymentPlan = input.default_payment_plan;
      await tx
        .update(feeSettings)
        .set(set)
        .where(eq(feeSettings.tenantId, c.tenantId));
      await recordChange(tx, c.actor, c.tenantId, {
        action: "FEE_PLAN_SETTINGS_UPDATED",
        entityType: "fee_settings",
        entityId: c.tenantId,
        before: {
          monthly_instalments: before.monthlyInstalments,
          monthly_due_day: before.monthlyDueDay,
          term_due_dates: before.termDueDates,
          annual_discount_percent: before.annualDiscountPercent,
          annual_pay_by: before.annualPayBy,
          default_payment_plan: before.defaultPaymentPlan,
        },
        after: input,
      });
    });
    const s = await readSettings(this.db, c.tenantId);
    return year ? this.presentPlanSettings(s, year) : { version: s.version };
  }

  // ---- learner account ----------------------------------------------------------------------------

  /** The learner's open enrolment in the year (or their latest one), with class and section names. */
  private async placement(
    ex: Executor,
    tenantId: string,
    studentId: string,
    yearId: string,
  ) {
    const [e] = await ex
      .select({
        e: enrollments,
        className: academicClasses.name,
        classDisplay: academicClasses.displayName,
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
          eq(enrollments.studentId, studentId),
          eq(enrollments.academicYearId, yearId),
        ),
      )
      .orderBy(
        sql`${enrollments.status} in ('PENDING','ACTIVE') desc`,
        desc(enrollments.startDate),
      )
      .limit(1);
    if (!e) return null;
    const className = e.classDisplay ?? e.className;
    return {
      enrollment: e.e,
      class_id: e.e.classId,
      class_name: className,
      section_id: e.e.sectionId,
      section_name: e.sectionName,
      open: OPEN.includes(e.e.status),
    };
  }

  /** The year to show a learner's account for: the given one, the current one, or their latest enrolment's. */
  private async learnerYear(
    ex: Executor,
    tenantId: string,
    studentId: string,
    id?: string,
  ) {
    if (id) return this.year(ex, tenantId, id);
    const cur = await this.year(ex, tenantId).catch(() => null);
    if (cur) return cur;
    const [e] = await ex
      .select({ y: enrollments.academicYearId })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.studentId, studentId),
        ),
      )
      .orderBy(desc(enrollments.startDate))
      .limit(1);
    if (!e)
      throw businessRule(
        "NO_CURRENT_YEAR",
        "Set a current academic year first",
      );
    return this.year(ex, tenantId, e.y);
  }

  /** GET /fees/learners/:student_id — the learner fee account. */
  async account(c: Caller, studentId: string, yearId?: string) {
    const student = await loadStudent(
      this.db,
      c.tenantId,
      studentId,
      c.principal,
      "fees.read",
    );
    await ensureSettings(this.db, c.tenantId);
    const year = await this.learnerYear(this.db, c.tenantId, studentId, yearId);
    const now = this.deps.clock.now();
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    // The annual plan's discount lapses once its due date passes unpaid (kept current on read).
    await this.db.transaction((tx) =>
      lapseEarlyPaymentDiscounts(
        tx,
        { tenantId: c.tenantId, actor: c.actor, now, today },
        studentId,
      ),
    );
    const settings = await readSettings(this.db, c.tenantId);
    const [place, fees, demands, assignments, payments] = await Promise.all([
      this.placement(this.db, c.tenantId, studentId, year.id),
      this.gradeFeesOf(this.db, c.tenantId, year.id),
      this.db
        .select({ d: feeDemands, code: studentFeeAssignments.structureCode })
        .from(feeDemands)
        .innerJoin(
          studentFeeAssignments,
          and(
            eq(studentFeeAssignments.tenantId, feeDemands.tenantId),
            eq(studentFeeAssignments.id, feeDemands.studentFeeAssignmentId),
          ),
        )
        .where(
          and(
            eq(feeDemands.tenantId, c.tenantId),
            eq(feeDemands.studentId, studentId),
            eq(feeDemands.academicYearId, year.id),
            sql`${feeDemands.status} not in ('DRAFT','CANCELLED')`,
          ),
        )
        .orderBy(asc(feeDemands.dueDate), asc(feeDemands.demandNumber)),
      this.db
        .select()
        .from(studentFeeAssignments)
        .where(
          and(
            eq(studentFeeAssignments.tenantId, c.tenantId),
            eq(studentFeeAssignments.studentId, studentId),
            eq(studentFeeAssignments.academicYearId, year.id),
            eq(studentFeeAssignments.status, "ACTIVE"),
            like(studentFeeAssignments.structureCode, GRADE_LIKE),
          ),
        )
        .limit(1),
      this.db
        .select({
          p: schoolPayments,
          receiptId: feeReceipts.id,
          receiptNumber: feeReceipts.receiptNumber,
        })
        .from(schoolPayments)
        .leftJoin(
          feeReceipts,
          and(
            eq(feeReceipts.tenantId, schoolPayments.tenantId),
            eq(feeReceipts.paymentId, schoolPayments.id),
            eq(feeReceipts.status, "ISSUED"),
          ),
        )
        .where(
          and(
            eq(schoolPayments.tenantId, c.tenantId),
            eq(schoolPayments.studentId, studentId),
          ),
        )
        .orderBy(
          desc(schoolPayments.receivedOn),
          desc(schoolPayments.paymentNumber),
        )
        .limit(50),
    ]);
    const grade = demands.filter((r) => isGradeCode(r.code)).map((r) => r.d);
    const other = demands.filter((r) => !isGradeCode(r.code)).map((r) => r.d);
    const all = demands.map((r) => r.d);
    const a = assignments[0] ?? null;
    const sum = (rows: DemandRow[], f: (d: DemandRow) => bigint) =>
      rows.reduce((t, d) => t + f(d), 0n);
    const billed = sum(all, (d) => toMinor(d.finalAmount));
    const paid = sum(all, (d) => toMinor(d.paidAmount));
    const overdue = all.filter((d) => stateOf(d, today) === "OVERDUE");
    const owing = sum(overdue, (d) => outstandingOfMoney(moneyOf(d)));
    const next =
      all.find(
        (d) => d.dueDate >= today && outstandingOfMoney(moneyOf(d)) > 0n,
      ) ?? null;
    const credit = payments.reduce(
      (t, r) =>
        r.p.status === "RECEIVED"
          ? t +
            toMinor(r.p.amount) -
            toMinor(r.p.allocatedAmount) -
            toMinor(r.p.refundedAmount)
          : t,
      0n,
    );
    const annualFee = place ? (fees.get(place.class_id)?.amount ?? null) : null;
    // What changing plan would do: re-split what is still owed from today.
    const kept = grade.filter(
      (d) => moneyOf(d).paid > 0n || d.status === "PAID",
    );
    const remaining = annualFee
      ? toMinor(annualFee) - sum(kept, (d) => toMinor(d.originalAmount))
      : 0n;
    const from = today > year.startDate ? today : year.startDate;
    return {
      student: {
        id: student.id,
        full_name: [student.firstName, student.middleName, student.lastName]
          .filter(Boolean)
          .join(" "),
        student_number: student.studentNumber,
        admission_number: student.admissionNumber,
      },
      placement: place
        ? {
            class_id: place.class_id,
            class_name: place.class_name,
            section_id: place.section_id,
            section_name: place.section_name,
            enrolled: place.open,
          }
        : null,
      academic_year: { id: year.id, name: year.name },
      currency: settings.currency,
      today,
      plan: a?.paymentPlan ?? null,
      plan_label: a?.paymentPlan ? PLAN_LABELS[a.paymentPlan] : null,
      annual_fee: annualFee,
      totals: {
        billed: fromMinor(billed),
        paid: fromMinor(paid),
        paid_percent: billed > 0n ? Number((paid * 100n) / billed) : 0,
        owing_now: fromMinor(owing),
        instalments_behind: overdue.length,
        credit: fromMinor(credit),
      },
      status: owing > 0n ? "OVERDUE" : "UP_TO_DATE",
      next_instalment: next
        ? {
            label: next.periodLabel,
            amount: fromMinor(outstandingOfMoney(moneyOf(next))),
            due_date: next.dueDate,
          }
        : null,
      instalments: grade.map((d) => presentLine(d, today)),
      charges: other.map((d) => presentLine(d, today)),
      payments: payments.map(({ p, receiptId, receiptNumber }) => ({
        id: p.id,
        payment_number: p.paymentNumber,
        received_on: p.receivedOn,
        method: p.method,
        status: p.status,
        amount: p.amount,
        unallocated_amount: fromMinor(
          toMinor(p.amount) -
            toMinor(p.allocatedAmount) -
            toMinor(p.refundedAmount),
        ),
        reference: p.providerReference,
        receipt_id: receiptId,
        receipt_number: receiptNumber,
      })),
      plan_options:
        annualFee && place?.open
          ? PLANS.map((plan) => {
              const parts = splitPlan(
                plan,
                settings,
                year,
                remaining,
                from,
                today,
              );
              return {
                plan,
                label: PLAN_LABELS[plan],
                description: this.planDescription(plan, settings, year),
                instalments: parts.length,
                amount: parts[0]
                  ? fromMinor(parts[0].amount - parts[0].discount)
                  : "0.00",
                discount: parts[0] ? fromMinor(parts[0].discount) : "0.00",
                current: plan === a?.paymentPlan,
              };
            })
          : [],
    };
  }

  /** POST /fees/learners/:student_id/plan — change how the learner pays; re-splits what they still owe. */
  async changePlan(
    c: Caller,
    studentId: string,
    input: z.infer<typeof ChangePlanBody>,
  ) {
    await loadStudent(
      this.db,
      c.tenantId,
      studentId,
      c.principal,
      "fees.manage",
    );
    await ensureSettings(this.db, c.tenantId);
    const year = await this.learnerYear(
      this.db,
      c.tenantId,
      studentId,
      input.academic_year_id,
    );
    await this.db.transaction(async (tx) => {
      const ctx = await this.ctx(tx, c);
      const place = await this.placement(tx, c.tenantId, studentId, year.id);
      if (!place?.open)
        throw businessRule(
          "NOT_ENROLLED",
          "The student is not enrolled in this academic year",
        );
      const fee = (await this.gradeFeesOf(tx, c.tenantId, year.id)).get(
        place.class_id,
      );
      if (!fee)
        throw businessRule(
          "NO_GRADE_FEE",
          `Set the annual fee for ${place.class_name} first`,
        );
      const component = (await componentOf(tx, c.tenantId, fee.structure.id))!;
      let [a] = await tx
        .select()
        .from(studentFeeAssignments)
        .where(
          and(
            eq(studentFeeAssignments.tenantId, c.tenantId),
            eq(studentFeeAssignments.studentId, studentId),
            eq(studentFeeAssignments.feeStructureId, fee.structure.id),
            eq(studentFeeAssignments.status, "ACTIVE"),
          ),
        )
        .for("update");
      const isNew = !a;
      if (!a)
        a = await insertAssignment(
          tx,
          ctx,
          fee.structure,
          place.enrollment,
          input.plan,
        );
      else if (a.paymentPlan === input.plan) return;
      else
        await tx
          .update(studentFeeAssignments)
          .set({ paymentPlan: input.plan, version: a.version + 1 })
          .where(eq(studentFeeAssignments.id, a.id));
      const start = scheduleStart(year, place.enrollment.startDate);
      await rebuildGradeSchedule(tx, ctx, {
        assignment: { ...a, paymentPlan: input.plan },
        structure: fee.structure,
        component,
        plan: input.plan,
        year,
        from: isNew ? start : ctx.today > start ? ctx.today : start,
        reason: isNew
          ? `Billed on the ${PLAN_LABELS[input.plan].toLowerCase()} plan`
          : `Plan changed from ${PLAN_LABELS[a.paymentPlan ?? "MONTHLY"]} to ${PLAN_LABELS[input.plan]}`,
      });
    });
    return this.account(c, studentId, year.id);
  }

  /** POST /fees/learners/:student_id/charges — a one-off extra (trip, uniform …) on the learner's account. */
  async addCharge(
    c: Caller,
    studentId: string,
    input: z.infer<typeof AddChargeBody>,
  ) {
    await loadStudent(
      this.db,
      c.tenantId,
      studentId,
      c.principal,
      "fees.manage",
    );
    await ensureSettings(this.db, c.tenantId);
    const year = await this.learnerYear(
      this.db,
      c.tenantId,
      studentId,
      input.academic_year_id,
    );
    await this.db.transaction(async (tx) => {
      const ctx = await this.ctx(tx, c);
      const place = await this.placement(tx, c.tenantId, studentId, year.id);
      if (!place?.open)
        throw businessRule(
          "NOT_ENROLLED",
          "The student is not enrolled in this academic year",
        );
      const [have] = await tx
        .select()
        .from(feeStructures)
        .where(
          and(
            eq(feeStructures.tenantId, c.tenantId),
            eq(feeStructures.academicYearId, year.id),
            eq(feeStructures.code, CHARGES_CODE),
            eq(feeStructures.status, "PUBLISHED"),
          ),
        )
        .for("update");
      let structure = have;
      let component = have ? await componentOf(tx, c.tenantId, have.id) : null;
      if (!structure || !component) {
        const categoryId = await ensureCategory(
          tx,
          ctx,
          "OTHER",
          "Other charges",
        );
        const made = await insertPublishedStructure(tx, ctx, {
          code: CHARGES_CODE,
          name: `Other charges ${year.name}`,
          yearId: year.id,
          yearStart: year.startDate,
          classId: null,
          categoryId,
          componentName: "Other charge",
          amount: "0.01",
          frequency: "ONE_TIME",
        });
        structure = made.structure;
        component = made.component;
      }
      let [a] = await tx
        .select()
        .from(studentFeeAssignments)
        .where(
          and(
            eq(studentFeeAssignments.tenantId, c.tenantId),
            eq(studentFeeAssignments.studentId, studentId),
            eq(studentFeeAssignments.feeStructureId, structure.id),
            eq(studentFeeAssignments.status, "ACTIVE"),
          ),
        )
        .for("update");
      if (!a)
        a = await insertAssignment(tx, ctx, structure, place.enrollment, null);
      const [n] = await tx
        .select({ n: sql<number>`count(*)` })
        .from(feeDemands)
        .where(
          and(
            eq(feeDemands.tenantId, c.tenantId),
            eq(feeDemands.studentFeeAssignmentId, a.id),
          ),
        );
      const due = input.due_date ?? ctx.today;
      const money = {
        original: toMinor(input.amount),
        discount: 0n,
        concession: 0n,
        waiver: 0n,
        late: 0n,
        paid: 0n,
        writtenOff: 0n,
      };
      const id = uuidv7();
      const number = await nextNumber(tx, c.tenantId, "FEE", ctx.now);
      await tx.insert(feeDemands).values({
        id,
        tenantId: c.tenantId,
        demandNumber: number,
        studentId,
        enrollmentId: a.enrollmentId,
        academicYearId: year.id,
        studentFeeAssignmentId: a.id,
        feeComponentId: component.id,
        feeCategoryId: component.feeCategoryId,
        periodKey: `X${String(Number(n?.n ?? 0) + 1).padStart(4, "0")}`,
        periodLabel: input.name,
        description: input.name,
        currency: structure.currency,
        originalAmount: input.amount,
        finalAmount: input.amount,
        dueDate: due,
        status: statusAfter(
          { status: "ISSUED", dueDate: due },
          money,
          ctx.today,
        ),
        issuedAt: ctx.now,
        issuedBy: c.actor.userId,
        createdBy: c.actor.userId,
      });
      await recordChange(tx, c.actor, c.tenantId, {
        action: "FEE_CHARGE_ADDED",
        entityType: "fee_demand",
        entityId: id,
        event: "fee_demand.issued",
        after: { name: input.name, amount: input.amount, due_date: due },
        payload: {
          fee_demand_id: id,
          student_id: studentId,
          demand_number: number,
          final_amount: input.amount,
          currency: structure.currency,
          due_date: due,
        },
      });
    });
    return this.account(c, studentId, year.id);
  }

  // ---- tracker ------------------------------------------------------------------------------------

  /** GET /fees/tracker — the year's position: totals, by class, and every learner with their status. */
  async tracker(c: Caller, q: z.infer<typeof TrackerQuery>) {
    await ensureSettings(this.db, c.tenantId);
    const year = await this.year(this.db, c.tenantId, q.academic_year_id);
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const now = this.deps.clock.now();
    await this.db.transaction((tx) =>
      lapseEarlyPaymentDiscounts(tx, {
        tenantId: c.tenantId,
        actor: c.actor,
        now,
        today,
      }),
    );
    const settings = await readSettings(this.db, c.tenantId);
    const e = enrollments;
    const d = feeDemands;
    const learners = await this.db
      .select({
        studentId: e.studentId,
        classId: e.classId,
        sectionId: e.sectionId,
        first: students.firstName,
        middle: students.middleName,
        last: students.lastName,
        number: students.studentNumber,
        admission: students.admissionNumber,
        className: academicClasses.name,
        classDisplay: academicClasses.displayName,
        classSeq: academicClasses.sequence,
        sectionName: academicSections.name,
      })
      .from(e)
      .innerJoin(
        students,
        and(eq(students.tenantId, e.tenantId), eq(students.id, e.studentId)),
      )
      .innerJoin(
        academicClasses,
        and(
          eq(academicClasses.tenantId, e.tenantId),
          eq(academicClasses.id, e.classId),
        ),
      )
      .leftJoin(
        academicSections,
        and(
          eq(academicSections.tenantId, e.tenantId),
          eq(academicSections.id, e.sectionId),
        ),
      )
      .where(
        and(
          eq(e.tenantId, c.tenantId),
          eq(e.academicYearId, year.id),
          inArray(e.status, OPEN),
          feeScope(c.principal, "fees.read", {
            tenantId: e.tenantId,
            studentId: e.studentId,
          }),
        ),
      );
    const ids = [...new Set(learners.map((l) => l.studentId))];
    const owed = sql`${d.status} in ('ISSUED','PARTIALLY_PAID','OVERDUE')`;
    const out = sql`(${d.finalAmount} - ${d.paidAmount} - ${d.writtenOffAmount})`;
    const pastDue = sql`${owed} and ${d.dueDate} < ${today} and ${out} > 0`;
    const isGrade = sql`${studentFeeAssignments.structureCode} like ${GRADE_LIKE}`;
    const money = ids.length
      ? await this.db
          .select({
            studentId: d.studentId,
            paid: sql<string>`coalesce(sum(${d.paidAmount}), 0)`,
            dueToDate: sql<string>`coalesce(sum(case when ${d.dueDate} <= ${today} then ${d.finalAmount} else 0 end), 0)`,
            owing: sql<string>`coalesce(sum(case when ${pastDue} then ${out} else 0 end), 0)`,
            untouchedOverdue: sql<number>`coalesce(sum(case when ${pastDue} and ${d.paidAmount} = 0 then 1 else 0 end), 0)`,
            instalments: sql<number>`coalesce(sum(case when ${isGrade} then 1 else 0 end), 0)`,
            instalment: sql<
              string | null
            >`max(case when ${isGrade} then ${d.finalAmount} end)`,
          })
          .from(d)
          .innerJoin(
            studentFeeAssignments,
            and(
              eq(studentFeeAssignments.tenantId, d.tenantId),
              eq(studentFeeAssignments.id, d.studentFeeAssignmentId),
            ),
          )
          .where(
            and(
              eq(d.tenantId, c.tenantId),
              eq(d.academicYearId, year.id),
              inArray(d.studentId, ids),
              sql`${d.status} not in ('DRAFT','CANCELLED')`,
            ),
          )
          .groupBy(d.studentId)
      : [];
    const plans = ids.length
      ? await this.db
          .select({
            studentId: studentFeeAssignments.studentId,
            plan: studentFeeAssignments.paymentPlan,
          })
          .from(studentFeeAssignments)
          .where(
            and(
              eq(studentFeeAssignments.tenantId, c.tenantId),
              eq(studentFeeAssignments.academicYearId, year.id),
              eq(studentFeeAssignments.status, "ACTIVE"),
              like(studentFeeAssignments.structureCode, GRADE_LIKE),
              inArray(studentFeeAssignments.studentId, ids),
            ),
          )
      : [];
    const mm = new Map(money.map((r) => [r.studentId, r]));
    const pm = new Map(plans.map((r) => [r.studentId, r.plan]));
    const rows = learners.map((l) => {
      const m = mm.get(l.studentId);
      const paid = toMinor(String(m?.paid ?? "0"));
      const due = toMinor(String(m?.dueToDate ?? "0"));
      const owing = toMinor(String(m?.owing ?? "0"));
      const status =
        owing <= 0n
          ? "UP_TO_DATE"
          : Number(m?.untouchedOverdue ?? 0) > 0
            ? "OVERDUE"
            : "PART_PAID";
      const className = l.classDisplay ?? l.className;
      return {
        student_id: l.studentId,
        full_name: [l.first, l.middle, l.last].filter(Boolean).join(" "),
        student_number: l.number,
        admission_number: l.admission,
        class_id: l.classId,
        section_id: l.sectionId,
        class_label: l.sectionName
          ? `${className} · ${l.sectionName}`
          : className,
        class_seq: l.classSeq,
        plan: pm.get(l.studentId) ?? null,
        instalments: Number(m?.instalments ?? 0),
        instalment_amount: m?.instalment ? String(m.instalment) : null,
        paid: fromMinor(paid),
        due_to_date: fromMinor(due),
        owing: fromMinor(owing),
        status,
        _paid: paid,
        _due: due,
        _owing: owing,
      };
    });
    const total = (rs: typeof rows, f: (r: (typeof rows)[number]) => bigint) =>
      rs.reduce((t, r) => t + f(r), 0n);
    const pct = (a: bigint, b: bigint) =>
      b > 0n ? Number((a * 1000n) / b) / 10 : 0;
    // By class (and section), always over the whole year's learners.
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = `${r.class_id}|${r.section_id ?? ""}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const byClass = [...groups.values()]
      .map((g) => ({
        class_id: g[0]!.class_id,
        section_id: g[0]!.section_id,
        label: g[0]!.class_label,
        seq: g[0]!.class_seq,
        learners: g.length,
        collected: fromMinor(total(g, (r) => r._paid)),
        due_to_date: fromMinor(total(g, (r) => r._due)),
        outstanding: fromMinor(total(g, (r) => r._owing)),
        collected_percent: pct(
          total(g, (r) => r._paid),
          total(g, (r) => r._due),
        ),
      }))
      .sort((a, b) => a.seq - b.seq || a.label.localeCompare(b.label))
      .map(({ seq: _seq, ...rest }) => rest);
    const planMix = { MONTHLY: 0, TERMLY: 0, ANNUAL: 0, NONE: 0 };
    for (const r of rows) planMix[r.plan ?? "NONE"]++;

    // The list: class / section / search filters, then status counts, then the status filter.
    const needle = q.search?.toLowerCase();
    const filtered = rows.filter(
      (r) =>
        (!q.class_id || r.class_id === q.class_id) &&
        (!q.section_id || r.section_id === q.section_id) &&
        (!needle ||
          r.full_name.toLowerCase().includes(needle) ||
          r.student_number.toLowerCase().includes(needle) ||
          (r.admission_number ?? "").toLowerCase().includes(needle)),
    );
    const counts = {
      ALL: filtered.length,
      OVERDUE: filtered.filter((r) => r.status === "OVERDUE").length,
      PART_PAID: filtered.filter((r) => r.status === "PART_PAID").length,
      UP_TO_DATE: filtered.filter((r) => r.status === "UP_TO_DATE").length,
    };
    const rank = { OVERDUE: 0, PART_PAID: 1, UP_TO_DATE: 2 } as const;
    const list = filtered
      .filter((r) => !q.status || r.status === q.status)
      .sort(
        (a, b) =>
          rank[a.status as keyof typeof rank] -
            rank[b.status as keyof typeof rank] ||
          (a._owing === b._owing ? 0 : a._owing > b._owing ? -1 : 1) ||
          a.full_name.localeCompare(b.full_name),
      );
    const start = (q.page - 1) * q.page_size;
    const scope = q.class_id || q.section_id ? filtered : rows;
    return {
      academic_year: { id: year.id, name: year.name },
      currency: settings.currency,
      today,
      totals: {
        learners: scope.length,
        due_to_date: fromMinor(total(scope, (r) => r._due)),
        collected: fromMinor(total(scope, (r) => r._paid)),
        collected_percent: pct(
          total(scope, (r) => r._paid),
          total(scope, (r) => r._due),
        ),
        outstanding: fromMinor(total(scope, (r) => r._owing)),
        learners_behind: scope.filter((r) => r._owing > 0n).length,
      },
      plan_mix: planMix,
      by_class: byClass,
      counts,
      learners: list
        .slice(start, start + q.page_size)
        .map(({ _paid, _due, _owing, class_seq: _s, ...r }) => r),
      meta: { page: q.page, page_size: q.page_size, total: list.length },
    };
  }

  /** Exports the tracker learners as CSV. */
  async trackerCsv(c: Caller, q: z.infer<typeof TrackerQuery>) {
    const t = await this.tracker(c, { ...q, page: 1, page_size: 100_000 });
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = [
      "Learner",
      "Student no.",
      "Admission no.",
      "Class",
      "Plan",
      "Instalments",
      "Instalment",
      "Paid",
      "Due to date",
      "Owing",
      "Status",
    ];
    const lines = t.learners.map((r) =>
      [
        r.full_name,
        r.student_number,
        r.admission_number,
        r.class_label,
        r.plan ? PLAN_LABELS[r.plan] : "",
        r.instalments,
        r.instalment_amount,
        r.paid,
        r.due_to_date,
        r.owing,
        r.status,
      ]
        .map(esc)
        .join(","),
    );
    return [head.join(","), ...lines].join("\n") + "\n";
  }
}
