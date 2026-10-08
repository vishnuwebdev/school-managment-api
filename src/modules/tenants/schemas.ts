import { z } from 'zod';
import { PaymentBody } from '../billing/billing.schemas.js';
import { BILLING_INTERVAL } from '../../db/schema/index.js';

const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

export const TenantProfileFields = {
  name: z.string().trim().min(2).max(200),
  short_name: nullableText(64),
  school_type: nullableText(64),
  contact_email: z.email().max(254).nullable().optional(),
  contact_phone: nullableText(32),
  address: z
    .object({
      line1: nullableText(200),
      line2: nullableText(200),
      city: nullableText(100),
      state: nullableText(100),
      postal_code: nullableText(20),
      country: z.string().length(2).toUpperCase().nullable().optional(),
    })
    .optional(),
};

export const CreateTenantBody = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/, 'Use 3–64 lowercase letters, numbers and hyphens'),
  ...TenantProfileFields,
});

const phone = z
  .string()
  .trim()
  .regex(/^[+0-9()\-\s]{5,32}$/, 'Enter a valid phone number')
  .nullable()
  .optional();

/** Extra identity and contact details (§12.1, §12.2). Empty strings clear a field. */
export const ProfileExtrasBody = z.object({
  affiliation_board: nullableText(64),
  affiliation_number: nullableText(64),
  school_code: nullableText(64),
  established_year: z.number().int().min(1700).max(2100).nullable().optional(),
  medium_of_instruction: nullableText(100),
  motto: nullableText(200),
  about: nullableText(4000),
  secondary_phone: phone,
  landline: phone,
  reception_phone: phone,
  alternate_email: z.email().max(254).nullable().optional(),
  contact_person_name: nullableText(200),
  contact_person_role: nullableText(100),
  document_footer: nullableText(500),
});

export const UpdateTenantBody = z.object({
  version: z.number().int().positive(),
  ...TenantProfileFields,
  name: TenantProfileFields.name.optional(),
  profile: ProfileExtrasBody.optional(),
});

const hexColor = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'Use a colour like #1A73E8')
  .nullable()
  .optional();

export const SettingsBody = z.object({
  version: z.number().int().positive(),
  timezone: z
    .string()
    .min(1)
    .max(64)
    .refine(
      (tz) => Intl.supportedValuesOf('timeZone').includes(tz) || tz === 'UTC',
      'Unknown time zone',
    )
    .optional(),
  locale: z.string().min(2).max(16).optional(),
  currency: z.string().length(3).toUpperCase().optional(),
  date_format: z.enum(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY']).optional(),
  week_starts_on: z.number().int().min(0).max(6).optional(),
  working_days: z
    .array(z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']))
    .min(1)
    .max(7)
    .optional(),
  academic_year_start_month: z.number().int().min(1).max(12).optional(),
  brand_primary_color: hexColor,
  brand_secondary_color: hexColor,
  brand_accent_color: hexColor,
});

export const ProvisionBody = z.object({
  plan_code: z.string().min(1).max(64),
  billing_interval: z.enum(BILLING_INTERVAL).default('ANNUAL'),
  /** 0 = start a paid subscription immediately. */
  trial_days: z.number().int().min(0).max(90).default(14),
  admin: z.object({
    email: z.email().max(254),
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().max(100).optional(),
  }),
  settings: SettingsBody.omit({ version: true }).optional(),
  /** Price reduction agreed with the school, in minor units (paid subscriptions only). */
  discount_minor: z.number().int().min(0).optional(),
  /** A payment already received offline for this subscription (paid subscriptions only). */
  payment: PaymentBody.optional(),
});

export const ChangeSubscriptionBody = z.object({
  plan_code: z.string().min(1).max(64),
  status: z.enum(['TRIAL', 'ACTIVE']).default('ACTIVE'),
  billing_interval: z.enum(BILLING_INTERVAL).default('ANNUAL'),
  /** Custom period end (e.g. negotiated contracts). Defaults from the interval. */
  current_period_end: z.coerce.date().optional(),
  trial_days: z.number().int().min(1).max(90).optional(),
  auto_renew: z.boolean().default(true),
  /** Required when the change removes features the school currently has. */
  confirm: z.boolean().optional(),
  reason: z.string().trim().min(3).max(500),
  discount_minor: z.number().int().min(0).optional(),
  payment: PaymentBody.optional(),
});

export const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) });
