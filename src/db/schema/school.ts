import {
  boolean,
  char,
  date,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt } from './_columns.js';
import { tenants } from './tenancy.js';

export const FILE_PURPOSE = [
  'LOGO',
  'BANNER',
  'DOCUMENT_HEADER',
  'STUDENT_PHOTO',
  'STUDENT_DOCUMENT',
  'STAFF_PHOTO',
  'STAFF_DOCUMENT',
  'STUDENT_CERTIFICATE',
  'PAYMENT_PROOF',
] as const;
export type FilePurpose = (typeof FILE_PURPOSE)[number];

export const BANK_ACCOUNT_TYPE = ['SAVINGS', 'CURRENT', 'OTHER'] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPE)[number];

/** Extra school identity and contact details (§12.1, §12.2). One row per school; versioned with `tenants.version`. */
export const tenantProfiles = mysqlTable('tenant_profiles', {
  tenantId: ref('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  affiliationBoard: varchar('affiliation_board', { length: 64 }),
  affiliationNumber: varchar('affiliation_number', { length: 64 }),
  schoolCode: varchar('school_code', { length: 64 }),
  establishedYear: smallint('established_year'),
  mediumOfInstruction: varchar('medium_of_instruction', { length: 100 }),
  motto: varchar('motto', { length: 200 }),
  about: text('about'),
  secondaryPhone: varchar('secondary_phone', { length: 32 }),
  landline: varchar('landline', { length: 32 }),
  receptionPhone: varchar('reception_phone', { length: 32 }),
  alternateEmail: varchar('alternate_email', { length: 254 }),
  contactPersonName: varchar('contact_person_name', { length: 200 }),
  contactPersonRole: varchar('contact_person_role', { length: 100 }),
  documentFooter: varchar('document_footer', { length: 500 }),
  updatedBy: ref('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Uploaded files. Bytes live in the storage driver; rows are tenant-scoped and never hard-deleted. */
export const files = mysqlTable(
  'files',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    purpose: mysqlEnum('purpose', FILE_PURPOSE).notNull(),
    originalName: varchar('original_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    sizeBytes: int('size_bytes').notNull(),
    checksumSha256: char('checksum_sha256', { length: 64 }).notNull(),
    storageDriver: varchar('storage_driver', { length: 16 }).notNull(),
    storageKey: varchar('storage_key', { length: 255 }).notNull(),
    uploadedBy: ref('uploaded_by'),
    supersededAt: dt('superseded_at'),
    createdAt: createdAt(),
  },
  (t) => [index('files_tenant_purpose_idx').on(t.tenantId, t.purpose, t.createdAt)],
);

/** Bank accounts the school collects fees into. The number is encrypted; only the last 4 digits are stored in clear. */
export const tenantBankAccounts = mysqlTable(
  'tenant_bank_accounts',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    label: varchar('label', { length: 100 }),
    accountHolder: varchar('account_holder', { length: 200 }).notNull(),
    bankName: varchar('bank_name', { length: 200 }).notNull(),
    branchName: varchar('branch_name', { length: 200 }),
    accountNumberEnc: text('account_number_enc').notNull(),
    accountLast4: char('account_last4', { length: 4 }).notNull(),
    fingerprint: char('fingerprint', { length: 64 }).notNull(),
    ifsc: varchar('ifsc', { length: 11 }).notNull(),
    accountType: mysqlEnum('account_type', BANK_ACCOUNT_TYPE).notNull().default('CURRENT'),
    upiId: varchar('upi_id', { length: 100 }),
    isDefault: boolean('is_default').notNull().default(false),
    archivedAt: dt('archived_at'),
    version: int('version').notNull().default(1),
    createdBy: ref('created_by'),
    updatedBy: ref('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('tenant_bank_accounts_tenant_idx').on(t.tenantId, t.archivedAt)],
);

/** Statutory and registration identifiers (PAN, GSTIN, UDISE, …). One row per type per school. */
export const tenantRegistrations = mysqlTable(
  'tenant_registrations',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    typeCode: varchar('type_code', { length: 32 }).notNull(),
    value: varchar('value', { length: 200 }).notNull(),
    issuedOn: date('issued_on', { mode: 'string' }),
    validUntil: date('valid_until', { mode: 'string' }),
    authority: varchar('authority', { length: 200 }),
    updatedBy: ref('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('tenant_registrations_type_uq').on(t.tenantId, t.typeCode)],
);
