import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs } from '../../src/db/schema/index.js';
import { code, createHarness, type Harness } from '../helpers.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let B: Awaited<ReturnType<Harness['provisionSchool']>>;
let memberOfB: string;

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  B = await h.provisionSchool();
  const teacherB = await h.roleId(B.admin.api, 'TEACHER');
  memberOfB = (await h.addMember(B.admin.api, [{ role_id: teacherB }])).membershipId;
});
afterAll(() => h.close());

describe('tenant isolation — School A can never reach School B', () => {
  it('lists only its own members', async () => {
    const res = await A.admin.api.get('/members?page_size=100');
    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { id: string }) => m.id)).not.toContain(memberOfB);
    expect(
      res.body.data.every((m: { user: { email: string } }) => !m.user.email.startsWith(B.code)),
    ).toBe(true);
  });

  it('treats another school’s ids as not found', async () => {
    expect((await A.admin.api.get(`/members/${memberOfB}`)).status).toBe(404);
    expect((await A.admin.api.put(`/members/${memberOfB}/roles`, { roles: [] })).status).toBe(404);
    expect(
      (await A.admin.api.delete(`/members/${memberOfB}`, { reason: 'cross tenant' })).status,
    ).toBe(404);
    // B's membership is untouched.
    expect((await B.admin.api.get(`/members/${memberOfB}`)).body.data.status).toBe('ACTIVE');
  });

  it('ignores attempts to choose another school via X-Tenant-Id', async () => {
    const res = await h.as(A.admin.access_token, B.tenantId).get('/members');
    expect(res.status).toBe(403);
    expect(code(res)).toBe('TENANT_ACCESS_DENIED');
  });

  it('cannot assign a custom role that belongs to another school', async () => {
    const custom = await B.admin.api.post('/roles', {
      name: 'B Only Role',
      permissions: ['members.read'],
    });
    expect(custom.status).toBe(201);
    const res = await A.admin.api.post('/members/invitations', {
      email: 'cross@school.test',
      first_name: 'X',
      roles: [{ role_id: custom.body.data.id }],
    });
    expect(res.status).toBe(404);
    expect((await A.admin.api.get(`/roles/${custom.body.data.id}`)).status).toBe(404);
  });

  it('keeps audit logs separate', async () => {
    const res = await A.admin.api.get('/audit-logs?page_size=100');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((r: { tenant_id: string }) => r.tenant_id === A.tenantId)).toBe(
      true,
    );
  });

  it('blocks school users from platform routes', async () => {
    const res = await A.admin.api.get('/platform/tenants');
    expect(res.status).toBe(403);
    expect(code(res)).toBe('PERMISSION_DENIED');
  });

  it('lets a platform super admin act inside a school only with an explicit X-Tenant-Id, and audits it', async () => {
    const root = await h.superAdmin();
    const noTenant = await root.get('/members');
    expect(code(noTenant)).toBe('TENANT_ACCESS_DENIED');

    const support = h.as(root.token, B.tenantId);
    const res = await support.get('/members');
    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { id: string }) => m.id)).toContain(memberOfB);

    await support.post(`/members/${memberOfB}/suspend`, { reason: 'Support investigation' });
    const [entry] = await h.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, memberOfB), eq(auditLogs.action, 'MEMBER_SUSPENDED')));
    expect(entry!.tenantId).toBe(B.tenantId);
    expect(entry!.actorType).toBe('PLATFORM_USER');
    await support.post(`/members/${memberOfB}/reactivate`, { reason: 'Done' });
  });

  it('a support admin without platform.tenants.access cannot enter schools', async () => {
    const root = await h.superAdmin();
    const roles = await root.get('/platform/roles');
    const billing = roles.body.data.find((r: { code: string }) => r.code === 'BILLING_ADMIN');
    const email = `billing-${Date.now()}@platform.test`;
    expect(
      (
        await root.post('/platform/users/invitations', {
          email,
          first_name: 'Bill',
          roles: [{ role_id: billing.id }],
        })
      ).status,
    ).toBe(201);
    const billingUser = await h.acceptAndLogin(email);
    const res = await h.as(billingUser.access_token, A.tenantId).get('/members');
    expect(res.status).toBe(403);
    expect(code(res)).toBe('PERMISSION_DENIED');
    // But billing can read subscriptions.
    expect(
      (await billingUser.api.get(`/platform/tenants/${A.tenantId}/subscriptions`)).status,
    ).toBe(200);
    // And cannot suspend schools.
    expect(
      (await billingUser.api.post(`/platform/tenants/${A.tenantId}/suspend`, { reason: 'nope' }))
        .status,
    ).toBe(403);
  });
});
