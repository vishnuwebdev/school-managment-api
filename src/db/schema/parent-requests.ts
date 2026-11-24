import {
  boolean,
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

export const CHANGE_REQUEST_STATUS = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUS)[number];

/** One field change: what the record said when the parent asked, and what they asked for. */
export type FieldChange = { from: unknown; to: unknown };

/**
 * A parent asks the school to change their child's details (0046). Nothing changes on the
 * student until the office approves; approving applies the requested values.
 */
export const studentChangeRequests = mysqlTable(
  'student_change_requests',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    studentId: ref('student_id').notNull(),
    guardianId: ref('guardian_id').notNull(),
    /** Field (API name) → { from, to }. */
    changes: json('changes').$type<Record<string, FieldChange>>().notNull(),
    note: varchar('note', { length: 1000 }),
    status: mysqlEnum('status', CHANGE_REQUEST_STATUS).notNull().default('PENDING'),
    requestedBy: ref('requested_by'),
    decidedBy: ref('decided_by'),
    decidedAt: dt('decided_at'),
    decisionNote: varchar('decision_note', { length: 1000 }),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('student_change_requests_tenant_id_uq').on(t.tenantId, t.id),
    index('student_change_requests_status_idx').on(t.tenantId, t.status, t.createdAt),
    index('student_change_requests_student_idx').on(t.tenantId, t.studentId),
  ],
);

export const PARENT_MESSAGE_KIND = ['COMPLAINT', 'FEEDBACK', 'SUGGESTION'] as const;
export type ParentMessageKind = (typeof PARENT_MESSAGE_KIND)[number];

export const PARENT_MESSAGE_TOPIC = [
  'SCHOOL',
  'STUDENT_PROGRESS',
  'TEACHING',
  'FACILITIES',
  'FEES',
  'TRANSPORT',
  'OTHER',
] as const;
export type ParentMessageTopic = (typeof PARENT_MESSAGE_TOPIC)[number];

export const PARENT_MESSAGE_STATUS = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
export type ParentMessageStatus = (typeof PARENT_MESSAGE_STATUS)[number];

/**
 * A complaint (to the principal), feedback or suggestion from a parent (0046), with a
 * conversation: the school replies in the admin panel and the parent sees it in the app.
 */
export const parentMessages = mysqlTable(
  'parent_messages',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    referenceNumber: varchar('reference_number', { length: 24 }).notNull(),
    guardianId: ref('guardian_id').notNull(),
    /** The child it is about, if any. */
    studentId: ref('student_id'),
    kind: mysqlEnum('kind', PARENT_MESSAGE_KIND).notNull(),
    topic: mysqlEnum('topic', PARENT_MESSAGE_TOPIC).notNull().default('SCHOOL'),
    subject: varchar('subject', { length: 150 }).notNull(),
    body: text('body').notNull(),
    status: mysqlEnum('status', PARENT_MESSAGE_STATUS).notNull().default('OPEN'),
    /** Staff user handling it. */
    assignedTo: ref('assigned_to'),
    /** Unread flags for each side (a new reply from the other side sets them). */
    unreadBySchool: boolean('unread_by_school').notNull().default(true),
    unreadByParent: boolean('unread_by_parent').notNull().default(false),
    lastActivityAt: dt('last_activity_at').notNull(),
    resolvedAt: dt('resolved_at'),
    createdBy: ref('created_by'),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('parent_messages_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('parent_messages_reference_uq').on(t.tenantId, t.referenceNumber),
    index('parent_messages_status_idx').on(t.tenantId, t.kind, t.status, t.lastActivityAt),
    index('parent_messages_guardian_idx').on(t.tenantId, t.guardianId),
  ],
);

export const parentMessageReplies = mysqlTable(
  'parent_message_replies',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    messageId: ref('message_id').notNull(),
    author: mysqlEnum('author', ['PARENT', 'SCHOOL']).notNull(),
    authorUserId: ref('author_user_id'),
    authorName: varchar('author_name', { length: 150 }).notNull(),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('parent_message_replies_message_idx').on(t.tenantId, t.messageId, t.createdAt)],
);
