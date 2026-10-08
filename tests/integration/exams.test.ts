import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let B: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

async function ok<T = Json>(res: { status: number; body: Json }, status = 200) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
}

let yearId: string;
let classId: string;
let class2Id: string;
let kids: string[];
let secAId: string;

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  B = await h.provisionSchool();
  api = A.admin.api;
  yearId = (
    await ok(
      await api.post('/academic-years', {
        code: 'EX',
        name: 'Exam year',
        start_date: daysAgo(100),
        end_date: inDays(200),
      }),
      201,
    )
  ).id;
  await ok(await api.post(`/academic-years/${yearId}/activate`, { complete_current: true }));
  const cls = async (n: string, s: number) =>
    (
      await ok(
        await api.post('/academic-classes', { code: n.replace(/ /g, ''), name: n, sequence: s }),
        201,
      )
    ).id;
  classId = await cls('Class 5', 5);
  class2Id = await cls('Class 6', 6);
  const sec = async (c: string, code: string) =>
    (
      await ok(
        await api.post(`/academic-years/${yearId}/sections`, {
          class_id: c,
          code,
          name: `Section ${code}`,
        }),
        201,
      )
    ).id;
  const secA = await sec(classId, 'A');
  secAId = secA;
  const subject = async (name: string) =>
    (await ok(await api.post('/subjects', { code: uniq('S').toUpperCase(), name }), 201)).id;
  const offer = async (s: string, c: string) =>
    ok(
      await api.post('/subject-offerings', {
        academic_year_id: yearId,
        subject_id: s,
        class_id: c,
      }),
      201,
    );
  const maths = await subject('Mathematics');
  const sci = await subject('Science');
  await offer(maths, classId);
  await offer(sci, classId);
  await offer(maths, class2Id);
  const secB = await sec(class2Id, 'A');
  await ok(
    await api.post('/students', {
      first_name: 'Dev',
      last_name: uniq('F'),
      gender: 'MALE',
      enrollment: {
        academic_year_id: yearId,
        class_id: class2Id,
        section_id: secB,
        start_date: daysAgo(30),
      },
    }),
    201,
  );
  kids = [];
  for (const n of ['Asha', 'Ben', 'Chitra']) {
    const s = await ok(
      await api.post('/students', {
        first_name: n,
        last_name: uniq('F'),
        gender: 'FEMALE',
        enrollment: {
          academic_year_id: yearId,
          class_id: classId,
          section_id: secA,
          start_date: daysAgo(30),
        },
      }),
      201,
    );
    kids.push(s.id);
  }
}, 120_000);
afterAll(() => h.close());

describe('exam lifecycle', () => {
  let exam: Json;
  let papers: Json[];

  it('creates an exam with a paper per subject of each class', async () => {
    exam = await ok(
      await api.post('/exams', {
        name: 'Unit Test 1',
        exam_type: 'UNIT_TEST',
        start_date: inDays(1),
        end_date: inDays(5),
        class_ids: [classId, class2Id],
        default_max_marks: 50,
        default_pass_marks: 20,
      }),
      201,
    );
    expect(exam).toMatchObject({ status: 'DRAFT', stage: 'MARKING', classes: 2, papers: 3 });
    expect(exam.marks_expected).toBe(7); // 3 students × 2 papers in class 5, plus 1 in class 6
    papers = await ok(await api.get(`/exams/${exam.id}/papers?class_id=${classId}`));
    expect(papers).toHaveLength(2);
    expect(papers[0]).toMatchObject({ max_marks: 50, pass_marks: 20, students: 3 });
    const dup = await api.post('/exams', { name: 'Unit Test 1', class_ids: [classId] });
    expect(code(dup)).toBe('DUPLICATE_RESOURCE');
  });

  it('sets a date and refuses pass marks above the maximum', async () => {
    const p = await ok(await api.patch(`/exams/papers/${papers[0]!.id}`, { exam_date: inDays(2) }));
    expect(p.exam_date).toBe(inDays(2));
    expect((await api.patch(`/exams/papers/${papers[0]!.id}`, { pass_marks: 80 })).status).toBe(
      422,
    );
  });

  it('saves marks, rejects too-high marks and strangers, and counts progress', async () => {
    const pid = papers[0]!.id as string;
    const sheet = await ok(await api.get(`/exams/papers/${pid}/marks`));
    expect(sheet.rows).toHaveLength(3);
    const bad = await api.put(`/exams/papers/${pid}/marks`, {
      records: [{ student_id: kids[0], marks: 51 }],
    });
    expect(bad.status).toBe(422);
    const stranger = await api.put(`/exams/papers/${pid}/marks`, {
      records: [{ student_id: '0192f4f0-0000-7000-8000-000000000000', marks: 10 }],
    });
    expect(stranger.status).toBe(422);
    const saved = await ok(
      await api.put(`/exams/papers/${pid}/marks`, {
        records: [
          { student_id: kids[0], marks: 48 },
          { student_id: kids[1], marks: 12.5 },
          { student_id: kids[2], absent: true },
        ],
      }),
    );
    expect(saved.rows.map((r: Json) => r.marks)).toEqual([48, 12.5, null]);
    expect(saved.rows[2].absent).toBe(true);
    const list = await ok(await api.get(`/exams/${exam.id}/papers?class_id=${classId}`));
    expect(list.find((p: Json) => p.id === pid).marks_entered).toBe(3);
  });

  it('calculates results, ranks and subject analysis from the marks', async () => {
    const p2 = papers[1]!.id as string;
    await ok(
      await api.put(`/exams/papers/${p2}/marks`, {
        records: [
          { student_id: kids[0], marks: 40 },
          { student_id: kids[1], marks: 30 },
          { student_id: kids[2], marks: 25 },
        ],
      }),
    );
    const r = await ok(await api.get(`/exams/${exam.id}/results?class_id=${classId}`));
    expect(r.summary).toMatchObject({ students: 3, complete: 3, passed: 1, failed: 2 });
    const top = r.rows[0];
    expect(top).toMatchObject({ rank: 1, total: 88, max_total: 100, result: 'PASS' });
    expect(top.percentage).toBe(88);
    expect(top.grade).toBe('A');
    const ben = r.rows.find((x: Json) => x.subjects.some((s: Json) => s.marks === 12.5))!;
    expect(ben.result).toBe('FAIL'); // 12.5 < pass mark 20
    const absent = r.rows.find((x: Json) => x.subjects.some((s: Json) => s.absent))!;
    expect(absent.result).toBe('FAIL');
    expect(r.subjects).toHaveLength(2);
  });

  it('refuses to publish while marks are missing unless confirmed', async () => {
    const ready = await ok(await api.get(`/exams/${exam.id}/readiness`));
    expect(ready.ready).toBe(false); // Dev in class 6 has no marks
    const refused = await api.post(`/exams/${exam.id}/publish`, {});
    expect(refused.status).toBe(409);
    expect(code(refused)).toBe('CONFIRMATION_REQUIRED');
    const done = await ok(await api.post(`/exams/${exam.id}/publish`, { allow_incomplete: true }));
    expect(done).toMatchObject({ status: 'PUBLISHED', stage: 'PUBLISHED' });
  });

  it('locks marks once published, shows the student their result, and reopens', async () => {
    const locked = await api.put(`/exams/papers/${papers[0]!.id}/marks`, {
      records: [{ student_id: kids[0], marks: 10 }],
    });
    expect(locked.status).toBe(422);
    expect((await api.delete(`/exams/${exam.id}`)).status).toBe(422);
    const mine = await ok<Json[]>(await api.get(`/students/${kids[0]}/exams`));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ exam_name: 'Unit Test 1', total: 88, rank: 1, result: 'PASS' });
    const reopened = await ok(await api.post(`/exams/${exam.id}/unpublish`));
    expect(reopened.status).toBe('DRAFT');
    await ok(
      await api.put(`/exams/papers/${papers[0]!.id}/marks`, {
        records: [{ student_id: kids[0], marks: 10 }],
      }),
    );
  });

  it('adds and removes a class, then deletes the exam', async () => {
    await ok(await api.delete(`/exams/${exam.id}/classes/${class2Id}`), 204);
    const e = await ok(await api.get(`/exams/${exam.id}`));
    expect(e.class_progress).toHaveLength(1);
    await ok(await api.delete(`/exams/${exam.id}`), 204);
    expect((await api.get(`/exams/${exam.id}`)).status).toBe(404);
  });
});

describe('isolation', () => {
  it("another school cannot see or touch this school's exams", async () => {
    const e = await ok(await api.post('/exams', { name: 'Private', class_ids: [classId] }), 201);
    const other = B.admin.api;
    expect((await other.get(`/exams/${e.id}`)).status).toBe(404);
    expect(await ok(await other.get('/exams'))).toEqual([]);
  });
});

describe('scope narrowing', () => {
  it('a teacher limited to one section only sees and marks that section', async () => {
    // a second section of class 5 with its own student
    const secB = (
      await ok(
        await api.post(`/academic-years/${yearId}/sections`, {
          class_id: classId,
          code: 'B',
          name: 'Section B',
        }),
        201,
      )
    ).id;
    const other = await ok(
      await api.post('/students', {
        first_name: 'Zed',
        last_name: uniq('F'),
        gender: 'MALE',
        enrollment: {
          academic_year_id: yearId,
          class_id: classId,
          section_id: secB,
          start_date: daysAgo(30),
        },
      }),
      201,
    );
    const e = await ok(
      await api.post('/exams', { name: 'Scoped test', class_ids: [classId, class2Id] }),
      201,
    );
    const teacher = await h.addMember(api, [
      {
        role_id: await h.roleId(api, 'TEACHER'),
        scope_type: 'ASSIGNED_SECTION',
        scope_ref: { section_ids: [secAId] },
      },
    ]);
    const t = teacher.api;
    const papers = await ok<Json[]>(await t.get(`/exams/${e.id}/papers`));
    expect(papers.every((p) => p.class_id === classId)).toBe(true); // class 6 is invisible
    expect(papers[0]!.students).toBe(3); // section A only, not Zed
    const pid = papers[0]!.id as string;
    const sheet = await ok(await t.get(`/exams/papers/${pid}/marks`));
    expect(sheet.rows).toHaveLength(3);
    expect(sheet.rows.some((r: Json) => r.student_id === other.id)).toBe(false);
    const foreign = await t.put(`/exams/papers/${pid}/marks`, {
      records: [{ student_id: other.id, marks: 50 }],
    });
    expect(foreign.status).toBe(422);
    await ok(
      await t.put(`/exams/papers/${pid}/marks`, { records: [{ student_id: kids[0], marks: 55 }] }),
    );
    // the admin sees the whole class, the teacher's mark included
    const adminSheet = await ok(await api.get(`/exams/papers/${pid}/marks`));
    expect(adminSheet.rows).toHaveLength(4);
    expect(adminSheet.rows.find((r: Json) => r.student_id === kids[0]).marks).toBe(55);
    const res = await ok(await t.get(`/exams/${e.id}/results?class_id=${classId}`));
    expect(res.rows).toHaveLength(3);
    expect((await t.get(`/exams/${e.id}/results?class_id=${class2Id}`)).status).toBe(404);
    const class6Paper = (
      await ok<Json[]>(await api.get(`/exams/${e.id}/papers?class_id=${class2Id}`))
    )[0]!;
    expect((await t.get(`/exams/papers/${class6Paper.id}/marks`)).status).toBe(404);
    expect((await t.get(`/students/${other.id}/exams`)).status).toBe(404);
  });
});
