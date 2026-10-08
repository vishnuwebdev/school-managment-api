import { z } from 'zod';
import {
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
  RECORDABLE_PAYMENT_METHODS,
  PAYMENT_STATUS,
  RECEIPT_STATUS,
  REFUND_STATUS,
} from '../../db/schema/index.js';
import { PaginationQuery } from '../../shared/pagination.js';
import { MONEY_INPUT, normalizeMoney, toMinor } from './money.js';

export const IdParams = z.object({ id: z.uuid() });
export const StudentParams = z.object({ student_id: z.uuid() });
export const AllocationParams = z.object({ id: z.uuid(), allocation_id: z.uuid() });
export const REPORTS = [
  'demands',
  'payments',
  'outstanding',
  'collection',
  'overdue',
  'concessions',
  'refunds',
] as const;
export const ExportParams = z.object({ report: z.enum(REPORTS) });

const Version = z.number().int().positive();
const IsoDate = z.iso.date();
export const Reason = z.string().trim().min(3).max(500);
const Code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z0-9][A-Z0-9_.-]{0,31}$/,
    'Use letters, numbers and _ . - (max 32, start with a letter or number)',
  );

/**
 * A decimal amount with at most two decimals, sent as a string ("4000.50"). A JSON number is accepted too
 * (it is read from its written form, never computed with). Normalised to two places.
 */
export const Money = z
  .preprocess(
    (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : v),
    z
      .string()
      .trim()
      .regex(MONEY_INPUT, 'Use a decimal amount with at most two decimals, e.g. "4000.50"'),
  )
  .transform(normalizeMoney);
export const PositiveMoney = Money.refine((v) => toMinor(v) > 0n, {
  message: 'The amount must be greater than zero',
});
const Percent = Money.refine((v) => toMinor(v) <= 10_000n, {
  message: 'A percentage cannot be more than 100',
});
const PositivePercent = Percent.refine((v) => toMinor(v) > 0n, {
  message: 'The percentage must be greater than zero',
});

// ---- Settings ------------------------------------------------------------------------
export const UpdateSettingsBody = z.object({
  version: Version,
  late_fee_enabled: z.boolean().optional(),
  late_fee_type: z.enum(LATE_FEE_TYPE).optional(),
  /** An amount for FIXED / PER_DAY, a percentage (0–100) for PERCENT. */
  late_fee_value: Money.optional(),
  late_fee_grace_days: z.number().int().min(0).max(365).optional(),
  late_fee_cap: Money.nullable().optional(),
});

// ---- Categories ------------------------------------------------------------------------
export const CategoryListQuery = PaginationQuery.extend({
  status: z.enum(FEE_CATEGORY_STATUS).optional(),
});
export const CreateCategoryBody = z.object({
  code: Code,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().optional(),
});
export const UpdateCategoryBody = z.object({
  version: Version,
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

// ---- Structures & components ---------------------------------------------------------------
export const StructureListQuery = PaginationQuery.extend({
  academic_year_id: z.uuid().optional(),
  academic_class_id: z.uuid().optional(),
  status: z.enum(FEE_STRUCTURE_STATUS).optional(),
  code: z.string().trim().toUpperCase().max(32).optional(),
});
const dateOrder = (b: { effective_from?: string | null; effective_to?: string | null }) =>
  !b.effective_from || !b.effective_to || b.effective_from <= b.effective_to;
const dateOrderIssue = {
  message: 'effective_to cannot be before effective_from',
  path: ['effective_to'],
};
export const CreateStructureBody = z
  .object({
    code: Code,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable().optional(),
    academic_year_id: z.uuid(),
    /** Omit / null: applies to every class of the year. */
    academic_class_id: z.uuid().nullable().optional(),
    /** Only with academic_class_id: the structure is billed to this section of the class alone. */
    academic_section_id: z.uuid().nullable().optional(),
    effective_from: IsoDate.nullable().optional(),
    effective_to: IsoDate.nullable().optional(),
  })
  .refine(dateOrder, dateOrderIssue)
  .refine((b) => !b.academic_section_id || b.academic_class_id, {
    message: 'A section needs its class',
    path: ['academic_section_id'],
  });
export const UpdateStructureBody = z
  .object({
    version: Version,
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    academic_class_id: z.uuid().nullable().optional(),
    effective_from: IsoDate.nullable().optional(),
    effective_to: IsoDate.nullable().optional(),
  })
  .refine(dateOrder, dateOrderIssue);
export const DuplicateStructureBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});
export const PublishStructureBody = z.object({
  version: Version.optional(),
  /** Defaults to the draft's own date, else today (school time zone). */
  effective_from: IsoDate.optional(),
});
export const ArchiveStructureBody = z.object({
  version: Version.optional(),
  reason: Reason.optional(),
});

export const DueRuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('FIXED_DATE'), date: IsoDate }),
  z.object({ type: z.literal('DAY_OF_MONTH'), day: z.number().int().min(1).max(28) }),
  z.object({
    type: z.literal('DAYS_AFTER_PERIOD_START'),
    days: z.number().int().min(0).max(366),
  }),
  z.object({
    type: z.literal('CUSTOM_DATES'),
    dates: z
      .array(IsoDate)
      .min(1)
      .max(24)
      .refine((d) => new Set(d).size === d.length && [...d].sort().join() === d.join(), {
        message: 'Dates must be unique and in ascending order',
      }),
  }),
]);
export const CreateComponentBody = z.object({
  fee_category_id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  amount: PositiveMoney,
  frequency: z.enum(FEE_FREQUENCY),
  /** Defaults to "due on the first day of each period" (DAYS_AFTER_PERIOD_START 0); CUSTOM needs CUSTOM_DATES. */
  due_rule: DueRuleSchema.optional(),
  display_order: z.number().int().min(0).max(10_000).default(0),
});
export const UpdateComponentBody = z.object({
  version: Version,
  fee_category_id: z.uuid().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  amount: PositiveMoney.optional(),
  frequency: z.enum(FEE_FREQUENCY).optional(),
  due_rule: DueRuleSchema.optional(),
  display_order: z.number().int().min(0).max(10_000).optional(),
});
export const DeleteComponentQuery = z.object({
  version: z.coerce.number().int().positive().optional(),
});

// ---- Assignments ---------------------------------------------------------------------------------
export const AssignmentListQuery = PaginationQuery.extend({
  student_id: z.uuid().optional(),
  fee_structure_id: z.uuid().optional(),
  academic_year_id: z.uuid().optional(),
  class_id: z.uuid().optional(),
  section_id: z.uuid().optional(),
  status: z.enum(FEE_ASSIGNMENT_STATUS).optional(),
});
export const CreateAssignmentBody = z.object({
  student_id: z.uuid(),
  fee_structure_id: z.uuid(),
  /** Defaults to the student's open enrollment in the structure's academic year. */
  enrollment_id: z.uuid().optional(),
  /** Percentage discount for this student. Needs fees.waivers.approve. */
  discount_percent: PositivePercent.optional(),
  discount_reason: Reason.optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});
export const BulkAssignBody = z
  .object({
    fee_structure_id: z.uuid(),
    section_id: z.uuid().optional(),
    class_id: z.uuid().optional(),
    discount_percent: PositivePercent.optional(),
    discount_reason: Reason.optional(),
  })
  .refine((b) => b.section_id || b.class_id, {
    message: 'Send section_id or class_id',
    path: ['section_id'],
  });
export const ReasonBody = z.object({ reason: Reason, version: Version.optional() });

const DemandSelection = {
  /** Only these components (default: every component of the structure). */
  component_ids: z.array(z.uuid()).min(1).max(100).optional(),
  /** Only these periods, e.g. "2026-04", "2026-Q1", "ANNUAL" (default: every period of the year). */
  period_keys: z.array(z.string().trim().min(1).max(16)).min(1).max(60).optional(),
  /** true: demands are ISSUED immediately; false (default): they are created as DRAFT. */
  issue: z.boolean().default(false),
};
export const GenerateDemandsBody = z.object(DemandSelection);
export const BulkGenerateBody = z
  .object({
    assignment_ids: z.array(z.uuid()).min(1).max(500).optional(),
    fee_structure_id: z.uuid().optional(),
    section_id: z.uuid().optional(),
    class_id: z.uuid().optional(),
    ...DemandSelection,
  })
  .refine((b) => b.assignment_ids || b.fee_structure_id || b.section_id || b.class_id, {
    message: 'Send assignment_ids, fee_structure_id, section_id or class_id',
    path: ['assignment_ids'],
  });

// ---- Demands ----------------------------------------------------------------------------------------
export const DemandListQuery = PaginationQuery.extend({
  student_id: z.uuid().optional(),
  assignment_id: z.uuid().optional(),
  academic_year_id: z.uuid().optional(),
  class_id: z.uuid().optional(),
  section_id: z.uuid().optional(),
  fee_category_id: z.uuid().optional(),
  fee_component_id: z.uuid().optional(),
  /** Effective status: ISSUED / PARTIALLY_PAID past their due date are OVERDUE. */
  status: z.enum(FEE_DEMAND_STATUS).optional(),
  due_from: IsoDate.optional(),
  due_to: IsoDate.optional(),
});
export const IssueDemandsBody = z.object({ demand_ids: z.array(z.uuid()).min(1).max(500) });
export const DiscountBody = z.object({
  value_type: z.enum(FEE_ADJUSTMENT_VALUE_TYPE),
  value: PositiveMoney,
  reason: Reason,
});
export const ApplyLateFeesBody = z.object({
  /** Default: every overdue demand of the school (up to 500 per call). */
  demand_ids: z.array(z.uuid()).min(1).max(500).optional(),
});

// ---- Adjustments (concessions and waivers) -------------------------------------------------------------
export const AdjustmentListQuery = PaginationQuery.extend({
  type: z.enum(FEE_ADJUSTMENT_TYPE).optional(),
  status: z.enum(FEE_ADJUSTMENT_STATUS).optional(),
  student_id: z.uuid().optional(),
  fee_demand_id: z.uuid().optional(),
});
export const CreateAdjustmentBody = z
  .object({
    type: z.enum(FEE_ADJUSTMENT_TYPE),
    fee_demand_id: z.uuid(),
    value_type: z.enum(FEE_ADJUSTMENT_VALUE_TYPE),
    /** An amount, or a percentage of the demand's original amount when value_type is PERCENT. */
    value: PositiveMoney,
    reason: Reason,
  })
  .refine((b) => b.value_type !== 'PERCENT' || toMinor(b.value) <= 10_000n, {
    message: 'A percentage cannot be more than 100',
    path: ['value'],
  });
export const DecisionBody = z.object({
  note: z.string().trim().max(500).optional(),
  version: Version.optional(),
});

// ---- Payments -------------------------------------------------------------------------------------------
export const AllocationRequest = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('AUTO'),
    /** Limit auto-allocation to these demands (default: all collectable demands of the student). */
    demand_ids: z.array(z.uuid()).min(1).max(200).optional(),
  }),
  z.object({
    mode: z.literal('MANUAL'),
    allocations: z
      .array(z.object({ fee_demand_id: z.uuid(), amount: PositiveMoney }))
      .min(1)
      .max(100)
      .refine((a) => new Set(a.map((x) => x.fee_demand_id)).size === a.length, {
        message: 'A demand can appear only once',
      }),
  }),
]);
export const PaymentListQuery = PaginationQuery.extend({
  student_id: z.uuid().optional(),
  status: z.enum(PAYMENT_STATUS).optional(),
  method: z.enum(PAYMENT_METHOD).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});
export const CreatePaymentBody = z.object({
  student_id: z.uuid(),
  amount: PositiveMoney,
  method: z.enum(RECORDABLE_PAYMENT_METHODS),
  /** RECEIVED (default): the money is in, a receipt is issued. PENDING: recorded, not yet confirmed (e.g. cheque). */
  status: z.enum(['PENDING', 'RECEIVED']).default('RECEIVED'),
  /** When the money was received (default now; not in the future). */
  received_at: z.iso.datetime().optional(),
  payer_type: z.enum(PAYER_TYPE).default('GUARDIAN'),
  payer_name: z.string().trim().min(1).max(150).nullable().optional(),
  payer_reference: z.string().trim().min(1).max(100).nullable().optional(),
  provider: z.string().trim().min(1).max(64).nullable().optional(),
  /** Cheque / transfer / slip reference. Unique per school. */
  provider_reference: z.string().trim().min(1).max(128).nullable().optional(),
  /** Retrying the same key returns the same payment instead of recording it twice. */
  idempotency_key: z.string().trim().min(8).max(128).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  /** Allocate straight away (only for status RECEIVED). */
  allocation: AllocationRequest.optional(),
});
export const AllocateBody = AllocationRequest;
export const VerifyPaymentBody = z.object({
  note: z.string().trim().max(500).optional(),
  version: Version.optional(),
});

export const ReceiptListQuery = PaginationQuery.extend({
  student_id: z.uuid().optional(),
  status: z.enum(RECEIPT_STATUS).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});

// ---- Refunds --------------------------------------------------------------------------------------------
export const RefundListQuery = PaginationQuery.extend({
  status: z.enum(REFUND_STATUS).optional(),
  student_id: z.uuid().optional(),
  payment_id: z.uuid().optional(),
});
export const CreateRefundBody = z.object({
  payment_id: z.uuid(),
  amount: PositiveMoney,
  reason: Reason,
});
export const CompleteRefundBody = z.object({
  provider_reference: z.string().trim().min(1).max(128).optional(),
});

// ---- Reports ------------------------------------------------------------------------------------------
const Scope = {
  academic_year_id: z.uuid().optional(),
  class_id: z.uuid().optional(),
  section_id: z.uuid().optional(),
};
export const LedgerQuery = z.object({ academic_year_id: z.uuid().optional() });
export const OutstandingQuery = PaginationQuery.extend({
  ...Scope,
  fee_category_id: z.uuid().optional(),
});
export const OverdueQuery = PaginationQuery.extend({
  ...Scope,
  fee_category_id: z.uuid().optional(),
  min_days_overdue: z.coerce.number().int().min(1).max(3650).optional(),
});
const DateRange = {
  from: IsoDate,
  to: IsoDate,
};
const rangeOk = (b: { from: string; to: string }) =>
  b.from <= b.to && Date.parse(b.to) - Date.parse(b.from) <= 366 * 86_400_000;
const rangeIssue = {
  message: 'from must not be after to, and the range is at most 366 days',
  path: ['to'],
};
export const CollectionQuery = z
  .object({ ...DateRange, method: z.enum(PAYMENT_METHOD).optional() })
  .refine(rangeOk, rangeIssue);
export const ConcessionReportQuery = PaginationQuery.extend({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  type: z.enum(FEE_ADJUSTMENT_TYPE).optional(),
  status: z.enum(FEE_ADJUSTMENT_STATUS).optional(),
});
export const RefundReportQuery = PaginationQuery.extend({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  status: z.enum(REFUND_STATUS).optional(),
});
export const DashboardQuery = z.object({ academic_year_id: z.uuid().optional() });

/** Query accepted by every CSV export: the union of the report filters (unused ones are ignored). */
export const ExportQuery = z.object({
  academic_year_id: z.uuid().optional(),
  class_id: z.uuid().optional(),
  section_id: z.uuid().optional(),
  fee_category_id: z.uuid().optional(),
  student_id: z.uuid().optional(),
  status: z.string().max(32).optional(),
  type: z.string().max(32).optional(),
  method: z.enum(PAYMENT_METHOD).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  due_from: IsoDate.optional(),
  due_to: IsoDate.optional(),
  min_days_overdue: z.coerce.number().int().min(1).max(3650).optional(),
});
