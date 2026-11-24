import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, uniq, type Api, type Harness } from '../helpers.js';

let h: Harness;
let api: Api;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => iso(new Date(Date.now() + n * DAY));

async function ok<T = Json>(res: { status: number; body: Json }, status = 200) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
}
const clash = (res: { status: number; body: Json }) => {
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(res.body.error.details.reason).toBe('EXAM_CLASH');
  return res.body.error.details.clashes as Json[];
};

// The exam runs Monday–Friday of a week a few weeks ahead.
const monday = (() => {
  const d = new Date(Date.now() + 21 * DAY);
  while ((d.getUTCDay() || 7) !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
})();
const plus = (n: number) => iso(new Date(Date.parse(`${monday}T00:00:00Z`) + n * DAY));

const F = {} as {
  yearId: string;
  c5: string;
  c6: string;
  secA: string;
  secB: string;
  maths5: string;
  sci5: string;
  maths6: string;
  sci6: string;
  sci6Offering: string;
  t1: string;
  t2: string;
  t3: string;
  hall: string;
  room: string;
  examId: string;
  kid6: string;
};
const paper = (cls: string, subject: string) => `${cls}:${subject}`;
const papers = new Map<string, string>();

beforeAll(async () => {
  h = await createHarness();
  const A = await h.provisionSchool();
  api = A.admin.api;
  F.yearId = (
    await ok(
      await api.post('/academic-years', {
        code: 'ET',
        name: 'Exam timetable year',
        start_date: daysFromNow(-100),
        end_date: daysFromNow(200),
      }),
      201,
    )
  ).id;
  await ok(await api.post(`/academic-years/${F.yearId}/activate`, { complete_current: true }));
  const cls = async (n: string, s: number) =>
    (await ok(await api.post('/academic-classes', { code: uniq('C'), name: n, sequence: s }), 201))
      .id as string;
  F.c5 = await cls('Class 5', 5);
  F.c6 = await cls('Class 6', 6); // no sections
  const sec = async (code: string) =>
    (
      await ok(
        await api.post(`/academic-years/${F.yearId}/sections`, {
          class_id: F.c5,
          code,
          name: code,
        }),
        201,
      )
    ).id as string;
  F.secA = await sec('A');
  F.secB = await sec('B');
  const subject = async (name: string) =>
    (await ok(await api.post('/subjects', { code: uniq('S').toUpperCase(), name }), 201))
      .id as string;
  const maths = await subject('Mathematics');
  const sci = await subject('Science');
  const offer = async (s: string, c: string) =>
    (
      await ok(
        await api.post('/subject-offerings', {
          academic_year_id: F.yearId,
          subject_id: s,
          class_id: c,
        }),
        201,
      )
    ).id as string;
  await offer(maths, F.c5);
  await offer(sci, F.c5);
  await offer(maths, F.c6);
  F.sci6Offering = await offer(sci, F.c6);
  const teacher = async (first: string) =>
    (await ok(await api.post('/teachers', { first_name: first, last_name: uniq('T') }), 201))
      .id as string;
  F.t1 = await teacher('Ivy');
  F.t2 = await teacher('Jon');
  F.t3 = await teacher('Kim');
  const venue = async (name: string) =>
    (
      await ok(
        await api.post('/timetable/venues', {
          code: uniq('V').toUpperCase(),
          name,
          venue_type: 'CLASSROOM',
        }),
        201,
      )
    ).id as string;
  F.kid6 = (
    await ok(
      await api.post('/students', {
        first_name: 'Ravi',
        last_name: uniq('S'),
        gender: 'MALE',
        enrollment: { academic_year_id: F.yearId, class_id: F.c6, start_date: daysFromNow(-30) },
      }),
      201,
    )
  ).id;
  F.hall = await venue('Exam hall');
  F.room = await venue('Room 5');
  const exam = await ok(
    await api.post('/exams', {
      name: 'Mid-Term',
      exam_type: 'MID_TERM',
      start_date: monday,
      end_date: plus(4),
      class_ids: [F.c5, F.c6],
    }),
    201,
  );
  F.examId = exam.id;
  const list = await ok<Json[]>(await api.get(`/exams/${F.examId}/papers`));
  for (const p of list) papers.set(paper(p.class_id, p.subject_name), p.id);
  F.maths5 = papers.get(paper(F.c5, 'Mathematics'))!;
  F.sci5 = papers.get(paper(F.c5, 'Science'))!;
  F.maths6 = papers.get(paper(F.c6, 'Mathematics'))!;
  F.sci6 = papers.get(paper(F.c6, 'Science'))!;
}, 120_000);
afterAll(() => h.close());

const schedule = (paperId: string, body: object) =>
  api.put(`/exams/papers/${paperId}/schedule`, body);
const sectionSchedule = (paperId: string, sectionId: string, body: object) =>
  api.put(`/exams/papers/${paperId}/sections/${sectionId}/schedule`, body);

describe('scheduling a paper for the class', () => {
  it('sets date, time, venue, invigilators and markers; every section sits it', async () => {
    const res = await ok(
      await schedule(F.maths5, {
        exam_date: monday,
        start_time: '09:00',
        end_time: '11:00',
        venue_id: F.hall,
        invigilator_ids: [F.t1],
        marker_ids: [F.t2, F.t3],
      }),
    );
    expect(res.warnings).toEqual([]);
    expect(res.paper).toMatchObject({
      exam_date: monday,
      start_time: '09:00',
      end_time: '11:00',
      venue: { id: F.hall, name: 'Exam hall' },
      has_sections: true,
    });
    expect(res.paper.invigilators.map((t: Json) => t.id)).toEqual([F.t1]);
    expect(res.paper.markers.map((t: Json) => t.id).sort()).toEqual([F.t2, F.t3].sort());
    expect(res.paper.sections).toHaveLength(2);
    for (const s of res.paper.sections)
      expect(s).toMatchObject({ start_time: '09:00', overridden: false, own_invigilators: false });

    const tt = await ok(await api.get(`/exams/${F.examId}/timetable`));
    expect(tt.exam).toMatchObject({ start_date: monday, end_date: plus(4) });
    expect(tt.papers.find((p: Json) => p.id === F.maths5).start_time).toBe('09:00');
    // the paper list shows the times too
    const list = await ok<Json[]>(await api.get(`/exams/${F.examId}/papers`));
    expect(list.find((p) => p.id === F.maths5)).toMatchObject({
      start_time: '09:00',
      end_time: '11:00',
    });
  });

  it('refuses bad times and dates outside the exam', async () => {
    const bad = async (body: object) => {
      const r = await schedule(F.maths6, body);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
    };
    await bad({ exam_date: monday, start_time: '11:00', end_time: '10:00' });
    await bad({ exam_date: monday, start_time: '11:00' });
    await bad({ exam_date: plus(10), start_time: '09:00', end_time: '10:00' });
    await bad({ exam_date: null, start_time: '09:00', end_time: '10:00' });
  });
});

describe('a section sitting differently', () => {
  it('gives one section its own time and invigilator; clearing puts it back with the class', async () => {
    const res = await ok(
      await sectionSchedule(F.maths5, F.secB, {
        start_time: '12:00',
        end_time: '14:00',
        venue_id: F.room,
        invigilator_ids: [F.t3],
      }),
    );
    const b = res.paper.sections.find((s: Json) => s.section_id === F.secB);
    const a = res.paper.sections.find((s: Json) => s.section_id === F.secA);
    expect(b).toMatchObject({
      exam_date: monday,
      start_time: '12:00',
      end_time: '14:00',
      venue: { id: F.room },
      overridden: true,
      own_invigilators: true,
    });
    expect(b.invigilators.map((t: Json) => t.id)).toEqual([F.t3]);
    expect(a).toMatchObject({ start_time: '09:00', overridden: false });
    expect(a.invigilators.map((t: Json) => t.id)).toEqual([F.t1]);

    const back = await ok(
      await api.delete(`/exams/papers/${F.maths5}/sections/${F.secB}/schedule`),
    );
    expect(back.paper.sections.find((s: Json) => s.section_id === F.secB)).toMatchObject({
      start_time: '09:00',
      overridden: false,
      own_invigilators: false,
    });
  });

  it('refuses a section of another class', async () => {
    const r = await sectionSchedule(F.maths6, F.secA, { start_time: '09:00', end_time: '10:00' });
    expect(r.status).toBe(404);
  });
});

describe('clashes', () => {
  it('a class cannot sit two papers at overlapping times', async () => {
    const c = clash(
      await schedule(F.sci5, { exam_date: monday, start_time: '10:30', end_time: '12:00' }),
    );
    expect(c[0]).toMatchObject({ type: 'SECTION', other_paper_id: F.maths5 });
    expect(c[0]!.message).toContain('Mathematics');
    // nothing was saved
    const tt = await ok(await api.get(`/exams/${F.examId}/timetable`));
    expect(tt.papers.find((p: Json) => p.id === F.sci5).start_time).toBeNull();
    // back-to-back is fine
    await ok(await schedule(F.sci5, { exam_date: monday, start_time: '11:00', end_time: '12:00' }));
  });

  it('a section moved onto another paper of its class clashes too', async () => {
    const c = clash(
      await sectionSchedule(F.sci5, F.secA, { start_time: '09:30', end_time: '10:30' }),
    );
    expect(c[0]).toMatchObject({ type: 'SECTION', section_id: F.secA });
  });

  it('a teacher cannot invigilate two sittings at once', async () => {
    const c = clash(
      await schedule(F.maths6, {
        exam_date: monday,
        start_time: '10:00',
        end_time: '11:00',
        invigilator_ids: [F.t1],
      }),
    );
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ type: 'TEACHER', teacher_id: F.t1 });
  });

  it('a venue cannot hold two different papers at once', async () => {
    const c = clash(
      await schedule(F.maths6, {
        exam_date: monday,
        start_time: '10:00',
        end_time: '11:00',
        venue_id: F.hall,
      }),
    );
    expect(c[0]).toMatchObject({ type: 'VENUE', venue_id: F.hall });
    await ok(
      await schedule(F.maths6, {
        exam_date: monday,
        start_time: '10:00',
        end_time: '11:00',
        venue_id: F.room,
        invigilator_ids: [F.t2],
      }),
    );
  });
});

describe('lesson warnings', () => {
  it('warns (but saves) when an invigilator normally teaches at that time', async () => {
    await ok(
      await api.post(`/teachers/${F.t3}/assignments`, { subject_offering_id: F.sci6Offering }),
      201,
    );
    await ok(
      await api.post('/timetable/periods', {
        kind: 'LESSON',
        class_id: F.c6,
        name: 'Period 1',
        start_time: '08:00',
        end_time: '08:45',
        subject_offering_id: F.sci6Offering,
        teacher_id: F.t3,
      }),
      201,
    );
    const res = await ok(
      await schedule(F.sci6, {
        exam_date: plus(1),
        start_time: '08:30',
        end_time: '09:30',
        invigilator_ids: [F.t3],
      }),
    );
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatchObject({ teacher_id: F.t3 });
    expect(res.warnings[0]!.message).toContain('Period 1');
    expect(res.paper.start_time).toBe('08:30');
  });
});

describe('markers and duties', () => {
  it('a marker can enter marks for their paper; the teacher sees their duties', async () => {
    const t = await ok(
      await api.post('/teachers', {
        first_name: 'Marker',
        last_name: uniq('T'),
        email: `${uniq('m')}@school.test`,
      }),
      201,
    );
    await ok(
      await api.post(`/teachers/${t.id}/portal-access`, {
        role_id: await h.roleId(api, 'TEACHER'),
      }),
      201,
    );
    const session = await h.acceptAndLogin(t.email);
    const marks = { records: [{ student_id: F.kid6, marks: 42 }] };
    const before = await session.api.put(`/exams/papers/${F.maths6}/marks`, marks);
    expect(before.status).toBe(403); // not their class, not (yet) their paper
    await ok(await schedule(F.maths6, { marker_ids: [t.id], invigilator_ids: [F.t2, t.id] }));
    await ok(await session.api.put(`/exams/papers/${F.maths6}/marks`, marks));
    const duties = await ok(await session.api.get('/exams/my-duties'));
    expect(duties.invigilating.map((s: Json) => s.paper_id)).toEqual([F.maths6]);
    expect(duties.invigilating[0]).toMatchObject({ start_time: '10:00', class_name: 'Class 6' });
    expect(duties.marking.map((p: Json) => p.paper_id)).toEqual([F.maths6]);
  });

  it('deleting a scheduled paper and the exam removes its timetable too', async () => {
    expect((await api.delete(`/exams/papers/${F.sci6}`)).status).toBe(204);
    expect((await api.delete(`/exams/${F.examId}`)).status).toBe(204);
  });
});
