import { z } from "zod";
import { PAYMENT_PLAN } from "../../db/schema/index.js";
import { Money, PositiveMoney } from "./fees.schemas.js";

const MonthDay = z
  .string()
  .regex(
    /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
    "Use 'MM-DD', e.g. '01-31'",
  );

export const YearQuery = z.object({ academic_year_id: z.uuid().optional() });

export const GradeFeesBody = z.object({
  academic_year_id: z.uuid().optional(),
  fees: z
    .array(z.object({ class_id: z.uuid(), annual_fee: PositiveMoney }))
    .min(1)
    .max(60)
    .refine((f) => new Set(f.map((x) => x.class_id)).size === f.length, {
      message: "A class can appear only once",
    }),
  /** Re-split what learners already billed still owe, at the new fee (default true). */
  update_existing: z.boolean().default(true),
});

export const PlanSettingsBody = z.object({
  monthly_instalments: z.number().int().min(1).max(12).optional(),
  monthly_due_day: z.number().int().min(1).max(28).optional(),
  term_due_dates: z.array(MonthDay).min(1).max(6).nullable().optional(),
  annual_discount_percent: Money.refine(
    (v) => Number(v) <= 100,
    "At most 100",
  ).optional(),
  annual_pay_by: MonthDay.nullable().optional(),
  default_payment_plan: z.enum(PAYMENT_PLAN).optional(),
});

export const ChangePlanBody = z.object({
  plan: z.enum(PAYMENT_PLAN),
  academic_year_id: z.uuid().optional(),
});

export const AddChargeBody = z.object({
  name: z.string().trim().min(2).max(120),
  amount: PositiveMoney,
  due_date: z.iso.date().optional(),
  academic_year_id: z.uuid().optional(),
});

export const TRACKER_STATUS = ["OVERDUE", "PART_PAID", "UP_TO_DATE"] as const;
export const TrackerQuery = z.object({
  academic_year_id: z.uuid().optional(),
  class_id: z.uuid().optional(),
  section_id: z.uuid().optional(),
  status: z.enum(TRACKER_STATUS).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});
