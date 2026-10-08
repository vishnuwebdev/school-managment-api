import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, uniq, type Api, type Harness } from '../helpers.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let B: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;
let classId: string;
let enrollment: { academic_year_id: string; class_id: string; section_id: string };
const last = uniq('Rep');

type Row = Record<string, string | number | null>;

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  B = await h.provisionSchool();
  api = A.admin.api;
  const y = await api.post('/academic-years', {
    code: 'Y-RP',
    name: 'Year RP',
    start_date: '2026-04-01',
    end_date: '2027-03-31',
  });
  await api.post(`/academic-years/${y.body.data.id}/activate`, { complete_current: true });
  const cls = await api.post('/academic-classes', { code: 'G7RP', name: 'Grade 7', sequence: 7 });
  classId = cls.body.data.id;
  const sec = await api.post(`/academic-years/${y.body.data.id}/sections`, {
    class_id: classId,
    code: 'A',
    name: 'Section A',
  });
  enrollment = {
    academic_year_id: y.body.data.id,
    class_id: classId,
    section_id: sec.body.data.id,
  };
  const mk = (first: string, gender: string, extra: object = {}) =>
    api.post('/students', {
      first_name: first,
      last_name: last,
      gender,
      admission_date: '2026-05-10',
      enrollment,
      ...extra,
    });
  await mk('Boy', 'MALE');
  await mk('Girl1', 'FEMALE');
  const g2 = await mk('Girl2', 'FEMALE');
  await api.post(`/students/${g2.body.data.id}/transfer`, {
    reason: 'Moved away',
    destination_school: 'Elsewhere High',
    effective_date: '2026-08-01',
  });
});
afterAll(() => h.close());

describe('student reports', () => {
  it('counts class strength and gender strength', async () => {
    const r = await api.get('/students/reports/class-strength');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows: Row[] = r.body.data.rows;
    const sec = rows.find((x) => x.section === 'Section A')!;
    expect(sec).toMatchObject({ male: 1, female: 2 - 1, total: 2 });
    expect(rows.at(-1)).toMatchObject({ class: 'Total', total: 2 });

    const g = await api.get('/students/reports/gender-strength');
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.data.rows.find((x: Row) => x.class === 'Grade 7')).toMatchObject({ total: 2 });
  });

  it('lists admissions in a date range and rejects a reversed range', async () => {
    const r = await api.get('/students/reports/admissions?date_from=2026-05-01&date_to=2026-05-31');
    expect(r.status).toBe(200);
    expect(r.body.data.rows.filter((x: Row) => String(x.name).includes(last))).toHaveLength(3);
    const none = await api.get(
      '/students/reports/admissions?date_from=2025-01-01&date_to=2025-01-31',
    );
    expect(none.body.data.rows.filter((x: Row) => String(x.name).includes(last))).toHaveLength(0);
    const bad = await api.get(
      '/students/reports/admissions?date_from=2026-06-01&date_to=2026-05-01',
    );
    expect(bad.status).toBe(422);
  });

  it('shows transfers with destination, and an empty withdrawals report', async () => {
    const t = await api.get('/students/reports/transfers');
    const mine = t.body.data.rows.filter((x: Row) => String(x.name).includes(last));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ destination: 'Elsewhere High', class: 'Grade 7 · Section A' });
    const w = await api.get('/students/reports/withdrawals');
    expect(w.body.data.rows.filter((x: Row) => String(x.name).includes(last))).toHaveLength(0);
  });

  it('filters the student list and exports CSV', async () => {
    const r = await api.get(`/students/reports/student-list?class_id=${classId}&gender=FEMALE`);
    expect(r.body.data.rows).toHaveLength(1);
    const csv = await api.get('/students/reports/student-list?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\n')[0]).toContain('Admission no.');
  });

  it('keeps schools apart and rejects unknown reports', async () => {
    const r = await B.admin.api.get('/students/reports/student-list');
    expect(r.body.data.rows).toHaveLength(0);
    expect((await api.get('/students/reports/nope')).status).toBe(422);
  });
});
