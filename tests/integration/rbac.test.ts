import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, type Harness } from '../helpers.js';

let h: Harness;
let S: Awaited<ReturnType<Harness['provisionSchool']>>;

beforeAll(async () => {
  h = await createHarness();
  S = await h.provisionSchool();
});
afterAll(() => h.close());

describe('RBAC — roles are data, permissions are the contract', () => {
  it('a Sub Admin custom role grants exactly what the main admin chose', async () => {
    const role = await S.admin.api.post('/roles', {
      name: 'Sub Admin',
      permissions: ['members.read', 'tenant.profile.read'],
    });
    expect(role.status).toBe(201);
    expect(role.body.data.code).toBe('SUB_ADMIN');
    expect(role.body.data.role_type).toBe('CUSTOM');

    const sub = await h.addMember(S.admin.api, [{ role_id: role.body.data.id }]);
    expect((await sub.api.get('/members')).status).toBe(200);
    const denied = await sub.api.post('/members/invitations', {
      email: 'x@school.test',
      first_name: 'X',
      roles: [{ role_id: role.body.data.id }],
    });
    expect(denied.status).toBe(403);
    expect(code(denied)).toBe('PERMISSION_DENIED');
    expect(denied.body.error.details.permission).toBe('members.invite');

    // Granting a permission takes effect on the next request (cache invalidated).
    const upd = await S.admin.api.patch(`/roles/${role.body.data.id}`, {
      version: role.body.data.version,
      permissions: ['members.read', 'tenant.profile.read', 'tenant.settings.read'],
    });
    expect(upd.status).toBe(200);
    expect(upd.body.data.permissions).toContain('tenant.settings.read');
    expect((await sub.api.get('/tenants/current/settings')).status).toBe(200);

    // Stale version → conflict.
    const stale = await S.admin.api.patch(`/roles/${role.body.data.id}`, {
      version: role.body.data.version,
      name: 'Renamed',
    });
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe('CONFLICT');
  });

  it('tenant roles cannot contain platform permissions', async () => {
    const res = await S.admin.api.post('/roles', {
      name: 'Sneaky',
      permissions: ['platform.tenants.read'],
    });
    expect(res.status).toBe(403); // the admin does not hold it → cannot grant it
    const res2 = await h
      .as((await h.superAdmin()).token, S.tenantId)
      .post('/roles', { name: 'Sneaky 2', permissions: ['platform.tenants.read'] });
    // Even a super admin acting in a school only has tenant permissions there.
    expect(res2.status).toBe(403);
  });

  it('nobody can grant a permission they do not hold (anti-escalation)', async () => {
    const limited = await S.admin.api.post('/roles', {
      name: 'Role Manager',
      permissions: ['roles.read', 'roles.create', 'members.read', 'members.invite', 'roles.assign'],
    });
    const manager = await h.addMember(S.admin.api, [{ role_id: limited.body.data.id }]);

    const escalate = await manager.api.post('/roles', {
      name: 'Bigger',
      permissions: ['members.revoke'],
    });
    expect(escalate.status).toBe(403);
    expect(escalate.body.error.details.permissions).toEqual(['members.revoke']);

    const adminRole = await h.roleId(S.admin.api, 'SCHOOL_ADMIN');
    const inviteAdmin = await manager.api.post('/members/invitations', {
      email: 'boss@school.test',
      first_name: 'Boss',
      roles: [{ role_id: adminRole }],
    });
    expect(inviteAdmin.status).toBe(403);

    const ok = await manager.api.post('/roles', { name: 'Reader', permissions: ['members.read'] });
    expect(ok.status).toBe(201);
  });

  it('system roles are read-only for schools', async () => {
    const teacher = await h.roleId(S.admin.api, 'TEACHER');
    const res = await S.admin.api.patch(`/roles/${teacher}`, { version: 1, name: 'Hacked' });
    expect(res.status).toBe(422);
    expect(code(res)).toBe('OPERATION_NOT_ALLOWED');
    expect((await S.admin.api.post(`/roles/${teacher}/archive`, { reason: 'nope' })).status).toBe(
      422,
    );
  });

  it('protects the last administrator and self-lockout', async () => {
    const me = await S.admin.api.get('/auth/me');
    const myMembership = me.body.data.membership.id;
    expect(code(await S.admin.api.delete(`/members/${myMembership}`, { reason: 'bye' }))).toBe(
      'OPERATION_NOT_ALLOWED',
    );
    const self = await S.admin.api.put(`/members/${myMembership}/roles`, { roles: [] });
    expect(code(self)).toBe('OPERATION_NOT_ALLOWED');

    // In a school with a single administrator, nobody (not even platform support) can remove the last one.
    const solo = await h.provisionSchool();
    const soloMe = await solo.admin.api.get('/auth/me');
    const support = h.as((await h.superAdmin()).token, solo.tenantId);
    const res = await support.put(`/members/${soloMe.body.data.membership.id}/roles`, {
      roles: [],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/administrator/);
    expect(
      code(
        await support.delete(`/members/${soloMe.body.data.membership.id}`, {
          reason: 'remove last admin',
        }),
      ),
    ).toBe('OPERATION_NOT_ALLOWED');
  });

  it('removing a member signs them out and keeps their history', async () => {
    const teacher = await h.roleId(S.admin.api, 'TEACHER');
    const m = await h.addMember(S.admin.api, [{ role_id: teacher }]);
    expect((await m.api.get('/_probe/students')).status).toBe(200);
    expect(
      (await S.admin.api.delete(`/members/${m.membershipId}`, { reason: 'Left the school' }))
        .status,
    ).toBe(204);
    expect(code(await m.api.get('/_probe/students'))).toBe('INVALID_TOKEN');
    const detail = await S.admin.api.get(`/members/${m.membershipId}`);
    expect(detail.body.data.status).toBe('REVOKED');
    const audit = await S.admin.api.get(`/audit-logs?entity_id=${m.membershipId}`);
    expect(audit.body.data.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['MEMBER_INVITED', 'MEMBER_REVOKED']),
    );
  });

  it('carries scope with the assignment (e.g. teacher limited to sections)', async () => {
    const teacher = await h.roleId(S.admin.api, 'TEACHER');
    const m = await h.addMember(S.admin.api, [
      { role_id: teacher, scope_type: 'ASSIGNED_SECTION', scope_ref: { section_ids: ['sec-7a'] } },
    ]);
    const res = await m.api.get('/_probe/attendance');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ type: 'ASSIGNED_SECTION', ref: { section_ids: ['sec-7a'] } }]);
  });

  it('exposes a grouped permission catalog with entitlement and grantable flags', async () => {
    const res = await S.admin.api.get('/permissions');
    expect(res.status).toBe(200);
    const transport = res.body.data.find((g: { feature: string }) => g.feature === 'transport');
    expect(transport.entitled).toBe(false); // STANDARD plan
    const students = res.body.data.find((g: { feature: string }) => g.feature === 'students');
    expect(students.entitled).toBe(true);
    expect(students.permissions.every((p: { grantable: boolean }) => p.grantable)).toBe(true);
  });
});
