import { z } from 'zod';
import { CALENDAR_AUDIENCE, EVENT_ACTION_LINK } from '../../db/schema/index.js';

const IsoDate = z.iso.date();
const Version = z.number().int().min(0);
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const Color = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'Use a colour like #F43F5E')
  .transform((c) => c.toUpperCase());

export const IdParams = z.object({ id: z.uuid() });

// ---- weekly off days ------------------------------------------------------------------------------

export const UpdateCalendarSettingsBody = z.object({
  /** ISO weekdays always off: 1 = Monday … 7 = Sunday. */
  weekly_off_days: z.array(z.number().int().min(1).max(7)).max(6),
  /** Saturdays of the month that are off (1–5), e.g. [2, 4]. */
  off_saturdays: z.array(z.number().int().min(1).max(5)).max(5).default([]),
  /** 0 when the school has never saved its calendar settings. */
  version: Version,
});

// ---- categories -----------------------------------------------------------------------------------

export const CreateCategoryBody = z.object({
  name: z.string().trim().min(2).max(60),
  color: Color,
  /** Entries in this category are days off: leave and attendance skip them. */
  closes_school: z.boolean().default(false),
});

export const UpdateCategoryBody = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  color: Color.optional(),
  closes_school: z.boolean().optional(),
  /** Switched-off categories keep their entries but can't be chosen for new ones. */
  is_active: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(10_000).optional(),
  version: Version,
});

// ---- calendar entries -----------------------------------------------------------------------------

/** Pre-categories API: EVENT / EXAM / MEETING map to the Activity / Exam / Meeting categories. */
const LegacyType = z.enum(['EVENT', 'EXAM', 'MEETING', 'HOLIDAY']);

export const EventListQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  category_id: z.uuid().optional(),
  /** Legacy filter by type (EVENT / EXAM / MEETING / HOLIDAY). */
  type: LegacyType.optional(),
  include_cancelled: z.stringbool().optional(),
});

/** Teacher app: holidays and events between two dates. */
export const HolidayListQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  include_cancelled: z.stringbool().optional(),
});

const eventFields = {
  category_id: z.uuid(),
  title: z.string().trim().min(2).max(120),
  start_date: IsoDate,
  /** Inclusive. Same as start_date for a one-day entry. */
  end_date: IsoDate,
  /** Optional; give both or neither. */
  start_time: Time.nullable().optional(),
  end_time: Time.nullable().optional(),
  /** ALL = everyone; STAFF = teachers and office; STUDENTS; CLASSES / SECTIONS = only those chosen. */
  audience: z.enum(CALENDAR_AUDIENCE),
  class_ids: z.array(z.uuid()).max(100).optional(),
  section_ids: z.array(z.uuid()).max(300).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  /** "Action for you" line in the teacher app. */
  staff_action: z.string().trim().max(200).nullable().optional(),
  /** LEAVE stays in the column for old rows, but leave is gone (Teachers-only change). */
  action_link: z.enum(EVENT_ACTION_LINK).exclude(['LEAVE']).optional(),
};

export const CreateEventBody = z
  .object({
    ...eventFields,
    category_id: eventFields.category_id.optional(),
    /** Legacy: use category_id. */
    type: LegacyType.optional(),
    audience: eventFields.audience.default('ALL'),
  })
  .refine((b) => b.category_id || b.type, { message: 'Choose a category', path: ['category_id'] });

export const UpdateEventBody = z.object({
  category_id: eventFields.category_id.optional(),
  type: LegacyType.optional(),
  title: eventFields.title.optional(),
  start_date: IsoDate.optional(),
  end_date: IsoDate.optional(),
  start_time: eventFields.start_time,
  end_time: eventFields.end_time,
  audience: eventFields.audience.optional(),
  class_ids: eventFields.class_ids,
  section_ids: eventFields.section_ids,
  description: eventFields.description,
  staff_action: eventFields.staff_action,
  action_link: eventFields.action_link,
  version: Version,
});

export const CancelEventBody = z.object({
  reason: z.string().trim().min(3).max(500).optional(),
  version: Version,
});

/** for = staff (default), students, or a class (optionally a section): whose working days to count. */
export const WorkingDaysQuery = z
  .object({
    from: IsoDate,
    to: IsoDate,
    for: z.enum(['staff', 'students']).default('staff'),
    class_id: z.uuid().optional(),
    section_id: z.uuid().optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 400, {
    message: 'The range cannot be longer than 400 days',
    path: ['to'],
  });
