import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt, version } from './_columns.js';
import { tenants } from './tenancy.js';

export const NOTICE_CATEGORY = ['NOTICE', 'CIRCULAR', 'ANNOUNCEMENT', 'EVENT'] as const;
export type NoticeCategory = (typeof NOTICE_CATEGORY)[number];

/** SCHOOL = every parent; CLASSES / SECTIONS = parents of children placed there. */
export const NOTICE_AUDIENCE = ['SCHOOL', 'CLASSES', 'SECTIONS'] as const;
export type NoticeAudience = (typeof NOTICE_AUDIENCE)[number];

export const NOTICE_STATUS = ['ACTIVE', 'CANCELLED'] as const;

/**
 * A notice, circular, announcement or event for parents (0045). Written by the office in the
 * admin panel (any audience) or by a teacher in the teacher app (their own sections only).
 * Parents see it in the parent app once `publish_at` has passed (no push yet).
 */
export const notices = mysqlTable(
  'notices',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    category: mysqlEnum('category', NOTICE_CATEGORY).notNull().default('NOTICE'),
    title: varchar('title', { length: 150 }).notNull(),
    /** One-line preview for lists. */
    summary: varchar('summary', { length: 300 }).notNull(),
    /** Full text; paragraphs are separated by blank lines. */
    body: text('body').notNull(),
    audience: mysqlEnum('audience', NOTICE_AUDIENCE).notNull().default('SCHOOL'),
    classIds: json('class_ids').$type<string[]>(),
    sectionIds: json('section_ids').$type<string[]>(),
    attachmentFileId: ref('attachment_file_id'),
    requiresAcknowledgement: boolean('requires_acknowledgement').notNull().default(false),
    /** When set, the notice also shows under "Coming up" in the parent app. */
    eventDate: date('event_date', { mode: 'string' }),
    eventTitle: varchar('event_title', { length: 120 }),
    eventSubtitle: varchar('event_subtitle', { length: 160 }),
    publishAt: dt('publish_at').notNull(),
    status: mysqlEnum('status', NOTICE_STATUS).notNull().default('ACTIVE'),
    /** Set when a teacher posted it from the teacher app; null for the office. */
    teacherId: ref('teacher_id'),
    /** Name shown to parents ("School office", "Ms Priya Nair"). */
    postedByName: varchar('posted_by_name', { length: 150 }).notNull(),
    cancelledAt: dt('cancelled_at'),
    cancelReason: varchar('cancel_reason', { length: 500 }),
    createdBy: ref('created_by'),
    updatedBy: ref('updated_by'),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('notices_tenant_id_uq').on(t.tenantId, t.id),
    index('notices_publish_idx').on(t.tenantId, t.status, t.publishAt),
    index('notices_teacher_idx').on(t.tenantId, t.teacherId),
  ],
);

/** Read and acknowledgement state of a notice per guardian (one row per guardian). */
export const noticeReceipts = mysqlTable(
  'notice_receipts',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    noticeId: ref('notice_id').notNull(),
    guardianId: ref('guardian_id').notNull(),
    readAt: dt('read_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    acknowledgedAt: dt('acknowledged_at'),
    acknowledgedBy: ref('acknowledged_by'),
  },
  (t) => [
    uniqueIndex('notice_receipts_uq').on(t.tenantId, t.noticeId, t.guardianId),
    index('notice_receipts_guardian_idx').on(t.tenantId, t.guardianId),
  ],
);
