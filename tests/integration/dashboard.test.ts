import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, uniq, type Api, type Harness } from '../helpers.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let B: Awaited<ReturnType<Harness['provisionSchool']>>;

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(Date.now() - n * DAY);
const inDays = (n: number) => iso(Date.now() + n * DAY);
/** The most recent Monday–Friday on or before today (a school day under the default calendar). */
function lastWeekday() {
  for (let n = 0; n < 7; n++) {
    const d = new Date(Date.now() - n * DAY);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) return iso(d.getTime());
  }
  return daysAgo(0);
}

async function setup(a: Api) {
  const y = await a.post('/academic-years', {
    code: uniq('Y'),
    name: 'Dashboard year',
    start_date: daysAgo(120),
    end_date: inDays(200),
  });
  expect(y.status, JSON.stringify(y.body)).toBe(201);
  const yearId = y.body.data.id as string;
  expect((await a.post(`/academic-years/${yearId}/activate`, { complete_current: true })).status).toBe(200);
  const cls = await a.post('/academic-classes', { code: uniq('G5'), name: 'Grade 5', sequence: 5 });
  const classId = cls.body.data.id as string;
  const section = async (name: string) => {
    const r = await a.post(`/academic-years/${yearId}/sections`, {
      class_id: classId,
      code: uniq(name).toUpperCase().slice(0, 30),
      name,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data.id as string;
  };
  const secA = await section('A');
  const secB = await section('B');
  const student = async (first: string, sectionId: string) => {
    const r = await a.post('/students', {
      first_name: first,
      last_name: uniq('Fam'),
      gender: 'FEMALE',
      enrollment: { academic_year_id: yearId, class_id: classId, section_id: sectionId, start_date: daysAgo(60) },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data.id as string;
  };
  const s1 = await student('Asha', secA);
  const s2 = await student('Bina', secA);
  await student('Chitra', secB);
  return { yearId, classId, secA, secB, s1, s2 };
}

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  B = await h.provisionSchool();
});
afterAll(async () => h?.close());

describe('GET /dashboard/school', () => {
  it('shows the day, the year, registers, the attendance trend and leaves out nothing it may see', async () => {
    const a = A.admin.api;
    const st = await setup(a);
    const statuses = await a.get('/attendance/statuses');
    const id = Object.fromEntries(
      (statuses.body.data as { code: string; id: string }[]).map((s) => [s.code, s.id]),
    );
    const date = lastWeekday();
    const open = await a.post('/attendance/sessions', { section_id: st.secA, session_date: date });
    expect([200, 201], JSON.stringify(open.body)).toContain(open.status);
    const sessionId = open.body.data.id as string;
    const marked = await a.put(`/attendance/sessions/${sessionId}/records`, {
      records: [
        { student_id: st.s1, status_id: id.PRESENT },
        { student_id: st.s2, status_id: id.ABSENT },
      ],
    });
    expect(marked.status, JSON.stringify(marked.body)).toBe(200);
    expect((await a.post(`/attendance/sessions/${sessionId}/submit`, {})).status).toBe(200);

    const res = await a.get('/dashboard/school');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body.data;
    expect(d.academic_year).toMatchObject({ id: st.yearId });
    expect(d.attendance).toBeTruthy();
    expect(d.attendance.threshold).toBeGreaterThan(0);
    const point = (d.attendance.trend as { date: string; percent: number; marked: number }[]).find(
      (p) => p.date === date,
    );
    expect(point).toMatchObject({ percent: 50, marked: 2 });
    // Section B has no register today.
    expect((d.attendance.not_started as { section_id: string }[]).map((s) => s.section_id)).toContain(
      st.secB,
    );
    expect(d.classes.totals.sections).toBeGreaterThanOrEqual(2);
    expect(d.classes.totals.enrolled).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(d.events)).toBe(true);
    for (const k of ['fees', 'teachers', 'exams', 'parents', 'admissions'])
      expect(Object.keys(d)).toContain(k);
  });

  it("another school sees only its own numbers", async () => {
    const res = await B.admin.api.get('/dashboard/school');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.academic_year).toBeNull();
    expect(res.body.data.attendance?.trend ?? []).toEqual([]);
  });

  it('needs a signed-in school member', async () => {
    const res = await h.as('not-a-token', A.tenantId).get('/dashboard/school');
    expect(res.status).toBe(401);
  });
});
