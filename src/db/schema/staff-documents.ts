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
import { teachers } from './teachers.js';
import { tenants } from './tenancy.js';

/** Document kinds a school asks for (ID proof, qualification certificate, contract, …). Configurable per school. */
export const staffDocumentTypes = mysqlTable(
  'staff_document_types',
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
    uniqueIndex('staff_document_types_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('staff_document_types_tenant_code_uq').on(t.tenantId, t.code),
  ],
);

/** A file attached to a staff member. Replaced or removed rows are kept (replaced_at) for history. */
export const staffDocuments = mysqlTable(
  'staff_documents',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    teacherId: ref('teacher_id').notNull(),
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
    index('staff_documents_teacher_idx').on(t.tenantId, t.teacherId, t.replacedAt),
    foreignKey({
      name: 'staff_documents_teacher_fk',
      columns: [t.tenantId, t.teacherId],
      foreignColumns: [teachers.tenantId, teachers.id],
    }),
    foreignKey({
      name: 'staff_documents_type_fk',
      columns: [t.tenantId, t.typeId],
      foreignColumns: [staffDocumentTypes.tenantId, staffDocumentTypes.id],
    }),
  ],
);
