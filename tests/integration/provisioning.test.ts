import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invitations, outboxEvents } from '../../src/db/schema/index.js';
import { code, createHarness, uniq, type Harness } from '../helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('Milestone 1 — platform admin → school → admin invitation → login → dashboard context', () => {
  it('runs the complete first vertical workflow', async () => {
    const { tenantId, admin, adminEmail } = await h.provisionSchool({ plan: 'STANDARD' });

    const me = await admin.api.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(adminEmail);
    expect(me.body.data.membership.kind).toBe('TENANT');
    expect(me.body.data.membership.tenant.id).toBe(tenantId);
    expect(me.body.data.permissions).toContain('members.invite');
    expect(me.body.data.permissions).not.toContain('platform.tenants.read');
    expect(me.body.data.entitlements.access_mode).toBe('FULL');
    expect(me.body.data.entitlements.subscription.status).toBe('TRIAL');
    expect(me.body.data.entitlements.features).toEqual(
      expect.arrayContaining(['core', 'students', 'fees', 'examinations']),
    );
    expect(me.body.data.entitlements.features).not.toContain('transport');

    const school = await admin.api.get('/tenants/current');
    expect(school.status).toBe(200);
    expect(school.body.data.status).toBe('ACTIVE');
    expect(school.body.data.settings.timezone).toBe('Asia/Kolkata');

    const members = await admin.api.get('/members');
    expect(members.body.meta.total).toBe(1);
    expect(members.body.data[0].roles[0].code).toBe('SCHOOL_ADMIN');
  });

  it('stores only the hash of invitation tokens and emits outbox events', async () => {
    const root = await h.superAdmin();
    const schoolCode = uniq('school');
    const created = await root.post('/platform/tenants', {
      code: schoolCode,
      name: 'Hash Check School',
    });
    const tenantId = created.body.data.id;
    const email = `${schoolCode}@school.test`;
    await root.post(`/platform/tenants/${tenantId}/provision`, {
      plan_code: 'STARTER',
      trial_days: 0,
      admin: { email, first_name: 'A' },
    });

    const [pending] = await h.deps.db
      .select()
      .from(invitations)
      .where(eq(invitations.email, email));
    expect(pending!.status).toBe('PENDING');
    expect(pending!.tokenHash).toBeNull();

    await h.drainOutbox();
    const token = h.lastToken(email, 'invitation');
    const [sent] = await h.deps.db.select().from(invitations).where(eq(invitations.email, email));
    expect(sent!.status).toBe('SENT');
    expect(sent!.tokenHash).toHaveLength(64);
    expect(sent!.tokenHash).not.toContain(token);

    const events = await h.deps.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.tenantId, tenantId));
    const types = events.map((e) => e.eventType);
    expect(types).toEqual(
      expect.arrayContaining([
        'tenant.created',
        'subscription.started',
        'invitation.created',
        'tenant.provisioned',
      ]),
    );
    expect(events.every((e) => e.status === 'PUBLISHED')).toBe(true);
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain(token);

    const preview = await h.http.post('/api/v1/auth/invitations/preview').send({ token });
    expect(preview.status).toBe(200);
    expect(preview.body.data.requires_password).toBe(true);
    expect(preview.body.data.tenant.name).toBe('Hash Check School');

    // Accept once; the token is single-use.
    const ok = await h.http
      .post('/api/v1/auth/invitations/accept')
      .send({ token, password: 'Password1234' });
    expect(ok.status).toBe(200);
    const again = await h.http
      .post('/api/v1/auth/invitations/accept')
      .send({ token, password: 'Password1234' });
    expect(code(again)).toBe('INVALID_STATE');
  });

  it('refuses to provision twice and rejects duplicate school codes', async () => {
    const root = await h.superAdmin();
    const schoolCode = uniq('school');
    const created = await root.post('/platform/tenants', { code: schoolCode, name: 'Dup' });
    const dup = await root.post('/platform/tenants', { code: schoolCode, name: 'Dup 2' });
    expect(dup.status).toBe(409);
    expect(code(dup)).toBe('DUPLICATE_RESOURCE');

    const body = {
      plan_code: 'STARTER',
      admin: { email: `${schoolCode}@school.test`, first_name: 'A' },
    };
    expect(
      (await root.post(`/platform/tenants/${created.body.data.id}/provision`, body)).status,
    ).toBe(200);
    const twice = await root.post(`/platform/tenants/${created.body.data.id}/provision`, body);
    expect(twice.status).toBe(422);
    expect(code(twice)).toBe('INVALID_STATE');
  });

  it('rolls back provisioning completely when a step fails (unknown plan)', async () => {
    const root = await h.superAdmin();
    const created = await root.post('/platform/tenants', {
      code: uniq('school'),
      name: 'Rollback',
    });
    const id = created.body.data.id;
    const bad = await root.post(`/platform/tenants/${id}/provision`, {
      plan_code: 'NOPE',
      admin: { email: `${uniq('x')}@school.test`, first_name: 'A' },
    });
    expect(bad.status).toBe(404);
    const detail = await root.get(`/platform/tenants/${id}`);
    expect(detail.body.data.status).toBe('APPROVED'); // not PROVISIONING, not ACTIVE
    expect(detail.body.data.member_count).toBe(0);
  });

  it('approves a public school request into an APPROVED school', async () => {
    const submitted = await h.http.post('/api/v1/public/school-requests').send({
      school_name: 'Green Valley',
      contact_name: 'Asha',
      contact_email: 'asha@greenvalley.test',
    });
    expect(submitted.status).toBe(201);
    const root = await h.superAdmin();
    const list = await root.get('/platform/school-requests?status=PENDING');
    expect(list.body.data.some((r: { id: string }) => r.id === submitted.body.data.id)).toBe(true);
    const approved = await root.post(
      `/platform/school-requests/${submitted.body.data.id}/approve`,
      { code: uniq('green'), name: 'Green Valley School' },
    );
    expect(approved.status).toBe(200);
    const tenant = await root.get(`/platform/tenants/${approved.body.data.tenant_id}`);
    expect(tenant.body.data.status).toBe('APPROVED');
    const again = await root.post(`/platform/school-requests/${submitted.body.data.id}/reject`, {
      note: 'too late',
    });
    expect(code(again)).toBe('INVALID_STATE');
  });

  it('publishes an OpenAPI document that covers the routes', async () => {
    const res = await h.http.get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/auth/login',
        '/platform/tenants/{id}/provision',
        '/members/{id}/roles',
      ]),
    );
  });
});
