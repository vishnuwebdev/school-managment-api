import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxEvents } from '../../src/db/schema/index.js';
import { code, createHarness, uniq, type Harness } from '../helpers.js';

/** Plans & features: the super admin decides what each plan lets a school use. */
let h: Harness;
let root: Awaited<ReturnType<Harness['superAdmin']>>;

beforeAll(async () => {
  h = await createHarness();
  root = await h.superAdmin();
});
afterAll(() => h.close());

const planCode = () =>
  uniq('PLAN')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_');

async function newPlan(features: string[], extra: Record<string, unknown> = {}) {
  const c = planCode();
  const res = await root.post('/platform/plans', {
    code: c,
    name: `Plan ${c}`,
    price_monthly_minor: 100_000,
    price_annual_minor: 1_000_000,
    features,
    reason: 'Test plan',
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return c;
}

async function entitled(tenantId: string) {
  const res = await root.get(`/platform/tenants/${tenantId}/entitlements`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as { features: string[]; limits: { max_staff_users: number | null } };
}

describe('the catalog the super admin edits', () => {
  it('lists plans with limits and school counts, and capabilities under their features', async () => {
    const plans = (await root.get('/platform/plans')).body.data;
    const byCode = Object.fromEntries(plans.map((p: { code: string }) => [p.code, p]));
    expect(Object.keys(byCode)).toEqual(expect.arrayContaining(['STARTER', 'STANDARD', 'PREMIUM']));
    expect(byCode.STANDARD).toMatchObject({ max_staff_users: null, max_students: null });
    expect(byCode.STANDARD.features).toEqual(
      expect.arrayContaining(['fees', 'fees.refunds', 'students.certificates']),
    );
    // Custom roles is sold separately: only the top plan includes it.
    expect(byCode.STANDARD.features).not.toContain('custom_roles');
    expect(byCode.PREMIUM.features).toContain('custom_roles');

    const feats = (await root.get('/platform/features')).body.data;
    const refunds = feats.find((f: { code: string }) => f.code === 'fees.refunds');
    expect(refunds).toMatchObject({
      parent_code: 'fees',
      kind: 'capability',
      depends_on: ['fees'],
    });
    expect(feats.find((f: { code: string }) => f.code === 'fees').kind).toBe('feature');
  });
});

describe('creating and editing plans', () => {
  it('adds what a feature needs, refuses core and unknown features, and rejects duplicates', async () => {
    const c = await newPlan(['fees.refunds']);
    const plan = (await root.get(`/platform/plans/${c}`)).body.data;
    // Refunds needs Fees, which needs Students.
    expect(plan.features).toEqual(['fees', 'fees.refunds', 'students']);

    const core = await root.put(`/platform/plans/${c}/features`, {
      features: ['core', 'students'],
      reason: 'Try core',
    });
    expect(core.status).toBe(422);
    const unknown = await root.put(`/platform/plans/${c}/features`, {
      features: ['no.such.feature'],
      reason: 'Try unknown',
    });
    expect(unknown.status).toBe(422);
    const dup = await root.post('/platform/plans', {
      code: c,
      name: 'Again',
      price_monthly_minor: 1,
      price_annual_minor: 1,
      features: [],
      reason: 'dup',
    });
    expect(dup.status).toBe(409);
    expect(code(dup)).toBe('DUPLICATE_RESOURCE');
  });

  it('only people with plans.manage can change plans, but support can read them', async () => {
    const roles = await root.get('/platform/roles');
    const platformAdmin = roles.body.data.find(
      (r: { code: string }) => r.code === 'PLATFORM_ADMIN',
    );
    const email = `plans-${Date.now()}@platform.test`;
    const inv = await root.post('/platform/users/invitations', {
      email,
      first_name: 'Ops',
      roles: [{ role_id: platformAdmin.id, scope_type: 'ALL_TENANTS' }],
    });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const ops = h.as((await h.acceptAndLogin(email)).access_token);
    expect((await ops.get('/platform/plans')).status).toBe(200);
    const denied = await ops.post('/platform/plans', {
      code: planCode(),
      name: 'No',
      price_monthly_minor: 1,
      price_annual_minor: 1,
      features: [],
      reason: 'nope',
    });
    expect(denied.status).toBe(403);
    expect(code(denied)).toBe('PERMISSION_DENIED');
  });

  it('a feature change applies to schools already on the plan at once, after confirmation', async () => {
    const c = await newPlan(['fees', 'fees.refunds']);
    const S = await h.provisionSchool({ plan: c, customRoles: false });
    expect((await entitled(S.tenantId)).features).toEqual(
      expect.arrayContaining(['fees', 'fees.refunds', 'students']),
    );

    const preview = await root.post(`/platform/plans/${c}/features/preview`, {
      features: ['fees'],
    });
    expect(preview.body.data).toMatchObject({
      added: [],
      removed: ['fees.refunds'],
      schools_affected: 1,
    });
    // Previewing changed nothing.
    expect((await entitled(S.tenantId)).features).toContain('fees.refunds');

    const refused = await root.put(`/platform/plans/${c}/features`, {
      features: ['fees'],
      reason: 'Refunds become an upsell',
    });
    expect(refused.status).toBe(409);
    expect(code(refused)).toBe('CONFIRMATION_REQUIRED');
    expect(refused.body.error.details.removed).toEqual(['fees.refunds']);

    const done = await root.put(`/platform/plans/${c}/features`, {
      features: ['fees'],
      reason: 'Refunds become an upsell',
      confirm: true,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.features).toEqual(['fees', 'students']);
    expect((await entitled(S.tenantId)).features).not.toContain('fees.refunds');
    // The school's own API refuses what the plan no longer includes.
    const refund = await S.admin.api.post('/fees/refunds', {});
    expect(refund.status).toBe(403);
    expect(code(refund)).toBe('FEATURE_NOT_ENABLED');

    // Turning it back on needs no confirmation and reaches the school immediately.
    const back = await root.put(`/platform/plans/${c}/features`, {
      features: ['fees', 'fees.refunds'],
      reason: 'Refunds back in',
    });
    expect(back.status).toBe(200);
    expect((await entitled(S.tenantId)).features).toContain('fees.refunds');

    // The change is recorded and published for later notifications.
    const events = await h.deps.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.eventType, 'plan.features_changed'),
          eq(outboxEvents.aggregateType, 'plan'),
        ),
      );
    const mine = events.filter((e) => (e.payload as { plan_code?: string }).plan_code === c);
    expect(mine).toHaveLength(2);
    expect(mine.map((e) => (e.payload as { removed: string[] }).removed)).toEqual(
      expect.arrayContaining([['fees.refunds'], []]),
    );
  });

  it('a school with an override keeps it when the plan changes', async () => {
    const c = await newPlan(['students']);
    const S = await h.provisionSchool({ plan: c, customRoles: false });
    const grant = await root.put(`/platform/tenants/${S.tenantId}/entitlements/overrides/library`, {
      effect: 'GRANT',
      reason: 'Pilot',
    });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
    await root.put(`/platform/plans/${c}/features`, {
      features: ['students', 'students.certificates'],
      reason: 'Add certificates',
    });
    const now = (await entitled(S.tenantId)).features;
    expect(now).toEqual(expect.arrayContaining(['library', 'students.certificates']));
  });

  it('price changes do not touch a subscription that already started; retiring hides a plan from new schools', async () => {
    const c = await newPlan(['students']);
    const S = await h.provisionSchool({ plan: c, customRoles: false });
    const patch = await root.patch(`/platform/plans/${c}`, {
      name: 'Renamed plan',
      price_monthly_minor: 250_000,
      reason: 'New price list',
    });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.data).toMatchObject({ name: 'Renamed plan', price_monthly_minor: 250_000 });
    const [item] = (await h.deps.db.execute(
      `select final_price_minor as p from subscription_items where tenant_id = '${S.tenantId}' limit 1` as never,
    )) as unknown as { p: number }[][];
    expect(Number(item![0]!.p)).toBe(0); // trial: nothing charged, and not rewritten

    const retired = await root.post(`/platform/plans/${c}/retire`, { reason: 'Replaced' });
    expect(retired.body.data.status).toBe('ARCHIVED');
    // Schools already on it are unaffected.
    expect((await entitled(S.tenantId)).features).toContain('students');
    // A new school cannot be put on it.
    const created = await root.post('/platform/tenants', {
      code: uniq('late'),
      name: 'Late school',
    });
    const prov = await root.post(`/platform/tenants/${created.body.data.id}/provision`, {
      plan_code: c,
      trial_days: 14,
      admin: { email: `late-${Date.now()}@school.test`, first_name: 'Late' },
    });
    expect(prov.status).toBe(404);
    expect(
      (await root.post(`/platform/plans/${c}/restore`, { reason: 'Back' })).body.data.status,
    ).toBe('ACTIVE');
  });
});

describe('Custom roles as a sellable feature', () => {
  it('a school without it can use built-in roles but not create, edit or archive roles', async () => {
    const c = await newPlan(['students']);
    const S = await h.provisionSchool({ plan: c, customRoles: false });
    const api = S.admin.api;
    // Built-in roles still list and can be assigned: inviting users keeps working.
    expect((await api.get('/roles')).status).toBe(200);
    const teacher = await h.roleId(api, 'TEACHER');
    expect((await h.addMember(api, [{ role_id: teacher }])).membershipId).toBeTruthy();

    const create = await api.post('/roles', {
      name: 'Coordinator',
      permissions: ['students.read'],
    });
    expect(create.status).toBe(403);
    expect(code(create)).toBe('FEATURE_NOT_ENABLED');

    // Switching it on for the plan turns it on for the school, with no other change.
    const on = await root.put(`/platform/plans/${c}/features`, {
      features: ['students', 'custom_roles'],
      reason: 'Custom roles paid for',
    });
    expect(on.status).toBe(200);
    const made = await api.post('/roles', { name: 'Coordinator', permissions: ['students.read'] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);

    // Switching it off again keeps the role working for its holders; only changes are blocked.
    const holder = await h.addMember(api, [{ role_id: made.body.data.id }]);
    await root.put(`/platform/plans/${c}/features`, {
      features: ['students'],
      reason: 'Stopped paying',
      confirm: true,
    });
    expect((await holder.api.get('/students')).status).toBe(200);
    const edit = await api.patch(`/roles/${made.body.data.id}`, {
      version: made.body.data.version,
      name: 'Renamed',
    });
    expect(edit.status).toBe(403);
    expect(code(edit)).toBe('FEATURE_NOT_ENABLED');
  });
});

describe('plan limits', () => {
  it('staff users: the limit counts active and invited staff, suspended members free a seat', async () => {
    const c = await newPlan(['students'], { max_staff_users: 2 });
    const S = await h.provisionSchool({ plan: c, customRoles: false });
    const api = S.admin.api;
    expect((await entitled(S.tenantId)).limits.max_staff_users).toBe(2);
    const teacher = await h.roleId(api, 'TEACHER');

    const first = await h.addMember(api, [{ role_id: teacher }]); // admin + 1 = 2
    const over = await api.post('/members/invitations', {
      email: `over-${Date.now()}@school.test`,
      first_name: 'Over',
      roles: [{ role_id: teacher }],
    });
    expect(over.status).toBe(422);
    expect(code(over)).toBe('PLAN_LIMIT_REACHED');
    expect(over.body.error.details).toMatchObject({ limit_type: 'STAFF_USERS', limit: 2, used: 2 });

    // Suspending frees the seat; reactivating needs one again.
    await api.post(`/members/${first.membershipId}/suspend`, { reason: 'Leave' });
    const second = await h.addMember(api, [{ role_id: teacher }]);
    const back = await api.post(`/members/${first.membershipId}/reactivate`, { reason: 'Back' });
    expect(back.status).toBe(422);
    expect(code(back)).toBe('PLAN_LIMIT_REACHED');

    // Raising the limit takes effect immediately for the school.
    const raise = await root.patch(`/platform/plans/${c}`, {
      max_staff_users: 5,
      reason: 'Upgrade',
    });
    expect(raise.status, JSON.stringify(raise.body)).toBe(200);
    expect((await entitled(S.tenantId)).limits.max_staff_users).toBe(5);
    expect(
      (await api.post(`/members/${first.membershipId}/reactivate`, { reason: 'Back' })).status,
    ).toBe(200);
    void second;

    // Unlimited again.
    await root.patch(`/platform/plans/${c}`, { max_staff_users: null, reason: 'Unlimited' });
    expect((await entitled(S.tenantId)).limits.max_staff_users).toBeNull();
  });

  it('students: admitted and active students count; applicants and the limit message are clear', async () => {
    const c = await newPlan(['students'], { max_students: 1 });
    const S = await h.provisionSchool({ plan: c, customRoles: false });
    const api = S.admin.api;
    const make = (n: string) =>
      api.post('/students', { first_name: n, last_name: uniq('Fam'), gender: 'FEMALE' });
    const one = await make('One');
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    const two = await make('Two');
    expect(two.status).toBe(422);
    expect(code(two)).toBe('PLAN_LIMIT_REACHED');
    expect(two.body.error.details).toMatchObject({ limit_type: 'STUDENTS', limit: 1, used: 1 });
    expect(two.body.error.message).toMatch(/plan allows 1 students/);
  });
});
