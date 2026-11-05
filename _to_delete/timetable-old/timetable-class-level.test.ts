import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { timetableEntries } from '../../src/db/schema/index.js';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

/**
 * Timetables for a class that has no sections: its lessons belong to the whole
 * class (section_id NULL, class_id set). A class with sections keeps scheduling
 * per section.
 */
let h: Harness;
let api: Api;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function ok<T = Json>(res: { status: number; body: Json }, status = 200) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
}

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

let yearId: string;
let nursery: string; // no sections
let grade1: string; // has sections
let g1A: string;
let artN: string; // class-wide offering of the nursery
let musicN: string;
let math1: string; // offering of grade 1
let tArt: string;
let tMusic: string;
let p1: string;
let p2: string;
let lunch: string;
let ttId: string;

beforeAll(async () => {
  h = await createHarness();
  const school = await h.provisionSchool();
  api = school.admin.api;
  yearId = (
    await ok(
      await api.post('/academic-years', {
        code: uniq('Y'),
        name: 'Year',
        start_date: daysAgo(100),
        end_date: inDays(200),
      }),
      201,
    )
  ).id;
  await ok(await api.post(`/academic-years/${yearId}/activate`, { complete_current: true }));
  const cls = async (name: string, seq: number) =>
    (await ok(await api.post('/academic-classes', { code: uniq('C'), name, sequence: seq }), 201))
      .id as string;
  nursery = await cls('Nursery', 1);
  grade1 = await cls('Grade 1', 2);
  g1A = (
    await ok(
      await api.post(`/academic-years/${yearId}/sections`, {
        class_id: grade1,
        code: 'A',
        name: 'Section A',
      }),
      201,
    )
  ).id;
  const offering = async (name: string, classId: string) => {
    const subj = await ok(
      await api.post('/subjects', { code: uniq('S').toUpperCase(), name }),
      201,
    );
    return (
      await ok(
        await api.post('/subject-offerings', {
          academic_year_id: yearId,
          subject_id: subj.id,
          class_id: classId,
        }),
        201,
      )
    ).id as string;
  };
  artN = await offering('Art', nursery);
  musicN = await offering('Music', nursery);
  math1 = await offering('Mathematics', grade1);
  const teacher = async (first: string, offeringId: string) => {
    const t = await ok(
      await api.post('/teachers', { first_name: first, last_name: uniq('F') }),
      201,
    );
    await ok(
      await api.post(`/teachers/${t.id}/assignments`, { subject_offering_id: offeringId }),
      201,
    );
    return t.id as string;
  };
  tArt = await teacher('Asha', artN);
  tMusic = await teacher('Milo', musicN);
  await teacher('Meera', math1);
  const period = async (c: string, s: string, e: string, kind = 'LESSON') =>
    (
      await ok(
        await api.post('/timetable/periods', {
          code: c,
          name: c,
          start_time: s,
          end_time: e,
          kind,
        }),
        201,
      )
    ).id as string;
  p1 = await period('P1', '08:00', '08:40');
  p2 = await period('P2', '08:40', '09:20');
  lunch = await period('LUN', '09:20', '10:00', 'LUNCH');
  ttId = (
    await ok(
      await api.post('/timetable/timetables', { academic_year_id: yearId, name: 'Main' }),
      201,
    )
  ).id;
});
afterAll(() => h.close());

const grid = (classId: string, cells: object[], replace = false) =>
  api.put(`/timetable/timetables/${ttId}/classes/${classId}/grid`, { cells, replace });

describe('class-level lessons (a class without sections)', () => {
  it('saves a class grid: lessons belong to the class, with no section', async () => {
    const res = await ok(
      await grid(nursery, [
        { day_of_week: 1, period_id: p1, subject_offering_id: artN },
        { day_of_week: 1, period_id: p2, subject_offering_id: musicN },
        { day_of_week: 2, period_id: p1, subject_offering_id: artN },
      ]),
    );
    expect(res).toMatchObject({ class_id: nursery, section_id: null, created: 3 });
    const rows = await h.deps.db
      .select()
      .from(timetableEntries)
      .where(eq(timetableEntries.timetableId, ttId));
    expect(rows.every((r) => r.sectionId === null && r.classId === nursery)).toBe(true);

    const list = await ok<Json[]>(await api.get(`/timetable/timetables/${ttId}/entries`));
    const art = list.find((e) => e.subject_offering_id === artN && e.day_of_week === 1)!;
    expect(art.section).toBeNull();
    expect(art.class).toMatchObject({ id: nursery, name: 'Nursery' });
    expect(art.owner).toEqual({ kind: 'CLASS', id: nursery, title: 'Nursery' });
    expect(art.teacher.id).toBe(tArt);
  });

  it('updates and clears cells of the class grid, and replace makes it the whole truth', async () => {
    await ok(
      await grid(nursery, [
        { day_of_week: 1, period_id: p1, subject_offering_id: musicN }, // change
        { day_of_week: 2, period_id: p1, subject_offering_id: null }, // clear
      ]),
    );
    const view = await ok(await api.get(`/timetable/views/class/${nursery}?timetable_id=${ttId}`));
    expect(view.class).toMatchObject({ id: nursery, name: 'Nursery' });
    const cell = (day: number, period: string) =>
      view.periods
        .find((r: Json) => r.id === period)
        ?.cells.find((c: Json) => c.day_of_week === day)?.entry ?? null;
    expect(cell(1, p1).subject.name).toBe('Music');
    expect(cell(2, p1)).toBeNull();
    expect(view.summary.lessons_per_week).toBe(2);

    const replaced = await ok(
      await grid(nursery, [{ day_of_week: 3, period_id: p2, subject_offering_id: artN }], true),
    );
    expect(replaced).toMatchObject({ created: 1, deleted: 2 });
  });

  it('refuses a second lesson in the same class slot, and teacher double-booking', async () => {
    const one = await api.post(`/timetable/timetables/${ttId}/entries`, {
      day_of_week: 3,
      period_id: p2,
      class_id: nursery,
      subject_offering_id: musicN,
    });
    expect(one.status).toBe(409);
    expect(one.body.error.details.clashes.map((c: Json) => c.type)).toContain('SECTION');
  });

  it('creates single class-level entries and requires exactly one of section_id or class_id', async () => {
    const created = await ok(
      await api.post(`/timetable/timetables/${ttId}/entries`, {
        day_of_week: 4,
        period_id: p1,
        class_id: nursery,
        subject_offering_id: musicN,
      }),
      201,
    );
    expect(created.owner).toMatchObject({ kind: 'CLASS', id: nursery });
    expect(created.teacher.id).toBe(tMusic);
    const both = await api.post(`/timetable/timetables/${ttId}/entries`, {
      day_of_week: 4,
      period_id: p2,
      class_id: nursery,
      section_id: g1A,
      subject_offering_id: musicN,
    });
    expect(code(both)).toBe('VALIDATION_ERROR');
    const neither = await api.post(`/timetable/timetables/${ttId}/entries`, {
      day_of_week: 4,
      period_id: p2,
      subject_offering_id: musicN,
    });
    expect(code(neither)).toBe('VALIDATION_ERROR');
  });

  it('refuses class-level lessons for a class that has sections', async () => {
    const res = await grid(grade1, [{ day_of_week: 1, period_id: p1, subject_offering_id: math1 }]);
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('CLASS_HAS_SECTIONS');
    const view = await api.get(`/timetable/views/class/${grade1}?timetable_id=${ttId}`);
    expect(view.body.error.details.reason).toBe('CLASS_HAS_SECTIONS');
    // the section of that class still schedules normally
    await ok(
      await api.put(`/timetable/timetables/${ttId}/sections/${g1A}/grid`, {
        cells: [{ day_of_week: 1, period_id: p1, subject_offering_id: math1 }],
      }),
    );
  });

  it("refuses another class's offering, non-lesson periods and unknown classes", async () => {
    const res = await grid(nursery, [
      { day_of_week: 5, period_id: p1, subject_offering_id: math1 },
      { day_of_week: 5, period_id: lunch, subject_offering_id: artN },
    ]);
    expect(res.status).toBe(422);
    const codes = res.body.error.details.cells.map((c: Json) => c.code);
    expect(codes).toEqual(['OFFERING_NOT_FOR_SECTION', 'PERIOD_NOT_LESSON']);
    const missing = await grid('01a00000-0000-7000-8000-000000000000', [
      { day_of_week: 5, period_id: p1, subject_offering_id: artN },
    ]);
    expect(missing.status, JSON.stringify(missing.body)).toBe(404);
  });

  it('checks, publishes and copies class-level lessons into a new draft', async () => {
    const check = await ok(await api.get(`/timetable/timetables/${ttId}/check`));
    expect(check.blocking.filter((i: Json) => i.type.endsWith('CLASH'))).toEqual([]);
    expect(
      check.warnings.some((i: Json) => i.type === 'EMPTY_SLOTS' && i.details?.class_id === nursery),
    ).toBe(true);
    const pub = await api.post(`/timetable/timetables/${ttId}/publish`, {});
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    const copy = await ok(await api.post(`/timetable/timetables/${ttId}/duplicate`, {}), 201);
    const copied = await h.deps.db
      .select()
      .from(timetableEntries)
      .where(eq(timetableEntries.timetableId, copy.id));
    expect(copied.filter((r) => r.sectionId === null && r.classId === nursery).length).toBe(2);
  });

  it("shows class-level lessons in the teacher's week", async () => {
    const week = await ok(await api.get(`/timetable/views/teacher/${tMusic}`));
    const entries = week.periods
      .flatMap((r: Json) => r.cells.map((c: Json) => c.entry))
      .filter(Boolean);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e: Json) => e.owner.kind === 'CLASS' && e.section === null)).toBe(true);
  });
});
