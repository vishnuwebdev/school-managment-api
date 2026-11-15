import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, uniq, type Harness } from '../helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

/** A fresh 10-digit Indian mobile number (national form, as people type it). */
const mobile = () => `9${String(Date.now() + Math.floor(Math.random() * 1e6)).slice(-9)}`;

async function phoneLogin(phone: string, password: string) {
  return h.http.post('/api/v1/auth/login').send({ phone, password });
}

describe('sign in with a mobile number or an email (B3)', () => {
  it('provisions a school whose admin has only a mobile number', async () => {
    const root = await h.superAdmin();
    const created = await root.post('/platform/tenants', { code: uniq('school'), name: 'Mobile' });
    const tenantId = created.body.data.id;
    const phone = mobile();

    const noPassword = await root.post(`/platform/tenants/${tenantId}/provision`, {
      plan_code: 'STARTER',
      admin: { mobile: phone, first_name: 'Ravi' },
    });
    expect(noPassword.status).toBe(422);

    const nothing = await root.post(`/platform/tenants/${tenantId}/provision`, {
      plan_code: 'STARTER',
      admin: { first_name: 'Ravi', password: 'Welcome123' },
    });
    expect(nothing.status).toBe(422);

    const prov = await root.post(`/platform/tenants/${tenantId}/provision`, {
      plan_code: 'STARTER',
      admin: { mobile: phone, first_name: 'Ravi', password: 'Welcome123' },
    });
    expect(prov.status, JSON.stringify(prov.body)).toBe(200);
    expect(prov.body.data.invitation_id).toBeNull();

    const res = await phoneLogin(`+91 ${phone}`, 'Welcome123');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await phoneLogin(phone, 'Welcome123')).status).toBe(200);

    const admins = await root.get(`/platform/tenants/${tenantId}/admins`);
    expect(admins.body.data[0]).toMatchObject({ email: null, login_phone: `+91${phone}` });

    // The platform changes the admin's number; the old one stops working.
    const next = mobile();
    const changed = await root.put(
      `/platform/tenants/${tenantId}/admins/${admins.body.data[0].membership_id}/mobile`,
      { mobile: next },
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.data.login_phone).toBe(`+91${next}`);
    expect((await phoneLogin(phone, 'Welcome123')).status).toBe(401);
    expect((await phoneLogin(next, 'Welcome123')).status).toBe(200);

    // A login without an email can't lose its only identifier.
    const cleared = await root.put(
      `/platform/tenants/${tenantId}/admins/${admins.body.data[0].membership_id}/mobile`,
      { mobile: null },
    );
    expect(cleared.status).toBe(422);
  });

  it('lets a school create staff logins by mobile number, change it and set a password', async () => {
    const { admin } = await h.provisionSchool({ plan: 'STANDARD' });
    const accountant = await h.roleId(admin.api, 'ACCOUNTANT');
    const phone = mobile();

    const noPassword = await admin.api.post('/members/invitations', {
      mobile: phone,
      first_name: 'Meena',
      roles: [{ role_id: accountant }],
    });
    expect(noPassword.status).toBe(422);

    const created = await admin.api.post('/members/invitations', {
      mobile: phone,
      first_name: 'Meena',
      password: 'Accounts1',
      roles: [{ role_id: accountant }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.status).toBe('ACTIVE');
    expect(created.body.data.user).toMatchObject({ email: null, login_phone: `+91${phone}` });
    expect((await phoneLogin(phone, 'Accounts1')).status).toBe(200);

    // The same number can't name a second account.
    const dup = await admin.api.post('/members/invitations', {
      mobile: phone,
      first_name: 'Other',
      password: 'Accounts1',
      roles: [{ role_id: accountant }],
    });
    // Same number at the same school = the same person, already a member.
    expect(dup.status).toBe(409);
    expect(code(dup)).toBe('DUPLICATE_RESOURCE');

    const memberId = created.body.data.id;
    const next = mobile();
    const changed = await admin.api.put(`/members/${memberId}/mobile`, { mobile: next });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.data.user.login_phone).toBe(`+91${next}`);

    const pw = await admin.api.put(`/members/${memberId}/password`, { password: 'NewPass22' });
    expect(pw.status, JSON.stringify(pw.body)).toBe(200);
    expect((await phoneLogin(next, 'NewPass22')).status).toBe(200);

    // Another school can't take a number that is already in use.
    const other = await h.provisionSchool({ plan: 'STANDARD' });
    const otherRole = await h.roleId(other.admin.api, 'ACCOUNTANT');
    const taken = await other.admin.api.post('/members/invitations', {
      email: `${uniq('x')}@school.test`,
      mobile: next,
      first_name: 'Taken',
      password: 'Accounts1',
      roles: [{ role_id: otherRole }],
    });
    expect(taken.status).toBe(422);
    expect(code(taken)).toBe('OPERATION_NOT_ALLOWED');

    // An email login still works and can add a mobile number later.
    const email = `${uniq('clerk')}@school.test`;
    const byEmail = await admin.api.post('/members/invitations', {
      email,
      first_name: 'Clerk',
      password: 'Clerk1234',
      roles: [{ role_id: accountant }],
    });
    expect(byEmail.status).toBe(201);
    expect(
      (await h.http.post('/api/v1/auth/login').send({ email, password: 'Clerk1234' })).status,
    ).toBe(200);
    const added = mobile();
    expect(
      (await admin.api.put(`/members/${byEmail.body.data.id}/mobile`, { mobile: added })).status,
    ).toBe(200);
    expect((await phoneLogin(added, 'Clerk1234')).status).toBe(200);
    // With an email the mobile number can be removed again.
    expect(
      (await admin.api.put(`/members/${byEmail.body.data.id}/mobile`, { mobile: null })).status,
    ).toBe(200);
  });

  it('lets the platform team add staff by mobile number, change it and set a password', async () => {
    const root = await h.superAdmin();
    const roles = await root.get('/platform/roles');
    const platformAdmin = roles.body.data.find(
      (r: { code: string }) => r.code === 'PLATFORM_ADMIN',
    ).id;
    const phone = mobile();

    const noPassword = await root.post('/platform/users/invitations', {
      mobile: phone,
      first_name: 'Asha',
      roles: [{ role_id: platformAdmin }],
    });
    expect(noPassword.status).toBe(422);

    const created = await root.post('/platform/users/invitations', {
      mobile: phone,
      first_name: 'Asha',
      password: 'Platform1',
      roles: [{ role_id: platformAdmin }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.status).toBe('ACTIVE');
    expect(created.body.data.user).toMatchObject({ email: null, login_phone: `+91${phone}` });
    expect((await phoneLogin(phone, 'Platform1')).status).toBe(200);

    const id = created.body.data.id;
    const detail = await root.get(`/platform/users/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.user.login_phone).toBe(`+91${phone}`);
    const list = await root.get(`/platform/users?search=${phone}`);
    expect(list.body.data.map((m: { id: string }) => m.id)).toContain(id);

    const next = mobile();
    const changed = await root.put(`/platform/users/${id}/mobile`, { mobile: next });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.data.user.login_phone).toBe(`+91${next}`);
    expect((await phoneLogin(phone, 'Platform1')).status).toBe(401);
    expect((await root.put(`/platform/users/${id}/mobile`, { mobile: null })).status).toBe(422);

    const pw = await root.put(`/platform/users/${id}/password`, { password: 'Platform22' });
    expect(pw.status, JSON.stringify(pw.body)).toBe(200);
    expect((await phoneLogin(next, 'Platform1')).status).toBe(401);
    expect((await phoneLogin(next, 'Platform22')).status).toBe(200);

    // A number used by a school login can't be taken, by invite or by a change.
    const { admin } = await h.provisionSchool({ plan: 'STANDARD' });
    const schoolPhone = mobile();
    const staff = await admin.api.post('/members/invitations', {
      mobile: schoolPhone,
      first_name: 'Meena',
      password: 'Accounts1',
      roles: [{ role_id: await h.roleId(admin.api, 'ACCOUNTANT') }],
    });
    expect(staff.status).toBe(201);
    const dupChange = await root.put(`/platform/users/${id}/mobile`, { mobile: schoolPhone });
    expect(dupChange.status).toBe(409);
    expect(code(dupChange)).toBe('DUPLICATE_RESOURCE');
    // Inviting that number reuses the school person's account, so the platform can't set
    // its password (that would take over their school login).
    const takeover = await root.post('/platform/users/invitations', {
      mobile: schoolPhone,
      first_name: 'Meena',
      password: 'Takeover1',
      roles: [{ role_id: platformAdmin }],
    });
    expect(takeover.status).toBe(422);
    expect(code(takeover)).toBe('OPERATION_NOT_ALLOWED');
    expect((await phoneLogin(schoolPhone, 'Accounts1')).status).toBe(200);
  });
});
