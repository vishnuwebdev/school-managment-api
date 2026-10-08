import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let B: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;
let teacherRole: string;

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const today = () => day(0);

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  B = await h.provisionSchool();
  api = A.admin.api;
  teacherRole = await h.roleId(api, 'TEACHER');
});
afterAll(() => h.close());

async function staff(first: string) {
  const res = await api.post('/teachers', {
    first_name: first,
    last_name: uniq('Fam'),
    email: `${uniq('s')}@school.test`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const t = res.body.data as { id: string; email: string };
  const inv = await api.post(`/teachers/${t.id}/portal-access`, { role_id: teacherRole });
  expect(inv.status, JSON.stringify(inv.body)).toBe(201);
  const session = await h.acceptAndLogin(t.email);
  return { ...t, api: session.api };
}
async function typeId(a: Api, codeName: string) {
  const list = await a.get('/leave-types');
  return list.body.data.find((t: { code: string }) => t.code === codeName).id as string;
}

describe('leave types', () => {
  it('seeds defaults, lets the school add and switch off its own, and stays per school', async () => {
    const list = await api.get('/leave-types');
    expect(list.body.data.map((t: { code: string }) => t.code)).toEqual(
      expect.arrayContaining(['CASUAL', 'SICK', 'UNPAID']),
    );
    const added = await api.post('/leave-types', {
      code: 'maternity',
      name: 'Maternity leave',
      annual_quota: 90,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.data.code).toBe('MATERNITY');
    expect((await api.post('/leave-types', { code: 'MATERNITY', name: 'Again' })).status).toBe(409);
    const off = await api.patch(`/leave-types/${added.body.data.id}`, { is_active: false });
    expect(off.body.data.is_active).toBe(false);
    const other = await B.admin.api.get('/leave-types');
    expect(other.body.data.map((t: { code: string }) => t.code)).not.toContain('MATERNITY');
  });
});

describe('leave requests', () => {
  it('requests, shows a live balance, refuses overlaps and overdrafts, then approves', async () => {
    const t = await staff('Leafy');
    const casual = await typeId(api, 'CASUAL');
    const res = await t.api.post('/leave-requests', {
      leave_type_id: casual,
      start_date: day(10),
      end_date: day(12),
      reason: 'Family function',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'PENDING', days: 3 });

    const bal = await t.api.get('/leave-balance');
    const row = bal.body.data.types.find(
      (x: { leave_type: { code: string } }) => x.leave_type.code === 'CASUAL',
    );
    expect(row).toMatchObject({ annual_quota: 12, pending_days: 3, remaining: 9 });

    const overlap = await t.api.post('/leave-requests', {
      leave_type_id: casual,
      start_date: day(12),
      end_date: day(13),
    });
    expect(overlap.status).toBe(409);

    const tooMuch = await t.api.post('/leave-requests', {
      leave_type_id: casual,
      start_date: day(40),
      end_date: day(60),
    });
    expect(tooMuch.status).toBe(422);
    expect(code(tooMuch)).toBe('OPERATION_NOT_ALLOWED');
    expect(
      (
        await t.api.post('/leave-requests', {
          leave_type_id: casual,
          start_date: day(5),
          end_date: day(4),
        })
      ).status,
    ).toBe(422);

    // A teacher cannot approve; the admin can, and the history records it.
    expect((await t.api.post(`/leave-requests/${res.body.data.id}/approve`, {})).status).toBe(403);
    const ok = await api.post(`/leave-requests/${res.body.data.id}/approve`, { note: 'Enjoy' });
    expect(ok.body.data.status).toBe('APPROVED');
    expect((await api.post(`/leave-requests/${res.body.data.id}/approve`, {})).status).toBe(422);
    const bal2 = await t.api.get('/leave-balance');
    expect(
      bal2.body.data.types.find(
        (x: { leave_type: { code: string } }) => x.leave_type.code === 'CASUAL',
      ),
    ).toMatchObject({ approved_days: 3, pending_days: 0, remaining: 9 });
    const events = (await api.get(`/teachers/${t.id}/history`)).body.data.map(
      (e: { event_type: string }) => e.event_type,
    );
    expect(events).toEqual(expect.arrayContaining(['LEAVE_REQUESTED', 'LEAVE_APPROVED']));

    // Approved leave that has not started can be cancelled by the owner, freeing the days.
    const cancel = await t.api.post(`/leave-requests/${res.body.data.id}/cancel`, {});
    expect(cancel.body.data.status).toBe('CANCELLED');
  });

  it('rejection needs a note; staff see only their own requests; other schools see nothing', async () => {
    const a = await staff('Alpha');
    const b = await staff('Bravo');
    const sick = await typeId(api, 'SICK');
    const ra = await a.api.post('/leave-requests', {
      leave_type_id: sick,
      start_date: day(20),
      end_date: day(21),
    });
    await b.api.post('/leave-requests', {
      leave_type_id: sick,
      start_date: day(20),
      end_date: day(21),
    });

    expect((await api.post(`/leave-requests/${ra.body.data.id}/reject`, {})).status).toBe(422);
    const rej = await api.post(`/leave-requests/${ra.body.data.id}/reject`, {
      note: 'Exams that week',
    });
    expect(rej.body.data).toMatchObject({ status: 'REJECTED', decision_note: 'Exams that week' });

    const mine = await a.api.get('/leave-requests');
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].teacher.id).toBe(a.id);
    expect((await b.api.get(`/leave-requests/${ra.body.data.id}`)).status).toBe(404);
    const all = await api.get('/leave-requests?status=PENDING');
    expect(all.body.data.length).toBeGreaterThanOrEqual(1);
    expect((await B.admin.api.get(`/leave-requests/${ra.body.data.id}`)).status).toBe(404);
  });

  it('lets an approver request on behalf, but not a teacher for someone else', async () => {
    const a = await staff('Behalf');
    const b = await staff('Other');
    const casual = await typeId(api, 'CASUAL');
    const ok = await api.post('/leave-requests', {
      teacher_id: a.id,
      leave_type_id: casual,
      start_date: day(30),
      end_date: day(30),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const denied = await b.api.post('/leave-requests', {
      teacher_id: a.id,
      leave_type_id: casual,
      start_date: day(31),
      end_date: day(31),
    });
    expect(denied.status).toBe(403);
  });
});

describe('staff attendance', () => {
  it('lists the roster, marks and corrects a day, and refuses the future', async () => {
    const t = await staff('Marked');
    const roster = await api.get(`/staff-attendance?date=${today()}`);
    expect(roster.status, JSON.stringify(roster.body)).toBe(200);
    const row = roster.body.data.entries.find((e: { teacher_id: string }) => e.teacher_id === t.id);
    expect(row.status).toBeNull();

    const mark = await api.put(`/staff-attendance?date=${today()}`, {
      entries: [{ teacher_id: t.id, status: 'PRESENT' }],
    });
    expect(mark.status, JSON.stringify(mark.body)).toBe(200);
    const fix = await api.put(`/staff-attendance?date=${today()}`, {
      entries: [{ teacher_id: t.id, status: 'LATE', note: 'Bus delay' }],
    });
    expect(fix.body.data.summary.late).toBe(1);
    const after = await api.get(`/staff-attendance?date=${today()}`);
    expect(
      after.body.data.entries.find((e: { teacher_id: string }) => e.teacher_id === t.id),
    ).toMatchObject({ status: 'LATE', note: 'Bus delay' });

    expect(
      (
        await api.put(`/staff-attendance?date=${day(1)}`, {
          entries: [{ teacher_id: t.id, status: 'PRESENT' }],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await api.put(`/staff-attendance?date=${today()}`, {
          entries: [
            { teacher_id: t.id, status: 'PRESENT' },
            { teacher_id: t.id, status: 'ABSENT' },
          ],
        })
      ).status,
    ).toBe(422);
  });

  it('flags approved leave on the roster, summarises the month, exports CSV, and guards access', async () => {
    const t = await staff('Monthly');
    const casual = await typeId(api, 'CASUAL');
    const lr = await api.post('/leave-requests', {
      teacher_id: t.id,
      leave_type_id: casual,
      start_date: day(3),
      end_date: day(4),
    });
    await api.post(`/leave-requests/${lr.body.data.id}/approve`, {});
    const future = await api.get(`/staff-attendance?date=${day(3)}`);
    expect(
      future.body.data.entries.find((e: { teacher_id: string }) => e.teacher_id === t.id)
        .on_approved_leave,
    ).toBe(true);

    await api.put(`/staff-attendance?date=${today()}`, {
      entries: [{ teacher_id: t.id, status: 'ABSENT' }],
    });
    const month = today().slice(0, 7);
    const m = await api.get(`/staff-attendance/monthly?month=${month}`);
    expect(
      m.body.data.rows.find((r: { teacher_id: string }) => r.teacher_id === t.id),
    ).toMatchObject({
      absent: 1,
      marked_days: 1,
    });
    const csv = await api.get(`/staff-attendance/export?month=${month}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');

    // A teacher can read their own marks but not the roster or mark anyone.
    const mine = await t.api.get(`/staff-attendance/mine?month=${month}`);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.data.summary.absent).toBe(1);
    expect((await t.api.get(`/staff-attendance?date=${today()}`)).status).toBe(403);
    expect(
      (
        await t.api.put(`/staff-attendance?date=${today()}`, {
          entries: [{ teacher_id: t.id, status: 'PRESENT' }],
        })
      ).status,
    ).toBe(403);
    // Another school's staff are not found.
    const foreign = await B.admin.api.put(`/staff-attendance?date=${today()}`, {
      entries: [{ teacher_id: t.id, status: 'PRESENT' }],
    });
    expect(foreign.status).toBe(404);
  });
});
