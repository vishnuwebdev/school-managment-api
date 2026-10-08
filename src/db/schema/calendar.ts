import { date, index, json, mysqlEnum, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { createdAt, id, ref, updatedAt, version } from './_columns.js';
import { tenants } from './tenancy.js';

/** Who a holiday is for. STUDENTS = staff still work (e.g. a teacher training day). */
export const HOLIDAY_AUDIENCE = ['ALL', 'STUDENTS', 'CLASSES'] as const;
export type HolidayAudience = (typeof HOLIDAY_AUDIENCE)[number];

export const HOLIDAY_STATUS = ['ACTIVE', 'CANCELLED'] as const;

/**
 * The school's weekly off days. One row per school; a missing row means the
 * defaults (Sunday off, no Saturdays off).
 */
export const schoolCalendarSettings = mysqlTable('school_calendar_settings', {
  tenantId: ref('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  /** ISO weekdays that are always off: 1 = Monday … 7 = Sunday. */
  weeklyOffDays: json('weekly_off_days').$type<number[]>().notNull(),
  /** Which Saturdays of the month are off, e.g. [2, 4] = 2nd and 4th Saturday. */
  offSaturdays: json('off_saturdays').$type<number[]>().notNull(),
  version: version(),
  updatedBy: ref('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * A school holiday: one day or a range (both ends included). Leave, staff and
 * student attendance and the timetable read these through CalendarService.
 * Cancelled holidays are kept for history.
 */
export const schoolHolidays = mysqlTable(
  'school_holidays',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: varchar('name', { length: 120 }).notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    audience: mysqlEnum('audience', HOLIDAY_AUDIENCE).notNull().default('ALL'),
    /** audience = CLASSES: the academic class ids that are off. */
    classIds: json('class_ids').$type<string[]>(),
    description: varchar('description', { length: 500 }),
    status: mysqlEnum('status', HOLIDAY_STATUS).notNull().default('ACTIVE'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('school_holidays_tenant_id_uq').on(t.tenantId, t.id),
    index('school_holidays_range_idx').on(t.tenantId, t.status, t.startDate, t.endDate),
  ],
);
