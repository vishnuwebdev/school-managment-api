import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import type { Executor } from '../../db/client.js';
import {
  enrollments,
  feeAdjustments,
  feeCategories,
  feeComponents,
  feeDemands,
  feeReceipts,
  feeRefunds,
  feeSettings,
  feeStructures,
  OPEN_ENROLLMENT_STATUSES,
  paymentAllocations,
  schoolPayments,
  studentFeeAssignments,
  students,
  tenantSettings,
  type FeeDemandStatus,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import {
  AuthorizationError,
  BusinessRuleError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import { hasTenantWideScope, scopesFor } from '../access/authorization.service.js';
import { fromMinor, toMinor } from './money.js';

export type { Caller } from '../attendance/support.js';
export { rows, schoolToday } from '../attendance/support.js';
export { nextNumber } from '../students/support.js';

export type CategoryRow = typeof feeCategories.$inferSelect;
export type SettingsRow = typeof feeSettings.$inferSelect;
export type StructureRow = typeof feeStructures.$inferSelect;
export type ComponentRow = typeof feeComponents.$inferSelect;
export type AssignmentRow = typeof studentFeeAssignments.$inferSelect;
export type DemandRow = typeof feeDemands.$inferSelect;
export type PaymentRow = typeof schoolPayments.$inferSelect;
export type AllocationRow = typeof paymentAllocations.$inferSelect;
export type ReceiptRow = typeof feeReceipts.$inferSelect;
export type AdjustmentRow = typeof feeAdjustments.$inferSelect;
export type RefundRow = typeof feeRefunds.$inferSelect;

const OPEN = [...OPEN_ENROLLMENT_STATUSES];

export function validationIssue(path: string, message: string, code = 'custom'): ValidationError {
  return new ValidationError('The request is invalid', {
    location: 'body',
    issues: [{ path, code, message }],
  });
}

/** 409-style guard shared by every optimistic-concurrency command. */
export const staleVersion = (have: number, sent: number | undefined) =>
  sent !== undefined && have !== sent;

export const isDeadlock = (err: unknown) => {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    if (typeof cur === 'object' && cur !== null && 'code' in cur) {
      const c = (cur as { code: unknown }).code;
      if (c === 'ER_LOCK_DEADLOCK' || c === 'ER_LOCK_WAIT_TIMEOUT') return true;
    }
    cur = typeof cur === 'object' && cur !== null ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
};

/** Runs a whole transaction again when MySQL picks it as a deadlock victim (safe: nothing committed). */
export async function withDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < 3 && isDeadlock(err)) continue;
      throw err;
    }
  }
}

// ---- time ---------------------------------------------------------------------------------

export async function schoolTimezone(ex: Executor, tenantId: string): Promise<string> {
  const [s] = await ex
    .select({ tz: tenantSettings.timezone })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenantId));
  return s?.tz ?? 'UTC';
}

/** Calendar date of an instant in a time zone (falls back to UTC). */
export function dateInZone(tz: string, d: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

const DAY_MS = 86_400_000;
export const daysBetween = (from: string, to: string) =>
  Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
export const addDaysIso = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

// ---- settings ---------------------------------------------------------------------------------

const ready = new Set<string>();

/**
 * Idempotent, concurrency-safe creation of the school's fee settings row (currency defaults to the
 * school currency). Runs on fee paths BEFORE the caller opens its transaction.
 */
export async function ensureSettings(db: Executor, tenantId: string): Promise<void> {
  if (ready.has(tenantId)) return;
  for (let attempt = 0; ; attempt++) {
    try {
      const [ts] = await db
        .select({ currency: tenantSettings.currency })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tenantId));
      await db
        .insert(feeSettings)
        .values({ tenantId, currency: ts?.currency ?? 'INR' })
        .onDuplicateKeyUpdate({ set: { tenantId: sql`${feeSettings.tenantId}` } });
      ready.add(tenantId);
      return;
    } catch (err) {
      if (attempt < 3 && isDeadlock(err)) continue;
      throw err;
    }
  }
}

export async function readSettings(
  ex: Executor,
  tenantId: string,
  lock: 'share' | 'update' | false = false,
): Promise<SettingsRow> {
  const q = ex.select().from(feeSettings).where(eq(feeSettings.tenantId, tenantId));
  const [row] = await (lock ? q.for(lock) : q);
  if (!row) throw new Error('Fee settings missing: ensureSettings must run first');
  return row;
}

export const settingsPresent = (s: SettingsRow) => ({
  currency: s.currency,
  late_fee_enabled: s.lateFeeEnabled,
  late_fee_type: s.lateFeeType,
  late_fee_value: s.lateFeeValue,
  late_fee_grace_days: s.lateFeeGraceDays,
  late_fee_cap: s.lateFeeCap,
  version: s.version,
  updated_at: s.updatedAt.toISOString(),
});

// ---- scope -----------------------------------------------------------------------------------------

type Col = AnyMySqlColumn;

/**
 * Row-level student scope for a fee permission, expressed on the `student_id` column of a fee table:
 * a user limited to ASSIGNED_SECTION / ASSIGNED_CLASS only sees fee records of students with an open
 * enrollment there. Tenant-wide grants return `undefined`; a grant we cannot resolve denies. Derived
 * from the signed-in principal — never client input. Records outside the scope behave as missing (404).
 */
export function feeScope(
  principal: Principal,
  permission: string,
  cols: { tenantId: Col; studentId: Col },
): SQL | undefined {
  if (hasTenantWideScope(principal, permission)) return undefined;
  const grants = scopesFor(principal, permission);
  const sectionIds = grants.flatMap((g) =>
    g.type === 'ASSIGNED_SECTION' ? (g.ref?.section_ids ?? []) : [],
  );
  const classIds = grants.flatMap((g) =>
    g.type === 'ASSIGNED_CLASS' ? (g.ref?.class_ids ?? []) : [],
  );
  const placement: SQL[] = [];
  if (sectionIds.length) placement.push(inArray(enrollments.sectionId, sectionIds));
  if (classIds.length) placement.push(inArray(enrollments.classId, classIds));
  if (placement.length === 0) return sql`1 = 0`;
  return sql`exists (select 1 from ${enrollments} where ${enrollments.tenantId} = ${cols.tenantId} and ${enrollments.studentId} = ${cols.studentId} and ${inArray(enrollments.status, OPEN)} and (${sql.join(placement, sql` or `)}))`;
}

/** Whole-school operations (settings, structure lifecycle, bulk jobs) need a tenant-wide grant. */
export function requireWide(principal: Principal, permission: string) {
  if (!hasTenantWideScope(principal, permission))
    throw new AuthorizationError(
      'PERMISSION_DENIED',
      'This operation needs school-wide access to fees',
      { permission },
    );
}

export const separationOfDuties = (what: string) =>
  new AuthorizationError(
    'PERMISSION_DENIED',
    `${what} must be done by someone other than the person who requested it`,
    { reason: 'SEPARATION_OF_DUTIES' },
  );

// ---- demand arithmetic --------------------------------------------------------------------------------

export interface DemandMoney {
  original: bigint;
  discount: bigint;
  concession: bigint;
  waiver: bigint;
  late: bigint;
  paid: bigint;
  writtenOff: bigint;
}

export const moneyOf = (d: DemandRow): DemandMoney => ({
  original: toMinor(d.originalAmount),
  discount: toMinor(d.discountAmount),
  concession: toMinor(d.concessionAmount),
  waiver: toMinor(d.waiverAmount),
  late: toMinor(d.lateFeeAmount),
  paid: toMinor(d.paidAmount),
  writtenOff: toMinor(d.writtenOffAmount),
});

export const finalOf = (m: DemandMoney) =>
  m.original - m.discount - m.concession - m.waiver + m.late;
export const outstandingOfMoney = (m: DemandMoney) => finalOf(m) - m.paid - m.writtenOff;
/** original − discount − concession − waiver: what the late fee is measured against. */
export const netBeforeLate = (m: DemandMoney) => m.original - m.discount - m.concession - m.waiver;

/**
 * The status a demand has, given its balance and due date. DRAFT and CANCELLED never change here.
 * outstanding > 0: OVERDUE when past due, else PARTIALLY_PAID (something collected) or ISSUED.
 * outstanding = 0: WRITTEN_OFF (school forgave the rest), PAID (money received) or WAIVED (forgiven
 * by adjustments, nothing collected).
 */
export function statusAfter(
  d: { status: FeeDemandStatus; dueDate: string },
  m: DemandMoney,
  today: string,
): FeeDemandStatus {
  if (d.status === 'DRAFT' || d.status === 'CANCELLED') return d.status;
  const out = outstandingOfMoney(m);
  if (out <= 0n) {
    if (m.writtenOff > 0n) return 'WRITTEN_OFF';
    return m.paid > 0n ? 'PAID' : 'WAIVED';
  }
  if (d.dueDate < today) return 'OVERDUE';
  return m.paid > 0n ? 'PARTIALLY_PAID' : 'ISSUED';
}

const AMOUNT_COLUMNS = {
  original: 'originalAmount',
  discount: 'discountAmount',
  concession: 'concessionAmount',
  waiver: 'waiverAmount',
  late: 'lateFeeAmount',
  paid: 'paidAmount',
  writtenOff: 'writtenOffAmount',
} as const;

/**
 * The only writer of a demand's balance columns: applies the new amounts, recomputes `final_amount`
 * and the status, stamps `settled_at`, bumps `version`. The caller holds the demand's row lock.
 */
export async function writeDemand(
  tx: Executor,
  before: DemandRow,
  next: Partial<DemandMoney>,
  o: {
    today: string;
    now: Date;
    extra?: Partial<typeof feeDemands.$inferInsert>;
    status?: FeeDemandStatus;
  },
): Promise<{ row: DemandRow; from: FeeDemandStatus; to: FeeDemandStatus }> {
  const m = { ...moneyOf(before), ...next };
  const set: Partial<typeof feeDemands.$inferInsert> = { ...o.extra };
  for (const [k, col] of Object.entries(AMOUNT_COLUMNS) as [keyof DemandMoney, string][])
    (set as Record<string, string>)[col] = fromMinor(m[k]);
  set.finalAmount = fromMinor(finalOf(m));
  const to =
    o.status ?? statusAfter({ status: before.status, dueDate: before.dueDate }, m, o.today);
  set.status = to;
  const settled = outstandingOfMoney(m) <= 0n && to !== 'DRAFT' && to !== 'CANCELLED';
  set.settledAt = settled ? (before.settledAt ?? o.now) : null;
  set.version = before.version + 1;
  await tx
    .update(feeDemands)
    .set(set)
    .where(and(eq(feeDemands.id, before.id), eq(feeDemands.tenantId, before.tenantId)));
  const [row] = await tx
    .select()
    .from(feeDemands)
    .where(and(eq(feeDemands.id, before.id), eq(feeDemands.tenantId, before.tenantId)));
  return { row: row!, from: before.status, to };
}

/** SQL expression for the status a demand has TODAY (stored ISSUED / PARTIALLY_PAID past due = OVERDUE). */
export const effectiveStatusSql = (today: string) =>
  sql<FeeDemandStatus>`(case when ${feeDemands.status} in ('ISSUED','PARTIALLY_PAID') and ${feeDemands.dueDate} < ${today} then 'OVERDUE' else ${feeDemands.status} end)`;

/** Outstanding of an issued demand, in SQL (DECIMAL arithmetic is exact in MySQL). */
export const outstandingSql = sql`(${feeDemands.finalAmount} - ${feeDemands.paidAmount} - ${feeDemands.writtenOffAmount})`;

/** Demands that are owed: issued and not yet settled or closed (before the overdue overlay). */
export const OWED_STATUSES = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] as const;
export const inOwed = sql`${feeDemands.status} in ('ISSUED','PARTIALLY_PAID','OVERDUE')`;

// ---- loaders --------------------------------------------------------------------------------------------

/** A demand the principal may access for `permission`, or 404. */
export async function loadDemand(
  ex: Executor,
  tenantId: string,
  id: string,
  principal: Principal,
  permission: string,
  lock?: 'update' | 'share',
): Promise<DemandRow> {
  const q = ex
    .select()
    .from(feeDemands)
    .where(
      and(
        eq(feeDemands.id, id),
        eq(feeDemands.tenantId, tenantId),
        feeScope(principal, permission, feeDemands),
      ),
    );
  const [row] = await (lock ? q.for(lock) : q);
  if (!row) throw new NotFoundError('Fee demand');
  return row;
}

export async function loadPayment(
  ex: Executor,
  tenantId: string,
  id: string,
  principal: Principal,
  permission: string,
  lock?: 'update' | 'share',
): Promise<PaymentRow> {
  const q = ex
    .select()
    .from(schoolPayments)
    .where(
      and(
        eq(schoolPayments.id, id),
        eq(schoolPayments.tenantId, tenantId),
        feeScope(principal, permission, schoolPayments),
      ),
    );
  const [row] = await (lock ? q.for(lock) : q);
  if (!row) throw new NotFoundError('Payment');
  return row;
}

export async function loadAssignment(
  ex: Executor,
  tenantId: string,
  id: string,
  principal: Principal,
  permission: string,
  lock?: 'update' | 'share',
): Promise<AssignmentRow> {
  const q = ex
    .select()
    .from(studentFeeAssignments)
    .where(
      and(
        eq(studentFeeAssignments.id, id),
        eq(studentFeeAssignments.tenantId, tenantId),
        feeScope(principal, permission, studentFeeAssignments),
      ),
    );
  const [row] = await (lock ? q.for(lock) : q);
  if (!row) throw new NotFoundError('Fee assignment');
  return row;
}

export async function loadStructure(
  ex: Executor,
  tenantId: string,
  id: string,
  lock?: 'update' | 'share',
): Promise<StructureRow> {
  const q = ex
    .select()
    .from(feeStructures)
    .where(and(eq(feeStructures.id, id), eq(feeStructures.tenantId, tenantId)));
  const [row] = await (lock ? q.for(lock) : q);
  if (!row) throw new NotFoundError('Fee structure');
  return row;
}

export async function loadCategory(
  ex: Executor,
  tenantId: string,
  id: string,
  lock?: 'update' | 'share',
): Promise<CategoryRow> {
  const q = ex
    .select()
    .from(feeCategories)
    .where(and(eq(feeCategories.id, id), eq(feeCategories.tenantId, tenantId)));
  const [row] = await (lock ? q.for(lock) : q);
  if (!row) throw new NotFoundError('Fee category');
  return row;
}

/** Locks the given demands in id order (the global lock order), returning them keyed by id. */
export async function lockDemands(
  tx: Executor,
  tenantId: string,
  ids: string[],
): Promise<Map<string, DemandRow>> {
  const out = new Map<string, DemandRow>();
  if (!ids.length) return out;
  const found = await tx
    .select()
    .from(feeDemands)
    .where(and(eq(feeDemands.tenantId, tenantId), inArray(feeDemands.id, ids)))
    .orderBy(feeDemands.id)
    .for('update');
  for (const r of found) out.set(r.id, r);
  return out;
}

export const businessRule = (
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
  code: 'INVALID_STATE' | 'OPERATION_NOT_ALLOWED' = 'INVALID_STATE',
) => new BusinessRuleError(code, message, { reason, ...extra });

// ---- presenters --------------------------------------------------------------------------------------------

export const iso = (d: Date | null) => d?.toISOString() ?? null;

export const presentCategory = (c: CategoryRow) => ({
  id: c.id,
  code: c.code,
  name: c.name,
  description: c.description,
  status: c.status,
  version: c.version,
  created_at: c.createdAt.toISOString(),
  updated_at: c.updatedAt.toISOString(),
});

export const presentComponent = (c: ComponentRow, category?: { code: string; name: string }) => ({
  id: c.id,
  fee_structure_id: c.feeStructureId,
  fee_category_id: c.feeCategoryId,
  category: category
    ? { id: c.feeCategoryId, code: category.code, name: category.name }
    : undefined,
  name: c.name,
  amount: c.amount,
  frequency: c.frequency,
  due_rule: c.dueRule,
  display_order: c.displayOrder,
  version: c.version,
  created_at: c.createdAt.toISOString(),
  updated_at: c.updatedAt.toISOString(),
});

export const presentStructure = (
  s: StructureRow,
  extra: {
    year?: { id: string; code: string; name: string };
    klass?: { id: string; code: string; name: string } | null;
    componentCount?: number;
    totalAmount?: string;
    assignmentCount?: number;
  } = {},
) => ({
  id: s.id,
  code: s.code,
  name: s.name,
  description: s.description,
  version_no: s.versionNo,
  academic_year: extra.year ?? { id: s.academicYearId },
  academic_class: s.academicClassId ? (extra.klass ?? { id: s.academicClassId }) : null,
  academic_section_id: s.academicSectionId,
  currency: s.currency,
  status: s.status,
  effective_from: s.effectiveFrom,
  effective_to: s.effectiveTo,
  copied_from_id: s.copiedFromId,
  superseded_by_id: s.supersededById,
  published_at: iso(s.publishedAt),
  archived_at: iso(s.archivedAt),
  component_count: extra.componentCount,
  total_amount: extra.totalAmount,
  assignment_count: extra.assignmentCount,
  version: s.version,
  created_at: s.createdAt.toISOString(),
  updated_at: s.updatedAt.toISOString(),
});

export interface StudentMini {
  id: string;
  student_number: string;
  full_name: string;
}
export const studentMini = (s: {
  id: string;
  studentNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
}): StudentMini => ({
  id: s.id,
  student_number: s.studentNumber,
  full_name: [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' '),
});

/** Loads student summaries for a set of ids (tenant filtered). */
export async function studentMinis(
  ex: Executor,
  tenantId: string,
  ids: string[],
): Promise<Map<string, StudentMini>> {
  const out = new Map<string, StudentMini>();
  const unique = [...new Set(ids)];
  if (!unique.length) return out;
  const found = await ex
    .select()
    .from(students)
    .where(and(eq(students.tenantId, tenantId), inArray(students.id, unique)));
  for (const s of found) out.set(s.id, studentMini(s));
  return out;
}

export const presentAssignment = (
  a: AssignmentRow,
  extra: {
    student?: StudentMini;
    structure?: { id: string; code: string; name: string; version_no: number; status: string };
    demandCount?: number;
  } = {},
) => ({
  id: a.id,
  student: extra.student ?? { id: a.studentId },
  enrollment_id: a.enrollmentId,
  academic_year_id: a.academicYearId,
  fee_structure: extra.structure ?? { id: a.feeStructureId },
  structure_code: a.structureCode,
  status: a.status,
  discount_percent: a.discountPercent,
  discount_reason: a.discountReason,
  notes: a.notes,
  assigned_at: a.assignedAt.toISOString(),
  cancelled_at: iso(a.cancelledAt),
  cancel_reason: a.cancelReason,
  demand_count: extra.demandCount,
  version: a.version,
  created_at: a.createdAt.toISOString(),
  updated_at: a.updatedAt.toISOString(),
});

export function presentDemand(
  d: DemandRow,
  today: string,
  extra: { student?: StudentMini; category?: { id: string; code: string; name: string } } = {},
) {
  const m = moneyOf(d);
  const out = d.status === 'CANCELLED' ? 0n : outstandingOfMoney(m);
  const overdue =
    (d.status === 'ISSUED' || d.status === 'PARTIALLY_PAID' || d.status === 'OVERDUE') &&
    out > 0n &&
    d.dueDate < today;
  return {
    id: d.id,
    demand_number: d.demandNumber,
    student: extra.student ?? { id: d.studentId },
    enrollment_id: d.enrollmentId,
    academic_year_id: d.academicYearId,
    assignment_id: d.studentFeeAssignmentId,
    fee_component_id: d.feeComponentId,
    category: extra.category ?? { id: d.feeCategoryId },
    description: d.description,
    period_key: d.periodKey,
    period_label: d.periodLabel,
    currency: d.currency,
    original_amount: d.originalAmount,
    discount_amount: d.discountAmount,
    concession_amount: d.concessionAmount,
    waiver_amount: d.waiverAmount,
    late_fee_amount: d.lateFeeAmount,
    final_amount: d.finalAmount,
    paid_amount: d.paidAmount,
    written_off_amount: d.writtenOffAmount,
    outstanding_amount: fromMinor(out),
    due_date: d.dueDate,
    status: overdue ? ('OVERDUE' as const) : d.status,
    is_overdue: overdue,
    days_overdue: overdue ? daysBetween(d.dueDate, today) : 0,
    issued_at: iso(d.issuedAt),
    settled_at: iso(d.settledAt),
    late_fee_applied_at: iso(d.lateFeeAppliedAt),
    cancelled_at: iso(d.cancelledAt),
    cancel_reason: d.cancelReason,
    written_off_at: iso(d.writtenOffAt),
    write_off_reason: d.writeOffReason,
    version: d.version,
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
  };
}
export type DemandView = ReturnType<typeof presentDemand>;

export function presentPayment(p: PaymentRow, extra: { student?: StudentMini } = {}) {
  const amount = toMinor(p.amount);
  const allocated = toMinor(p.allocatedAmount);
  const refunded = toMinor(p.refundedAmount);
  return {
    id: p.id,
    payment_number: p.paymentNumber,
    student: extra.student ?? { id: p.studentId },
    payer_type: p.payerType,
    payer_name: p.payerName,
    payer_reference: p.payerReference,
    amount: p.amount,
    currency: p.currency,
    method: p.method,
    status: p.status,
    provider: p.provider,
    provider_reference: p.providerReference,
    idempotency_key: p.idempotencyKey,
    notes: p.notes,
    received_on: p.receivedOn,
    received_at: iso(p.receivedAt),
    verified_at: iso(p.verifiedAt),
    failed_reason: p.failedReason,
    cancelled_at: iso(p.cancelledAt),
    cancel_reason: p.cancelReason,
    allocated_amount: p.allocatedAmount,
    refunded_amount: p.refundedAmount,
    unallocated_amount: fromMinor(amount - allocated - refunded),
    version: p.version,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}
export type PaymentView = ReturnType<typeof presentPayment>;

export const presentAllocation = (
  a: AllocationRow,
  extra: { demandNumber?: string; description?: string } = {},
) => ({
  id: a.id,
  payment_id: a.paymentId,
  fee_demand_id: a.feeDemandId,
  demand_number: extra.demandNumber,
  description: extra.description,
  currency: a.currency,
  allocated_amount: a.allocatedAmount,
  reversed_amount: a.reversedAmount,
  net_amount: fromMinor(toMinor(a.allocatedAmount) - toMinor(a.reversedAmount)),
  status: a.status,
  reversed_at: iso(a.reversedAt),
  reversal_reason: a.reversalReason,
  created_at: a.createdAt.toISOString(),
});

export const presentReceipt = (
  r: ReceiptRow,
  extra: {
    student?: StudentMini;
    payment?: { payment_number: string; method: string; received_on: string };
  } = {},
) => ({
  id: r.id,
  receipt_number: r.receiptNumber,
  status: r.status,
  payment_id: r.paymentId,
  payment: extra.payment,
  student: extra.student ?? { id: r.studentId },
  amount: r.amount,
  currency: r.currency,
  issued_at: r.issuedAt.toISOString(),
  voided_at: iso(r.voidedAt),
  void_reason: r.voidReason,
  version: r.version,
});

export const presentAdjustment = (
  a: AdjustmentRow,
  extra: { student?: StudentMini; demandNumber?: string } = {},
) => ({
  id: a.id,
  type: a.type,
  student: extra.student ?? { id: a.studentId },
  fee_demand_id: a.feeDemandId,
  demand_number: extra.demandNumber,
  value_type: a.valueType,
  value: a.value,
  applied_amount: a.appliedAmount,
  currency: a.currency,
  reason: a.reason,
  status: a.status,
  requested_by: a.requestedBy,
  requested_at: a.requestedAt.toISOString(),
  approved_by: a.approvedBy,
  approved_at: iso(a.approvedAt),
  decision_note: a.decisionNote,
  rejected_at: iso(a.rejectedAt),
  applied_by: a.appliedBy,
  applied_at: iso(a.appliedAt),
  cancelled_at: iso(a.cancelledAt),
  cancel_reason: a.cancelReason,
  version: a.version,
  created_at: a.createdAt.toISOString(),
  updated_at: a.updatedAt.toISOString(),
});

export const presentRefund = (
  r: RefundRow,
  extra: { student?: StudentMini; paymentNumber?: string } = {},
) => ({
  id: r.id,
  refund_number: r.refundNumber,
  payment_id: r.paymentId,
  payment_number: extra.paymentNumber,
  student: extra.student ?? { id: r.studentId },
  amount: r.amount,
  currency: r.currency,
  reason: r.reason,
  status: r.status,
  provider_reference: r.providerReference,
  from_unallocated: r.fromUnallocated,
  requested_by: r.requestedBy,
  requested_at: r.requestedAt.toISOString(),
  approved_by: r.approvedBy,
  approved_at: iso(r.approvedAt),
  processing_at: iso(r.processingAt),
  completed_at: iso(r.completedAt),
  failed_at: iso(r.failedAt),
  failed_reason: r.failedReason,
  cancelled_at: iso(r.cancelledAt),
  cancel_reason: r.cancelReason,
  version: r.version,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
});

// ---- misc --------------------------------------------------------------------------------------------------

/** Escape LIKE wildcards so a search for "50%" is literal. */
export const likeOf = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export type { Actor };
