import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  date,
  foreignKey,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt, version } from './_columns.js';
import { academicClasses, academicSections, academicYears } from './academic.js';
import {
  ADMISSION_STATUS,
  ADMISSION_TYPE,
  BLOOD_GROUP,
  ENROLLMENT_STATUS,
  ENROLLMENT_TYPE,
  GENDER,
  GUARDIAN_CHANNEL,
  GUARDIAN_LINK_STATUS,
  GUARDIAN_RELATION,
  GUARDIAN_STATUS,
  STUDENT_STATUS,
} from './enums.js';
import { users } from './identity.js';
import { studentHouses } from './student-config.js';
import { tenants } from './tenancy.js';

export interface PostalAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

/** Per-school running counters for business numbers (student / admission numbers). */
export const numberSequences = mysqlTable(
  'number_sequences',
  {
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sequenceKey: varchar('sequence_key', { length: 64 }).notNull(),
    lastValue: bigint('last_value', { mode: 'number' }).notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ name: 'number_sequences_pk', columns: [t.tenantId, t.sequenceKey] })],
);

/** Student identity. Class/section live in enrollments, never here. */
export const students = mysqlTable(
  'students',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Business identifier, unique per school. Not the primary key. */
    studentNumber: varchar('student_number', { length: 32 }).notNull(),
    admissionNumber: varchar('admission_number', { length: 32 }),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    middleName: varchar('middle_name', { length: 100 }),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    preferredName: varchar('preferred_name', { length: 100 }),
    dateOfBirth: date('date_of_birth', { mode: 'string' }),
    gender: mysqlEnum('gender', GENDER).notNull().default('UNDISCLOSED'),
    status: mysqlEnum('status', STUDENT_STATUS).notNull().default('PROSPECTIVE'),
    primaryEmail: varchar('primary_email', { length: 254 }),
    primaryPhone: varchar('primary_phone', { length: 32 }),
    nationality: varchar('nationality', { length: 64 }),
    address: json('address').$type<PostalAddress>(),
    /** Reference into the future file service (no binary here). */
    photoFileId: ref('photo_file_id'),
    /** Optional login. Linking never grants school or portal permissions. */
    userId: ref('user_id').references(() => users.id),
    notes: text('notes'),
    bloodGroup: mysqlEnum('blood_group', BLOOD_GROUP),
    /** Government ID number, AES-256-GCM encrypted. Responses only show the last 4 characters. */
    governmentIdEnc: varchar('government_id_enc', { length: 512 }),
    governmentIdLast4: varchar('government_id_last4', { length: 8 }),
    houseId: ref('house_id'),
    previousSchool: varchar('previous_school', { length: 200 }),
    category: varchar('category', { length: 64 }),
    admissionDate: date('admission_date', { mode: 'string' }),
    admissionType: mysqlEnum('admission_type', ADMISSION_TYPE).notNull().default('NEW'),
    statusChangedAt: dt('status_changed_at'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'students_house_fk',
      columns: [t.tenantId, t.houseId],
      foreignColumns: [studentHouses.tenantId, studentHouses.id],
    }),
    index('students_tenant_admission_type_idx').on(t.tenantId, t.admissionType),
    uniqueIndex('students_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('students_tenant_number_uq').on(t.tenantId, t.studentNumber),
    uniqueIndex('students_tenant_admission_uq').on(t.tenantId, t.admissionNumber),
    index('students_tenant_status_idx').on(t.tenantId, t.status),
    index('students_tenant_name_idx').on(t.tenantId, t.lastName, t.firstName),
    index('students_tenant_dob_idx').on(t.tenantId, t.dateOfBirth),
  ],
);

/** Domain history of lifecycle changes (not a copy of the row; audit stays separate). */
export const studentHistory = mysqlTable(
  'student_history',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    studentId: ref('student_id').notNull(),
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
    index('student_history_student_idx').on(t.tenantId, t.studentId, t.createdAt),
    foreignKey({
      name: 'student_history_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
  ],
);

export const admissions = mysqlTable(
  'admissions',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    studentId: ref('student_id').notNull(),
    admissionNumber: varchar('admission_number', { length: 32 }).notNull(),
    applicationDate: date('application_date', { mode: 'string' }).notNull(),
    status: mysqlEnum('status', ADMISSION_STATUS).notNull().default('DRAFT'),
    admissionDate: date('admission_date', { mode: 'string' }),
    source: varchar('source', { length: 64 }),
    notes: text('notes'),
    decisionNote: varchar('decision_note', { length: 500 }),
    decidedBy: ref('decided_by'),
    decidedAt: dt('decided_at'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('admissions_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('admissions_tenant_number_uq').on(t.tenantId, t.admissionNumber),
    index('admissions_tenant_status_idx').on(t.tenantId, t.status),
    index('admissions_student_idx').on(t.tenantId, t.studentId),
    foreignKey({
      name: 'admissions_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
  ],
);

/**
 * A student's place in the academic structure for a period. Historical and
 * never overwritten: a class/section change closes this row and opens another.
 */
export const enrollments = mysqlTable(
  'enrollments',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    studentId: ref('student_id').notNull(),
    academicYearId: ref('academic_year_id').notNull(),
    classId: ref('class_id').notNull(),
    sectionId: ref('section_id'),
    status: mysqlEnum('status', ENROLLMENT_STATUS).notNull().default('ACTIVE'),
    enrollmentType: mysqlEnum('enrollment_type', ENROLLMENT_TYPE).notNull().default('NEW'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    reason: varchar('reason', { length: 500 }),
    /**
     * Generated: student+year while the enrollment is open (PENDING/ACTIVE), NULL otherwise.
     * The UNIQUE on it gives "one open enrollment per student per year" without
     * restricting history (a partial unique index, expressed for MySQL).
     */
    openKey: varchar('open_key', { length: 80 }).generatedAlwaysAs(
      sql`(IF(\`status\` IN ('PENDING','ACTIVE'), CONCAT(\`student_id\`, ':', \`academic_year_id\`), NULL))`,
      { mode: 'virtual' },
    ),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('enrollments_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('enrollments_open_uq').on(t.openKey),
    index('enrollments_student_idx').on(t.tenantId, t.studentId),
    index('enrollments_year_idx').on(t.tenantId, t.academicYearId),
    index('enrollments_roster_idx').on(t.tenantId, t.classId, t.sectionId, t.status),
    foreignKey({
      name: 'enrollments_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'enrollments_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }),
    foreignKey({
      name: 'enrollments_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [academicClasses.tenantId, academicClasses.id],
    }),
    foreignKey({
      name: 'enrollments_section_fk',
      columns: [t.tenantId, t.sectionId],
      foreignColumns: [academicSections.tenantId, academicSections.id],
    }),
  ],
);

/** A guardian is a contact record. Becoming a login (user_id) is optional and separate. */
export const guardians = mysqlTable(
  'guardians',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    firstName: varchar('first_name', { length: 100 }).notNull(),
    middleName: varchar('middle_name', { length: 100 }),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    email: varchar('email', { length: 254 }),
    phone: varchar('phone', { length: 32 }),
    address: json('address').$type<PostalAddress>(),
    occupation: varchar('occupation', { length: 100 }),
    /** How the school should reach this parent first, and what they have opted in to. */
    preferredChannel: mysqlEnum('preferred_channel', GUARDIAN_CHANNEL),
    notifyEmail: boolean('notify_email').notNull().default(true),
    notifySms: boolean('notify_sms').notNull().default(true),
    notifyWhatsapp: boolean('notify_whatsapp').notNull().default(false),
    preferredLanguage: varchar('preferred_language', { length: 16 }),
    status: mysqlEnum('status', GUARDIAN_STATUS).notNull().default('ACTIVE'),
    userId: ref('user_id').references(() => users.id),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('guardians_tenant_id_uq').on(t.tenantId, t.id),
    index('guardians_tenant_name_idx').on(t.tenantId, t.lastName, t.firstName),
    index('guardians_tenant_phone_idx').on(t.tenantId, t.phone),
    index('guardians_tenant_email_idx').on(t.tenantId, t.email),
  ],
);

/** Student ↔ guardian relationship with per-link rights (pick-up, portal, emergency…). */
export const studentGuardians = mysqlTable(
  'student_guardians',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    studentId: ref('student_id').notNull(),
    guardianId: ref('guardian_id').notNull(),
    relationshipType: mysqlEnum('relationship_type', GUARDIAN_RELATION).notNull(),
    /** Display label such as "Mother"; tenant-facing wording, not logic. */
    relationshipLabel: varchar('relationship_label', { length: 64 }),
    isPrimary: boolean('is_primary').notNull().default(false),
    isEmergencyContact: boolean('is_emergency_contact').notNull().default(false),
    canPickUp: boolean('can_pick_up').notNull().default(false),
    portalAccessAllowed: boolean('portal_access_allowed').notNull().default(false),
    effectiveFrom: date('effective_from', { mode: 'string' }),
    effectiveUntil: date('effective_until', { mode: 'string' }),
    status: mysqlEnum('status', GUARDIAN_LINK_STATUS).notNull().default('ACTIVE'),
    /** Generated: the student id while this is the ACTIVE primary link → one primary per student. */
    primaryKey: char('primary_key', { length: 36 }).generatedAlwaysAs(
      sql`(IF(\`is_primary\` AND \`status\` = 'ACTIVE', \`student_id\`, NULL))`,
      { mode: 'virtual' },
    ),
    /** Generated: prevents linking the same guardian twice while active. */
    activeKey: varchar('active_key', { length: 80 }).generatedAlwaysAs(
      sql`(IF(\`status\` = 'ACTIVE', CONCAT(\`student_id\`, ':', \`guardian_id\`), NULL))`,
      { mode: 'virtual' },
    ),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('student_guardians_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('student_guardians_primary_uq').on(t.primaryKey),
    uniqueIndex('student_guardians_active_uq').on(t.activeKey),
    index('student_guardians_student_idx').on(t.tenantId, t.studentId),
    index('student_guardians_guardian_idx').on(t.tenantId, t.guardianId),
    foreignKey({
      name: 'student_guardians_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'student_guardians_guardian_fk',
      columns: [t.tenantId, t.guardianId],
      foreignColumns: [guardians.tenantId, guardians.id],
    }),
  ],
);
