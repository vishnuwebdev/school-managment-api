import {
  boolean,
  char,
  date,
  foreignKey,
  index,
  int,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt } from './_columns.js';
import { students } from './students.js';
import { tenants } from './tenancy.js';

/** Document kinds a school asks for (birth certificate, address proof, …). Configurable per school. */
export const studentDocumentTypes = mysqlTable(
  'student_document_types',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    isRequired: boolean('is_required').notNull().default(false),
    hasExpiry: boolean('has_expiry').notNull().default(false),
    /** false = a new upload replaces the current one; true = several may exist (e.g. "Other"). */
    allowMultiple: boolean('allow_multiple').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: int('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('student_document_types_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('student_document_types_tenant_code_uq').on(t.tenantId, t.code),
  ],
);

/** A file attached to a student. Replaced or removed rows are kept (replaced_at) for history. */
export const studentDocuments = mysqlTable(
  'student_documents',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    studentId: ref('student_id').notNull(),
    typeId: ref('type_id').notNull(),
    fileId: char('file_id', { length: 36 }).notNull(),
    expiresOn: date('expires_on', { mode: 'string' }),
    notes: varchar('notes', { length: 500 }),
    replacedAt: dt('replaced_at'),
    uploadedBy: ref('uploaded_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('student_documents_student_idx').on(t.tenantId, t.studentId, t.replacedAt),
    foreignKey({
      name: 'student_documents_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
    foreignKey({
      name: 'student_documents_type_fk',
      columns: [t.tenantId, t.typeId],
      foreignColumns: [studentDocumentTypes.tenantId, studentDocumentTypes.id],
    }),
  ],
);
