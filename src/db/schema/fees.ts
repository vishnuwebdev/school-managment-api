import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  decimal,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt, version } from './_columns.js';
import { academicClasses, academicYears } from './academic.js';
import {
  ALLOCATION_STATUS,
  FEE_ADJUSTMENT_STATUS,
  FEE_ADJUSTMENT_TYPE,
  FEE_ADJUSTMENT_VALUE_TYPE,
  FEE_ASSIGNMENT_STATUS,
  FEE_CATEGORY_STATUS,
  FEE_DEMAND_STATUS,
  FEE_FREQUENCY,
  FEE_STRUCTURE_STATUS,
  LATE_FEE_TYPE,
  PAYER_TYPE,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  RECEIPT_STATUS,
  REFUND_STATUS,
} from './enums.js';
import { enrollments, students } from './students.js';
import { tenants } from './tenancy.js';

/**
 * School fees (Part 18 / Part 35). Completely separate from platform billing
 * (`plans`, `subscriptions`, platform invoices): a Student owes the School.
 * Every table is tenant-scoped and references its parents through composite
 * foreign keys `(tenant_id, x_id)`, so the database refuses cross-school links.
 * Money is DECIMAL(14,2) with a currency; the application computes with integer
 * minor units and CHECK constraints are the last line of defence for balances.
 */

const money = (name: string) => decimal(name, { precision: 14, scale: 2 });

/** Business type of a fee (Tuition, Transport, Library …). Configurable per school. */
export const feeCategories = mysqlTable(
  'fee_categories',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    description: varchar('description', { length: 500 }),
    status: mysqlEnum('status', FEE_CATEGORY_STATUS).notNull().default('ACTIVE'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('fee_categories_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('fee_categories_tenant_code_uq').on(t.tenantId, t.code),
    index('fee_categories_tenant_status_idx').on(t.tenantId, t.status),
  ],
);

/** One row per school, created lazily: currency and the late-fee rule. */
export const feeSettings = mysqlTable(
  'fee_settings',
  {
    tenantId: ref('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    currency: char('currency', { length: 3 }).notNull(),
    lateFeeEnabled: boolean('late_fee_enabled').notNull().default(false),
    /** FIXED amount once, PERCENT of the net demand once, PER_DAY amount for every day late. */
    lateFeeType: mysqlEnum('late_fee_type', LATE_FEE_TYPE).notNull().default('FIXED'),
    /** An amount for FIXED / PER_DAY, a percentage (0–100) for PERCENT. */
    lateFeeValue: money('late_fee_value').notNull().default('0.00'),
    lateFeeGraceDays: int('late_fee_grace_days').notNull().default(0),
    /** Upper limit of the late fee per demand. NULL = no cap. */
    lateFeeCap: money('late_fee_cap'),
    version: version(),
    updatedBy: ref('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('fee_settings_late_value_chk', sql`${t.lateFeeValue} >= 0`)],
);

/**
 * A version of what a school intends to charge for an academic year (optionally one class).
 * `code` identifies the structure across versions, `version_no` numbers them. PUBLISHED versions
 * are immutable; changing one means duplicating it as a new DRAFT version and publishing that,
 * which archives the version it replaces. Issued demands never follow a structure.
 */
export const feeStructures = mysqlTable(
  'fee_structures',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    description: varchar('description', { length: 500 }),
    versionNo: int('version_no').notNull(),
    academicYearId: ref('academic_year_id').notNull(),
    /** NULL = applies to every class of the year. */
    academicClassId: ref('academic_class_id'),
    /** NULL = every section of the class. Set for an extra fee that only some sections pay. */
    academicSectionId: ref('academic_section_id'),
    currency: char('currency', { length: 3 }).notNull(),
    status: mysqlEnum('status', FEE_STRUCTURE_STATUS).notNull().default('DRAFT'),
    effectiveFrom: date('effective_from', { mode: 'string' }),
    effectiveTo: date('effective_to', { mode: 'string' }),
    copiedFromId: ref('copied_from_id'),
    supersededById: ref('superseded_by_id'),
    /**
     * Generated: year + class + code while PUBLISHED, NULL otherwise. UNIQUE on it = at most one
     * published version of a structure per year and class (a partial unique index for MySQL).
     */
    publishedKey: varchar('published_key', { length: 160 }).generatedAlwaysAs(
      sql`(IF(\`status\` = 'PUBLISHED', CONCAT(\`tenant_id\`, ':', \`academic_year_id\`, ':', IFNULL(\`academic_class_id\`, 'ALL'), ':', \`code\`), NULL))`,
      { mode: 'virtual' },
    ),
    publishedAt: dt('published_at'),
    publishedBy: ref('published_by'),
    archivedAt: dt('archived_at'),
    archivedBy: ref('archived_by'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('fee_structures_tenant_id_uq').on(t.tenantId, t.id),
    /** Lets assignments pin "this structure belongs to this year". */
    uniqueIndex('fee_structures_tenant_id_year_uq').on(t.tenantId, t.id, t.academicYearId),
    uniqueIndex('fee_structures_code_version_uq').on(t.tenantId, t.code, t.versionNo),
    uniqueIndex('fee_structures_published_uq').on(t.publishedKey),
    index('fee_structures_year_status_idx').on(t.tenantId, t.academicYearId, t.status),
    index('fee_structures_section_idx').on(t.tenantId, t.academicSectionId),
    foreignKey({
      name: 'fee_structures_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }),
    foreignKey({
      name: 'fee_structures_class_fk',
      columns: [t.tenantId, t.academicClassId],
      foreignColumns: [academicClasses.tenantId, academicClasses.id],
    }),
    foreignKey({
      name: 'fee_structures_copied_from_fk',
      columns: [t.tenantId, t.copiedFromId],
      foreignColumns: [t.tenantId, t.id],
    }),
    foreignKey({
      name: 'fee_structures_superseded_by_fk',
      columns: [t.tenantId, t.supersededById],
      foreignColumns: [t.tenantId, t.id],
    }),
  ],
);

export interface DueRule {
  type: 'FIXED_DATE' | 'DAY_OF_MONTH' | 'DAYS_AFTER_PERIOD_START' | 'CUSTOM_DATES';
  date?: string;
  day?: number;
  days?: number;
  dates?: string[];
}

/** One charge inside a structure: amount, frequency and the rule that yields each period's due date. */
export const feeComponents = mysqlTable(
  'fee_components',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    feeStructureId: ref('fee_structure_id').notNull(),
    feeCategoryId: ref('fee_category_id').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    /** Amount charged per period (per instalment for CUSTOM). */
    amount: money('amount').notNull(),
    frequency: mysqlEnum('frequency', FEE_FREQUENCY).notNull(),
    dueRule: json('due_rule').$type<DueRule>().notNull(),
    displayOrder: int('display_order').notNull().default(0),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('fee_components_tenant_id_uq').on(t.tenantId, t.id),
    index('fee_components_structure_idx').on(t.tenantId, t.feeStructureId, t.displayOrder),
    index('fee_components_category_idx').on(t.tenantId, t.feeCategoryId),
    check('fee_components_amount_chk', sql`${t.amount} > 0`),
    foreignKey({
      name: 'fee_components_structure_fk',
      columns: [t.tenantId, t.feeStructureId],
      foreignColumns: [feeStructures.tenantId, feeStructures.id],
    }),
    foreignKey({
      name: 'fee_components_category_fk',
      columns: [t.tenantId, t.feeCategoryId],
      foreignColumns: [feeCategories.tenantId, feeCategories.id],
    }),
  ],
);

/** "This student actually has these obligations": a student + enrollment + a PUBLISHED structure version. */
export const studentFeeAssignments = mysqlTable(
  'student_fee_assignments',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    studentId: ref('student_id').notNull(),
    enrollmentId: ref('enrollment_id').notNull(),
    academicYearId: ref('academic_year_id').notNull(),
    feeStructureId: ref('fee_structure_id').notNull(),
    /** Copied from the structure: identifies it across versions (one active assignment per enrollment and code). */
    structureCode: varchar('structure_code', { length: 32 }).notNull(),
    status: mysqlEnum('status', FEE_ASSIGNMENT_STATUS).notNull().default('ACTIVE'),
    /** Percentage discount for this student, snapshotted into every demand generated from the assignment. */
    discountPercent: decimal('discount_percent', { precision: 5, scale: 2 })
      .notNull()
      .default('0.00'),
    discountReason: varchar('discount_reason', { length: 500 }),
    notes: varchar('notes', { length: 500 }),
    assignedAt: dt('assigned_at').notNull(),
    assignedBy: ref('assigned_by'),
    cancelledAt: dt('cancelled_at'),
    cancelledBy: ref('cancelled_by'),
    cancelReason: varchar('cancel_reason', { length: 500 }),
    activeKey: varchar('active_key', { length: 80 }).generatedAlwaysAs(
      sql`(IF(\`status\` = 'ACTIVE', CONCAT(\`enrollment_id\`, ':', \`structure_code\`), NULL))`,
      { mode: 'virtual' },
    ),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('student_fee_assignments_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('student_fee_assignments_tenant_id_student_uq').on(t.tenantId, t.id, t.studentId),
    uniqueIndex('student_fee_assignments_active_uq').on(t.activeKey),
    index('student_fee_assignments_student_idx').on(t.tenantId, t.studentId),
    index('student_fee_assignments_enrollment_idx').on(t.tenantId, t.enrollmentId),
    index('student_fee_assignments_structure_idx').on(t.tenantId, t.feeStructureId, t.status),
    check(
      'student_fee_assignments_discount_chk',
      sql`${t.discountPercent} >= 0 AND ${t.discountPercent} <= 100`,
    ),
    foreignKey({
      name: 'student_fee_assignments_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'student_fee_assignments_enrollment_fk',
      columns: [t.tenantId, t.enrollmentId, t.studentId, t.academicYearId],
      foreignColumns: [
        enrollments.tenantId,
        enrollments.id,
        enrollments.studentId,
        enrollments.academicYearId,
      ],
    }),
    foreignKey({
      name: 'student_fee_assignments_structure_fk',
      columns: [t.tenantId, t.feeStructureId, t.academicYearId],
      foreignColumns: [feeStructures.tenantId, feeStructures.id, feeStructures.academicYearId],
    }),
  ],
);

/**
 * The actual amount owed for one component and period. A snapshot: amounts, due date and the
 * component description are copied at generation and never follow the structure afterwards.
 * `final = original − discount − concession − waiver + late_fee`; outstanding =
 * `final − paid − written_off`. Balances are maintained under row locks and guarded by CHECKs.
 */
export const feeDemands = mysqlTable(
  'fee_demands',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    demandNumber: varchar('demand_number', { length: 32 }).notNull(),
    studentId: ref('student_id').notNull(),
    enrollmentId: ref('enrollment_id').notNull(),
    academicYearId: ref('academic_year_id').notNull(),
    studentFeeAssignmentId: ref('student_fee_assignment_id').notNull(),
    feeComponentId: ref('fee_component_id').notNull(),
    feeCategoryId: ref('fee_category_id').notNull(),
    /** Idempotency slot: MONTHLY 2026-04, QUARTERLY 2026-Q1, HALF_YEARLY 2026-H1, ANNUAL, ONE_TIME, CUSTOM C1… */
    periodKey: varchar('period_key', { length: 16 }).notNull(),
    periodLabel: varchar('period_label', { length: 80 }).notNull(),
    /** Component name at generation time. */
    description: varchar('description', { length: 200 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    originalAmount: money('original_amount').notNull(),
    discountAmount: money('discount_amount').notNull().default('0.00'),
    concessionAmount: money('concession_amount').notNull().default('0.00'),
    waiverAmount: money('waiver_amount').notNull().default('0.00'),
    lateFeeAmount: money('late_fee_amount').notNull().default('0.00'),
    finalAmount: money('final_amount').notNull(),
    paidAmount: money('paid_amount').notNull().default('0.00'),
    writtenOffAmount: money('written_off_amount').notNull().default('0.00'),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    status: mysqlEnum('status', FEE_DEMAND_STATUS).notNull().default('DRAFT'),
    issuedAt: dt('issued_at'),
    issuedBy: ref('issued_by'),
    settledAt: dt('settled_at'),
    lateFeeAppliedAt: dt('late_fee_applied_at'),
    cancelledAt: dt('cancelled_at'),
    cancelledBy: ref('cancelled_by'),
    cancelReason: varchar('cancel_reason', { length: 500 }),
    writtenOffAt: dt('written_off_at'),
    writtenOffBy: ref('written_off_by'),
    writeOffReason: varchar('write_off_reason', { length: 500 }),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('fee_demands_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('fee_demands_tenant_id_student_uq').on(t.tenantId, t.id, t.studentId),
    uniqueIndex('fee_demands_tenant_number_uq').on(t.tenantId, t.demandNumber),
    uniqueIndex('fee_demands_slot_uq').on(
      t.tenantId,
      t.studentFeeAssignmentId,
      t.feeComponentId,
      t.periodKey,
    ),
    index('fee_demands_student_status_idx').on(t.tenantId, t.studentId, t.status),
    index('fee_demands_due_idx').on(t.tenantId, t.dueDate, t.status),
    index('fee_demands_year_idx').on(t.tenantId, t.academicYearId, t.status),
    index('fee_demands_assignment_idx').on(t.tenantId, t.studentFeeAssignmentId),
    index('fee_demands_category_idx').on(t.tenantId, t.feeCategoryId),
    check(
      'fee_demands_amounts_chk',
      sql`${t.originalAmount} >= 0 AND ${t.discountAmount} >= 0 AND ${t.concessionAmount} >= 0 AND ${t.waiverAmount} >= 0 AND ${t.lateFeeAmount} >= 0 AND ${t.paidAmount} >= 0 AND ${t.writtenOffAmount} >= 0`,
    ),
    check(
      'fee_demands_final_chk',
      sql`${t.finalAmount} = ${t.originalAmount} - ${t.discountAmount} - ${t.concessionAmount} - ${t.waiverAmount} + ${t.lateFeeAmount}`,
    ),
    check(
      'fee_demands_balance_chk',
      sql`${t.finalAmount} >= 0 AND ${t.paidAmount} + ${t.writtenOffAmount} <= ${t.finalAmount}`,
    ),
    foreignKey({
      name: 'fee_demands_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'fee_demands_enrollment_fk',
      columns: [t.tenantId, t.enrollmentId],
      foreignColumns: [enrollments.tenantId, enrollments.id],
    }),
    foreignKey({
      name: 'fee_demands_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }),
    foreignKey({
      name: 'fee_demands_assignment_fk',
      columns: [t.tenantId, t.studentFeeAssignmentId, t.studentId],
      foreignColumns: [
        studentFeeAssignments.tenantId,
        studentFeeAssignments.id,
        studentFeeAssignments.studentId,
      ],
    }),
    foreignKey({
      name: 'fee_demands_component_fk',
      columns: [t.tenantId, t.feeComponentId],
      foreignColumns: [feeComponents.tenantId, feeComponents.id],
    }),
    foreignKey({
      name: 'fee_demands_category_fk',
      columns: [t.tenantId, t.feeCategoryId],
      foreignColumns: [feeCategories.tenantId, feeCategories.id],
    }),
  ],
);

/**
 * Money received by the school from (or for) a student. Never deleted: it is cancelled or refunded.
 * `allocated_amount` (net of reversals) and `refunded_amount` (completed refunds) are maintained under
 * the payment row lock, so concurrent allocations can never exceed the payment.
 */
export const schoolPayments = mysqlTable(
  'school_payments',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paymentNumber: varchar('payment_number', { length: 32 }).notNull(),
    studentId: ref('student_id').notNull(),
    payerType: mysqlEnum('payer_type', PAYER_TYPE).notNull().default('GUARDIAN'),
    payerName: varchar('payer_name', { length: 150 }),
    payerReference: varchar('payer_reference', { length: 100 }),
    amount: money('amount').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    method: mysqlEnum('method', PAYMENT_METHOD).notNull(),
    status: mysqlEnum('status', PAYMENT_STATUS).notNull().default('PENDING'),
    provider: varchar('provider', { length: 64 }),
    /** Cheque / transfer / gateway transaction reference. Unique per school (retried callbacks = one payment). */
    providerReference: varchar('provider_reference', { length: 128 }),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    notes: varchar('notes', { length: 500 }),
    /** School-local calendar date of receipt (drives daily collection reports). */
    receivedOn: date('received_on', { mode: 'string' }).notNull(),
    receivedAt: dt('received_at'),
    verifiedAt: dt('verified_at'),
    verifiedBy: ref('verified_by'),
    failedReason: varchar('failed_reason', { length: 500 }),
    cancelledAt: dt('cancelled_at'),
    cancelledBy: ref('cancelled_by'),
    cancelReason: varchar('cancel_reason', { length: 500 }),
    allocatedAmount: money('allocated_amount').notNull().default('0.00'),
    refundedAmount: money('refunded_amount').notNull().default('0.00'),
    version: version(),
    recordedBy: ref('recorded_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('school_payments_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('school_payments_tenant_id_student_uq').on(t.tenantId, t.id, t.studentId),
    uniqueIndex('school_payments_tenant_number_uq').on(t.tenantId, t.paymentNumber),
    uniqueIndex('school_payments_idempotency_uq').on(t.tenantId, t.idempotencyKey),
    uniqueIndex('school_payments_provider_ref_uq').on(t.tenantId, t.providerReference),
    index('school_payments_student_idx').on(t.tenantId, t.studentId, t.status),
    index('school_payments_status_idx').on(t.tenantId, t.status),
    index('school_payments_received_idx').on(t.tenantId, t.receivedOn),
    check('school_payments_amount_chk', sql`${t.amount} > 0`),
    check(
      'school_payments_balance_chk',
      sql`${t.allocatedAmount} >= 0 AND ${t.refundedAmount} >= 0 AND ${t.allocatedAmount} + ${t.refundedAmount} <= ${t.amount}`,
    ),
    foreignKey({
      name: 'school_payments_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
  ],
);

/**
 * One slice of a payment applied to one demand. Rows are never deleted: a reversal (refund,
 * cancellation, correction) raises `reversed_amount`. Payment and demand must belong to the same
 * school AND the same student (composite foreign keys on both sides).
 */
export const paymentAllocations = mysqlTable(
  'payment_allocations',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paymentId: ref('payment_id').notNull(),
    feeDemandId: ref('fee_demand_id').notNull(),
    studentId: ref('student_id').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    allocatedAmount: money('allocated_amount').notNull(),
    reversedAmount: money('reversed_amount').notNull().default('0.00'),
    status: mysqlEnum('status', ALLOCATION_STATUS).notNull().default('ACTIVE'),
    allocatedBy: ref('allocated_by'),
    reversedAt: dt('reversed_at'),
    reversedBy: ref('reversed_by'),
    reversalReason: varchar('reversal_reason', { length: 500 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payment_allocations_tenant_id_uq').on(t.tenantId, t.id),
    index('payment_allocations_payment_idx').on(t.tenantId, t.paymentId),
    index('payment_allocations_demand_idx').on(t.tenantId, t.feeDemandId),
    check('payment_allocations_amount_chk', sql`${t.allocatedAmount} > 0`),
    check(
      'payment_allocations_reversed_chk',
      sql`${t.reversedAmount} >= 0 AND ${t.reversedAmount} <= ${t.allocatedAmount}`,
    ),
    foreignKey({
      name: 'payment_allocations_payment_fk',
      columns: [t.tenantId, t.paymentId, t.studentId],
      foreignColumns: [schoolPayments.tenantId, schoolPayments.id, schoolPayments.studentId],
    }),
    foreignKey({
      name: 'payment_allocations_demand_fk',
      columns: [t.tenantId, t.feeDemandId, t.studentId],
      foreignColumns: [feeDemands.tenantId, feeDemands.id, feeDemands.studentId],
    }),
  ],
);

/** Confirmation of a payment. A receipt is voided (never deleted) and a new one issued when needed. */
export const feeReceipts = mysqlTable(
  'receipts',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paymentId: ref('payment_id').notNull(),
    studentId: ref('student_id').notNull(),
    receiptNumber: varchar('receipt_number', { length: 32 }).notNull(),
    status: mysqlEnum('status', RECEIPT_STATUS).notNull().default('ISSUED'),
    /** Amount of the payment when the receipt was issued. */
    amount: money('amount').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    issuedAt: dt('issued_at').notNull(),
    issuedBy: ref('issued_by'),
    voidedAt: dt('voided_at'),
    voidedBy: ref('voided_by'),
    voidReason: varchar('void_reason', { length: 500 }),
    /** Generated: the payment id while ISSUED → at most one valid receipt per payment. */
    activeKey: varchar('active_key', { length: 36 }).generatedAlwaysAs(
      sql`(IF(\`status\` = 'ISSUED', \`payment_id\`, NULL))`,
      { mode: 'virtual' },
    ),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('receipts_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('receipts_tenant_number_uq').on(t.tenantId, t.receiptNumber),
    uniqueIndex('receipts_active_uq').on(t.activeKey),
    index('receipts_payment_idx').on(t.tenantId, t.paymentId),
    index('receipts_student_idx').on(t.tenantId, t.studentId),
    foreignKey({
      name: 'receipts_payment_fk',
      columns: [t.tenantId, t.paymentId, t.studentId],
      foreignColumns: [schoolPayments.tenantId, schoolPayments.id, schoolPayments.studentId],
    }),
  ],
);

/**
 * Concessions and waivers: REQUESTED → APPROVED (by a different person) → APPLIED to one demand.
 * The demand keeps original_amount and the running concession/waiver totals; this row keeps who
 * asked, who approved, why and the amount that was applied.
 */
export const feeAdjustments = mysqlTable(
  'fee_adjustments',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    type: mysqlEnum('type', FEE_ADJUSTMENT_TYPE).notNull(),
    studentId: ref('student_id').notNull(),
    feeDemandId: ref('fee_demand_id').notNull(),
    valueType: mysqlEnum('value_type', FEE_ADJUSTMENT_VALUE_TYPE).notNull(),
    /** An amount, or a percentage (0–100] of the demand's original amount. */
    value: money('value').notNull(),
    /** The amount actually deducted; set when applied. */
    appliedAmount: money('applied_amount'),
    currency: char('currency', { length: 3 }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    status: mysqlEnum('status', FEE_ADJUSTMENT_STATUS).notNull().default('REQUESTED'),
    requestedOn: date('requested_on', { mode: 'string' }).notNull(),
    requestedBy: ref('requested_by'),
    requestedAt: dt('requested_at').notNull(),
    approvedBy: ref('approved_by'),
    approvedAt: dt('approved_at'),
    decisionNote: varchar('decision_note', { length: 500 }),
    rejectedBy: ref('rejected_by'),
    rejectedAt: dt('rejected_at'),
    appliedBy: ref('applied_by'),
    appliedAt: dt('applied_at'),
    cancelledBy: ref('cancelled_by'),
    cancelledAt: dt('cancelled_at'),
    cancelReason: varchar('cancel_reason', { length: 500 }),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('fee_adjustments_tenant_id_uq').on(t.tenantId, t.id),
    index('fee_adjustments_demand_idx').on(t.tenantId, t.feeDemandId),
    index('fee_adjustments_student_idx').on(t.tenantId, t.studentId),
    index('fee_adjustments_status_idx').on(t.tenantId, t.status, t.type),
    index('fee_adjustments_requested_idx').on(t.tenantId, t.requestedOn),
    check('fee_adjustments_value_chk', sql`${t.value} > 0`),
    foreignKey({
      name: 'fee_adjustments_demand_fk',
      columns: [t.tenantId, t.feeDemandId, t.studentId],
      foreignColumns: [feeDemands.tenantId, feeDemands.id, feeDemands.studentId],
    }),
  ],
);

/** Money returned for a payment. The payment is never deleted; allocations are reversed on completion. */
export const feeRefunds = mysqlTable(
  'fee_refunds',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    refundNumber: varchar('refund_number', { length: 32 }).notNull(),
    paymentId: ref('payment_id').notNull(),
    studentId: ref('student_id').notNull(),
    amount: money('amount').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    status: mysqlEnum('status', REFUND_STATUS).notNull().default('REQUESTED'),
    providerReference: varchar('provider_reference', { length: 128 }),
    /** Part of the amount taken from the payment's unallocated balance when completed; the rest reversed allocations. */
    fromUnallocated: money('from_unallocated'),
    requestedOn: date('requested_on', { mode: 'string' }).notNull(),
    requestedBy: ref('requested_by'),
    requestedAt: dt('requested_at').notNull(),
    approvedBy: ref('approved_by'),
    approvedAt: dt('approved_at'),
    processingAt: dt('processing_at'),
    processingBy: ref('processing_by'),
    completedAt: dt('completed_at'),
    completedBy: ref('completed_by'),
    failedAt: dt('failed_at'),
    failedReason: varchar('failed_reason', { length: 500 }),
    cancelledAt: dt('cancelled_at'),
    cancelledBy: ref('cancelled_by'),
    cancelReason: varchar('cancel_reason', { length: 500 }),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('fee_refunds_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('fee_refunds_tenant_number_uq').on(t.tenantId, t.refundNumber),
    index('fee_refunds_payment_idx').on(t.tenantId, t.paymentId, t.status),
    index('fee_refunds_student_idx').on(t.tenantId, t.studentId),
    index('fee_refunds_status_idx').on(t.tenantId, t.status),
    index('fee_refunds_requested_idx').on(t.tenantId, t.requestedOn),
    check('fee_refunds_amount_chk', sql`${t.amount} > 0`),
    foreignKey({
      name: 'fee_refunds_payment_fk',
      columns: [t.tenantId, t.paymentId, t.studentId],
      foreignColumns: [schoolPayments.tenantId, schoolPayments.id, schoolPayments.studentId],
    }),
  ],
);

/** How a completed refund reversed allocations (the audit trail of the reversal math). */
export const refundAllocations = mysqlTable(
  'refund_allocations',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    refundId: ref('refund_id').notNull(),
    paymentAllocationId: ref('payment_allocation_id').notNull(),
    amount: money('amount').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('refund_allocations_refund_idx').on(t.tenantId, t.refundId),
    index('refund_allocations_allocation_idx').on(t.tenantId, t.paymentAllocationId),
    check('refund_allocations_amount_chk', sql`${t.amount} > 0`),
    foreignKey({
      name: 'refund_allocations_refund_fk',
      columns: [t.tenantId, t.refundId],
      foreignColumns: [feeRefunds.tenantId, feeRefunds.id],
    }),
    foreignKey({
      name: 'refund_allocations_allocation_fk',
      columns: [t.tenantId, t.paymentAllocationId],
      foreignColumns: [paymentAllocations.tenantId, paymentAllocations.id],
    }),
  ],
);

/**
 * Proof that a payment really arrived: the EFT confirmation, card slip or signed cash receipt.
 * Several can be attached to one payment; they are kept for audit and never replaced or deleted.
 */
export const paymentProofs = mysqlTable(
  'payment_proofs',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paymentId: ref('payment_id').notNull(),
    fileId: ref('file_id').notNull(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    uploadedBy: ref('uploaded_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('payment_proofs_payment_idx').on(t.tenantId, t.paymentId),
    foreignKey({
      name: 'payment_proofs_payment_fk',
      columns: [t.tenantId, t.paymentId],
      foreignColumns: [schoolPayments.tenantId, schoolPayments.id],
    }),
  ],
);
