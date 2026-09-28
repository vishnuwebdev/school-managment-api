import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userSessions } from '../../src/db/schema/index.js';
import { code, createHarness, SUPER, type Harness } from '../helpers.js';

/** Rules from the design notes that the first audit found missing. */
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('school lifecycle for platform support', () => {
  it('a suspended school is read-only for platform support; recovery goes through platform actions', async () => {
    const S = await h.provisionSchool();
    await S.root.post(`/platform/tenants/${S.tenantId}/suspend`, { reason: 'Investigation' });
    const support = h.as(S.root.token, S.tenantId);
    expect((await support.get('/members')).status).toBe(200);
    const write = await support.post('/roles', {
      name: 'During suspension',
      permissions: ['members.read'],
    });
    expect(write.status).toBe(403);
    expect(code(write)).toBe('SCHOOL_SUSPENDED');
  });

  it('an archived school can be restored (to SUSPENDED) and then reactivated', async () => {
    const S = await h.provisionSchool();
    await S.root.post(`/platform/tenants/${S.tenantId}/archive`, { reason: 'Closed' });
    const support = h.as(S.root.token, S.tenantId);
    expect(code(await support.post('/roles', { name: 'x', permissions: ['members.read'] }))).toBe(
      'SCHOOL_NOT_ACTIVE',
    );
    expect(
      code(await S.root.post(`/platform/tenants/${S.tenantId}/suspend`, { reason: 'nope' })),
    ).toBe('INVALID_STATE');

    const restored = await S.root.post(`/platform/tenants/${S.tenantId}/restore`, {
      reason: 'Reopened',
    });
    expect(restored.status).toBe(200);
    expect(restored.body.data.status).toBe('SUSPENDED');
    expect(
      (await S.root.post(`/platform/tenants/${S.tenantId}/reactivate`, { reason: 'Back' })).status,
    ).toBe(200);
    expect((await S.admin.api.get('/tenants/current')).status).toBe(200);
  });
});

describe('platform support scoped to selected schools', () => {
  it('SELECTED_TENANTS limits which schools a support admin can enter', async () => {
    const A = await h.provisionSchool();
    const B = await h.provisionSchool();
    const roles = await A.root.get('/platform/roles');
    const support = roles.body.data.find((r: { code: string }) => r.code === 'SUPPORT_ADMIN');
    const email = `support-${Date.now()}@platform.test`;
    const inv = await A.root.post('/platform/users/invitations', {
      email,
      first_name: 'Sup',
      roles: [{ role_id: support.id, scope_type: 'SELECTED_TENANTS', tenant_ids: [A.tenantId] }],
    });
    expect(inv.status).toBe(201);
    const s = await h.acceptAndLogin(email);
    expect((await h.as(s.access_token, A.tenantId).get('/members')).status).toBe(200);
    const denied = await h.as(s.access_token, B.tenantId).get('/members');
    expect(denied.status).toBe(403);
    expect(code(denied)).toBe('TENANT_ACCESS_DENIED');
  });
});

describe('subscriptions', () => {
  it('a downgrade that removes features needs confirmation, and replaced subscriptions are SUPERSEDED', async () => {
    const S = await h.provisionSchool({ plan: 'PREMIUM' });
    const down = await S.root.post(`/platform/tenants/${S.tenantId}/subscriptions`, {
      plan_code: 'STARTER',
      reason: 'Budget cut',
    });
    expect(down.status).toBe(409);
    expect(code(down)).toBe('CONFIRMATION_REQUIRED');
    expect(down.body.error.details.lost_features).toEqual(
      expect.arrayContaining(['transport', 'fees', 'library']),
    );
    expect((await S.admin.api.get('/_probe/transport')).status).toBe(200); // unchanged

    const ok = await S.root.post(`/platform/tenants/${S.tenantId}/subscriptions`, {
      plan_code: 'STARTER',
      reason: 'Budget cut',
      confirm: true,
    });
    expect(ok.status).toBe(201);
    const history = await S.root.get(`/platform/tenants/${S.tenantId}/subscriptions`);
    expect(history.body.data.map((s: { status: string }) => s.status)).toEqual([
      'ACTIVE',
      'SUPERSEDED',
    ]);
    expect(history.body.data[0].currency).toBe('INR');
  });

  it('cancellation is distinct: access continues until the period ends unless immediate', async () => {
    const S = await h.provisionSchool({ trialDays: 0 });
    const res = await S.root.post(`/platform/tenants/${S.tenantId}/subscriptions/cancel`, {
      reason: 'Leaving',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.entitlements.access_mode).toBe('FULL');
    const now = await S.root.post(`/platform/tenants/${S.tenantId}/subscriptions/cancel`, {
      reason: 'again',
    });
    expect(code(now)).toBe('INVALID_STATE'); // nothing active left to cancel
    const history = await S.root.get(`/platform/tenants/${S.tenantId}/subscriptions`);
    expect(history.body.data[0].status).toBe('CANCELLED');
  });

  it('removing a GRANT override that others depend on needs confirmation', async () => {
    const S = await h.provisionSchool({ plan: 'STARTER' });
    // Starter has no timetable; granting it enables subject attendance? (no — needs the feature too)
    await S.root.put(`/platform/tenants/${S.tenantId}/entitlements/overrides/timetable`, {
      effect: 'GRANT',
      reason: 'Pilot',
    });
    await S.root.put(`/platform/tenants/${S.tenantId}/entitlements/overrides/attendance.subject`, {
      effect: 'GRANT',
      reason: 'Pilot',
    });
    const remove = await S.root.delete(
      `/platform/tenants/${S.tenantId}/entitlements/overrides/timetable`,
      { reason: 'Pilot over' },
    );
    expect(code(remove)).toBe('CONFIRMATION_REQUIRED');
    expect(remove.body.error.details.impacted_features).toEqual([
      'attendance.subject',
      'timetable',
    ]);
    const confirmed = await S.root.delete(
      `/platform/tenants/${S.tenantId}/entitlements/overrides/timetable`,
      { reason: 'Pilot over', confirm: true },
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.features).not.toContain('attendance.subject');
  });
});

describe('sessions', () => {
  it('rotation keeps the absolute expiry, and idle sessions cannot be refreshed', async () => {
    const s = await h.login(SUPER.email, SUPER.password);
    const r1 = await h.http.post('/api/v1/auth/refresh').send({ refresh_token: s.refresh_token });
    const [first] = await h.deps.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.id, s.session_id));
    expect(r1.body.data.refresh_expires_at).toBe(first!.expiresAt.toISOString());

    h.clock.advanceDays(8); // beyond REFRESH_IDLE_DAYS (7)
    const idle = await h.http
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: r1.body.data.refresh_token });
    expect(code(idle)).toBe('INVALID_TOKEN');
    expect(idle.body.error.message).toMatch(/inactivity/);
  });
});

describe('API conventions', () => {
  it('honours sort on lists and rejects unknown sort fields', async () => {
    const S = await h.provisionSchool();
    const byName = await S.root.get('/platform/tenants?sort=name&order=asc&page_size=100');
    expect(byName.status).toBe(200);
    const names = byName.body.data.map((t: { name: string }) => t.name);
    expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b)));
    const bad = await S.root.get('/platform/tenants?sort=password_hash');
    expect(code(bad)).toBe('VALIDATION_ERROR');
  });

  it('assigns a request id even when the JSON body is malformed', async () => {
    const res = await h.http
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.error.request_id).toBe(res.headers['x-request-id']);
  });
});
