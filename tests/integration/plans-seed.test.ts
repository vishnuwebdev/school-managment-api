import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedCatalog } from '../../src/db/seed.js';
import {
  entitlements,
  featureDependencies,
  features,
  planFeatures,
  plans,
} from '../../src/db/schema/index.js';
import { createHarness, type Harness } from '../helpers.js';

/**
 * Deploying this release onto a database that already has plans and schools:
 * new catalog features join the plans that should have them, schools on those plans
 * get them straight away, and schools that already had custom roles keep managing them.
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

/** Make the database look like it was before `codes` existed in the catalog. */
async function forget(codes: string[]) {
  const db = h.deps.db;
  const rows = await db.select().from(features).where(inArray(features.code, codes));
  const ids = rows.map((r) => r.id);
  await db.delete(entitlements).where(inArray(entitlements.featureId, ids));
  await db.delete(planFeatures).where(inArray(planFeatures.featureId, ids));
  await db.delete(featureDependencies).where(inArray(featureDependencies.featureId, ids));
  await db.delete(features).where(inArray(features.id, ids));
}

describe('seeding over an existing database', () => {
  it('adds new capabilities to the plans and to schools on them, without touching edits', async () => {
    const S = await h.provisionSchool({ plan: 'STANDARD', customRoles: false });
    const root = await h.superAdmin();
    // The super admin renamed the plan: a deploy must not undo that.
    await root.patch('/platform/plans/STANDARD', { name: 'Standard (renamed)', reason: 'Rebrand' });

    await forget(['fees.refunds', 'fees.arrears']);
    await seedCatalog(h.deps.db);

    const std = (await root.get('/platform/plans/STANDARD')).body.data;
    expect(std.name).toBe('Standard (renamed)');
    expect(std.features).toEqual(expect.arrayContaining(['fees.refunds', 'fees.arrears']));
    const ent = (await root.get(`/platform/tenants/${S.tenantId}/entitlements`)).body.data;
    expect(ent.features).toEqual(expect.arrayContaining(['fees.refunds', 'fees.arrears']));

    const [plan] = await h.deps.db.select().from(plans).where(eq(plans.code, 'STANDARD'));
    expect(plan!.name).toBe('Standard (renamed)');
  });

  it('keeps Custom roles for schools that already had custom roles, and only those', async () => {
    const withRoles = await h.provisionSchool({ plan: 'STANDARD' }); // test helper grants the feature
    const created = await withRoles.admin.api.post('/roles', {
      name: 'Existing custom role',
      permissions: ['students.read'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const without = await h.provisionSchool({ plan: 'STANDARD', customRoles: false });

    await forget(['custom_roles']);
    const root = await h.superAdmin();
    expect(
      (await root.get(`/platform/tenants/${withRoles.tenantId}/entitlements`)).body.data.features,
    ).not.toContain('custom_roles');

    await seedCatalog(h.deps.db);

    const feats = async (id: string) =>
      (await root.get(`/platform/tenants/${id}/entitlements`)).body.data.features as string[];
    expect(await feats(withRoles.tenantId)).toContain('custom_roles');
    expect(await feats(without.tenantId)).not.toContain('custom_roles');
    // The top plan includes it as part of the plan.
    expect((await root.get('/platform/plans/PREMIUM')).body.data.features).toContain(
      'custom_roles',
    );
  });
});
