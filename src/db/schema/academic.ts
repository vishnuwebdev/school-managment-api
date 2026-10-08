import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
  char,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt, version } from './_columns.js';
import {
  ACADEMIC_YEAR_STATUS,
  CLASS_PHASE,
  CLASS_STATUS,
  OFFERING_STATUS,
  SECTION_STATUS,
  SUBJECT_STATUS,
  SUBJECT_TYPE,
} from './enums.js';
import { tenants } from './tenancy.js';

/**
 * Academic structure (Part 32 / Part 5). Every table has a unique
 * (tenant_id, id) so children can reference their parent through a composite
 * foreign key — the database itself then refuses cross-school references.
 */

export const academicYears = mysqlTable(
  'academic_years',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    status: mysqlEnum('status', ACADEMIC_YEAR_STATUS).notNull().default('DRAFT'),
    /** True only for the ACTIVE year. At most one per school (see current_key). */
    isCurrent: boolean('is_current').notNull().default(false),
    /** Generated: equals tenant_id for the current year, NULL otherwise → UNIQUE allows one. */
    currentKey: varchar('current_key', { length: 36 }).generatedAlwaysAs(
      sql`(IF(\`is_current\`, \`tenant_id\`, NULL))`,
      { mode: 'virtual' },
    ),
    activatedAt: dt('activated_at'),
    completedAt: dt('completed_at'),
    archivedAt: dt('archived_at'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('academic_years_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('academic_years_tenant_code_uq').on(t.tenantId, t.code),
    uniqueIndex('academic_years_current_uq').on(t.currentKey),
    index('academic_years_tenant_status_idx').on(t.tenantId, t.status),
  ],
);

export const academicClasses = mysqlTable(
  'academic_classes',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    displayName: varchar('display_name', { length: 100 }),
    /** Display order only — never identity. */
    sequence: int('sequence').notNull().default(0),
    /** Grouping for reports and the registry (early years, primary, ...). */
    phase: mysqlEnum('phase', CLASS_PHASE),
    languageOfInstruction: varchar('language_of_instruction', { length: 64 }),
    /** The class students move to at year end. Validated in the service. */
    promotesToClassId: char('promotes_to_class_id', { length: 36 }),
    status: mysqlEnum('status', CLASS_STATUS).notNull().default('ACTIVE'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('academic_classes_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('academic_classes_tenant_code_uq').on(t.tenantId, t.code),
    index('academic_classes_tenant_status_idx').on(t.tenantId, t.status, t.sequence),
  ],
);

/** A class grouping inside one academic year (Grade 5 / Section A in 2026-27). */
export const academicSections = mysqlTable(
  'academic_sections',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    academicYearId: ref('academic_year_id').notNull(),
    classId: ref('class_id').notNull(),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    /** NULL = unlimited. Enforced transactionally at enrollment. */
    capacity: int('capacity'),
    room: varchar('room', { length: 50 }),
    status: mysqlEnum('status', SECTION_STATUS).notNull().default('ACTIVE'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('academic_sections_tenant_id_uq').on(t.tenantId, t.id),
    /** Lets children pin "this section belongs to this year" with a composite foreign key (timetable). */
    uniqueIndex('academic_sections_tenant_id_year_uq').on(t.tenantId, t.id, t.academicYearId),
    uniqueIndex('academic_sections_code_uq').on(t.tenantId, t.academicYearId, t.classId, t.code),
    index('academic_sections_year_class_idx').on(t.tenantId, t.academicYearId, t.classId),
    foreignKey({
      name: 'academic_sections_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }),
    foreignKey({
      name: 'academic_sections_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [academicClasses.tenantId, academicClasses.id],
    }),
  ],
);

export const subjects = mysqlTable(
  'subjects',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    description: varchar('description', { length: 500 }),
    subjectType: mysqlEnum('subject_type', SUBJECT_TYPE).notNull().default('CORE'),
    status: mysqlEnum('status', SUBJECT_STATUS).notNull().default('ACTIVE'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('subjects_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('subjects_tenant_code_uq').on(t.tenantId, t.code),
    index('subjects_tenant_status_idx').on(t.tenantId, t.status),
  ],
);

/**
 * A subject offered in one year to a class, optionally narrowed to one section
 * (NULL section = the whole class). Later domains (teaching assignment,
 * timetable, exams) reference this row.
 */
export const subjectOfferings = mysqlTable(
  'subject_offerings',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    academicYearId: ref('academic_year_id').notNull(),
    subjectId: ref('subject_id').notNull(),
    classId: ref('class_id').notNull(),
    sectionId: ref('section_id'),
    /** Generated: section id or 'ALL' so the UNIQUE below also covers class-wide offerings. */
    sectionKey: varchar('section_key', { length: 36 }).generatedAlwaysAs(
      sql`(IFNULL(\`section_id\`, 'ALL'))`,
      { mode: 'virtual' },
    ),
    status: mysqlEnum('status', OFFERING_STATUS).notNull().default('ACTIVE'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('subject_offerings_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('subject_offerings_tenant_id_year_uq').on(t.tenantId, t.id, t.academicYearId),
    uniqueIndex('subject_offerings_uq').on(
      t.tenantId,
      t.academicYearId,
      t.subjectId,
      t.classId,
      t.sectionKey,
    ),
    index('subject_offerings_year_class_idx').on(t.tenantId, t.academicYearId, t.classId),
    index('subject_offerings_subject_idx').on(t.tenantId, t.subjectId),
    foreignKey({
      name: 'subject_offerings_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }),
    foreignKey({
      name: 'subject_offerings_subject_fk',
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    foreignKey({
      name: 'subject_offerings_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [academicClasses.tenantId, academicClasses.id],
    }),
    foreignKey({
      name: 'subject_offerings_section_fk',
      columns: [t.tenantId, t.sectionId],
      foreignColumns: [academicSections.tenantId, academicSections.id],
    }),
  ],
);
