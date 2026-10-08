import { PERMISSIONS, type ScopeSupport } from '../../catalog/permissions.js';
import type { ScopeType } from '../../db/schema/index.js';
import type { ScopeGrant } from '../../platform/context.js';

/**
 * Central scope policy (D55). Every tenant permission declares how a grant
 * narrower than the whole school applies to it (`scopeSupport` in the catalog).
 * The policy is applied once, when a membership's grants are loaded, so a
 * module that never looks at scope cannot silently widen a section-limited
 * grant to the whole school.
 */

const SUPPORT = new Map(PERMISSIONS.map((p) => [p.code, p.scopeSupport]));
const PERMISSION_SCOPE = new Map(PERMISSIONS.map((p) => [p.code, p.scope]));

/** Scope types a school role assignment may carry. */
export const TENANT_SCOPE_TYPES = [
  'ALL_TENANT',
  'ASSIGNED_SECTION',
  'ASSIGNED_CLASS',
  'OWN_RECORD',
] as const satisfies readonly ScopeType[];
export type TenantScopeType = (typeof TENANT_SCOPE_TYPES)[number];

/** Scope types a platform role assignment may carry. */
export const PLATFORM_SCOPE_TYPES = [
  'ALL_TENANTS',
  'SELECTED_TENANTS',
] as const satisfies readonly ScopeType[];

/** The only scope_ref key each narrower type accepts (null ref = derived / none). */
export const SCOPE_REF_KEY: Partial<Record<ScopeType, string>> = {
  ASSIGNED_SECTION: 'section_ids',
  ASSIGNED_CLASS: 'class_ids',
  SELECTED_TENANTS: 'tenant_ids',
};

const WIDE: ReadonlySet<string> = new Set(['ALL_TENANT', 'ALL_TENANTS']);

export const scopeSupportOf = (code: string): ScopeSupport => SUPPORT.get(code) ?? 'TENANT_WIDE';

export const isWideScope = (type: string) => WIDE.has(type);

/** Does a grant of `type` confer this permission? */
export function supportsScope(support: ScopeSupport, type: ScopeType): boolean {
  if (WIDE.has(type)) return true;
  switch (support) {
    case 'TENANT_WIDE':
      return false;
    case 'NEUTRAL':
    case 'OWN':
      return true;
    case 'PLACEMENT':
      return type === 'ASSIGNED_SECTION' || type === 'ASSIGNED_CLASS';
  }
}

/** Permissions of a role that a `scopeType` assignment would not confer. */
export function unsupportedPermissions(codes: Iterable<string>, scopeType: ScopeType): string[] {
  return [...new Set(codes)]
    .filter((c) => PERMISSION_SCOPE.get(c) === 'TENANT')
    .filter((c) => !supportsScope(scopeSupportOf(c), scopeType))
    .sort();
}

/**
 * Effective grants of a school membership. Tenant permissions keep only the
 * grants their scope support accepts; NEUTRAL ones become school-wide; a
 * permission left without grants is not held. Platform permissions are
 * returned unchanged (they never appear on school memberships).
 */
export function applyScopePolicy(
  scopes: Readonly<Record<string, ScopeGrant[]>>,
): Record<string, ScopeGrant[]> {
  const out: Record<string, ScopeGrant[]> = {};
  for (const [code, grants] of Object.entries(scopes)) {
    if (PERMISSION_SCOPE.get(code) !== 'TENANT') {
      out[code] = grants;
      continue;
    }
    const support = scopeSupportOf(code);
    const kept = grants.filter((g) => supportsScope(support, g.type));
    if (kept.length === 0) continue;
    out[code] =
      support === 'NEUTRAL' || kept.some((g) => WIDE.has(g.type))
        ? [{ type: 'ALL_TENANT', ref: null }]
        : kept;
  }
  return out;
}

/**
 * A platform user inside a school they were allowed to enter (ALL_TENANTS, or
 * SELECTED_TENANTS that includes it): their tenant permissions apply to the
 * whole of that school.
 */
export function platformGrantsInSchool(
  scopes: Readonly<Record<string, ScopeGrant[]>>,
  tenantPermissions: Iterable<string>,
): Record<string, ScopeGrant[]> {
  const out: Record<string, ScopeGrant[]> = {};
  for (const code of tenantPermissions) {
    if (scopes[code]?.length) out[code] = [{ type: 'ALL_TENANT', ref: null }];
  }
  return out;
}
