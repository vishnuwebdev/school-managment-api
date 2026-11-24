import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, uniq, type Api, type Harness } from '../helpers.js';

/** Teacher attendance register: day states, half days, leave marks, gaps and salary-ready totals. */
let h: Harness;
let api: Api;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const plus = (d: string, n: number) => iso(Date.parse(`${d}T00:00:00Z`) + n * DAY);

async function ok<T = Json>(res: { status: number; body: Json }, status = 200) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
}

// Last month: always fully in the past, whatever today is.
const now = new Date();
const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const month = iso(first.getTime()).slice(0, 7);
const monthStart = `${month}-01`;
const daysInMonth = new Date(
  Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
).getUTCDate();
// The first Monday of last month and the days after it.
const mon = (() => {
  let d = monthStart;
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = plus(d, 1);
  return d;
})();
const tue = plus(mon, 1);
const wed = plus(mon, 2);
const thu = plus(mon, 3);
const fri = plus(mon, 4);
const sun = plus(mon, 6);
const nextMon = plus(mon, 7);
const sundays = (() => {
  let n = 0;
  for (let i = 0; i < daysInMonth; i++)
    if (new Date(`${plus(monthStart, i)}T00:00:00Z`).getUTCDay() === 0) n++;
  return n;
})();

let teacherId: string;
let lateJoinerId: string;
let teacherApi: Api;

beforeAll(async () => {
  h = await createHarness();
  const A = await h.provisionSchool({ plan: 'STANDARD' });
  api = A.admin.api;
  // Only Sundays are weekly off days for this school.
  const settings = await ok(await api.get('/calendar/settings'));
  await ok(
    await api.put('/calendar/settings', {
      weekly_off_days: [7],
      off_saturdays: [],
      version: settings.version ?? 0,
    }),
  );
  const t = await ok(
    await api.post('/teachers', {
      first_name: 'Asha',
      last_name: uniq('Reg'),
      email: `${uniq('r')}@school.test`,
      joining_date: monthStart,
    }),
    201,
  );
  teacherId = t.id;
  await ok(
    await api.post(`/teachers/${t.id}/portal-access`, { role_id: await h.roleId(api, 'TEACHER') }),
    201,
  );
  teacherApi = (await h.acceptAndLogin(t.email)).api;
  lateJoinerId = (
    await ok(
      await api.post('/teachers', {
        first_name: 'Late',
        last_name: uniq('Join'),
        joining_date: plus(monthStart, 10),
      }),
      201,
    )
  ).id;
}, 120_000);
afterAll(() => h.close());

const setDay = (id: string, date: string, body: object) =>
  api.put(`/teacher-attendance/teachers/${id}/days/${date}`, body);
const rowOf = (reg: Json, id: string) => reg.rows.find((r: Json) => r.teacher_id === id);
const dayOf = (row: Json, date: string) => row.days.find((d: Json) => d.date === date);

describe('marking single days', () => {
  it('sets present, half day, absent and leave; refuses future, off and pre-joining days', async () => {
    await ok(await setDay(teacherId, mon, { status: 'PRESENT' }));
    await ok(await setDay(teacherId, tue, { status: 'HALF_DAY', note: 'Left at noon' }));
    await ok(await setDay(teacherId, wed, { status: 'ABSENT' }));
    const m = await ok(await setDay(teacherId, thu, { status: 'LEAVE' }));
    expect(dayOf(m, thu)).toMatchObject({
      state: 'LEAVE',
      marked: true,
      leave: { paid: true, approved: false }, // no leave module: a Leave mark is paid
    });
    expect(dayOf(m, tue)).toMatchObject({ state: 'HALF_DAY', note: 'Left at noon' });

    const future = await setDay(teacherId, plus(iso(Date.now()), 2), { status: 'PRESENT' });
    expect(future.status).toBe(422);
    const sunday = await setDay(teacherId, sun, { status: 'PRESENT' });
    expect(sunday.status).toBe(422);
    const early = await setDay(lateJoinerId, mon, { status: 'PRESENT' });
    expect(early.status, JSON.stringify(early.body)).toBe(422); // joined on the 11th
  });

  it('clears a mark back to "not marked"', async () => {
    await ok(await setDay(teacherId, fri, { status: 'PRESENT' }));
    const m = await ok(await setDay(teacherId, fri, { status: null }));
    expect(dayOf(m, fri)).toMatchObject({ state: 'NOT_MARKED', marked: false });
  });

  it('the daily roster lists teachers and accepts half days too', async () => {
    const r = await api.put(`/teacher-attendance?date=${mon}`, {
      entries: [{ teacher_id: teacherId, status: 'PRESENT' }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const roster = await ok(await api.get(`/teacher-attendance?date=${mon}`));
    const me = roster.entries.find((e: Json) => e.teacher_id === teacherId);
    expect(me).toMatchObject({ status: 'PRESENT', on_leave: false });
    expect(me).not.toHaveProperty('staff_type');
    // The late joiner had not started yet.
    expect(roster.entries.some((e: Json) => e.teacher_id === lateJoinerId)).toBe(false);
  });
});

describe('the month register', () => {
  it('fills weekly offs and gaps, and works out payable days', async () => {
    const reg = await ok(await api.get(`/teacher-attendance/register?month=${month}`));
    expect(reg.partial).toBe(false);
    expect(reg.days).toHaveLength(daysInMonth);
    expect(reg.days.find((d: Json) => d.date === sun).off).toMatchObject({ reason: 'WEEKLY_OFF' });

    const row = rowOf(reg, teacherId);
    expect(dayOf(row, sun).state).toBe('OFF');
    expect(dayOf(row, nextMon).state).toBe('NOT_MARKED');
    expect(dayOf(row, fri).state).toBe('NOT_MARKED');

    const working = daysInMonth - sundays;
    expect(row.summary).toMatchObject({
      employed_days: daysInMonth,
      working_days: working,
      present: 1,
      half_day: 1,
      absent: 1,
      leave_unpaid: 0,
      leave_paid: 1,
      not_marked: working - 4,
      attended: 1.5,
      loss_of_pay_days: 1.5, // absent + ½ half day (the Leave mark is paid)
      payable_days: daysInMonth - 1.5,
      complete: false,
    });
    expect(row.summary.attendance_percent).toBe(50); // 1.5 of 3 marked working days

    const late = rowOf(reg, lateJoinerId);
    expect(dayOf(late, monthStart).state).toBe('NOT_EMPLOYED');
    expect(late.summary.employed_days).toBe(daysInMonth - 10);

    // Filters
    const found = await ok(await api.get(`/teacher-attendance/register?month=${month}&q=Asha`));
    expect(found.rows.map((r: Json) => r.teacher_id)).toEqual([teacherId]);
  });

  it("shows one person's month and year, with the dates they were absent", async () => {
    const m = await ok(await api.get(`/teacher-attendance/teachers/${teacherId}?month=${month}`));
    expect(m.teacher.teacher_id).toBe(teacherId);
    expect(m.summary.absent).toBe(1);
    const y = await ok(
      await api.get(`/teacher-attendance/teachers/${teacherId}/year?year=${month.slice(0, 4)}`),
    );
    const mm = y.months.find((x: Json) => x.month === month);
    expect(mm.absent_dates).toEqual([wed]);
    expect(mm.summary.loss_of_pay_days).toBe(1.5);
  });

  it('exports the register as CSV, with day columns on request', async () => {
    const csv = await api.get(`/teacher-attendance/export?month=${month}&with_days=true`);
    expect(csv.status).toBe(200);
    const text = csv.text as string;
    expect(text.split('\n')[0]).toContain('Payable days');
    expect(text).toContain(`${mon.slice(8)} Mon`);
    const line = text.split('\n').find((l) => l.includes('Asha'))!;
    expect(line).toContain(',P,H,A,LV,?,');
  });

  it('is for attendance managers only', async () => {
    expect((await teacherApi.get(`/teacher-attendance/register?month=${month}`)).status).toBe(403);
    expect(
      (
        await teacherApi.put(`/teacher-attendance/teachers/${teacherId}/days/${mon}`, {
          status: 'PRESENT',
        })
      ).status,
    ).toBe(403);
  });
});
