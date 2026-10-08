import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, uniq, type Api, type Harness } from '../helpers.js';

let h: Harness;
let api: Api;

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
function ok<T = Json>(res: { status: number; body: Json }, status = 200) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
}

let yearId: string;
let classId: string;
let secA: string;
let secB: string;
let baseId: string;
let extraId: string;
let catTuition: string;
let catLab: string;

async function enrolled(section: string) {
  const res = await api.post('/students', {
    first_name: 'Auto',
    last_name: uniq('Kid'),
    gender: 'MALE',
    enrollment: { academic_year_id: yearId, class_id: classId, section_id: section },
  });
  return ok(res, 201) as { id: string };
}
const assignmentsOf = async (studentId: string) =>
  ok<Json[]>(await api.get(`/fees/assignments?student_id=${studentId}`));
const demandsOf = async (studentId: string) =>
  ok<Json[]>(await api.get(`/fees/demands?student_id=${studentId}&page_size=100`));

beforeAll(async () => {
  h = await createHarness();
  const A = await h.provisionSchool();
  api = A.admin.api;
  const y = ok(
    await api.post('/academic-years', { code: 'Y-AUTO', name: 'Year Auto', start_date: daysAgo(30), end_date: inDays(300) }),
    201,
  );
  ok(await api.post(`/academic-years/${y.id}/activate`, { complete_current: true }));
  yearId = y.id;
  classId = ok(await api.post('/academic-classes', { code: 'G9', name: 'Grade 9', sequence: 9 }), 201).id;
  const sec = async (c: string) =>
    ok(await api.post(`/academic-years/${yearId}/sections`, { class_id: classId, code: c, name: `Section ${c}` }), 201).id as string;
  secA = await sec('A');
  secB = await sec('B');
  catTuition = ok(await api.post('/fees/categories', { code: 'TUITION', name: 'Tuition' }), 201).id;
  catLab = ok(await api.post('/fees/categories', { code: 'LAB', name: 'Lab fee' }), 201).id;

  // Base plan for the whole class: tuition 3000 every month.
  const base = ok(
    await api.post('/fees/structures', { code: 'G9-BASE', name: 'Grade 9 fees', academic_year_id: yearId, academic_class_id: classId }),
    201,
  );
  ok(
    await api.post(`/fees/structures/${base.id}/components`, {
      fee_category_id: catTuition,
      name: 'Tuition',
      amount: '3000.00',
      frequency: 'MONTHLY',
      due_rule: { type: 'DAY_OF_MONTH', day: 10 },
    }),
    201,
  );
  ok(await api.post(`/fees/structures/${base.id}/publish`, {}));
  baseId = base.id;

  // Extra fee for section A only: lab fee 800, one time.
  const extra = ok(
    await api.post('/fees/structures', {
      code: 'EXTRA_LAB_G9_A',
      name: 'Lab fee Grade 9 A',
      academic_year_id: yearId,
      academic_class_id: classId,
      academic_section_id: secA,
    }),
    201,
  );
  expect(extra.academic_section_id).toBe(secA);
  ok(
    await api.post(`/fees/structures/${extra.id}/components`, {
      fee_category_id: catLab,
      name: 'Lab fee',
      amount: '800.00',
      frequency: 'ONE_TIME',
      due_rule: { type: 'FIXED_DATE', date: inDays(20) },
    }),
    201,
  );
  ok(await api.post(`/fees/structures/${extra.id}/publish`, {}));
  extraId = extra.id;
}, 120_000);
afterAll(() => h.close());

describe('automatic billing on enrolment', () => {
  it('bills a newly enrolled student the class plan and the extra for their section', async () => {
    const s = await enrolled(secA);
    const assignments = await assignmentsOf(s.id);
    expect(assignments.map((a) => a.structure_code ?? a.fee_structure?.code).sort()).toEqual(['EXTRA_LAB_G9_A', 'G9-BASE']);
    const demands = await demandsOf(s.id);
    expect(demands.length).toBeGreaterThan(1);
    expect(demands.every((d) => d.status !== 'DRAFT')).toBe(true);
    const lab = demands.filter((d) => d.description === 'Lab fee');
    expect(lab).toHaveLength(1);
    expect(lab[0]!.final_amount).toBe('800.00');
    const summary = ok(await api.get(`/fees/students/${s.id}/summary`));
    expect(Number(summary.billed)).toBeGreaterThan(800);
  });

  it('does not bill another section for the extra fee', async () => {
    const s = await enrolled(secB);
    const codes = (await assignmentsOf(s.id)).map((a) => a.structure_code ?? a.fee_structure?.code);
    expect(codes).toEqual(['G9-BASE']);
    expect((await demandsOf(s.id)).some((d) => d.description === 'Lab fee')).toBe(false);
  });

  it('is idempotent: moving a student to another section does not bill the base plan twice', async () => {
    const s = await enrolled(secA);
    const [enrolment] = ok<Json[]>(await api.get(`/students/${s.id}/enrollments`));
    const before = (await demandsOf(s.id)).length;
    ok(await api.post(`/enrollments/${enrolment!.id}/change`, { section_id: secB, reason: 'Timetable' }));
    const after = await demandsOf(s.id);
    expect(after.length).toBe(before);
    const baseDemands = after.filter((d) => d.description === 'Tuition');
    expect(new Set(baseDemands.map((d) => d.period_key)).size).toBe(baseDemands.length);
  });

  it('only a published plan is applied: a draft plan bills nobody', async () => {
    const draft = ok(
      await api.post('/fees/structures', { code: 'G9-DRAFT', name: 'Draft', academic_year_id: yearId, academic_class_id: classId }),
      201,
    );
    ok(
      await api.post(`/fees/structures/${draft.id}/components`, {
        fee_category_id: catTuition,
        name: 'Draft fee',
        amount: '1.00',
        frequency: 'ONE_TIME',
        due_rule: { type: 'FIXED_DATE', date: inDays(5) },
      }),
      201,
    );
    const s = await enrolled(secB);
    expect((await demandsOf(s.id)).some((d) => d.description === 'Draft fee')).toBe(false);
  });

  it('rejects a section from another class or year', async () => {
    const other = ok(await api.post('/academic-classes', { code: 'G10', name: 'Grade 10', sequence: 10 }), 201);
    const res = await api.post('/fees/structures', {
      code: 'BAD-SEC',
      name: 'Bad',
      academic_year_id: yearId,
      academic_class_id: other.id,
      academic_section_id: secA,
    });
    expect(res.status).toBe(404);
    const noClass = await api.post('/fees/structures', { code: 'NO-CLS', name: 'Bad', academic_year_id: yearId, academic_section_id: secA });
    expect(noClass.status).toBe(422);
  });

  it('assigning the extra plan by hand skips students who already have it', async () => {
    const s = await enrolled(secA);
    const res = await api.post('/fees/assignments/bulk', { fee_structure_id: extraId, section_id: secA });
    expect(res.status).toBe(200);
    expect((await assignmentsOf(s.id)).filter((a) => (a.structure_code ?? a.fee_structure?.code) === 'EXTRA_LAB_G9_A')).toHaveLength(1);
    void baseId;
  });
});
