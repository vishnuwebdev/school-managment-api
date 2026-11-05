/**
 * Grade fees and learner payment plans.
 *
 * Each grade (academic class) has ONE annual fee per academic year, stored as a PUBLISHED fee
 * structure with code `GF_<class code>` and a single ANNUAL component. Every learner enrolled in
 * the grade gets an assignment to it carrying their `payment_plan` (MONTHLY / TERMLY / ANNUAL); the
 * plan decides how the annual fee is split into instalment demands. Annual payers get the school's
 * early-payment discount on the single instalment while its due date has not passed.
 *
 * One-off extras (trip, uniform …) are demands on a per-year `CHARGES` structure.
 *
 * All helpers here run inside the caller's transaction.
 */
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Executor } from "../../db/client.js";
import {
  feeCategories,
  feeComponents,
  feeDemands,
  feeStructures,
  studentFeeAssignments,
  type PaymentPlan,
} from "../../db/schema/index.js";
import { recordChange } from "../../platform/record.js";
import { applyBp, fromMinor, percentToBp, toMinor } from "./money.js";
import { planPeriods, splitEven, type PlanPeriod } from "./schedule.js";
import {
  lockDemands,
  moneyOf,
  nextNumber,
  statusAfter,
  writeDemand,
  type Actor,
  type AssignmentRow,
  type ComponentRow,
  type DemandRow,
  type SettingsRow,
  type StructureRow,
} from "./support.js";

export const GRADE_PREFIX = "GF_";
/** LIKE pattern for grade-fee structure codes (the _ escaped). */
export const GRADE_LIKE = "GF\\_%";
export const CHARGES_CODE = "CHARGES";

export const isGradeCode = (code: string) => code.startsWith(GRADE_PREFIX);

/** Structure code of a grade fee: GF_ + the class code (upper-case, A–Z 0–9 _ only, max 32). */
export const gradeCode = (classCode: string) =>
  (GRADE_PREFIX + classCode.toUpperCase().replace(/[^A-Z0-9_]/g, "_")).slice(
    0,
    32,
  );

export interface Ctx {
  tenantId: string;
  actor: Actor;
  now: Date;
  today: string;
  settings: SettingsRow;
}

export interface Year {
  id: string;
  startDate: string;
  endDate: string;
}

const rulesOf = (s: SettingsRow) => ({
  monthlyInstalments: s.monthlyInstalments,
  monthlyDueDay: s.monthlyDueDay,
  termDueDates: s.termDueDates ?? null,
  annualPayBy: s.annualPayBy,
});

/** The instalment slots of a plan for the year. */
export const periodsOf = (
  plan: PaymentPlan,
  s: SettingsRow,
  year: Year,
): PlanPeriod[] => planPeriods(plan, rulesOf(s), year);

/** Instalments that would be created for `remaining` on `plan`, from `from` on (no writes). */
export function splitPlan(
  plan: PaymentPlan,
  s: SettingsRow,
  year: Year,
  remaining: bigint,
  from: string,
  today: string,
): { period: PlanPeriod; amount: bigint; discount: bigint }[] {
  if (remaining <= 0n) return [];
  let periods = periodsOf(plan, s, year).filter((p) => p.dueDate >= from);
  if (!periods.length)
    periods = [{ code: "B", label: "Balance", dueDate: from }];
  const amounts = splitEven(remaining, periods.length);
  const bp = percentToBp(s.annualDiscountPercent);
  return periods.map((period, i) => ({
    period,
    amount: amounts[i]!,
    discount:
      plan === "ANNUAL" && period.code === "A" && period.dueDate >= today
        ? applyBp(amounts[i]!, bp)
        : 0n,
  }));
}

/**
 * Where a learner's first schedule starts: the year start. A learner billed mid-year therefore owes
 * the instalments already due (the school can re-split them by changing the plan).
 */
export const scheduleStart = (year: Year, _enrolmentStart?: string | null) =>
  year.startDate;

/** Finds or creates an active category by code (used for TUITION and OTHER). */
export async function ensureCategory(
  tx: Executor,
  ctx: Pick<Ctx, "tenantId" | "actor">,
  code: string,
  name: string,
): Promise<string> {
  const [have] = await tx
    .select()
    .from(feeCategories)
    .where(
      and(
        eq(feeCategories.tenantId, ctx.tenantId),
        eq(feeCategories.code, code),
      ),
    );
  if (have) {
    if (have.status !== "ACTIVE")
      await tx
        .update(feeCategories)
        .set({ status: "ACTIVE", version: have.version + 1 })
        .where(eq(feeCategories.id, have.id));
    return have.id;
  }
  const id = uuidv7();
  await tx.insert(feeCategories).values({
    id,
    tenantId: ctx.tenantId,
    code,
    name,
    createdBy: ctx.actor.userId,
  });
  return id;
}

/** Inserts a PUBLISHED one-component structure (grade fee or the year's charges holder). */
export async function insertPublishedStructure(
  tx: Executor,
  ctx: Pick<Ctx, "tenantId" | "actor" | "now" | "settings">,
  o: {
    code: string;
    name: string;
    yearId: string;
    yearStart: string;
    classId: string | null;
    categoryId: string;
    componentName: string;
    amount: string;
    frequency: "ANNUAL" | "ONE_TIME";
    supersedes?: StructureRow;
  },
): Promise<{ structure: StructureRow; component: ComponentRow }> {
  const [mx] = await tx
    .select({ v: sql<number>`coalesce(max(${feeStructures.versionNo}), 0)` })
    .from(feeStructures)
    .where(
      and(
        eq(feeStructures.tenantId, ctx.tenantId),
        eq(feeStructures.code, o.code),
      ),
    );
  const id = uuidv7();
  if (o.supersedes)
    await tx
      .update(feeStructures)
      .set({
        status: "ARCHIVED",
        archivedAt: ctx.now,
        archivedBy: ctx.actor.userId,
        version: o.supersedes.version + 1,
      })
      .where(eq(feeStructures.id, o.supersedes.id));
  await tx.insert(feeStructures).values({
    id,
    tenantId: ctx.tenantId,
    code: o.code,
    name: o.name,
    versionNo: Number(mx?.v ?? 0) + 1,
    academicYearId: o.yearId,
    academicClassId: o.classId,
    currency: ctx.settings.currency,
    status: "PUBLISHED",
    copiedFromId: o.supersedes?.id ?? null,
    publishedAt: ctx.now,
    publishedBy: ctx.actor.userId,
    createdBy: ctx.actor.userId,
  });
  if (o.supersedes)
    await tx
      .update(feeStructures)
      .set({ supersededById: id })
      .where(eq(feeStructures.id, o.supersedes.id));
  const componentId = uuidv7();
  await tx.insert(feeComponents).values({
    id: componentId,
    tenantId: ctx.tenantId,
    feeStructureId: id,
    feeCategoryId: o.categoryId,
    name: o.componentName,
    amount: o.amount,
    frequency: o.frequency,
    dueRule: { type: "FIXED_DATE", date: o.yearStart },
    createdBy: ctx.actor.userId,
  });
  const [structure] = await tx
    .select()
    .from(feeStructures)
    .where(eq(feeStructures.id, id));
  const [component] = await tx
    .select()
    .from(feeComponents)
    .where(eq(feeComponents.id, componentId));
  return { structure: structure!, component: component! };
}

/** The (only) component of a one-component structure. */
export async function componentOf(
  tx: Executor,
  tenantId: string,
  structureId: string,
) {
  const [c] = await tx
    .select()
    .from(feeComponents)
    .where(
      and(
        eq(feeComponents.tenantId, tenantId),
        eq(feeComponents.feeStructureId, structureId),
      ),
    )
    .orderBy(asc(feeComponents.displayOrder))
    .limit(1);
  return c ?? null;
}

/** Creates a learner's active assignment to a structure (no demands). */
export async function insertAssignment(
  tx: Executor,
  ctx: Pick<Ctx, "tenantId" | "actor" | "now">,
  s: StructureRow,
  enrollment: { id: string; studentId: string },
  plan: PaymentPlan | null,
): Promise<AssignmentRow> {
  const id = uuidv7();
  await tx.insert(studentFeeAssignments).values({
    id,
    tenantId: ctx.tenantId,
    studentId: enrollment.studentId,
    enrollmentId: enrollment.id,
    academicYearId: s.academicYearId,
    feeStructureId: s.id,
    structureCode: s.code,
    paymentPlan: plan,
    assignedAt: ctx.now,
    assignedBy: ctx.actor.userId,
  });
  const [a] = await tx
    .select()
    .from(studentFeeAssignments)
    .where(eq(studentFeeAssignments.id, id));
  return a!;
}

/** Every grade-fee demand of a student in a year, over all their grade assignments. */
export async function gradeDemandsOf(
  ex: Executor,
  tenantId: string,
  studentId: string,
  yearId: string,
): Promise<DemandRow[]> {
  const rows = await ex
    .select({ d: feeDemands })
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
        eq(feeDemands.tenantId, tenantId),
        eq(feeDemands.studentId, studentId),
        eq(feeDemands.academicYearId, yearId),
        like(studentFeeAssignments.structureCode, GRADE_LIKE),
      ),
    )
    .orderBy(asc(feeDemands.dueDate), asc(feeDemands.demandNumber));
  return rows.map((r) => r.d);
}

/** Has money (or a concession) touched this demand? Untouched open ones can be re-split freely. */
const untouched = (d: DemandRow) => {
  const m = moneyOf(d);
  return (
    m.paid === 0n &&
    m.writtenOff === 0n &&
    m.concession === 0n &&
    m.waiver === 0n
  );
};
const OPEN = new Set(["DRAFT", "ISSUED", "PARTIALLY_PAID", "OVERDUE"]);

/**
 * (Re)builds a learner's grade-fee instalments on `a`. Open instalments nothing was paid on are
 * cancelled; instalments with money on them are kept. What is left of the annual fee is split over
 * the plan's instalments due on or after `from` (or one "Balance" instalment due on `from`).
 * Grade assignments of the learner other than `a` (an earlier class this year) are closed.
 */
export async function rebuildGradeSchedule(
  tx: Executor,
  ctx: Ctx,
  o: {
    assignment: AssignmentRow;
    structure: StructureRow;
    component: ComponentRow;
    plan: PaymentPlan;
    year: Year;
    from: string;
    reason: string;
  },
): Promise<{ cancelled: number; created: DemandRow[] }> {
  const { assignment: a, structure, component } = o;
  const all = await gradeDemandsOf(tx, ctx.tenantId, a.studentId, o.year.id);
  const locked = await lockDemands(
    tx,
    ctx.tenantId,
    all.filter((d) => d.status !== "CANCELLED").map((d) => d.id),
  );
  let keptOriginal = 0n;
  let cancelled = 0;
  for (const id of [...locked.keys()].sort()) {
    const d = locked.get(id)!;
    if (OPEN.has(d.status) && untouched(d)) {
      await writeDemand(
        tx,
        d,
        {},
        {
          today: ctx.today,
          now: ctx.now,
          status: "CANCELLED",
          extra: {
            cancelledAt: ctx.now,
            cancelledBy: ctx.actor.userId,
            cancelReason: o.reason,
          },
        },
      );
      cancelled++;
    } else keptOriginal += moneyOf(d).original;
  }
  // A learner moved to another grade this year: the earlier grade's assignment is closed.
  await tx
    .update(studentFeeAssignments)
    .set({
      status: "CANCELLED",
      cancelledAt: ctx.now,
      cancelledBy: ctx.actor.userId,
      cancelReason: "Moved to another grade",
    })
    .where(
      and(
        eq(studentFeeAssignments.tenantId, ctx.tenantId),
        eq(studentFeeAssignments.studentId, a.studentId),
        eq(studentFeeAssignments.academicYearId, o.year.id),
        eq(studentFeeAssignments.status, "ACTIVE"),
        like(studentFeeAssignments.structureCode, GRADE_LIKE),
        sql`${studentFeeAssignments.id} <> ${a.id}`,
      ),
    );

  const remaining = toMinor(component.amount) - keptOriginal;
  const parts = splitPlan(
    o.plan,
    ctx.settings,
    o.year,
    remaining,
    o.from,
    ctx.today,
  );
  const created: DemandRow[] = [];
  if (parts.length) {
    const used = new Set(
      all
        .filter((d) => d.feeComponentId === component.id)
        .map((d) => d.periodKey),
    );
    const rows = [];
    for (const { period, amount, discount } of parts) {
      let key = period.code;
      for (let n = 2; used.has(key); n++) key = `${period.code}.${n}`;
      used.add(key);
      const money = {
        original: amount,
        discount,
        concession: 0n,
        waiver: 0n,
        late: 0n,
        paid: 0n,
        writtenOff: 0n,
      };
      rows.push({
        id: uuidv7(),
        tenantId: ctx.tenantId,
        demandNumber: await nextNumber(tx, ctx.tenantId, "FEE", ctx.now),
        studentId: a.studentId,
        enrollmentId: a.enrollmentId,
        academicYearId: a.academicYearId,
        studentFeeAssignmentId: a.id,
        feeComponentId: component.id,
        feeCategoryId: component.feeCategoryId,
        periodKey: key,
        periodLabel: period.label,
        description: component.name,
        currency: structure.currency,
        originalAmount: fromMinor(amount),
        discountAmount: fromMinor(discount),
        finalAmount: fromMinor(amount - discount),
        dueDate: period.dueDate,
        status: statusAfter(
          { status: "ISSUED", dueDate: period.dueDate },
          money,
          ctx.today,
        ),
        issuedAt: ctx.now,
        issuedBy: ctx.actor.userId,
        createdBy: ctx.actor.userId,
      });
    }
    await tx.insert(feeDemands).values(rows);
    created.push(
      ...(await tx
        .select()
        .from(feeDemands)
        .where(
          and(
            eq(feeDemands.tenantId, ctx.tenantId),
            inArray(
              feeDemands.id,
              rows.map((r) => r.id),
            ),
          ),
        )
        .orderBy(asc(feeDemands.dueDate))),
    );
  }
  await recordChange(tx, ctx.actor, ctx.tenantId, {
    action: "FEE_SCHEDULE_BUILT",
    entityType: "student_fee_assignment",
    entityId: a.id,
    event: "fee_demand.generated",
    after: {
      plan: o.plan,
      annual_fee: component.amount,
      from: o.from,
      cancelled,
      created: created.length,
    },
    reason: o.reason,
    payload: {
      student_id: a.studentId,
      demand_ids: created.map((d) => d.id),
      count: created.length,
      issued: true,
    },
  });
  return { cancelled, created };
}

/**
 * The annual plan's discount only holds if the learner pays in full by the due date. Removes it
 * from annual instalments that are past due and not settled. Idempotent; returns how many changed.
 */
export async function lapseEarlyPaymentDiscounts(
  tx: Executor,
  ctx: Pick<Ctx, "tenantId" | "actor" | "now" | "today">,
  studentId?: string,
): Promise<number> {
  const due = await tx
    .select({ id: feeDemands.id })
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
        eq(feeDemands.tenantId, ctx.tenantId),
        studentId ? eq(feeDemands.studentId, studentId) : undefined,
        like(studentFeeAssignments.structureCode, GRADE_LIKE),
        like(feeDemands.periodKey, "A%"),
        inArray(feeDemands.status, ["ISSUED", "PARTIALLY_PAID", "OVERDUE"]),
        sql`${feeDemands.discountAmount} > 0`,
        sql`${feeDemands.dueDate} < ${ctx.today}`,
        sql`(${feeDemands.finalAmount} - ${feeDemands.paidAmount} - ${feeDemands.writtenOffAmount}) > 0`,
      ),
    )
    .limit(500);
  if (!due.length) return 0;
  const locked = await lockDemands(
    tx,
    ctx.tenantId,
    due.map((r) => r.id),
  );
  let n = 0;
  for (const id of [...locked.keys()].sort()) {
    const d = locked.get(id)!;
    const m = moneyOf(d);
    if (m.discount === 0n || d.dueDate >= ctx.today || !OPEN.has(d.status))
      continue;
    await writeDemand(
      tx,
      d,
      { discount: 0n },
      { today: ctx.today, now: ctx.now },
    );
    await recordChange(tx, ctx.actor, ctx.tenantId, {
      action: "FEE_EARLY_DISCOUNT_LAPSED",
      entityType: "fee_demand",
      entityId: d.id,
      before: { discount_amount: d.discountAmount },
      after: { discount_amount: "0.00" },
      reason: "Not paid in full by the annual due date",
    });
    n++;
  }
  return n;
}

/** Automatic billing on enrolment: the learner gets the grade fee on the school's default plan. */
export async function applyGradeFeeOnEnrolment(
  tx: Executor,
  ctx: Ctx,
  enrollment: { id: string; studentId: string; startDate: string },
  structure: StructureRow,
  year: Year,
): Promise<boolean> {
  const component = await componentOf(tx, ctx.tenantId, structure.id);
  if (!component) return false;
  const a = await insertAssignment(
    tx,
    ctx,
    structure,
    enrollment,
    ctx.settings.defaultPaymentPlan,
  );
  await rebuildGradeSchedule(tx, ctx, {
    assignment: a,
    structure,
    component,
    plan: a.paymentPlan!,
    year,
    from: scheduleStart(year, enrollment.startDate),
    reason: "Enrolled",
  });
  return true;
}
