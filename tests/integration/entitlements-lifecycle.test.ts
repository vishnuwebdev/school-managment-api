import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, type Harness } from '../helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('entitlements — permission AND tenant entitlement are both required', () => {
  it('denies a permitted action when the plan lacks the feature, and follows overrides and plan changes', async () => {
    const S = await h.provisionSchool({ plan: 'STANDARD' });
    // School Admin holds transport.read, but STANDARD has no transport.
    const denied = await S.admin.api.get('/_probe/transport');
    expect(denied.status).toBe(403);
    expect(code(denied)).toBe('FEATURE_NOT_ENABLED');
    expect(denied.body.error.details.feature).toBe('transport');

    const grant = await S.root.put(
      `/platform/tenants/${S.tenantId}/entitlements/overrides/transport`,
      { effect: 'GRANT', reason: 'Pilot' },
    );
    expect(grant.status).toBe(200);
    expect(grant.body.data.features).toContain('transport');
    expect((await S.admin.api.get('/_probe/transport')).status).toBe(200);

    expect(
      (
        await S.root.delete(`/platform/tenants/${S.tenantId}/entitlements/overrides/transport`, {
          reason: 'Pilot over',
        })
      ).status,
    ).toBe(200);
    expect(code(await S.admin.api.get('/_probe/transport'))).toBe('FEATURE_NOT_ENABLED');

    const upgrade = await S.root.post(`/platform/tenants/${S.tenantId}/subscriptions`, {
      plan_code: 'PREMIUM',
      status: 'ACTIVE',
      billing_interval: 'ANNUAL',
      reason: 'Upgrade',
    });
    expect(upgrade.status).toBe(201);
    expect((await S.admin.api.get('/_probe/transport')).status).toBe(200);

    const history = await S.root.get(`/platform/tenants/${S.tenantId}/subscriptions`);
    expect(
      history.body.data.map(
        (s: { status: string; plan: { code: string } }) => `${s.plan.code}:${s.status}`,
      ),
    ).toEqual(['PREMIUM:ACTIVE', 'STANDARD:SUPERSEDED']);
  });

  it('never cascades dependency changes silently', async () => {
    const S = await h.provisionSchool({ plan: 'STANDARD' });
    const attempt = await S.root.put(
      `/platform/tenants/${S.tenantId}/entitlements/overrides/students`,
      { effect: 'DENY', reason: 'Test' },
    );
    expect(attempt.status).toBe(409);
    expect(code(attempt)).toBe('CONFIRMATION_REQUIRED');
    expect(attempt.body.error.details.impacted_features).toEqual(
      expect.arrayContaining(['attendance', 'fees', 'examinations', 'parent_portal']),
    );
    expect((await S.admin.api.get('/_probe/students')).status).toBe(200); // nothing changed yet

    const confirmed = await S.root.put(
      `/platform/tenants/${S.tenantId}/entitlements/overrides/students`,
      { effect: 'DENY', reason: 'Test', confirm: true },
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.features).not.toContain('attendance');
    expect(confirmed.body.data.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: 'attendance', reason: 'DEPENDENCY_MISSING' }),
      ]),
    );
    expect(code(await S.admin.api.get('/_probe/students'))).toBe('FEATURE_NOT_ENABLED');
    expect(code(await S.admin.api.get('/_probe/attendance'))).toBe('FEATURE_NOT_ENABLED');

    const core = await S.root.put(`/platform/tenants/${S.tenantId}/entitlements/overrides/core`, {
      effect: 'DENY',
      reason: 'not allowed',
      confirm: true,
    });
    expect(code(core)).toBe('OPERATION_NOT_ALLOWED');
  });
});

describe('school lifecycle is separate from subscription lifecycle', () => {
  it('suspension blocks members but not platform support, and archive is terminal', async () => {
    const S = await h.provisionSchool();
    expect(
      (await S.root.post(`/platform/tenants/${S.tenantId}/suspend`, { reason: 'Unpaid invoices' }))
        .status,
    ).toBe(200);
    const blocked = await S.admin.api.get('/tenants/current');
    expect(blocked.status).toBe(403);
    expect(code(blocked)).toBe('SCHOOL_SUSPENDED');
    // /auth/me still works so the app can explain what happened.
    const me = await S.admin.api.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.membership.tenant.status).toBe('SUSPENDED');
    expect((await h.as(S.root.token, S.tenantId).get('/members')).status).toBe(200);

    expect(
      (await S.root.post(`/platform/tenants/${S.tenantId}/reactivate`, { reason: 'Paid' })).status,
    ).toBe(200);
    expect((await S.admin.api.get('/tenants/current')).status).toBe(200);

    expect(
      (await S.root.post(`/platform/tenants/${S.tenantId}/archive`, { reason: 'Closed' })).status,
    ).toBe(200);
    const revive = await S.root.post(`/platform/tenants/${S.tenantId}/reactivate`, {
      reason: 'Oops',
    });
    expect(revive.status).toBe(422);
    expect(code(revive)).toBe('INVALID_STATE');
    const history = await S.root.get(`/platform/tenants/${S.tenantId}/status-history`);
    expect(history.body.data.map((x: { to_status: string }) => x.to_status)).toEqual([
      'ARCHIVED',
      'ACTIVE',
      'SUSPENDED',
      'ACTIVE',
      'PROVISIONING',
      'APPROVED',
    ]);
  });

  it('expired trial: grace period for admins only, then locked; data preserved', async () => {
    const S = await h.provisionSchool({ trialDays: 7 });
    const teacherRole = await h.roleId(S.admin.api, 'TEACHER');
    const teacher = await h.addMember(S.admin.api, [{ role_id: teacherRole }]);
    expect((await teacher.api.get('/_probe/students')).status).toBe(200);

    h.clock.advanceDays(8); // trial over → grace
    await h.flushTenantCache(S.tenantId);

    const sub = await S.admin.api.get('/tenants/current/subscription');
    expect(sub.status).toBe(200);
    expect(sub.body.data.entitlements.access_mode).toBe('GRACE');
    const adminOps = await S.admin.api.get('/_probe/students');
    expect(code(adminOps)).toBe('SUBSCRIPTION_EXPIRED');
    expect(code(await teacher.api.get('/_probe/students'))).toBe('SUBSCRIPTION_EXPIRED');
    expect(code(await teacher.api.get('/members'))).toBe('SUBSCRIPTION_EXPIRED');

    h.clock.advanceDays(31); // grace exhausted → locked
    await h.flushTenantCache(S.tenantId);
    // (The 30-day refresh sessions have also expired by now, so sign in again.)
    expect(code(await S.admin.api.get('/tenants/current'))).toBe('INVALID_TOKEN');
    const admin = h.as((await h.login(S.adminEmail, S.admin.password)).access_token);
    expect(code(await admin.get('/tenants/current/subscription'))).toBe('SUBSCRIPTION_EXPIRED');

    // Renewal restores everything; nothing was deleted.
    const root = await h.superAdmin();
    const renew = await root.post(`/platform/tenants/${S.tenantId}/subscriptions`, {
      plan_code: 'STANDARD',
      status: 'ACTIVE',
      reason: 'Renewed',
    });
    expect(renew.status).toBe(201);
    const teacherAgain = h.as((await h.login(teacher.email, teacher.password)).access_token);
    expect((await teacherAgain.get('/_probe/students')).status).toBe(200);
    expect((await admin.get('/members')).body.meta.total).toBe(2);
  });

  it('rejects stale settings updates (optimistic concurrency)', async () => {
    const S = await h.provisionSchool();
    const current = await S.admin.api.get('/tenants/current/settings');
    const v = current.body.data.version;
    expect(
      (
        await S.admin.api.patch('/tenants/current/settings', {
          version: v,
          timezone: 'Africa/Johannesburg',
          currency: 'ZAR',
        })
      ).status,
    ).toBe(200);
    const stale = await S.admin.api.patch('/tenants/current/settings', {
      version: v,
      locale: 'en-ZA',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.current_version).toBe(v + 1);
    const bad = await S.admin.api.patch('/tenants/current/settings', {
      version: v + 1,
      timezone: 'Mars/Olympus',
    });
    expect(code(bad)).toBe('VALIDATION_ERROR');
  });
});
