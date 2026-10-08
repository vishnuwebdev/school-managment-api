import { and, count, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  permissions,
  rolePermissions,
  roleAssignments,
  roles,
  type PermissionScope,
} from '../../db/schema/index.js';
import { recordAudit } from '../../platform/audit.js';
import type { Actor, Principal, ScopeGrant } from '../../platform/context.js';
import { publishEvent } from '../../platform/outbox.js';
import {
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
  AuthorizationError,
  ValidationError,
} from '../../shared/errors.js';
import { adminCount, assertAdminSurvives, lockAdminScope } from './admin-guard.js';
import { scopeOfPermission, type AuthorizationService } from './authorization.service.js';
import { isWideScope, unsupportedPermissions } from './scope-policy.js';
import type { ScopeRef, ScopeType } from '../../db/schema/index.js';

export interface RoleView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  role_type: 'SYSTEM' | 'CUSTOM';
  scope: PermissionScope;
  status: 'ACTIVE' | 'ARCHIVED';
  editable: boolean;
  permissions: string[];
  member_count: number;
  version: number;
}

/**
 * Anti-escalation rule: nobody can grant (or edit a role holding) a permission
 * they do not hold themselves. A school admin can never mint platform authority
 * because tenant roles only accept TENANT-scope permissions.
 */
export function assertCanGrant(principal: Principal, codes: Iterable<string>) {
  const missing = [...codes].filter((c) => !principal.permissions.has(c));
  if (missing.length > 0) {
    throw new AuthorizationError(
      'PERMISSION_DENIED',
      'You cannot grant permissions you do not have',
      { permissions: missing },
    );
  }
}

/**
 * A grantor can only hand out a scope as wide as their own for each
 * permission: someone limited to section 7A cannot grant ALL_TENANT access, or
 * access to section 8B.
 */
export function assertScopeWithin(
  principal: Principal,
  codes: Iterable<string>,
  scopeType: ScopeType,
  scopeRef: ScopeRef | null,
) {
  for (const code of codes) {
    const own: ScopeGrant[] = principal.scopes[code] ?? [];
    if (own.some((g) => g.type === 'ALL_TENANT' || g.type === 'ALL_TENANTS')) continue;
    const covered =
      scopeType !== 'ALL_TENANT' &&
      scopeType !== 'ALL_TENANTS' &&
      own.some((g) => {
        if (g.type !== scopeType) return false;
        if (scopeType === 'OWN_RECORD') return true;
        const entries = Object.entries(scopeRef ?? {});
        return (
          entries.length > 0 &&
          entries.every(([key, values]) => values.every((v) => (g.ref?.[key] ?? []).includes(v)))
        );
      });
    if (!covered) {
      throw new AuthorizationError(
        'PERMISSION_DENIED',
        'You cannot grant access wider than your own',
        { permission: code, scope_type: scopeType },
      );
    }
  }
}

const slug = (name: string) =>
  name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60) || 'ROLE';

export class RoleService {
  constructor(
    private readonly deps: Deps,
    private readonly authz: AuthorizationService,
  ) {}

  /** Roles visible in a context: system roles of that scope + the tenant's custom roles. */
  async list(
    tenantId: string | null,
    opts: { includeArchived?: boolean } = {},
  ): Promise<RoleView[]> {
    const scope: PermissionScope = tenantId ? 'TENANT' : 'PLATFORM';
    const visibility = tenantId
      ? or(isNull(roles.tenantId), eq(roles.tenantId, tenantId))
      : isNull(roles.tenantId);
    const rows = await this.deps.db
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.scope, scope),
          visibility,
          opts.includeArchived ? undefined : eq(roles.status, 'ACTIVE'),
        ),
      )
      .orderBy(roles.roleType, roles.name);
    return this.hydrate(rows, tenantId);
  }

  async get(
    tenantId: string | null,
    roleId: string,
    executor: Executor = this.deps.db,
  ): Promise<RoleView> {
    const row = await this.getRow(tenantId, roleId, executor);
    const [view] = await this.hydrate([row], tenantId, executor);
    return view!;
  }

  private async getRow(tenantId: string | null, roleId: string, executor: Executor = this.deps.db) {
    const scope: PermissionScope = tenantId ? 'TENANT' : 'PLATFORM';
    const [row] = await executor.select().from(roles).where(eq(roles.id, roleId));
    // A role from another tenant is indistinguishable from a missing one.
    if (!row || row.scope !== scope || (row.tenantId !== null && row.tenantId !== tenantId))
      throw new NotFoundError('Role');
    return row;
  }

  private async hydrate(
    rows: (typeof roles.$inferSelect)[],
    tenantId: string | null,
    executor: Executor = this.deps.db,
  ): Promise<RoleView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [perms, counts] = await Promise.all([
      executor
        .select({ roleId: rolePermissions.roleId, code: permissions.code })
        .from(rolePermissions)
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(inArray(rolePermissions.roleId, ids)),
      executor
        .select({ roleId: roleAssignments.roleId, n: count() })
        .from(roleAssignments)
        .where(
          and(
            inArray(roleAssignments.roleId, ids),
            eq(roleAssignments.status, 'ACTIVE'),
            tenantId ? eq(roleAssignments.tenantId, tenantId) : isNull(roleAssignments.tenantId),
          ),
        )
        .groupBy(roleAssignments.roleId),
    ]);
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      role_type: r.roleType,
      scope: r.scope,
      status: r.status,
      editable: r.roleType === 'CUSTOM',
      permissions: perms
        .filter((p) => p.roleId === r.id)
        .map((p) => p.code)
        .sort(),
      member_count: counts.find((c) => c.roleId === r.id)?.n ?? 0,
      version: r.version,
    }));
  }

  private async resolvePermissionIds(executor: Executor, codes: string[], scope: PermissionScope) {
    const unique = [...new Set(codes)];
    const invalid = unique.filter((c) => scopeOfPermission(c) !== scope);
    if (invalid.length)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        `These permissions cannot be used in a ${scope.toLowerCase()} role`,
        { permissions: invalid },
      );
    const rows = await executor
      .select({ id: permissions.id, code: permissions.code })
      .from(permissions)
      .where(and(inArray(permissions.code, unique), eq(permissions.status, 'ACTIVE')));
    if (rows.length !== unique.length) {
      const known = new Set(rows.map((r) => r.code));
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'Unknown permissions', {
        permissions: unique.filter((c) => !known.has(c)),
      });
    }
    return rows;
  }

  async create(
    tenantId: string | null,
    input: { code?: string; name: string; description?: string | null; permissions: string[] },
    principal: Principal,
    actor: Actor,
  ) {
    const scope: PermissionScope = tenantId ? 'TENANT' : 'PLATFORM';
    assertCanGrant(principal, input.permissions);
    try {
      const id = await this.deps.db.transaction(async (tx) => {
        const perms = await this.resolvePermissionIds(tx, input.permissions, scope);
        const [row] = await tx
          .insert(roles)
          .values({
            tenantId,
            tenantKey: tenantId ?? 'SYSTEM',
            code: input.code ?? slug(input.name),
            name: input.name,
            description: input.description ?? null,
            roleType: 'CUSTOM',
            scope,
            createdBy: actor.userId,
          })
          .$returningId();
        if (perms.length)
          await tx
            .insert(rolePermissions)
            .values(perms.map((p) => ({ roleId: row!.id, permissionId: p.id })));
        await recordAudit(tx, actor, {
          tenantId,
          action: 'ROLE_CREATED',
          entityType: 'role',
          entityId: row!.id,
          after: { name: input.name, permissions: perms.map((p) => p.code).sort() },
        });
        await publishEvent(tx, actor, {
          tenantId,
          eventType: 'role.created',
          aggregateType: 'role',
          aggregateId: row!.id,
          payload: { role_id: row!.id, permissions: perms.map((p) => p.code).sort() },
        });
        return row!.id;
      });
      return this.get(tenantId, id);
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw new ConflictError('DUPLICATE_RESOURCE', 'A role with this code already exists', {
          field: 'code',
        });
      throw err;
    }
  }

  async update(
    tenantId: string | null,
    roleId: string,
    input: {
      version: number;
      name?: string;
      description?: string | null;
      permissions?: string[];
      reason?: string;
    },
    principal: Principal,
    actor: Actor,
  ) {
    const result = await this.deps.db.transaction(async (tx) => {
      await lockAdminScope(tx, tenantId);
      const adminsBefore = await adminCount(tx, tenantId);
      const role = await this.getRow(tenantId, roleId, tx);
      if (role.roleType === 'SYSTEM' || role.tenantId !== tenantId)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'System roles cannot be edited. Create a custom role instead.',
        );
      if (role.status !== 'ACTIVE')
        throw new BusinessRuleError('INVALID_STATE', 'Archived roles cannot be edited');
      const before = await this.get(tenantId, roleId, tx);
      // You may only edit roles whose full authority you hold.
      assertCanGrant(principal, before.permissions);

      const [res] = await tx
        .update(roles)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          version: role.version + 1,
        })
        .where(and(eq(roles.id, roleId), eq(roles.version, input.version)));
      if (res.affectedRows !== 1)
        throw new ConflictError('CONFLICT', undefined, { current_version: role.version });

      if (input.permissions) {
        assertCanGrant(principal, input.permissions);
        const perms = await this.resolvePermissionIds(tx, input.permissions, role.scope);
        if (tenantId) await this.assertScopedAssignmentsStillValid(tx, roleId, input.permissions);
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
        if (perms.length)
          await tx
            .insert(rolePermissions)
            .values(perms.map((p) => ({ roleId, permissionId: p.id })));
        await assertAdminSurvives(tx, tenantId, adminsBefore);
      }
      const after = await this.get(tenantId, roleId, tx);
      const added = after.permissions.filter((p) => !before.permissions.includes(p));
      const removed = before.permissions.filter((p) => !after.permissions.includes(p));
      // Permission changes alter what every holder of the role can do: say why (Part 4 §4.20).
      if ((added.length || removed.length) && !input.reason)
        throw new ValidationError("A reason is required when a role's permissions change", {
          location: 'body',
          issues: [
            {
              path: 'reason',
              code: 'required',
              message: "Say why the role's permissions are changing",
            },
          ],
        });
      await recordAudit(tx, actor, {
        tenantId,
        action: added.length || removed.length ? 'ROLE_PERMISSIONS_CHANGED' : 'ROLE_UPDATED',
        entityType: 'role',
        entityId: roleId,
        before: { name: before.name, permissions: before.permissions },
        after: { name: after.name, permissions: after.permissions, added, removed },
        reason: added.length || removed.length ? input.reason : null,
      });
      if (added.length || removed.length) {
        await publishEvent(tx, actor, {
          tenantId,
          eventType: 'role.permissions_changed',
          aggregateType: 'role',
          aggregateId: roleId,
          payload: { role_id: roleId, added, removed },
        });
      }
      return after;
    });
    await this.authz.invalidateTenant(tenantId);
    return result;
  }

  /**
   * A role already given to someone with a narrower-than-school scope cannot gain
   * permissions that only work school-wide (D55): those users would silently not
   * receive them. Change those users' scope first, or use a separate role.
   */
  private async assertScopedAssignmentsStillValid(tx: Executor, roleId: string, codes: string[]) {
    const rows = await tx
      .selectDistinct({ scopeType: roleAssignments.scopeType })
      .from(roleAssignments)
      .where(and(eq(roleAssignments.roleId, roleId), eq(roleAssignments.status, 'ACTIVE')));
    for (const { scopeType } of rows) {
      if (isWideScope(scopeType)) continue;
      const unsupported = unsupportedPermissions(codes, scopeType);
      if (unsupported.length)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'Some users have this role for only part of the school, and these permissions only work for the whole school.',
          {
            reason: 'SCOPE_NOT_SUPPORTED',
            role_id: roleId,
            scope_type: scopeType,
            permissions: unsupported,
          },
        );
    }
  }

  async archive(
    tenantId: string | null,
    roleId: string,
    reason: string,
    principal: Principal,
    actor: Actor,
  ) {
    const result = await this.deps.db.transaction(async (tx) => {
      await lockAdminScope(tx, tenantId);
      const adminsBefore = await adminCount(tx, tenantId);
      const role = await this.getRow(tenantId, roleId, tx);
      if (role.roleType === 'SYSTEM' || role.tenantId !== tenantId)
        throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'System roles cannot be archived');
      if (role.status === 'ARCHIVED')
        throw new BusinessRuleError('INVALID_STATE', 'The role is already archived');
      const view = await this.get(tenantId, roleId, tx);
      assertCanGrant(principal, view.permissions);
      await tx
        .update(roles)
        .set({ status: 'ARCHIVED', version: role.version + 1 })
        .where(eq(roles.id, roleId));
      await assertAdminSurvives(tx, tenantId, adminsBefore);
      await recordAudit(tx, actor, {
        tenantId,
        action: 'ROLE_ARCHIVED',
        entityType: 'role',
        entityId: roleId,
        before: { status: 'ACTIVE', member_count: view.member_count },
        after: { status: 'ARCHIVED' },
        reason,
      });
      // Everyone holding the role loses its permissions now; consumers find them
      // through the role's ACTIVE assignments (kept for history).
      await publishEvent(tx, actor, {
        tenantId,
        eventType: 'role.archived',
        aggregateType: 'role',
        aggregateId: roleId,
        payload: {
          role_id: roleId,
          member_count: view.member_count,
          permissions: view.permissions,
        },
      });
      return this.get(tenantId, roleId, tx);
    });
    await this.authz.invalidateTenant(tenantId);
    return result;
  }

  /**
   * Permission codes per role, for anti-escalation checks. Roles that are not
   * visible in this context (another school's, wrong scope, archived) are
   * reported as not found — never by revealing their permissions.
   */
  async permissionsOfRoles(
    tenantId: string | null,
    roleIds: string[],
    executor: Executor = this.deps.db,
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const ids = [...new Set(roleIds)];
    if (ids.length === 0) return out;
    const scope: PermissionScope = tenantId ? 'TENANT' : 'PLATFORM';
    const found = await executor.select().from(roles).where(inArray(roles.id, ids));
    for (const id of ids) {
      const role = found.find((r) => r.id === id);
      if (!role || role.scope !== scope || (role.tenantId !== null && role.tenantId !== tenantId))
        throw new NotFoundError('Role', { role_id: id });
      out.set(id, []);
    }
    const rows = await executor
      .select({ roleId: rolePermissions.roleId, code: permissions.code })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(inArray(rolePermissions.roleId, ids));
    for (const r of rows) out.get(r.roleId)!.push(r.code);
    return out;
  }
}
