import {
  boolean,
  char,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref } from './_columns.js';
import { students } from './students.js';
import { tenants } from './tenancy.js';

export const STUDENT_DOCUMENT_KIND = [
  'BONAFIDE',
  'TRANSFER_CERTIFICATE',
  'CHARACTER_CERTIFICATE',
  'ID_CARD',
] as const;
export type StudentDocumentKind = (typeof STUDENT_DOCUMENT_KIND)[number];

/**
 * The wording of each certificate (and the back of the ID card), per school. Editing creates a new
 * version; issued documents keep pointing at the version they were made from.
 */
export const studentDocumentTemplates = mysqlTable(
  'student_document_templates',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: mysqlEnum('kind', STUDENT_DOCUMENT_KIND).notNull(),
    version: int('version').notNull(),
    title: varchar('title', { length: 150 }).notNull(),
    body: text('body').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('student_doc_templates_version_uq').on(t.tenantId, t.kind, t.version),
    index('student_doc_templates_current_idx').on(t.tenantId, t.kind, t.isCurrent),
  ],
);

/**
 * One row per certificate or card handed out. Never edited: a mistake is voided and a new one
 * issued. `snapshot` holds the exact values printed, so the record stays true if the student's
 * details change later.
 */
export const issuedDocuments = mysqlTable(
  'issued_documents',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    studentId: ref('student_id').notNull(),
    kind: mysqlEnum('kind', STUDENT_DOCUMENT_KIND).notNull(),
    serialNumber: varchar('serial_number', { length: 32 }).notNull(),
    templateId: ref('template_id').notNull(),
    templateVersion: int('template_version').notNull(),
    snapshot: json('snapshot').$type<Record<string, string>>().notNull(),
    fileId: char('file_id', { length: 36 }).notNull(),
    isDuplicate: boolean('is_duplicate').notNull().default(false),
    remarks: varchar('remarks', { length: 500 }),
    issuedBy: ref('issued_by'),
    issuedAt: dt('issued_at').notNull(),
    voidedAt: dt('voided_at'),
    voidedBy: ref('voided_by'),
    voidReason: varchar('void_reason', { length: 500 }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('issued_documents_serial_uq').on(t.tenantId, t.serialNumber),
    index('issued_documents_student_idx').on(t.tenantId, t.studentId, t.issuedAt),
    foreignKey({
      name: 'issued_documents_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
  ],
);
