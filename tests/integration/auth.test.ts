import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, SUPER, type Harness } from '../helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('authentication', () => {
  it('reports health', async () => {
    const res = await h.http.get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ database: 'ok', redis: 'ok' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('rejects bad credentials with a stable code and no account enumeration', async () => {
    const wrong = await h.http
      .post('/api/v1/auth/login')
      .send({ email: SUPER.email, password: 'nope-nope-1' });
    const unknown = await h.http
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@x.test', password: 'nope-nope-1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(code(wrong)).toBe('INVALID_CREDENTIALS');
    expect(code(unknown)).toBe('INVALID_CREDENTIALS');
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('requires a token and rejects garbage tokens', async () => {
    expect(code(await h.http.get('/api/v1/auth/me'))).toBe('AUTHENTICATION_REQUIRED');
    expect(
      code(await h.http.get('/api/v1/auth/me').set('Authorization', 'Bearer abc.def.ghi')),
    ).toBe('INVALID_TOKEN');
  });

  it('locks the account after repeated failures', async () => {
    const { adminEmail } = await h.provisionSchool();
    for (let i = 0; i < 5; i++)
      await h.http
        .post('/api/v1/auth/login')
        .send({ email: adminEmail, password: 'wrong-password-1' });
    const locked = await h.http
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: 'Password1234' });
    expect(locked.status).toBe(403);
    expect(code(locked)).toBe('ACCOUNT_LOCKED');
  });

  it('rotates refresh tokens and revokes everything on reuse', async () => {
    const s = await h.login(SUPER.email, SUPER.password);
    const r1 = await h.http.post('/api/v1/auth/refresh').send({ refresh_token: s.refresh_token });
    expect(r1.status).toBe(200);
    expect(r1.body.data.refresh_token).not.toBe(s.refresh_token);

    // The new access token works; the old session is gone.
    expect((await h.as(r1.body.data.access_token).get('/auth/me')).status).toBe(200);
    expect(code(await h.as(s.access_token).get('/auth/me'))).toBe('INVALID_TOKEN');

    // Replaying the rotated token = theft signal → all sessions revoked.
    const replay = await h.http
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: s.refresh_token });
    expect(code(replay)).toBe('INVALID_TOKEN');
    expect(code(await h.as(r1.body.data.access_token).get('/auth/me'))).toBe('INVALID_TOKEN');
    expect(
      code(
        await h.http
          .post('/api/v1/auth/refresh')
          .send({ refresh_token: r1.body.data.refresh_token }),
      ),
    ).toBe('INVALID_TOKEN');
  });

  it('logout ends the session immediately', async () => {
    const s = await h.login(SUPER.email, SUPER.password);
    const api = h.as(s.access_token);
    expect((await api.post('/auth/logout')).status).toBe(204);
    expect(code(await api.get('/auth/me'))).toBe('INVALID_TOKEN');
  });

  it('lists and revokes own sessions', async () => {
    const a = await h.login(SUPER.email, SUPER.password);
    const b = await h.login(SUPER.email, SUPER.password);
    const list = await h.as(a.access_token).get('/auth/sessions');
    const ids = list.body.data.map((x: { id: string }) => x.id);
    expect(ids).toEqual(expect.arrayContaining([a.session_id, b.session_id]));
    expect((await h.as(a.access_token).delete(`/auth/sessions/${b.session_id}`)).status).toBe(204);
    expect(code(await h.as(b.access_token).get('/auth/me'))).toBe('INVALID_TOKEN');
  });

  it('resets a password by email link and signs out every session', async () => {
    const { adminEmail, admin } = await h.provisionSchool();
    const forgot = await h.http.post('/api/v1/auth/forgot-password').send({ email: adminEmail });
    expect(forgot.status).toBe(202);
    // Unknown emails get the same response.
    expect(
      (await h.http.post('/api/v1/auth/forgot-password').send({ email: 'ghost@x.test' })).status,
    ).toBe(202);

    await h.drainOutbox();
    const token = h.lastToken(adminEmail, 'password_reset');
    const weak = await h.http
      .post('/api/v1/auth/reset-password')
      .send({ token, new_password: 'short' });
    expect(code(weak)).toBe('VALIDATION_ERROR');
    const ok = await h.http
      .post('/api/v1/auth/reset-password')
      .send({ token, new_password: 'BrandNewPass99' });
    expect(ok.status).toBe(204);
    expect(code(await admin.api.get('/auth/me'))).toBe('INVALID_TOKEN');
    expect(
      code(
        await h.http
          .post('/api/v1/auth/reset-password')
          .send({ token, new_password: 'AnotherPass99' }),
      ),
    ).toBe('INVALID_STATE');
    await h.login(adminEmail, 'BrandNewPass99');
  });

  it('changing the password keeps the current session and ends the others', async () => {
    const { adminEmail, admin } = await h.provisionSchool();
    const other = await h.login(adminEmail, admin.password);
    const res = await admin.api.post('/auth/change-password', {
      current_password: admin.password,
      new_password: 'Changed12345',
    });
    expect(res.status).toBe(204);
    expect((await admin.api.get('/auth/me')).status).toBe(200);
    expect(code(await h.as(other.access_token).get('/auth/me'))).toBe('INVALID_TOKEN');
  });

  it('asks users with several schools to choose, and can switch context', async () => {
    const a = await h.provisionSchool();
    const b = await h.provisionSchool();
    const adminRoleB = await h.roleId(b.admin.api, 'SCHOOL_ADMIN');
    // School B invites school A's admin (same person, second membership).
    const inv = await b.admin.api.post('/members/invitations', {
      email: a.adminEmail,
      first_name: 'Admin',
      roles: [{ role_id: adminRoleB }],
    });
    expect(inv.status).toBe(201);
    await h.drainOutbox();
    const token = h.lastToken(a.adminEmail, 'invitation');
    const preview = await h.http.post('/api/v1/auth/invitations/preview').send({ token });
    expect(preview.body.data.requires_password).toBe(false); // existing account
    expect((await h.http.post('/api/v1/auth/invitations/accept').send({ token })).status).toBe(200);

    const ambiguous = await h.http
      .post('/api/v1/auth/login')
      .send({ email: a.adminEmail, password: a.admin.password });
    expect(ambiguous.status).toBe(409);
    expect(code(ambiguous)).toBe('CONTEXT_SELECTION_REQUIRED');
    const options = ambiguous.body.error.details.memberships as {
      membership_id: string;
      tenant: { id: string };
    }[];
    expect(options.map((o) => o.tenant.id).sort()).toEqual([a.tenantId, b.tenantId].sort());

    const inA = await h.login(
      a.adminEmail,
      a.admin.password,
      options.find((o) => o.tenant.id === a.tenantId)!.membership_id,
    );
    expect((await h.as(inA.access_token).get('/tenants/current')).body.data.id).toBe(a.tenantId);
    const switched = await h.as(inA.access_token).post('/auth/switch-tenant', {
      membership_id: options.find((o) => o.tenant.id === b.tenantId)!.membership_id,
    });
    expect(switched.status).toBe(200);
    expect((await h.as(switched.body.data.access_token).get('/tenants/current')).body.data.id).toBe(
      b.tenantId,
    );
    expect(code(await h.as(inA.access_token).get('/tenants/current'))).toBe('INVALID_TOKEN');
  });

  it('validates input with field-level details', async () => {
    const res = await h.http.post('/api/v1/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(422);
    expect(code(res)).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(['email', 'password']),
    );
    const malformed = await h.http
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send('{bad');
    expect(malformed.status).toBe(400);
  });
});
