import { z } from 'zod';
import { BANK_ACCOUNT_TYPE } from '../../db/schema/index.js';

export const BrandingKind = z.enum(['logo', 'banner', 'document-header']);
export type BrandingKindValue = z.infer<typeof BrandingKind>;

export const BrandingUploadQuery = z.object({ filename: z.string().trim().max(255).optional() });

const text = (max: number) => z.string().trim().max(max).nullable().optional();

const accountNumber = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^[0-9]{6,20}$/, 'Account number must be 6–20 digits'));

const ifsc = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC must look like HDFC0001234');

const upi = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9]{2,32}$/, 'UPI ID must look like school@bank')
  .nullable()
  .optional();

export const CreateBankAccountBody = z.object({
  label: text(100),
  account_holder: z.string().trim().min(2).max(200),
  bank_name: z.string().trim().min(2).max(200),
  branch_name: text(200),
  account_number: accountNumber,
  ifsc,
  account_type: z.enum(BANK_ACCOUNT_TYPE).default('CURRENT'),
  upi_id: upi,
  is_default: z.boolean().default(false),
});

export const UpdateBankAccountBody = z.object({
  version: z.number().int().positive(),
  label: text(100),
  account_holder: z.string().trim().min(2).max(200).optional(),
  bank_name: z.string().trim().min(2).max(200).optional(),
  branch_name: text(200),
  /** Send only to replace the stored number. */
  account_number: accountNumber.optional(),
  ifsc: ifsc.optional(),
  account_type: z.enum(BANK_ACCOUNT_TYPE).optional(),
  upi_id: upi,
});

export const BankAccountParams = z.object({ id: z.string().uuid() });
export const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) });

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .nullable()
  .optional();

export const RegistrationParams = z.object({
  type: z.string().trim().toUpperCase().min(2).max(32),
});
export const RegistrationBody = z.object({
  value: z.string().trim().min(1).max(200),
  issued_on: isoDate,
  valid_until: isoDate,
  authority: text(200),
});
