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
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt, version } from './_columns.js';
import { teachers } from './teachers.js';
import { tenants } from './tenancy.js';

export const LEAVE_STATUS = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type LeaveStatus = (typeof LEAVE_STATUS)[number];

export const STAFF_ATTENDANCE_STATUS = ['PRESENT', 'ABSENT', 'LEAVE', 'LATE'] as const;
export type StaffAttendanceStatus = (typeof STAFF_ATTENDANCE_STATUS)[number];

/** Kinds of leave a school grants (casual, sick, …). Configurable per school. */
export const leaveTypes = mysqlTable(
  'leave_types',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    /** Days per calendar year. NULL = no limit (e.g. unpaid leave). */
    annualQuota: int('annual_quota'),
    isPaid: boolean('is_paid').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: int('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('leave_types_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('leave_types_tenant_code_uq').on(t.tenantId, t.code),
  ],
);

/** A leave request by a staff member. Decided requests are kept (never deleted). */
export const leaveRequests = mysqlTable(
  'leave_requests',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    teacherId: ref('teacher_id').notNull(),
    leaveTypeId: ref('leave_type_id').notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    /** Calendar days from start to end, both included. */
    days: int('days').notNull(),
    reason: varchar('reason', { length: 500 }),
    status: mysqlEnum('status', LEAVE_STATUS).notNull().default('PENDING'),
    decidedBy: ref('decided_by'),
    decidedAt: dt('decided_at'),
    decisionNote: varchar('decision_note', { length: 500 }),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('leave_requests_tenant_id_uq').on(t.tenantId, t.id),
    index('leave_requests_teacher_idx').on(t.tenantId, t.teacherId, t.startDate),
    index('leave_requests_status_idx').on(t.tenantId, t.status, t.startDate),
    foreignKey({
      name: 'leave_requests_teacher_fk',
      columns: [t.tenantId, t.teacherId],
      foreignColumns: [teachers.tenantId, teachers.id],
    }),
    foreignKey({
      name: 'leave_requests_type_fk',
      columns: [t.tenantId, t.leaveTypeId],
      foreignColumns: [leaveTypes.tenantId, leaveTypes.id],
    }),
  ],
);

/** One mark per staff member per day. */
export const staffAttendance = mysqlTable(
  'staff_attendance',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    teacherId: ref('teacher_id').notNull(),
    attendanceDate: date('attendance_date', { mode: 'string' }).notNull(),
    status: mysqlEnum('status', STAFF_ATTENDANCE_STATUS).notNull(),
    note: varchar('note', { length: 255 }),
    markedBy: ref('marked_by'),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('staff_attendance_day_uq').on(t.tenantId, t.teacherId, t.attendanceDate),
    index('staff_attendance_date_idx').on(t.tenantId, t.attendanceDate),
    foreignKey({
      name: 'staff_attendance_teacher_fk',
      columns: [t.tenantId, t.teacherId],
      foreignColumns: [teachers.tenantId, teachers.id],
    }),
  ],
);
