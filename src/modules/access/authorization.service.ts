import { and, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Deps } from '../../container.js';
import {
  academicSections,
  academicYears,
  permissions,
  rolePermissions,
  roleAssignments,
  roles,
  sectionClassTeachers,
  subjectOfferings,
  teachers,
  teachingAssignments,
} from '../../db/schema/index.js';
import { cacheKeys } from '../../infrastructure/cache.js';
import type { Principal, ScopeGrant, TenantContext } from '../../platform/context.js';
import { PERMISSIONS } from '../../catalog/permissions.js';
import { AuthorizationError } from '../../shared/errors.js';
import { applyScopePolicy } from './scope-policy.js';

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
      () => this.loadGrants(membershipId, tenantId !== null),
    );
  }

  /**
   * Raw grants of the membership's ACTIVE role assignments. For a school
   * membership (`schoolContext`) the central scope policy is applied (D55): a
   * permission that does not support the assignment's scope is not held.
   */
  async loadGrants(membershipId: string, schoolContext = true): Promise<Grants> {
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
    await this.deriveAssignedScopes(membershipId, scopes);
    const effective = schoolContext ? applyScopePolicy(scopes) : scopes;
    return { permissions: Object.keys(effective).sort(), scopes: effective };
  }

  /**
   * An ASSIGNED_SECTION / ASSIGNED_CLASS grant with no explicit ids means "the
   * sections I am assigned to": the class teacher of a section, or a teacher
   * with an open teaching assignment on it. Resolved here, once per grant load
   * (cached, and dropped whenever assignments change), so every domain module's
   * existing scope check works without knowing about teachers.
   */
  private async deriveAssignedScopes(membershipId: string, scopes: Record<string, ScopeGrant[]>) {
    const wantsDerived = Object.values(scopes).some((list) =>
      list.some(
        (g) => (g.type === 'ASSIGNED_SECTION' || g.type === 'ASSIGNED_CLASS') && g.ref === null,
      ),
    );
    if (!wantsDerived) return;
    const sectionIds = new Set<string>();
    const classIds = new Set<string>();
    const [teacher] = await this.deps.db
      .select({ id: teachers.id, tenantId: teachers.tenantId })
      .from(teachers)
      .where(
        and(
          eq(teachers.membershipId, membershipId),
          inArray(teachers.status, ['ACTIVE', 'ON_LEAVE']),
        ),
      );
    if (teacher) {
      const today = this.deps.clock.now().toISOString().slice(0, 10);
      const db = this.deps.db;
      const liveYear = inArray(academicYears.status, ['ACTIVE', 'UPCOMING']);
      const own = await db
        .select({ id: academicSections.id, classId: academicSections.classId })
        .from(sectionClassTeachers)
        .innerJoin(academicSections, eq(academicSections.id, sectionClassTeachers.sectionId))
        .innerJoin(academicYears, eq(academicYears.id, academicSections.academicYearId))
        .where(
          and(
            eq(sectionClassTeachers.tenantId, teacher.tenantId),
            eq(sectionClassTeachers.teacherId, teacher.id),
            eq(sectionClassTeachers.status, 'ACTIVE'),
            lte(sectionClassTeachers.startDate, today),
            liveYear,
          ),
        );
      for (const r of own) {
        sectionIds.add(r.id);
        classIds.add(r.classId);
      }
      const offerings = await db
        .select({
          sectionId: subjectOfferings.sectionId,
          classId: subjectOfferings.classId,
          yearId: subjectOfferings.academicYearId,
        })
        .from(teachingAssignments)
        .innerJoin(subjectOfferings, eq(subjectOfferings.id, teachingAssignments.subjectOfferingId))
        .innerJoin(academicYears, eq(academicYears.id, subjectOfferings.academicYearId))
        .where(
          and(
            eq(teachingAssignments.tenantId, teacher.tenantId),
            eq(teachingAssignments.teacherId, teacher.id),
            eq(teachingAssignments.status, 'ACTIVE'),
            lte(teachingAssignments.startDate, today),
            liveYear,
          ),
        );
      for (const o of offerings) {
        classIds.add(o.classId);
        if (o.sectionId) {
          sectionIds.add(o.sectionId);
          continue;
        }
        // A class-wide offering covers every section of that class in the year.
        const secs = await db
          .select({ id: academicSections.id })
          .from(academicSections)
          .where(
            and(
              eq(academicSections.tenantId, teacher.tenantId),
              eq(academicSections.classId, o.classId),
              eq(academicSections.academicYearId, o.yearId),
            ),
          );
        for (const sec of secs) sectionIds.add(sec.id);
      }
    }
    for (const list of Object.values(scopes)) {
      for (const g of list) {
        if (g.ref !== null) continue;
        if (g.type === 'ASSIGNED_SECTION') g.ref = { section_ids: [...sectionIds] };
        else if (g.type === 'ASSIGNED_CLASS') g.ref = { class_ids: [...classIds] };
      }
    }
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
