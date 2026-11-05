import { sql } from 'drizzle-orm';
import { index, json, mysqlEnum, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt, version } from './_columns.js';
import { tenants } from './tenancy.js';

/**
 * A notification the office sends to teachers from the admin panel (0044): to every
 * teacher or to chosen ones, now or at a set time. The teacher app shows it once
 * send_at has passed (no push yet).
 */
export const teacherNotifications = mysqlTable(
  'teacher_notifications',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    title: varchar('title', { length: 150 }).notNull(),
    body: varchar('body', { length: 2000 }).notNull(),
    audience: mysqlEnum('audience', ['ALL', 'SELECTED']).notNull().default('ALL'),
    teacherIds: json('teacher_ids').$type<string[]>(),
    sendAt: dt('send_at').notNull(),
    status: mysqlEnum('status', ['ACTIVE', 'CANCELLED']).notNull().default('ACTIVE'),
    createdBy: ref('created_by'),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('teacher_notifications_send_idx').on(t.tenantId, t.status, t.sendAt)],
);

/** Which teacher has read which notification. */
export const teacherNotificationReads = mysqlTable(
  'teacher_notification_reads',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    notificationId: ref('notification_id').notNull(),
    teacherId: ref('teacher_id').notNull(),
    readAt: dt('read_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [uniqueIndex('teacher_notification_reads_uq').on(t.notificationId, t.teacherId)],
);
