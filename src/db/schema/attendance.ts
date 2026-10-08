import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  decimal,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt, version } from './_columns.js';
import { academicClasses, academicSections, academicYears, subjectOfferings } from './academic.js';
import {
  ATTENDANCE_CORRECTION_STATUS,
  ATTENDANCE_SESSION_STATUS,
  ATTENDANCE_STATUS_CATEGORY,
  ATTENDANCE_STATUS_STATE,
  ATTENDANCE_TYPE,
} from './enums.js';
import { enrollments, students } from './students.js';
import { teachers } from './teachers.js';
import { tenants } from './tenancy.js';

/**
 * Attendance (Part 16 / Part 33 §33.13–33.44). Attendance owns sessions,
 * records, statuses and corrections; it only REFERENCES students, enrollments,
 * the academic structure and teachers — always through composite foreign keys
 * `(tenant_id, x_id)`, so the database itself refuses cross-school references.
 */

/** School-configurable status catalog (PRESENT, ABSENT, LATE, ... plus custom ones). */
export const attendanceStatuses = mysqlTable(
  'attendance_statuses',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Stable, upper-case identifier, unique per school. */
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 80 }).notNull(),
    category: mysqlEnum('category', ATTENDANCE_STATUS_CATEGORY).notNull(),
    /** Share of one attendance unit this status counts as present (0.00–1.00; half day = 0.50). */
    countsAsPresent: decimal('counts_as_present', { precision: 3, scale: 2 })
      .notNull()
      .default('0.00'),
    /** Share of one unit counted as absent (0.00–1.00). */
    countsAsAbsent: decimal('counts_as_absent', { precision: 3, scale: 2 })
      .notNull()
      .default('0.00'),
    requiresReason: boolean('requires_reason').notNull().default(false),
    sortOrder: int('sort_order').notNull().default(0),
    status: mysqlEnum('status', ATTENDANCE_STATUS_STATE).notNull().default('ACTIVE'),
    /** The six built-in statuses. Never deleted, never deactivated, semantics locked. */
    isSystem: boolean('is_system').notNull().default(false),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('attendance_statuses_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('attendance_statuses_tenant_code_uq').on(t.tenantId, t.code),
    index('attendance_statuses_tenant_state_idx').on(t.tenantId, t.status, t.sortOrder),
  ],
);

/** One row per school, created lazily with defaults. Owned by Attendance (§33.43). */
export const attendanceSettings = mysqlTable('attendance_settings', {
  tenantId: ref('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  /** true: submit → SUBMITTED and an approver finalizes; false: submit → FINAL. */
  approvalRequired: boolean('approval_required').notNull().default(false),
  /** true: corrections of FINAL records wait for approval; false: applied at once (still recorded). */
  correctionRequiresApproval: boolean('correction_requires_approval').notNull().default(false),
  /** Days after the session date during which sessions can be opened and edited (approvers bypass). */
  editWindowDays: int('edit_window_days').notNull().default(7),
  defaulterThresholdPercent: decimal('defaulter_threshold_percent', { precision: 5, scale: 2 })
    .notNull()
    .default('75.00'),
  /** Convenience switch: sets counts_as_present of every LATE-category status to 1.00 / 0.00. */
  lateCountsAsPresent: boolean('late_counts_as_present').notNull().default(true),
  version: version(),
  updatedBy: ref('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * The business context in which attendance is recorded: one class register for
 * one date (DAILY) or one subject period (SUBJECT).
 */
export const attendanceSessions = mysqlTable(
  'attendance_sessions',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    attendanceType: mysqlEnum('attendance_type', ATTENDANCE_TYPE).notNull().default('DAILY'),
    academicYearId: ref('academic_year_id').notNull(),
    classId: ref('class_id').notNull(),
    /** Always set: the register is per section. Derived from the section, never trusted from the client. */
    sectionId: ref('section_id').notNull(),
    sessionDate: date('session_date', { mode: 'string' }).notNull(),
    subjectOfferingId: ref('subject_offering_id'),
    /** The recorder's teacher record, when their login is linked to one. Context, not authorization. */
    teacherId: ref('teacher_id'),
    periodLabel: varchar('period_label', { length: 40 }),
    status: mysqlEnum('status', ATTENDANCE_SESSION_STATUS).notNull().default('DRAFT'),
    /**
     * Generated: one DAILY session per year+section+date; one SUBJECT session per
     * offering+section+date+period. UNIQUE on it (with tenant) forbids competing sessions.
     */
    sessionKey: varchar('session_key', { length: 200 }).generatedAlwaysAs(
      sql`(IF(\`attendance_type\` = 'DAILY', CONCAT('D:', \`academic_year_id\`, ':', \`section_id\`, ':', \`session_date\`), CONCAT('S:', IFNULL(\`subject_offering_id\`, ''), ':', \`section_id\`, ':', \`session_date\`, ':', IFNULL(\`period_label\`, ''))))`,
      { mode: 'virtual' },
    ),
    startedAt: dt('started_at').notNull(),
    startedBy: ref('started_by'),
    submittedAt: dt('submitted_at'),
    submittedBy: ref('submitted_by'),
    approvedAt: dt('approved_at'),
    approvedBy: ref('approved_by'),
    /** When the session became FINAL (by approval, or by submit when approval is not required). */
    finalizedAt: dt('finalized_at'),
    rejectedAt: dt('rejected_at'),
    rejectedBy: ref('rejected_by'),
    rejectionReason: varchar('rejection_reason', { length: 500 }),
    reopenedAt: dt('reopened_at'),
    reopenedBy: ref('reopened_by'),
    reopenReason: varchar('reopen_reason', { length: 500 }),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('attendance_sessions_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('attendance_sessions_key_uq').on(t.tenantId, t.sessionKey),
    index('attendance_sessions_section_date_idx').on(t.tenantId, t.sectionId, t.sessionDate),
    index('attendance_sessions_date_idx').on(t.tenantId, t.sessionDate, t.status),
    index('attendance_sessions_year_date_idx').on(t.tenantId, t.academicYearId, t.sessionDate),
    foreignKey({
      name: 'attendance_sessions_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }),
    foreignKey({
      name: 'attendance_sessions_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [academicClasses.tenantId, academicClasses.id],
    }),
    foreignKey({
      name: 'attendance_sessions_section_fk',
      columns: [t.tenantId, t.sectionId],
      foreignColumns: [academicSections.tenantId, academicSections.id],
    }),
    foreignKey({
      name: 'attendance_sessions_offering_fk',
      columns: [t.tenantId, t.subjectOfferingId],
      foreignColumns: [subjectOfferings.tenantId, subjectOfferings.id],
    }),
    foreignKey({
      name: 'attendance_sessions_teacher_fk',
      columns: [t.tenantId, t.teacherId],
      foreignColumns: [teachers.tenantId, teachers.id],
    }),
  ],
);

/**
 * One student in one session. `enrollment_id` preserves the academic context
 * the mark was made under; the present/absent weights are SNAPSHOTS of the
 * status semantics at marking time, so reconfiguring a status never rewrites
 * history (§33.23).
 */
export const attendanceRecords = mysqlTable(
  'attendance_records',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    sessionId: ref('session_id').notNull(),
    studentId: ref('student_id').notNull(),
    enrollmentId: ref('enrollment_id').notNull(),
    statusId: ref('status_id').notNull(),
    presentWeight: decimal('present_weight', { precision: 3, scale: 2 }).notNull(),
    absentWeight: decimal('absent_weight', { precision: 3, scale: 2 }).notNull(),
    remarks: varchar('remarks', { length: 500 }),
    markedAt: dt('marked_at').notNull(),
    markedBy: ref('marked_by'),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('attendance_records_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('attendance_records_session_student_uq').on(t.tenantId, t.sessionId, t.studentId),
    index('attendance_records_student_idx').on(t.tenantId, t.studentId),
    index('attendance_records_status_idx').on(t.tenantId, t.statusId),
    index('attendance_records_enrollment_idx').on(t.tenantId, t.enrollmentId),
    foreignKey({
      name: 'attendance_records_session_fk',
      columns: [t.tenantId, t.sessionId],
      foreignColumns: [attendanceSessions.tenantId, attendanceSessions.id],
    }),
    foreignKey({
      name: 'attendance_records_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'attendance_records_enrollment_fk',
      columns: [t.tenantId, t.enrollmentId],
      foreignColumns: [enrollments.tenantId, enrollments.id],
    }),
    foreignKey({
      name: 'attendance_records_status_fk',
      columns: [t.tenantId, t.statusId],
      foreignColumns: [attendanceStatuses.tenantId, attendanceStatuses.id],
    }),
  ],
);

/** Controlled change of a FINAL record. The original status is never lost (§33.25). */
export const attendanceCorrections = mysqlTable(
  'attendance_corrections',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    recordId: ref('record_id').notNull(),
    oldStatusId: ref('old_status_id').notNull(),
    newStatusId: ref('new_status_id').notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    status: mysqlEnum('status', ATTENDANCE_CORRECTION_STATUS).notNull().default('PENDING'),
    requestedBy: ref('requested_by'),
    requestedAt: dt('requested_at').notNull(),
    /** Approver (APPROVED / REJECTED). NULL for AUTO_APPLIED. */
    decidedBy: ref('decided_by'),
    decidedAt: dt('decided_at'),
    decisionNote: varchar('decision_note', { length: 500 }),
    /** Generated: the record id while PENDING, else NULL → at most one pending correction per record. */
    pendingKey: varchar('pending_key', { length: 36 }).generatedAlwaysAs(
      sql`(IF(\`status\` = 'PENDING', \`record_id\`, NULL))`,
      { mode: 'virtual' },
    ),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('attendance_corrections_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('attendance_corrections_pending_uq').on(t.pendingKey),
    index('attendance_corrections_record_idx').on(t.tenantId, t.recordId, t.createdAt),
    index('attendance_corrections_state_idx').on(t.tenantId, t.status, t.createdAt),
    foreignKey({
      name: 'attendance_corrections_record_fk',
      columns: [t.tenantId, t.recordId],
      foreignColumns: [attendanceRecords.tenantId, attendanceRecords.id],
    }),
    foreignKey({
      name: 'attendance_corrections_old_status_fk',
      columns: [t.tenantId, t.oldStatusId],
      foreignColumns: [attendanceStatuses.tenantId, attendanceStatuses.id],
    }),
    foreignKey({
      name: 'attendance_corrections_new_status_fk',
      columns: [t.tenantId, t.newStatusId],
      foreignColumns: [attendanceStatuses.tenantId, attendanceStatuses.id],
    }),
  ],
);
