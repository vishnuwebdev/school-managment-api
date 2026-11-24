import { boolean, date, foreignKey, index, int, json, mysqlEnum, mysqlTable, time, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
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

/** What kind of calendar entry an event is (holidays live in school_holidays). */
export const EVENT_TYPE = ['EVENT', 'EXAM', 'MEETING'] as const;
export type EventType = (typeof EVENT_TYPE)[number];

/** Who an event is for. STAFF = teachers and office only (e.g. a staff meeting). */
export const EVENT_AUDIENCE = ['ALL', 'STAFF', 'STUDENTS', 'CLASSES'] as const;
export type EventAudience = (typeof EVENT_AUDIENCE)[number];

/** Where the teacher app's "Action for you" link opens. */
export const EVENT_ACTION_LINK = ['NONE', 'ATTENDANCE', 'MARKS', 'TIMETABLE', 'LEAVE'] as const;
export type EventActionLink = (typeof EVENT_ACTION_LINK)[number];

/**
 * A school event, exam / deadline or meeting: one day or a range (both ends
 * included), optionally with times. Unlike holidays these never make a day
 * off, so leave and attendance ignore them; the teacher app shows them on
 * the school calendar. Cancelled events are kept for history.
 */
export const schoolEvents = mysqlTable(
  'school_events',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    type: mysqlEnum('type', EVENT_TYPE).notNull(),
    title: varchar('title', { length: 120 }).notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    /** Optional, both or neither: 14:00 – 15:00. */
    startTime: time('start_time'),
    endTime: time('end_time'),
    audience: mysqlEnum('audience', EVENT_AUDIENCE).notNull().default('ALL'),
    /** audience = CLASSES: the academic class ids it is for. */
    classIds: json('class_ids').$type<string[]>(),
    description: varchar('description', { length: 500 }),
    /** "Action for you" line shown to teachers, e.g. "Submit Term 4 marks by Friday". */
    staffAction: varchar('staff_action', { length: 200 }),
    actionLink: mysqlEnum('action_link', EVENT_ACTION_LINK).notNull().default('NONE'),
    status: mysqlEnum('status', HOLIDAY_STATUS).notNull().default('ACTIVE'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('school_events_tenant_id_uq').on(t.tenantId, t.id),
    index('school_events_range_idx').on(t.tenantId, t.status, t.startDate, t.endDate),
  ],
);

// ---- unified school calendar (categories + entries) ---------------------------------------------
// Replaces school_holidays and school_events (kept read-only for history; data copied by 0032).

/** Who a calendar entry is for. STAFF = teachers and office; CLASSES / SECTIONS = only those chosen. */
export const CALENDAR_AUDIENCE = ['ALL', 'STAFF', 'STUDENTS', 'CLASSES', 'SECTIONS'] as const;
export type CalendarAudience = (typeof CALENDAR_AUDIENCE)[number];

/**
 * What kind of entry: Holiday, Vacation, Exam / Test, Sports … Each school has
 * the built-in set (is_system) and may add its own. `closes_school` makes its
 * entries days off: leave, attendance and working-day counts skip them.
 */
export const calendarCategories = mysqlTable(
  'calendar_categories',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** Stable code; built-in ones are HOLIDAY, VACATION, EXAM, SPORTS, ACTIVITY, OCCASION, MEETING, INFO. */
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 60 }).notNull(),
    /** #RRGGBB */
    color: varchar('color', { length: 7 }).notNull(),
    closesSchool: boolean('closes_school').notNull().default(false),
    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: int('sort_order').notNull().default(100),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('calendar_categories_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('calendar_categories_tenant_code_uq').on(t.tenantId, t.code),
  ],
);

/**
 * One calendar entry: a day or a range (both ends included), optionally timed,
 * in a category, for an audience. Several entries can share a day. Cancelled
 * entries are kept for history.
 */
export const calendarEvents = mysqlTable(
  'calendar_events',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    categoryId: ref('category_id').notNull(),
    title: varchar('title', { length: 120 }).notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    /** Optional, both or neither: 14:00 – 15:00. */
    startTime: time('start_time'),
    endTime: time('end_time'),
    audience: mysqlEnum('audience', CALENDAR_AUDIENCE).notNull().default('ALL'),
    /** CLASSES: the chosen classes. SECTIONS: the classes of the chosen sections (for filtering). */
    classIds: json('class_ids').$type<string[]>(),
    /** SECTIONS: the chosen sections. */
    sectionIds: json('section_ids').$type<string[]>(),
    description: varchar('description', { length: 500 }),
    /** "Action for you" line shown to teachers, e.g. "Submit Term 4 marks by Friday". */
    staffAction: varchar('staff_action', { length: 200 }),
    actionLink: mysqlEnum('action_link', EVENT_ACTION_LINK).notNull().default('NONE'),
    status: mysqlEnum('status', HOLIDAY_STATUS).notNull().default('ACTIVE'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedBy: ref('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('calendar_events_tenant_id_uq').on(t.tenantId, t.id),
    index('calendar_events_range_idx').on(t.tenantId, t.status, t.startDate, t.endDate),
    index('calendar_events_category_idx').on(t.tenantId, t.categoryId),
    foreignKey({
      name: 'calendar_events_category_fk',
      columns: [t.tenantId, t.categoryId],
      foreignColumns: [calendarCategories.tenantId, calendarCategories.id],
    }),
  ],
);
