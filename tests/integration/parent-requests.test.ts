import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

/**
 * What parents send to the school (0046): their own profile, requests to change a child's
 * details (approved by the office), complaints / feedback / suggestions with replies, and
 * changing their password.
 */
let h: Harness;
let api: Api;
let parent: Api;
let reception: Api;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
function ok<T = Json>(res: { status: number; body: Json }, status = 200) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
}

let mine: Json;
let other: Json;
let guardianId: string;
const PASSWORD = 'Parent12345';
const PHONE = '+91 98765 33333';

beforeAll(async () => {
  h = await createHarness();
  const A = await h.provisionSchool({ plan: 'STANDARD' });
  api = A.admin.api;
  const yearId = ok(
    await api.post('/academic-years', {
      code: 'RY',
      name: '2026-27',
      start_date: daysAgo(120),
      end_date: inDays(200),
    }),
    201,
  ).id;
  ok(await api.post(`/academic-years/${yearId}/activate`, { complete_current: true }));
  const classId = ok(
    await api.post('/academic-classes', { code: 'G4', name: 'Grade 4', sequence: 4 }),
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
  const student = async (first: string, phone: string) =>
    ok(
      await api.post('/students', {
        first_name: first,
        last_name: uniq('Fam'),
        gender: 'FEMALE',
        date_of_birth: '2016-05-01',
        guardians: [
          {
            guardian: { first_name: 'Meera', last_name: uniq('Par'), phone },
            relationship_type: 'PARENT',
            relationship_label: 'Mother',
          },
        ],
        enrollment: {
          academic_year_id: yearId,
          class_id: classId,
          section_id: sectionId,
          start_date: daysAgo(30),
        },
      }),
      201,
    );
  mine = await student('Isha', PHONE);
  other = await student('Other', '+91 90000 44444');
  guardianId = mine.guardians[0].guardian.id;
  ok(await api.post(`/guardians/${guardianId}/app-access`, { password: PASSWORD }), 201);
  const login = await h.http.post('/api/v1/auth/login').send({ phone: PHONE, password: PASSWORD });
  parent = h.as(login.body.data.access_token);
  reception = (await h.addMember(api, [{ role_id: await h.roleId(api, 'RECEPTIONIST') }])).api;
}, 120_000);
afterAll(() => h.close());

describe('my profile', () => {
  it('shows and saves my details; the sign-in number stays with the school', async () => {
    const p = ok(await parent.get('/parent/profile'));
    expect(p).toMatchObject({ guardian_id: guardianId, first_name: 'Meera' });
    expect(p.sign_in.mobile).toContain('9876533333');
    const saved = ok(
      await parent.patch('/parent/profile', {
        version: p.version,
        first_name: 'Meera K',
        occupation: 'Engineer',
        address: { line1: '12 MG Road', city: 'Pune', postal_code: '411001', country: 'IN' },
        notify_sms: false,
      }),
    );
    expect(saved).toMatchObject({
      first_name: 'Meera K',
      occupation: 'Engineer',
      notify_sms: false,
    });
    expect(saved.version).toBe(p.version + 1);
    // Stale version
    expect(
      (await parent.patch('/parent/profile', { version: p.version, occupation: 'X' })).status,
    ).toBe(409);
    // The office sees it.
    const g = ok(await api.get(`/guardians/${guardianId}`));
    expect(g.occupation).toBe('Engineer');
    // The phone is not editable here (unknown field is dropped or rejected, never saved).
    await parent.patch('/parent/profile', { version: saved.version, phone: '+91 90000 00000' });
    expect(ok(await parent.get('/parent/profile')).phone).not.toBe('+91 90000 00000');
  });

  it('changes my password', async () => {
    const res = await parent.post('/auth/change-password', {
      current_password: PASSWORD,
      new_password: 'Parent99999',
    });
    expect(res.status).toBe(204);
    const again = await h.http
      .post('/api/v1/auth/login')
      .send({ phone: PHONE, password: 'Parent99999' });
    expect(again.status).toBe(200);
    parent = h.as(again.body.data.access_token);
  });
});

describe("child's details", () => {
  let requestId: string;
  it('asks the school, which approves; the record changes only then', async () => {
    const d = ok(await parent.get(`/parent/children/${mine.id}/details`));
    expect(d.fields.first_name).toBe('Isha');
    expect(d.pending).toBe(false);

    expect(
      code(
        await parent.post(`/parent/children/${mine.id}/change-requests`, {
          changes: { first_name: 'Isha' },
        }),
      ),
    ).toBe('VALIDATION_ERROR');

    const r = ok(
      await parent.post(`/parent/children/${mine.id}/change-requests`, {
        changes: { preferred_name: 'Ishu', blood_group: 'B+' },
        note: 'Please update',
      }),
      201,
    );
    expect(r.pending).toBe(true);
    requestId = r.requests[0].id;
    expect(r.requests[0].status).toBe('PENDING');
    expect(r.requests[0].changes.preferred_name).toEqual({ from: null, to: 'Ishu' });
    // One at a time
    expect(
      code(
        await parent.post(`/parent/children/${mine.id}/change-requests`, {
          changes: { preferred_name: 'I' },
        }),
      ),
    ).toBe('OPERATION_NOT_ALLOWED');
    // Not for another family's child
    expect(code(await parent.get(`/parent/children/${other.id}/details`))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    // Nothing changed yet
    expect(ok(await api.get(`/students/${mine.id}`)).preferred_name ?? null).toBeNull();

    const list = await api.get('/student-change-requests?status=PENDING');
    expect(list.status).toBe(200);
    expect(list.body.meta.pending).toBeGreaterThanOrEqual(1);
    expect(list.body.data.find((x: Json) => x.id === requestId)).toBeTruthy();
    const one = ok(await api.get(`/student-change-requests/${requestId}`));
    expect(one.changes.blood_group.to).toBe('B+');

    const done = ok(
      await api.post(`/student-change-requests/${requestId}/approve`, { note: 'Done' }),
    );
    expect(done.status).toBe('APPROVED');
    const s = ok(await api.get(`/students/${mine.id}`));
    expect(s.preferred_name).toBe('Ishu');
    expect(code(await api.post(`/student-change-requests/${requestId}/reject`, {}))).toBe(
      'INVALID_STATE',
    );
    const after = ok(await parent.get(`/parent/children/${mine.id}/details`));
    expect(after.fields.preferred_name).toBe('Ishu');
    expect(after.requests[0]).toMatchObject({ status: 'APPROVED', decision_note: 'Done' });
  });

  it('can be rejected or withdrawn', async () => {
    const r = ok(
      await parent.post(`/parent/children/${mine.id}/change-requests`, {
        changes: { date_of_birth: '2016-06-01' },
      }),
      201,
    );
    ok(
      await api.post(`/student-change-requests/${r.requests[0].id}/reject`, {
        note: 'Need a certificate',
      }),
    );
    const r2 = ok(
      await parent.post(`/parent/children/${mine.id}/change-requests`, {
        changes: { date_of_birth: '2016-06-01' },
      }),
      201,
    );
    const c = ok(await parent.post(`/parent/change-requests/${r2.requests[0].id}/cancel`));
    expect(c.requests[0].status).toBe('CANCELLED');
    expect(c.requests[1]).toMatchObject({
      status: 'REJECTED',
      decision_note: 'Need a certificate',
    });
    expect(ok(await api.get(`/students/${mine.id}`)).date_of_birth).toBe('2016-05-01');
  });
});

describe('complaints, feedback and suggestions', () => {
  let complaintId: string;
  let feedbackId: string;
  it('a complaint goes to the principal, not the front office', async () => {
    const c = ok(
      await parent.post('/parent/messages', {
        kind: 'COMPLAINT',
        topic: 'TRANSPORT',
        student_id: mine.id,
        subject: 'Bus is late',
        body: 'The bus has been 30 minutes late all week.',
      }),
      201,
    );
    complaintId = c.id;
    expect(c.reference_number).toMatch(/^CMP-\d{4}-\d{5}$/);
    expect(c.status).toBe('OPEN');
    expect(c.student.id).toBe(mine.id);

    const f = ok(
      await parent.post('/parent/messages', {
        kind: 'FEEDBACK',
        topic: 'STUDENT_PROGRESS',
        subject: 'Maths has improved',
        body: 'Thank you to the maths teacher.',
      }),
      201,
    );
    feedbackId = f.id;
    expect(
      code(
        await parent.post('/parent/messages', {
          kind: 'SUGGESTION',
          student_id: other.id,
          subject: 'Not mine',
          body: 'Another family',
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');

    const office = await reception.get('/feedback');
    expect(office.status).toBe(200);
    const ids = office.body.data.map((x: Json) => x.id);
    expect(ids).toContain(feedbackId);
    expect(ids).not.toContain(complaintId);
    expect(code(await reception.get(`/feedback/${complaintId}`))).toBe('RESOURCE_NOT_FOUND');

    const all = await api.get('/feedback?kind=COMPLAINT');
    expect(all.body.data.map((x: Json) => x.id)).toEqual([complaintId]);
    expect(all.body.data[0].guardian.phone).toBeTruthy();
    const sum = ok(await api.get('/feedback/summary'));
    expect(sum).toMatchObject({ open: 2, unread: 2 });
    expect(sum.by_kind.COMPLAINT.open).toBe(1);
  });

  it('the school replies and resolves; the parent sees it, replies and closes', async () => {
    const opened = ok(await api.get(`/feedback/${complaintId}`));
    expect(opened.unread).toBe(false);
    const replied = ok(
      await api.post(`/feedback/${complaintId}/replies`, { body: 'We spoke to the operator.' }),
      201,
    );
    expect(replied.status).toBe('IN_PROGRESS');
    const me = ok(await api.get('/auth/me'));
    const userId = me.user?.id ?? me.id;
    const assigned = ok(await api.patch(`/feedback/${complaintId}`, { assigned_to: userId }));
    expect(assigned.assigned_to.user_id).toBe(userId);
    ok(await api.patch(`/feedback/${complaintId}`, { status: 'RESOLVED' }));

    const home = await parent.get('/parent/home');
    expect(home.body.data.unread_messages).toBe(1);
    const mineList = await parent.get('/parent/messages');
    expect(mineList.body.meta.unread).toBeGreaterThanOrEqual(1);
    const t = ok(await parent.get(`/parent/messages/${complaintId}`));
    expect(t.status).toBe('RESOLVED');
    expect(t.guardian).toBeUndefined();
    expect(t.replies.map((r: Json) => r.author)).toEqual(['SCHOOL']);

    const again = ok(
      await parent.post(`/parent/messages/${complaintId}/replies`, { body: 'Still late today.' }),
      201,
    );
    expect(again.status).toBe('OPEN'); // re-opened for the school
    expect(again.replies).toHaveLength(2);
    const inbox = await api.get('/feedback?unread=true');
    expect(inbox.body.data.map((x: Json) => x.id)).toContain(complaintId);

    const closed = ok(await parent.post(`/parent/messages/${complaintId}/close`));
    expect(closed.status).toBe('CLOSED');
    expect(
      code(await parent.post(`/parent/messages/${complaintId}/replies`, { body: 'One more' })),
    ).toBe('INVALID_STATE');
  });

  it('keeps one family out of another’s messages', async () => {
    const g2 = other.guardians[0].guardian.id;
    ok(await api.post(`/guardians/${g2}/app-access`, { password: PASSWORD }), 201);
    const login = await h.http
      .post('/api/v1/auth/login')
      .send({ phone: '+91 90000 44444', password: PASSWORD });
    const p2 = h.as(login.body.data.access_token);
    expect(code(await p2.get(`/parent/messages/${feedbackId}`))).toBe('RESOURCE_NOT_FOUND');
    expect((await p2.get('/parent/messages')).body.data).toHaveLength(0);
    expect((await parent.get('/feedback')).status).toBe(403);
  });
});
