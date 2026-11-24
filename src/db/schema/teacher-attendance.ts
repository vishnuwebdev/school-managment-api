import {
  date,
  foreignKey,
  index,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, id, ref, updatedAt, version } from './_columns.js';
import { teachers } from './teachers.js';
import { tenants } from './tenancy.js';

export const TEACHER_ATTENDANCE_STATUS = [
  'PRESENT',
  'ABSENT',
  'LEAVE',
  'LATE',
  'HALF_DAY',
] as const;
export type TeacherAttendanceStatus = (typeof TEACHER_ATTENDANCE_STATUS)[number];

/**
 * Teacher attendance: one mark per teacher per day, set by the school office
 * (0041_teacher_attendance). Replaces the old staff_attendance table, which was
 * dropped with leave in 0040.
 */
export const teacherAttendance = mysqlTable(
  'teacher_attendance',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    teacherId: ref('teacher_id').notNull(),
    attendanceDate: date('attendance_date', { mode: 'string' }).notNull(),
    status: mysqlEnum('status', TEACHER_ATTENDANCE_STATUS).notNull(),
    note: varchar('note', { length: 255 }),
    markedBy: ref('marked_by'),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('teacher_attendance_day_uq').on(t.tenantId, t.teacherId, t.attendanceDate),
    index('teacher_attendance_date_idx').on(t.tenantId, t.attendanceDate),
    foreignKey({
      name: 'teacher_attendance_teacher_fk',
      columns: [t.tenantId, t.teacherId],
      foreignColumns: [teachers.tenantId, teachers.id],
    }),
  ],
);
