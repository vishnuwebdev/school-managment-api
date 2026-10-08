import { sql } from 'drizzle-orm';
import {
  date,
  foreignKey,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt, version } from './_columns.js';
import { academicSections, subjectOfferings } from './academic.js';
import {
  ASSIGNMENT_ROLE,
  EMPLOYMENT_TYPE,
  GENDER,
  QUALIFICATION_STATUS,
  QUALIFICATION_TYPE,
  STAFF_TYPE,
  TEACHER_STATUS,
  TEACHING_ASSIGNMENT_STATUS,
} from './enums.js';
import { memberships } from './identity.js';
import type { PostalAddress } from './students.js';
import { tenants } from './tenancy.js';

/**
 * Teachers and staff (Part 15). A teacher is a personnel record owned by the
 * school; a login (membership) is optional and linked separately. No payroll,
 * salary or credential data lives here.
 */
export const teachers = mysqlTable(
  'teachers',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Business identifier, unique per school. Not the primary key. */
    teacherNumber: varchar('teacher_number', { length: 32 }).notNull(),
    staffType: mysqlEnum('staff_type', STAFF_TYPE).notNull().default('TEACHING'),
    status: mysqlEnum('status', TEACHER_STATUS).notNull().default('ACTIVE'),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    middleName: varchar('middle_name', { length: 100 }),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    preferredName: varchar('preferred_name', { length: 100 }),
    dateOfBirth: date('date_of_birth', { mode: 'string' }),
    gender: mysqlEnum('gender', GENDER).notNull().default('UNDISCLOSED'),
    email: varchar('email', { length: 254 }),
    phone: varchar('phone', { length: 32 }),
    address: json('address').$type<PostalAddress>(),
    // ---- employment (not payroll)
    joiningDate: date('joining_date', { mode: 'string' }),
    employmentType: mysqlEnum('employment_type', EMPLOYMENT_TYPE).notNull().default('FULL_TIME'),
    department: varchar('department', { length: 100 }),
    designation: varchar('designation', { length: 100 }),
    exitDate: date('exit_date', { mode: 'string' }),
    exitReason: varchar('exit_reason', { length: 500 }),
    notes: text('notes'),
    emergencyContactName: varchar('emergency_contact_name', { length: 150 }),
    emergencyContactPhone: varchar('emergency_contact_phone', { length: 32 }),
    emergencyContactRelation: varchar('emergency_contact_relation', { length: 50 }),
    /** Government ID number, AES-256-GCM encrypted. Never returned; only the last 4 characters are shown. */
    idNumberEnc: varchar('id_number_enc', { length: 512 }),
    idNumberLast4: varchar('id_number_last4', { length: 8 }),
    reportingManagerId: ref('reporting_manager_id'),
    photoFileId: ref('photo_file_id'),
    /** Optional login. Linking never grants school permissions by itself. */
    membershipId: ref('membership_id'),
    statusChangedAt: dt('status_changed_at'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('teachers_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('teachers_tenant_number_uq').on(t.tenantId, t.teacherNumber),
    uniqueIndex('teachers_membership_uq').on(t.membershipId),
    index('teachers_tenant_status_idx').on(t.tenantId, t.status),
    index('teachers_tenant_name_idx').on(t.tenantId, t.lastName, t.firstName),
    index('teachers_tenant_type_idx').on(t.tenantId, t.staffType, t.status),
    index('teachers_tenant_department_idx').on(t.tenantId, t.department),
    foreignKey({
      name: 'teachers_manager_fk',
      columns: [t.tenantId, t.reportingManagerId],
      foreignColumns: [t.tenantId, t.id],
    }),
    foreignKey({
      name: 'teachers_membership_fk',
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
    }),
  ],
);

/** Domain history of a teacher (lifecycle, profile edits, assignments). Audit stays separate. */
export const teacherHistory = mysqlTable(
  'teacher_history',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    teacherId: ref('teacher_id').notNull(),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    fromStatus: varchar('from_status', { length: 32 }),
    toStatus: varchar('to_status', { length: 32 }),
    effectiveDate: date('effective_date', { mode: 'string' }),
    reason: varchar('reason', { length: 500 }),
    details: json('details').$type<Record<string, unknown>>(),
    actorUserId: ref('actor_user_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('teacher_history_teacher_idx').on(t.tenantId, t.teacherId, t.createdAt),
    foreignKey({
      name: 'teacher_history_teacher_fk',
      columns: [t.tenantId, t.teacherId],
      foreignColumns: [teachers.tenantId, teachers.id],
    }),
  ],
);

export const teacherQualifications = mysqlTable(
  'teacher_qualifications',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    teacherId: ref('teacher_id').notNull(),
    qualificationType: mysqlEnum('qualification_type', QUALIFICATION_TYPE).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    institution: varchar('institution', { length: 200 }),
    fieldOfStudy: varchar('field_of_study', { length: 200 }),
    completionYear: smallint('completion_year'),
    /** REMOVED keeps the row for audit; it no longer shows on the profile. */
    status: mysqlEnum('status', QUALIFICATION_STATUS).notNull().default('ACTIVE'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('teacher_qualifications_tenant_id_uq').on(t.tenantId, t.id),
    index('teacher_qualifications_teacher_idx').on(t.tenantId, t.teacherId, t.status),
    foreignKey({
      name: 'teacher_qualifications_teacher_fk',
      columns: [t.tenantId, t.teacherId],
      foreignColumns: [teachers.tenantId, teachers.id],
    }),
  ],
);

/**
 * A teacher's link to a subject offering (year + class + optional section +
 * subject). Class, section and year are NOT copied here — they come from the
 * offering. Effective-dated and historical: ending never deletes.
 */
export const teachingAssignments = mysqlTable(
  'teaching_assignments',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    teacherId: ref('teacher_id').notNull(),
    subjectOfferingId: ref('subject_offering_id').notNull(),
    role: mysqlEnum('role', ASSIGNMENT_ROLE).notNull().default('PRIMARY'),
    status: mysqlEnum('status', TEACHING_ASSIGNMENT_STATUS).notNull().default('ACTIVE'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    reason: varchar('reason', { length: 500 }),
    /**
     * Generated: teacher+offering while the assignment is open (ACTIVE), NULL otherwise.
     * UNIQUE on it = at most one open assignment per teacher per offering, while
     * several teachers can share an offering and history is unrestricted.
     */
    openKey: varchar('open_key', { length: 80 }).generatedAlwaysAs(
      sql`(IF(\`status\` = 'ACTIVE', CONCAT(\`teacher_id\`, ':', \`subject_offering_id\`), NULL))`,
      { mode: 'virtual' },
    ),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('teaching_assignments_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('teaching_assignments_open_uq').on(t.openKey),
    index('teaching_assignments_teacher_idx').on(t.tenantId, t.teacherId, t.status),
    index('teaching_assignments_offering_idx').on(t.tenantId, t.subjectOfferingId, t.status),
    foreignKey({
      name: 'teaching_assignments_teacher_fk',
      columns: [t.tenantId, t.teacherId],
      foreignColumns: [teachers.tenantId, teachers.id],
    }),
    foreignKey({
      name: 'teaching_assignments_offering_fk',
      columns: [t.tenantId, t.subjectOfferingId],
      foreignColumns: [subjectOfferings.tenantId, subjectOfferings.id],
    }),
  ],
);

/**
 * The class teacher of a section. One open row per section (ACTIVE); changing
 * the class teacher ends the old row and opens a new one, so history is kept.
 * A teacher may be class teacher of several sections.
 */
export const sectionClassTeachers = mysqlTable(
  'section_class_teachers',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sectionId: ref('section_id').notNull(),
    teacherId: ref('teacher_id').notNull(),
    status: mysqlEnum('status', ['ACTIVE', 'ENDED']).notNull().default('ACTIVE'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    reason: varchar('reason', { length: 500 }),
    /** Generated: the section id while ACTIVE, NULL otherwise. UNIQUE = one open class teacher per section. */
    openKey: varchar('open_key', { length: 36 }).generatedAlwaysAs(
      sql`(IF(\`status\` = 'ACTIVE', \`section_id\`, NULL))`,
      { mode: 'virtual' },
    ),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('section_class_teachers_open_uq').on(t.tenantId, t.openKey),
    index('section_class_teachers_teacher_idx').on(t.tenantId, t.teacherId, t.status),
    index('section_class_teachers_section_idx').on(t.tenantId, t.sectionId, t.status),
    foreignKey({
      name: 'section_class_teachers_section_fk',
      columns: [t.tenantId, t.sectionId],
      foreignColumns: [academicSections.tenantId, academicSections.id],
    }),
    foreignKey({
      name: 'section_class_teachers_teacher_fk',
      columns: [t.tenantId, t.teacherId],
      foreignColumns: [teachers.tenantId, teachers.id],
    }),
  ],
);
