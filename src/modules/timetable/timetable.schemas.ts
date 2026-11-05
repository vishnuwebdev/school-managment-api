import { z } from 'zod';
import { PERIOD_KIND, VENUE_STATUS, VENUE_TYPE } from '../../db/schema/index.js';
import { PaginationQuery } from '../../shared/pagination.js';

export const IdParams = z.object({ id: z.uuid() });
export const ViewSectionParams = z.object({ section_id: z.uuid() });
export const ViewClassParams = z.object({ class_id: z.uuid() });
export const ViewTeacherParams = z.object({ teacher_id: z.uuid() });
export const ViewVenueParams = z.object({ venue_id: z.uuid() });

const Version = z.number().int().positive();
const IsoDate = z.iso.date();
const Day = z.number().int().min(1).max(7);
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const Code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z0-9][A-Z0-9_.-]{0,31}$/,
    'Use letters, numbers and _ . - (max 32, start with a letter or number)',
  );

// ---- Settings (working days) ------------------------------------------------------
const SchoolDayTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
export const UpdateSettingsBody = z
  .object({
    version: Version,
    /** ISO weekdays: 1 = Monday … 7 = Sunday. */
    working_days: z
      .array(Day)
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, 'Days must be unique')
      .optional(),
    /** The school day window on the periods timeline. */
    school_day_start: SchoolDayTime.optional(),
    school_day_end: SchoolDayTime.optional(),
  })
  .refine(
    (b) => b.working_days || b.school_day_start || b.school_day_end,
    'Send working_days and/or the school day',
  )
  .refine(
    (b) => !b.school_day_start || !b.school_day_end || b.school_day_start < b.school_day_end,
    { message: 'The school day must end after it starts', path: ['school_day_end'] },
  );

// ---- Periods (each section's school day) -----------------------------------------
/** Whose school day: a section, a class without sections (+ year), or neither = the School default day. */
const OwnerFields = {
  section_id: z.uuid().optional(),
  class_id: z.uuid().optional(),
  /** For a class without sections; defaults to the current academic year. */
  academic_year_id: z.uuid().optional(),
};
export const OwnerQuery = z.object(OwnerFields);
/** The weekdays a period runs on (ISO 1–7); null or left out on create = every working day. */
const DaysOfWeek = z.array(z.number().int().min(1).max(7)).max(7).nullable();
const LessonFields = {
  /** Lesson periods of a section or class: what is taught (required for them). */
  subject_offering_id: z.uuid().optional(),
  /** Needed only when several teachers teach the subject there. */
  teacher_id: z.uuid().nullable().optional(),
  venue_id: z.uuid().nullable().optional(),
};
export const CreatePeriodBody = z
  .object({
    ...OwnerFields,
    /** Optional: when left out the server picks the next free code for the kind (P1, BRK2, …). */
    code: Code.optional(),
    name: z.string().trim().min(1).max(80),
    start_time: Time,
    end_time: Time,
    kind: z.enum(PERIOD_KIND).default('LESSON'),
    display_order: z.number().int().min(0).max(10_000).default(0),
    days_of_week: DaysOfWeek.optional(),
    ...LessonFields,
  })
  .refine((b) => b.start_time < b.end_time, {
    message: 'The end time must be after the start time',
    path: ['end_time'],
  });
export const UpdatePeriodBody = z.object({
  version: Version,
  name: z.string().trim().min(1).max(80).optional(),
  start_time: Time.optional(),
  end_time: Time.optional(),
  kind: z.enum(PERIOD_KIND).optional(),
  display_order: z.number().int().min(0).max(10_000).optional(),
  days_of_week: DaysOfWeek.optional(),
  ...LessonFields,
});
export const DayParams = z.object({ id: z.uuid(), day: z.coerce.number().int().min(1).max(7) });
/** A weekday exception: another lesson, or `subject_offering_id: null` = no lesson that day. */
export const SetDayBody = z.object({
  subject_offering_id: z.uuid().nullable(),
  teacher_id: z.uuid().optional(),
  venue_id: z.uuid().nullable().optional(),
  /** Optimistic check against the exception currently set for that day. */
  version: Version.optional(),
});
const OwnerRef = z.object(OwnerFields).refine((o) => !!o.section_id !== !!o.class_id, {
  message: 'Send section_id, or class_id for a class without sections',
  path: ['section_id'],
});
export const CopyPeriodsBody = z.object({
  /** The section / class receiving the periods (must have none yet). */
  to: OwnerRef,
  /** Copy from another section / class, or `{ template: true }` = the School default day. */
  from: z
    .object({ ...OwnerFields, template: z.boolean().optional() })
    .refine((o) => (o.template === true) !== (!!o.section_id || !!o.class_id), {
      message: 'Send template: true, or the section_id / class_id to copy from',
      path: ['template'],
    }),
});
export const CopyYearBody = z.object({
  from_academic_year_id: z.uuid(),
  to_academic_year_id: z.uuid(),
  /** Only this class (its sections, or the class itself). */
  class_id: z.uuid().optional(),
});
export const StatusQuery = z.object({ academic_year_id: z.uuid().optional() });

// ---- Venues ---------------------------------------------------------------------
export const VenueListQuery = PaginationQuery.extend({
  status: z.enum(VENUE_STATUS).optional(),
  venue_type: z.enum(VENUE_TYPE).optional(),
});
export const CreateVenueBody = z.object({
  code: Code,
  name: z.string().trim().min(1).max(100),
  venue_type: z.enum(VENUE_TYPE).default('CLASSROOM'),
  capacity: z.number().int().min(1).max(100_000).nullable().optional(),
});
export const UpdateVenueBody = z.object({
  version: Version,
  name: z.string().trim().min(1).max(100).optional(),
  venue_type: z.enum(VENUE_TYPE).optional(),
  capacity: z.number().int().min(1).max(100_000).nullable().optional(),
});

// ---- Views / reports ------------------------------------------------------------------
export const ViewQuery = z.object({
  /** Defaults to the current academic year. */
  academic_year_id: z.uuid().optional(),
});
export const DayViewQuery = z.object({
  /** Defaults to today in the school's time zone. */
  date: IsoDate.optional(),
  section_id: z.uuid().optional(),
  teacher_id: z.uuid().optional(),
  venue_id: z.uuid().optional(),
});
export const MyDayQuery = z.object({ date: IsoDate.optional() });
export const WorkloadQuery = ViewQuery;
export const ExportQuery = z.object({
  academic_year_id: z.uuid().optional(),
  section_id: z.uuid().optional(),
  teacher_id: z.uuid().optional(),
  venue_id: z.uuid().optional(),
});
