import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, type Harness } from '../helpers.js';

/**
 * Regression tests for issues found in the Phase 1 security review.
 * Each test names the scenario it guards against.
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

async function schoolWithTwoAdmins() {
  const S = await h.provisionSchool();
  const adminRole = await h.roleId(S.admin.api, 'SCHOOL_ADMIN');
  const second = await h.addMember(S.admin.api, [{ role_id: adminRole }]);
  const readerRole = await S.admin.api.post('/roles', {
    name: `Reader ${Date.now()}`,
    permissions: ['members.read'],
  });
  const me = await S.admin.api.get('/auth/me');
  return {
    S,
    second,
    adminRole,
    readerId: readerRole.body.data.id as string,
    firstMembership: me.body.data.membership.id as string,
  };
}

describe('last-administrator protection under concurrency', () => {
  it('two admins demoting each other at the same time cannot leave the school without an admin', async () => {
    const { S, second, readerId, firstMembership } = await schoolWithTwoAdmins();
    const [a, b] = await Promise.all([
      S.admin.api.put(`/members/${second.membershipId}/roles`, { roles: [{ role_id: readerId }] }),
      second.api.put(`/members/${firstMembership}/roles`, { roles: [{ role_id: readerId }] }),
    ]);
    const statuses = [a.status, b.status].sort();
    // Exactly one wins; the other is rejected (last admin) or signed out (lost its authority).
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).not.toBe(200);
    const root = await h.superAdmin();
    const members = await h.as(root.token, S.tenantId).get('/members');
    const admins = members.body.data.filter((m: { roles: { code: string }[] }) =>
      m.roles.some((r) => r.code === 'SCHOOL_ADMIN'),
    );
    expect(admins.length).toBe(1);
  });

  it('editing or archiving a custom role cannot remove the last administrator', async () => {
    const S = await h.provisionSchool();
    const head = await S.admin.api.post('/roles', {
      name: 'Head',
      permissions: [
        'roles.assign',
        'roles.read',
        'roles.update',
        'roles.archive',
        'members.read',
        'members.invite',
      ],
    });
    const headUser = await h.addMember(S.admin.api, [{ role_id: head.body.data.id }]);
    const me = await S.admin.api.get('/auth/me');
    // Head moves the original admin onto "Head" (holds all Head permissions → allowed? No: removing SCHOOL_ADMIN needs its permissions).
    const demote = await headUser.api.put(`/members/${me.body.data.membership.id}/roles`, {
      roles: [{ role_id: head.body.data.id }],
    });
    expect(demote.status).toBe(403);
    // Platform support does it instead, leaving "Head" as the only admin-granting role.
    const support = h.as((await h.superAdmin()).token, S.tenantId);
    expect(
      (
        await support.put(`/members/${me.body.data.membership.id}/roles`, {
          roles: [{ role_id: head.body.data.id }],
        })
      ).status,
    ).toBe(200);

    const strip = await headUser.api.patch(`/roles/${head.body.data.id}`, {
      version: head.body.data.version,
      permissions: ['roles.read', 'members.read'],
    });
    expect(strip.status).toBe(422);
    expect(strip.body.error.message).toMatch(/administrator/);
    const archive = await headUser.api.post(`/roles/${head.body.data.id}/archive`, {
      reason: 'cleanup',
    });
    expect(archive.status).toBe(422);
  });
});

describe('invitation abuse', () => {
  it('re-inviting a pending invitee cannot silently change their roles', async () => {
    const S = await h.provisionSchool();
    const adminRole = await h.roleId(S.admin.api, 'SCHOOL_ADMIN');
    const email = `pending-${Date.now()}@school.test`;
    expect(
      (
        await S.admin.api.post('/members/invitations', {
          email,
          first_name: 'P',
          roles: [{ role_id: adminRole }],
        })
      ).status,
    ).toBe(201);
    const inviter = await S.admin.api.post('/roles', {
      name: 'Inviter',
      permissions: ['members.read', 'members.invite', 'roles.assign'],
    });
    const manager = await h.addMember(S.admin.api, [{ role_id: inviter.body.data.id }]);
    const reader = await S.admin.api.post('/roles', {
      name: 'Reader X',
      permissions: ['members.read'],
    });
    const again = await manager.api.post('/members/invitations', {
      email,
      first_name: 'P',
      roles: [{ role_id: reader.body.data.id }],
    });
    expect(again.status).toBe(409);
    expect(code(again)).toBe('DUPLICATE_RESOURCE');
    // Resending a pending admin's invitation needs the admin's authority too.
    const resend = await manager.api.post(
      `/members/${again.body.error.details.membership_id}/invitations/resend`,
    );
    expect(resend.status).toBe(403);
  });

  it('an invitation for a membership that was removed cannot be accepted', async () => {
    const S = await h.provisionSchool();
    const teacher = await h.roleId(S.admin.api, 'TEACHER');
    const email = `removed-${Date.now()}@school.test`;
    const inv = await S.admin.api.post('/members/invitations', {
      email,
      first_name: 'R',
      roles: [{ role_id: teacher }],
    });
    await h.drainOutbox();
    const token = h.lastToken(email, 'invitation');
    expect(
      (await S.admin.api.delete(`/members/${inv.body.data.id}`, { reason: 'changed mind' })).status,
    ).toBe(204);
    const accept = await h.http
      .post('/api/v1/auth/invitations/accept')
      .send({ token, password: 'Password1234' });
    expect(code(accept)).toBe('INVALID_STATE');
  });

  it('inviting an existing account does not reveal its real name or activity', async () => {
    const A = await h.provisionSchool();
    const B = await h.provisionSchool();
    const teacher = await h.roleId(B.admin.api, 'TEACHER');
    const res = await B.admin.api.post('/members/invitations', {
      email: A.adminEmail,
      first_name: 'Typed',
      last_name: 'ByInviter',
      roles: [{ role_id: teacher }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({
      first_name: 'Typed',
      last_name: 'ByInviter',
      status: 'INVITED',
      last_login_at: null,
    });
  });
});

describe('anti-escalation on scope, status and cross-tenant roles', () => {
  it('a section-scoped grantor cannot hand out school-wide or other-section access', async () => {
    const S = await h.provisionSchool();
    const lead = await S.admin.api.post('/roles', {
      name: 'Section Lead',
      permissions: ['attendance.read', 'members.invite', 'members.read', 'roles.assign'],
    });
    const helper = await S.admin.api.post('/roles', {
      name: 'Attendance Helper',
      permissions: ['attendance.read'],
    });
    const sectionLead = await h.addMember(S.admin.api, [
      {
        role_id: lead.body.data.id,
        scope_type: 'ASSIGNED_SECTION',
        scope_ref: { section_ids: ['7A'] },
      },
    ]);

    const wide = await sectionLead.api.post('/members/invitations', {
      email: `w-${Date.now()}@school.test`,
      first_name: 'W',
      roles: [{ role_id: helper.body.data.id }],
    });
    expect(wide.status).toBe(403);
    const other = await sectionLead.api.post('/members/invitations', {
      email: `o-${Date.now()}@school.test`,
      first_name: 'O',
      roles: [
        {
          role_id: helper.body.data.id,
          scope_type: 'ASSIGNED_SECTION',
          scope_ref: { section_ids: ['8B'] },
        },
      ],
    });
    expect(other.status).toBe(403);
    const same = await sectionLead.api.post('/members/invitations', {
      email: `s-${Date.now()}@school.test`,
      first_name: 'S',
      roles: [
        {
          role_id: helper.body.data.id,
          scope_type: 'ASSIGNED_SECTION',
          scope_ref: { section_ids: ['7A'] },
        },
      ],
    });
    expect(same.status).toBe(201);
  });

  it('suspending or reactivating someone requires holding their permissions', async () => {
    const S = await h.provisionSchool();
    const suspender = await S.admin.api.post('/roles', {
      name: 'Suspender',
      permissions: ['members.read', 'members.update'],
    });
    const s = await h.addMember(S.admin.api, [{ role_id: suspender.body.data.id }]);
    const me = await S.admin.api.get('/auth/me');
    const res = await s.api.post(`/members/${me.body.data.membership.id}/suspend`, {
      reason: 'coup attempt',
    });
    expect(res.status).toBe(403);
    expect((await S.admin.api.get('/auth/me')).status).toBe(200);
  });

  it("another school's role id is 'not found' and never leaks its permissions", async () => {
    const A = await h.provisionSchool();
    const B = await h.provisionSchool();
    const secret = await B.admin.api.post('/roles', {
      name: 'Secret',
      permissions: ['members.revoke', 'fees.read'],
    });
    const res = await A.admin.api.post('/members/invitations', {
      email: `leak-${Date.now()}@school.test`,
      first_name: 'L',
      roles: [{ role_id: secret.body.data.id }],
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('members.revoke');
  });
});
