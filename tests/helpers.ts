import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app.js';
import { closeDeps, createDeps } from '../src/bootstrap.js';
import { seedSuperAdmin } from '../src/db/seed.js';
import { processEvent, relayOutbox } from '../src/events/processor.js';
import { defineRoute } from '../src/http/route.js';
import { MemoryMailer } from '../src/infrastructure/mail/mailer.js';
import { buildServices } from '../src/services.js';
import type { Clock } from '../src/shared/time.js';

/** A clock tests can move forward (trial expiry, grace periods). */
export class TestClock implements Clock {
  private offsetMs = 0;
  now() {
    return new Date(Date.now() + this.offsetMs);
  }
  advanceDays(days: number) {
    this.offsetMs += days * 86_400_000;
  }
}

/** Probe routes that exercise the permission + entitlement pipeline for business features. */
const probeRoutes = [
  defineRoute({
    method: 'get',
    path: '/_probe/students',
    summary: 'probe',
    tags: ['Test'],
    access: 'tenant',
    permissions: ['students.read'],
    handler: async () => ({ data: 'students-ok' }),
  }),
  defineRoute({
    method: 'get',
    path: '/_probe/transport',
    summary: 'probe',
    tags: ['Test'],
    access: 'tenant',
    permissions: ['transport.read'],
    handler: async () => ({ data: 'transport-ok' }),
  }),
  defineRoute({
    method: 'get',
    path: '/_probe/attendance',
    summary: 'probe',
    tags: ['Test'],
    access: 'tenant',
    permissions: ['attendance.read'],
    handler: async ({ req }) => ({ data: req.ctx.principal!.scopes['attendance.read'] ?? [] }),
  }),
];

export const SUPER = { email: 'root@platform.test', password: 'SuperSecret123' };

let seq = 0;
export const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;
export const code = (res: { body: unknown }) =>
  (res.body as { error?: { code?: string } }).error?.code;

export interface Api {
  token: string;
  get(url: string): request.Test;
  post(url: string, body?: object): request.Test;
  patch(url: string, body?: object): request.Test;
  put(url: string, body?: object): request.Test;
  delete(url: string, body?: object): request.Test;
}

export async function createHarness() {
  const clock = new TestClock();
  const mailer = new MemoryMailer();
  const deps = createDeps({ mailer, clock });
  const svc = buildServices(deps);
  const app = createApp(deps, svc, { extraRoutes: probeRoutes });
  await seedSuperAdmin(deps.db, SUPER.email, SUPER.password);
  const http = request(app);

  /** Run the worker pipeline inline: relay outbox → process events. */
  async function drainOutbox() {
    for (let i = 0; i < 20; i++) {
      const n = await relayOutbox(deps, (event) => processEvent(deps, event.id));
      if (n === 0) return;
    }
  }

  /** Token from the most recent email of a template sent to `to`. */
  function lastToken(to: string, template: 'invitation' | 'password_reset') {
    const msg = [...mailer.sent]
      .reverse()
      .find((m) => m.to === to.toLowerCase() && m.template === template);
    expect(msg, `no ${template} email for ${to}`).toBeTruthy();
    return String(msg!.data.token);
  }

  async function login(email: string, password: string, membershipId?: string) {
    const res = await http
      .post('/api/v1/auth/login')
      .send({ email, password, ...(membershipId ? { membership_id: membershipId } : {}) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data as {
      access_token: string;
      refresh_token: string;
      session_id: string;
      membership: { membership_id: string };
    };
  }

  function as(token: string, tenantId?: string): Api {
    const h = (r: request.Test) => {
      r.set('Authorization', `Bearer ${token}`);
      if (tenantId) r.set('X-Tenant-Id', tenantId);
      return r;
    };
    return {
      token,
      get: (url: string) => h(http.get(`/api/v1${url}`)),
      post: (url: string, body?: object) => h(http.post(`/api/v1${url}`)).send(body ?? {}),
      patch: (url: string, body?: object) => h(http.patch(`/api/v1${url}`)).send(body ?? {}),
      put: (url: string, body?: object) => h(http.put(`/api/v1${url}`)).send(body ?? {}),
      delete: (url: string, body?: object) => h(http.delete(`/api/v1${url}`)).send(body ?? {}),
    };
  }

  async function superAdmin() {
    return as((await login(SUPER.email, SUPER.password)).access_token);
  }

  /** Email → accept (sets password) → login. */
  async function acceptAndLogin(email: string, password = 'Password1234') {
    await drainOutbox();
    const token = lastToken(email, 'invitation');
    const accept = await http.post('/api/v1/auth/invitations/accept').send({ token, password });
    expect(accept.status, JSON.stringify(accept.body)).toBe(200);
    const session = await login(email, password);
    return { ...session, password, api: as(session.access_token) };
  }

  /** Milestone-1 flow: platform creates + provisions a school; the invited admin signs in. */
  async function provisionSchool(
    opts: { plan?: string; trialDays?: number; customRoles?: boolean } = {},
  ) {
    const root = await superAdmin();
    const schoolCode = uniq('school');
    const created = await root.post('/platform/tenants', {
      code: schoolCode,
      name: `School ${schoolCode}`,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const tenantId = created.body.data.id as string;
    const adminEmail = `${schoolCode}-admin@school.test`;
    const prov = await root.post(`/platform/tenants/${tenantId}/provision`, {
      plan_code: opts.plan ?? 'STANDARD',
      trial_days: opts.trialDays ?? 14,
      admin: { email: adminEmail, first_name: 'Admin' },
    });
    expect(prov.status, JSON.stringify(prov.body)).toBe(200);
    // Custom roles is a separate (sellable) feature; most tests need it, so give it
    // to the test school unless the test is about the plan not including it.
    if (opts.customRoles !== false) {
      const grant = await root.put(
        `/platform/tenants/${tenantId}/entitlements/overrides/custom_roles`,
        { effect: 'GRANT', reason: 'Test school uses custom roles' },
      );
      expect(grant.status, JSON.stringify(grant.body)).toBe(200);
    }
    const admin = await acceptAndLogin(adminEmail);
    return { tenantId, code: schoolCode, adminEmail, admin, root };
  }

  /** School admin invites someone with roles; returns their signed-in client. */
  async function addMember(
    adminApi: Api,
    roles: { role_id: string; scope_type?: string; scope_ref?: Record<string, string[]> }[],
  ) {
    const email = `${uniq('user')}@school.test`;
    const res = await adminApi.post('/members/invitations', { email, first_name: 'Member', roles });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const session = await acceptAndLogin(email);
    return { email, membershipId: res.body.data.id as string, ...session };
  }

  async function roleId(api: Api, roleCode: string) {
    const res = await api.get('/roles');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const role = (res.body.data as { id: string; code: string }[]).find((r) => r.code === roleCode);
    expect(role, `role ${roleCode}`).toBeTruthy();
    return role!.id;
  }

  /**
   * A custom copy of a system role holding only the permissions that can be
   * limited to part of the school (scope_support other than TENANT_WIDE, D55),
   * so it can be assigned with ASSIGNED_SECTION / ASSIGNED_CLASS.
   */
  async function scopableRole(api: Api, baseRoleCode: string) {
    const [rolesRes, catalog] = await Promise.all([api.get('/roles'), api.get('/permissions')]);
    expect(rolesRes.status, JSON.stringify(rolesRes.body)).toBe(200);
    expect(catalog.status, JSON.stringify(catalog.body)).toBe(200);
    const base = (rolesRes.body.data as { code: string; permissions: string[] }[]).find(
      (r) => r.code === baseRoleCode,
    );
    expect(base, `role ${baseRoleCode}`).toBeTruthy();
    const wideOnly = new Set(
      (catalog.body.data as { permissions: { code: string; scope_support: string }[] }[])
        .flatMap((g) => g.permissions)
        .filter((p) => p.scope_support === 'TENANT_WIDE')
        .map((p) => p.code),
    );
    const res = await api.post('/roles', {
      name: `${baseRoleCode} (limited) ${uniq('r')}`,
      permissions: base!.permissions.filter((c) => !wideOnly.has(c)),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data.id as string;
  }

  /** Drop cached entitlement snapshots (after moving the test clock). */
  async function flushTenantCache(tenantId: string) {
    await svc.entitlements.invalidate(tenantId);
  }

  return {
    deps,
    svc,
    app,
    http,
    clock,
    mailer,
    drainOutbox,
    lastToken,
    login,
    as,
    superAdmin,
    acceptAndLogin,
    provisionSchool,
    addMember,
    roleId,
    scopableRole,
    flushTenantCache,
    close: () => closeDeps(deps),
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
