import { boolean, int, mysqlEnum, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { createdAt, id, ref, updatedAt } from './_columns.js';
import { tenants } from './tenancy.js';

export const STAFF_LOOKUP_KIND = ['DEPARTMENT', 'DESIGNATION'] as const;
export type StaffLookupKind = (typeof STAFF_LOOKUP_KIND)[number];

/**
 * The school's managed lists of departments and designations. Teachers keep
 * the plain text value (so history stays readable); the list only drives the
 * pickers and validates new values.
 */
export const staffLookups = mysqlTable(
  'staff_lookups',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: mysqlEnum('kind', STAFF_LOOKUP_KIND).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: int('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('staff_lookups_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('staff_lookups_tenant_kind_name_uq').on(t.tenantId, t.kind, t.name),
  ],
);
