import {
  char,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  tinyint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt, version } from './_columns.js';
import { SCHOOL_REQUEST_STATUS, TENANT_STATUS } from './enums.js';

/** Tenant = School in V1. Profile lives here; configuration lives in tenant_settings. */
export const tenants = mysqlTable(
  'tenants',
  {
    id: id(),
    code: varchar('code', { length: 64 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    shortName: varchar('short_name', { length: 64 }),
    schoolType: varchar('school_type', { length: 64 }),
    status: mysqlEnum('status', TENANT_STATUS).notNull().default('APPROVED'),
    contactEmail: varchar('contact_email', { length: 254 }),
    contactPhone: varchar('contact_phone', { length: 32 }),
    addressLine1: varchar('address_line1', { length: 200 }),
    addressLine2: varchar('address_line2', { length: 200 }),
    city: varchar('city', { length: 100 }),
    state: varchar('state', { length: 100 }),
    postalCode: varchar('postal_code', { length: 20 }),
    country: char('country', { length: 2 }),
    version: version(),
    activatedAt: dt('activated_at'),
    suspendedAt: dt('suspended_at'),
    archivedAt: dt('archived_at'),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tenants_code_uq').on(t.code),
    index('tenants_status_idx').on(t.status),
    index('tenants_created_at_idx').on(t.createdAt),
  ],
);

export const tenantSettings = mysqlTable('tenant_settings', {
  tenantId: ref('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Kolkata'),
  locale: varchar('locale', { length: 16 }).notNull().default('en-IN'),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  dateFormat: varchar('date_format', { length: 20 }).notNull().default('DD/MM/YYYY'),
  /** 0 = Sunday, 1 = Monday */
  weekStartsOn: tinyint('week_starts_on').notNull().default(1),
  workingDays: json('working_days').$type<string[]>().notNull(),
  academicYearStartMonth: tinyint('academic_year_start_month').notNull().default(4),
  brandPrimaryColor: varchar('brand_primary_color', { length: 9 }),
  brandSecondaryColor: varchar('brand_secondary_color', { length: 9 }),
  brandAccentColor: varchar('brand_accent_color', { length: 9 }),
  logoFileId: ref('logo_file_id'),
  bannerFileId: ref('banner_file_id'),
  documentHeaderFileId: ref('document_header_file_id'),
  version: version(),
  updatedBy: ref('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tenantStatusHistory = mysqlTable(
  'tenant_status_history',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    fromStatus: mysqlEnum('from_status', TENANT_STATUS),
    toStatus: mysqlEnum('to_status', TENANT_STATUS).notNull(),
    reason: varchar('reason', { length: 500 }),
    actorUserId: ref('actor_user_id'),
    createdAt: createdAt(),
  },
  (t) => [index('tenant_status_history_tenant_idx').on(t.tenantId, t.createdAt)],
);

/** A request is not a school. Approval creates the tenant in status APPROVED. */
export const schoolRequests = mysqlTable(
  'school_requests',
  {
    id: id(),
    schoolName: varchar('school_name', { length: 200 }).notNull(),
    contactName: varchar('contact_name', { length: 200 }).notNull(),
    contactEmail: varchar('contact_email', { length: 254 }).notNull(),
    contactPhone: varchar('contact_phone', { length: 32 }),
    city: varchar('city', { length: 100 }),
    country: char('country', { length: 2 }),
    message: text('message'),
    status: mysqlEnum('status', SCHOOL_REQUEST_STATUS).notNull().default('PENDING'),
    reviewedBy: ref('reviewed_by'),
    reviewedAt: dt('reviewed_at'),
    reviewNote: varchar('review_note', { length: 500 }),
    tenantId: ref('tenant_id').references(() => tenants.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('school_requests_status_idx').on(t.status, t.createdAt),
    uniqueIndex('school_requests_tenant_uq').on(t.tenantId),
  ],
);
