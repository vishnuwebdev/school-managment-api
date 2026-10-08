import { z } from 'zod';
import { BILLING_PAYMENT_METHOD } from '../../db/schema/index.js';

const Reason = z.string().trim().min(3).max(500);
const Money = z.number().int().min(0).max(1_000_000_000_000);

/** A payment received outside the platform (cash, bank transfer, cheque …). */
export const PaymentBody = z.object({
  amount_minor: z.number().int().min(1).max(1_000_000_000_000),
  method: z.enum(BILLING_PAYMENT_METHOD),
  /** Bank reference, cheque number, receipt book number … */
  reference: z.string().trim().max(100).optional(),
  /** Day the money was received. Defaults to today. */
  received_on: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional(),
});
export type PaymentInput = z.infer<typeof PaymentBody>;

export const CreateInvoiceBody = z.object({
  description: z.string().trim().min(3).max(300),
  amount_minor: Money.min(1),
  discount_minor: Money.optional(),
  due_on: z.coerce.date().optional(),
  subscription_id: z.string().uuid().optional(),
  /** Record a payment received at the same time. */
  payment: PaymentBody.optional(),
});

export const VoidBody = z.object({ reason: Reason });
export const InvoiceIdParams = z.object({ invoice_id: z.string().uuid() });
export const PaymentIdParams = z.object({ payment_id: z.string().uuid() });
export const TenantIdParams = z.object({ id: z.string().uuid() });
