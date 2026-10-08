import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, uniq, type Api, type Harness } from '../helpers.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;
let y1: string;
let y2: string;
let c7: string;
let c8: string;
let secA: string;
let secB: string;
let sec8: string;

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  api = A.admin.api;
  const a = await api.post('/academic-years', {
    code: 'Y-CS1',
    name: 'Year CS1',
    start_date: '2026-04-01',
    end_date: '2027-03-31',
  });
  y1 = a.body.data.id;
  await api.post(`/academic-years/${y1}/activate`, { complete_current: true });
  const b = await api.post('/academic-years', {
    code: 'Y-CS2',
    name: 'Year CS2',
    start_date: '2027-04-01',
    end_date: '2028-03-31',
  });
  y2 = b.body.data.id;
  await api.post(`/academic-years/${y2}/open`, {});
  c7 = (await api.post('/academic-classes', { code: 'G7CS', name: 'Grade 7', sequence: 7 })).body
    .data.id;
  c8 = (await api.post('/academic-classes', { code: 'G8CS', name: 'Grade 8', sequence: 8 })).body
    .data.id;
  const sec = async (year: string, cls: string, code: string, capacity?: number) =>
    (
      await api.post(`/academic-years/${year}/sections`, {
        class_id: cls,
        code,
        name: `Section ${code}`,
        capacity,
        room: `R-${code}`,
      })
    ).body.data.id as string;
  secA = await sec(y1, c7, 'A', 2);
  secB = await sec(y1, c7, 'B');
  sec8 = await sec(y2, c8, 'A');
});
afterAll(() => h.close());

const kid = async (section: string) => {
  const r = await api.post('/students', {
    first_name: 'Cls',
    last_name: uniq('K'),
    enrollment: { academic_year_id: y1, class_id: c7, section_id: section },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
};

describe('class fields', () => {
  it('stores phase, language and the promotion order, and refuses loops', async () => {
    const cls = (await api.get(`/academic-classes/${c7}`)).body.data;
    const set = await api.patch(`/academic-classes/${c7}`, {
      version: cls.version,
      phase: 'SECONDARY',
      language_of_instruction: 'English',
      promotes_to_class_id: c8,
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data).toMatchObject({ phase: 'SECONDARY', promotes_to_class_id: c8 });
    const c8row = (await api.get(`/academic-classes/${c8}`)).body.data;
    const loop = await api.patch(`/academic-classes/${c8}`, {
      version: c8row.version,
      promotes_to_class_id: c7,
    });
    expect(loop.status).toBe(422);
    const self = await api.patch(`/academic-classes/${c8}`, {
      version: c8row.version,
      promotes_to_class_id: c8,
    });
    expect(self.status).toBe(422);
  });

  it('shows the room on sections', async () => {
    const s = await api.get(`/sections/${secA}`);
    expect(s.body.data.room).toBe('R-A');
  });
});

describe('overview', () => {
  it('lists classes with seats and flags sections without a class teacher', async () => {
    await kid(secA);
    const r = await api.get('/academic-classes/overview');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const g7 = r.body.data.classes.find((c: { id: string }) => c.id === c7);
    expect(g7.enrolled).toBe(1);
    expect(g7.sections).toHaveLength(2);
    expect(r.body.data.attention.some((a: { type: string }) => a.type === 'NO_CLASS_TEACHER')).toBe(
      true,
    );
    expect(r.body.data.totals.sections).toBeGreaterThanOrEqual(2);
  });
});

describe('bulk move and promote', () => {
  it('moves a group to another section', async () => {
    const x = await kid(secB);
    const y = await kid(secB);
    const res = await api.post('/enrollments/bulk-move', {
      student_ids: [x, y],
      to_section_id: secA,
      reason: 'Rebalancing',
    });
    // Section A has 1 free seat only, so the group cannot fit and nothing moves.
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/full/i);
    const one = await api.post('/enrollments/bulk-move', {
      student_ids: [x],
      to_section_id: secA,
      reason: 'Rebalancing',
    });
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.data.moved).toBe(1);
  });

  it('promotes students into the next year', async () => {
    const x = await kid(secB);
    const res = await api.post('/enrollments/bulk-promote', {
      student_ids: [x],
      to_academic_year_id: y2,
      to_class_id: c8,
      to_section_id: sec8,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.promoted).toBe(1);
    const enr = await api.get(`/students/${x}/enrollments`);
    const types = enr.body.data.map((e: { enrollment_type: string }) => e.enrollment_type);
    expect(types).toContain('PROMOTION');
    const again = await api.post('/enrollments/bulk-promote', {
      student_ids: [x],
      to_academic_year_id: y2,
      to_class_id: c8,
    });
    expect(again.status).toBe(422);
  });
});
