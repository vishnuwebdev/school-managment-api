import { z } from 'zod';
import {
  PERIOD_KIND,
  PERIOD_STATUS,
  TIMETABLE_STATUS,
  VENUE_STATUS,
  VENUE_TYPE,
} from '../../db/schema/index.js';
import { PaginationQuery } from '../../shared/pagination.js';

export const IdParams = z.object({ id: z.uuid() });
export const SectionParams = z.object({ id: z.uuid(), section_id: z.uuid() });
export const ViewSectionParams = z.object({ section_id: z.uuid() });
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
const Reason = z.string().trim().min(3).max(500);

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

// ---- Periods -------------------------------------------------------------------
export const PeriodListQuery = z.object({
  status: z.enum(PERIOD_STATUS).optional(),
  kind: z.enum(PERIOD_KIND).optional(),
  /** Whose periods: a section (its own, else its class's, else the school's), a class, or neither = the whole school. */
  class_id: z.uuid().optional(),
  section_id: z.uuid().optional(),
});
export const CreatePeriodBody = z
  .object({
    /** Optional: when left out the server picks the next free code for the kind (P1, BRK2, …). */
    code: Code.optional(),
    name: z.string().trim().min(1).max(80),
    start_time: Time,
    end_time: Time,
    kind: z.enum(PERIOD_KIND).default('LESSON'),
    display_order: z.number().int().min(0).max(10_000).default(0),
    /** Who the period is for. Neither = the whole school; a section implies its class. */
    class_id: z.uuid().optional(),
    section_id: z.uuid().optional(),
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
});

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

// ---- Timetables -------------------------------------------------------------------
export const TimetableListQuery = PaginationQuery.extend({
  academic_year_id: z.uuid().optional(),
  status: z.enum(TIMETABLE_STATUS).optional(),
});
const dateOrder = (b: { effective_from?: string | null; effective_to?: string | null }) =>
  !b.effective_from || !b.effective_to || b.effective_from <= b.effective_to;
const dateOrderIssue = {
  message: 'effective_to cannot be before effective_from',
  path: ['effective_to'],
};
export const CreateTimetableBody = z
  .object({
    academic_year_id: z.uuid(),
    name: z.string().trim().min(1).max(120),
    effective_from: IsoDate.nullable().optional(),
    effective_to: IsoDate.nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    /** Start from a copy of this version's entries (same academic year). */
    copy_from_id: z.uuid().optional(),
  })
  .refine(dateOrder, dateOrderIssue);
export const DuplicateTimetableBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});
export const UpdateTimetableBody = z
  .object({
    version: Version,
    name: z.string().trim().min(1).max(120).optional(),
    effective_from: IsoDate.nullable().optional(),
    effective_to: IsoDate.nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine(dateOrder, dateOrderIssue);
export const PublishBody = z.object({
  /** Optional optimistic check: the timetable version you read. */
  version: Version.optional(),
  /** Defaults to the draft's own date, else today (school time zone). */
  effective_from: IsoDate.optional(),
  /** true: unscheduled sections and empty lesson slots block publishing instead of warning. */
  strict: z.boolean().default(false),
});
export const ArchiveBody = z.object({
  version: Version.optional(),
  reason: Reason.optional(),
});

// ---- Entries -----------------------------------------------------------------------
const EntryTarget = {
  /** Either the assignment itself, or the offering (+ optional teacher) it is resolved from. */
  subject_offering_id: z.uuid().optional(),
  teacher_id: z.uuid().optional(),
  teaching_assignment_id: z.uuid().optional(),
};
export const CreateEntryBody = z
  .object({
    day_of_week: Day,
    period_id: z.uuid(),
    section_id: z.uuid(),
    venue_id: z.uuid().nullable().optional(),
    ...EntryTarget,
  })
  .refine((b) => b.subject_offering_id || b.teaching_assignment_id, {
    message: 'Send subject_offering_id (and optionally teacher_id) or teaching_assignment_id',
    path: ['subject_offering_id'],
  });
export const UpdateEntryBody = z.object({
  version: Version,
  day_of_week: Day.optional(),
  period_id: z.uuid().optional(),
  venue_id: z.uuid().nullable().optional(),
  ...EntryTarget,
});
export const DeleteEntryQuery = z.object({
  version: z.coerce.number().int().positive().optional(),
});
export const EntryListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(500).default(100),
  section_id: z.uuid().optional(),
  class_id: z.uuid().optional(),
  teacher_id: z.uuid().optional(),
  venue_id: z.uuid().optional(),
  period_id: z.uuid().optional(),
  day_of_week: z.coerce.number().int().min(1).max(7).optional(),
});

const GridCell = z
  .object({
    day_of_week: Day,
    period_id: z.uuid(),
    /** null clears the cell. */
    subject_offering_id: z.uuid().nullable(),
    teacher_id: z.uuid().optional(),
    teaching_assignment_id: z.uuid().optional(),
    venue_id: z.uuid().nullable().optional(),
    /** Optimistic check against the entry currently in this cell. */
    version: Version.optional(),
  })
  .refine((c) => c.subject_offering_id !== null || (!c.teacher_id && !c.teaching_assignment_id), {
    message: 'A cleared cell cannot carry a teacher or assignment',
    path: ['teacher_id'],
  });
export const SaveGridBody = z
  .object({
    cells: z.array(GridCell).max(500),
    /** true: entries of this section that are not listed are removed (the grid is the whole truth). */
    replace: z.boolean().default(false),
  })
  .superRefine((b, ctx) => {
    const seen = new Set<string>();
    b.cells.forEach((c, i) => {
      const k = `${c.day_of_week}:${c.period_id}`;
      if (seen.has(k))
        ctx.addIssue({
          code: 'custom',
          path: ['cells', i, 'period_id'],
          message: 'Duplicate cell (same day and period) in the request',
        });
      seen.add(k);
    });
    if (b.cells.length === 0 && !b.replace)
      ctx.addIssue({ code: 'custom', path: ['cells'], message: 'Send at least one cell' });
  });

// ---- Views / reports ------------------------------------------------------------------
export const ViewQuery = z.object({
  /** Any timetable of the school you may read. Defaults to the published one of the year. */
  timetable_id: z.uuid().optional(),
  /** Defaults to the active academic year. Ignored when timetable_id is sent. */
  academic_year_id: z.uuid().optional(),
});
export const DayViewQuery = z.object({
  /** Defaults to today in the school's time zone. Uses the version that was effective on that date. */
  date: IsoDate.optional(),
  section_id: z.uuid().optional(),
  teacher_id: z.uuid().optional(),
  venue_id: z.uuid().optional(),
});
export const MyDayQuery = z.object({ date: IsoDate.optional() });
export const WorkloadQuery = ViewQuery;
export const ExportQuery = z.object({
  section_id: z.uuid().optional(),
  teacher_id: z.uuid().optional(),
  venue_id: z.uuid().optional(),
});
export const CheckQuery = z.object({
  /** true: also treat unscheduled sections and empty lesson slots as blocking (what publish uses in strict mode). */
  strict: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
