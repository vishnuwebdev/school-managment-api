import { sql } from 'drizzle-orm';
import {
  date,
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
import { createdAt, dt, id, ref, updatedAt, version } from './_columns.js';
import { academicSections, academicYears, subjectOfferings } from './academic.js';
import {
  PERIOD_KIND,
  PERIOD_STATUS,
  TIMETABLE_ENTRY_STATUS,
  TIMETABLE_STATUS,
  VENUE_STATUS,
  VENUE_TYPE,
} from './enums.js';
import { teachers, teachingAssignments } from './teachers.js';
import { tenants } from './tenancy.js';

/**
 * Timetable (Part 22 / Part 37). Timetable owns scheduling only: bell schedule,
 * venues, timetable versions and their entries. It REFERENCES academic
 * structure, teachers and teaching assignments through composite foreign keys
 * `(tenant_id, x_id)`, so the database refuses cross-school references. Clash
 * rules are enforced by the service AND by UNIQUE keys on generated columns
 * (partial unique indexes, expressed for MySQL).
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

/** A reusable slot of the school day (Period 1 08:30–09:15, Break, Lunch …). Not versioned. */
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
     * Who the period is for. Both null = the whole school (the default day).
     * A class (or one section of it) can have its own periods; the most specific
     * set that exists wins for a section: its own, else its class's, else the school's.
     */
    academicClassId: ref('academic_class_id'),
    academicSectionId: ref('academic_section_id'),
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
  ],
);

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

/**
 * A timetable version for one academic year. `version_no` numbers the schedule
 * versions of a year (1, 2, 3 …); `version` is the optimistic-concurrency
 * counter every editable row carries.
 */
export const timetables = mysqlTable(
  'timetables',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    academicYearId: ref('academic_year_id').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    status: mysqlEnum('status', TIMETABLE_STATUS).notNull().default('DRAFT'),
    versionNo: int('version_no').notNull(),
    effectiveFrom: date('effective_from', { mode: 'string' }),
    effectiveTo: date('effective_to', { mode: 'string' }),
    notes: varchar('notes', { length: 500 }),
    /** The version this one was duplicated from (history of how the schedule evolved). */
    copiedFromId: ref('copied_from_id'),
    /** Set on the version that was replaced when another one was published. */
    supersededById: ref('superseded_by_id'),
    /**
     * Generated: the academic year while PUBLISHED, NULL otherwise. UNIQUE on it =
     * at most one published timetable per year, history unrestricted.
     */
    publishedKey: varchar('published_key', { length: 36 }).generatedAlwaysAs(
      sql`(IF(\`status\` = 'PUBLISHED', \`academic_year_id\`, NULL))`,
      { mode: 'virtual' },
    ),
    publishedAt: dt('published_at'),
    publishedBy: ref('published_by'),
    archivedAt: dt('archived_at'),
    archivedBy: ref('archived_by'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('timetables_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('timetables_tenant_id_year_uq').on(t.tenantId, t.id, t.academicYearId),
    uniqueIndex('timetables_version_no_uq').on(t.tenantId, t.academicYearId, t.versionNo),
    uniqueIndex('timetables_published_uq').on(t.publishedKey),
    index('timetables_year_status_idx').on(t.tenantId, t.academicYearId, t.status),
    foreignKey({
      name: 'timetables_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }),
    foreignKey({
      name: 'timetables_copied_from_fk',
      columns: [t.tenantId, t.copiedFromId],
      foreignColumns: [t.tenantId, t.id],
    }),
    foreignKey({
      name: 'timetables_superseded_by_fk',
      columns: [t.tenantId, t.supersededById],
      foreignColumns: [t.tenantId, t.id],
    }),
  ],
);

/**
 * One scheduled lesson: a section has a subject offering, taught by a teacher
 * (through an existing teaching assignment), in a period of a weekday,
 * optionally in a venue. The teacher is copied from the assignment so the
 * database can forbid double-booking; the service keeps the two in step.
 */
export const timetableEntries = mysqlTable(
  'timetable_entries',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    timetableId: ref('timetable_id').notNull(),
    /** Copied from the timetable so composite keys can pin section and offering to the same year. */
    academicYearId: ref('academic_year_id').notNull(),
    /** ISO weekday: 1 = Monday … 7 = Sunday. */
    dayOfWeek: smallint('day_of_week').notNull(),
    periodId: ref('period_id').notNull(),
    sectionId: ref('section_id').notNull(),
    subjectOfferingId: ref('subject_offering_id').notNull(),
    teachingAssignmentId: ref('teaching_assignment_id').notNull(),
    teacherId: ref('teacher_id').notNull(),
    venueId: ref('venue_id'),
    status: mysqlEnum('status', TIMETABLE_ENTRY_STATUS).notNull().default('ACTIVE'),
    /** Generated occupancy keys: set while ACTIVE, so UNIQUE forbids a second lesson in the same slot. */
    sectionSlotKey: varchar('section_slot_key', { length: 120 }).generatedAlwaysAs(
      sql`(IF(\`status\` = 'ACTIVE', CONCAT(\`timetable_id\`, ':', \`section_id\`, ':', \`day_of_week\`, ':', \`period_id\`), NULL))`,
      { mode: 'virtual' },
    ),
    teacherSlotKey: varchar('teacher_slot_key', { length: 120 }).generatedAlwaysAs(
      sql`(IF(\`status\` = 'ACTIVE', CONCAT(\`timetable_id\`, ':', \`teacher_id\`, ':', \`day_of_week\`, ':', \`period_id\`), NULL))`,
      { mode: 'virtual' },
    ),
    venueSlotKey: varchar('venue_slot_key', { length: 120 }).generatedAlwaysAs(
      sql`(IF(\`status\` = 'ACTIVE' AND \`venue_id\` IS NOT NULL, CONCAT(\`timetable_id\`, ':', \`venue_id\`, ':', \`day_of_week\`, ':', \`period_id\`), NULL))`,
      { mode: 'virtual' },
    ),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('timetable_entries_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('timetable_entries_section_slot_uq').on(t.sectionSlotKey),
    uniqueIndex('timetable_entries_teacher_slot_uq').on(t.teacherSlotKey),
    uniqueIndex('timetable_entries_venue_slot_uq').on(t.venueSlotKey),
    index('timetable_entries_slot_idx').on(t.tenantId, t.timetableId, t.dayOfWeek, t.periodId),
    index('timetable_entries_section_idx').on(t.tenantId, t.timetableId, t.sectionId),
    index('timetable_entries_teacher_idx').on(t.tenantId, t.timetableId, t.teacherId),
    index('timetable_entries_venue_idx').on(t.tenantId, t.venueId),
    index('timetable_entries_period_idx').on(t.tenantId, t.periodId),
    index('timetable_entries_assignment_idx').on(t.tenantId, t.teachingAssignmentId),
    foreignKey({
      name: 'timetable_entries_timetable_fk',
      columns: [t.tenantId, t.timetableId, t.academicYearId],
      foreignColumns: [timetables.tenantId, timetables.id, timetables.academicYearId],
    }),
    foreignKey({
      name: 'timetable_entries_period_fk',
      columns: [t.tenantId, t.periodId],
      foreignColumns: [timetablePeriods.tenantId, timetablePeriods.id],
    }),
    foreignKey({
      name: 'timetable_entries_section_fk',
      columns: [t.tenantId, t.sectionId, t.academicYearId],
      foreignColumns: [
        academicSections.tenantId,
        academicSections.id,
        academicSections.academicYearId,
      ],
    }),
    foreignKey({
      name: 'timetable_entries_offering_fk',
      columns: [t.tenantId, t.subjectOfferingId, t.academicYearId],
      foreignColumns: [
        subjectOfferings.tenantId,
        subjectOfferings.id,
        subjectOfferings.academicYearId,
      ],
    }),
    foreignKey({
      name: 'timetable_entries_assignment_fk',
      columns: [t.tenantId, t.teachingAssignmentId],
      foreignColumns: [teachingAssignments.tenantId, teachingAssignments.id],
    }),
    foreignKey({
      name: 'timetable_entries_teacher_fk',
      columns: [t.tenantId, t.teacherId],
      foreignColumns: [teachers.tenantId, teachers.id],
    }),
    foreignKey({
      name: 'timetable_entries_venue_fk',
      columns: [t.tenantId, t.venueId],
      foreignColumns: [timetableVenues.tenantId, timetableVenues.id],
    }),
  ],
);
