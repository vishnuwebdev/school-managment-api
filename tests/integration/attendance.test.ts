import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attendanceCorrections,
  attendanceRecords,
  attendanceSessions,
  attendanceSettings,
  attendanceStatuses,
  auditLogs,
  outboxEvents,
} from '../../src/db/schema/index.js';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>; // STANDARD: attendance, no attendance.subject
let B: Awaited<ReturnType<Harness['provisionSchool']>>; // another school
let C: Awaited<ReturnType<Harness['provisionSchool']>>; // approval workflow toggled here
let P: Awaited<ReturnType<Harness['provisionSchool']>>; // PREMIUM: attendance.subject
let R: Awaited<ReturnType<Harness['provisionSchool']>>; // reports fixtures
let api: Api;

interface Structure {
  yearId: string;
  classId: string;
  class2Id: string;
}

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

/** The year spans ±~half a year around today so the suite does not age out. */
async function structure(a: Api, label: string): Promise<Structure> {
  const y = await a.post('/academic-years', {
    code: `Y-${label}`,
    name: `Year ${label}`,
    start_date: daysAgo(200),
    end_date: inDays(160),
  });
  expect(y.status, JSON.stringify(y.body)).toBe(201);
  const yearId = y.body.data.id as string;
  const act = await a.post(`/academic-years/${yearId}/activate`, { complete_current: true });
  expect(act.status, JSON.stringify(act.body)).toBe(200);
  const cls = async (c: string, seq: number) =>
    (await a.post('/academic-classes', { code: `${c}${label}`, name: c, sequence: seq })).body.data
      .id as string;
  return { yearId, classId: await cls('Grade7', 7), class2Id: await cls('Grade8', 8) };
}

async function newSection(a: Api, st: Structure, classId = st.classId, label = uniq('S')) {
  const res = await a.post(`/academic-years/${st.yearId}/sections`, {
    class_id: classId,
    code: label.toUpperCase().slice(0, 30),
    name: `Section ${label}`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

async function newStudent(
  a: Api,
  st: Structure,
  first: string,
  section?: string,
  start: string = daysAgo(60),
  last = uniq('Fam'),
) {
  const res = await a.post('/students', {
    first_name: first,
    last_name: last,
    gender: 'FEMALE',
    ...(section
      ? {
          enrollment: {
            academic_year_id: st.yearId,
            class_id: st.classId,
            section_id: section,
            start_date: start,
          },
        }
      : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string };
}

async function statusIds(a: Api): Promise<Record<string, string>> {
  const res = await a.get('/attendance/statuses');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return Object.fromEntries(res.body.data.map((s: { code: string; id: string }) => [s.code, s.id]));
}

async function open(a: Api, sectionId: string, date: string, extra: object = {}) {
  const res = await a.post('/attendance/sessions', {
    section_id: sectionId,
    session_date: date,
    ...extra,
  });
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  return res.body.data as Session;
}
interface RosterItem {
  student: { id: string; full_name: string };
  enrollment_id: string | null;
  on_roster: boolean;
  record: null | {
    id: string;
    status_code: string;
    status_id: string;
    remarks: string | null;
    version: number;
  };
}
interface Session {
  id: string;
  status: string;
  version: number;
  session_date: string;
  rejection_reason: string | null;
  reopened_at: string | null;
  summary: {
    roster_size: number;
    marked_count: number;
    unmarked_count: number;
    counts: Record<string, number>;
    present_units: number;
    absent_units: number;
  };
  roster: RosterItem[];
}
const rosterIds = (s: Session) => s.roster.map((r) => r.student.id);
const getSession = async (a: Api, id: string) =>
  (await a.get(`/attendance/sessions/${id}`)).body.data as Session;
const mark = (a: Api, id: string, records: object[], extra: object = {}) =>
  a.put(`/attendance/sessions/${id}/records`, { records, ...extra });
const cmd = (a: Api, id: string, c: string, body: object = {}) =>
  a.post(`/attendance/sessions/${id}/${c}`, body);

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

let SA: Structure;
let SB: Structure;
let SC: Structure;
let SP: Structure;
let SR: Structure;
let ST: Record<string, string>; // school A status ids
let teacherA: Awaited<ReturnType<Harness['addMember']>>;

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  B = await h.provisionSchool();
  C = await h.provisionSchool();
  P = await h.provisionSchool({ plan: 'PREMIUM' });
  R = await h.provisionSchool();
  api = A.admin.api;
  SA = await structure(api, 'A');
  SB = await structure(B.admin.api, 'B');
  SC = await structure(C.admin.api, 'C');
  SP = await structure(P.admin.api, 'P');
  SR = await structure(R.admin.api, 'R');
  ST = await statusIds(api);
  teacherA = await h.addMember(api, [{ role_id: await h.roleId(api, 'TEACHER') }]);
});
afterAll(() => h.close());

// ==================================================================================
describe('statuses and settings', () => {
  it('creates the six built-in statuses and the settings row lazily, once, even under concurrency', async () => {
    const D = await h.provisionSchool();
    const before = await h.deps.db
      .select({ n: count() })
      .from(attendanceStatuses)
      .where(eq(attendanceStatuses.tenantId, D.tenantId));
    expect(before[0]!.n).toBe(0); // not created at provisioning
    const results = await Promise.all(
      Array.from({ length: 6 }, () => D.admin.api.get('/attendance/statuses')),
    );
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    const list = results[0]!.body.data as {
      code: string;
      category: string;
      counts_as_present: number;
      counts_as_absent: number;
      requires_reason: boolean;
      is_system: boolean;
      status: string;
    }[];
    expect(list.map((s) => s.code)).toEqual([
      'PRESENT',
      'ABSENT',
      'LATE',
      'HALF_DAY',
      'EXCUSED',
      'LEAVE',
    ]);
    const by = Object.fromEntries(list.map((s) => [s.code, s]));
    expect([by.PRESENT!.counts_as_present, by.PRESENT!.counts_as_absent]).toEqual([1, 0]);
    expect([by.ABSENT!.counts_as_present, by.ABSENT!.counts_as_absent]).toEqual([0, 1]);
    expect([by.HALF_DAY!.counts_as_present, by.HALF_DAY!.counts_as_absent]).toEqual([0.5, 0.5]);
    expect(by.LATE!.counts_as_present).toBe(1);
    expect(by.LEAVE!.requires_reason).toBe(true);
    expect(list.every((s) => s.is_system && s.status === 'ACTIVE')).toBe(true);
    const [rows, settings] = await Promise.all([
      h.deps.db
        .select({ n: count() })
        .from(attendanceStatuses)
        .where(eq(attendanceStatuses.tenantId, D.tenantId)),
      h.deps.db
        .select({ n: count() })
        .from(attendanceSettings)
        .where(eq(attendanceSettings.tenantId, D.tenantId)),
    ]);
    expect(rows[0]!.n).toBe(6);
    expect(settings[0]!.n).toBe(1);
    // idempotent afterwards
    await D.admin.api.get('/attendance/settings');
    expect(
      (
        await h.deps.db
          .select({ n: count() })
          .from(attendanceStatuses)
          .where(eq(attendanceStatuses.tenantId, D.tenantId))
      )[0]!.n,
    ).toBe(6);
  });

  it('first touch through a write path (open a session) also ensures the defaults', async () => {
    const D = await h.provisionSchool();
    const st = await structure(D.admin.api, 'D');
    const sec = await newSection(D.admin.api, st);
    const s = await D.admin.api.post('/attendance/sessions', {
      section_id: sec,
      session_date: daysAgo(1),
    });
    expect(s.status).toBe(201);
    expect(
      (
        await h.deps.db
          .select({ n: count() })
          .from(attendanceStatuses)
          .where(eq(attendanceStatuses.tenantId, D.tenantId))
      )[0]!.n,
    ).toBe(6);
  });

  it('reads settings, updates them with optimistic concurrency and audits the change', async () => {
    const D = await h.provisionSchool();
    const g = await D.admin.api.get('/attendance/settings');
    expect(g.body.data).toMatchObject({
      approval_required: false,
      correction_requires_approval: false,
      edit_window_days: 7,
      defaulter_threshold_percent: 75,
      late_counts_as_present: true,
      version: 1,
    });
    const upd = await D.admin.api.patch('/attendance/settings', {
      version: 1,
      edit_window_days: 14,
      defaulter_threshold_percent: 80.5,
      approval_required: true,
    });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.data).toMatchObject({
      edit_window_days: 14,
      defaulter_threshold_percent: 80.5,
      approval_required: true,
      version: 2,
    });
    const stale = await D.admin.api.patch('/attendance/settings', {
      version: 1,
      edit_window_days: 3,
    });
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe('CONFLICT');
    expect(
      (await D.admin.api.patch('/attendance/settings', { version: 2, edit_window_days: -1 }))
        .status,
    ).toBe(422);
    expect(
      (
        await D.admin.api.patch('/attendance/settings', {
          version: 2,
          defaulter_threshold_percent: 101,
        })
      ).status,
    ).toBe(422);
    const audit = await h.deps.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.tenantId, D.tenantId),
          eq(auditLogs.action, 'ATTENDANCE_SETTINGS_UPDATED'),
        ),
      );
    expect(audit).toHaveLength(1);
    const ev = await h.deps.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.tenantId, D.tenantId),
          eq(outboxEvents.eventType, 'attendance.settings_updated'),
        ),
      );
    expect(ev).toHaveLength(1);
    // A teacher can read but not change settings.
    const t = await h.addMember(D.admin.api, [{ role_id: await h.roleId(D.admin.api, 'TEACHER') }]);
    expect((await t.api.get('/attendance/settings')).status).toBe(200);
    expect(
      (await t.api.patch('/attendance/settings', { version: 2, edit_window_days: 1 })).status,
    ).toBe(403);
  });

  it('the LATE switch changes LATE definitions but never rewrites earlier marks', async () => {
    const D = await h.provisionSchool();
    const a = D.admin.api;
    const st = await structure(a, 'L');
    const sec = await newSection(a, st);
    const stu = await newStudent(a, st, 'Late', sec);
    const ids = await statusIds(a);
    const s1 = await open(a, sec, daysAgo(3));
    await mark(a, s1.id, [{ student_id: stu.id, status_id: ids.LATE }]);
    expect((await cmd(a, s1.id, 'submit')).status).toBe(200);
    const off = await a.patch('/attendance/settings', {
      version: 1,
      late_counts_as_present: false,
    });
    expect(off.status).toBe(200);
    const list = (await a.get('/attendance/statuses')).body.data as {
      code: string;
      counts_as_present: number;
    }[];
    expect(list.find((s) => s.code === 'LATE')!.counts_as_present).toBe(0);
    const s2 = await open(a, sec, daysAgo(2));
    await mark(a, s2.id, [{ student_id: stu.id, status_id: ids.LATE }]);
    await cmd(a, s2.id, 'submit');
    const hist = await a.get(`/students/${stu.id}/attendance`);
    // day 1 was marked while LATE counted as present (1), day 2 after the switch (0)
    expect(hist.body.data.summary).toMatchObject({
      marked_count: 2,
      present_units: 1,
      percentage: 50,
    });
  });

  it('manages custom statuses; built-ins are protected', async () => {
    const created = await api.post('/attendance/statuses', {
      code: 'sports',
      name: 'Sports event',
      category: 'EXCUSED',
      requires_reason: true,
      sort_order: 70,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const s = created.body.data;
    expect(s).toMatchObject({
      code: 'SPORTS',
      is_system: false,
      status: 'ACTIVE',
      counts_as_present: 1,
      counts_as_absent: 0,
    });
    const dup = await api.post('/attendance/statuses', {
      code: 'SPORTS',
      name: 'x',
      category: 'OTHER',
    });
    expect(dup.status).toBe(409);
    expect(code(dup)).toBe('DUPLICATE_RESOURCE');
    expect(
      (
        await api.post('/attendance/statuses', {
          code: 'BAD',
          name: 'x',
          category: 'OTHER',
          counts_as_present: 0.8,
          counts_as_absent: 0.5,
        })
      ).status,
    ).toBe(422);

    const upd = await api.patch(`/attendance/statuses/${s.id}`, {
      version: s.version,
      name: 'Sports / competition',
      counts_as_present: 0.75,
    });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.data).toMatchObject({
      name: 'Sports / competition',
      counts_as_present: 0.75,
      version: 2,
    });
    expect(
      (await api.patch(`/attendance/statuses/${s.id}`, { version: 1, name: 'stale' })).status,
    ).toBe(409);

    const off = await api.post(`/attendance/statuses/${s.id}/deactivate`);
    expect(off.body.data.status).toBe('INACTIVE');
    expect(code(await api.post(`/attendance/statuses/${s.id}/deactivate`))).toBe('INVALID_STATE');
    expect(
      (await api.get('/attendance/statuses?status=ACTIVE')).body.data.map(
        (x: { code: string }) => x.code,
      ),
    ).not.toContain('SPORTS');
    expect((await api.post(`/attendance/statuses/${s.id}/activate`)).body.data.status).toBe(
      'ACTIVE',
    );

    // built-ins: rename OK, semantics locked, never deactivated
    const present = (await api.get(`/attendance/statuses/${ST.PRESENT}`)).body.data;
    expect(code(await api.post(`/attendance/statuses/${ST.PRESENT}/deactivate`))).toBe(
      'OPERATION_NOT_ALLOWED',
    );
    expect(
      code(
        await api.patch(`/attendance/statuses/${ST.PRESENT}`, {
          version: present.version,
          counts_as_present: 0,
        }),
      ),
    ).toBe('OPERATION_NOT_ALLOWED');
    expect(
      (
        await api.patch(`/attendance/statuses/${ST.PRESENT}`, {
          version: present.version,
          name: 'Here',
          sort_order: 5,
        })
      ).status,
    ).toBe(200);
    await api.patch(`/attendance/statuses/${ST.PRESENT}`, {
      version: present.version + 1,
      name: 'Present',
    });

    // teachers cannot manage statuses; other schools cannot see them
    expect(
      (
        await teacherA.api.post('/attendance/statuses', {
          code: 'NOPE',
          name: 'x',
          category: 'OTHER',
        })
      ).status,
    ).toBe(403);
    expect((await B.admin.api.get(`/attendance/statuses/${s.id}`)).status).toBe(404);
    expect(
      (await B.admin.api.patch(`/attendance/statuses/${s.id}`, { version: 3, name: 'x' })).status,
    ).toBe(404);
    const audit = await h.deps.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.tenantId, A.tenantId));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'ATTENDANCE_STATUS_CREATED',
        'ATTENDANCE_STATUS_UPDATED',
        'ATTENDANCE_STATUS_DEACTIVATED',
        'ATTENDANCE_STATUS_ACTIVATED',
      ]),
    );
  });
});

// ==================================================================================
describe('opening sessions and the roster', () => {
  it('derives the roster from enrollments: effective dates, other sections, class changes', async () => {
    const secX = await newSection(api, SA);
    const secY = await newSection(api, SA);
    const sOld = await newStudent(api, SA, 'Old', secX, daysAgo(30));
    const sNew = await newStudent(api, SA, 'New', secX, daysAgo(1)); // joins yesterday
    const sOther = await newStudent(api, SA, 'Other', secY, daysAgo(30));
    const sMove = await newStudent(api, SA, 'Move', secX, daysAgo(30));
    const enr = (await api.get(`/students/${sMove.id}/enrollments`)).body.data[0].id as string;
    const ch = await api.post(`/enrollments/${enr}/change`, {
      section_id: secY,
      effective_date: daysAgo(3),
      reason: 'Section change',
    });
    expect(ch.status, JSON.stringify(ch.body)).toBe(200);

    const d5 = await open(api, secX, daysAgo(5));
    expect(rosterIds(d5)).toEqual(expect.arrayContaining([sOld.id, sMove.id]));
    expect(rosterIds(d5)).not.toContain(sNew.id); // not yet enrolled
    expect(rosterIds(d5)).not.toContain(sOther.id);
    expect(d5.summary).toMatchObject({ roster_size: 2, marked_count: 0, unmarked_count: 2 });

    // the day of the change belongs to the NEW section (end date is exclusive)
    const d3 = await open(api, secX, daysAgo(3));
    expect(rosterIds(d3)).toEqual([sOld.id]);
    const d1 = await open(api, secX, daysAgo(1));
    expect(rosterIds(d1).sort()).toEqual([sOld.id, sNew.id].sort());
    const y3 = await open(api, secY, daysAgo(3));
    expect(rosterIds(y3).sort()).toEqual([sOther.id, sMove.id].sort());
    expect(d1.roster.every((r) => r.enrollment_id && r.on_roster)).toBe(true);
    expect(d1).toMatchObject({ attendance_type: 'DAILY', status: 'DRAFT', section: { id: secX } });
  });

  it('open is idempotent: 201 first, 200 afterwards, same session', async () => {
    const sec = await newSection(api, SA);
    const first = await api.post('/attendance/sessions', {
      section_id: sec,
      session_date: daysAgo(2),
    });
    const second = await api.post('/attendance/sessions', {
      section_id: sec,
      session_date: daysAgo(2),
    });
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(first.body.meta.created).toBe(true);
    expect(second.body.meta.created).toBe(false);
    const events = await h.deps.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, first.body.data.id),
          eq(outboxEvents.eventType, 'attendance.session_opened'),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it('simultaneous opens create exactly one session', async () => {
    const sec = await newSection(api, SA);
    const res = await Promise.all(
      Array.from({ length: 8 }, () =>
        api.post('/attendance/sessions', { section_id: sec, session_date: daysAgo(4) }),
      ),
    );
    expect(
      res.every((r) => r.status === 200 || r.status === 201),
      JSON.stringify(res.map((r) => r.body)),
    ).toBe(true);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(res.map((r) => r.body.data.id)).size).toBe(1);
    const [n] = await h.deps.db
      .select({ n: count() })
      .from(attendanceSessions)
      .where(
        and(eq(attendanceSessions.tenantId, A.tenantId), eq(attendanceSessions.sectionId, sec)),
      );
    expect(n!.n).toBe(1);
  });

  it('rejects future dates, dates outside the year, unknown and foreign sections, inactive years', async () => {
    const sec = await newSection(api, SA);
    const future = await api.post('/attendance/sessions', {
      section_id: sec,
      session_date: inDays(3),
    });
    expect(future.status).toBe(422);
    expect(future.body.error.details.issues[0].path).toBe('session_date');
    const early = await api.post('/attendance/sessions', {
      section_id: sec,
      session_date: daysAgo(300),
    });
    expect(early.status).toBe(422);
    expect(early.body.error.details.issues[0].path).toBe('session_date');
    expect(
      (
        await api.post('/attendance/sessions', {
          section_id: '019a0000-0000-7000-8000-000000000000',
          session_date: daysAgo(1),
        })
      ).status,
    ).toBe(404);
    const secB = await newSection(B.admin.api, SB);
    expect(
      (await api.post('/attendance/sessions', { section_id: secB, session_date: daysAgo(1) }))
        .status,
    ).toBe(404);
    expect(
      (await api.post('/attendance/sessions', { section_id: sec, session_date: 'nope' })).status,
    ).toBe(422);
    // completing the year makes attendance INVALID_STATE
    const D = await h.provisionSchool();
    const st = await structure(D.admin.api, 'Z');
    const s2 = await newSection(D.admin.api, st);
    await D.admin.api.post(`/academic-years/${st.yearId}/complete`);
    const r = await D.admin.api.post('/attendance/sessions', {
      section_id: s2,
      session_date: daysAgo(1),
    });
    expect(r.status).toBe(422);
    expect(code(r)).toBe('INVALID_STATE');
  });

  it('SUBJECT sessions need the attendance.subject feature (permission alone is not enough)', async () => {
    const sec = await newSection(api, SA);
    const denied = await api.post('/attendance/sessions', {
      attendance_type: 'SUBJECT',
      section_id: sec,
      session_date: daysAgo(1),
      subject_offering_id: '019a0000-0000-7000-8000-000000000000',
    });
    expect(denied.status).toBe(403);
    expect(code(denied)).toBe('FEATURE_NOT_ENABLED');
    expect(denied.body.error.details.feature).toBe('attendance.subject');
    // DAILY sessions are unaffected
    expect(
      (await api.post('/attendance/sessions', { section_id: sec, session_date: daysAgo(1) }))
        .status,
    ).toBe(201);
  });

  it('SUBJECT sessions on a plan that has the feature: offering rules, periods, uniqueness, downgrade', async () => {
    const a = P.admin.api;
    const sec = await newSection(a, SP);
    const secOther = await newSection(a, SP);
    const subj = (await a.post('/subjects', { code: uniq('SUB').toUpperCase(), name: 'Maths' }))
      .body.data.id;
    const offWide = (
      await a.post('/subject-offerings', {
        academic_year_id: SP.yearId,
        subject_id: subj,
        class_id: SP.classId,
      })
    ).body.data.id as string;
    const subj2 = (await a.post('/subjects', { code: uniq('SUB').toUpperCase(), name: 'Science' }))
      .body.data.id;
    const offSec = (
      await a.post('/subject-offerings', {
        academic_year_id: SP.yearId,
        subject_id: subj2,
        class_id: SP.classId,
        section_id: sec,
      })
    ).body.data.id as string;
    const stu = await newStudent(a, SP, 'Pupil', sec);
    const body = (o: object) => ({
      attendance_type: 'SUBJECT',
      section_id: sec,
      session_date: daysAgo(1),
      subject_offering_id: offWide,
      ...o,
    });
    const p1 = await a.post('/attendance/sessions', body({ period_label: 'Period 1' }));
    expect(p1.status, JSON.stringify(p1.body)).toBe(201);
    expect(p1.body.data).toMatchObject({
      attendance_type: 'SUBJECT',
      period_label: 'Period 1',
      subject_offering: { id: offWide, subject: { name: 'Maths' } },
    });
    expect(rosterIds(p1.body.data)).toEqual([stu.id]);
    const again = await a.post('/attendance/sessions', body({ period_label: 'Period 1' }));
    expect([again.status, again.body.data.id]).toEqual([200, p1.body.data.id]);
    const p2 = await a.post('/attendance/sessions', body({ period_label: 'Period 2' }));
    expect(p2.status).toBe(201);
    expect(p2.body.data.id).not.toBe(p1.body.data.id);
    // a class-wide offering can be taken by another section of the class (own session)
    const other = await a.post(
      '/attendance/sessions',
      body({ section_id: secOther, period_label: 'Period 1' }),
    );
    expect(other.status).toBe(201);
    // a section-level offering only for its own section
    expect(
      code(
        await a.post(
          '/attendance/sessions',
          body({ section_id: secOther, subject_offering_id: offSec }),
        ),
      ),
    ).toBe('OPERATION_NOT_ALLOWED');
    // required / forbidden fields
    expect(
      (
        await a.post('/attendance/sessions', {
          attendance_type: 'SUBJECT',
          section_id: sec,
          session_date: daysAgo(1),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await a.post('/attendance/sessions', {
          section_id: sec,
          session_date: daysAgo(2),
          period_label: 'P1',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await a.post(
          '/attendance/sessions',
          body({ subject_offering_id: '019a0000-0000-7000-8000-000000000000', period_label: 'X' }),
        )
      ).status,
    ).toBe(404);
    // marking and submitting work like DAILY
    const ids = await statusIds(a);
    expect(
      (await mark(a, p1.body.data.id, [{ student_id: stu.id, status_id: ids.PRESENT }])).status,
    ).toBe(200);
    expect((await cmd(a, p1.body.data.id, 'submit')).body.data.status).toBe('FINAL');
    // SUBJECT sessions never count in DAILY reports
    expect((await a.get(`/students/${stu.id}/attendance`)).body.data.summary.marked_count).toBe(0);

    // list shows them; after the feature is denied they disappear and become 403
    const listed = await a.get(`/attendance/sessions?section_id=${sec}&attendance_type=SUBJECT`);
    expect(listed.body.meta.total).toBe(2);
    const deny = await P.root.put(
      `/platform/tenants/${P.tenantId}/entitlements/overrides/attendance.subject`,
      {
        effect: 'DENY',
        reason: 'Downgrade test',
      },
    );
    expect(deny.status, JSON.stringify(deny.body)).toBe(200);
    const blocked = await a.get(`/attendance/sessions/${p1.body.data.id}`);
    expect([blocked.status, code(blocked)]).toEqual([403, 'FEATURE_NOT_ENABLED']);
    expect(code(await cmd(a, p2.body.data.id, 'submit'))).toBe('FEATURE_NOT_ENABLED');
    expect((await a.get(`/attendance/sessions?section_id=${sec}`)).body.meta.total).toBe(0);
    await P.root.delete(
      `/platform/tenants/${P.tenantId}/entitlements/overrides/attendance.subject`,
      {
        reason: 'restore',
      },
    );
    expect((await a.get(`/attendance/sessions/${p1.body.data.id}`)).status).toBe(200);
  });

  it('lists sessions with counts and filters', async () => {
    const sec = await newSection(api, SA);
    const stu = await newStudent(api, SA, 'Lister', sec);
    const s = await open(api, sec, daysAgo(2));
    await mark(api, s.id, [{ student_id: stu.id, status_id: ST.ABSENT }]);
    const res = await api.get(`/attendance/sessions?section_id=${sec}`);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      id: s.id,
      status: 'DRAFT',
      marked_count: 1,
      counts: { absent: 1, present: 0 },
      section: { id: sec },
    });
    expect(
      (await api.get(`/attendance/sessions?section_id=${sec}&status=FINAL`)).body.meta.total,
    ).toBe(0);
    expect(
      (await api.get(`/attendance/sessions?section_id=${sec}&date_from=${daysAgo(1)}`)).body.meta
        .total,
    ).toBe(0);
    expect(
      (await api.get(`/attendance/sessions?section_id=${sec}&date_to=${daysAgo(2)}`)).body.meta
        .total,
    ).toBe(1);
  });
});

// ==================================================================================
describe('marking', () => {
  async function fixture(n = 3) {
    const sec = await newSection(api, SA);
    const stu = [];
    for (let i = 0; i < n; i++) stu.push(await newStudent(api, SA, `Kid${i}`, sec));
    const s = await open(api, sec, daysAgo(2));
    return { sec, stu, s };
  }

  it('bulk upserts marks, is idempotent, and only versions real changes', async () => {
    const { stu, s } = await fixture();
    const first = await mark(api, s.id, [
      { student_id: stu[0]!.id, status_id: ST.PRESENT },
      { student_id: stu[1]!.id, status_id: ST.ABSENT, remarks: '  fever  ' },
    ]);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.meta.saved).toEqual({ created: 2, updated: 0, unchanged: 0 });
    const d = first.body.data as Session;
    expect(d.version).toBe(s.version + 1);
    expect(d.summary).toMatchObject({
      marked_count: 2,
      unmarked_count: 1,
      present_units: 1,
      absent_units: 1,
    });
    expect(d.roster.find((r) => r.student.id === stu[1]!.id)!.record).toMatchObject({
      status_code: 'ABSENT',
      remarks: 'fever',
    });
    // retry of the same payload: nothing changes
    const retry = await mark(api, s.id, [
      { student_id: stu[0]!.id, status_id: ST.PRESENT },
      { student_id: stu[1]!.id, status_id: ST.ABSENT, remarks: 'fever' },
    ]);
    expect(retry.body.meta.saved).toEqual({ created: 0, updated: 0, unchanged: 2 });
    expect(retry.body.data.version).toBe(d.version);
    // change one, add one
    const third = await mark(api, s.id, [
      { student_id: stu[1]!.id, status_id: ST.LATE },
      { student_id: stu[2]!.id, status_id: ST.HALF_DAY },
    ]);
    expect(third.body.meta.saved).toEqual({ created: 1, updated: 1, unchanged: 0 });
    expect(third.body.data.summary).toMatchObject({
      marked_count: 3,
      unmarked_count: 0,
      present_units: 2.5,
      absent_units: 0.5,
    });
    // exactly one event per save that changed something; none for the retry
    const events = await h.deps.db
      .select()
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.aggregateId, s.id), eq(outboxEvents.eventType, 'attendance.recorded')),
      );
    expect(events).toHaveLength(2);
    expect(events[0]!.payload).toMatchObject({
      created: 2,
      updated: 0,
      unchanged: 0,
      attendance_session_id: s.id,
    });
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain('Kid'); // ids and counts only
    const audit = await h.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, s.id), eq(auditLogs.action, 'ATTENDANCE_RECORDED')));
    expect(audit).toHaveLength(2);
  });

  it('validates the whole payload and saves nothing when any row is wrong', async () => {
    const { sec, stu, s } = await fixture();
    const secOther = await newSection(api, SA);
    const outsider = await newStudent(api, SA, 'Outsider', secOther);
    const foreignSec = await newSection(B.admin.api, SB);
    const foreign = await newStudent(B.admin.api, SB, 'Foreign', foreignSec);
    const foreignStatus = (await statusIds(B.admin.api)).PRESENT;
    const custom = (
      await api.post('/attendance/statuses', {
        code: uniq('C').toUpperCase().replace(/-/g, '_').slice(0, 20),
        name: 'Custom',
        category: 'OTHER',
      })
    ).body.data;
    await api.post(`/attendance/statuses/${custom.id}/deactivate`);

    const issues = (res: {
      body: { error: { details: { issues: { path: string; code: string }[] } } };
    }) => res.body.error.details.issues.map((i) => `${i.path}:${i.code}`);
    // not on the roster (other section) → 422
    const r1 = await mark(api, s.id, [
      { student_id: stu[0]!.id, status_id: ST.PRESENT },
      { student_id: outsider.id, status_id: ST.PRESENT },
    ]);
    expect([r1.status, code(r1)]).toEqual([422, 'VALIDATION_ERROR']);
    expect(issues(r1)).toEqual(['records.1.student_id:not_on_roster']);
    // another school's student → indistinguishable from "not on the roster"
    const r2 = await mark(api, s.id, [{ student_id: foreign.id, status_id: ST.PRESENT }]);
    expect([r2.status, issues(r2)]).toEqual([422, ['records.0.student_id:not_on_roster']]);
    // random id
    expect(
      (
        await mark(api, s.id, [
          { student_id: '019a0000-0000-7000-8000-000000000001', status_id: ST.PRESENT },
        ])
      ).status,
    ).toBe(422);
    // duplicate rows in the payload
    const r3 = await mark(api, s.id, [
      { student_id: stu[0]!.id, status_id: ST.PRESENT },
      { student_id: stu[0]!.id, status_id: ST.ABSENT },
    ]);
    expect(r3.status).toBe(422);
    expect(issues(r3)).toEqual(['records.1.student_id:custom']);
    // status needing a reason
    const r4 = await mark(api, s.id, [{ student_id: stu[0]!.id, status_id: ST.LEAVE }]);
    expect(r4.status).toBe(422);
    expect(issues(r4)).toEqual(['records.0.remarks:custom']);
    expect(
      (await mark(api, s.id, [{ student_id: stu[0]!.id, status_id: ST.LEAVE, remarks: '   ' }]))
        .status,
    ).toBe(422);
    expect(
      (
        await mark(api, s.id, [
          { student_id: stu[0]!.id, status_id: ST.LEAVE, remarks: 'Family event' },
        ])
      ).status,
    ).toBe(200);
    // unknown, foreign and inactive statuses
    expect(
      (
        await mark(api, s.id, [
          { student_id: stu[1]!.id, status_id: '019a0000-0000-7000-8000-000000000002' },
        ])
      ).status,
    ).toBe(422);
    expect(
      (await mark(api, s.id, [{ student_id: stu[1]!.id, status_id: foreignStatus }])).status,
    ).toBe(422);
    const r5 = await mark(api, s.id, [{ student_id: stu[1]!.id, status_id: custom.id }]);
    expect(r5.status).toBe(422);
    expect(issues(r5)).toEqual(['records.0.status_id:custom']);
    // shape errors
    expect((await mark(api, s.id, [])).status).toBe(422);
    expect((await mark(api, s.id, [{ student_id: 'nope', status_id: ST.PRESENT }])).status).toBe(
      422,
    );
    // all-or-nothing: the valid first row of a failing request was NOT saved
    const bad = await mark(api, s.id, [
      { student_id: stu[2]!.id, status_id: ST.PRESENT },
      { student_id: outsider.id, status_id: ST.PRESENT },
    ]);
    expect(bad.status).toBe(422);
    const now = await getSession(api, s.id);
    expect(now.roster.find((r) => r.student.id === stu[2]!.id)!.record).toBeNull();
    expect(sec).toBeTruthy();
  });

  it('mark-all fills the unmarked with PRESENT, or a chosen status; overwrite replaces', async () => {
    const { stu, s } = await fixture(4);
    await mark(api, s.id, [{ student_id: stu[0]!.id, status_id: ST.ABSENT }]);
    const all = await api.post(`/attendance/sessions/${s.id}/mark-all`, {});
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.meta.saved).toEqual({ created: 3, updated: 0, unchanged: 0 });
    const d = all.body.data as Session;
    expect(d.roster.find((r) => r.student.id === stu[0]!.id)!.record!.status_code).toBe('ABSENT'); // kept
    expect(d.summary.counts).toMatchObject({ present: 3, absent: 1 });
    // overwrite with another status
    const over = await api.post(`/attendance/sessions/${s.id}/mark-all`, {
      status_id: ST.LATE,
      overwrite: true,
    });
    expect(over.body.meta.saved).toEqual({ created: 0, updated: 4, unchanged: 0 });
    expect(over.body.data.summary.counts.late).toBe(4);
    // a status that needs a reason needs remarks
    expect(
      (
        await api.post(`/attendance/sessions/${s.id}/mark-all`, {
          status_id: ST.LEAVE,
          overwrite: true,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await api.post(`/attendance/sessions/${s.id}/mark-all`, {
          status_id: ST.LEAVE,
          overwrite: true,
          remarks: 'School trip',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.post(`/attendance/sessions/${s.id}/mark-all`, {
          status_id: '019a0000-0000-7000-8000-000000000003',
        })
      ).status,
    ).toBe(422);
  });

  it('serialises concurrent saves: disjoint saves both land, conflicting saves leave one record', async () => {
    const { stu, s } = await fixture(4);
    const [a, b] = await Promise.all([
      mark(api, s.id, [
        { student_id: stu[0]!.id, status_id: ST.PRESENT },
        { student_id: stu[1]!.id, status_id: ST.PRESENT },
      ]),
      mark(api, s.id, [
        { student_id: stu[2]!.id, status_id: ST.ABSENT },
        { student_id: stu[3]!.id, status_id: ST.ABSENT },
      ]),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    let d = await getSession(api, s.id);
    expect(d.summary).toMatchObject({ marked_count: 4, counts: { present: 2, absent: 2 } });
    expect(d.version).toBe(s.version + 2);
    // both write the same student at once
    const [c, e] = await Promise.all([
      mark(api, s.id, [{ student_id: stu[0]!.id, status_id: ST.ABSENT }]),
      mark(api, s.id, [{ student_id: stu[0]!.id, status_id: ST.LATE }]),
    ]);
    expect([c.status, e.status]).toEqual([200, 200]);
    d = await getSession(api, s.id);
    const rec = d.roster.find((r) => r.student.id === stu[0]!.id)!.record!;
    expect(['ABSENT', 'LATE']).toContain(rec.status_code);
    const [n] = await h.deps.db
      .select({ n: count() })
      .from(attendanceRecords)
      .where(
        and(eq(attendanceRecords.sessionId, s.id), eq(attendanceRecords.studentId, stu[0]!.id)),
      );
    expect(n!.n).toBe(1);
    // a stale version is a conflict (optional optimistic check)
    const stale = await mark(api, s.id, [{ student_id: stu[0]!.id, status_id: ST.PRESENT }], {
      version: s.version,
    });
    expect([stale.status, code(stale)]).toEqual([409, 'CONFLICT']);
    const ok = await mark(api, s.id, [{ student_id: stu[0]!.id, status_id: ST.PRESENT }], {
      version: d.version,
    });
    expect(ok.status).toBe(200);
  });

  it('a roster change between opening and saving is respected (locking read)', async () => {
    const { sec, stu, s } = await fixture(1);
    const late = await newStudent(api, SA, 'Joiner', sec, daysAgo(10)); // enrolled after the session was opened
    const after = await getSession(api, s.id);
    expect(rosterIds(after)).toContain(late.id); // draft roster is live
    expect((await mark(api, s.id, [{ student_id: late.id, status_id: ST.PRESENT }])).status).toBe(
      200,
    );
    // a student withdrawn from the section after being marked stays visible but flagged
    const enr = (await api.get(`/students/${stu[0]!.id}/enrollments`)).body.data[0].id as string;
    await mark(api, s.id, [{ student_id: stu[0]!.id, status_id: ST.PRESENT }]);
    await api.post(`/enrollments/${enr}/complete`, { end_date: daysAgo(3) });
    const d = await getSession(api, s.id);
    const item = d.roster.find((r) => r.student.id === stu[0]!.id)!;
    expect([item.on_roster, item.record!.status_code]).toEqual([false, 'PRESENT']);
  });

  it('an unmarked-only teacher role cannot mark without the permission', async () => {
    const { s } = await fixture(1);
    const principal = await h.addMember(api, [{ role_id: await h.roleId(api, 'PRINCIPAL') }]);
    expect(
      (await principal.api.put(`/attendance/sessions/${s.id}/records`, { records: [] })).status,
    ).toBe(403);
    expect(
      (
        await principal.api.post('/attendance/sessions', {
          section_id: s.id,
          session_date: daysAgo(1),
        })
      ).status,
    ).toBe(403);
    expect((await principal.api.get(`/attendance/sessions/${s.id}`)).status).toBe(200);
  });
});

// ==================================================================================
describe('lifecycle', () => {
  async function ready(a: Api, st: Structure, date = daysAgo(2), complete = true) {
    const sec = await newSection(a, st);
    const stu = await newStudent(a, st, 'Kid', sec);
    const ids = await statusIds(a);
    const s = await open(a, sec, date);
    if (complete) await mark(a, s.id, [{ student_id: stu.id, status_id: ids.PRESENT }]);
    return { sec, stu, s, ids };
  }

  it('without approval: submit goes straight to FINAL and a final register is locked', async () => {
    const { stu, s, ids } = await ready(api, SA);
    const done = await cmd(api, s.id, 'submit');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'FINAL' });
    expect(done.body.data.submitted_at).toBeTruthy();
    expect(done.body.data.finalized_at).toBeTruthy();
    // locked
    const edit = await mark(api, s.id, [{ student_id: stu.id, status_id: ids.ABSENT }]);
    expect([edit.status, code(edit)]).toEqual([422, 'INVALID_STATE']);
    expect(code(await api.post(`/attendance/sessions/${s.id}/mark-all`, { overwrite: true }))).toBe(
      'INVALID_STATE',
    );
    expect(code(await cmd(api, s.id, 'submit'))).toBe('INVALID_STATE');
    expect(code(await cmd(api, s.id, 'approve'))).toBe('INVALID_STATE');
    expect(code(await cmd(api, s.id, 'reject', { reason: 'no way' }))).toBe('INVALID_STATE');
    const types = (
      await h.deps.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, s.id))
    ).map((e) => e.eventType);
    expect(types).toEqual(
      expect.arrayContaining([
        'attendance.session_opened',
        'attendance.recorded',
        'attendance.session_submitted',
        'attendance.session_finalized',
      ]),
    );
    expect(types).not.toContain('attendance.session_approved');
    const actions = (
      await h.deps.db.select().from(auditLogs).where(eq(auditLogs.entityId, s.id))
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'ATTENDANCE_SESSION_OPENED',
        'ATTENDANCE_RECORDED',
        'ATTENDANCE_SESSION_SUBMITTED',
        'ATTENDANCE_SESSION_FINALIZED',
      ]),
    );
  });

  it('refuses to submit an incomplete or empty register', async () => {
    const { stu, s, ids } = await ready(api, SA, daysAgo(2), false);
    const r = await cmd(api, s.id, 'submit');
    expect([r.status, code(r)]).toEqual([422, 'OPERATION_NOT_ALLOWED']);
    expect(r.body.error.details).toMatchObject({
      reason: 'UNMARKED_STUDENTS',
      unmarked_count: 1,
      unmarked_student_ids: [stu.id],
    });
    await mark(api, s.id, [{ student_id: stu.id, status_id: ids.PRESENT }]);
    expect((await cmd(api, s.id, 'submit')).status).toBe(200);
    const emptySec = await newSection(api, SA);
    const empty = await open(api, emptySec, daysAgo(2));
    const e = await cmd(api, empty.id, 'submit');
    expect([e.status, e.body.error.details.reason]).toEqual([422, 'EMPTY_ROSTER']);
  });

  it('with approval: DRAFT → SUBMITTED → FINAL, reject sends it back with a reason, reopen edits again', async () => {
    const a = C.admin.api;
    const ids = await statusIds(a);
    const cfg = await a.patch('/attendance/settings', { version: 1, approval_required: true });
    expect(cfg.status).toBe(200);
    try {
      const teacher = await h.addMember(a, [{ role_id: await h.roleId(a, 'TEACHER') }]);
      const approver = await h.addMember(a, [{ role_id: await h.roleId(a, 'PRINCIPAL') }]);
      const sec = await newSection(a, SC);
      const stu = await newStudent(a, SC, 'Kid', sec);
      const s = await open(teacher.api, sec, daysAgo(2));
      await mark(teacher.api, s.id, [{ student_id: stu.id, status_id: ids.PRESENT }]);

      // approve/reject/reopen need attendance.approve
      expect((await cmd(teacher.api, s.id, 'approve')).status).toBe(403);
      const submitted = await cmd(teacher.api, s.id, 'submit');
      expect(submitted.body.data.status).toBe('SUBMITTED');
      expect(submitted.body.data.finalized_at).toBeNull();
      expect(
        code(await mark(teacher.api, s.id, [{ student_id: stu.id, status_id: ids.ABSENT }])),
      ).toBe('INVALID_STATE');
      expect(code(await cmd(teacher.api, s.id, 'submit'))).toBe('INVALID_STATE');
      expect(code(await cmd(approver.api, s.id, 'reopen', { reason: 'not final yet' }))).toBe(
        'INVALID_STATE',
      );
      expect((await cmd(teacher.api, s.id, 'reject', { reason: 'Because I said so' })).status).toBe(
        403,
      );

      // reject: reason required; back to DRAFT with the reason visible; teacher fixes and resubmits
      expect((await cmd(approver.api, s.id, 'reject', {})).status).toBe(422);
      const rej = await cmd(approver.api, s.id, 'reject', { reason: 'Check Kid again' });
      expect(rej.body.data).toMatchObject({ status: 'DRAFT', rejection_reason: 'Check Kid again' });
      expect(
        (await mark(teacher.api, s.id, [{ student_id: stu.id, status_id: ids.LATE }])).status,
      ).toBe(200);
      const again = await cmd(teacher.api, s.id, 'submit');
      expect(again.body.data).toMatchObject({ status: 'SUBMITTED', rejection_reason: null });

      // approve → FINAL
      const ok = await cmd(approver.api, s.id, 'approve');
      expect(ok.body.data.status).toBe('FINAL');
      expect(ok.body.data.approved_at).toBeTruthy();
      expect(code(await cmd(approver.api, s.id, 'approve'))).toBe('INVALID_STATE');
      expect(code(await cmd(approver.api, s.id, 'reject', { reason: 'too late' }))).toBe(
        'INVALID_STATE',
      );

      // reopen needs a reason; teacher cannot reopen; after reopening the register is editable
      expect((await cmd(teacher.api, s.id, 'reopen', { reason: 'please' })).status).toBe(403);
      expect((await cmd(approver.api, s.id, 'reopen', {})).status).toBe(422);
      const reopened = await cmd(approver.api, s.id, 'reopen', { reason: 'Wrong day' });
      expect(reopened.body.data).toMatchObject({
        status: 'DRAFT',
        reopen_reason: 'Wrong day',
        approved_at: null,
      });
      expect(reopened.body.data.reopened_at).toBeTruthy();
      expect(
        (await mark(teacher.api, s.id, [{ student_id: stu.id, status_id: ids.ABSENT }])).status,
      ).toBe(200);

      // optimistic version on commands
      const d = await getSession(a, s.id);
      const stale = await cmd(teacher.api, s.id, 'submit', { version: d.version - 1 });
      expect([stale.status, code(stale)]).toEqual([409, 'CONFLICT']);
      expect(
        (await cmd(teacher.api, s.id, 'submit', { version: d.version })).body.data.status,
      ).toBe('SUBMITTED');

      const types = (
        await h.deps.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, s.id))
      ).map((e) => e.eventType);
      expect(types).toEqual(
        expect.arrayContaining([
          'attendance.session_rejected',
          'attendance.session_approved',
          'attendance.session_finalized',
          'attendance.session_reopened',
        ]),
      );
    } finally {
      const cur = (await a.get('/attendance/settings')).body.data;
      await a.patch('/attendance/settings', { version: cur.version, approval_required: false });
    }
  });

  it('a submit racing with mark-all never leaves a FINAL register with unmarked students', async () => {
    const sec = await newSection(api, SA);
    const stu = [];
    for (let i = 0; i < 3; i++) stu.push(await newStudent(api, SA, `Race${i}`, sec));
    const s = await open(api, sec, daysAgo(2));
    await mark(api, s.id, [{ student_id: stu[0]!.id, status_id: ST.PRESENT }]);
    const [fill, submit] = await Promise.all([
      api.post(`/attendance/sessions/${s.id}/mark-all`, {}),
      cmd(api, s.id, 'submit'),
    ]);
    expect(fill.status, JSON.stringify(fill.body)).toBe(200);
    expect([200, 422]).toContain(submit.status);
    const d = await getSession(api, s.id);
    if (submit.status === 200) expect([d.status, d.summary.marked_count]).toEqual(['FINAL', 3]);
    else expect(d.status).toBe('DRAFT');
  });

  it('the edit window closes old registers for recorders, but not for approvers or after a reopen', async () => {
    const sec = await newSection(api, SA);
    const stu = await newStudent(api, SA, 'Old', sec, daysAgo(60));
    const old = daysAgo(20);
    // a recorder without attendance.approve cannot open (or edit) a session that old
    const w = await teacherA.api.post('/attendance/sessions', {
      section_id: sec,
      session_date: old,
    });
    expect([w.status, code(w), w.body.error.details.reason]).toEqual([
      422,
      'OPERATION_NOT_ALLOWED',
      'EDIT_WINDOW_CLOSED',
    ]);
    // an approver can (backfill)
    const s = await open(api, sec, old);
    await mark(api, s.id, [{ student_id: stu.id, status_id: ST.PRESENT }]);
    // ... but the teacher still cannot edit or submit it
    const e = await mark(teacherA.api, s.id, [{ student_id: stu.id, status_id: ST.ABSENT }]);
    expect([e.status, e.body.error.details.reason]).toEqual([422, 'EDIT_WINDOW_CLOSED']);
    expect((await cmd(teacherA.api, s.id, 'submit')).status).toBe(422);
    expect((await cmd(api, s.id, 'submit')).body.data.status).toBe('FINAL');
    // once an approver reopens it on purpose, the recorder may edit again
    await cmd(api, s.id, 'reopen', { reason: 'Teacher to fix' });
    expect(
      (await mark(teacherA.api, s.id, [{ student_id: stu.id, status_id: ST.ABSENT }])).status,
    ).toBe(200);
    // widening the window lets recorders in
    const D = await h.provisionSchool();
    const st = await structure(D.admin.api, 'W');
    const sec2 = await newSection(D.admin.api, st);
    const t = await h.addMember(D.admin.api, [{ role_id: await h.roleId(D.admin.api, 'TEACHER') }]);
    expect(
      (await t.api.post('/attendance/sessions', { section_id: sec2, session_date: daysAgo(10) }))
        .status,
    ).toBe(422);
    await D.admin.api.patch('/attendance/settings', { version: 1, edit_window_days: 30 });
    expect(
      (await t.api.post('/attendance/sessions', { section_id: sec2, session_date: daysAgo(10) }))
        .status,
    ).toBe(201);
  });
});

// ==================================================================================
describe('corrections', () => {
  async function finalRecord(a: Api, st: Structure, statusCode = 'PRESENT') {
    const sec = await newSection(a, st);
    const stu = await newStudent(a, st, 'Corr', sec);
    const ids = await statusIds(a);
    const s = await open(a, sec, daysAgo(2));
    await mark(a, s.id, [{ student_id: stu.id, status_id: ids[statusCode] }]);
    const draft = await getSession(a, s.id);
    return { sec, stu, s, ids, recordId: draft.roster[0]!.record!.id };
  }

  it('applies a correction at once when approval is not required, keeping the original in the correction row', async () => {
    const { stu, s, ids, recordId } = await finalRecord(api, SA);
    // records of a DRAFT session are edited directly, not corrected
    const early = await teacherA.api.post(`/attendance/records/${recordId}/corrections`, {
      new_status_id: ids.ABSENT,
      reason: 'Was absent',
    });
    expect([early.status, code(early)]).toEqual([422, 'INVALID_STATE']);
    await cmd(api, s.id, 'submit');

    const res = await teacherA.api.post(`/attendance/records/${recordId}/corrections`, {
      new_status_id: ids.ABSENT,
      reason: 'Parent called: was absent',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'AUTO_APPLIED',
      old_status: { code: 'PRESENT' },
      new_status: { code: 'ABSENT' },
      reason: 'Parent called: was absent',
      student: { id: stu.id },
      session: { id: s.id },
    });
    expect(res.body.data.decided_by).toBeNull();
    const d = await getSession(api, s.id);
    expect(d.roster[0]!.record).toMatchObject({ status_code: 'ABSENT', version: 2 });
    expect(d.summary).toMatchObject({ present_units: 0, absent_units: 1 });
    expect((await api.get(`/students/${stu.id}/attendance`)).body.data.summary.percentage).toBe(0);

    // validations
    expect(
      code(
        await teacherA.api.post(`/attendance/records/${recordId}/corrections`, {
          new_status_id: ids.ABSENT,
          reason: 'Same again',
        }),
      ),
    ).toBe('OPERATION_NOT_ALLOWED');
    expect(
      (
        await teacherA.api.post(`/attendance/records/${recordId}/corrections`, {
          new_status_id: ids.PRESENT,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await teacherA.api.post(`/attendance/records/${recordId}/corrections`, {
          new_status_id: ids.PRESENT,
          reason: 'x',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await teacherA.api.post(`/attendance/records/${recordId}/corrections`, {
          new_status_id: (await statusIds(B.admin.api)).PRESENT,
          reason: 'Foreign status',
        })
      ).status,
    ).toBe(404);
    const custom = (
      await api.post('/attendance/statuses', {
        code: uniq('K').toUpperCase().replace(/-/g, '_').slice(0, 20),
        name: 'K',
        category: 'OTHER',
      })
    ).body.data;
    await api.post(`/attendance/statuses/${custom.id}/deactivate`);
    expect(
      code(
        await teacherA.api.post(`/attendance/records/${recordId}/corrections`, {
          new_status_id: custom.id,
          reason: 'Inactive one',
        }),
      ),
    ).toBe('INVALID_STATE');
    // a principal without attendance.correct cannot request one
    const principal = await h.addMember(api, [{ role_id: await h.roleId(api, 'PRINCIPAL') }]);
    expect(
      (
        await principal.api.post(`/attendance/records/${recordId}/corrections`, {
          new_status_id: ids.PRESENT,
          reason: 'Not allowed',
        })
      ).status,
    ).toBe(403);

    // trail: correction history + audit + outbox
    const list = await api.get(`/attendance/corrections?record_id=${recordId}`);
    expect(list.body.meta.total).toBe(1);
    const ev = await h.deps.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.tenantId, A.tenantId),
          eq(outboxEvents.eventType, 'attendance.corrected'),
        ),
      );
    expect(ev.some((e) => (e.payload as { record_id?: string }).record_id === recordId)).toBe(true);
    const audit = await h.deps.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, res.body.data.id));
    expect(audit[0]).toMatchObject({
      action: 'ATTENDANCE_CORRECTED',
      reason: 'Parent called: was absent',
    });
    expect(audit[0]!.before).toMatchObject({ status: 'PRESENT' });
    expect(audit[0]!.after).toMatchObject({ status: 'ABSENT' });
  });

  it('with approval required: PENDING until an approver decides; one pending per record', async () => {
    const a = C.admin.api;
    const cfg = (await a.get('/attendance/settings')).body.data;
    await a.patch('/attendance/settings', {
      version: cfg.version,
      correction_requires_approval: true,
    });
    try {
      const teacher = await h.addMember(a, [{ role_id: await h.roleId(a, 'TEACHER') }]);
      const approver = await h.addMember(a, [{ role_id: await h.roleId(a, 'PRINCIPAL') }]);
      const { s, ids, recordId, stu } = await finalRecord(a, SC);
      await cmd(a, s.id, 'submit');

      const req = await teacher.api.post(`/attendance/records/${recordId}/corrections`, {
        new_status_id: ids.ABSENT,
        reason: 'Was absent, per office',
      });
      expect(req.status, JSON.stringify(req.body)).toBe(201);
      expect(req.body.data.status).toBe('PENDING');
      const cid = req.body.data.id as string;
      // record unchanged, numbers unchanged
      expect((await getSession(a, s.id)).roster[0]!.record!.status_code).toBe('PRESENT');
      expect((await a.get(`/students/${stu.id}/attendance`)).body.data.summary.percentage).toBe(
        100,
      );
      // second request while one is pending
      const dup = await teacher.api.post(`/attendance/records/${recordId}/corrections`, {
        new_status_id: ids.LATE,
        reason: 'Another try',
      });
      expect([dup.status, code(dup)]).toEqual([409, 'DUPLICATE_RESOURCE']);
      expect(dup.body.error.details.correction_id).toBe(cid);
      // a pending correction blocks reopening
      const blocked = await cmd(a, s.id, 'reopen', { reason: 'Reopen please' });
      expect([blocked.status, blocked.body.error.details.reason]).toEqual([
        422,
        'PENDING_CORRECTIONS',
      ]);
      // list filters
      expect(
        (await a.get('/attendance/corrections?status=PENDING')).body.data.map(
          (x: { id: string }) => x.id,
        ),
      ).toContain(cid);
      expect(
        (await a.get('/attendance/corrections?status=APPROVED')).body.data.map(
          (x: { id: string }) => x.id,
        ),
      ).not.toContain(cid);
      expect((await a.get(`/attendance/corrections/${cid}`)).body.data.status).toBe('PENDING');
      // the requester cannot decide
      expect((await teacher.api.post(`/attendance/corrections/${cid}/approve`, {})).status).toBe(
        403,
      );
      expect(
        (await teacher.api.post(`/attendance/corrections/${cid}/reject`, { reason: 'Nope nope' }))
          .status,
      ).toBe(403);
      // rejecting needs a reason and leaves the record alone
      expect((await approver.api.post(`/attendance/corrections/${cid}/reject`, {})).status).toBe(
        422,
      );
      const rej = await approver.api.post(`/attendance/corrections/${cid}/reject`, {
        reason: 'No evidence',
      });
      expect(rej.body.data).toMatchObject({ status: 'REJECTED', decision_note: 'No evidence' });
      expect(rej.body.data.decided_by).toBeTruthy();
      expect((await getSession(a, s.id)).roster[0]!.record!.status_code).toBe('PRESENT');
      expect(code(await approver.api.post(`/attendance/corrections/${cid}/approve`, {}))).toBe(
        'INVALID_STATE',
      );
      expect(
        code(await approver.api.post(`/attendance/corrections/${cid}/reject`, { reason: 'Again' })),
      ).toBe('INVALID_STATE');
      // a new request is possible after the decision; approving applies it
      const second = await teacher.api.post(`/attendance/records/${recordId}/corrections`, {
        new_status_id: ids.HALF_DAY,
        reason: 'Left at noon',
      });
      expect(second.status).toBe(201);
      const ok = await approver.api.post(`/attendance/corrections/${second.body.data.id}/approve`, {
        note: 'Confirmed with parent',
      });
      expect(ok.body.data).toMatchObject({
        status: 'APPROVED',
        decision_note: 'Confirmed with parent',
      });
      const rec = (await getSession(a, s.id)).roster[0]!.record!;
      expect([rec.status_code, rec.version]).toEqual(['HALF_DAY', 2]);
      expect((await a.get(`/students/${stu.id}/attendance`)).body.data.summary).toMatchObject({
        percentage: 50,
        present_units: 0.5,
      });
      const rows = await h.deps.db
        .select()
        .from(attendanceCorrections)
        .where(eq(attendanceCorrections.recordId, recordId));
      expect(rows.map((r) => r.status).sort()).toEqual(['APPROVED', 'REJECTED']);
      const types = (
        await h.deps.db
          .select()
          .from(outboxEvents)
          .where(eq(outboxEvents.aggregateId, second.body.data.id))
      ).map((e) => e.eventType);
      expect(types).toEqual(
        expect.arrayContaining(['attendance.correction_requested', 'attendance.corrected']),
      );
    } finally {
      const cur = (await a.get('/attendance/settings')).body.data;
      await a.patch('/attendance/settings', {
        version: cur.version,
        correction_requires_approval: false,
      });
    }
  });
});

describe('corrections racing with reopen', () => {
  it('a pending correction and a reopen exclude each other, whoever wins', async () => {
    const a = C.admin.api;
    const cfg = (await a.get('/attendance/settings')).body.data;
    await a.patch('/attendance/settings', {
      version: cfg.version,
      correction_requires_approval: true,
    });
    try {
      const ids = await statusIds(a);
      for (let round = 0; round < 3; round++) {
        const sec = await newSection(a, SC);
        const stu = await newStudent(a, SC, 'Race', sec);
        const s = await open(a, sec, daysAgo(2));
        await mark(a, s.id, [{ student_id: stu.id, status_id: ids.PRESENT }]);
        await cmd(a, s.id, 'submit');
        const rid = (await getSession(a, s.id)).roster[0]!.record!.id;
        const [req, reopen] = await Promise.all([
          a.post(`/attendance/records/${rid}/corrections`, {
            new_status_id: ids.ABSENT,
            reason: 'Race request',
          }),
          cmd(a, s.id, 'reopen', { reason: 'Race reopen' }),
        ]);
        const outcome = [req.status, reopen.status].join('/');
        expect(['201/422', '422/200'], outcome + JSON.stringify([req.body, reopen.body])).toContain(
          outcome,
        );
        const d = await getSession(a, s.id);
        const pending = await h.deps.db
          .select({ n: count() })
          .from(attendanceCorrections)
          .where(
            and(
              eq(attendanceCorrections.recordId, rid),
              eq(attendanceCorrections.status, 'PENDING'),
            ),
          );
        // never a pending correction on a register that is no longer FINAL
        expect(d.status === 'DRAFT' ? pending[0]!.n : 0).toBe(0);
      }
    } finally {
      const cur = (await a.get('/attendance/settings')).body.data;
      await a.patch('/attendance/settings', {
        version: cur.version,
        correction_requires_approval: false,
      });
    }
  });
});

// ==================================================================================
describe('scope narrowing', () => {
  it('a section-scoped user only sees and marks their sections; others behave as 404', async () => {
    const mine = await newSection(api, SA);
    const theirs = await newSection(api, SA);
    const sMine = await newStudent(api, SA, 'Mine', mine);
    const sTheirs = await newStudent(api, SA, 'Theirs', theirs);
    const teacher = await h.addMember(api, [
      {
        role_id: await h.roleId(api, 'TEACHER'),
        scope_type: 'ASSIGNED_SECTION',
        scope_ref: { section_ids: [mine] },
      },
    ]);
    const t = teacher.api;
    const own = await open(t, mine, daysAgo(1));
    const foreign = await open(api, theirs, daysAgo(1)); // opened by the admin
    expect(
      (await t.post('/attendance/sessions', { section_id: theirs, session_date: daysAgo(1) }))
        .status,
    ).toBe(404);
    expect((await t.get(`/attendance/sessions/${foreign.id}`)).status).toBe(404);
    expect(
      (
        await t.put(`/attendance/sessions/${foreign.id}/records`, {
          records: [{ student_id: sTheirs.id, status_id: ST.PRESENT }],
        })
      ).status,
    ).toBe(404);
    expect((await t.post(`/attendance/sessions/${foreign.id}/mark-all`, {})).status).toBe(404);
    expect((await cmd(t, foreign.id, 'submit')).status).toBe(404);
    expect((await mark(t, own.id, [{ student_id: sMine.id, status_id: ST.PRESENT }])).status).toBe(
      200,
    );
    expect(
      (await mark(t, own.id, [{ student_id: sTheirs.id, status_id: ST.PRESENT }])).status,
    ).toBe(422);
    const list = await t.get('/attendance/sessions?page_size=100');
    const ids = list.body.data.map((x: { id: string }) => x.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(foreign.id);
    expect(
      (
        await t.get(
          `/attendance/register?section_id=${theirs}&date_from=${daysAgo(3)}&date_to=${daysAgo(1)}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await t.get(
          `/attendance/register?section_id=${mine}&date_from=${daysAgo(3)}&date_to=${daysAgo(1)}`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await t.get(
          `/attendance/reports/monthly?section_id=${theirs}&month=${daysAgo(1).slice(0, 7)}`,
        )
      ).status,
    ).toBe(404);
    const today = await t.get('/attendance/today');
    const secIds = today.body.data.sections.map((x: { section: { id: string } }) => x.section.id);
    expect(secIds).toEqual([mine]);
    expect((await t.get(`/students/${sMine.id}/attendance`)).status).toBe(200);
    expect((await t.get(`/students/${sTheirs.id}/attendance`)).status).toBe(404);
    // corrections of an out-of-scope record are 404 too
    await mark(api, foreign.id, [{ student_id: sTheirs.id, status_id: ST.PRESENT }]);
    await cmd(api, foreign.id, 'submit');
    const rid = (await getSession(api, foreign.id)).roster[0]!.record!.id;
    expect(
      (
        await t.post(`/attendance/records/${rid}/corrections`, {
          new_status_id: ST.ABSENT,
          reason: 'Out of scope',
        })
      ).status,
    ).toBe(404);
    // the defaulter list only covers their sections
    const def = await t.get('/attendance/reports/defaulters?threshold=100');
    expect(
      def.body.data.every((r: { section: { id: string } | null }) => r.section?.id === mine),
    ).toBe(true);
  });

  it('an ASSIGNED_CLASS grant covers every section of the class', async () => {
    const s1 = await newSection(api, SA);
    const s2 = await newSection(api, SA);
    const other = await newSection(api, SA, SA.class2Id);
    const teacher = await h.addMember(api, [
      {
        role_id: await h.roleId(api, 'TEACHER'),
        scope_type: 'ASSIGNED_CLASS',
        scope_ref: { class_ids: [SA.classId] },
      },
    ]);
    expect(
      (await teacher.api.post('/attendance/sessions', { section_id: s1, session_date: daysAgo(1) }))
        .status,
    ).toBe(201);
    expect(
      (await teacher.api.post('/attendance/sessions', { section_id: s2, session_date: daysAgo(1) }))
        .status,
    ).toBe(201);
    expect(
      (
        await teacher.api.post('/attendance/sessions', {
          section_id: other,
          session_date: daysAgo(1),
        })
      ).status,
    ).toBe(404);
  });

  it('a teacher without narrowing (ALL_TENANT) marks any section; a scope-less grant of another kind is denied', async () => {
    const sec = await newSection(api, SA);
    expect(
      (
        await teacherA.api.post('/attendance/sessions', {
          section_id: sec,
          session_date: daysAgo(1),
        })
      ).status,
    ).toBe(201);
    // A scope the attendance permissions cannot use is refused when assigned (D55).
    const odd = await api.post('/members/invitations', {
      email: `odd-${Date.now()}@school.test`,
      first_name: 'Odd',
      roles: [{ role_id: await h.roleId(api, 'TEACHER'), scope_type: 'OWN_RECORD' }],
    });
    expect(odd.status).toBe(422);
    expect(odd.body.error.details.reason).toBe('SCOPE_NOT_SUPPORTED');
    expect(odd.body.error.details.permissions).toEqual(
      expect.arrayContaining(['attendance.mark', 'attendance.read', 'students.read']),
    );
  });
});

// ==================================================================================
describe('plan and tenant isolation', () => {
  it('a school without the attendance feature gets FEATURE_NOT_ENABLED everywhere', async () => {
    const D = await h.provisionSchool();
    const deny = await D.root.put(
      `/platform/tenants/${D.tenantId}/entitlements/overrides/attendance`,
      {
        effect: 'DENY',
        reason: 'No attendance',
        confirm: true, // also switches off its capabilities (corrections & approvals)
      },
    );
    expect(deny.status, JSON.stringify(deny.body)).toBe(200);
    for (const url of [
      '/attendance/statuses',
      '/attendance/settings',
      '/attendance/today',
      '/attendance/sessions',
      '/attendance/corrections',
    ]) {
      const r = await D.admin.api.get(url);
      expect([r.status, code(r), r.body.error.details.feature], url).toEqual([
        403,
        'FEATURE_NOT_ENABLED',
        'attendance',
      ]);
    }
    expect(
      code(
        await D.admin.api.post('/attendance/sessions', {
          section_id: '019a0000-0000-7000-8000-000000000000',
          session_date: daysAgo(1),
        }),
      ),
    ).toBe('FEATURE_NOT_ENABLED');
  });

  it("another school's ids are 404 on every attendance read and write path", async () => {
    const sec = await newSection(api, SA);
    const stu = await newStudent(api, SA, 'Iso', sec);
    const s = await open(api, sec, daysAgo(1));
    await mark(api, s.id, [{ student_id: stu.id, status_id: ST.PRESENT }]);
    const rec = (await getSession(api, s.id)).roster[0]!.record!.id;
    await cmd(api, s.id, 'submit');
    const corr = await api.post(`/attendance/records/${rec}/corrections`, {
      new_status_id: ST.ABSENT,
      reason: 'Isolation test',
    });
    const b = B.admin.api;
    const month = daysAgo(1).slice(0, 7);
    const probes: [string, string, object?][] = [
      ['get', `/attendance/sessions/${s.id}`],
      [
        'put',
        `/attendance/sessions/${s.id}/records`,
        { records: [{ student_id: stu.id, status_id: ST.PRESENT }] },
      ],
      ['post', `/attendance/sessions/${s.id}/mark-all`, {}],
      ['post', `/attendance/sessions/${s.id}/submit`, {}],
      ['post', `/attendance/sessions/${s.id}/approve`, {}],
      ['post', `/attendance/sessions/${s.id}/reject`, { reason: 'Isolation' }],
      ['post', `/attendance/sessions/${s.id}/reopen`, { reason: 'Isolation' }],
      [
        'post',
        `/attendance/records/${rec}/corrections`,
        { new_status_id: ST.ABSENT, reason: 'Isolation' },
      ],
      ['get', `/attendance/corrections/${corr.body.data.id}`],
      ['post', `/attendance/corrections/${corr.body.data.id}/approve`, {}],
      ['post', `/attendance/corrections/${corr.body.data.id}/reject`, { reason: 'Isolation' }],
      ['get', `/attendance/statuses/${ST.PRESENT}`],
      ['get', `/students/${stu.id}/attendance`],
      [
        'get',
        `/attendance/register?section_id=${sec}&date_from=${daysAgo(3)}&date_to=${daysAgo(1)}`,
      ],
      ['get', `/attendance/reports/monthly?section_id=${sec}&month=${month}`],
      [
        'get',
        `/attendance/register/export?section_id=${sec}&date_from=${daysAgo(3)}&date_to=${daysAgo(1)}`,
      ],
      ['post', '/attendance/sessions', { section_id: sec, session_date: daysAgo(1) }],
    ];
    for (const [method, url, body] of probes) {
      const r = await (
        b as unknown as Record<string, (u: string, x?: object) => Promise<{ status: number }>>
      )[method]!(url, body);
      expect(r.status, `${method} ${url}`).toBe(404);
    }
    // list-style reads simply do not contain it
    expect(
      (await b.get('/attendance/sessions?page_size=100')).body.data.map(
        (x: { id: string }) => x.id,
      ),
    ).not.toContain(s.id);
    expect(
      (await b.get('/attendance/corrections')).body.data.map((x: { id: string }) => x.id),
    ).not.toContain(corr.body.data.id);
    const todayIds = (await b.get('/attendance/today')).body.data.sections.map(
      (x: { section: { id: string } }) => x.section.id,
    );
    expect(todayIds).not.toContain(sec);
    const def = await b.get('/attendance/reports/defaulters?threshold=100');
    expect(JSON.stringify(def.body)).not.toContain(stu.id);
    // the student query filter cannot be used to look across schools either
    expect((await b.get(`/attendance/corrections?student_id=${stu.id}`)).body.meta.total).toBe(0);
  });

  it('the database itself refuses cross-school references (composite foreign keys)', async () => {
    const secA = await newSection(api, SA);
    const stuA = await newStudent(api, SA, 'FkA', secA);
    const s = await open(api, secA, daysAgo(1));
    const secB = await newSection(B.admin.api, SB);
    const stuB = await newStudent(B.admin.api, SB, 'FkB', secB);
    const stB = await statusIds(B.admin.api);
    const enrB = (await B.admin.api.get(`/students/${stuB.id}/enrollments`)).body.data[0]
      .id as string;
    const enrA = (await api.get(`/students/${stuA.id}/enrollments`)).body.data[0].id as string;
    const db = h.deps.db;
    const rec = (over: Partial<typeof attendanceRecords.$inferInsert>) =>
      db.insert(attendanceRecords).values({
        tenantId: A.tenantId,
        sessionId: s.id,
        studentId: stuA.id,
        enrollmentId: enrA,
        statusId: ST.PRESENT!,
        presentWeight: '1.00',
        absentWeight: '0.00',
        markedAt: new Date(),
        ...over,
      });
    expect(await dbErrorCode(rec({ studentId: stuB.id }))).toBe('ER_NO_REFERENCED_ROW_2');
    expect(await dbErrorCode(rec({ enrollmentId: enrB }))).toBe('ER_NO_REFERENCED_ROW_2');
    expect(await dbErrorCode(rec({ statusId: stB.PRESENT! }))).toBe('ER_NO_REFERENCED_ROW_2');
    expect(await dbErrorCode(rec({ tenantId: B.tenantId }))).toBe('ER_NO_REFERENCED_ROW_2'); // A's session under B
    expect(await dbErrorCode(rec({}))).toBeUndefined(); // the legitimate row is fine
    expect(await dbErrorCode(rec({}))).toBe('ER_DUP_ENTRY'); // one record per student per session
    const sess = (over: Partial<typeof attendanceSessions.$inferInsert>) =>
      db.insert(attendanceSessions).values({
        tenantId: A.tenantId,
        academicYearId: SA.yearId,
        classId: SA.classId,
        sectionId: secA,
        sessionDate: daysAgo(9),
        startedAt: new Date(),
        ...over,
      });
    expect(await dbErrorCode(sess({ sectionId: secB, sessionDate: daysAgo(8) }))).toBe(
      'ER_NO_REFERENCED_ROW_2',
    );
    expect(await dbErrorCode(sess({ academicYearId: SB.yearId, sessionDate: daysAgo(8) }))).toBe(
      'ER_NO_REFERENCED_ROW_2',
    );
    expect(
      await dbErrorCode(
        sess({ teacherId: '019a0000-0000-7000-8000-000000000009', sessionDate: daysAgo(8) }),
      ),
    ).toBe('ER_NO_REFERENCED_ROW_2');
    expect(await dbErrorCode(sess({}))).toBeUndefined();
    expect(await dbErrorCode(sess({}))).toBe('ER_DUP_ENTRY'); // one DAILY session per section and date
    // corrections
    const recId = (
      await db.select().from(attendanceRecords).where(eq(attendanceRecords.sessionId, s.id))
    )[0]!.id;
    const corr = (over: Partial<typeof attendanceCorrections.$inferInsert>) =>
      db.insert(attendanceCorrections).values({
        tenantId: A.tenantId,
        recordId: recId,
        oldStatusId: ST.PRESENT!,
        newStatusId: ST.ABSENT!,
        reason: 'db test',
        requestedAt: new Date(),
        ...over,
      });
    expect(await dbErrorCode(corr({ newStatusId: stB.ABSENT! }))).toBe('ER_NO_REFERENCED_ROW_2');
    expect(await dbErrorCode(corr({}))).toBeUndefined();
    expect(await dbErrorCode(corr({}))).toBe('ER_DUP_ENTRY'); // one pending correction per record
  });
});

// ==================================================================================
describe('reports (hand-computed fixtures)', () => {
  const base = (() => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - 2, 1);
    return d.toISOString().slice(0, 10);
  })();
  const dayN = (n: number) =>
    new Date(Date.parse(`${base}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
  const month = base.slice(0, 7);
  let sec: string;
  let sec2: string;
  let students: { id: string; name: string }[];
  let rid: Record<string, string>;
  let today: string;
  let raSession: string;
  let ra: Api;

  beforeAll(async () => {
    ra = R.admin.api;
    rid = await statusIds(ra);
    sec = await newSection(ra, SR, SR.classId, 'R1');
    sec2 = await newSection(ra, SR, SR.classId, 'R2');
    const names = ['Anil', 'Bela', 'Chitra', '=Dev']; // a spreadsheet formula as a first name proves CSV safety
    students = [];
    for (const [i, n] of names.entries()) {
      const s = await newStudent(ra, SR, n, sec, daysAgo(190), `Fam${i}`);
      students.push({ id: s.id, name: n });
    }
    // day × student (Anil, Bela, Chitra, Dev)
    const plan: string[][] = [
      ['PRESENT', 'PRESENT', 'PRESENT', 'ABSENT'],
      ['PRESENT', 'ABSENT', 'HALF_DAY', 'ABSENT'],
      ['PRESENT', 'PRESENT', 'LATE', 'ABSENT'],
      ['PRESENT', 'ABSENT', 'PRESENT', 'PRESENT'],
      ['PRESENT', 'PRESENT', 'PRESENT', 'LEAVE'],
    ];
    for (const [d, row] of plan.entries()) {
      const s = await open(ra, sec, dayN(d));
      const res = await mark(
        ra,
        s.id,
        row.map((c, i) => ({
          student_id: students[i]!.id,
          status_id: rid[c],
          ...(c === 'LEAVE' ? { remarks: 'Family function' } : {}),
        })),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await cmd(ra, s.id, 'submit')).body.data.status).toBe('FINAL');
    }
    // a DRAFT register that must not count
    const draft = await open(ra, sec, dayN(6));
    await mark(ra, draft.id, [{ student_id: students[0]!.id, status_id: rid.ABSENT }]);
    // today's dashboard fixtures: R1 gets a DRAFT with two marks; R2 (empty) stays NOT_STARTED
    today = (await ra.get('/attendance/today')).body.data.date;
    const t = await open(ra, sec, today);
    raSession = t.id;
    await mark(ra, t.id, [
      { student_id: students[0]!.id, status_id: rid.PRESENT },
      { student_id: students[1]!.id, status_id: rid.ABSENT },
    ]);
  });

  it('student history: present units, absent units and percentage (half day = 0.5, LEAVE = 0)', async () => {
    const get = async (i: number) =>
      (await ra.get(`/students/${students[i]!.id}/attendance`)).body.data;
    const anil = await get(0);
    expect(anil.summary).toMatchObject({
      marked_count: 5,
      present_units: 5,
      absent_units: 0,
      percentage: 100,
    });
    expect(anil.records).toHaveLength(5); // the DRAFT and today's marks are not official
    const bela = await get(1);
    expect(bela.summary).toMatchObject({
      marked_count: 5,
      present_units: 3,
      absent_units: 2,
      percentage: 60,
    });
    const chitra = await get(2);
    expect(chitra.summary).toMatchObject({ present_units: 4.5, absent_units: 0.5, percentage: 90 });
    expect(chitra.summary.counts).toMatchObject({ present: 3, late: 1, half_day: 1 });
    expect(chitra.summary.by_status).toEqual(
      expect.arrayContaining([
        { code: 'HALF_DAY', name: 'Half day', category: 'HALF_DAY', count: 1 },
      ]),
    );
    const dev = await get(3);
    expect(dev.summary).toMatchObject({ present_units: 1, absent_units: 4, percentage: 20 });
    expect(dev.records.map((r: { session_date: string }) => r.session_date)).toEqual(
      [0, 1, 2, 3, 4].map(dayN),
    );
    expect(dev.records[4].status.code).toBe('LEAVE');
    // period filter
    const two = await ra.get(
      `/students/${students[1]!.id}/attendance?from=${dayN(0)}&to=${dayN(1)}`,
    );
    expect(two.body.data.summary).toMatchObject({
      marked_count: 2,
      present_units: 1,
      percentage: 50,
    });
    expect(
      (await ra.get(`/students/${students[1]!.id}/attendance?from=${dayN(3)}&to=${dayN(1)}`))
        .status,
    ).toBe(422);
    expect(
      (await ra.get(`/students/${students[1]!.id}/attendance?from=2020-01-01&to=2024-01-01`))
        .status,
    ).toBe(422);
    // no marks at all → percentage is null, not 0
    const fresh = await newStudent(ra, SR, 'Nomark', sec2);
    expect((await ra.get(`/students/${fresh.id}/attendance`)).body.data.summary).toMatchObject({
      marked_count: 0,
      percentage: null,
    });
  });

  it('daily register matrix', async () => {
    const res = await ra.get(
      `/attendance/register?section_id=${sec}&date_from=${dayN(0)}&date_to=${dayN(6)}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body.data;
    expect(d.dates.map((x: { date: string }) => x.date)).toEqual([0, 1, 2, 3, 4, 6].map(dayN));
    expect(d.dates.map((x: { session_status: string }) => x.session_status)).toEqual([
      'FINAL',
      'FINAL',
      'FINAL',
      'FINAL',
      'FINAL',
      'DRAFT',
    ]);
    expect(d.students).toHaveLength(4);
    const chitra = d.students.find((s: { student: { full_name: string } }) =>
      s.student.full_name.startsWith('Chitra'),
    );
    expect(chitra.cells[dayN(1)].status_code).toBe('HALF_DAY');
    expect(chitra.cells[dayN(2)].status_code).toBe('LATE');
    expect(chitra).toMatchObject({ marked_count: 5, present_units: 4.5, percentage: 90 });
    const anil = d.students.find((s: { student: { full_name: string } }) =>
      s.student.full_name.startsWith('Anil'),
    );
    expect(anil.cells[dayN(6)]).toMatchObject({ status_code: 'ABSENT', session_status: 'DRAFT' }); // shown …
    expect(anil.percentage).toBe(100); // … but not counted until FINAL
    expect(
      (
        await ra.get(
          `/attendance/register?section_id=${sec}&date_from=${dayN(5)}&date_to=${dayN(1)}`,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await ra.get(
          `/attendance/register?section_id=${sec}&date_from=${dayN(-100)}&date_to=${dayN(6)}`,
        )
      ).status,
    ).toBe(422); // > 62 days
  });

  it('monthly report: per-day counts, per-student figures and section totals', async () => {
    const res = await ra.get(`/attendance/reports/monthly?section_id=${sec}&month=${month}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body.data;
    expect(d.summary).toEqual({
      sessions_held: 5,
      sessions_open: 1,
      marked_count: 20,
      present_units: 13.5,
      absent_units: 6.5,
      percentage: 67.5,
    });
    const day1 = d.days.find((x: { date: string }) => x.date === dayN(1));
    expect(day1).toMatchObject({ marked_count: 4, present_units: 1.5, session_status: 'FINAL' });
    expect(day1.counts).toMatchObject({ present: 1, absent: 2, half_day: 1 });
    const pct = Object.fromEntries(
      d.students.map((s: { student: { full_name: string }; percentage: number }) => [
        s.student.full_name.split(' ')[0],
        s.percentage,
      ]),
    );
    expect(pct).toEqual({ Anil: 100, Bela: 60, Chitra: 90, '=Dev': 20 });
    expect(
      (await ra.get(`/attendance/reports/monthly?section_id=${sec}&month=2026-13`)).status,
    ).toBe(422);
  });

  it('defaulters: strictly below the threshold, worst first, filters and pagination', async () => {
    const res = await ra.get('/attendance/reports/defaulters');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.meta).toMatchObject({ threshold_percent: 75, total: 2 });
    expect(
      res.body.data.map((r: { student: { full_name: string }; percentage: number }) => [
        r.student.full_name.split(' ')[0],
        r.percentage,
      ]),
    ).toEqual([
      ['=Dev', 20],
      ['Bela', 60],
    ]);
    expect(res.body.data[0]).toMatchObject({
      marked_count: 5,
      present_units: 1,
      absent_units: 4,
      section: { id: sec },
    });
    // 90 is not below 90, but is below 95; 100 is not below 100
    expect((await ra.get('/attendance/reports/defaulters?threshold=90')).body.meta.total).toBe(2);
    expect(
      (await ra.get('/attendance/reports/defaulters?threshold=95')).body.data.map(
        (r: { percentage: number }) => r.percentage,
      ),
    ).toEqual([20, 60, 90]);
    expect((await ra.get('/attendance/reports/defaulters?threshold=100')).body.meta.total).toBe(3);
    expect((await ra.get('/attendance/reports/defaulters?threshold=0')).body.meta.total).toBe(0);
    expect((await ra.get('/attendance/reports/defaulters?threshold=101')).status).toBe(422);
    // filters
    expect(
      (await ra.get(`/attendance/reports/defaulters?section_id=${sec2}`)).body.meta.total,
    ).toBe(0);
    expect(
      (await ra.get(`/attendance/reports/defaulters?class_id=${SR.classId}`)).body.meta.total,
    ).toBe(2);
    expect(
      (await ra.get(`/attendance/reports/defaulters?class_id=${SR.class2Id}`)).body.meta.total,
    ).toBe(0);
    expect(
      (await ra.get(`/attendance/reports/defaulters?from=${dayN(3)}&to=${dayN(4)}`)).body.data.map(
        (r: { percentage: number }) => r.percentage,
      ),
    ).toEqual([50, 50]);
    const paged = await ra.get('/attendance/reports/defaulters?page=2&page_size=1');
    expect(paged.body.data).toHaveLength(1);
    expect(paged.body.data[0].student.full_name.startsWith('Bela')).toBe(true);
    expect(paged.body.meta.total).toBe(2);
    // the school's own threshold setting is the default
    const cfg = (await ra.get('/attendance/settings')).body.data;
    await ra.patch('/attendance/settings', {
      version: cfg.version,
      defaulter_threshold_percent: 50,
    });
    expect(
      (await ra.get('/attendance/reports/defaulters')).body.data.map(
        (r: { percentage: number }) => r.percentage,
      ),
    ).toEqual([20]);
    await ra.patch('/attendance/settings', {
      version: cfg.version + 1,
      defaulter_threshold_percent: 75,
    });
    expect((await ra.get('/attendance/reports/defaulters')).body.meta.total).toBe(2);
  });

  it("today's dashboard: NOT_STARTED / DRAFT / SUBMITTED / FINAL per section with counts", async () => {
    const res = await ra.get('/attendance/today');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body.data;
    expect(d.date).toBe(today);
    const bySec = Object.fromEntries(
      d.sections.map((s: { section: { id: string } }) => [s.section.id, s]),
    );
    expect(bySec[sec]).toMatchObject({
      state: 'DRAFT',
      roster_size: 4,
      marked_count: 2,
      session_id: raSession,
    });
    expect(bySec[sec].counts).toMatchObject({ present: 1, absent: 1 });
    expect(bySec[sec2]).toMatchObject({
      state: 'NOT_STARTED',
      roster_size: 1,
      marked_count: 0,
      session_id: null,
    }); // 'Nomark'
    expect(d.totals).toMatchObject({
      sections: 2,
      not_started: 1,
      draft: 1,
      submitted: 0,
      final: 0,
      marked: 2,
    });
    // a past day with a FINAL register
    const past = await ra.get(`/attendance/today?date=${dayN(1)}`);
    const row = past.body.data.sections.find(
      (s: { section: { id: string } }) => s.section.id === sec,
    );
    expect(row).toMatchObject({ state: 'FINAL', roster_size: 4, marked_count: 4 });
    expect(row.counts).toMatchObject({ present: 1, absent: 2, half_day: 1 });
    expect((await ra.get(`/attendance/today?date=${inDays(5)}`)).status).toBe(422);
  });

  it('exports CSV (audited, permission-gated, formula-safe)', async () => {
    const reg = await ra.get(
      `/attendance/register/export?section_id=${sec}&date_from=${dayN(0)}&date_to=${dayN(4)}`,
    );
    expect(reg.status).toBe(200);
    expect(reg.headers['content-type']).toMatch(/text\/csv/);
    const lines = reg.text.trim().split('\n');
    expect(lines[0]).toBe(
      [
        'Student number',
        'Student',
        ...[0, 1, 2, 3, 4].map(dayN),
        'Marked days',
        'Present units',
        'Absent units',
        'Attendance %',
      ].join(','),
    );
    expect(lines).toHaveLength(5);
    expect(reg.text).toContain("'=Dev"); // formula neutralised
    expect(lines.find((l) => l.includes('Chitra'))).toMatch(
      /PRESENT,HALF_DAY,LATE,PRESENT,PRESENT,5,4.5,0.5,90$/,
    );
    const def = await ra.get('/attendance/reports/defaulters/export');
    expect(def.text.trim().split('\n')).toHaveLength(3);
    expect(def.text.split('\n')[0]).toContain('Attendance %');
    const mon = await ra.get(`/attendance/reports/monthly/export?section_id=${sec}&month=${month}`);
    expect(mon.text.trim().split('\n')).toHaveLength(5);
    const audit = await h.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.tenantId, R.tenantId), eq(auditLogs.action, 'ATTENDANCE_EXPORTED')));
    expect(audit).toHaveLength(3);
    const ev = await h.deps.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.tenantId, R.tenantId),
          eq(outboxEvents.eventType, 'attendance.exported'),
        ),
      );
    expect(ev.map((e) => (e.payload as { report: string }).report).sort()).toEqual([
      'defaulters',
      'monthly',
      'register',
    ]);
    // reading is not enough: exporting needs attendance.export
    const teacher = await h.addMember(ra, [{ role_id: await h.roleId(ra, 'TEACHER') }]);
    expect(
      (
        await teacher.api.get(
          `/attendance/register?section_id=${sec}&date_from=${dayN(0)}&date_to=${dayN(4)}`,
        )
      ).status,
    ).toBe(200);
    for (const url of [
      `/attendance/register/export?section_id=${sec}&date_from=${dayN(0)}&date_to=${dayN(4)}`,
      '/attendance/reports/defaulters/export',
      `/attendance/reports/monthly/export?section_id=${sec}&month=${month}`,
    ])
      expect((await teacher.api.get(url)).status, url).toBe(403);
    // the principal has it
    const principal = await h.addMember(ra, [{ role_id: await h.roleId(ra, 'PRINCIPAL') }]);
    expect((await principal.api.get('/attendance/reports/defaulters/export')).status).toBe(200);
  });
});
