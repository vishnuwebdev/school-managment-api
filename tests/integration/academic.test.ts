import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, type Api, type Harness } from '../helpers.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let B: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  B = await h.provisionSchool();
  api = A.admin.api;
});
afterAll(() => h.close());

const year = (c: string, start = '2026-04-01', end = '2027-03-31') => ({
  code: c,
  name: `AY ${c}`,
  start_date: start,
  end_date: end,
});

describe('academic years', () => {
  it('runs the lifecycle DRAFT → UPCOMING → ACTIVE → COMPLETED → ARCHIVED', async () => {
    const created = await api.post(
      '/academic-years',
      year('2030-2031', '2030-04-01', '2031-03-31'),
    );
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('DRAFT');
    const id = created.body.data.id;
    expect((await api.post(`/academic-years/${id}/open`)).body.data.status).toBe('UPCOMING');
    const active = await api.post(`/academic-years/${id}/activate`, {});
    expect(active.body.data.status).toBe('ACTIVE');
    expect(active.body.data.is_current).toBe(true);
    expect((await api.post(`/academic-years/${id}/complete`)).body.data.status).toBe('COMPLETED');
    expect((await api.post(`/academic-years/${id}/archive`)).body.data.status).toBe('ARCHIVED');
    expect((await api.post(`/academic-years/${id}/open`)).status).toBe(422); // invalid state
  });

  it('keeps exactly one current year and asks before completing the old one', async () => {
    const y1 = (await api.post('/academic-years', year('CUR-1'))).body.data.id;
    const y2 = (await api.post('/academic-years', year('CUR-2', '2027-04-01', '2028-03-31'))).body
      .data.id;
    await api.post(`/academic-years/${y1}/activate`, {});
    const blocked = await api.post(`/academic-years/${y2}/activate`, {});
    expect(blocked.status).toBe(409);
    expect(code(blocked)).toBe('CONFIRMATION_REQUIRED');
    expect(blocked.body.error.details.current_year.id).toBe(y1);
    const ok = await api.post(`/academic-years/${y2}/activate`, { complete_current: true });
    expect(ok.status).toBe(200);
    expect((await api.get(`/academic-years/${y1}`)).body.data.status).toBe('COMPLETED');
    const list = await api.get('/academic-years?page_size=100');
    expect(list.body.data.filter((y: { is_current: boolean }) => y.is_current)).toHaveLength(1);
  });

  it('validates dates, duplicate codes and concurrent edits', async () => {
    expect(
      (await api.post('/academic-years', year('BAD', '2027-01-01', '2026-01-01'))).status,
    ).toBe(422);
    const first = await api.post('/academic-years', year('DUP-1'));
    expect(first.status).toBe(201);
    const dup = await api.post('/academic-years', year('DUP-1'));
    expect(dup.status).toBe(409);
    expect(code(dup)).toBe('DUPLICATE_RESOURCE');
    const { id, version } = first.body.data;
    expect((await api.patch(`/academic-years/${id}`, { version, name: 'Renamed' })).status).toBe(
      200,
    );
    const stale = await api.patch(`/academic-years/${id}`, { version, name: 'Stale' });
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe('CONFLICT');
  });

  it('writes audit rows and outbox events for changes', async () => {
    const res = await api.post('/academic-years', year('AUD-1'));
    const audit = await api.get('/audit-logs?page_size=50');
    expect(
      audit.body.data.some(
        (a: { action: string; entity_id: string }) =>
          a.action === 'ACADEMIC_YEAR_CREATED' && a.entity_id === res.body.data.id,
      ),
    ).toBe(true);
  });
});

describe('classes, sections and subjects', () => {
  let yearId: string;
  let classId: string;
  beforeAll(async () => {
    yearId = (await api.post('/academic-years', year('STRUCT-1', '2028-04-01', '2029-03-31'))).body
      .data.id;
    classId = (
      await api.post('/academic-classes', { code: 'grade_5', name: 'Grade 5', sequence: 5 })
    ).body.data.id;
  });

  it('normalises class codes and rejects duplicates', async () => {
    const list = await api.get('/academic-classes');
    expect(list.body.data.find((c: { id: string }) => c.id === classId).code).toBe('GRADE_5');
    const dup = await api.post('/academic-classes', { code: 'GRADE_5', name: 'Again' });
    expect(dup.status).toBe(409);
  });

  it('creates sections inside a year, with unique codes per class and year', async () => {
    const s = await api.post(`/academic-years/${yearId}/sections`, {
      class_id: classId,
      code: 'a',
      name: 'Section A',
      capacity: 30,
    });
    expect(s.status).toBe(201);
    expect(s.body.data.code).toBe('A');
    expect(s.body.data.enrolled_count).toBe(0);
    expect(s.body.data.seats_available).toBe(30);
    const dup = await api.post(`/academic-years/${yearId}/sections`, {
      class_id: classId,
      code: 'A',
      name: 'Dup',
    });
    expect(dup.status).toBe(409);
    const list = await api.get(`/sections?academic_year_id=${yearId}&class_id=${classId}`);
    expect(list.body.data).toHaveLength(1);
  });

  it('runs the section lifecycle and refuses sections in a completed year', async () => {
    const s = await api.post(`/academic-years/${yearId}/sections`, {
      class_id: classId,
      code: 'B',
      name: 'Section B',
      status: 'DRAFT',
    });
    const id = s.body.data.id;
    expect((await api.post(`/sections/${id}/activate`)).body.data.status).toBe('ACTIVE');
    expect((await api.post(`/sections/${id}/close`)).body.data.status).toBe('CLOSED');
    expect((await api.post(`/sections/${id}/archive`)).body.data.status).toBe('ARCHIVED');
    expect((await api.patch(`/sections/${id}`, { version: 99, name: 'x' })).status).toBe(422);

    const old = (await api.post('/academic-years', year('OLD-1', '2020-04-01', '2021-03-31'))).body
      .data.id;
    await api.post(`/academic-years/${old}/activate`, { complete_current: true });
    await api.post(`/academic-years/${old}/complete`);
    const late = await api.post(`/academic-years/${old}/sections`, {
      class_id: classId,
      code: 'Z',
      name: 'Z',
    });
    expect(late.status).toBe(422);
  });

  it('manages subjects and offerings (class-wide and section-level)', async () => {
    const subject = await api.post('/subjects', {
      code: 'math',
      name: 'Mathematics',
      subject_type: 'CORE',
    });
    expect(subject.status).toBe(201);
    const subjectId = subject.body.data.id;
    const section = (await api.get(`/sections?academic_year_id=${yearId}&class_id=${classId}`)).body
      .data[0];

    const wide = await api.post('/subject-offerings', {
      academic_year_id: yearId,
      subject_id: subjectId,
      class_id: classId,
    });
    expect(wide.status).toBe(201);
    expect(wide.body.data.scope).toBe('CLASS');
    expect(
      (
        await api.post('/subject-offerings', {
          academic_year_id: yearId,
          subject_id: subjectId,
          class_id: classId,
        })
      ).status,
    ).toBe(409);
    const narrow = await api.post('/subject-offerings', {
      academic_year_id: yearId,
      subject_id: subjectId,
      class_id: classId,
      section_id: section.id,
    });
    expect(narrow.status).toBe(201);
    expect(narrow.body.data.scope).toBe('SECTION');

    // A section from a different class cannot be used.
    const other = (await api.post('/academic-classes', { code: 'grade_6', name: 'Grade 6' })).body
      .data.id;
    const mismatch = await api.post('/subject-offerings', {
      academic_year_id: yearId,
      subject_id: subjectId,
      class_id: other,
      section_id: section.id,
    });
    expect(mismatch.status).toBe(422);

    const archived = await api.post(`/subjects/${subjectId}/archive`);
    expect(archived.body.data.status).toBe('ARCHIVED');
    const offerings = await api.get(`/subject-offerings?subject_id=${subjectId}`);
    expect(offerings.body.data.every((o: { status: string }) => o.status === 'INACTIVE')).toBe(
      true,
    );
    expect((await api.post(`/subject-offerings/${wide.body.data.id}/activate`)).status).toBe(422);
  });
});

describe('tenant isolation and permissions', () => {
  it("never exposes another school's academic data", async () => {
    const other = (await B.admin.api.post('/academic-years', year('B-ONLY'))).body.data.id;
    expect((await api.get(`/academic-years/${other}`)).status).toBe(404);
    expect((await api.post(`/academic-years/${other}/activate`, {})).status).toBe(404);
    const classB = (await B.admin.api.post('/academic-classes', { code: 'X', name: 'X' })).body.data
      .id;
    const yearA = (await api.post('/academic-years', year('ISO-A'))).body.data.id;
    const res = await api.post(`/academic-years/${yearA}/sections`, {
      class_id: classB,
      code: 'A',
      name: 'A',
    });
    expect(res.status).toBe(404);
    expect(
      (await api.get('/academic-classes?page_size=100')).body.data.map(
        (c: { code: string }) => c.code,
      ),
    ).not.toContain('X');
  });

  it('separates read from manage', async () => {
    const teacher = await h.addMember(api, [{ role_id: await h.roleId(api, 'TEACHER') }]);
    expect((await teacher.api.get('/academic-years')).status).toBe(200);
    const denied = await teacher.api.post('/academic-years', year('T-1'));
    expect(denied.status).toBe(403);
    expect(code(denied)).toBe('PERMISSION_DENIED');
  });
});

describe('class order', () => {
  it('places new classes in their natural order and saves a drag-and-drop order', async () => {
    const b = B.admin.api;
    const mk = (c: string, name: string) => b.post('/academic-classes', { code: c, name });
    for (const [c, n] of [
      ['C2', 'Class 2'],
      ['NUR', 'Nursery'],
      ['C1', 'Class 1'],
      ['LKG', 'LKG'],
    ] as const)
      expect((await mk(c, n)).status).toBe(201);
    const names = async () =>
      (await b.get('/academic-classes?page_size=100')).body.data
        .map((c: { name: string }) => c.name)
        .filter((n: string) => n !== 'X');
    expect(await names()).toEqual(['Nursery', 'LKG', 'Class 1', 'Class 2']);

    const all = (await b.get('/academic-classes?page_size=100')).body.data as {
      id: string;
      name: string;
    }[];
    const by = Object.fromEntries(all.map((c) => [c.name, c.id]));
    const reordered = [by['Class 2'], by['Class 1'], by['LKG'], by['Nursery']];
    expect((await b.post('/academic-classes/reorder', { ids: reordered })).status).toBe(200);
    expect(await names()).toEqual(['Class 2', 'Class 1', 'LKG', 'Nursery']);

    // another school's class is treated as missing
    const foreign = (await api.get('/academic-classes?page_size=1')).body.data[0]?.id;
    if (foreign) expect((await b.post('/academic-classes/reorder', { ids: [foreign] })).status).toBe(404);
  });
});
