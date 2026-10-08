import { and, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  permissions,
  rolePermissions,
  tenants,
  type ScopeRef,
  type ScopeType,
} from '../../db/schema/index.js';
import { BusinessRuleError, ValidationError } from '../../shared/errors.js';
import {
  isWideScope,
  PLATFORM_SCOPE_TYPES,
  SCOPE_REF_KEY,
  TENANT_SCOPE_TYPES,
  unsupportedPermissions,
} from './scope-policy.js';

export interface ScopedAssignment {
  roleId: string;
  scopeType?: ScopeType;
  scopeRef?: ScopeRef | null;
}

export interface NormalizedAssignment {
  roleId: string;
  scopeType: ScopeType;
  scopeRef: ScopeRef | null;
}

interface Issue {
  path: string;
  code: string;
  message: string;
  ids?: string[];
}

/**
 * Validate and normalise role assignments before they are stored (D55):
 *  - the scope type is one this context accepts;
 *  - `scope_ref` matches the type (only `section_ids` for ASSIGNED_SECTION,
 *    `class_ids` for ASSIGNED_CLASS, `tenant_ids` for SELECTED_TENANTS; none for
 *    whole-school / own-record) and every id exists in this school (another
 *    school's id is reported exactly like an unknown one);
 *  - a narrower-than-school scope is refused when the role contains permissions
 *    that only work school-wide (OPERATION_NOT_ALLOWED, reason SCOPE_NOT_SUPPORTED).
 * Ids are de-duplicated. A null ref on ASSIGNED_SECTION / ASSIGNED_CLASS means
 * "the sections / classes this person teaches" (resolved from teaching assignments).
 */
export async function normalizeAssignments(
  tx: Executor,
  tenantId: string | null,
  input: ScopedAssignment[],
): Promise<NormalizedAssignment[]> {
  const allowed: readonly ScopeType[] = tenantId ? TENANT_SCOPE_TYPES : PLATFORM_SCOPE_TYPES;
  const fallback: ScopeType = tenantId ? 'ALL_TENANT' : 'ALL_TENANTS';
  const issues: Issue[] = [];

  const out = input.map((a, i): NormalizedAssignment => {
    const path = `roles.${i}`;
    const scopeType = a.scopeType ?? fallback;
    if (!allowed.includes(scopeType)) {
      issues.push({
        path: `${path}.scope_type`,
        code: 'invalid_value',
        message: `Scope ${scopeType} cannot be used here. Use one of: ${allowed.join(', ')}.`,
      });
      return { roleId: a.roleId, scopeType, scopeRef: null };
    }
    const key = SCOPE_REF_KEY[scopeType];
    const ref = a.scopeRef ?? null;
    if (ref === null) {
      if (scopeType === 'SELECTED_TENANTS')
        issues.push({
          path: `${path}.scope_ref`,
          code: 'required',
          message: 'Choose at least one school',
        });
      return { roleId: a.roleId, scopeType, scopeRef: null };
    }
    const keys = Object.keys(ref);
    if (!key || keys.length !== 1 || keys[0] !== key) {
      issues.push({
        path: `${path}.scope_ref`,
        code: 'invalid_value',
        message: key
          ? `Scope ${scopeType} takes only "${key}" (or no reference)`
          : `Scope ${scopeType} takes no reference`,
      });
      return { roleId: a.roleId, scopeType, scopeRef: null };
    }
    const ids = [...new Set(ref[key] ?? [])];
    if (ids.length === 0)
      issues.push({
        path: `${path}.scope_ref.${key}`,
        code: 'too_small',
        message: 'Choose at least one',
      });
    return { roleId: a.roleId, scopeType, scopeRef: { [key]: ids } };
  });

  // Every referenced id must belong to this school (or exist, for platform tenant ids).
  const wanted = (k: string) => [...new Set(out.flatMap((a) => a.scopeRef?.[k] ?? []))];
  const sectionIds = wanted('section_ids');
  const classIds = wanted('class_ids');
  const tenantIds = wanted('tenant_ids');
  const found = new Set<string>();
  if (tenantId && sectionIds.length) {
    const rows = await tx
      .select({ id: academicSections.id })
      .from(academicSections)
      .where(
        and(eq(academicSections.tenantId, tenantId), inArray(academicSections.id, sectionIds)),
      );
    rows.forEach((r) => found.add(r.id));
  }
  if (tenantId && classIds.length) {
    const rows = await tx
      .select({ id: academicClasses.id })
      .from(academicClasses)
      .where(and(eq(academicClasses.tenantId, tenantId), inArray(academicClasses.id, classIds)));
    rows.forEach((r) => found.add(r.id));
  }
  if (!tenantId && tenantIds.length) {
    const rows = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(inArray(tenants.id, tenantIds));
    rows.forEach((r) => found.add(r.id));
  }
  out.forEach((a, i) => {
    for (const [key, ids] of Object.entries(a.scopeRef ?? {})) {
      const unknown = ids.filter((id) => !found.has(id));
      if (unknown.length)
        issues.push({
          path: `roles.${i}.scope_ref.${key}`,
          code: 'not_found',
          message:
            key === 'section_ids'
              ? 'Some sections do not exist in this school'
              : key === 'class_ids'
                ? 'Some classes do not exist in this school'
                : 'Some schools do not exist',
          ids: unknown,
        });
    }
  });
  if (issues.length)
    throw new ValidationError('The role scope is invalid', { location: 'body', issues });

  // A narrower scope must not contain permissions that only work school-wide.
  const narrow = tenantId ? out.filter((a) => !isWideScope(a.scopeType)) : [];
  if (narrow.length) {
    const rows = await tx
      .select({ roleId: rolePermissions.roleId, code: permissions.code })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(
        and(
          inArray(
            rolePermissions.roleId,
            narrow.map((a) => a.roleId),
          ),
          eq(permissions.status, 'ACTIVE'),
        ),
      );
    for (const a of narrow) {
      const codes = rows.filter((r) => r.roleId === a.roleId).map((r) => r.code);
      const unsupported = unsupportedPermissions(codes, a.scopeType);
      if (unsupported.length)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'This role contains permissions that only work for the whole school, so it cannot be limited. Give those permissions through a separate school-wide role.',
          {
            reason: 'SCOPE_NOT_SUPPORTED',
            role_id: a.roleId,
            scope_type: a.scopeType,
            permissions: unsupported,
          },
        );
    }
  }
  return out;
}
