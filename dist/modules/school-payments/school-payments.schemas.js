import { z } from 'zod';
import { BILLING_PAYMENT_METHOD } from '../../db/schema/index.js';
/** Rupees in paise. Up to ₹1,00,00,000 per fee. */
const Money = z.number().int().min(0).max(10_000_000_00);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
/** Indian financial year, e.g. `2026-27` (1 Apr 2026 – 31 Mar 2027). */
export const Session = z
    .string()
    .regex(/^20\d{2}-\d{2}$/, 'Use a session like 2026-27')
    .refine((s) => (Number(s.slice(0, 4)) + 1) % 100 === Number(s.slice(5)), 'Not a valid session');
export const SettingsBody = z.object({ default_fee_minor: Money.min(100) });
/** A school's fee for one session and when it is to be paid. */
export const FeeBody = z.object({
    amount_minor: Money.min(100),
    discount_minor: Money.optional(),
    discount_reason: z.string().trim().max(300).optional(),
    /** Up to 12 instalments; they must add up to amount − discount. */
    instalments: z
        .array(z.object({ amount_minor: Money.min(1), due_on: IsoDate }))
        .min(1)
        .max(12),
});
export const SetUpFeeBody = FeeBody.extend({ session: Session });
/** Money received offline. */
export const PaymentBody = z.object({
    amount_minor: z.number().int().min(1).max(10_000_000_00),
    method: z.enum(BILLING_PAYMENT_METHOD),
    /** UPI transaction id, bank reference, cheque number … */
    reference: z.string().trim().max(100).optional(),
    /** Day the money was received (YYYY-MM-DD). Defaults to today. */
    received_on: z.coerce.date().optional(),
    notes: z.string().trim().max(500).optional(),
});
export const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) });
export const SessionQuery = z.object({ session: Session.optional() });
export const LedgerQuery = z.object({
    session: Session.optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export const TenantIdParams = z.object({ id: z.string().uuid() });
export const InvoiceIdParams = z.object({ invoice_id: z.string().uuid() });
export const PaymentIdParams = z.object({ payment_id: z.string().uuid() });
