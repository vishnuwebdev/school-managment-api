import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

// Printed report cards for the school office (gap M13): one student, or a whole section.

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

async function pdfPages(res: { status: number; headers: Json; body: unknown }) {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.headers['content-type']).toBe('application/pdf');
  expect(res.headers['content-disposition']).toMatch(/^inline; filename=".+\.pdf"$/);
  const buf = Buffer.from(res.body as Buffer);
  expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  return (await PDFDocument.load(buf)).getPageCount();
}

let classId: string;
let secA: string;
let secB: string;
let kidsA: string[];
let kidB: string;
let examId: string;
let draftId: string;

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  B = await h.provisionSchool();
  api = A.admin.api;
  const yearId = (
    await ok(
      await api.post('/academic-years', {
        code: 'RC',
        name: 'Report year',
        start_date: daysAgo(100),
        end_date: inDays(200),
      }),
      201,
    )
  ).id;
  await ok(await api.post(`/academic-years/${yearId}/activate`, { complete_current: true }));
  classId = (
    await ok(await api.post('/academic-classes', { code: 'C7', name: 'Class 7', sequence: 7 }), 201)
  ).id;
  const sec = async (c: string) =>
    (
      await ok(
        await api.post(`/academic-years/${yearId}/sections`, {
          class_id: classId,
          code: c,
          name: c,
        }),
        201,
      )
    ).id as string;
  secA = await sec('A');
  secB = await sec('B');
  const subject = (
    await ok(await api.post('/subjects', { code: uniq('S').toUpperCase(), name: 'Maths' }), 201)
  ).id;
  await ok(
    await api.post('/subject-offerings', {
      academic_year_id: yearId,
      subject_id: subject,
      class_id: classId,
    }),
    201,
  );
  const student = async (name: string, section: string) =>
    (
      await ok(
        await api.post('/students', {
          first_name: name,
          last_name: uniq('K'),
          gender: 'FEMALE',
          enrollment: {
            academic_year_id: yearId,
            class_id: classId,
            section_id: section,
            start_date: daysAgo(30),
          },
        }),
        201,
      )
    ).id as string;
  kidsA = [await student('Asha', secA), await student('Bina', secA), await student('Charu', secA)];
  kidB = await student('Divya', secB);

  examId = (
    await ok(
      await api.post('/exams', {
        name: 'Half Yearly',
        class_ids: [classId],
        default_max_marks: 100,
        default_pass_marks: 33,
      }),
      201,
    )
  ).id;
  const [paper] = await ok<Json[]>(await api.get(`/exams/${examId}/papers?class_id=${classId}`));
  await ok(
    await api.put(`/exams/papers/${paper!.id}/marks`, {
      records: [...kidsA, kidB].map((id, i) => ({ student_id: id, marks: 90 - i * 10 })),
    }),
  );
  await ok(await api.post(`/exams/${examId}/publish`, {}));
  draftId = (await ok(await api.post('/exams', { name: 'Unit Test 9', class_ids: [classId] }), 201))
    .id;
}, 120_000);
afterAll(() => h.close());

describe('office report cards', () => {
  it('downloads one student’s report card', async () => {
    const res = await api.get(`/exams/${examId}/report-cards/${kidsA[0]}/pdf`);
    expect(await pdfPages(res)).toBe(1);
    expect(res.headers['content-disposition']).toContain('Report-card-Asha');
  });

  it('downloads a whole section as one PDF, a page per student', async () => {
    const res = await api.get(`/exams/${examId}/report-cards/pdf?section_id=${secA}`);
    expect(await pdfPages(res)).toBe(3);
    expect(res.headers['content-disposition']).toContain('Report-cards-Class-7-A');
    expect(
      await pdfPages(await api.get(`/exams/${examId}/report-cards/pdf?section_id=${secB}`)),
    ).toBe(1);
  });

  it('needs the section', async () => {
    const res = await api.get(`/exams/${examId}/report-cards/pdf`);
    expect(res.status).toBe(422);
    expect(code(res)).toBe('VALIDATION_ERROR');
  });

  it('refuses an exam whose results are not published, in plain words', async () => {
    const res = await api.get(`/exams/${draftId}/report-cards/${kidsA[0]}/pdf`);
    expect(res.status).toBe(422);
    expect(code(res)).toBe('INVALID_STATE');
    expect(res.body.error.message).toMatch(/after the results are published/);
    expect((await api.get(`/exams/${draftId}/report-cards/pdf?section_id=${secA}`)).status).toBe(
      422,
    );
  });

  it('is refused without the exams permission', async () => {
    const rec = await h.addMember(api, [{ role_id: await h.roleId(api, 'RECEPTIONIST') }]);
    expect((await rec.api.get(`/exams/${examId}/report-cards/${kidsA[0]}/pdf`)).status).toBe(403);
    expect((await rec.api.get(`/exams/${examId}/report-cards/pdf?section_id=${secA}`)).status).toBe(
      403,
    );
  });

  it('a teacher limited to one section only prints that section', async () => {
    const t = await h.addMember(api, [
      {
        role_id: await h.roleId(api, 'TEACHER'),
        scope_type: 'ASSIGNED_SECTION',
        scope_ref: { section_ids: [secA] },
      },
    ]);
    expect(await pdfPages(await t.api.get(`/exams/${examId}/report-cards/${kidsA[1]}/pdf`))).toBe(
      1,
    );
    expect((await t.api.get(`/exams/${examId}/report-cards/${kidB}/pdf`)).status).toBe(404);
    expect((await t.api.get(`/exams/${examId}/report-cards/pdf?section_id=${secB}`)).status).toBe(
      404,
    );
  });

  it("another school's exam, student or section looks missing", async () => {
    const other = B.admin.api;
    expect((await other.get(`/exams/${examId}/report-cards/${kidsA[0]}/pdf`)).status).toBe(404);
    expect((await other.get(`/exams/${examId}/report-cards/pdf?section_id=${secA}`)).status).toBe(
      404,
    );
    // A student id this school doesn't have is a 404 too.
    const stranger = '0192f4f0-0000-7000-8000-000000000000';
    expect((await api.get(`/exams/${examId}/report-cards/${stranger}/pdf`)).status).toBe(404);
  });
});
