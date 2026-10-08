import { z } from 'zod';
import { HOLIDAY_AUDIENCE } from '../../db/schema/index.js';

const IsoDate = z.iso.date();
const Version = z.number().int().min(0);

export const HolidayParams = z.object({ id: z.uuid() });

export const UpdateCalendarSettingsBody = z.object({
  /** ISO weekdays always off: 1 = Monday … 7 = Sunday. */
  weekly_off_days: z.array(z.number().int().min(1).max(7)).max(6),
  /** Saturdays of the month that are off (1–5), e.g. [2, 4]. */
  off_saturdays: z.array(z.number().int().min(1).max(5)).max(5).default([]),
  /** 0 when the school has never saved its calendar settings. */
  version: Version,
});

export const HolidayListQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  include_cancelled: z.stringbool().optional(),
});

export const CreateHolidayBody = z.object({
  name: z.string().trim().min(2).max(120),
  start_date: IsoDate,
  /** Inclusive. Same as start_date for a one-day holiday. */
  end_date: IsoDate,
  /** ALL = everyone off; STUDENTS = staff still work; CLASSES = only class_ids are off. */
  audience: z.enum(HOLIDAY_AUDIENCE).default('ALL'),
  class_ids: z.array(z.uuid()).max(100).optional(),
  description: z.string().trim().max(500).optional(),
});

export const UpdateHolidayBody = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  start_date: IsoDate.optional(),
  end_date: IsoDate.optional(),
  audience: z.enum(HOLIDAY_AUDIENCE).optional(),
  class_ids: z.array(z.uuid()).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  version: Version,
});

export const CancelHolidayBody = z.object({
  reason: z.string().trim().min(3).max(500).optional(),
  version: Version,
});

/** for = staff (default), students, or a class id: whose working days to count. */
export const WorkingDaysQuery = z
  .object({
    from: IsoDate,
    to: IsoDate,
    for: z.enum(['staff', 'students']).default('staff'),
    class_id: z.uuid().optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 400, {
    message: 'The range cannot be longer than 400 days',
    path: ['to'],
  });
