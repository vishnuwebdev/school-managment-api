import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { roleAssignments } from '../../src/db/schema/index.js';
import { code, createHarness, SUPER, type Api, type Harness } from '../helpers.js';

/**
 * D55 — one scope policy for every permission: a grant narrower than the whole
 * school never widens, scope values are validated, and roles that only work
 * school-wide cannot be limited.
 */
let h: Harness;
type School = Awaited<ReturnType<Harness['provisionSchool']>>;
let A: School;
let B: School;
let api: Api;
let secA: string;
let secB: string;
let classId: string;
let otherSchoolSection: string;

async function structure(a: Api, label: string) {
  const y = await a.post('/academic-years', {
    code: `Y-${label}`,
    name: `Year ${label}`,
    start_date: '2026-04-01',
    end_date: '2027-03-31',
  });
  const yearId = y.body.data.id;
  await a.post(`/academic-years/${yearId}/activate`, { complete_current: true });
  const cls = (
    await a.post('/academic-classes', { code: `G7${label}`, name: 'Grade 7', sequence: 7 })
  ).body.data.id as string;
  const sec = async (c: string) =>
    (
      await a.post(`/academic-years/${yearId}/sections`, {
        class_id: cls,
        code: c,
        name: `Section ${c}`,
      })
    ).body.data.id as string;
  return { classId: cls, secA: await sec('A'), secB: await sec('B') };
}

const invite = (a: Api, roles: unknown[]) =>
  a.post('/members/invitations', {
    email: `scope-${Date.now()}-${Math.random().toString(36).slice(2)}@school.test`,
    first_name: 'Scope',
    roles,
  });

async function customRole(a: Api, name: string, permissions: string[]) {
  const res = await a.post('/roles', { name: `${name} ${Date.now()}`, permissions });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

/** Simulate an assignment stored before D55 (no validation at the time). */
async function narrowInDatabase(membershipId: string, tenantId: string, sectionIds: string[]) {
  await h.deps.db
    .update(roleAssignments)
    .set({ scopeType: 'ASSIGNED_SECTION', scopeRef: { section_ids: sectionIds } })
    .where(
      and(eq(roleAssignments.membershipId, membershipId), eq(roleAssignments.status, 'ACTIVE')),
    );
  await h.svc.authz.invalidateTenant(tenantId);
}

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  B = await h.provisionSchool();
  api = A.admin.api;
  ({ secA, secB, classId } = await structure(api, 'A'));
  otherSchoolSection = (await structure(B.admin.api, 'B')).secA;
});
afterAll(() => h.close());

describe('validation when roles are assigned', () => {
  it('accepts real sections and classes of this school, and "the sections they teach"', async () => {
    const teacher = await h.roleId(api, 'TEACHER');
    const m = await h.addMember(api, [
      {
        role_id: teacher,
        scope_type: 'ASSIGNED_SECTION',
        scope_ref: { section_ids: [secA, secA] },
      },
    ]);
    const detail = await api.get(`/members/${m.membershipId}`);
    expect(detail.body.data.roles[0]).toMatchObject({
      scope_type: 'ASSIGNED_SECTION',
      scope_ref: { section_ids: [secA] }, // de-duplicated
    });
    expect(
      (
        await invite(api, [
          { role_id: teacher, scope_type: 'ASSIGNED_CLASS', scope_ref: { class_ids: [classId] } },
        ])
      ).status,
    ).toBe(201);
    expect((await invite(api, [{ role_id: teacher, scope_type: 'ASSIGNED_SECTION' }])).status).toBe(
      201,
    );
  });

  it("rejects unknown ids and another school's ids the same way", async () => {
    const teacher = await h.roleId(api, 'TEACHER');
    for (const id of [otherSchoolSection, '00000000-0000-7000-8000-000000000001']) {
      const res = await invite(api, [
        {
          role_id: teacher,
          scope_type: 'ASSIGNED_SECTION',
          scope_ref: { section_ids: [secB, id] },
        },
      ]);
      expect(res.status).toBe(422);
      expect(code(res)).toBe('VALIDATION_ERROR');
      expect(res.body.error.details.issues[0]).toMatchObject({ code: 'not_found', ids: [id] });
    }
  });

  it('rejects a scope_ref that does not match the scope type, and unimplemented scope types', async () => {
    const teacher = await h.roleId(api, 'TEACHER');
    const cases = [
      { role_id: teacher, scope_type: 'ASSIGNED_SECTION', scope_ref: { class_ids: [classId] } },
      { role_id: teacher, scope_type: 'ALL_TENANT', scope_ref: { section_ids: [secA] } },
      { role_id: teacher, scope_type: 'ASSIGNED_SUBJECT' },
      { role_id: teacher, scope_type: 'SELECTED_RESOURCE', scope_ref: { resource_ids: [secA] } },
    ];
    for (const r of cases) {
      const res = await invite(api, [r]);
      expect(res.status, JSON.stringify(r)).toBe(422);
      expect(code(res)).toBe('VALIDATION_ERROR');
    }
  });

  it('refuses to limit a role holding permissions that only work school-wide', async () => {
    const mixed = await customRole(api, 'Coordinator', [
      'students.read',
      'audit.read',
      'tenant.settings.update',
    ]);
    const res = await invite(api, [
      { role_id: mixed, scope_type: 'ASSIGNED_CLASS', scope_ref: { class_ids: [classId] } },
    ]);
    expect(res.status).toBe(422);
    expect(code(res)).toBe('OPERATION_NOT_ALLOWED');
    expect(res.body.error.details).toMatchObject({
      reason: 'SCOPE_NOT_SUPPORTED',
      role_id: mixed,
      permissions: ['audit.read', 'tenant.settings.update'],
    });
    // Changing an existing member's roles follows the same rule.
    const m = await h.addMember(api, [{ role_id: mixed }]);
    const change = await api.put(`/members/${m.membershipId}/roles`, {
      roles: [
        { role_id: mixed, scope_type: 'ASSIGNED_SECTION', scope_ref: { section_ids: [secA] } },
      ],
    });
    expect(change.status).toBe(422);
    expect(change.body.error.details.reason).toBe('SCOPE_NOT_SUPPORTED');
  });

  it('a role given to someone for part of the school cannot gain school-wide-only permissions', async () => {
    const role = await customRole(api, 'Section Reader', ['students.read']);
    await h.addMember(api, [
      { role_id: role, scope_type: 'ASSIGNED_SECTION', scope_ref: { section_ids: [secA] } },
    ]);
    const current = await api.get(`/roles/${role}`);
    const res = await api.patch(`/roles/${role}`, {
      version: current.body.data.version,
      permissions: ['students.read', 'members.read'],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toMatchObject({
      reason: 'SCOPE_NOT_SUPPORTED',
      permissions: ['members.read'],
    });
    // Section-capable permissions can still be added.
    const ok = await api.patch(`/roles/${role}`, {
      version: current.body.data.version,
      permissions: ['students.read', 'attendance.read'],
      reason: 'Also takes attendance',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('records the scope (including ids) in the audit log', async () => {
    const teacher = await h.roleId(api, 'TEACHER');
    const m = await h.addMember(api, [{ role_id: teacher }]);
    await api.put(`/members/${m.membershipId}/roles`, {
      roles: [
        { role_id: teacher, scope_type: 'ASSIGNED_SECTION', scope_ref: { section_ids: [secB] } },
      ],
    });
    const audit = await api.get(`/audit-logs?entity_id=${m.membershipId}`);
    const change = audit.body.data.find(
      (a: { action: string }) => a.action === 'MEMBER_ROLES_CHANGED',
    );
    expect(change.after.roles).toEqual([
      { role_id: teacher, scope_type: 'ASSIGNED_SECTION', scope_ref: { section_ids: [secB] } },
    ]);
  });
});

describe('enforcement for assignments stored before validation existed', () => {
  it('a section-limited School Admin keeps only section-capable and reference permissions', async () => {
    const m = await h.addMember(api, [{ role_id: await h.roleId(api, 'SCHOOL_ADMIN') }]);
    await narrowInDatabase(m.membershipId, A.tenantId, [secA]);
    const me = await m.api.get('/auth/me');
    const perms: string[] = me.body.data.permissions;
    expect(perms).toEqual(
      expect.arrayContaining(['students.read', 'academics.read', 'teachers.read']),
    );
    for (const wide of [
      'members.read',
      'roles.assign',
      'audit.read',
      'tenant.settings.update',
      'tenant.finance.read',
    ])
      expect(perms).not.toContain(wide);
    for (const path of ['/members', '/roles', '/audit-logs']) {
      const res = await m.api.get(path);
      expect(res.status, path).toBe(403);
      expect(code(res)).toBe('PERMISSION_DENIED');
    }
    // Reference data stays readable; section-scoped data stays narrowed.
    expect((await m.api.get('/academic-years')).status).toBe(200);
    expect((await m.api.get('/_probe/attendance')).body.data).toEqual([
      { type: 'ASSIGNED_SECTION', ref: { section_ids: [secA] } },
    ]);
  });

  it('a section-limited admin is not counted as the remaining administrator', async () => {
    const S = await h.provisionSchool();
    const legacy = await h.addMember(S.admin.api, [
      { role_id: await h.roleId(S.admin.api, 'SCHOOL_ADMIN') },
    ]);
    const { secA: s } = await structure(S.admin.api, 'L');
    await narrowInDatabase(legacy.membershipId, S.tenantId, [s]);
    const me = await S.admin.api.get('/auth/me');
    // Platform support acting in the school tries to remove the only school-wide admin.
    const root = await h.login(SUPER.email, SUPER.password);
    const support = h.as(root.access_token, S.tenantId);
    const res = await support.delete(`/members/${me.body.data.membership.id}`, {
      reason: 'Testing guard',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/administrator/);
  });
});

describe('platform support inside a school', () => {
  it('SELECTED_TENANTS support works school-wide inside an allowed school', async () => {
    const roles = await A.root.get('/platform/roles');
    const supportRole = roles.body.data.find((r: { code: string }) => r.code === 'SUPPORT_ADMIN');
    const email = `support-scope-${Date.now()}@platform.test`;
    const inv = await A.root.post('/platform/users/invitations', {
      email,
      first_name: 'Sup',
      roles: [
        { role_id: supportRole.id, scope_type: 'SELECTED_TENANTS', tenant_ids: [A.tenantId] },
      ],
    });
    expect(inv.status).toBe(201);
    const s = await h.acceptAndLogin(email);
    const inSchool = h.as(s.access_token, A.tenantId);
    expect((await inSchool.get('/_probe/attendance')).body.data).toEqual([
      { type: 'ALL_TENANT', ref: null },
    ]);
    const unknown = await A.root.post('/platform/users/invitations', {
      email: `support-x-${Date.now()}@platform.test`,
      first_name: 'Sup',
      roles: [
        {
          role_id: supportRole.id,
          scope_type: 'SELECTED_TENANTS',
          tenant_ids: ['00000000-0000-7000-8000-000000000002'],
        },
      ],
    });
    expect(unknown.status).toBe(422);
  });
});

describe('permission catalog', () => {
  it('tells the panel how each permission behaves when a role is limited', async () => {
    const res = await api.get('/permissions');
    const support = Object.fromEntries(
      res.body.data.flatMap((g: { permissions: { code: string; scope_support: string }[] }) =>
        g.permissions.map((p) => [p.code, p.scope_support]),
      ),
    );
    expect(support['members.read']).toBe('TENANT_WIDE');
    expect(support['students.read']).toBe('PLACEMENT');
    expect(support['academics.read']).toBe('NEUTRAL');
    expect(support['teachers.read']).toBe('OWN');
  });
});
