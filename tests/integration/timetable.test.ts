import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLogs,
  outboxEvents,
  teachers,
  timetableEntries,
  timetables,
} from '../../src/db/schema/index.js';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>; // config, entries, grid, concurrency
let P: Awaited<ReturnType<Harness['provisionSchool']>>; // publish lifecycle, views, scope
let B: Awaited<ReturnType<Harness['provisionSchool']>>; // another school
let api: Api;
let papi: Api;
let FA: Fixture;
let FP: Fixture;
let FB: Fixture;

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
/** First date at or after today (+ `from` days) that falls on ISO weekday `dow`. */
function onWeekday(dow: number, from = 0) {
  for (let i = from; ; i++) {
    const d = inDays(i);
    const w = new Date(`${d}T00:00:00Z`).getUTCDay() || 7;
    if (w === dow) return d;
  }
}

interface Fixture {
  yearId: string;
  classId: string;
  class2Id: string;
  s7A: string;
  s7B: string;
  s8A: string;
  math7: string;
  sci7: string;
  eng7: string;
  hist7: string; // two teachers share it
  art7A: string; // section-level offering (7A only)
  math8: string; // another class
  tMath: string;
  tSci: string;
  tEng: string;
  tArt: string;
  tHistA: string;
  tHistB: string;
  tNone: string;
  assignMath: string;
  p1: string;
  p2: string;
  brk: string;
  p3: string;
  p4: string;
  lunch: string;
  r1: string;
  r2: string;
  lab: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function ok<T = Json>(res: { status: number; body: Json }, status = 200) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
}

async function buildFixture(a: Api, label: string): Promise<Fixture> {
  const y = await a.post('/academic-years', {
    code: `Y-${label}`,
    name: `Year ${label}`,
    start_date: daysAgo(200),
    end_date: inDays(160),
  });
  const yearId = (await ok(y, 201)).id as string;
  await ok(await a.post(`/academic-years/${yearId}/activate`, { complete_current: true }));
  const cls = async (c: string, s: number) =>
    (
      await ok(
        await a.post('/academic-classes', { code: `${c}${label}`, name: c, sequence: s }),
        201,
      )
    ).id as string;
  const classId = await cls('Grade7', 7);
  const class2Id = await cls('Grade8', 8);
  const sec = async (classId_: string, c: string) =>
    (
      await ok(
        await a.post(`/academic-years/${yearId}/sections`, {
          class_id: classId_,
          code: c,
          name: `Section ${c}`,
        }),
        201,
      )
    ).id as string;
  const s7A = await sec(classId, 'A');
  const s7B = await sec(classId, 'B');
  const s8A = await sec(class2Id, 'A');
  const subject = async (name: string) =>
    (await ok(await a.post('/subjects', { code: uniq('S').toUpperCase(), name }), 201))
      .id as string;
  const offering = async (subjectId: string, classId_: string, sectionId?: string) =>
    (
      await ok(
        await a.post('/subject-offerings', {
          academic_year_id: yearId,
          subject_id: subjectId,
          class_id: classId_,
          ...(sectionId ? { section_id: sectionId } : {}),
        }),
        201,
      )
    ).id as string;
  const mathSubject = await subject('Mathematics');
  const math7 = await offering(mathSubject, classId);
  const math8 = await offering(mathSubject, class2Id);
  const sci7 = await offering(await subject('Science'), classId);
  const eng7 = await offering(await subject('English'), classId);
  const hist7 = await offering(await subject('History'), classId);
  const art7A = await offering(await subject('Art'), classId, s7A);
  const teacher = async (first: string) =>
    (await ok(await a.post('/teachers', { first_name: first, last_name: uniq('Fam') }), 201))
      .id as string;
  const assign = async (teacherId: string, offeringId: string) =>
    (
      await ok(
        await a.post(`/teachers/${teacherId}/assignments`, { subject_offering_id: offeringId }),
        201,
      )
    ).id as string;
  const tMath = await teacher('Maya');
  const tSci = await teacher('Sunil');
  const tEng = await teacher('Erin');
  const tArt = await teacher('Arya');
  const tHistA = await teacher('Hana');
  const tHistB = await teacher('Hugo');
  const tNone = await teacher('Nobody');
  const assignMath = await assign(tMath, math7);
  await assign(tMath, math8);
  await assign(tSci, sci7);
  await assign(tEng, eng7);
  await assign(tArt, art7A);
  await assign(tHistA, hist7);
  await assign(tHistB, hist7);
  const period = async (c: string, name: string, s: string, e: string, kind = 'LESSON') =>
    (
      await ok(
        await a.post('/timetable/periods', {
          code: c,
          name,
          start_time: s,
          end_time: e,
          kind,
        }),
        201,
      )
    ).id as string;
  const p1 = await period('P1', 'Period 1', '08:00', '08:45');
  const p2 = await period('P2', 'Period 2', '08:45', '09:30');
  const brk = await period('BRK', 'Break', '09:30', '09:45', 'BREAK');
  const p3 = await period('P3', 'Period 3', '09:45', '10:30');
  const p4 = await period('P4', 'Period 4', '10:30', '11:15');
  const lunch = await period('LUN', 'Lunch', '11:15', '12:00', 'LUNCH');
  const venue = async (c: string, name: string, type: string, capacity: number) =>
    (
      await ok(
        await a.post('/timetable/venues', { code: c, name, venue_type: type, capacity }),
        201,
      )
    ).id as string;
  const r1 = await venue('R1', 'Room 101', 'CLASSROOM', 40);
  const r2 = await venue('R2', 'Room 102', 'CLASSROOM', 40);
  const lab = await venue('LAB1', 'Science Lab', 'LAB', 2);
  return {
    yearId,
    classId,
    class2Id,
    s7A,
    s7B,
    s8A,
    math7,
    sci7,
    eng7,
    hist7,
    art7A,
    math8,
    tMath,
    tSci,
    tEng,
    tArt,
    tHistA,
    tHistB,
    tNone,
    assignMath,
    p1,
    p2,
    brk,
    p3,
    p4,
    lunch,
    r1,
    r2,
    lab,
  };
}

/** A new class-wide Grade 7 offering nobody teaches yet (no cross-talk between tests). */
async function freshOffering(a: Api, F: Fixture) {
  const subj = await ok(
    await a.post('/subjects', { code: uniq('FO').toUpperCase(), name: uniq('Fresh') }),
    201,
  );
  return (
    await ok(
      await a.post('/subject-offerings', {
        academic_year_id: F.yearId,
        subject_id: subj.id,
        class_id: F.classId,
      }),
      201,
    )
  ).id as string;
}

type Tt = { id: string; version: number; status: string; version_no: number; entry_count: number };
async function newDraft(a: Api, F: Fixture, extra: object = {}) {
  return ok<Tt>(
    await a.post('/timetable/timetables', {
      academic_year_id: F.yearId,
      name: uniq('Timetable'),
      ...extra,
    }),
    201,
  );
}
const addEntry = (a: Api, ttId: string, body: object) =>
  a.post(`/timetable/timetables/${ttId}/entries`, body);
type Entry = {
  id: string;
  version: number;
  day_of_week: number;
  teacher: { id: string };
  venue: { id: string } | null;
  section: { id: string };
  period: { id: string };
};
async function lesson(
  a: Api,
  ttId: string,
  F: Fixture,
  o: {
    day: number;
    period: string;
    section?: string;
    offering?: string;
    teacher?: string;
    venue?: string | null;
  },
) {
  return ok<Entry>(
    await addEntry(a, ttId, {
      day_of_week: o.day,
      period_id: o.period,
      section_id: o.section ?? F.s7A,
      subject_offering_id: o.offering ?? F.math7,
      ...(o.teacher ? { teacher_id: o.teacher } : {}),
      ...(o.venue ? { venue_id: o.venue } : {}),
    }),
    201,
  );
}
const entriesOf = async (ttId: string) =>
  h.deps.db.select().from(timetableEntries).where(eq(timetableEntries.timetableId, ttId));

async function dbErrorCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    let cur: unknown = err;
    for (let i = 0; i < 5 && cur; i++) {
      if (typeof cur === 'object' && cur !== null && 'code' in cur)
        return String((cur as { code: unknown }).code);
      cur = (cur as { cause?: unknown }).cause;
    }
    return 'UNKNOWN';
  }
  return undefined;
}

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  P = await h.provisionSchool();
  B = await h.provisionSchool();
  api = A.admin.api;
  papi = P.admin.api;
  FA = await buildFixture(api, 'A');
  FP = await buildFixture(papi, 'P');
  FB = await buildFixture(B.admin.api, 'B');
}, 120_000);
afterAll(() => h.close());

// ==================================================================================
describe('configuration: working days, periods, venues', () => {
  it('starts with Monday to Friday and changes with an optimistic version', async () => {
    const s = await ok(await api.get('/timetable/settings'));
    expect(s.working_days).toEqual([1, 2, 3, 4, 5]);
    expect(s.working_day_names[0]).toBe('Monday');
    const upd = await ok(
      await api.patch('/timetable/settings', {
        version: s.version,
        working_days: [1, 2, 3, 4, 5, 6],
      }),
    );
    expect(upd.working_days).toEqual([1, 2, 3, 4, 5, 6]);
    expect(upd.version).toBe(s.version + 1);
    const stale = await api.patch('/timetable/settings', {
      version: s.version,
      working_days: [1, 2, 3],
    });
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe('CONFLICT');
    expect(stale.body.error.details.reason).toBe('STALE_VERSION');
    expect(
      (await api.patch('/timetable/settings', { version: upd.version, working_days: [] })).status,
    ).toBe(422);
    expect(
      (await api.patch('/timetable/settings', { version: upd.version, working_days: [1, 1] }))
        .status,
    ).toBe(422);
    expect(
      (await api.patch('/timetable/settings', { version: upd.version, working_days: [0, 8] }))
        .status,
    ).toBe(422);
    // back to Mon-Fri for the other tests
    await ok(
      await api.patch('/timetable/settings', {
        version: upd.version,
        working_days: [1, 2, 3, 4, 5],
      }),
    );
  });

  it('creates periods with validation, an upper-cased unique code and no overlaps', async () => {
    const p = await ok(
      await api.post('/timetable/periods', {
        code: 'zz1',
        name: 'Zero',
        start_time: '06:00',
        end_time: '06:30',
      }),
      201,
    );
    expect(p).toMatchObject({
      code: 'ZZ1',
      kind: 'LESSON',
      is_teaching: true,
      status: 'ACTIVE',
      start_time: '06:00',
      end_time: '06:30',
      version: 1,
    });
    const dup = await api.post('/timetable/periods', {
      code: 'ZZ1',
      name: 'Again',
      start_time: '05:00',
      end_time: '05:30',
    });
    expect(dup.status).toBe(409);
    expect(code(dup)).toBe('DUPLICATE_RESOURCE');
    const overlap = await api.post('/timetable/periods', {
      code: 'ZZ2',
      name: 'Overlap',
      start_time: '06:15',
      end_time: '06:45',
    });
    expect(overlap.status).toBe(422);
    expect(code(overlap)).toBe('OPERATION_NOT_ALLOWED');
    expect(overlap.body.error.details.reason).toBe('PERIOD_OVERLAP');
    expect(overlap.body.error.details.overlapping[0].code).toBe('ZZ1');
    // touching is fine
    expect(
      (
        await api.post('/timetable/periods', {
          code: 'ZZ3',
          name: 'Adjacent',
          start_time: '06:30',
          end_time: '07:00',
        })
      ).status,
    ).toBe(201);
    for (const bad of [
      { code: 'ZZ4', name: 'Backwards', start_time: '07:30', end_time: '07:00' },
      { code: 'ZZ4', name: 'Bad time', start_time: '7:3', end_time: '08:00' },
      { code: 'ZZ4', name: 'Bad kind', start_time: '07:00', end_time: '07:30', kind: 'NAP' },
      { code: 'bad code!', name: 'x', start_time: '07:00', end_time: '07:30' },
    ]) {
      const r = await api.post('/timetable/periods', bad);
      expect(r.status).toBe(422);
      expect(code(r)).toBe('VALIDATION_ERROR');
    }
    // list ordered by start time, filterable
    const list = await ok<{ code: string; kind: string }[]>(await api.get('/timetable/periods'));
    const times = list.map((x) => x.code);
    expect(times.indexOf('ZZ1')).toBeLessThan(times.indexOf('P1'));
    const breaks = await ok<{ code: string }[]>(await api.get('/timetable/periods?kind=BREAK'));
    expect(breaks.map((x) => x.code)).toEqual(['BRK']);
  });

  it('edits, deactivates, reactivates and deletes periods', async () => {
    const p = await ok(
      await api.post('/timetable/periods', {
        code: 'EDT',
        name: 'Edit me',
        start_time: '19:00',
        end_time: '19:30',
      }),
      201,
    );
    const edited = await ok(
      await api.patch(`/timetable/periods/${p.id}`, {
        version: 1,
        name: 'Evening',
        end_time: '19:45',
      }),
    );
    expect(edited).toMatchObject({ name: 'Evening', end_time: '19:45', version: 2, code: 'EDT' });
    expect(
      (await api.patch(`/timetable/periods/${p.id}`, { version: 1, name: 'Stale' })).status,
    ).toBe(409);
    const clash = await api.patch(`/timetable/periods/${p.id}`, {
      version: 2,
      start_time: '11:30',
    });
    expect(clash.status).toBe(422); // overlaps Lunch and ends before it starts
    const off = await ok(await api.post(`/timetable/periods/${p.id}/deactivate`));
    expect(off.status).toBe('INACTIVE');
    const on = await ok(await api.post(`/timetable/periods/${p.id}/activate`));
    expect(on.status).toBe('ACTIVE');
    expect((await api.delete(`/timetable/periods/${p.id}`)).status).toBe(204);
    expect((await api.get(`/timetable/periods/${p.id}`)).status).toBe(404);
  });

  it('creates venues with a unique code, filters and edits them', async () => {
    const v = await ok(
      await api.post('/timetable/venues', {
        code: 'gym',
        name: 'Gym',
        venue_type: 'HALL',
        capacity: 200,
      }),
      201,
    );
    expect(v).toMatchObject({ code: 'GYM', venue_type: 'HALL', capacity: 200, status: 'ACTIVE' });
    expect((await api.post('/timetable/venues', { code: 'GYM', name: 'Other' })).status).toBe(409);
    expect(
      (await api.post('/timetable/venues', { code: 'X1', name: 'Bad', venue_type: 'POOL' })).status,
    ).toBe(422);
    expect(
      (await api.post('/timetable/venues', { code: 'X1', name: 'Bad', capacity: 0 })).status,
    ).toBe(422);
    const halls = await api.get('/timetable/venues?venue_type=HALL');
    expect(halls.body.data.map((x: { code: string }) => x.code)).toEqual(['GYM']);
    expect(halls.body.meta.total).toBe(1);
    const search = await api.get('/timetable/venues?search=science');
    expect(search.body.data.map((x: { code: string }) => x.code)).toEqual(['LAB1']);
    const edited = await ok(
      await api.patch(`/timetable/venues/${v.id}`, {
        version: 1,
        name: 'Sports Hall',
        capacity: null,
      }),
    );
    expect(edited).toMatchObject({ name: 'Sports Hall', capacity: null, version: 2 });
    expect(
      (await api.patch(`/timetable/venues/${v.id}`, { version: 1, name: 'Stale' })).status,
    ).toBe(409);
    expect((await ok(await api.post(`/timetable/venues/${v.id}/deactivate`))).status).toBe(
      'INACTIVE',
    );
    expect((await api.get('/timetable/venues?status=INACTIVE')).body.data).toHaveLength(1);
    expect((await api.delete(`/timetable/venues/${v.id}`)).status).toBe(204);
  });

  it('refuses configuration changes that would break a draft or published timetable', async () => {
    const tt = await newDraft(api, FA);
    await lesson(api, tt.id, FA, { day: 5, period: FA.p1, venue: FA.r1 });
    const venue = await api.post(`/timetable/venues/${FA.r1}/deactivate`);
    expect(venue.status).toBe(422);
    expect(venue.body.error.details.reason).toBe('VENUE_IN_USE');
    expect(venue.body.error.details.timetable_ids).toContain(tt.id);
    const period = await api.post(`/timetable/periods/${FA.p1}/deactivate`);
    expect(period.status).toBe(422);
    expect(period.body.error.details.reason).toBe('PERIOD_IN_USE');
    const kind = await api.patch(`/timetable/periods/${FA.p1}`, { version: 1, kind: 'BREAK' });
    expect(kind.status).toBe(422);
    expect(kind.body.error.details.reason).toBe('PERIOD_IN_USE');
    expect((await api.delete(`/timetable/periods/${FA.p1}`)).status).toBe(422);
    expect((await api.delete(`/timetable/venues/${FA.r1}`)).status).toBe(422);
    const s = await ok(await api.get('/timetable/settings'));
    const days = await api.patch('/timetable/settings', {
      version: s.version,
      working_days: [1, 2, 3, 4],
    });
    expect(days.status).toBe(422);
    expect(days.body.error.details.reason).toBe('DAY_IN_USE');
    expect(days.body.error.details.removed_days).toEqual([5]);
    // after archiving the only draft using them the changes go through, then are undone
    await ok(await api.post(`/timetable/timetables/${tt.id}/archive`, {}));
    const off = await ok(await api.post(`/timetable/venues/${FA.r1}/deactivate`));
    expect(off.status).toBe('INACTIVE');
    await ok(await api.post(`/timetable/venues/${FA.r1}/activate`));
    expect((await api.delete(`/timetable/venues/${FA.r1}`)).status).toBe(422); // archived version still references it
  });
});

// ==================================================================================
describe('timetable versions: creating drafts', () => {
  it('creates numbered DRAFT versions per academic year', async () => {
    const one = await newDraft(api, FA, {
      name: 'Term 1',
      effective_from: inDays(1),
      effective_to: inDays(90),
      notes: 'first',
    });
    expect(one).toMatchObject({ status: 'DRAFT', entry_count: 0, version: 1 });
    const res = await ok(await api.get(`/timetable/timetables/${one.id}`));
    expect(res).toMatchObject({
      name: 'Term 1',
      effective_from: inDays(1),
      effective_to: inDays(90),
      notes: 'first',
      copied_from_id: null,
    });
    expect(res.academic_year.id).toBe(FA.yearId);
    const two = await newDraft(api, FA);
    expect(two.version_no).toBe(one.version_no + 1);
    const list = await api.get(`/timetable/timetables?academic_year_id=${FA.yearId}&status=DRAFT`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((x: Tt) => x.id)).toEqual(expect.arrayContaining([one.id, two.id]));
    expect(list.body.meta.total).toBeGreaterThanOrEqual(2);
  });

  it('validates the request and the academic year', async () => {
    const bad = await api.post('/timetable/timetables', {
      academic_year_id: FA.yearId,
      name: 'x',
      effective_from: inDays(9),
      effective_to: inDays(2),
    });
    expect(bad.status).toBe(422);
    const outside = await api.post('/timetable/timetables', {
      academic_year_id: FA.yearId,
      name: 'x',
      effective_from: daysAgo(400),
    });
    expect(outside.status).toBe(422);
    expect(code(outside)).toBe('VALIDATION_ERROR');
    expect((await api.post('/timetable/timetables', { academic_year_id: FA.yearId })).status).toBe(
      422,
    );
    // a year that is still DRAFT cannot get a timetable
    const y = await ok(
      await api.post('/academic-years', {
        code: uniq('Y'),
        name: 'Future',
        start_date: inDays(400),
        end_date: inDays(700),
      }),
      201,
    );
    const closed = await api.post('/timetable/timetables', {
      academic_year_id: y.id,
      name: 'Nope',
    });
    expect(closed.status).toBe(422);
    expect(closed.body.error.details.reason).toBe('YEAR_NOT_OPEN');
    // another school's year does not exist for us
    expect(
      (await api.post('/timetable/timetables', { academic_year_id: FB.yearId, name: 'x' })).status,
    ).toBe(404);
  });

  it('edits only drafts, with the version you read', async () => {
    const tt = await newDraft(api, FA);
    const upd = await ok<Tt & { name: string }>(
      await api.patch(`/timetable/timetables/${tt.id}`, { version: tt.version, name: 'Renamed' }),
    );
    expect(upd).toMatchObject({ name: 'Renamed', version: tt.version + 1 });
    const stale = await api.patch(`/timetable/timetables/${tt.id}`, {
      version: tt.version,
      name: 'Stale',
    });
    expect(stale.status).toBe(409);
    await ok(await api.post(`/timetable/timetables/${tt.id}/archive`, {}));
    const archived = await api.patch(`/timetable/timetables/${tt.id}`, {
      version: upd.version + 1,
      name: 'Late',
    });
    expect(archived.status).toBe(422);
    expect(archived.body.error.details.reason).toBe('TIMETABLE_NOT_DRAFT');
  });
});

// ==================================================================================
describe('entries: rules and clashes', () => {
  let tt: Tt;
  beforeAll(async () => {
    tt = await newDraft(api, FA);
  });

  it('schedules a lesson: teacher resolved from the offering, venue optional', async () => {
    const e = await ok<
      Entry & {
        teacher: { full_name: string };
        subject: { name: string };
        period: { start_time: string };
        venue: { code: string } | null;
        status: string;
      }
    >(
      await addEntry(api, tt.id, {
        day_of_week: 1,
        period_id: FA.p1,
        section_id: FA.s7A,
        subject_offering_id: FA.math7,
        venue_id: FA.r1,
      }),
      201,
    );
    expect(e).toMatchObject({ day_of_week: 1, status: 'ACTIVE', version: 1 });
    expect(e.teacher.id).toBe(FA.tMath);
    expect(e.subject.name).toBe('Mathematics');
    expect(e.period.start_time).toBe('08:00');
    expect(e.venue!.code).toBe('R1');
    const got = await ok<Entry>(await api.get(`/timetable/entries/${e.id}`));
    expect(got.id).toBe(e.id);
    expect((await ok<Tt>(await api.get(`/timetable/timetables/${tt.id}`))).entry_count).toBe(1);
    // by assignment id only
    const byAssignment = await ok<Entry>(
      await addEntry(api, tt.id, {
        day_of_week: 1,
        period_id: FA.p2,
        section_id: FA.s7A,
        teaching_assignment_id: FA.assignMath,
      }),
      201,
    );
    expect(byAssignment.teacher.id).toBe(FA.tMath);
    const list = await api.get(
      `/timetable/timetables/${tt.id}/entries?section_id=${FA.s7A}&day_of_week=1`,
    );
    expect(list.body.data).toHaveLength(2);
    expect(list.body.meta.total).toBe(2);
  });

  it('rejects a second lesson for the same section, day and period (section clash)', async () => {
    const res = await addEntry(api, tt.id, {
      day_of_week: 1,
      period_id: FA.p1,
      section_id: FA.s7A,
      subject_offering_id: FA.sci7,
    });
    expect(res.status).toBe(409);
    expect(code(res)).toBe('CONFLICT');
    expect(res.body.error.details.reason).toBe('SCHEDULE_CLASH');
    const c = res.body.error.details.clashes;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ type: 'SECTION', day_of_week: 1, period_id: FA.p1 });
    expect(c[0].entry.subject.name).toBe('Mathematics');
    expect(c[0].entry.section.id).toBe(FA.s7A);
  });

  it('rejects a teacher in two places at once (teacher clash) and names the entry in the way', async () => {
    const res = await addEntry(api, tt.id, {
      day_of_week: 1,
      period_id: FA.p1,
      section_id: FA.s7B,
      subject_offering_id: FA.math7,
    });
    expect(res.status).toBe(409);
    const types = res.body.error.details.clashes.map((c: { type: string }) => c.type);
    expect(types).toEqual(['TEACHER']);
    expect(res.body.error.details.clashes[0].entry.section.id).toBe(FA.s7A);
    // the same teacher in another period is fine
    await lesson(api, tt.id, FA, { day: 1, period: FA.p3, section: FA.s7B });
  });

  it('rejects a double-booked venue, and reports every clash at once', async () => {
    const venue = await addEntry(api, tt.id, {
      day_of_week: 1,
      period_id: FA.p1,
      section_id: FA.s7B,
      subject_offering_id: FA.sci7,
      venue_id: FA.r1,
    });
    expect(venue.status).toBe(409);
    expect(venue.body.error.details.clashes.map((c: { type: string }) => c.type)).toEqual([
      'VENUE',
    ]);
    const all = await addEntry(api, tt.id, {
      day_of_week: 1,
      period_id: FA.p1,
      section_id: FA.s7A,
      subject_offering_id: FA.math7,
      venue_id: FA.r1,
    });
    expect(all.status).toBe(409);
    expect(new Set(all.body.error.details.clashes.map((c: { type: string }) => c.type))).toEqual(
      new Set(['SECTION', 'TEACHER', 'VENUE']),
    );
    // nothing was written by the rejected requests
    expect(
      (await entriesOf(tt.id)).filter((e) => e.dayOfWeek === 1 && e.periodId === FA.p1),
    ).toHaveLength(1);
    // another venue works
    await lesson(api, tt.id, FA, {
      day: 1,
      period: FA.p1,
      section: FA.s7B,
      offering: FA.sci7,
      venue: FA.r2,
    });
  });

  it('only lets a teacher with an active assignment for the offering teach it', async () => {
    const res = await addEntry(api, tt.id, {
      day_of_week: 2,
      period_id: FA.p1,
      section_id: FA.s7A,
      subject_offering_id: FA.math7,
      teacher_id: FA.tSci,
    });
    expect(res.status).toBe(422);
    expect(code(res)).toBe('OPERATION_NOT_ALLOWED');
    expect(res.body.error.details.reason).toBe('TEACHER_NOT_ASSIGNED');
    const none = await addEntry(api, tt.id, {
      day_of_week: 2,
      period_id: FA.p1,
      section_id: FA.s7A,
      subject_offering_id: FA.math7,
      teacher_id: FA.tNone,
    });
    expect(none.body.error.details.reason).toBe('TEACHER_NOT_ASSIGNED');
    // an offering nobody teaches
    const y = await ok(
      await api.post('/subjects', { code: uniq('NT').toUpperCase(), name: 'Untaught' }),
      201,
    );
    const off = await ok(
      await api.post('/subject-offerings', {
        academic_year_id: FA.yearId,
        subject_id: y.id,
        class_id: FA.classId,
      }),
      201,
    );
    const nobody = await addEntry(api, tt.id, {
      day_of_week: 2,
      period_id: FA.p1,
      section_id: FA.s7A,
      subject_offering_id: off.id,
    });
    expect(nobody.status).toBe(422);
    expect(nobody.body.error.details.reason).toBe('NO_TEACHING_ASSIGNMENT');
    // two teachers share History: the caller must choose
    const amb = await addEntry(api, tt.id, {
      day_of_week: 2,
      period_id: FA.p1,
      section_id: FA.s7A,
      subject_offering_id: FA.hist7,
    });
    expect(amb.status).toBe(422);
    expect(amb.body.error.details.reason).toBe('AMBIGUOUS_TEACHER');
    expect(amb.body.error.details.teachers).toHaveLength(2);
    expect(
      (
        await addEntry(api, tt.id, {
          day_of_week: 2,
          period_id: FA.p1,
          section_id: FA.s7A,
          subject_offering_id: FA.hist7,
          teacher_id: FA.tHistB,
        })
      ).status,
    ).toBe(201);
    // an assignment that was ended cannot be scheduled
    const t2 = await ok(
      await api.post('/teachers', { first_name: 'Ended', last_name: uniq('F') }),
      201,
    );
    const endedOffering = await freshOffering(api, FA);
    const a2 = await ok(
      await api.post(`/teachers/${t2.id}/assignments`, {
        subject_offering_id: endedOffering,
        start_date: daysAgo(30),
      }),
      201,
    );
    await ok(await api.post(`/teaching-assignments/${a2.id}/end`, {}));
    const ended = await addEntry(api, tt.id, {
      day_of_week: 2,
      period_id: FA.p2,
      section_id: FA.s7A,
      teaching_assignment_id: a2.id,
    });
    expect(ended.status).toBe(422);
    expect(ended.body.error.details.reason).toBe('TEACHING_ASSIGNMENT_NOT_ACTIVE');
    // an assignment id that does not match the offering sent with it
    const mism = await addEntry(api, tt.id, {
      day_of_week: 2,
      period_id: FA.p2,
      section_id: FA.s7A,
      subject_offering_id: FA.sci7,
      teaching_assignment_id: FA.assignMath,
    });
    expect(mism.body.error.details.reason).toBe('ASSIGNMENT_OFFERING_MISMATCH');
  });

  it("refuses an offering that is not the section's class or section", async () => {
    const otherClass = await addEntry(api, tt.id, {
      day_of_week: 3,
      period_id: FA.p1,
      section_id: FA.s7A,
      subject_offering_id: FA.math8,
    });
    expect(otherClass.status).toBe(422);
    expect(otherClass.body.error.details.reason).toBe('OFFERING_NOT_FOR_SECTION');
    const otherSection = await addEntry(api, tt.id, {
      day_of_week: 3,
      period_id: FA.p1,
      section_id: FA.s7B,
      subject_offering_id: FA.art7A,
    });
    expect(otherSection.status).toBe(422);
    expect(otherSection.body.error.details.reason).toBe('OFFERING_NOT_FOR_SECTION');
    // the section-level offering works for its own section; a class-wide one works for both
    expect(
      (
        await addEntry(api, tt.id, {
          day_of_week: 3,
          period_id: FA.p1,
          section_id: FA.s7A,
          subject_offering_id: FA.art7A,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await addEntry(api, tt.id, {
          day_of_week: 3,
          period_id: FA.p2,
          section_id: FA.s7B,
          subject_offering_id: FA.math7,
        })
      ).status,
    ).toBe(201);
    // an inactive offering
    const off = await ok(
      await api.post('/subject-offerings', {
        academic_year_id: FA.yearId,
        subject_id: (
          await ok(
            await api.post('/subjects', { code: uniq('IN').toUpperCase(), name: 'Dormant' }),
            201,
          )
        ).id,
        class_id: FA.classId,
      }),
      201,
    );
    const t3 = await ok(
      await api.post('/teachers', { first_name: 'Dorm', last_name: uniq('F') }),
      201,
    );
    await ok(
      await api.post(`/teachers/${t3.id}/assignments`, { subject_offering_id: off.id }),
      201,
    );
    await ok(await api.post(`/subject-offerings/${off.id}/deactivate`, {}));
    const inactive = await addEntry(api, tt.id, {
      day_of_week: 3,
      period_id: FA.p4,
      section_id: FA.s7A,
      subject_offering_id: off.id,
    });
    expect(inactive.status).toBe(422);
    expect(inactive.body.error.details.reason).toBe('OFFERING_INACTIVE');
  });

  it('refuses non-lesson periods, inactive periods and non-teaching days', async () => {
    const brk = await addEntry(api, tt.id, {
      day_of_week: 2,
      period_id: FA.brk,
      section_id: FA.s7A,
      subject_offering_id: FA.math7,
    });
    expect(brk.status).toBe(422);
    expect(brk.body.error.details.reason).toBe('PERIOD_NOT_LESSON');
    const sunday = await addEntry(api, tt.id, {
      day_of_week: 7,
      period_id: FA.p1,
      section_id: FA.s7A,
      subject_offering_id: FA.math7,
    });
    expect(sunday.status).toBe(422);
    expect(sunday.body.error.details.reason).toBe('DAY_NOT_WORKING');
    const zz = await ok<{ id: string }[]>(await api.get('/timetable/periods?status=ACTIVE')).then(
      (l) => l.find((p) => (p as { code?: string }).code === 'ZZ1')!,
    );
    await ok(await api.post(`/timetable/periods/${zz.id}/deactivate`));
    const inactive = await addEntry(api, tt.id, {
      day_of_week: 2,
      period_id: zz.id,
      section_id: FA.s7A,
      subject_offering_id: FA.math7,
    });
    expect(inactive.body.error.details.reason).toBe('PERIOD_INACTIVE');
    for (const bad of [
      { day_of_week: 0, period_id: FA.p1, section_id: FA.s7A, subject_offering_id: FA.math7 },
      { day_of_week: 8, period_id: FA.p1, section_id: FA.s7A, subject_offering_id: FA.math7 },
      { day_of_week: 1, period_id: 'nope', section_id: FA.s7A, subject_offering_id: FA.math7 },
      { day_of_week: 1, period_id: FA.p1, section_id: FA.s7A },
    ])
      expect((await addEntry(api, tt.id, bad)).status).toBe(422);
  });

  it("treats another school's ids as missing (404), never as a validation detail", async () => {
    const base = {
      day_of_week: 4,
      period_id: FA.p1,
      section_id: FA.s7A,
      subject_offering_id: FA.math7,
    };
    for (const [field, value] of [
      ['section_id', FB.s7A],
      ['period_id', FB.p1],
      ['subject_offering_id', FB.math7],
      ['venue_id', FB.r1],
      ['teacher_id', FB.tMath],
      ['teaching_assignment_id', FB.assignMath],
    ] as const) {
      const res = await addEntry(api, tt.id, { ...base, [field]: value });
      expect(res.status, field).toBe(404);
      expect(code(res)).toBe('RESOURCE_NOT_FOUND');
    }
    expect((await addEntry(B.admin.api, tt.id, { ...base, section_id: FB.s7A })).status).toBe(404);
    expect((await entriesOf(tt.id)).some((e) => e.dayOfWeek === 4)).toBe(false);
  });

  it('moves, changes and removes a lesson with the version you read', async () => {
    const e = await lesson(api, tt.id, FA, {
      day: 4,
      period: FA.p1,
      section: FA.s7A,
      offering: FA.sci7,
    });
    const moved = await ok<Entry>(
      await api.patch(`/timetable/entries/${e.id}`, {
        version: e.version,
        period_id: FA.p2,
        venue_id: FA.r1,
      }),
    );
    expect(moved).toMatchObject({ version: 2 });
    expect(moved.period.id).toBe(FA.p2);
    expect(moved.venue!.id).toBe(FA.r1);
    expect(moved.teacher.id).toBe(FA.tSci); // teacher stays
    const stale = await api.patch(`/timetable/entries/${e.id}`, { version: 1, period_id: FA.p3 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.reason).toBe('STALE_VERSION');
    // moving onto a booked slot clashes, and the entry is unchanged
    await lesson(api, tt.id, FA, { day: 4, period: FA.p3, section: FA.s7A, offering: FA.eng7 });
    const clash = await api.patch(`/timetable/entries/${e.id}`, { version: 2, period_id: FA.p3 });
    expect(clash.status).toBe(409);
    expect(clash.body.error.details.clashes[0].type).toBe('SECTION');
    expect((await ok<Entry>(await api.get(`/timetable/entries/${e.id}`))).period.id).toBe(FA.p2);
    // a no-op change does not bump the version
    const same = await ok<Entry>(
      await api.patch(`/timetable/entries/${e.id}`, { version: 2, period_id: FA.p2 }),
    );
    expect(same.version).toBe(2);
    // clear the venue
    const cleared = await ok<Entry>(
      await api.patch(`/timetable/entries/${e.id}`, { version: 2, venue_id: null }),
    );
    expect(cleared.venue).toBeNull();
    expect((await api.delete(`/timetable/entries/${e.id}?version=1`)).status).toBe(409);
    expect((await api.delete(`/timetable/entries/${e.id}?version=3`)).status).toBe(204);
    expect((await api.get(`/timetable/entries/${e.id}`)).status).toBe(404);
  });

  it('refuses a teacher change to someone not assigned', async () => {
    const e = await lesson(api, tt.id, FA, {
      day: 5,
      period: FA.p4,
      section: FA.s7B,
      offering: FA.eng7,
    });
    const bad = await api.patch(`/timetable/entries/${e.id}`, { version: 1, teacher_id: FA.tMath });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.reason).toBe('TEACHER_NOT_ASSIGNED');
    const swap = await ok<Entry>(
      await api.patch(`/timetable/entries/${e.id}`, { version: 1, subject_offering_id: FA.sci7 }),
    );
    expect(swap.teacher.id).toBe(FA.tSci); // a new offering resolves its own teacher
  });
});

// ==================================================================================
describe('the database enforces the same rules', () => {
  let tt: Tt;
  let existing!: typeof timetableEntries.$inferSelect;
  beforeAll(async () => {
    tt = await newDraft(api, FA);
    const e = await lesson(api, tt.id, FA, {
      day: 2,
      period: FA.p1,
      section: FA.s7A,
      venue: FA.r1,
    });
    existing = (
      await h.deps.db.select().from(timetableEntries).where(eq(timetableEntries.id, e.id))
    )[0]!;
  });
  const row = (over: Partial<typeof timetableEntries.$inferInsert>) => ({
    ...existing!,
    id: undefined as unknown as string,
    ...over,
  });

  it('refuses a second lesson in the same section slot, teacher slot or venue slot', async () => {
    const db = h.deps.db;
    const [assignSci] = await db.query.teachingAssignments.findMany({
      where: (t, { eq: e }) => e(t.teacherId, FA.tSci),
    });
    expect(
      await dbErrorCode(
        db.insert(timetableEntries).values({ ...existing!, id: undefined as unknown as string }),
      ),
    ).toBe('ER_DUP_ENTRY');
    // other section, same teacher and slot
    expect(
      await dbErrorCode(
        db.insert(timetableEntries).values({ ...row({ sectionId: FA.s7B, venueId: null }) }),
      ),
    ).toBe('ER_DUP_ENTRY');
    // other section and teacher, same venue and slot
    expect(
      await dbErrorCode(
        db.insert(timetableEntries).values({
          ...row({
            sectionId: FA.s7B,
            subjectOfferingId: FA.sci7,
            teachingAssignmentId: assignSci!.id,
            teacherId: FA.tSci,
          }),
        }),
      ),
    ).toBe('ER_DUP_ENTRY');
  });

  it("refuses another school's teacher, section, period, venue or assignment (composite foreign keys)", async () => {
    const db = h.deps.db;
    const tryInsert = (over: Partial<typeof timetableEntries.$inferInsert>) =>
      dbErrorCode(db.insert(timetableEntries).values({ ...row({ dayOfWeek: 3, ...over }) }));
    expect(await tryInsert({ teacherId: FB.tMath })).toBe('ER_NO_REFERENCED_ROW_2');
    expect(await tryInsert({ sectionId: FB.s7A })).toBe('ER_NO_REFERENCED_ROW_2');
    expect(await tryInsert({ periodId: FB.p2 })).toBe('ER_NO_REFERENCED_ROW_2');
    expect(await tryInsert({ venueId: FB.r2 })).toBe('ER_NO_REFERENCED_ROW_2');
    expect(await tryInsert({ teachingAssignmentId: FB.assignMath })).toBe('ER_NO_REFERENCED_ROW_2');
    expect(await tryInsert({ subjectOfferingId: FB.math7 })).toBe('ER_NO_REFERENCED_ROW_2');
    // a timetable of school B with school A's tenant id
    const other = await ok<Tt>(
      await B.admin.api.post('/timetable/timetables', {
        academic_year_id: FB.yearId,
        name: uniq('B'),
      }),
      201,
    );
    expect(await tryInsert({ timetableId: other.id })).toBe('ER_NO_REFERENCED_ROW_2');
  });

  it("pins section and offering to the timetable's academic year", async () => {
    const db = h.deps.db;
    const y2 = await ok(
      await api.post('/academic-years', {
        code: uniq('Y2'),
        name: 'Next',
        start_date: inDays(200),
        end_date: inDays(500),
      }),
      201,
    );
    const s = await ok(
      await api.post(`/academic-years/${y2.id}/sections`, {
        class_id: FA.classId,
        code: 'Z',
        name: 'Z',
      }),
      201,
    );
    expect(
      await dbErrorCode(
        db.insert(timetableEntries).values({ ...row({ dayOfWeek: 3, sectionId: s.id }) }),
      ),
    ).toBe('ER_NO_REFERENCED_ROW_2');
    // and the API says so nicely
    const res = await addEntry(api, tt.id, {
      day_of_week: 3,
      period_id: FA.p1,
      section_id: s.id,
      subject_offering_id: FA.math7,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe('SECTION_WRONG_YEAR');
  });

  it('allows a single PUBLISHED timetable per academic year', async () => {
    const db = h.deps.db;
    const a = await newDraft(api, FA);
    const b = await newDraft(api, FA);
    await db.update(timetables).set({ status: 'PUBLISHED' }).where(eq(timetables.id, a.id));
    expect(
      await dbErrorCode(
        db.update(timetables).set({ status: 'PUBLISHED' }).where(eq(timetables.id, b.id)),
      ),
    ).toBe('ER_DUP_ENTRY');
    await db.update(timetables).set({ status: 'ARCHIVED' }).where(eq(timetables.id, a.id));
    expect(
      await dbErrorCode(
        db.update(timetables).set({ status: 'PUBLISHED' }).where(eq(timetables.id, b.id)),
      ),
    ).toBeUndefined();
    await db.update(timetables).set({ status: 'ARCHIVED' }).where(eq(timetables.id, b.id));
  });
});

// ==================================================================================
describe('concurrency', () => {
  it('lets exactly one of two simultaneous conflicting entries win', async () => {
    for (const kind of ['teacher', 'section', 'venue'] as const) {
      const tt = await newDraft(api, FA);
      const day = 3;
      const bodies =
        kind === 'teacher'
          ? [
              {
                day_of_week: day,
                period_id: FA.p1,
                section_id: FA.s7A,
                subject_offering_id: FA.math7,
              },
              {
                day_of_week: day,
                period_id: FA.p1,
                section_id: FA.s7B,
                subject_offering_id: FA.math7,
              },
            ]
          : kind === 'section'
            ? [
                {
                  day_of_week: day,
                  period_id: FA.p1,
                  section_id: FA.s7A,
                  subject_offering_id: FA.math7,
                },
                {
                  day_of_week: day,
                  period_id: FA.p1,
                  section_id: FA.s7A,
                  subject_offering_id: FA.sci7,
                },
              ]
            : [
                {
                  day_of_week: day,
                  period_id: FA.p1,
                  section_id: FA.s7A,
                  subject_offering_id: FA.math7,
                  venue_id: FA.r2,
                },
                {
                  day_of_week: day,
                  period_id: FA.p1,
                  section_id: FA.s7B,
                  subject_offering_id: FA.sci7,
                  venue_id: FA.r2,
                },
              ];
      const res = await Promise.all(bodies.map((b) => addEntry(api, tt.id, b)));
      expect(res.map((r) => r.status).sort(), kind).toEqual([201, 409]);
      const loser = res.find((r) => r.status === 409)!;
      expect(loser.body.error.details.reason).toBe('SCHEDULE_CLASH');
      expect(await entriesOf(tt.id)).toHaveLength(1);
      await api.post(`/timetable/timetables/${tt.id}/archive`, {});
    }
  });

  it('serialises many parallel writers of one slot', async () => {
    const tt = await newDraft(api, FA);
    const res = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        addEntry(api, tt.id, {
          day_of_week: 2,
          period_id: FA.p3,
          section_id: i % 2 ? FA.s7A : FA.s7B,
          subject_offering_id: FA.math7,
        }),
      ),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(5);
    expect(res.every((r) => [201, 409].includes(r.status))).toBe(true);
    expect(await entriesOf(tt.id)).toHaveLength(1);
  });

  it('a period cannot be deactivated while a lesson is being added to it', async () => {
    const tt = await newDraft(api, FA);
    const p = await ok(
      await api.post('/timetable/periods', {
        code: 'RACE',
        name: 'Race',
        start_time: '20:00',
        end_time: '20:40',
      }),
      201,
    );
    const [add, off] = await Promise.all([
      addEntry(api, tt.id, {
        day_of_week: 2,
        period_id: p.id,
        section_id: FA.s7A,
        subject_offering_id: FA.math7,
      }),
      api.post(`/timetable/periods/${p.id}/deactivate`),
    ]);
    const entries = await entriesOf(tt.id);
    // either the lesson made it (then the period stays active) or the period went inactive first
    if (add.status === 201) {
      expect(off.status).toBe(422);
      expect(entries).toHaveLength(1);
    } else {
      expect(add.status).toBe(422);
      expect(off.status).toBe(200);
      expect(entries).toHaveLength(0);
    }
  });
});

// ==================================================================================
describe('saving a section grid', () => {
  let tt: Tt;
  beforeAll(async () => {
    tt = await newDraft(api, FA);
  });
  const grid = (sectionId: string, body: object, id = tt.id) =>
    api.put(`/timetable/timetables/${id}/sections/${sectionId}/grid`, body);
  const cell = (day: number, period: string, offering: string | null, extra: object = {}) => ({
    day_of_week: day,
    period_id: period,
    subject_offering_id: offering,
    ...extra,
  });

  it('creates, updates and clears cells in one call and reports the counts', async () => {
    const first = await ok(
      await grid(FA.s7A, {
        cells: [
          cell(1, FA.p1, FA.math7, { venue_id: FA.r1 }),
          cell(1, FA.p2, FA.sci7),
          cell(1, FA.p3, FA.eng7),
          cell(2, FA.p1, FA.art7A),
        ],
      }),
    );
    expect(first).toMatchObject({
      section_id: FA.s7A,
      created: 4,
      updated: 0,
      deleted: 0,
      unchanged: 0,
    });
    // the same request again changes nothing
    expect(
      await ok(
        await grid(FA.s7A, {
          cells: [cell(1, FA.p1, FA.math7, { venue_id: FA.r1 }), cell(1, FA.p2, FA.sci7)],
        }),
      ),
    ).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    // change one, clear one, add one
    const second = await ok(
      await grid(FA.s7A, {
        cells: [
          cell(1, FA.p1, FA.math7, { venue_id: FA.r2 }),
          cell(1, FA.p3, null),
          cell(2, FA.p2, FA.eng7),
        ],
      }),
    );
    expect(second).toMatchObject({ created: 1, updated: 1, deleted: 1, unchanged: 0 });
    const view = await ok(
      await api.get(`/timetable/views/section/${FA.s7A}?timetable_id=${tt.id}`),
    );
    const at = (d: number, p: string) =>
      view.periods
        .find((x: { id: string }) => x.id === p)
        .cells.find((c: { day_of_week: number }) => c.day_of_week === d).entry;
    expect(at(1, FA.p1).venue.id).toBe(FA.r2);
    expect(at(1, FA.p3)).toBeNull();
    expect(at(2, FA.p2).subject.name).toBe('English');
  });

  it('replace makes the request the whole truth for the section', async () => {
    const res = await ok(
      await grid(FA.s7B, { cells: [cell(3, FA.p1, FA.math7), cell(3, FA.p2, FA.sci7)] }),
    );
    expect(res.created).toBe(2);
    const rep = await ok(
      await grid(FA.s7B, {
        replace: true,
        cells: [cell(3, FA.p1, FA.math7), cell(4, FA.p1, FA.eng7)],
      }),
    );
    expect(rep).toMatchObject({ created: 1, deleted: 1, unchanged: 1 });
    const now = await api.get(`/timetable/timetables/${tt.id}/entries?section_id=${FA.s7B}`);
    expect(
      now.body.data
        .map(
          (e: { day_of_week: number; period: { id: string } }) => `${e.day_of_week}:${e.period.id}`,
        )
        .sort(),
    ).toEqual([`3:${FA.p1}`, `4:${FA.p1}`].sort());
    // replace with nothing empties the section
    expect((await ok(await grid(FA.s7B, { replace: true, cells: [] }))).deleted).toBe(2);
  });

  it('is atomic: one bad cell rolls the whole request back and lists every rejected cell', async () => {
    const before = (await entriesOf(tt.id)).length;
    const res = await grid(FA.s8A, {
      cells: [
        cell(5, FA.p1, FA.math8), // fine
        cell(5, FA.p2, FA.math7), // class 7 offering in a class 8 section
        cell(5, FA.brk, FA.math8), // break period
        cell(5, FA.p3, FA.math8, { teacher_id: FA.tSci }), // not assigned
      ],
    });
    expect(res.status).toBe(422);
    expect(code(res)).toBe('OPERATION_NOT_ALLOWED');
    expect(res.body.error.details.reason).toBe('GRID_REJECTED');
    const cells = res.body.error.details.cells as { index: number; code: string }[];
    expect(cells.map((c) => [c.index, c.code])).toEqual([
      [1, 'OFFERING_NOT_FOR_SECTION'],
      [2, 'PERIOD_NOT_LESSON'],
      [3, 'TEACHER_NOT_ASSIGNED'],
    ]);
    expect((await entriesOf(tt.id)).length).toBe(before);
  });

  it('a clash in one cell rejects the request with 409 and writes nothing', async () => {
    // Maths teacher already teaches 7A on Monday P1: a 7B cell there clashes
    const before = (await entriesOf(tt.id)).length;
    const res = await grid(FA.s7B, { cells: [cell(2, FA.p4, FA.eng7), cell(1, FA.p1, FA.math7)] });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('GRID_REJECTED');
    const c = res.body.error.details.cells;
    expect(c).toHaveLength(1);
    expect(c[0].index).toBe(1);
    expect(c[0].code).toBe('SCHEDULE_CLASH');
    expect(c[0].clashes[0]).toMatchObject({ type: 'TEACHER' });
    expect((await entriesOf(tt.id)).length).toBe(before);
  });

  it('detects stale cells by version and refuses foreign ids with 404', async () => {
    const view = await ok(
      await api.get(`/timetable/views/section/${FA.s7A}?timetable_id=${tt.id}`),
    );
    const e = view.periods
      .find((x: { id: string }) => x.id === FA.p2)
      .cells.find((c: { day_of_week: number }) => c.day_of_week === 1).entry;
    const stale = await grid(FA.s7A, {
      cells: [cell(1, FA.p2, FA.eng7, { version: e.version + 5 })],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.cells[0].code).toBe('STALE_VERSION');
    expect(
      (await grid(FA.s7A, { cells: [cell(1, FA.p2, FA.eng7, { version: e.version })] })).status,
    ).toBe(200);
    expect((await grid(FB.s7A, { cells: [cell(1, FA.p1, FA.math7)] })).status).toBe(404);
    expect((await grid(FA.s7A, { cells: [cell(1, FB.p1, FA.math7)] })).status).toBe(404);
    expect((await grid(FA.s7A, { cells: [cell(1, FA.p1, FB.math7)] })).status).toBe(404);
    expect(
      (await grid(FA.s7A, { cells: [cell(1, FA.p1, FA.math7), cell(1, FA.p1, FA.sci7)] })).status,
    ).toBe(422); // duplicate cell
    expect((await grid(FA.s7A, { cells: [] })).status).toBe(422);
  });
});

// ==================================================================================
describe('publishing and versions', () => {
  it('publishes a clean draft, archives the previous version and keeps one published', async () => {
    const v1 = await newDraft(papi, FP, { name: 'Main' });
    await lesson(papi, v1.id, FP, { day: 1, period: FP.p1, section: FP.s7A, venue: FP.r1 });
    await lesson(papi, v1.id, FP, { day: 1, period: FP.p2, section: FP.s7A, offering: FP.sci7 });
    const pub = await papi.post(`/timetable/timetables/${v1.id}/publish`, {});
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(pub.body.data).toMatchObject({ status: 'PUBLISHED', version_no: 1 });
    expect(pub.body.data.effective_from).toBeTruthy();
    expect(pub.body.data.published_at).toBeTruthy();
    // unscheduled sections are warnings, not blockers
    const kinds = pub.body.meta.warnings.map((w: { type: string }) => w.type);
    expect(kinds).toContain('SECTION_WITHOUT_ENTRIES');
    expect(kinds).toContain('EMPTY_SLOTS');
    // second version from a copy, with a change, then publish: v1 is archived and superseded
    const v2 = await ok<Tt & { copied_from_id: string }>(
      await papi.post(`/timetable/timetables/${v1.id}/duplicate`, { name: 'Main v2' }),
      201,
    );
    expect(v2).toMatchObject({
      status: 'DRAFT',
      version_no: 2,
      copied_from_id: v1.id,
      entry_count: 2,
    });
    await lesson(papi, v2.id, FP, { day: 2, period: FP.p1, section: FP.s7A, offering: FP.eng7 });
    const pub2 = await papi.post(`/timetable/timetables/${v2.id}/publish`, {
      effective_from: inDays(5),
    });
    expect(pub2.status, JSON.stringify(pub2.body)).toBe(200);
    expect(pub2.body.data.effective_from).toBe(inDays(5));
    const old = await ok(await papi.get(`/timetable/timetables/${v1.id}`));
    expect(old).toMatchObject({
      status: 'ARCHIVED',
      superseded_by_id: v2.id,
      effective_to: inDays(4),
    });
    const published = await ok<Tt[]>(
      await papi.get(`/timetable/timetables?academic_year_id=${FP.yearId}&status=PUBLISHED`),
    );
    expect(published.map((t) => t.id)).toEqual([v2.id]);
    // audit and outbox: publish, supersede, create
    const db = h.deps.db;
    const actions = (
      await db
        .select({ a: auditLogs.action, e: auditLogs.entityId })
        .from(auditLogs)
        .where(and(eq(auditLogs.tenantId, P.tenantId), like(auditLogs.action, 'TIMETABLE_%')))
    ).map((r) => `${r.a}:${r.e}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        `TIMETABLE_PUBLISHED:${v1.id}`,
        `TIMETABLE_PUBLISHED:${v2.id}`,
        `TIMETABLE_SUPERSEDED:${v1.id}`,
        `TIMETABLE_CREATED:${v2.id}`,
      ]),
    );
    const events = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, P.tenantId), eq(outboxEvents.aggregateId, v2.id)));
    const published2 = events.find((e) => e.eventType === 'timetable.published');
    expect(published2).toBeTruthy();
    expect(JSON.stringify(published2!.payload)).toContain(v1.id);
    expect(events.some((e) => e.eventType === 'timetable.created')).toBe(true);
    expect(
      (
        await db
          .select()
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.aggregateId, v1.id),
              eq(outboxEvents.eventType, 'timetable.superseded'),
            ),
          )
      ).length,
    ).toBe(1);
  });

  it('is read-only once published: every edit of the version is refused', async () => {
    const [pub] = await ok<Tt[]>(
      await papi.get(`/timetable/timetables?academic_year_id=${FP.yearId}&status=PUBLISHED`),
    );
    const entry = (await papi.get(`/timetable/timetables/${pub!.id}/entries`)).body
      .data[0] as Entry;
    const expectLocked = (res: { status: number; body: Json }) => {
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(code(res)).toBe('INVALID_STATE');
      expect(res.body.error.details.reason).toBe('TIMETABLE_NOT_DRAFT');
    };
    expectLocked(
      await addEntry(papi, pub!.id, {
        day_of_week: 5,
        period_id: FP.p3,
        section_id: FP.s7B,
        subject_offering_id: FP.math7,
      }),
    );
    expectLocked(
      await papi.patch(`/timetable/entries/${entry.id}`, {
        version: entry.version,
        period_id: FP.p4,
      }),
    );
    expectLocked(await papi.delete(`/timetable/entries/${entry.id}`));
    expectLocked(
      await papi.put(`/timetable/timetables/${pub!.id}/sections/${FP.s7A}/grid`, {
        replace: true,
        cells: [],
      }),
    );
    expectLocked(
      await papi.patch(`/timetable/timetables/${pub!.id}`, {
        version: pub!.version,
        name: 'Edited',
      }),
    );
    expectLocked(await papi.post(`/timetable/timetables/${pub!.id}/publish`, {}));
    expect(await entriesOf(pub!.id)).toHaveLength(3);
  });

  it('blocks publishing with the full list of issues, and check reports the same', async () => {
    const tt = await newDraft(papi, FP);
    const empty = await papi.post(`/timetable/timetables/${tt.id}/publish`, {});
    expect(empty.status).toBe(422);
    expect(empty.body.error.details.reason).toBe('PUBLISH_BLOCKED');
    expect(empty.body.error.details.blocking.map((b: { type: string }) => b.type)).toEqual([
      'NO_ENTRIES',
    ]);
    // a teacher whose assignment ends after being scheduled
    const t = await ok(
      await papi.post('/teachers', { first_name: 'Leaver', last_name: uniq('F') }),
      201,
    );
    const subj = await ok(
      await papi.post('/subjects', { code: uniq('LV').toUpperCase(), name: 'Leaving' }),
      201,
    );
    const off = await ok(
      await papi.post('/subject-offerings', {
        academic_year_id: FP.yearId,
        subject_id: subj.id,
        class_id: FP.classId,
      }),
      201,
    );
    const assignment = await ok(
      await papi.post(`/teachers/${t.id}/assignments`, {
        subject_offering_id: off.id,
        start_date: daysAgo(10),
      }),
      201,
    );
    const e = await lesson(papi, tt.id, FP, {
      day: 3,
      period: FP.p1,
      section: FP.s7A,
      offering: off.id,
    });
    await lesson(papi, tt.id, FP, { day: 3, period: FP.p2, section: FP.s7A, venue: FP.lab });
    const ended = await papi.post(`/teachers/${t.id}/resign`, {
      reason: 'Left',
      exit_date: daysAgo(0),
    });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    const check = await ok(await papi.get(`/timetable/timetables/${tt.id}/check`));
    expect(check.ok).toBe(false);
    expect(check.blocking).toHaveLength(1);
    expect(check.blocking[0]).toMatchObject({
      type: 'INVALID_ASSIGNMENT',
      severity: 'BLOCKING',
      day_of_week: 3,
      period_id: FP.p1,
    });
    expect(check.blocking[0].entries[0].id).toBe(e.id);
    expect(check.blocking[0].details.teaching_assignment_id).toBe(assignment.id);
    expect(check.summary).toMatchObject({ entries: 2, blocking_count: 1 });
    const blocked = await papi.post(`/timetable/timetables/${tt.id}/publish`, {});
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details.blocking).toHaveLength(1);
    expect(blocked.body.error.details.blocking[0].type).toBe('INVALID_ASSIGNMENT');
    // still a draft, previously published version untouched
    expect((await ok(await papi.get(`/timetable/timetables/${tt.id}`))).status).toBe('DRAFT');
    // fix the lesson: remove it, then the venue-capacity warning shows (lab seats 2)
    await ok(
      await papi.delete(`/timetable/entries/${e.id}`).then((r) => ({ ...r, body: { data: 1 } })),
      204,
    );
    const fixed = await ok(await papi.get(`/timetable/timetables/${tt.id}/check`));
    expect(fixed.ok).toBe(true);
    // strict mode turns the completeness warnings into blockers
    const strict = await papi.post(`/timetable/timetables/${tt.id}/publish`, { strict: true });
    expect(strict.status).toBe(422);
    expect(strict.body.error.details.blocking.map((b: { type: string }) => b.type)).toEqual(
      expect.arrayContaining(['SECTION_WITHOUT_ENTRIES']),
    );
    const strictCheck = await ok(
      await papi.get(`/timetable/timetables/${tt.id}/check?strict=true`),
    );
    expect(strictCheck.ok).toBe(false);
    await ok(
      await papi.post(`/timetable/timetables/${tt.id}/archive`, { reason: 'Superseded draft' }),
    );
  });

  it('warns when a venue is smaller than the section', async () => {
    const tt = await newDraft(papi, FP);
    for (let i = 0; i < 3; i++) {
      await ok(
        await papi.post('/students', {
          first_name: `Kid${i}`,
          last_name: uniq('F'),
          gender: 'FEMALE',
          enrollment: {
            academic_year_id: FP.yearId,
            class_id: FP.classId,
            section_id: FP.s7A,
            start_date: daysAgo(10),
          },
        }),
        201,
      );
    }
    await lesson(papi, tt.id, FP, { day: 4, period: FP.p1, section: FP.s7A, venue: FP.lab });
    const check = await ok(await papi.get(`/timetable/timetables/${tt.id}/check`));
    const w = check.warnings.find((x: { type: string }) => x.type === 'VENUE_CAPACITY');
    expect(w.details).toEqual({ capacity: 2, students: 3 });
    await ok(await papi.post(`/timetable/timetables/${tt.id}/archive`, {}));
  });

  it('archives a draft or the published version explicitly, once', async () => {
    const tt = await newDraft(papi, FP);
    const a = await ok(
      await papi.post(`/timetable/timetables/${tt.id}/archive`, { reason: 'not needed' }),
    );
    expect(a.status).toBe('ARCHIVED');
    expect(a.archived_at).toBeTruthy();
    const twice = await papi.post(`/timetable/timetables/${tt.id}/archive`, {});
    expect(twice.status).toBe(422);
    expect(code(twice)).toBe('INVALID_STATE');
    // an archived version can be duplicated but not published or edited
    expect((await papi.post(`/timetable/timetables/${tt.id}/publish`, {})).status).toBe(422);
    const copy = await ok<Tt>(await papi.post(`/timetable/timetables/${tt.id}/duplicate`, {}), 201);
    expect(copy.status).toBe('DRAFT');
    await papi.post(`/timetable/timetables/${copy.id}/archive`, {});
  });

  it('copies entries into a new draft and re-points ended assignments at the current one', async () => {
    const t1 = await ok(
      await api.post('/teachers', { first_name: 'Old', last_name: uniq('F') }),
      201,
    );
    const t2 = await ok(
      await api.post('/teachers', { first_name: 'New', last_name: uniq('F') }),
      201,
    );
    const subj = await ok(
      await api.post('/subjects', { code: uniq('CP').toUpperCase(), name: 'Copying' }),
      201,
    );
    const off = await ok(
      await api.post('/subject-offerings', {
        academic_year_id: FA.yearId,
        subject_id: subj.id,
        class_id: FA.classId,
      }),
      201,
    );
    const a1 = await ok(
      await api.post(`/teachers/${t1.id}/assignments`, {
        subject_offering_id: off.id,
        start_date: daysAgo(20),
      }),
      201,
    );
    const src = await newDraft(api, FA);
    await lesson(api, src.id, FA, { day: 5, period: FA.p1, section: FA.s7A, offering: off.id });
    await lesson(api, src.id, FA, { day: 5, period: FA.p2, section: FA.s7B, offering: FA.eng7 });
    // the old teacher's assignment ends and the same teacher... is replaced by a new teacher with the same offering
    await ok(
      await api.post(`/teachers/${t1.id}/resign`, {
        reason: 'Left the school',
        exit_date: daysAgo(0),
      }),
    );
    const a2 = await ok(
      await api.post(`/teachers/${t2.id}/assignments`, { subject_offering_id: off.id }),
      201,
    );
    const copy = await ok<Tt>(await api.post(`/timetable/timetables/${src.id}/duplicate`, {}), 201);
    expect(copy.entry_count).toBe(2);
    const copied = await entriesOf(copy.id);
    const stale = copied.find((e) => e.subjectOfferingId === off.id)!;
    // teacher t1 left, so the copy keeps the ended assignment (flagged by check) — t2 is a different person
    expect(stale.teachingAssignmentId).toBe(a1.id);
    const check = await ok(await api.get(`/timetable/timetables/${copy.id}/check`));
    expect(check.blocking.map((b: { type: string }) => b.type)).toEqual(['INVALID_ASSIGNMENT']);
    // re-scheduling the cell resolves the current teacher
    const fix = await ok<Entry>(
      await api.patch(`/timetable/entries/${stale.id}`, {
        version: stale.version,
        subject_offering_id: off.id,
        teacher_id: t2.id,
      }),
    );
    expect(fix.teacher.id).toBe(t2.id);
    expect(a2.id).toBeTruthy();
    for (const id of [src.id, copy.id]) await api.post(`/timetable/timetables/${id}/archive`, {});
  });

  it('remaps an ended assignment when the same teacher holds a new one', async () => {
    const t = await ok(
      await api.post('/teachers', { first_name: 'Again', last_name: uniq('F') }),
      201,
    );
    const subj = await ok(
      await api.post('/subjects', { code: uniq('RM').toUpperCase(), name: 'Remap' }),
      201,
    );
    const off = await ok(
      await api.post('/subject-offerings', {
        academic_year_id: FA.yearId,
        subject_id: subj.id,
        class_id: FA.classId,
      }),
      201,
    );
    const a1 = await ok(
      await api.post(`/teachers/${t.id}/assignments`, {
        subject_offering_id: off.id,
        start_date: daysAgo(20),
      }),
      201,
    );
    const src = await newDraft(api, FA);
    await lesson(api, src.id, FA, { day: 5, period: FA.p3, section: FA.s7A, offering: off.id });
    await ok(await api.post(`/teaching-assignments/${a1.id}/end`, {}));
    const a2 = await ok(
      await api.post(`/teachers/${t.id}/assignments`, { subject_offering_id: off.id }),
      201,
    );
    const copy = await ok<Tt>(await api.post(`/timetable/timetables/${src.id}/duplicate`, {}), 201);
    const [row] = await entriesOf(copy.id);
    expect(row!.teachingAssignmentId).toBe(a2.id);
    const audit = await h.deps.db
      .select()
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.aggregateId, copy.id), eq(outboxEvents.eventType, 'timetable.created')),
      );
    expect(JSON.stringify(audit[0]!.payload)).toContain('"assignments_remapped":1');
    for (const id of [src.id, copy.id]) await api.post(`/timetable/timetables/${id}/archive`, {});
  });
});

// ==================================================================================
describe('views', () => {
  let tt: Tt;
  let teacherUser: Awaited<ReturnType<Harness['acceptAndLogin']>>;
  let teacherId: string;
  let monday: string;
  beforeAll(async () => {
    // a fresh school-year state: archive whatever the lifecycle tests published
    for (const t of await ok<Tt[]>(
      await papi.get(`/timetable/timetables?academic_year_id=${FP.yearId}&page_size=100`),
    ))
      if (t.status !== 'ARCHIVED') await papi.post(`/timetable/timetables/${t.id}/archive`, {});
    tt = await newDraft(papi, FP, { name: 'Views' });
    const put = (section: string, cells: object[]) =>
      papi.put(`/timetable/timetables/${tt.id}/sections/${section}/grid`, { cells });
    const c = (day: number, period: string, offering: string, extra: object = {}) => ({
      day_of_week: day,
      period_id: period,
      subject_offering_id: offering,
      ...extra,
    });
    await ok(
      await put(FP.s7A, [
        c(1, FP.p1, FP.math7, { venue_id: FP.r1 }),
        c(1, FP.p2, FP.sci7, { venue_id: FP.lab }),
        c(2, FP.p1, FP.eng7),
      ]),
    );
    await ok(
      await put(FP.s7B, [
        c(1, FP.p2, FP.math7, { venue_id: FP.r1 }),
        c(1, FP.p1, FP.sci7),
        c(3, FP.p3, FP.eng7),
      ]),
    );
    await ok(await put(FP.s8A, [c(1, FP.p3, FP.math8, { venue_id: FP.r2 })]));
    // a teacher with a login: Maya (maths)
    const [tm] = await h.deps.db.select().from(teachers).where(eq(teachers.id, FP.tMath));
    teacherId = tm!.id;
    await ok(
      await papi.patch(`/teachers/${teacherId}`, {
        version: tm!.version,
        email: `${uniq('maya')}@school.test`,
      }),
    );
    const withEmail = (await ok(await papi.get(`/teachers/${teacherId}`))).email as string;
    await ok(
      await papi.post(`/teachers/${teacherId}/portal-access`, {
        role_id: await h.roleId(papi, 'TEACHER'),
      }),
      201,
    );
    teacherUser = await h.acceptAndLogin(withEmail);
    await ok(await papi.post(`/timetable/timetables/${tt.id}/publish`, {}));
    monday = onWeekday(1);
  });

  it('shows a section grid: days x periods with entries, breaks empty', async () => {
    const v = await ok(await papi.get(`/timetable/views/section/${FP.s7A}`));
    expect(v.timetable).toMatchObject({ id: tt.id, status: 'PUBLISHED' });
    expect(v.section).toMatchObject({ id: FP.s7A, name: 'Section A', class: { name: 'Grade7' } });
    expect(v.days.map((d: { day_of_week: number }) => d.day_of_week)).toEqual([1, 2, 3, 4, 5]);
    expect(v.periods.map((p: { code: string }) => p.code)).toEqual([
      'P1',
      'P2',
      'BRK',
      'P3',
      'P4',
      'LUN',
    ]);
    const p1 = v.periods[0];
    expect(p1).toMatchObject({ start_time: '08:00', end_time: '08:45', is_teaching: true });
    expect(p1.cells).toHaveLength(5);
    expect(p1.cells[0].entry).toMatchObject({
      day_of_week: 1,
      subject: { name: 'Mathematics' },
      venue: { code: 'R1' },
    });
    expect(p1.cells[1].entry.subject.name).toBe('English');
    expect(p1.cells[2].entry).toBeNull();
    expect(v.periods[2].is_teaching).toBe(false);
    expect(v.periods[2].cells.every((c: { entry: unknown }) => c.entry === null)).toBe(true);
    expect(v.summary.lessons_per_week).toBe(3);
    expect(v.summary.subjects.map((s: { subject: { name: string } }) => s.subject.name)).toEqual([
      'English',
      'Mathematics',
      'Science',
    ]);
    // explicit timetable id gives the same
    expect(
      (await ok(await papi.get(`/timetable/views/section/${FP.s7A}?timetable_id=${tt.id}`)))
        .timetable.id,
    ).toBe(tt.id);
    expect((await papi.get(`/timetable/views/section/${FB.s7A}`)).status).toBe(404);
  });

  it("shows a teacher's week across sections, a venue's week and the workload", async () => {
    const t = await ok(await papi.get(`/timetable/views/teacher/${FP.tMath}`));
    expect(t.teacher.id).toBe(FP.tMath);
    const entries = t.periods
      .flatMap((p: { cells: { entry: { section: { id: string } } | null }[] }) =>
        p.cells.map((c) => c.entry),
      )
      .filter(Boolean);
    expect(new Set(entries.map((e: { section: { id: string } }) => e.section.id))).toEqual(
      new Set([FP.s7A, FP.s7B, FP.s8A]),
    );
    expect(t.summary).toMatchObject({ lessons_per_week: 3, sections: 3 });
    expect(t.summary.by_day).toEqual([{ day_of_week: 1, lessons: 3 }]);
    const v = await ok(await papi.get(`/timetable/views/venue/${FP.r1}`));
    expect(v.venue).toMatchObject({ code: 'R1', capacity: 40 });
    expect(v.summary.lessons_per_week).toBe(2);
    expect(v.summary.lesson_slots_per_week).toBe(20);
    const w = await ok(await papi.get('/timetable/workload'));
    const maya = w.teachers.find((x: { teacher: { id: string } }) => x.teacher.id === FP.tMath);
    expect(maya).toMatchObject({ lessons_per_week: 3, sections: 3 });
    const idle = w.teachers.find((x: { teacher: { id: string } }) => x.teacher.id === FP.tNone);
    expect(idle.lessons_per_week).toBe(0);
    expect(w.teachers[0].lessons_per_week).toBeGreaterThanOrEqual(w.teachers[1].lessons_per_week);
    expect((await papi.get(`/timetable/views/teacher/${FB.tMath}`)).status).toBe(404);
    expect((await papi.get(`/timetable/views/venue/${FB.r1}`)).status).toBe(404);
  });

  it("gives a teacher their own timetable through the login link, and today's lessons", async () => {
    const me = await ok(await teacherUser.api.get('/timetable/views/me'));
    expect(me.teacher.id).toBe(teacherId);
    expect(me.summary.lessons_per_week).toBe(3);
    const today = await ok(await teacherUser.api.get(`/timetable/views/me/today?date=${monday}`));
    expect(today).toMatchObject({
      date: monday,
      day_of_week: 1,
      day_name: 'Monday',
      is_working_day: true,
      teacher_id: teacherId,
    });
    const lessons = today.periods.flatMap((p: { entries: unknown[] }) => p.entries);
    expect(lessons).toHaveLength(3);
    expect(today.periods.find((p: { code: string }) => p.code === 'BRK').entries).toEqual([]);
    const sunday = await ok(
      await teacherUser.api.get(`/timetable/views/me/today?date=${onWeekday(7)}`),
    );
    expect(sunday.is_working_day).toBe(false);
    expect(sunday.periods.flatMap((p: { entries: unknown[] }) => p.entries)).toEqual([]);
    // the admin has no teacher record linked to their login
    const none = await papi.get('/timetable/views/me');
    expect(none.status).toBe(404);
  });

  it("shows the school's day, filterable, from the version effective on that date", async () => {
    const day = await ok(await papi.get(`/timetable/views/today?date=${monday}`));
    expect(day.timetable.id).toBe(tt.id);
    expect(day.periods.flatMap((p: { entries: unknown[] }) => p.entries)).toHaveLength(5);
    const onlyB = await ok(
      await papi.get(`/timetable/views/today?date=${monday}&section_id=${FP.s7B}`),
    );
    expect(onlyB.periods.flatMap((p: { entries: unknown[] }) => p.entries)).toHaveLength(2);
    const byVenue = await ok(
      await papi.get(`/timetable/views/today?date=${monday}&venue_id=${FP.lab}`),
    );
    expect(byVenue.periods.flatMap((p: { entries: unknown[] }) => p.entries)).toHaveLength(1);
    // a date before the version took effect has no timetable
    const before = await ok(await papi.get(`/timetable/views/today?date=${daysAgo(30)}`));
    expect(before.timetable).toBeNull();
    // history: publish a new version from later on; the old one still answers for earlier dates
    const v2 = await ok<Tt>(await papi.post(`/timetable/timetables/${tt.id}/duplicate`, {}), 201);
    await ok(
      await papi.put(`/timetable/timetables/${v2.id}/sections/${FP.s8A}/grid`, {
        cells: [{ day_of_week: 2, period_id: FP.p1, subject_offering_id: FP.math8 }],
      }),
    );
    const later = onWeekday(1, 10);
    await ok(await papi.post(`/timetable/timetables/${v2.id}/publish`, { effective_from: later }));
    const stillOld = await ok(await papi.get(`/timetable/views/today?date=${monday}`));
    expect(stillOld.timetable.id).toBe(tt.id);
    const newer = await ok(await papi.get(`/timetable/views/today?date=${later}`));
    expect(newer.timetable.id).toBe(v2.id);
    expect((await ok(await papi.get(`/timetable/views/section/${FP.s8A}`))).timetable.id).toBe(
      v2.id,
    ); // default = published
    expect(
      (await ok(await papi.get(`/timetable/views/section/${FP.s8A}?timetable_id=${tt.id}`)))
        .timetable.id,
    ).toBe(tt.id);
  });

  it('answers with an empty grid, not an error, when nothing is published yet', async () => {
    const fresh = await h.provisionSchool();
    const fx = await buildFixture(fresh.admin.api, 'F');
    const v = await ok(await fresh.admin.api.get(`/timetable/views/section/${fx.s7A}`));
    expect(v.timetable).toBeNull();
    expect(v.periods.length).toBe(6);
    expect(v.summary.lessons_per_week).toBe(0);
    const day = await ok(await fresh.admin.api.get('/timetable/views/today'));
    expect(day.timetable).toBeNull();
  });
});

// ==================================================================================
describe('scope, permissions and features', () => {
  let tt: Tt;
  let scoped: Awaited<ReturnType<Harness['addMember']>>;
  let teacherOnly: Awaited<ReturnType<Harness['addMember']>>;
  let reception: Awaited<ReturnType<Harness['addMember']>>;
  beforeAll(async () => {
    for (const t of await ok<Tt[]>(
      await papi.get(`/timetable/timetables?academic_year_id=${FP.yearId}&page_size=100`),
    ))
      if (t.status !== 'ARCHIVED') await papi.post(`/timetable/timetables/${t.id}/archive`, {});
    tt = await newDraft(papi, FP, { name: 'Scope' });
    const put = (section: string, cells: object[]) =>
      papi.put(`/timetable/timetables/${tt.id}/sections/${section}/grid`, { cells });
    const c = (day: number, period: string, offering: string) => ({
      day_of_week: day,
      period_id: period,
      subject_offering_id: offering,
    });
    await ok(await put(FP.s7A, [c(1, FP.p1, FP.math7), c(1, FP.p2, FP.sci7)]));
    await ok(await put(FP.s7B, [c(2, FP.p1, FP.math7), c(2, FP.p2, FP.eng7)]));
    await ok(await put(FP.s8A, [c(3, FP.p1, FP.math8)]));
    scoped = await h.addMember(papi, [
      {
        role_id: await h.scopableRole(papi, 'PRINCIPAL'),
        scope_type: 'ASSIGNED_SECTION',
        scope_ref: { section_ids: [FP.s7A] },
      },
    ]);
    teacherOnly = await h.addMember(papi, [{ role_id: await h.roleId(papi, 'TEACHER') }]);
    reception = await h.addMember(papi, [{ role_id: await h.roleId(papi, 'RECEPTIONIST') }]);
  });

  it('narrows reads to the assigned sections; others behave as missing', async () => {
    const s = scoped.api;
    // the draft is visible to a manager, even a section-scoped one
    expect((await s.get(`/timetable/views/section/${FP.s7B}?timetable_id=${tt.id}`)).status).toBe(
      404,
    );
    expect((await s.get(`/timetable/views/section/${FP.s8A}?timetable_id=${tt.id}`)).status).toBe(
      404,
    );
    const own = await ok(await s.get(`/timetable/views/section/${FP.s7A}?timetable_id=${tt.id}`));
    expect(own.summary.lessons_per_week).toBe(2);
    // the teacher's grid only holds the entries of sections in scope
    const t = await ok(await s.get(`/timetable/views/teacher/${FP.tMath}?timetable_id=${tt.id}`));
    expect(t.summary.lessons_per_week).toBe(1);
    const list = await s.get(`/timetable/timetables/${tt.id}/entries?page_size=500`);
    expect(new Set(list.body.data.map((e: Entry) => e.section.id))).toEqual(new Set([FP.s7A]));
    expect(list.body.meta.total).toBe(2);
    const foreign = (await papi.get(`/timetable/timetables/${tt.id}/entries?section_id=${FP.s7B}`))
      .body.data[0] as Entry;
    expect((await s.get(`/timetable/entries/${foreign.id}`)).status).toBe(404);
    const csv = await s.get(`/timetable/timetables/${tt.id}/export`);
    expect(csv.status).toBe(200);
    expect(csv.text.trim().split(/\r?\n/)).toHaveLength(3); // header + two lessons of 7A
  });

  it('a section-scoped editor cannot touch other sections and cannot run whole-timetable commands', async () => {
    const s = scoped.api;
    const foreign = (await papi.get(`/timetable/timetables/${tt.id}/entries?section_id=${FP.s7B}`))
      .body.data[0] as Entry;
    expect(
      (
        await s.patch(`/timetable/entries/${foreign.id}`, {
          version: foreign.version,
          venue_id: FP.r1,
        })
      ).status,
    ).toBe(404);
    expect((await s.delete(`/timetable/entries/${foreign.id}`)).status).toBe(404);
    expect(
      (
        await addEntry(s, tt.id, {
          day_of_week: 4,
          period_id: FP.p1,
          section_id: FP.s7B,
          subject_offering_id: FP.math7,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await s.put(`/timetable/timetables/${tt.id}/sections/${FP.s7B}/grid`, {
          cells: [{ day_of_week: 4, period_id: FP.p1, subject_offering_id: FP.math7 }],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await addEntry(s, tt.id, {
          day_of_week: 4,
          period_id: FP.p1,
          section_id: FP.s7A,
          subject_offering_id: FP.math7,
        })
      ).status,
    ).toBe(201);
    for (const res of [
      await s.post('/timetable/timetables', { academic_year_id: FP.yearId, name: 'x' }),
      await s.post(`/timetable/timetables/${tt.id}/publish`, {}),
      await s.post(`/timetable/timetables/${tt.id}/archive`, {}),
      await s.get(`/timetable/timetables/${tt.id}/check`),
      await s.get('/timetable/workload'),
    ]) {
      expect(res.status).toBe(403);
      expect(code(res)).toBe('PERMISSION_DENIED');
    }
    expect((await entriesOf(tt.id)).some((e) => e.sectionId === FP.s7B && e.dayOfWeek === 4)).toBe(
      false,
    );
  });

  it('denies what the role lacks and hides drafts from read-only users', async () => {
    const t = teacherOnly.api;
    for (const res of [
      await t.post('/timetable/periods', {
        code: 'NOPE',
        name: 'x',
        start_time: '05:00',
        end_time: '05:10',
      }),
      await t.post('/timetable/venues', { code: 'NOPE', name: 'x' }),
      await t.post('/timetable/timetables', { academic_year_id: FP.yearId, name: 'x' }),
      await addEntry(t, tt.id, {
        day_of_week: 4,
        period_id: FP.p1,
        section_id: FP.s7A,
        subject_offering_id: FP.math7,
      }),
      await t.put(`/timetable/timetables/${tt.id}/sections/${FP.s7A}/grid`, { cells: [] }),
      await t.post(`/timetable/timetables/${tt.id}/publish`, {}),
      await t.patch('/timetable/settings', { version: 1, working_days: [1] }),
      await t.get(`/timetable/timetables/${tt.id}/export`),
    ]) {
      expect(res.status).toBe(403);
      expect(code(res)).toBe('PERMISSION_DENIED');
    }
    // read is allowed, but a draft is invisible: 404 by id, absent from lists
    expect((await t.get('/timetable/periods')).status).toBe(200);
    expect((await t.get(`/timetable/timetables/${tt.id}`)).status).toBe(404);
    expect((await t.get(`/timetable/timetables/${tt.id}/entries`)).status).toBe(404);
    expect((await t.get(`/timetable/views/section/${FP.s7A}?timetable_id=${tt.id}`)).status).toBe(
      404,
    );
    const list = await t.get('/timetable/timetables');
    expect(list.body.data.some((x: Tt) => x.id === tt.id)).toBe(false);
    const r = reception.api;
    for (const path of [
      '/timetable/periods',
      '/timetable/venues',
      '/timetable/settings',
      '/timetable/timetables',
      `/timetable/views/section/${FP.s7A}`,
      '/timetable/workload',
    ]) {
      const res = await r.get(path);
      expect(res.status, path).toBe(403);
      expect(code(res)).toBe('PERMISSION_DENIED');
    }
  });

  it('published versions are readable by a teacher, and only exportable with the export permission', async () => {
    await ok(await papi.post(`/timetable/timetables/${tt.id}/publish`, {}));
    const t = teacherOnly.api;
    const v = await ok(await t.get(`/timetable/views/section/${FP.s7A}`));
    expect(v.summary.lessons_per_week).toBe(3);
    expect((await t.get(`/timetable/timetables/${tt.id}`)).status).toBe(200);
    expect((await t.get(`/timetable/timetables/${tt.id}/export`)).status).toBe(403);
    expect((await papi.get(`/timetable/timetables/${tt.id}/export`)).status).toBe(200);
    // read-only users get the whole-timetable reports too (school-wide read)
    expect((await t.get('/timetable/workload')).status).toBe(200);
    // the day view is narrowed to the scoped user's sections as well
    type Day = { periods: { entries: unknown[] }[] };
    const lessons = (d: Day) => d.periods.flatMap((p) => p.entries);
    const tue = await ok<Day>(await scoped.api.get(`/timetable/views/today?date=${onWeekday(2)}`));
    expect(lessons(tue)).toHaveLength(0);
    const mon = await ok<Day>(await scoped.api.get(`/timetable/views/today?date=${onWeekday(1)}`));
    expect(lessons(mon)).toHaveLength(2);
    expect(
      lessons(await ok<Day>(await t.get(`/timetable/views/today?date=${onWeekday(2)}`))),
    ).toHaveLength(2);
  });

  it('a school without the timetable feature gets FEATURE_NOT_ENABLED everywhere', async () => {
    const starter = await h.provisionSchool({ plan: 'STARTER' });
    const s = starter.admin.api;
    const dummy = '019a0000-0000-7000-8000-000000000000';
    for (const [method, path] of [
      ['get', '/timetable/settings'],
      ['get', '/timetable/periods'],
      ['post', '/timetable/periods'],
      ['get', '/timetable/venues'],
      ['get', '/timetable/timetables'],
      ['post', '/timetable/timetables'],
      ['get', `/timetable/timetables/${dummy}`],
      ['post', `/timetable/timetables/${dummy}/publish`],
      ['get', `/timetable/timetables/${dummy}/export`],
      ['get', `/timetable/views/section/${dummy}`],
      ['get', '/timetable/views/me'],
      ['get', '/timetable/workload'],
      ['get', `/timetable/entries/${dummy}`],
    ] as const) {
      const res = method === 'get' ? await s.get(path) : await s.post(path, {});
      expect([res.status, code(res)], `${method} ${path}`).toEqual([403, 'FEATURE_NOT_ENABLED']);
    }
  });
});

// ==================================================================================
describe('tenant isolation', () => {
  it("never shows or changes another school's data", async () => {
    const b = B.admin.api;
    const ttA = await newDraft(api, FA);
    const e = await lesson(api, ttA.id, FA, { day: 1, period: FA.p1, section: FA.s7A });
    for (const path of [
      `/timetable/timetables/${ttA.id}`,
      `/timetable/timetables/${ttA.id}/entries`,
      `/timetable/timetables/${ttA.id}/check`,
      `/timetable/timetables/${ttA.id}/export`,
      `/timetable/entries/${e.id}`,
      `/timetable/periods/${FA.p1}`,
      `/timetable/venues/${FA.r1}`,
      `/timetable/views/section/${FA.s7A}?timetable_id=${ttA.id}`,
      `/timetable/views/teacher/${FA.tMath}`,
      `/timetable/views/venue/${FA.r1}`,
      `/timetable/workload?timetable_id=${ttA.id}`,
    ]) {
      const res = await b.get(path);
      expect(res.status, path).toBe(404);
      expect(code(res)).toBe('RESOURCE_NOT_FOUND');
    }
    expect(
      (await b.patch(`/timetable/entries/${e.id}`, { version: 1, venue_id: null })).status,
    ).toBe(404);
    expect((await b.delete(`/timetable/entries/${e.id}`)).status).toBe(404);
    expect((await b.post(`/timetable/timetables/${ttA.id}/publish`, {})).status).toBe(404);
    expect((await b.post(`/timetable/timetables/${ttA.id}/archive`, {})).status).toBe(404);
    expect((await b.post(`/timetable/timetables/${ttA.id}/duplicate`, {})).status).toBe(404);
    expect(
      (await b.patch(`/timetable/timetables/${ttA.id}`, { version: 1, name: 'x' })).status,
    ).toBe(404);
    expect((await b.patch(`/timetable/periods/${FA.p1}`, { version: 1, name: 'x' })).status).toBe(
      404,
    );
    expect((await b.post(`/timetable/periods/${FA.p1}/deactivate`)).status).toBe(404);
    expect((await b.delete(`/timetable/venues/${FA.r1}`)).status).toBe(404);
    expect(
      (
        await b.post('/timetable/timetables', {
          academic_year_id: FA.yearId,
          name: 'x',
          copy_from_id: ttA.id,
        })
      ).status,
    ).toBe(404);
    // lists only hold the caller's rows
    const mine = await b.get('/timetable/timetables?page_size=100');
    expect(
      mine.body.data.every(
        (t: { academic_year: { id: string } }) => t.academic_year.id === FB.yearId,
      ),
    ).toBe(true);
    const periods = await ok<{ id: string }[]>(await b.get('/timetable/periods'));
    expect(periods.some((p) => p.id === FA.p1)).toBe(false);
    const venues = await b.get('/timetable/venues?page_size=100');
    expect(venues.body.data.some((v: { id: string }) => v.id === FA.r1)).toBe(false);
    // the same code can exist in both schools
    expect(FB.p1).not.toBe(FA.p1);
    await api.post(`/timetable/timetables/${ttA.id}/archive`, {});
  });
});

// ==================================================================================
describe('export', () => {
  it('exports CSV, neutralises spreadsheet formulas and records an audit row and event', async () => {
    const tt = await newDraft(api, FA);
    const v = await ok(
      await api.post('/timetable/venues', {
        code: uniq('EV').toUpperCase(),
        name: '=HYPERLINK("http://evil","x")',
        capacity: 30,
      }),
      201,
    );
    await lesson(api, tt.id, FA, { day: 2, period: FA.p4, section: FA.s7A, venue: v.id });
    const res = await api.get(`/timetable/timetables/${tt.id}/export`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="timetable-v\d+\.csv"/,
    );
    const lines = res.text.trim().split(/\r?\n/);
    expect(lines[0]).toBe(
      'Day,Period,Start,End,Class,Section,Subject code,Subject,Teacher number,Teacher,Venue',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Tuesday,Period 4,10:30,11:15,Grade7,Section A');
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(lines[1]).not.toMatch(/,=HYPERLINK/);
    const audit = await h.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, tt.id), eq(auditLogs.action, 'TIMETABLE_EXPORTED')));
    expect(audit).toHaveLength(1);
    const ev = await h.deps.db
      .select()
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.aggregateId, tt.id), eq(outboxEvents.eventType, 'timetable.exported')),
      );
    expect(ev).toHaveLength(1);
    const filtered = await api.get(`/timetable/timetables/${tt.id}/export?section_id=${FA.s7B}`);
    expect(filtered.text.trim().split(/\r?\n/)).toHaveLength(1);
    await api.post(`/timetable/timetables/${tt.id}/archive`, {});
  });
});

// ==================================================================================
describe('audit and events', () => {
  it('records every mutation with one audit row and one outbox event, in the same transaction', async () => {
    const db = h.deps.db;
    const tt = await newDraft(api, FA);
    const e = await lesson(api, tt.id, FA, {
      day: 4,
      period: FA.p1,
      section: FA.s7A,
      venue: FA.r1,
    });
    await ok(await api.patch(`/timetable/entries/${e.id}`, { version: 1, venue_id: FA.r2 }));
    const g = await ok(
      await api.put(`/timetable/timetables/${tt.id}/sections/${FA.s7B}/grid`, {
        cells: [
          { day_of_week: 4, period_id: FA.p2, subject_offering_id: FA.math7 },
          { day_of_week: 4, period_id: FA.p3, subject_offering_id: FA.sci7 },
          { day_of_week: 4, period_id: FA.p4, subject_offering_id: FA.eng7 },
        ],
      }),
    );
    expect(g.created).toBe(3);
    await ok(
      await api.delete(`/timetable/entries/${e.id}`).then((r) => ({ ...r, body: { data: 1 } })),
      204,
    );
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.tenantId, A.tenantId), like(auditLogs.action, 'TIMETABLE_%')));
    const forTt = (id: string, action: string) =>
      audit.filter((r) => r.entityId === id && r.action === action);
    expect(forTt(tt.id, 'TIMETABLE_CREATED')).toHaveLength(1);
    expect(forTt(e.id, 'TIMETABLE_ENTRY_CREATED')).toHaveLength(1);
    expect(forTt(e.id, 'TIMETABLE_ENTRY_UPDATED')).toHaveLength(1);
    expect(forTt(e.id, 'TIMETABLE_ENTRY_DELETED')).toHaveLength(1);
    // a grid save is ONE audit row and ONE event with counts, not one per cell
    const grid = forTt(tt.id, 'TIMETABLE_GRID_SAVED');
    expect(grid).toHaveLength(1);
    expect(JSON.stringify(grid[0]!.after)).toContain('"created":3');
    const events = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, A.tenantId), eq(outboxEvents.aggregateId, tt.id)));
    const gridEvents = events.filter((x) => x.eventType === 'timetable.grid_saved');
    expect(gridEvents).toHaveLength(1);
    expect(gridEvents[0]!.payload).toMatchObject({
      timetable_id: tt.id,
      section_id: FA.s7B,
      created: 3,
      updated: 0,
      deleted: 0,
    });
    const entryEvents = await db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, A.tenantId), eq(outboxEvents.aggregateId, e.id)));
    expect(entryEvents.map((x) => x.eventType).sort()).toEqual([
      'timetable_entry.created',
      'timetable_entry.deleted',
      'timetable_entry.updated',
    ]);
    // a rejected request leaves no trace
    const before = (await db.select().from(auditLogs).where(eq(auditLogs.tenantId, A.tenantId)))
      .length;
    expect(
      (
        await addEntry(api, tt.id, {
          day_of_week: 4,
          period_id: FA.p2,
          section_id: FA.s7B,
          subject_offering_id: FA.sci7,
        })
      ).status,
    ).toBe(409);
    expect(
      (await db.select().from(auditLogs).where(eq(auditLogs.tenantId, A.tenantId))).length,
    ).toBe(before);
    // configuration changes are audited too
    const cfg = audit.map((r) => r.action);
    expect(cfg).toEqual(
      expect.arrayContaining([
        'TIMETABLE_PERIOD_CREATED',
        'TIMETABLE_VENUE_CREATED',
        'TIMETABLE_SETTINGS_UPDATED',
      ]),
    );
    await api.post(`/timetable/timetables/${tt.id}/archive`, {});
  });
});

// ==================================================================================
describe('periods per class and section', () => {
  it('gives a class its own school day, separate from the school default', async () => {
    const school = await ok<Json[]>(await api.get('/timetable/periods'));
    expect(school.length).toBeGreaterThan(0);
    expect(school.every((p) => p.scope === 'SCHOOL')).toBe(true);
    // before it has its own periods, class 2 uses the school's
    const before = await ok<Json[]>(await api.get(`/timetable/periods?class_id=${FA.class2Id}`));
    expect(before.map((p) => p.id).sort()).toEqual(school.map((p) => p.id).sort());

    const mine = await ok<Json>(
      await api.post('/timetable/periods', {
        code: 'c8p1',
        name: 'Class 2 first',
        start_time: '08:00',
        end_time: '08:45',
        class_id: FA.class2Id,
      }),
      201,
    );
    expect(mine).toMatchObject({ scope: 'CLASS', class_id: FA.class2Id, section_id: null });
    const after = await ok<Json[]>(await api.get(`/timetable/periods?class_id=${FA.class2Id}`));
    expect(after.map((p) => p.id)).toEqual([mine.id]);
    // the section of that class follows its class
    const viaSection = await ok<Json[]>(await api.get(`/timetable/periods?section_id=${FA.s8A}`));
    expect(viaSection.map((p) => p.id)).toEqual([mine.id]);
    // another class and the default list are untouched
    const other = await ok<Json[]>(await api.get(`/timetable/periods?class_id=${FA.classId}`));
    expect(other.some((p) => p.id === mine.id)).toBe(false);
    const def = await ok<Json[]>(await api.get('/timetable/periods'));
    expect(def.some((p) => p.id === mine.id)).toBe(false);

    // overlaps are checked inside the class only; the same time as the school's is fine
    const clash = await api.post('/timetable/periods', {
      code: 'C8P2',
      name: 'Clash',
      start_time: '08:30',
      end_time: '09:00',
      class_id: FA.class2Id,
    });
    expect(clash.status).toBe(422);
    expect(clash.body.error.details.reason).toBe('PERIOD_OVERLAP');
  });

  it('lets one section override its class, and validates the class and section', async () => {
    const secOwn = await ok<Json>(
      await api.post('/timetable/periods', {
        code: 'S8A1',
        name: 'Section first',
        start_time: '09:00',
        end_time: '09:30',
        section_id: FA.s8A,
      }),
      201,
    );
    expect(secOwn).toMatchObject({ scope: 'SECTION', section_id: FA.s8A, class_id: FA.class2Id });
    const list = await ok<Json[]>(await api.get(`/timetable/periods?section_id=${FA.s8A}`));
    expect(list.map((p) => p.id)).toEqual([secOwn.id]);
    const classList = await ok<Json[]>(await api.get(`/timetable/periods?class_id=${FA.class2Id}`));
    expect(classList.map((p) => p.code)).toEqual(['C8P1']);

    const mismatch = await api.post('/timetable/periods', {
      code: 'BAD1',
      name: 'Wrong class',
      start_time: '10:00',
      end_time: '10:30',
      class_id: FA.classId,
      section_id: FA.s8A,
    });
    expect(mismatch.status).toBe(422);
    const missing = await api.post('/timetable/periods', {
      code: 'BAD2',
      name: 'No class',
      start_time: '10:00',
      end_time: '10:30',
      class_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(missing.status).toBe(404);
  });

  it('only schedules a section in the periods of its own school day', async () => {
    const tt = await newDraft(api, FA);
    const own = (await ok<Json[]>(await api.get(`/timetable/periods?section_id=${FA.s8A}`)))[0]!;
    // 8A now has its own period, so the school's P1 is not part of its day
    const outside = await addEntry(api, tt.id, {
      day_of_week: 1,
      period_id: FA.p1,
      section_id: FA.s8A,
      subject_offering_id: FA.math8,
    });
    expect(outside.status).toBe(422);
    expect(outside.body.error.details.reason).toBe('PERIOD_NOT_IN_SCHEDULE');
    // a section with nothing of its own still uses the school's periods
    const school = await addEntry(api, tt.id, {
      day_of_week: 1,
      period_id: FA.p3,
      section_id: FA.s7B,
      subject_offering_id: FA.eng7,
    });
    expect(school.status).toBe(201);
    // the section grid view shows its own periods only
    const view = await ok<{ periods: { id: string }[] }>(
      await api.get(`/timetable/views/section/${FA.s8A}?timetable_id=${tt.id}`),
    );
    expect(view.periods.map((p) => p.id)).toEqual([own.id]);
    await api.post(`/timetable/timetables/${tt.id}/archive`, {});
  });
});

// ==================================================================================
describe('school day and custom periods', () => {
  it('saves the school day with the settings and accepts a custom period', async () => {
    const s = await ok<Json>(await api.get('/timetable/settings'));
    expect(s.school_day_start).toBeNull();
    const saved = await ok<Json>(
      await api.patch('/timetable/settings', {
        version: s.version,
        school_day_start: '08:00',
        school_day_end: '15:30',
      }),
    );
    expect(saved).toMatchObject({ school_day_start: '08:00', school_day_end: '15:30' });
    expect(saved.working_days).toEqual(s.working_days);
    const bad = await api.patch('/timetable/settings', {
      version: saved.version,
      school_day_start: '16:00',
      school_day_end: '09:00',
    });
    expect(bad.status).toBe(422);
    const custom = await ok<Json>(
      await api.post('/timetable/periods', {
        code: 'SPORT1',
        name: 'Sports',
        start_time: '20:00',
        end_time: '20:30',
        kind: 'CUSTOM',
      }),
      201,
    );
    expect(custom).toMatchObject({ kind: 'CUSTOM', is_teaching: false });
  });
});
