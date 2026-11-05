import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, uniq, type Api, type Harness } from '../helpers.js';

/** Student attendance month grid (/attendance/reports/month-grid). */
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

// Last month: fully in the past, whatever today is.
const now = new Date();
const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const month = iso(first.getTime()).slice(0, 7);
const daysInMonth = new Date(
  Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
).getUTCDate();
const mon = (() => {
  let d = `${month}-01`;
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = plus(d, 1);
  return d;
})();
const tue = plus(mon, 1);
const wed = plus(mon, 2);
const sun = plus(mon, 6);

let sectionId: string;
let asha: string;
let ben: string;

beforeAll(async () => {
  h = await createHarness();
  const A = await h.provisionSchool({ plan: 'STANDARD' });
  api = A.admin.api;
  const settings = await ok(await api.get('/calendar/settings'));
  await ok(
    await api.put('/calendar/settings', {
      weekly_off_days: [7],
      off_saturdays: [],
      version: settings.version ?? 0,
    }),
  );
  const yearId = (
    await ok(
      await api.post('/academic-years', {
        code: uniq('Y'),
        name: 'Grid year',
        start_date: iso(Date.now() - 200 * DAY),
        end_date: iso(Date.now() + 160 * DAY),
      }),
      201,
    )
  ).id;
  await ok(await api.post(`/academic-years/${yearId}/activate`, { complete_current: true }));
  const classId = (
    await ok(
      await api.post('/academic-classes', { code: uniq('G'), name: 'Grade 4', sequence: 4 }),
      201,
    )
  ).id;
  sectionId = (
    await ok(
      await api.post(`/academic-years/${yearId}/sections`, {
        class_id: classId,
        code: 'A',
        name: 'A',
      }),
      201,
    )
  ).id;
  const student = async (name: string) =>
    (
      await ok(
        await api.post('/students', {
          first_name: name,
          last_name: uniq('F'),
          gender: 'FEMALE',
          enrollment: {
            academic_year_id: yearId,
            class_id: classId,
            section_id: sectionId,
            start_date: iso(Date.now() - 90 * DAY),
          },
        }),
        201,
      )
    ).id as string;
  asha = await student('Asha');
  ben = await student('Ben');
  const ids = Object.fromEntries(
    (await ok<Json[]>(await api.get('/attendance/statuses'))).map((s) => [s.code, s.id]),
  ) as Record<string, string>;
  const take = async (date: string, marks: [string, string][]) => {
    const s = await api.post('/attendance/sessions', { section_id: sectionId, session_date: date });
    expect([200, 201], JSON.stringify(s.body)).toContain(s.status);
    const r = await api.put(`/attendance/sessions/${s.body.data.id}/records`, {
      records: marks.map(([student_id, code]) => ({ student_id, status_id: ids[code] })),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await api.post(`/attendance/sessions/${s.body.data.id}/submit`, {})).status).toBe(200);
  };
  await take(mon, [
    [asha, 'PRESENT'],
    [ben, 'ABSENT'],
  ]);
  await take(tue, [
    [asha, 'PRESENT'],
    [ben, 'PRESENT'],
  ]);
}, 120_000);
afterAll(() => h.close());

describe('the student month grid', () => {
  it('shows every day: marks, weekly offs and days with no register', async () => {
    const g = await ok(
      await api.get(`/attendance/reports/month-grid?section_id=${sectionId}&month=${month}`),
    );
    expect(g.partial).toBe(false);
    expect(g.days).toHaveLength(daysInMonth);
    const sunday = g.days.find((d: Json) => d.date === sun);
    expect(sunday.off).toMatchObject({ reason: 'WEEKLY_OFF' });
    expect(g.days.find((d: Json) => d.date === mon).session_id).toBeTruthy();

    const rowA = g.students.find((s: Json) => s.student.id === asha);
    const rowB = g.students.find((s: Json) => s.student.id === ben);
    const day = (row: Json, d: string) => row.days.find((x: Json) => x.date === d);
    expect(day(rowA, mon)).toMatchObject({ state: 'PRESENT', status_code: 'PRESENT', final: true });
    expect(day(rowB, mon)).toMatchObject({ state: 'ABSENT' });
    expect(day(rowA, sun).state).toBe('OFF');
    expect(day(rowA, wed).state).toBe('NOT_MARKED');
    expect(rowA.summary).toMatchObject({ present: 2, absent: 0, percentage: 100 });
    expect(rowB.summary).toMatchObject({ present: 1, absent: 1, percentage: 50 });
    expect(rowA.summary.not_marked).toBe(rowA.summary.school_days - 2);
    expect(g.totals).toMatchObject({
      students: 2,
      registers_taken: 2,
      absences: 1,
      percentage: 75,
    });
  });
});
