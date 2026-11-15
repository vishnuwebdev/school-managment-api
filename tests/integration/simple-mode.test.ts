import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SUPER, code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

/**
 * Simple product mode (PRODUCT_MODE=simple, what the product runs today):
 * - only the Super Admin and each school's School Admin sign in to the admin panel;
 * - no plans, subscriptions, billing, platform users or school users and roles;
 * - the Super Admin enables / disables a school and switches its Teacher app and Parent app;
 * - teachers and parents sign in only while their school's app is on, and the office sees
 *   app-only features (teacher app logins, guardian app logins, notices, feedback) only then.
 */
let h: Harness;
let root: Api;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
function ok<T = Json>(res: { status: number; body: Json }, status = 200) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
}

const PASSWORD = 'School12345';
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

async function signIn(body: Json) {
  return h.http.post('/api/v1/auth/login').send({ password: PASSWORD, ...body });
}

/** Create + set up a school with a ready School Admin login (no plan). */
async function newSchool(apps: { teacher_app?: boolean; parent_app?: boolean } = {}) {
  const schoolCode = uniq('simple');
  const tenantId = ok(
    await root.post('/platform/tenants', { code: schoolCode, name: `School ${schoolCode}` }),
    201,
  ).id as string;
  const adminEmail = `${schoolCode}-admin@school.test`;
  const prov = ok(
    await root.post(`/platform/tenants/${tenantId}/provision`, {
      admin: { email: adminEmail, first_name: 'Admin', password: PASSWORD },
      ...apps,
    }),
  );
  expect(prov.subscription_id).toBeNull();
  expect(prov.tenant.status).toBe('ACTIVE');
  const res = await signIn({ email: adminEmail, app: 'admin' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { tenantId, adminEmail, api: h.as(res.body.data.access_token) };
}

beforeAll(async () => {
  h = await createHarness({ mode: 'simple' });
  const res = await h.http
    .post('/api/v1/auth/login')
    .send({ email: SUPER.email, password: SUPER.password, app: 'admin' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  root = h.as(res.body.data.access_token);
}, 60_000);
afterAll(() => h.close());

describe('switched-off parts', () => {
  it('does not serve plans, subscriptions, billing, users or roles', async () => {
    const s = await newSchool();
    for (const url of [
      '/platform/plans',
      '/platform/billing/overview',
      '/platform/users',
      '/platform/roles',
      `/platform/tenants/${s.tenantId}/subscriptions`,
      `/platform/tenants/${s.tenantId}/entitlements`,
      `/platform/tenants/${s.tenantId}/billing`,
    ])
      expect((await root.get(url)).status, url).toBe(404);
    for (const url of [
      '/members',
      '/roles',
      '/permissions',
      '/tenants/current/subscription',
      '/tenants/current/billing',
    ])
      expect((await s.api.get(url)).status, url).toBe(404);
    expect((await s.api.post('/members/invitations', { email: 'x@y.test' })).status).toBe(404);
  });

  it('gives every school every feature without a plan, apps off by default', async () => {
    const s = await newSchool();
    const me = ok(await s.api.get('/auth/me'));
    const f: string[] = me.entitlements.features;
    for (const code of ['students', 'academics', 'attendance', 'examinations', 'fees', 'timetable'])
      expect(f, code).toContain(code);
    for (const code of ['teachers.mobile_app', 'parent_portal', 'communication', 'custom_roles'])
      expect(f, code).not.toContain(code);
    expect(me.entitlements.access_mode).toBe('FULL');
    const detail = ok(await root.get(`/platform/tenants/${s.tenantId}`));
    expect(detail.apps).toEqual({ teacher_app: false, parent_app: false });
  });
});

describe('who signs in to the admin panel', () => {
  it('lets the School Admin in and keeps a teacher out', async () => {
    const s = await newSchool({ teacher_app: true });
    const email = `${uniq('t')}@school.test`;
    const t = ok(
      await s.api.post('/teachers', { first_name: 'Asha', last_name: 'Rao', email }),
      201,
    );
    ok(await s.api.post(`/teachers/${t.id}/portal-access`, { password: PASSWORD }), 201);
    expect(code(await signIn({ email, app: 'admin' }))).toBe('ADMIN_PANEL_NOT_ALLOWED');
    expect((await signIn({ email, app: 'teacher' })).status).toBe(200);
    // An older teacher app (no `app`) still signs in.
    expect((await signIn({ email })).status).toBe(200);
  });

  it('keeps the Super Admin out of the mobile apps', async () => {
    const res = await h.http
      .post('/api/v1/auth/login')
      .send({ email: SUPER.email, password: SUPER.password, app: 'teacher' });
    expect(code(res)).toBe('NOT_A_TEACHER');
  });
});

describe('enable / disable a school', () => {
  it('signs everyone out and keeps them out until the school is enabled', async () => {
    const s = await newSchool();
    ok(await root.post(`/platform/tenants/${s.tenantId}/suspend`, { reason: 'Unpaid dues' }));
    expect(code(await s.api.get('/tenants/current'))).toBe('SESSION_REVOKED');
    const blocked = await signIn({ email: s.adminEmail, app: 'admin' });
    expect(code(blocked)).toBe('SCHOOL_SUSPENDED');
    expect(blocked.body.error.message).toMatch(/disabled/);
    const list = ok<Json[]>(await root.get('/platform/tenants?page_size=100'));
    expect(list.find((t) => t.id === s.tenantId)?.status).toBe('SUSPENDED');

    ok(await root.post(`/platform/tenants/${s.tenantId}/reactivate`, { reason: 'Paid' }));
    expect((await signIn({ email: s.adminEmail, app: 'admin' })).status).toBe(200);
  });
});

describe('Teacher app switch', () => {
  it('lets teachers in only while on, and hides teacher-app logins from the office', async () => {
    const s = await newSchool();
    const email = `${uniq('t')}@school.test`;
    const t = ok(
      await s.api.post('/teachers', { first_name: 'Ravi', last_name: 'Iyer', email }),
      201,
    );
    // Off: the office cannot give app logins.
    expect(code(await s.api.post(`/teachers/${t.id}/portal-access`, { password: PASSWORD }))).toBe(
      'FEATURE_NOT_ENABLED',
    );

    const on = ok(await root.put(`/platform/tenants/${s.tenantId}/apps`, { teacher_app: true }));
    expect(on.apps).toEqual({ teacher_app: true, parent_app: false });
    ok(await s.api.post(`/teachers/${t.id}/portal-access`, { password: PASSWORD }), 201);
    const signedIn = await signIn({ email, app: 'teacher' });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    const teacher = h.as(signedIn.body.data.access_token);
    expect((await teacher.get('/teacher/me')).status).toBe(200);

    // Off again: the teacher is signed out at once, cannot sign in, cannot refresh.
    ok(await root.put(`/platform/tenants/${s.tenantId}/apps`, { teacher_app: false }));
    const gone = await teacher.get('/teacher/me');
    expect(code(gone)).toBe('SESSION_REVOKED');
    expect(gone.body.error.message).toMatch(/switched off/);
    expect(code(await signIn({ email, app: 'teacher' }))).toBe('TEACHER_APP_DISABLED');
    const refresh = await h.http
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: signedIn.body.data.refresh_token });
    expect(refresh.status).toBe(401);
    // The School Admin is not affected.
    expect((await s.api.get('/teachers')).status).toBe(200);
    // Audit trail of the switch.
    const audit = ok<Json[]>(await s.api.get('/audit-logs?page_size=100'));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['SCHOOL_APP_ENABLED', 'SCHOOL_APP_DISABLED']),
    );
  });
});

describe('Parent app switch', () => {
  it('gates parent logins, guardian app access and notices', async () => {
    const s = await newSchool();
    const api = s.api;
    const yearId = ok(
      await api.post('/academic-years', {
        code: 'SY',
        name: '2026-27',
        start_date: daysAgo(30),
        end_date: inDays(300),
      }),
      201,
    ).id;
    ok(await api.post(`/academic-years/${yearId}/activate`, { complete_current: true }));
    const classId = ok(
      await api.post('/academic-classes', { code: 'C1', name: 'Class 1', sequence: 1 }),
      201,
    ).id;
    const sectionId = ok(
      await api.post(`/academic-years/${yearId}/sections`, {
        class_id: classId,
        code: 'A',
        name: 'A',
      }),
      201,
    ).id;
    const phone = `+9198${String(Date.now()).slice(-8)}`;
    const student = ok(
      await api.post('/students', {
        first_name: 'Diya',
        last_name: uniq('Shah'),
        gender: 'FEMALE',
        date_of_birth: '2019-06-01',
        guardians: [
          {
            guardian: { first_name: 'Meera', last_name: 'Shah', phone },
            relationship_type: 'PARENT',
            relationship_label: 'Mother',
          },
        ],
        enrollment: {
          academic_year_id: yearId,
          class_id: classId,
          section_id: sectionId,
          start_date: daysAgo(10),
        },
      }),
      201,
    );
    const guardianId = student.guardians[0].guardian.id as string;

    // Off: no parent logins, no notices, no feedback.
    expect(
      code(await api.post(`/guardians/${guardianId}/app-access`, { password: PASSWORD })),
    ).toBe('FEATURE_NOT_ENABLED');
    expect(code(await api.get('/notices'))).toBe('FEATURE_NOT_ENABLED');
    expect(code(await api.get('/feedback'))).toBe('FEATURE_NOT_ENABLED');

    ok(await root.put(`/platform/tenants/${s.tenantId}/apps`, { parent_app: true }));
    ok(await api.post(`/guardians/${guardianId}/app-access`, { password: PASSWORD }), 201);
    expect((await api.get('/notices')).status).toBe(200);
    const res = await signIn({ phone, app: 'parent' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const parent = h.as(res.body.data.access_token);
    expect((await parent.get('/parent/me')).status).toBe(200);
    // A parent is not an admin-panel user.
    expect(code(await signIn({ phone, app: 'admin' }))).toBe('ADMIN_PANEL_NOT_ALLOWED');

    ok(await root.put(`/platform/tenants/${s.tenantId}/apps`, { parent_app: false }));
    expect(code(await parent.get('/parent/me'))).toBe('SESSION_REVOKED');
    expect(code(await signIn({ phone, app: 'parent' }))).toBe('PARENT_APP_DISABLED');
    expect(code(await api.get('/notices'))).toBe('FEATURE_NOT_ENABLED');
    // The guardian record and the student stay.
    expect((await api.get(`/students/${student.id}`)).status).toBe(200);
  });
});
