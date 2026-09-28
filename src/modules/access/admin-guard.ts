import { and, eq, ne, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import {
  memberships,
  permissions,
  rolePermissions,
  roleAssignments,
  roles,
  tenants,
} from '../../db/schema/index.js';
import { BusinessRuleError } from '../../shared/errors.js';

/** Holding this permission makes someone an administrator of a school. */
export const TENANT_ADMIN_PERMISSION = 'roles.assign';
/** …and this one, of the platform. */
export const PLATFORM_ADMIN_PERMISSION = 'platform.users.manage';

const contextFilter = (tenantId: string | null) =>
  tenantId ? eq(memberships.tenantId, tenantId) : eq(memberships.tenantKey, 'PLATFORM');

/**
 * Serialize every change that can reduce the number of administrators in a
 * context (role edits, assignments, suspensions, removals). Without this, two
 * admins demoting each other concurrently could both pass the last-admin check.
 */
export async function lockAdminScope(tx: Executor, tenantId: string | null): Promise<void> {
  if (tenantId) {
    await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
  } else {
    await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.tenantKey, 'PLATFORM'))
      .for('update');
  }
}

/** ACTIVE memberships holding the admin permission through an ACTIVE role assignment. */
export async function adminCount(
  tx: Executor,
  tenantId: string | null,
  excludeMembershipId?: string,
): Promise<number> {
  const code = tenantId ? TENANT_ADMIN_PERMISSION : PLATFORM_ADMIN_PERMISSION;
  const [row] = await tx
    .select({ n: sql<number>`count(distinct ${memberships.id})` })
    .from(memberships)
    .innerJoin(
      roleAssignments,
      and(eq(roleAssignments.membershipId, memberships.id), eq(roleAssignments.status, 'ACTIVE')),
    )
    .innerJoin(roles, and(eq(roles.id, roleAssignments.roleId), eq(roles.status, 'ACTIVE')))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .innerJoin(
      permissions,
      and(
        eq(permissions.id, rolePermissions.permissionId),
        eq(permissions.code, code),
        eq(permissions.status, 'ACTIVE'),
      ),
    )
    .where(
      and(
        contextFilter(tenantId),
        eq(memberships.status, 'ACTIVE'),
        excludeMembershipId ? ne(memberships.id, excludeMembershipId) : undefined,
      ),
    );
  return Number(row?.n ?? 0);
}

/** Call after the change, inside the same (locked) transaction. */
export async function assertAdminSurvives(
  tx: Executor,
  tenantId: string | null,
  before: number,
): Promise<void> {
  if (before > 0 && (await adminCount(tx, tenantId)) === 0) {
    throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'At least one administrator must remain');
  }
}
