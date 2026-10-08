import { z } from 'zod';
import { BANK_LINE_STATUS, PAYMENT_METHOD, REMINDER_STAGE } from '../../db/schema/index.js';
import { PaginationQuery } from '../../shared/pagination.js';

const Reason = z.string().trim().min(3).max(500);
const IsoDate = z.iso.date();

// ---- Bank reconciliation ---------------------------------------------------------------------------
export const StatementUploadQuery = z.object({ filename: z.string().trim().max(255).optional() });
export const BankLineListQuery = PaginationQuery.extend({
  status: z.enum(BANK_LINE_STATUS).optional(),
  statement_id: z.uuid().optional(),
});
export const UnconfirmedPaymentsQuery = PaginationQuery.extend({
  method: z.enum(PAYMENT_METHOD).optional(),
});
export const ConfirmLineBody = z.object({ payment_id: z.uuid() });
export const RecordLineBody = z.object({
  student_id: z.uuid(),
  payer_name: z.string().trim().min(1).max(150).optional(),
  notes: z.string().trim().max(500).optional(),
});
export const IgnoreLineBody = z.object({ reason: Reason });
export const LineParams = z.object({ id: z.uuid() });

// ---- Arrears, reminders and payment plans -----------------------------------------------------------
export const ArrearsQuery = PaginationQuery.extend({
  class_id: z.uuid().optional(),
  section_id: z.uuid().optional(),
  min_days_overdue: z.coerce.number().int().min(1).max(3650).optional(),
  /** DUE_FIRST, DUE_SECOND, LETTER, HANDOVER, PLAN, NONE */
  step: z.enum(['DUE_FIRST', 'DUE_SECOND', 'LETTER', 'HANDOVER', 'PLAN', 'NONE']).optional(),
});
export const RecordReminderBody = z.object({
  stage: z.enum(REMINDER_STAGE),
  note: z.string().trim().max(500).optional(),
});
export const RunRemindersBody = z.object({ dry_run: z.boolean().default(false) });

export const CreatePlanBody = z
  .object({
    student_id: z.uuid(),
    note: z.string().trim().max(500).optional(),
    /** A longer plan needs the finance committee; only holders of fees.arrears.escalate may exceed the limit. */
    exceeds_policy: z.boolean().default(false),
    instalments: z
      .array(
        z.object({
          due_date: IsoDate,
          amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Enter an amount such as 1500.00'),
        }),
      )
      .min(2)
      .max(24),
  })
  .refine((b) => new Set(b.instalments.map((i) => i.due_date)).size === b.instalments.length, {
    message: 'Two instalments cannot fall on the same day',
    path: ['instalments'],
  });
export const PlanListQuery = PaginationQuery.extend({
  status: z.enum(['ACTIVE', 'COMPLETED', 'BROKEN', 'CANCELLED']).optional(),
  student_id: z.uuid().optional(),
});
export const PlanParams = z.object({ id: z.uuid() });
export const CancelPlanBody = z.object({ reason: Reason });
