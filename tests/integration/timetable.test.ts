import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

/**
 * The live timetable: each section (or class without sections) has its own
 * periods; a lesson period carries its subject and teacher, so the week is
 * periods × working days, with weekday exceptions. No versions, no publishing.
 */
let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function ok<T = Json>(res: { status: number; body: Json }, status = 200) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
}
const reason = (res: { body: Json }) => res.body.error?.details?.reason as string | undefined;

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

interface Fx {
  yearId: string;
  g7: string;
  g8: string;
  nursery: string; // class without sections
  s7A: string;
  s7B: string;
  s8A: string;
  math7: string; // whole class, one teacher (tMath)
  sci7: string; // one teacher (tSci)
  eng7: string; // one teacher (tEng)
  hist7: string; // two teachers
  art7A: string; // section 7A only
  math8: string; // tMath too
  artN: string; // nursery
  tMath: string;
  tSci: string;
  tEng: string;
  tHistA: string;
  tHistB: string;
  tArtN: string;
  r1: string;
  lab: string;
}

async function fixture(a: Api): Promise<Fx> {
  const yearId = (
    await ok(
      await a.post('/academic-years', {
        code: uniq('Y'),
        name: 'Year',
        start_date: daysAgo(100),
        end_date: inDays(200),
      }),
      201,
    )
  ).id;
  await ok(await a.post(`/academic-years/${yearId}/activate`, { complete_current: true }));
  const cls = async (name: string, seq: number) =>
    (await ok(await a.post('/academic-classes', { code: uniq('C'), name, sequence: seq }), 201))
      .id as string;
  const g7 = await cls('Grade 7', 7);
  const g8 = await cls('Grade 8', 8);
  const nursery = await cls('Nursery', 1);
  const sec = async (classId: string, c: string) =>
    (
      await ok(
        await a.post(`/academic-years/${yearId}/sections`, {
          class_id: classId,
          code: c,
          name: `Section ${c}`,
        }),
        201,
      )
    ).id as string;
  const s7A = await sec(g7, 'A');
  const s7B = await sec(g7, 'B');
  const s8A = await sec(g8, 'A');
  const subjectIds = new Map<string, string>();
  const offering = async (name: string, classId: string, sectionId?: string) => {
    let sid = subjectIds.get(name);
    if (!sid) {
      sid = (await ok(await a.post('/subjects', { code: uniq('S').toUpperCase(), name }), 201))
        .id as string;
      subjectIds.set(name, sid);
    }
    return (
      await ok(
        await a.post('/subject-offerings', {
          academic_year_id: yearId,
          subject_id: sid,
          class_id: classId,
          ...(sectionId ? { section_id: sectionId } : {}),
        }),
        201,
      )
    ).id as string;
  };
  const math7 = await offering('Mathematics', g7);
  const sci7 = await offering('Science', g7);
  const eng7 = await offering('English', g7);
  const hist7 = await offering('History', g7);
  const art7A = await offering('Art', g7, s7A);
  const math8 = await offering('Mathematics', g8);
  const artN = await offering('Art', nursery);
  const teacher = async (first: string, ...offerings: string[]) => {
    const t = await ok(await a.post('/teachers', { first_name: first, last_name: uniq('F') }), 201);
    for (const o of offerings)
      await ok(await a.post(`/teachers/${t.id}/assignments`, { subject_offering_id: o }), 201);
    return t.id as string;
  };
  const tMath = await teacher('Maya', math7, math8);
  const tSci = await teacher('Sunil', sci7);
  const tEng = await teacher('Erin', eng7, art7A);
  const tHistA = await teacher('Hana', hist7);
  const tHistB = await teacher('Hugo', hist7);
  const tArtN = await teacher('Nia', artN);
  const venue = async (c: string, name: string) =>
    (
      await ok(
        await a.post('/timetable/venues', {
          code: uniq(c).toUpperCase(),
          name,
          venue_type: 'CLASSROOM',
        }),
        201,
      )
    ).id as string;
  return {
    yearId,
    g7,
    g8,
    nursery,
    s7A,
    s7B,
    s8A,
    math7,
    sci7,
    eng7,
    hist7,
    art7A,
    math8,
    artN,
    tMath,
    tSci,
    tEng,
    tHistA,
    tHistB,
    tArtN,
    r1: await venue('R', 'Room 101'),
    lab: await venue('L', 'Lab'),
  };
}

let F: Fx;
beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  api = A.admin.api;
  F = await fixture(api);
});
afterAll(() => h.close());

const period = (a: Api, body: object) => a.post('/timetable/periods', { kind: 'LESSON', ...body });
const grid = async (sectionId: string) =>
  ok(await api.get(`/timetable/views/section/${sectionId}`));
const cellsOf = (g: Json, periodId: string) =>
  g.periods.find((p: Json) => p.id === periodId).cells as Json[];

describe('periods carry their lesson: the week is always filled', () => {
  let p1: Json;

  it('a lesson period needs a subject; its only teacher is picked automatically', async () => {
    const none = await period(api, {
      section_id: F.s7A,
      name: 'Period 1',
      start_time: '08:00',
      end_time: '08:40',
    });
    expect(code(none)).toBe('VALIDATION_ERROR');
    p1 = await ok(
      await period(api, {
        section_id: F.s7A,
        name: 'Period 1',
        start_time: '08:00',
        end_time: '08:40',
        subject_offering_id: F.math7,
      }),
      201,
    );
    expect(p1.lesson.subject.name).toBe('Mathematics');
    expect(p1.lesson.teacher.id).toBe(F.tMath);
    expect(p1.owner).toMatchObject({ kind: 'SECTION', id: F.s7A });
    expect(p1.days.map((d: Json) => d.state)).toEqual([
      'LESSON',
      'LESSON',
      'LESSON',
      'LESSON',
      'LESSON',
    ]);
  });

  it('the section grid shows the lesson on every working day, without anything else to do', async () => {
    const g = await grid(F.s7A);
    expect(g.timetable).toBeNull();
    const cells = cellsOf(g, p1.id);
    expect(cells).toHaveLength(5);
    expect(cells.every((c) => c.state === 'LESSON' && c.entry.subject.name === 'Mathematics')).toBe(
      true,
    );
    expect(g.summary.lessons_per_week).toBe(5);
    expect(g.summary.empty_lesson_slots).toBe(0);
  });

  it('breaks take no subject; overlapping periods of the same day are refused', async () => {
    const brk = await ok(
      await period(api, {
        section_id: F.s7A,
        name: 'Break',
        kind: 'BREAK',
        start_time: '08:40',
        end_time: '09:00',
      }),
      201,
    );
    expect(brk.lesson).toBeNull();
    expect(brk.days.every((d: Json) => d.state === 'NO_LESSONS')).toBe(true);
    const withSubject = await period(api, {
      section_id: F.s7A,
      name: 'Lunch',
      kind: 'LUNCH',
      start_time: '12:00',
      end_time: '12:30',
      subject_offering_id: F.math7,
    });
    expect(code(withSubject)).toBe('VALIDATION_ERROR');
    const overlap = await period(api, {
      section_id: F.s7A,
      name: 'Clash',
      start_time: '08:30',
      end_time: '09:10',
      subject_offering_id: F.sci7,
    });
    expect(reason(overlap)).toBe('PERIOD_OVERLAP');
  });

  it('checks the subject and teacher: offered there, someone assigned, the right teacher', async () => {
    const base = { section_id: F.s7B, name: 'P', start_time: '09:00', end_time: '09:40' };
    expect(reason(await period(api, { ...base, subject_offering_id: F.math8 }))).toBe(
      'OFFERING_NOT_FOR_SECTION',
    );
    expect(reason(await period(api, { ...base, subject_offering_id: F.art7A }))).toBe(
      'OFFERING_NOT_FOR_SECTION',
    ); // Art is offered to 7A only
    expect(reason(await period(api, { ...base, subject_offering_id: F.hist7 }))).toBe(
      'AMBIGUOUS_TEACHER',
    );
    expect(
      reason(await period(api, { ...base, subject_offering_id: F.hist7, teacher_id: F.tSci })),
    ).toBe('TEACHER_NOT_ASSIGNED');
    const ok1 = await ok(
      await period(api, { ...base, subject_offering_id: F.hist7, teacher_id: F.tHistB }),
      201,
    );
    expect(ok1.lesson.teacher.id).toBe(F.tHistB);
  });
});

describe('clashes are refused on save', () => {
  it('one teacher cannot be in two sections at overlapping times (periods differ per section)', async () => {
    // 7A has Mathematics (Maya) 08:00–08:40. 8A at 08:20–09:00 with Maya overlaps.
    const clash = await period(api, {
      section_id: F.s8A,
      name: 'Maths',
      start_time: '08:20',
      end_time: '09:00',
      subject_offering_id: F.math8,
    });
    expect(clash.status).toBe(422);
    expect(reason(clash)).toBe('SCHEDULE_CLASH');
    expect(clash.body.error.details.clashes[0].type).toBe('TEACHER');
    expect(clash.body.error.message).toContain('Grade 7 Section A');
    // right after is fine
    await ok(
      await period(api, {
        section_id: F.s8A,
        name: 'Maths',
        start_time: '08:40',
        end_time: '09:20',
        subject_offering_id: F.math8,
      }),
      201,
    );
  });

  it('a venue cannot be booked twice at once', async () => {
    await ok(
      await period(api, {
        section_id: F.s7A,
        name: 'Science',
        start_time: '10:00',
        end_time: '10:40',
        subject_offering_id: F.sci7,
        venue_id: F.lab,
      }),
      201,
    );
    const busy = await period(api, {
      section_id: F.s7B,
      name: 'English',
      start_time: '10:20',
      end_time: '11:00',
      subject_offering_id: F.eng7,
      venue_id: F.lab,
    });
    expect(reason(busy)).toBe('SCHEDULE_CLASH');
    expect(busy.body.error.details.clashes[0].type).toBe('VENUE');
  });
});

describe('editing a period and weekday exceptions', () => {
  let p: Json;
  beforeAll(async () => {
    p = await ok(
      await period(api, {
        section_id: F.s7B,
        name: 'Period 4',
        start_time: '11:00',
        end_time: '11:40',
        subject_offering_id: F.sci7,
      }),
      201,
    );
  });

  it('changing the subject changes every day at once', async () => {
    const changed = await ok(
      await api.patch(`/timetable/periods/${p.id}`, {
        version: p.version,
        subject_offering_id: F.eng7,
      }),
    );
    expect(changed.lesson.subject.name).toBe('English');
    expect(changed.lesson.teacher.id).toBe(F.tEng);
    const cells = cellsOf(await grid(F.s7B), p.id);
    expect(cells.every((c) => c.entry?.subject.name === 'English')).toBe(true);
    p = changed;
  });

  it('every Friday can be another subject, or free; resetting removes the exception', async () => {
    const fri = await ok(
      await api.put(`/timetable/periods/${p.id}/days/5`, { subject_offering_id: F.sci7 }),
    );
    const day5 = fri.days.find((d: Json) => d.day_of_week === 5);
    expect(day5).toMatchObject({ state: 'LESSON', overridden: true });
    expect(day5.subject.name).toBe('Science');
    expect(fri.days.find((d: Json) => d.day_of_week === 1).subject.name).toBe('English');

    const free = await ok(
      await api.put(`/timetable/periods/${p.id}/days/3`, { subject_offering_id: null }),
    );
    expect(free.days.find((d: Json) => d.day_of_week === 3).state).toBe('FREE');
    const g = await grid(F.s7B);
    expect(cellsOf(g, p.id).find((c) => c.day_of_week === 3)!.entry).toBeNull();

    const back = await ok(
      await api.put(`/timetable/periods/${p.id}/days/5`, { subject_offering_id: F.eng7 }),
    );
    expect(back.days.find((d: Json) => d.day_of_week === 5).overridden).toBe(false);
    const cleared = await ok(await api.delete(`/timetable/periods/${p.id}/days/3`));
    expect(cleared.days.every((d: Json) => d.state === 'LESSON')).toBe(true);
  });

  it('refuses exceptions on non-working days and on breaks; clashes count per day', async () => {
    expect(
      reason(await api.put(`/timetable/periods/${p.id}/days/7`, { subject_offering_id: F.eng7 })),
    ).toBe('DAY_NOT_WORKING');
    // Maya teaches 8A 08:40–09:20; a Monday exception in 7A at 08:00–08:40 with Maya is fine,
    // but a 7B Monday exception at 08:50 with Maths would clash.
    const p7b = await ok(
      await period(api, {
        section_id: F.s7B,
        name: 'Period 2',
        start_time: '08:50',
        end_time: '09:00',
        subject_offering_id: F.sci7,
      }),
      201,
    );
    const clash = await api.put(`/timetable/periods/${p7b.id}/days/1`, {
      subject_offering_id: F.math7,
    });
    expect(reason(clash)).toBe('SCHEDULE_CLASH');
  });

  it('deleting a period removes it (and its exceptions) from the week', async () => {
    const tmp = await ok(
      await period(api, {
        section_id: F.s7B,
        name: 'Tmp',
        start_time: '14:00',
        end_time: '14:40',
        subject_offering_id: F.eng7,
      }),
      201,
    );
    await ok(await api.put(`/timetable/periods/${tmp.id}/days/2`, { subject_offering_id: null }));
    expect((await api.delete(`/timetable/periods/${tmp.id}`)).status).toBe(204);
    expect((await api.get(`/timetable/periods/${tmp.id}`)).status).toBe(404);
  });
});

describe('a weekday can have its own times', () => {
  it('periods for some weekdays only: other days are off, overlaps count per shared day', async () => {
    const monThu = await ok(
      await period(api, {
        section_id: F.s8A,
        name: 'Late period',
        start_time: '14:00',
        end_time: '14:40',
        days_of_week: [4, 1, 2, 3, 3],
        subject_offering_id: F.math8,
      }),
      201,
    );
    expect(monThu.days_of_week).toEqual([1, 2, 3, 4]);
    expect(monThu.days.find((d: Json) => d.day_of_week === 5).state).toBe('OFF');
    // Friday has a shorter period at the same time: no overlap, no teacher clash.
    const fri = await ok(
      await period(api, {
        section_id: F.s8A,
        name: 'Friday period',
        start_time: '14:00',
        end_time: '14:30',
        days_of_week: [5],
        subject_offering_id: F.math8,
      }),
      201,
    );
    expect(fri.days.map((d: Json) => d.state)).toEqual(['OFF', 'OFF', 'OFF', 'OFF', 'LESSON']);
    // An every-day period would overlap both.
    const everyDay = await period(api, {
      section_id: F.s8A,
      name: 'Clash',
      kind: 'BREAK',
      start_time: '14:10',
      end_time: '14:20',
    });
    expect(reason(everyDay)).toBe('PERIOD_OVERLAP');
    // A Friday-only period cannot get a Monday exception.
    expect(
      reason(await api.put(`/timetable/periods/${fri.id}/days/1`, { subject_offering_id: null })),
    ).toBe('DAY_NOT_IN_PERIOD');
    // Widening Friday's period to every day overlaps Mon–Thu.
    expect(
      reason(
        await api.patch(`/timetable/periods/${fri.id}`, {
          version: fri.version,
          days_of_week: null,
        }),
      ),
    ).toBe('PERIOD_OVERLAP');
    const g = await grid(F.s8A);
    expect(cellsOf(g, monThu.id).find((c) => c.day_of_week === 5)).toMatchObject({
      state: 'OFF',
      entry: null,
    });
    expect(cellsOf(g, fri.id).find((c) => c.day_of_week === 5)!.entry.subject.name).toBe(
      'Mathematics',
    );
    // Choosing every teaching day is stored as "every day".
    const all = await ok(
      await period(api, {
        section_id: F.s8A,
        name: 'Late break',
        kind: 'BREAK',
        start_time: '15:00',
        end_time: '15:15',
        days_of_week: [1, 2, 3, 4, 5],
      }),
      201,
    );
    expect(all.days_of_week).toBeNull();
    // Leave 8A as the later tests expect it.
    for (const x of [monThu, fri, all])
      await ok(await api.delete(`/timetable/periods/${x.id}`), 204);
  });
});

describe('copying periods, classes without sections, and status', () => {
  it('copies the times of the School default day into an empty section; subjects are then set', async () => {
    await ok(await period(api, { name: 'Period 1', start_time: '07:30', end_time: '08:10' }), 201);
    const withSubject = await period(api, {
      name: 'X',
      start_time: '08:10',
      end_time: '08:50',
      subject_offering_id: F.math7,
    });
    expect(code(withSubject)).toBe('VALIDATION_ERROR'); // the template has no subjects
    // a fresh class with one section to copy into
    const g9 = (
      await ok(
        await api.post('/academic-classes', { code: uniq('C'), name: 'Grade 9', sequence: 9 }),
        201,
      )
    ).id;
    const s9 = (
      await ok(
        await api.post(`/academic-years/${F.yearId}/sections`, {
          class_id: g9,
          code: 'A',
          name: 'Section A',
        }),
        201,
      )
    ).id;
    const res = await ok(
      await api.post('/timetable/periods/copy', {
        to: { section_id: s9 },
        from: { template: true },
      }),
      201,
    );
    expect(res.created).toBe(1);
    const list = await ok(await api.get(`/timetable/periods?section_id=${s9}`));
    expect(list.periods[0]).toMatchObject({ name: 'Period 1', needs_subject: true });
    const again = await api.post('/timetable/periods/copy', {
      to: { section_id: s9 },
      from: { template: true },
    });
    expect(reason(again)).toBe('OWNER_HAS_PERIODS');
    const status = await ok(await api.get('/timetable/status'));
    const s9row = status.owners.find((o: Json) => o.id === s9);
    expect(s9row).toMatchObject({ state: 'NEEDS_ATTENTION', needs_subject: 1 });
  });

  it('a class without sections has its own periods; a class with sections does not', async () => {
    const n = await ok(
      await period(api, {
        class_id: F.nursery,
        name: 'Art',
        start_time: '09:00',
        end_time: '09:30',
        subject_offering_id: F.artN,
      }),
      201,
    );
    expect(n.owner).toMatchObject({ kind: 'CLASS', id: F.nursery });
    const view = await ok(await api.get(`/timetable/views/class/${F.nursery}`));
    expect(view.summary.lessons_per_week).toBe(5);
    const split = await period(api, {
      class_id: F.g7,
      name: 'X',
      start_time: '15:00',
      end_time: '15:30',
      subject_offering_id: F.math7,
    });
    expect(reason(split)).toBe('CLASS_HAS_SECTIONS');
    const status = await ok(await api.get('/timetable/status'));
    expect(status.owners.find((o: Json) => o.id === F.nursery)).toMatchObject({
      kind: 'CLASS',
      state: 'COMPLETE',
    });
    expect(status.owners.find((o: Json) => o.id === F.s7A).periods).toBeGreaterThan(0);
  });
});

describe('views from the live timetable', () => {
  it("shows a teacher's week across sections and the workload", async () => {
    const t = await ok(await api.get(`/timetable/views/teacher/${F.tMath}`));
    expect(t.summary.lessons_per_week).toBe(10); // 7A + 8A, five days each
    expect(t.summary.sections).toBe(2);
    expect(t.periods.map((r: Json) => r.start_time)).toEqual(['08:00', '08:40']);
    const w = await ok(await api.get('/timetable/workload'));
    expect(w.teachers.find((x: Json) => x.teacher.id === F.tMath).lessons_per_week).toBe(10);
  });

  it("gives a teacher their own week and today's lessons through the login link", async () => {
    const t = await ok(
      await api.post('/teachers', {
        first_name: 'Login',
        last_name: uniq('T'),
        email: `${uniq('t')}@school.test`,
      }),
      201,
    );
    await ok(
      await api.post(`/teachers/${t.id}/assignments`, { subject_offering_id: F.math7 }),
      201,
    );
    const role = await h.roleId(api, 'TEACHER');
    await ok(await api.post(`/teachers/${t.id}/portal-access`, { role_id: role }), 201);
    const session = await h.acceptAndLogin(t.email);
    const p = await ok(
      await period(api, {
        section_id: F.s7B,
        name: 'Maths B',
        start_time: '13:00',
        end_time: '13:40',
        subject_offering_id: F.math7,
        teacher_id: t.id,
      }),
      201,
    );
    const mine = await ok(await session.api.get('/timetable/views/me'));
    expect(mine.summary.lessons_per_week).toBe(5);
    const monday = new Date();
    while ((monday.getUTCDay() || 7) !== 1) monday.setUTCDate(monday.getUTCDate() + 1);
    const day = await ok(
      await session.api.get(`/timetable/views/me/today?date=${monday.toISOString().slice(0, 10)}`),
    );
    expect(day.periods.flatMap((r: Json) => r.entries).map((e: Json) => e.period_id)).toEqual([
      p.id,
    ]);
  });

  it('exports the live timetable as CSV', async () => {
    const res = await api.get(`/timetable/export?section_id=${F.s7A}`);
    expect(res.status).toBe(200);
    const lines = res.text.trim().split(/\r?\n/);
    expect(lines[0]).toContain('Subject');
    expect(lines.length).toBeGreaterThan(5);
  });

  it('narrows reads and writes to the sections in scope', async () => {
    const scoped = await h.addMember(api, [
      {
        role_id: await h.scopableRole(api, 'PRINCIPAL'),
        scope_type: 'ASSIGNED_SECTION',
        scope_ref: { section_ids: [F.s7A] },
      },
    ]);
    expect((await scoped.api.get(`/timetable/views/section/${F.s7B}`)).status).toBe(404);
    expect((await scoped.api.get(`/timetable/views/section/${F.s7A}`)).status).toBe(200);
    const status = await ok(await scoped.api.get('/timetable/status'));
    expect(status.owners.map((o: Json) => o.id)).toEqual([F.s7A]);
  });
});

describe('a new academic year', () => {
  it("copies last year's timetable where sections, subjects and teachers still match", async () => {
    const y2 = (
      await ok(
        await api.post('/academic-years', {
          code: uniq('Y'),
          name: 'Next year',
          start_date: inDays(201),
          end_date: inDays(500),
        }),
        201,
      )
    ).id;
    await ok(await api.post(`/academic-years/${y2}/open`, {}));
    const s7A2 = (
      await ok(
        await api.post(`/academic-years/${y2}/sections`, {
          class_id: F.g7,
          code: 'A',
          name: 'Section A',
        }),
        201,
      )
    ).id;
    const subj = (await ok(
      await api.get(`/subject-offerings?academic_year_id=${F.yearId}&class_id=${F.g7}`),
    )) as Json[];
    const mathSubject = subj.find((o: Json) => o.id === F.math7)!.subject.id;
    const math72 = (
      await ok(
        await api.post('/subject-offerings', {
          academic_year_id: y2,
          subject_id: mathSubject,
          class_id: F.g7,
        }),
        201,
      )
    ).id;
    await ok(
      await api.post(`/teachers/${F.tMath}/assignments`, { subject_offering_id: math72 }),
      201,
    );
    const r = await ok(
      await api.post('/timetable/copy-year', {
        from_academic_year_id: F.yearId,
        to_academic_year_id: y2,
        class_id: F.g7,
      }),
    );
    expect(r.owners).toBe(1); // 7A only: 7B has no section in the new year
    expect(r.skipped.some((m: string) => m.includes('Section B'))).toBe(true);
    const list = await ok(await api.get(`/timetable/periods?section_id=${s7A2}`));
    const maths = list.periods.find((p: Json) => p.lesson?.subject?.name === 'Mathematics');
    expect(maths.lesson.teacher.id).toBe(F.tMath);
    // Science is not offered in the new year: the period is copied without a subject
    expect(list.periods.some((p: Json) => p.needs_subject)).toBe(true);
  });
});

describe('settings and venues', () => {
  it('changes the working days; the week follows', async () => {
    const s = await ok(await api.get('/timetable/settings'));
    const saved = await ok(
      await api.patch('/timetable/settings', {
        version: s.version,
        working_days: [1, 2, 3, 4, 5, 6],
      }),
    );
    expect(saved.working_days).toEqual([1, 2, 3, 4, 5, 6]);
    const g = await grid(F.s7A);
    expect(g.days).toHaveLength(6);
    await ok(
      await api.patch('/timetable/settings', {
        version: saved.version,
        working_days: [1, 2, 3, 4, 5],
      }),
    );
  });

  it('a venue in use cannot be closed or deleted', async () => {
    const v = await ok(await api.get(`/timetable/venues/${F.lab}`));
    expect(reason(await api.post(`/timetable/venues/${v.id}/deactivate`))).toBe('VENUE_IN_USE');
    expect(reason(await api.delete(`/timetable/venues/${v.id}`))).toBe('VENUE_IN_USE');
  });
});
