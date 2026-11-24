import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

/**
 * Teacher app sign-in managed by the school: the admin sets a teacher's email
 * and password (no invitation email), and resets a forgotten or locked app PIN.
 */
let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;
let teacherRole: string;
const PASSWORD = 'Teacher#Pass2026';

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool({ plan: 'STANDARD' });
  api = A.admin.api;
  teacherRole = await h.roleId(api, 'TEACHER');
  const grant = await A.root.put(
    `/platform/tenants/${A.tenantId}/entitlements/overrides/teachers.mobile_app`,
    { effect: 'GRANT', reason: 'School bought the teacher app add-on' },
  );
  expect(grant.status, JSON.stringify(grant.body)).toBe(200);
  await h.flushTenantCache(A.tenantId);
});
afterAll(() => h.close());

async function newTeacher(email = `${uniq('t')}@school.test`) {
  const t = await api.post('/teachers', { first_name: 'Thabo', last_name: uniq('Fam'), email });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  return { id: t.body.data.id as string, email };
}

/** Admin gives the teacher a login with a password; returns the teacher's app session. */
async function teacherWithPassword() {
  const t = await newTeacher();
  const res = await api.post(`/teachers/${t.id}/portal-access`, {
    role_id: teacherRole,
    password: PASSWORD,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const session = await h.login(t.email, PASSWORD);
  return { ...t, session, app: h.as(session.access_token) };
}

const pinLogin = (pinToken: string, pin: string) =>
  h.http.post('/api/v1/auth/pin-login').send({ pin_token: pinToken, pin });

describe('admin sets the teacher login and password', () => {
  it('creates an active login without sending an invitation email', async () => {
    const t = await newTeacher();
    const res = await api.post(`/teachers/${t.id}/portal-access`, {
      role_id: teacherRole,
      password: PASSWORD,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const p = res.body.data.portal_access;
    expect(p.status).toBe('ACTIVE');
    expect(p.password_set).toBe(true);
    expect(p.app_pin.status).toBe('NONE');
    expect(p).not.toHaveProperty('password');

    await h.drainOutbox();
    expect(h.mailer.sent.some((m) => m.to === t.email && m.template === 'invitation')).toBe(false);

    const session = await h.login(t.email, PASSWORD);
    expect((await h.as(session.access_token).get('/teacher/me')).status).toBe(200);

    const history = await api.get(`/teachers/${t.id}/history`);
    expect(history.body.data.map((e: { event_type: string }) => e.event_type)).toContain(
      'PORTAL_ACCESS_GRANTED',
    );
  });

  it('completes a pending invitation: the emailed link stops working', async () => {
    const t = await newTeacher();
    const inv = await api.post(`/teachers/${t.id}/portal-access`, { role_id: teacherRole });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body.data.portal_access.status).toBe('INVITED');
    await h.drainOutbox();
    const link = h.lastToken(t.email, 'invitation');

    const set = await api.put(`/teachers/${t.id}/portal-access/password`, { password: PASSWORD });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data.portal_access.status).toBe('ACTIVE');
    expect(set.body.data.portal_access.password_set).toBe(true);

    const accept = await h.http
      .post('/api/v1/auth/invitations/accept')
      .send({ token: link, password: 'Another#Pass2026' });
    expect(code(accept)).toBe('INVALID_STATE');
    await h.login(t.email, PASSWORD);
  });

  it('replaces the password: old sessions end, old password and PIN stop working', async () => {
    const t = await teacherWithPassword();
    const pin = await t.app.put('/teacher/pin', { pin: '2580' });
    expect(pin.status, JSON.stringify(pin.body)).toBe(200);

    const set = await api.put(`/teachers/${t.id}/portal-access/password`, {
      password: 'Changed#Pass2026',
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data.portal_access.app_pin.status).toBe('NONE');

    const refresh = await h.http
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: t.session.refresh_token });
    expect(code(refresh)).toBe('SIGNED_OUT_ELSEWHERE');
    const old = await h.http
      .post('/api/v1/auth/login')
      .send({ email: t.email, password: PASSWORD });
    expect(code(old)).toBe('INVALID_CREDENTIALS');
    expect(code(await pinLogin(pin.body.data.pin_token, '2580'))).toBe('PIN_NOT_SET');
    await h.login(t.email, 'Changed#Pass2026');
  });

  it('enforces the password policy and needs an existing login', async () => {
    const t = await newTeacher();
    expect(
      code(
        await api.post(`/teachers/${t.id}/portal-access`, {
          role_id: teacherRole,
          password: 'short',
        }),
      ),
    ).toBe('VALIDATION_ERROR');
    expect(
      code(await api.put(`/teachers/${t.id}/portal-access/password`, { password: PASSWORD })),
    ).toBe('INVALID_STATE');
  });

  it('never takes over an account that also signs in to another school', async () => {
    const B = await h.provisionSchool({ plan: 'STANDARD' });
    const shared = `${uniq('shared')}@school.test`;
    const inB = await B.admin.api.post('/teachers', {
      first_name: 'Shared',
      last_name: 'Teacher',
      email: shared,
    });
    const bRole = await h.roleId(B.admin.api, 'TEACHER');
    await B.admin.api.post(`/teachers/${inB.body.data.id}/portal-access`, { role_id: bRole });

    // Creating the login in school A with a password is refused...
    const t = await newTeacher(shared);
    const res = await api.post(`/teachers/${t.id}/portal-access`, {
      role_id: teacherRole,
      password: PASSWORD,
    });
    expect(code(res)).toBe('OPERATION_NOT_ALLOWED');
    // ...nothing was left behind, and an email invitation still works.
    const inv = await api.post(`/teachers/${t.id}/portal-access`, { role_id: teacherRole });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    // Setting the password afterwards is refused as well.
    expect(
      code(await api.put(`/teachers/${t.id}/portal-access/password`, { password: PASSWORD })),
    ).toBe('OPERATION_NOT_ALLOWED');
  });

  it('needs teachers.portal.manage', async () => {
    const t = await teacherWithPassword();
    const other = await teacherWithPassword();
    expect(
      code(await t.app.put(`/teachers/${other.id}/portal-access/password`, { password: PASSWORD })),
    ).toBe('PERMISSION_DENIED');
    expect(code(await t.app.delete(`/teachers/${other.id}/portal-access/pin`, {}))).toBe(
      'PERMISSION_DENIED',
    );
  });
});

describe('teacher app PIN and admin reset', () => {
  it('sets a PIN, signs in with it, locks after 5 wrong PINs, and the admin resets it', async () => {
    const t = await teacherWithPassword();
    expect(code(await t.app.put('/teacher/pin', { pin: '1234' }))).toBe('VALIDATION_ERROR');
    expect(code(await t.app.put('/teacher/pin', { pin: '12a4' }))).toBe('VALIDATION_ERROR');

    const set = await t.app.put('/teacher/pin', {
      pin: '4071',
      device: { device_name: 'Pixel 8', device_type: 'android' },
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const token = set.body.data.pin_token as string;
    expect(set.body.data.status).toBe('SET');
    expect((await t.app.get('/teacher/pin')).body.data.status).toBe('SET');

    const ok = await pinLogin(token, '4071');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.membership.tenant.id).toBe(A.tenantId);
    expect((await h.as(ok.body.data.access_token).get('/teacher/me')).status).toBe(200);

    const profile = await api.get(`/teachers/${t.id}`);
    expect(profile.body.data.portal_access.app_pin).toMatchObject({
      status: 'SET',
      device_name: 'Pixel 8',
    });

    const wrong = await pinLogin(token, '9999');
    expect(code(wrong)).toBe('INVALID_PIN');
    expect(wrong.body.error.details.attempts_left).toBe(4);
    for (let i = 0; i < 3; i++) expect(code(await pinLogin(token, '9999'))).toBe('INVALID_PIN');
    expect(code(await pinLogin(token, '9999'))).toBe('PIN_LOCKED');
    expect(code(await pinLogin(token, '4071'))).toBe('PIN_LOCKED');
    expect((await api.get(`/teachers/${t.id}`)).body.data.portal_access.app_pin.status).toBe(
      'LOCKED',
    );

    const reset = await api.delete(`/teachers/${t.id}/portal-access/pin`, {
      reason: 'Teacher forgot the PIN',
    });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(reset.body.data.portal_access.app_pin.status).toBe('NONE');
    expect(code(await pinLogin(token, '4071'))).toBe('PIN_NOT_SET');
    expect(code(await api.delete(`/teachers/${t.id}/portal-access/pin`, {}))).toBe('INVALID_STATE');
    const history = await api.get(`/teachers/${t.id}/history`);
    expect(history.body.data.map((e: { event_type: string }) => e.event_type)).toContain(
      'APP_PIN_RESET',
    );

    // The teacher signs in with the password and chooses a new PIN.
    const again = h.as((await h.login(t.email, PASSWORD)).access_token);
    const fresh = await again.put('/teacher/pin', { pin: '5813' });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect((await pinLogin(fresh.body.data.pin_token, '5813')).status).toBe(200);
  });

  it('turning PIN sign-in off deletes the PIN', async () => {
    const t = await teacherWithPassword();
    const set = await t.app.put('/teacher/pin', { pin: '3690' });
    expect((await t.app.delete('/teacher/pin')).status).toBe(204);
    expect((await t.app.get('/teacher/pin')).body.data.status).toBe('NONE');
    expect(code(await pinLogin(set.body.data.pin_token, '3690'))).toBe('PIN_NOT_SET');
  });

  it('removing portal access clears the PIN, so a later re-invite cannot reuse it', async () => {
    const t = await teacherWithPassword();
    const set = await t.app.put('/teacher/pin', { pin: '7302' });
    const del = await api.delete(`/teachers/${t.id}/portal-access`, { reason: 'Left the school' });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(code(await pinLogin(set.body.data.pin_token, '7302'))).toBe('PIN_NOT_SET');
  });

  it('a suspended login cannot sign in with its PIN', async () => {
    const t = await teacherWithPassword();
    const set = await t.app.put('/teacher/pin', { pin: '8146' });
    const profile = await api.get(`/teachers/${t.id}`);
    const membershipId = profile.body.data.portal_access.membership_id as string;
    const sus = await api.post(`/members/${membershipId}/suspend`, { reason: 'Investigation' });
    expect(sus.status, JSON.stringify(sus.body)).toBe(200);
    expect(code(await pinLogin(set.body.data.pin_token, '8146'))).toBe('TENANT_ACCESS_DENIED');
  });
});
