import 'dotenv/config';
import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm';
import { pathToFileURL } from 'node:url';
import { FEATURES } from '../catalog/features.js';
import { PERMISSIONS } from '../catalog/permissions.js';
import { PLANS } from '../catalog/plans.js';
import { resolveSystemRolePermissions, SYSTEM_ROLES } from '../catalog/roles.js';
import { syncPlanVersionEntitlements } from '../modules/entitlements/plan-sync.js';
import { hashPassword } from '../modules/identity/password.js';
import { createDatabase, type Database } from './client.js';
import {
  entitlements,
  featureDependencies,
  features,
  memberships,
  permissions,
  planFeatures,
  plans,
  planVersions,
  rolePermissions,
  roleAssignments,
  roles,
  users,
} from './schema/index.js';

/**
 * Deterministic, idempotent seed of reference data: features, permissions,
 * system roles and plans. Safe to run on every deploy. It never touches
 * tenant business data.
 */
export async function seedCatalog(db: Database) {
  await db.transaction(async (tx) => {
    // ---- Features & dependencies
    const knownFeatureCodes = new Set(
      (await tx.select({ code: features.code }).from(features)).map((r) => r.code),
    );
    for (const [i, f] of FEATURES.entries()) {
      const def = f as (typeof FEATURES)[number] & {
        parent?: string;
        isCore?: boolean;
        description?: string;
      };
      await tx
        .insert(features)
        .values({
          code: def.code,
          name: def.name,
          description: def.description ?? null,
          parentCode: def.parent ?? null,
          isCore: def.isCore ?? false,
          sortOrder: i,
        })
        .onDuplicateKeyUpdate({
          set: {
            name: def.name,
            description: def.description ?? null,
            parentCode: def.parent ?? null,
            isCore: def.isCore ?? false,
            sortOrder: i,
            status: 'ACTIVE',
          },
        });
    }
    const featureRows = await tx.select().from(features);
    const featureId = new Map(featureRows.map((r) => [r.code, r.id]));
    await tx.delete(featureDependencies);
    const deps = FEATURES.flatMap((f) =>
      ((f as { dependsOn?: readonly string[] }).dependsOn ?? []).map((d) => ({
        featureId: featureId.get(f.code)!,
        dependsOnFeatureId: featureId.get(d)!,
      })),
    );
    if (deps.length) await tx.insert(featureDependencies).values(deps);

    // ---- Permissions (codes are never deleted; removed ones are archived)
    for (const [i, p] of PERMISSIONS.entries()) {
      await tx
        .insert(permissions)
        .values({
          code: p.code,
          name: p.name,
          featureCode: p.feature,
          scope: p.scope,
          isSensitive: p.sensitive ?? false,
          sortOrder: i,
        })
        .onDuplicateKeyUpdate({
          set: {
            name: p.name,
            featureCode: p.feature,
            scope: p.scope,
            isSensitive: p.sensitive ?? false,
            sortOrder: i,
            status: 'ACTIVE',
          },
        });
    }
    await tx
      .update(permissions)
      .set({ status: 'ARCHIVED' })
      .where(
        notInArray(
          permissions.code,
          PERMISSIONS.map((p) => p.code),
        ),
      );
    const permRows = await tx.select().from(permissions);
    const permId = new Map(permRows.map((r) => [r.code, r.id]));

    // ---- System roles (definitions are platform-controlled)
    for (const r of SYSTEM_ROLES) {
      await tx
        .insert(roles)
        .values({
          tenantId: null,
          tenantKey: 'SYSTEM',
          code: r.code,
          name: r.name,
          description: r.description,
          roleType: 'SYSTEM',
          scope: r.scope,
        })
        .onDuplicateKeyUpdate({
          set: { name: r.name, description: r.description, scope: r.scope, status: 'ACTIVE' },
        });
      const [role] = await tx
        .select()
        .from(roles)
        .where(and(eq(roles.tenantKey, 'SYSTEM'), eq(roles.code, r.code)));
      const wanted = resolveSystemRolePermissions(r).map((c) => permId.get(c)!);
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, role!.id));
      if (wanted.length)
        await tx
          .insert(rolePermissions)
          .values(wanted.map((pid) => ({ roleId: role!.id, permissionId: pid })));
    }

    // ---- Plans. Created once (version 1); after that the super admin owns name,
    // description, price, limits and features, so a deploy never overwrites them.
    const newFeatureCodes = new Set(
      FEATURES.map((f) => f.code as string).filter((c) => !knownFeatureCodes.has(c)),
    );
    const now = new Date();
    for (const plan of PLANS) {
      let [planRow] = await tx.select().from(plans).where(eq(plans.code, plan.code));
      if (!planRow) {
        await tx
          .insert(plans)
          .values({ code: plan.code, name: plan.name, description: plan.description });
        [planRow] = await tx.select().from(plans).where(eq(plans.code, plan.code));
      }
      const versions = await tx
        .select()
        .from(planVersions)
        .where(eq(planVersions.planId, planRow!.id));
      if (versions.length === 0) {
        const [v] = await tx
          .insert(planVersions)
          .values({
            planId: planRow!.id,
            version: 1,
            currency: plan.currency,
            priceMonthlyMinor: plan.priceMonthlyMinor,
            priceAnnualMinor: plan.priceAnnualMinor,
            effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          })
          .$returningId();
        await tx.insert(planFeatures).values(
          plan.features.map((code) => ({
            planVersionId: v!.id,
            featureId: featureId.get(code)!,
          })),
        );
        continue;
      }
      // Features added to the catalog since this plan was created join it by default.
      const added = plan.features.filter((c) => newFeatureCodes.has(c));
      if (added.length === 0) continue;
      for (const v of versions) {
        const have = new Set(
          (
            await tx
              .select({ id: planFeatures.featureId })
              .from(planFeatures)
              .where(eq(planFeatures.planVersionId, v.id))
          ).map((r) => r.id),
        );
        const missing = added.map((c) => featureId.get(c)!).filter((id) => !have.has(id));
        if (missing.length)
          await tx
            .insert(planFeatures)
            .values(missing.map((id) => ({ planVersionId: v.id, featureId: id })));
      }
      await syncPlanVersionEntitlements(
        tx,
        versions.map((v) => v.id),
        now,
        null,
      );
    }

    // Schools that already had custom roles keep the ability to manage them when
    // Custom roles first becomes a separate feature.
    if (newFeatureCodes.has('custom_roles') && featureId.get('custom_roles')) {
      const withRoles = await tx
        .selectDistinct({ tenantId: roles.tenantId })
        .from(roles)
        .where(
          and(isNotNull(roles.tenantId), eq(roles.status, 'ACTIVE'), eq(roles.roleType, 'CUSTOM')),
        );
      for (const r of withRoles) {
        await tx.insert(entitlements).values({
          tenantId: r.tenantId!,
          featureId: featureId.get('custom_roles')!,
          sourceType: 'CUSTOM_CONTRACT',
          effect: 'GRANT',
          startsAt: now,
          reason: 'Already had custom roles when Custom roles became a separate feature',
        });
      }
    }
  });
}

/** Create (or re-activate) the first platform Super Admin. */
export async function seedSuperAdmin(db: Database, email: string, password: string) {
  const normalized = email.trim().toLowerCase();
  const hash = await hashPassword(password);
  await db.transaction(async (tx) => {
    let [user] = await tx.select().from(users).where(eq(users.email, normalized));
    if (!user) {
      await tx.insert(users).values({
        email: normalized,
        firstName: 'Super',
        lastName: 'Admin',
        passwordHash: hash,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      });
      [user] = await tx.select().from(users).where(eq(users.email, normalized));
    }
    let [membership] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, user!.id), eq(memberships.tenantKey, 'PLATFORM')));
    if (!membership) {
      await tx.insert(memberships).values({
        userId: user!.id,
        tenantId: null,
        tenantKey: 'PLATFORM',
        kind: 'PLATFORM',
        status: 'ACTIVE',
        joinedAt: new Date(),
      });
      [membership] = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.userId, user!.id), eq(memberships.tenantKey, 'PLATFORM')));
    }
    const [role] = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.tenantKey, 'SYSTEM'), eq(roles.code, 'SUPER_ADMIN')));
    const active = await tx
      .select()
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.membershipId, membership!.id),
          eq(roleAssignments.roleId, role!.id),
          inArray(roleAssignments.status, ['ACTIVE']),
        ),
      );
    if (active.length === 0) {
      await tx.insert(roleAssignments).values({
        tenantId: null,
        membershipId: membership!.id,
        roleId: role!.id,
        scopeType: 'ALL_TENANTS',
      });
    }
  });
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const { db, pool } = createDatabase(url);
  await seedCatalog(db);
  if (process.env.REDIS_URL) {
    // System role permissions may have changed: invalidate every cached grant set.
    const { Redis } = await import('ioredis');
    const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
    await redis.incr('ver:system:roles').catch(() => undefined);
    await redis.quit().catch(() => undefined);
  }
  console.log(
    `Seeded ${FEATURES.length} features, ${PERMISSIONS.length} permissions, ${SYSTEM_ROLES.length} system roles, ${PLANS.length} plans`,
  );
  const email = process.env.SEED_SUPER_ADMIN_EMAIL;
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  if (email && password) {
    if (process.env.NODE_ENV === 'production' && password === 'ChangeMe!12345')
      throw new Error('Refusing to seed the example super admin password in production');
    await seedSuperAdmin(db, email, password);
    console.log(`Super admin ready: ${email}`);
  }
  await pool.end();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
