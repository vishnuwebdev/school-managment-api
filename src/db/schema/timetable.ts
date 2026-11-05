import {
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  smallint,
  time,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, id, ref, updatedAt, version } from './_columns.js';
import { academicClasses, academicSections, academicYears, subjectOfferings } from './academic.js';
import { OVERRIDE_KIND, PERIOD_KIND, PERIOD_STATUS, VENUE_STATUS, VENUE_TYPE } from './enums.js';
import { teachers, teachingAssignments } from './teachers.js';
import { tenants } from './tenancy.js';

/**
 * Timetable: ONE live timetable, no versions. Each section (or class without
 * sections) has its own periods; a lesson period carries its subject offering
 * and teacher, so the week is periods × working days, with optional per-weekday
 * overrides. References to academic structure, teachers and assignments use
 * composite foreign keys `(tenant_id, x_id)`, so cross-school links are refused.
 * Teacher / venue clashes (overlapping times on a weekday) are enforced by the
 * service, serialised on the school's settings row.
 */

/** One row per school, created lazily: the teaching days of the week (ISO: 1 = Monday … 7 = Sunday). */
export const timetableSettings = mysqlTable('timetable_settings', {
  tenantId: ref('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  workingDays: json('working_days').$type<number[]>().notNull(),
  /** The school day shown on the periods timeline (optional). */
  dayStart: time('day_start'),
  dayEnd: time('day_end'),
  version: version(),
  updatedBy: ref('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** A schedulable location (classroom, lab, hall). V1 keeps rooms inside Timetable (Part 37 §37.43). */
export const timetableVenues = mysqlTable(
  'timetable_venues',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    venueType: mysqlEnum('venue_type', VENUE_TYPE).notNull().default('CLASSROOM'),
    /** NULL = unknown. Compared with the section roster as a warning, never a hard rule. */
    capacity: int('capacity'),
    status: mysqlEnum('status', VENUE_STATUS).notNull().default('ACTIVE'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('timetable_venues_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('timetable_venues_tenant_code_uq').on(t.tenantId, t.code),
    index('timetable_venues_tenant_status_idx').on(t.tenantId, t.status, t.name),
  ],
);

/** A slot of a section's (or class's) school day: Period 1 08:30–09:15 Hindi · Mrs Rao, Break, Lunch … */
export const timetablePeriods = mysqlTable(
  'timetable_periods',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Stable identifier, unique per school (upper-case). */
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 80 }).notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    kind: mysqlEnum('kind', PERIOD_KIND).notNull().default('LESSON'),
    /** Tie-break for display; the day is ordered by start time first. */
    displayOrder: int('display_order').notNull().default(0),
    /**
     * Whose day the period belongs to: a section (class set too), a class without
     * sections (section NULL), or neither = the School default day (a template that
     * sections copy times from; it takes no lessons).
     */
    academicClassId: ref('academic_class_id'),
    academicSectionId: ref('academic_section_id'),
    /** The year of the section / class day. NULL only for the School default day (a template). */
    academicYearId: ref('academic_year_id'),
    /** Lesson periods of a section or class: what is taught, by whom, where (every working day). */
    subjectOfferingId: ref('subject_offering_id'),
    teachingAssignmentId: ref('teaching_assignment_id'),
    teacherId: ref('teacher_id'),
    venueId: ref('venue_id'),
    /**
     * The weekdays (ISO 1–7) the period runs on; NULL = every working day. Lets one
     * day (e.g. Friday) have its own times: its periods carry `[5]`, the others `[1,2,3,4]`.
     */
    daysOfWeek: json('days_of_week').$type<number[] | null>(),
    status: mysqlEnum('status', PERIOD_STATUS).notNull().default('ACTIVE'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('timetable_periods_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('timetable_periods_tenant_code_uq').on(t.tenantId, t.code),
    index('timetable_periods_tenant_status_idx').on(t.tenantId, t.status, t.startTime),
    index('timetable_periods_scope_idx').on(t.tenantId, t.academicClassId, t.academicSectionId),
    index('timetable_periods_year_idx').on(t.tenantId, t.academicYearId),
    index('timetable_periods_teacher_idx').on(t.tenantId, t.teacherId),
    foreignKey({
      name: 'timetable_periods_class_fk',
      columns: [t.tenantId, t.academicClassId],
      foreignColumns: [academicClasses.tenantId, academicClasses.id],
    }),
    foreignKey({
      name: 'timetable_periods_section_fk',
      columns: [t.tenantId, t.academicSectionId],
      foreignColumns: [academicSections.tenantId, academicSections.id],
    }),
    foreignKey({
      name: 'timetable_periods_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }),
    foreignKey({
      name: 'timetable_periods_offering_fk',
      columns: [t.tenantId, t.subjectOfferingId],
      foreignColumns: [subjectOfferings.tenantId, subjectOfferings.id],
    }),
    foreignKey({
      name: 'timetable_periods_assignment_fk',
      columns: [t.tenantId, t.teachingAssignmentId],
      foreignColumns: [teachingAssignments.tenantId, teachingAssignments.id],
    }),
    foreignKey({
      name: 'timetable_periods_teacher_fk',
      columns: [t.tenantId, t.teacherId],
      foreignColumns: [teachers.tenantId, teachers.id],
    }),
    foreignKey({
      name: 'timetable_periods_venue_fk',
      columns: [t.tenantId, t.venueId],
      foreignColumns: [timetableVenues.tenantId, timetableVenues.id],
    }),
  ],
);

/**
 * A weekday exception of one lesson period: on that weekday the period has a
 * different subject / teacher / venue (LESSON), or no lesson at all (FREE).
 * Example: Period 1 is Hindi, but every Friday it is Sports.
 */
export const timetableDayOverrides = mysqlTable(
  'timetable_day_overrides',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    periodId: ref('period_id').notNull(),
    /** ISO weekday: 1 = Monday … 7 = Sunday. */
    dayOfWeek: smallint('day_of_week').notNull(),
    kind: mysqlEnum('kind', OVERRIDE_KIND).notNull().default('LESSON'),
    subjectOfferingId: ref('subject_offering_id'),
    teachingAssignmentId: ref('teaching_assignment_id'),
    teacherId: ref('teacher_id'),
    venueId: ref('venue_id'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('timetable_day_overrides_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('timetable_day_overrides_slot_uq').on(t.periodId, t.dayOfWeek),
    index('timetable_day_overrides_teacher_idx').on(t.tenantId, t.teacherId),
    foreignKey({
      name: 'timetable_day_overrides_period_fk',
      columns: [t.tenantId, t.periodId],
      foreignColumns: [timetablePeriods.tenantId, timetablePeriods.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'timetable_day_overrides_offering_fk',
      columns: [t.tenantId, t.subjectOfferingId],
      foreignColumns: [subjectOfferings.tenantId, subjectOfferings.id],
    }),
    foreignKey({
      name: 'timetable_day_overrides_assignment_fk',
      columns: [t.tenantId, t.teachingAssignmentId],
      foreignColumns: [teachingAssignments.tenantId, teachingAssignments.id],
    }),
    foreignKey({
      name: 'timetable_day_overrides_teacher_fk',
      columns: [t.tenantId, t.teacherId],
      foreignColumns: [teachers.tenantId, teachers.id],
    }),
    foreignKey({
      name: 'timetable_day_overrides_venue_fk',
      columns: [t.tenantId, t.venueId],
      foreignColumns: [timetableVenues.tenantId, timetableVenues.id],
    }),
  ],
);
