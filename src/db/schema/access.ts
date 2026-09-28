import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt, version } from './_columns.js';
import {
  ASSIGNMENT_STATUS,
  PERMISSION_SCOPE,
  RECORD_STATUS,
  ROLE_TYPE,
  SCOPE_TYPE,
} from './enums.js';
import { memberships } from './identity.js';
import { tenants } from './tenancy.js';

/** Stable authorization contract. Seeded from src/catalog/permissions.ts. */
export const permissions = mysqlTable(
  'permissions',
  {
    id: id(),
    code: varchar('code', { length: 100 }).notNull(),
    name: varchar('name', { length: 150 }).notNull(),
    description: varchar('description', { length: 500 }),
    /** Feature the permission belongs to; used for entitlement gating and UI grouping. */
    featureCode: varchar('feature_code', { length: 64 }).notNull(),
    scope: mysqlEnum('scope', PERMISSION_SCOPE).notNull(),
    isSensitive: boolean('is_sensitive').notNull().default(false),
    status: mysqlEnum('status', RECORD_STATUS).notNull().default('ACTIVE'),
    sortOrder: int('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('permissions_code_uq').on(t.code),
    index('permissions_feature_idx').on(t.featureCode),
  ],
);

/**
 * Roles are permission bundles. System and platform roles have tenant_id NULL
 * (tenant_key = 'SYSTEM'); custom roles belong to one tenant.
 */
export const roles = mysqlTable(
  'roles',
  {
    id: id(),
    tenantId: ref('tenant_id').references(() => tenants.id),
    tenantKey: varchar('tenant_key', { length: 36 }).notNull(),
    code: varchar('code', { length: 64 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    description: varchar('description', { length: 500 }),
    roleType: mysqlEnum('role_type', ROLE_TYPE).notNull(),
    scope: mysqlEnum('scope', PERMISSION_SCOPE).notNull(),
    status: mysqlEnum('status', RECORD_STATUS).notNull().default('ACTIVE'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('roles_tenant_code_uq').on(t.tenantKey, t.code),
    index('roles_tenant_status_idx').on(t.tenantId, t.status),
  ],
);

export const rolePermissions = mysqlTable(
  'role_permissions',
  {
    roleId: ref('role_id')
      .notNull()
      .references(() => roles.id),
    permissionId: ref('permission_id')
      .notNull()
      .references(() => permissions.id),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'role_permissions_pk', columns: [t.roleId, t.permissionId] }),
    index('role_permissions_permission_idx').on(t.permissionId),
  ],
);

export type ScopeRef = Record<string, string[]>;

export const roleAssignments = mysqlTable(
  'role_assignments',
  {
    id: id(),
    tenantId: ref('tenant_id').references(() => tenants.id),
    membershipId: ref('membership_id')
      .notNull()
      .references(() => memberships.id),
    roleId: ref('role_id')
      .notNull()
      .references(() => roles.id),
    scopeType: mysqlEnum('scope_type', SCOPE_TYPE).notNull().default('ALL_TENANT'),
    /** e.g. { "section_ids": ["..."] } — interpreted by the owning domain. */
    scopeRef: json('scope_ref').$type<ScopeRef>(),
    status: mysqlEnum('status', ASSIGNMENT_STATUS).notNull().default('ACTIVE'),
    startsAt: dt('starts_at'),
    endsAt: dt('ends_at'),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('role_assignments_membership_idx').on(t.membershipId, t.status),
    index('role_assignments_tenant_role_idx').on(t.tenantId, t.roleId),
  ],
);
