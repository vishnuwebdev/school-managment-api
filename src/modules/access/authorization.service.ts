import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import type { Deps } from '../../container.js';
import { permissions, rolePermissions, roleAssignments, roles } from '../../db/schema/index.js';
import { cacheKeys } from '../../infrastructure/cache.js';
import type { Principal, ScopeGrant, TenantContext } from '../../platform/context.js';
import { PERMISSIONS } from '../../catalog/permissions.js';
import { AuthorizationError } from '../../shared/errors.js';

export interface Grants {
  permissions: string[];
  scopes: Record<string, ScopeGrant[]>;
}

const PERMISSION_FEATURE = new Map(PERMISSIONS.map((p) => [p.code, p.feature]));
const PERMISSION_SCOPE = new Map(PERMISSIONS.map((p) => [p.code, p.scope]));

export const featureOfPermission = (code: string) => PERMISSION_FEATURE.get(code);
export const scopeOfPermission = (code: string) => PERMISSION_SCOPE.get(code);

/**
 * Central authorization. Domain modules call `authorize()` (usually via the
 * route definition) instead of re-implementing RBAC. A decision requires BOTH
 * user authority (permission) AND product access (tenant entitlement).
 */
export class AuthorizationService {
  constructor(private readonly deps: Deps) {}

  /** Effective permissions and scopes for a membership (cached, versioned per tenant). */
  async grantsFor(membershipId: string, tenantId: string | null): Promise<Grants> {
    const [authzVersion, systemVersion] = await Promise.all([
      this.deps.cache.version(cacheKeys.tenantAuthzNamespace(tenantId)),
      this.deps.cache.version(cacheKeys.systemRolesNamespace),
    ]);
    return this.deps.cache.remember(
      cacheKeys.membershipPrincipal(membershipId, authzVersion, systemVersion),
      this.deps.env.CACHE_TTL_SECONDS,
      () => this.loadGrants(membershipId),
    );
  }

  async loadGrants(membershipId: string): Promise<Grants> {
    const now = this.deps.clock.now();
    const rows = await this.deps.db
      .select({
        code: permissions.code,
        scopeType: roleAssignments.scopeType,
        scopeRef: roleAssignments.scopeRef,
      })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(
        and(
          eq(roleAssignments.membershipId, membershipId),
          eq(roleAssignments.status, 'ACTIVE'),
          eq(roles.status, 'ACTIVE'),
          eq(permissions.status, 'ACTIVE'),
          or(isNull(roleAssignments.startsAt), lte(roleAssignments.startsAt, now)),
          or(isNull(roleAssignments.endsAt), gt(roleAssignments.endsAt, now)),
        ),
      );
    const scopes: Record<string, ScopeGrant[]> = {};
    for (const r of rows) {
      const list = (scopes[r.code] ??= []);
      if (
        !list.some(
          (g) =>
            g.type === r.scopeType && JSON.stringify(g.ref) === JSON.stringify(r.scopeRef ?? null),
        )
      ) {
        list.push({ type: r.scopeType, ref: r.scopeRef ?? null });
      }
    }
    return { permissions: Object.keys(scopes).sort(), scopes };
  }

  /** Invalidate cached grants for every membership of a tenant (or platform). */
  async invalidateTenant(tenantId: string | null): Promise<void> {
    await this.deps.cache.bump(cacheKeys.tenantAuthzNamespace(tenantId));
  }

  async invalidateSystemRoles(): Promise<void> {
    await this.deps.cache.bump(cacheKeys.systemRolesNamespace);
  }
}

export function hasPermission(principal: Principal, code: string): boolean {
  return principal.permissions.has(code);
}

/**
 * Throws unless the principal holds every permission AND (in a tenant context)
 * the tenant is entitled to each permission's feature.
 */
export function authorize(
  principal: Principal,
  tenant: TenantContext | undefined,
  required: string[],
): void {
  for (const code of required) {
    if (!principal.permissions.has(code)) {
      throw new AuthorizationError(
        'PERMISSION_DENIED',
        'You do not have permission to perform this operation',
        { permission: code },
      );
    }
    const feature = featureOfPermission(code);
    if (
      tenant &&
      feature &&
      feature !== 'platform' &&
      !tenant.entitlements.features.includes(feature)
    ) {
      if (tenant.entitlements.accessMode !== 'FULL') {
        throw new AuthorizationError(
          'SUBSCRIPTION_EXPIRED',
          'The school subscription has expired. Renew to continue.',
          { feature, grace_ends_at: tenant.entitlements.subscription.graceEndsAt },
        );
      }
      throw new AuthorizationError(
        'FEATURE_NOT_ENABLED',
        'This feature is not enabled for your school',
        { feature },
      );
    }
  }
}

/**
 * Scope grants for a permission. Domain modules use this to narrow queries
 * (e.g. a teacher limited to ASSIGNED_SECTION). ALL_TENANT dominates.
 */
export function scopesFor(principal: Principal, code: string): ScopeGrant[] {
  return principal.scopes[code] ?? [];
}

export function hasTenantWideScope(principal: Principal, code: string): boolean {
  return scopesFor(principal, code).some(
    (g) => g.type === 'ALL_TENANT' || g.type === 'ALL_TENANTS',
  );
}
