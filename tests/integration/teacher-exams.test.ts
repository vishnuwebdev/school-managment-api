import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

/**
 * Teacher app exams and marks (26 Oct 2026): marks only for the sections and subjects
 * the teacher teaches; draft → hand in → office can return; own tests; and the office's
 * notifications to teachers.
 */
let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;
let yearId: string;
let classId: string;
let secA: string;
let secB: string;
let maths: string;
let english: string;
let teacher: { id: string; api: Api };
let inA: string;
let inB: string;

const sub = async (name: string) =>
  (await api.post('/subjects', { code: uniq('S').toUpperCase(), name, subject_type: 'CORE' })).body
    .data.id as string;

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool({ plan: 'STANDARD' });
  api = A.admin.api;
  yearId = (
    await api.post('/academic-years', {
      code: `Y-${uniq('y')}`,
      name: 'Year',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
    })
  ).body.data.id;
  await api.post(`/academic-years/${yearId}/activate`, { complete_current: true });
  classId = (await api.post('/academic-classes', { code: uniq('G'), name: 'Grade 8', sequence: 8 }))
    .body.data.id;
  const sec = async (c: string) =>
    (
      await api.post(`/academic-years/${yearId}/sections`, {
        class_id: classId,
        code: c,
        name: `Section ${c}`,
      })
    ).body.data.id as string;
  secA = await sec('A');
  secB = await sec('B');
  maths = await sub('Mathematics');
  english = await sub('English');
  for (const s of [maths, english])
    await api.post('/subject-offerings', {
      academic_year_id: yearId,
      subject_id: s,
      class_id: classId,
    });
  const mathsA = await api.post('/subject-offerings', {
    academic_year_id: yearId,
    subject_id: maths,
    class_id: classId,
    section_id: secA,
  });
  expect(mathsA.status, JSON.stringify(mathsA.body)).toBe(201);

  const student = async (section: string) => {
    const res = await api.post('/students', {
      first_name: 'Kid',
      last_name: uniq('Fam'),
      gender: 'FEMALE',
      enrollment: {
        academic_year_id: yearId,
        class_id: classId,
        section_id: section,
        start_date: '2026-01-02',
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data.id as string;
  };
  inA = await student(secA);
  inB = await student(secB);

  // A teacher of Mathematics in section A only.
  const t = await api.post('/teachers', {
    first_name: 'Naledi',
    last_name: uniq('Fam'),
    email: `${uniq('t')}@school.test`,
  });
  const asg = await api.post(`/teachers/${t.body.data.id}/assignments`, {
    subject_offering_id: mathsA.body.data.id,
  });
  expect(asg.status, JSON.stringify(asg.body)).toBe(201);
  const inv = await api.post(`/teachers/${t.body.data.id}/portal-access`, {
    role_id: await h.roleId(api, 'TEACHER'),
  });
  expect(inv.status, JSON.stringify(inv.body)).toBe(201);
  const session = await h.acceptAndLogin(t.body.data.email);
  teacher = { id: t.body.data.id, api: session.api };
  const grant = await A.root.put(
    `/platform/tenants/${A.tenantId}/entitlements/overrides/teachers.mobile_app`,
    { effect: 'GRANT', reason: 'Teacher app add-on' },
  );
  expect(grant.status, JSON.stringify(grant.body)).toBe(200);
  await h.flushTenantCache(A.tenantId);
});
afterAll(() => h.close());

describe('teacher app: exams and marks', () => {
  let examId: string;
  let mathsPaper: string;
  let englishPaper: string;

  it('lists only the papers and sections I teach', async () => {
    const exam = await api.post('/exams', { name: uniq('Term test'), class_ids: [classId] });
    expect(exam.status, JSON.stringify(exam.body)).toBe(201);
    examId = exam.body.data.id;
    let papers = (await api.get(`/exams/${examId}/papers`)).body.data as {
      id: string;
      subject_id: string;
    }[];
    if (!papers.some((p) => p.subject_id === maths))
      await api.post(`/exams/${examId}/papers`, { class_id: classId, subject_id: maths });
    if (!papers.some((p) => p.subject_id === english))
      await api.post(`/exams/${examId}/papers`, { class_id: classId, subject_id: english });
    papers = (await api.get(`/exams/${examId}/papers`)).body.data;
    mathsPaper = papers.find((p) => p.subject_id === maths)!.id;
    englishPaper = papers.find((p) => p.subject_id === english)!.id;

    const list = await teacher.api.get('/teacher/exams');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const e = list.body.data.find((x: { id: string }) => x.id === examId);
    expect(e.papers.map((p: { paper_id: string }) => p.paper_id)).toEqual([mathsPaper]);
    expect(e.papers[0].sections.map((s: { section_id: string }) => s.section_id)).toEqual([secA]);
  });

  it('shows and saves marks for my section only', async () => {
    const m = await teacher.api.get(`/teacher/papers/${mathsPaper}/marks`);
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body.data.rows.map((r: { student_id: string }) => r.student_id)).toEqual([inA]);
    expect((await teacher.api.get(`/teacher/papers/${englishPaper}/marks`)).status).toBe(403);
    const other = await teacher.api.put(`/teacher/papers/${mathsPaper}/marks`, {
      records: [{ student_id: inB, marks: 40 }],
    });
    expect(other.status).toBe(422);
  });

  it('hands in a complete section, locks it, and the office can return it', async () => {
    const early = await teacher.api.post(`/teacher/papers/${mathsPaper}/submit`, {
      section_id: secA,
    });
    expect(code(early)).toBe('OPERATION_NOT_ALLOWED');
    const saved = await teacher.api.put(`/teacher/papers/${mathsPaper}/marks`, {
      records: [{ student_id: inA, marks: 70 }],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.sections[0].can_submit).toBe(true);
    const sub = await teacher.api.post(`/teacher/papers/${mathsPaper}/submit`, {
      section_id: secA,
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.data.sections[0].status).toBe('SUBMITTED');
    const locked = await teacher.api.put(`/teacher/papers/${mathsPaper}/marks`, {
      records: [{ student_id: inA, marks: 71 }],
    });
    expect(code(locked)).toBe('INVALID_STATE');

    const office = await api.get(`/exams/papers/${mathsPaper}/marks`);
    const a = office.body.data.sections.find((s: { section_id: string }) => s.section_id === secA);
    expect(a.status).toBe('SUBMITTED');
    const back = await api.post(`/exams/papers/${mathsPaper}/sections/${secA}/return`, {
      note: 'Check the total',
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const again = await teacher.api.put(`/teacher/papers/${mathsPaper}/marks`, {
      records: [{ student_id: inA, marks: 72 }],
    });
    expect(again.status).toBe(200);
    expect(again.body.data.sections[0].return_note).toBe('Check the total');
  });

  it('sets my own test for my section and subject, and deletes it until handed in', async () => {
    const refused = await teacher.api.post('/teacher/tests', {
      name: 'Spelling',
      section_id: secA,
      subject_id: english,
    });
    expect(code(refused)).toBe('PERMISSION_DENIED');
    const t = await teacher.api.post('/teacher/tests', {
      name: 'Fractions quiz',
      section_id: secA,
      subject_id: maths,
      max_marks: 20,
      pass_marks: 8,
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const office = (await api.get('/exams')).body.data.find(
      (e: { id: string }) => e.id === t.body.data.exam_id,
    );
    expect(office.by_teacher).toBe(true);
    const m = await teacher.api.get(`/teacher/papers/${t.body.data.paper_id}/marks`);
    expect(m.body.data.rows.map((r: { student_id: string }) => r.student_id)).toEqual([inA]);
    expect((await teacher.api.delete(`/teacher/tests/${t.body.data.exam_id}`)).status).toBe(204);

    const t2 = await teacher.api.post('/teacher/tests', {
      name: 'Decimals quiz',
      section_id: secA,
      subject_id: maths,
    });
    await teacher.api.put(`/teacher/papers/${t2.body.data.paper_id}/marks`, {
      records: [{ student_id: inA, absent: true }],
    });
    await teacher.api.post(`/teacher/papers/${t2.body.data.paper_id}/submit`, { section_id: secA });
    expect(code(await teacher.api.delete(`/teacher/tests/${t2.body.data.exam_id}`))).toBe(
      'INVALID_STATE',
    );
    expect((await teacher.api.delete(`/teacher/tests/${examId}`)).status).toBe(404);
  });
});

describe('teacher notifications', () => {
  it('the office sends now or later; the teacher sees what is due and marks it read', async () => {
    const now = await api.post('/teacher-notifications', {
      title: 'Staff meeting',
      body: 'Today 14:00',
    });
    expect(now.status, JSON.stringify(now.body)).toBe(201);
    expect(now.body.data.state).toBe('SENT');
    const later = await api.post('/teacher-notifications', {
      title: 'Sports day',
      body: 'Next week',
      send_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(later.body.data.state).toBe('SCHEDULED');

    const mine = await teacher.api.get('/teacher/notifications');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const ids = mine.body.data.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(now.body.data.id);
    expect(ids).not.toContain(later.body.data.id);
    expect(mine.body.data.unread).toBeGreaterThan(0);
    const read = await teacher.api.post('/teacher/notifications/read', { all: true });
    expect(read.body.data.unread).toBe(0);

    expect((await api.post(`/teacher-notifications/${now.body.data.id}/cancel`)).status).toBe(204);
    const after = await teacher.api.get('/teacher/notifications');
    expect(after.body.data.items.map((i: { id: string }) => i.id)).not.toContain(now.body.data.id);
  });
});
