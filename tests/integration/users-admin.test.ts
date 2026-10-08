import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, type Harness } from '../helpers.js';

/** Users & Roles review follow-ups: reasons for permission changes, expired invitations. */
let h: Harness;
type School = Awaited<ReturnType<Harness['provisionSchool']>>;
let S: School;

beforeAll(async () => {
  h = await createHarness();
  S = await h.provisionSchool();
});
afterAll(() => h.close());

describe('changing a role’s permissions needs a reason (Part 4 §4.20)', () => {
  it('refuses a permission change without one, records it when given, and allows renames without', async () => {
    const created = await S.admin.api.post('/roles', {
      name: `Reasoned ${Date.now()}`,
      permissions: ['students.read'],
    });
    const role = created.body.data;
    const missing = await S.admin.api.patch(`/roles/${role.id}`, {
      version: role.version,
      permissions: ['students.read', 'attendance.read'],
    });
    expect(missing.status).toBe(422);
    expect(code(missing)).toBe('VALIDATION_ERROR');
    expect(missing.body.error.details.issues[0].path).toBe('reason');

    const ok = await S.admin.api.patch(`/roles/${role.id}`, {
      version: role.version,
      permissions: ['students.read', 'attendance.read'],
      reason: 'Coordinators now check attendance',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const audit = await S.admin.api.get(`/audit-logs?entity_id=${role.id}`);
    const change = audit.body.data.find(
      (a: { action: string }) => a.action === 'ROLE_PERMISSIONS_CHANGED',
    );
    expect(change.reason).toBe('Coordinators now check attendance');

    const rename = await S.admin.api.patch(`/roles/${role.id}`, {
      version: ok.body.data.version,
      name: `Renamed ${Date.now()}`,
    });
    expect(rename.status).toBe(200);
  });
});

describe('expired invitations', () => {
  it('the users list marks a pending invitation whose link expired, and resending clears it', async () => {
    const teacher = await h.roleId(S.admin.api, 'TEACHER');
    const email = `late-${Date.now()}@school.test`;
    const inv = await S.admin.api.post('/members/invitations', {
      email,
      first_name: 'Late',
      roles: [{ role_id: teacher }],
    });
    expect(inv.status).toBe(201);
    await h.drainOutbox(); // the email is sent: status SENT
    const row = async (api: typeof S.admin.api) =>
      (await api.get(`/members?status=INVITED&search=${encodeURIComponent(email)}`)).body.data[0];
    expect((await row(S.admin.api)).invitation).toMatchObject({ status: 'SENT', expired: false });

    h.clock.advanceDays(4); // past the 72-hour link lifetime
    const admin = h.as((await h.login(S.adminEmail, 'Password1234')).access_token);
    const late = await row(admin);
    expect(late.status).toBe('INVITED');
    expect(late.invitation.expired).toBe(true);

    expect((await admin.post(`/members/${late.id}/invitations/resend`)).status).toBe(200);
    expect((await row(admin)).invitation.expired).toBe(false);
  });
});
