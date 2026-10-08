import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  outboxEvents,
  teacherHistory,
  teachers,
  teachingAssignments,
} from '../../src/db/schema/index.js';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let B: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;

interface Structure {
  yearId: string;
  classId: string;
  class2Id: string;
  secA: string;
  secB: string;
}
let S: Structure;
let SB: Structure;
let mathWide: string; // class-wide Mathematics offering, school A
let sciSecA: string; // section-level Science offering, school A

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function structure(a: Api, label: string): Promise<Structure> {
  const y = await a.post('/academic-years', {
    code: `Y-${label}`,
    name: `Year ${label}`,
    start_date: '2026-04-01',
    end_date: '2027-03-31',
  });
  const yearId = y.body.data.id;
  await a.post(`/academic-years/${yearId}/activate`, { complete_current: true });
  const cls = async (c: string, seq: number) =>
    (await a.post('/academic-classes', { code: `${c}${label}`, name: c, sequence: seq })).body.data
      .id;
  const classId = await cls('Grade7', 7);
  const class2Id = await cls('Grade8', 8);
  const sec = async (c: string) =>
    (
      await a.post(`/academic-years/${yearId}/sections`, {
        class_id: classId,
        code: c,
        name: `Section ${c}`,
      })
    ).body.data.id;
  return { yearId, classId, class2Id, secA: await sec('A'), secB: await sec('B') };
}

async function newSubject(a: Api, name: string) {
  const res = await a.post('/subjects', { code: uniq('SUB').toUpperCase(), name });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}
async function offering(a: Api, st: Structure, subjectId: string, sectionId?: string) {
  const res = await a.post('/subject-offerings', {
    academic_year_id: st.yearId,
    subject_id: subjectId,
    class_id: st.classId,
    ...(sectionId ? { section_id: sectionId } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}
/** A brand-new class-wide offering, so tests never collide on the unique offering. */
async function freshOffering(a: Api = api, st: Structure = S) {
  return offering(a, st, await newSubject(a, uniq('Subj')));
}

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  B = await h.provisionSchool();
  api = A.admin.api;
  S = await structure(api, 'A');
  SB = await structure(B.admin.api, 'B');
  mathWide = await offering(api, S, await newSubject(api, 'Mathematics'));
  sciSecA = await offering(api, S, await newSubject(api, 'Science'), S.secA);
});
afterAll(() => h.close());

const person = (first: string, last = uniq('Fam'), extra: object = {}) => ({
  first_name: first,
  last_name: last,
  ...extra,
});
type T = { id: string; version: number; status: string; teacher_number: string; email: string };
async function newTeacher(first: string, body: object = {}, a: Api = api) {
  const res = await a.post('/teachers', person(first, uniq('Fam'), body));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as T;
}
const withEmail = () => ({ email: `${uniq('teacher')}@school.test` });
async function assign(teacherId: string, offeringId: string, extra: object = {}, a: Api = api) {
  const res = await a.post(`/teachers/${teacherId}/assignments`, {
    subject_offering_id: offeringId,
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; status: string; version: number };
}
const cmd = (a: Api, id: string, c: string, body: object = {}) =>
  a.post(`/teachers/${id}/${c}`, body);

describe('creating teachers and staff', () => {
  it('creates with defaults, a generated number, inline qualifications and history', async () => {
    const res = await api.post(
      '/teachers',
      person('Meera', uniq('Iyer'), {
        gender: 'FEMALE',
        date_of_birth: '1985-03-12',
        email: `${uniq('meera')}@school.test`,
        phone: '+91 98765 22222',
        joining_date: '2019-06-01',
        employment_type: 'FULL_TIME',
        department: 'Science',
        designation: 'Senior Teacher',
        qualifications: [
          {
            type: 'DEGREE',
            title: 'M.Sc. Physics',
            institution: 'University of Pune',
            completion_year: 2008,
          },
          { type: 'CERTIFICATION', title: 'CTET' },
        ],
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const t = res.body.data;
    expect(t.status).toBe('ACTIVE');
    expect(t.staff_type).toBe('TEACHING');
    expect(t.teacher_number).toMatch(/^TCH-\d{4}-\d{5}$/);
    expect(t.full_name).toMatch(/^Meera /);
    expect(t.has_login).toBe(false);
    expect(t.version).toBe(1);
    expect(t.qualifications.map((q: { title: string }) => q.title)).toEqual(
      expect.arrayContaining(['M.Sc. Physics', 'CTET']),
    );
    expect(t.active_assignments).toEqual([]);
    expect(t.portal_access).toMatchObject({ status: 'NONE', membership_id: null });
    // No payroll or credential fields exist on the record.
    expect(Object.keys(t).join()).not.toMatch(/salary|payroll|password|user_id/);
    const history = await api.get(`/teachers/${t.id}/history`);
    const types = history.body.data.map((e: { event_type: string }) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(['TEACHER_CREATED', 'QUALIFICATION_ADDED']));
  });

  it('can start PROSPECTIVE or ONBOARDING, and non-teaching staff are supported', async () => {
    const p = await newTeacher('Cand', { status: 'PROSPECTIVE' });
    expect(p.status).toBe('PROSPECTIVE');
    const o = await newTeacher('Onb', { status: 'ONBOARDING' });
    expect(o.status).toBe('ONBOARDING');
    const clerk = await newTeacher('Clerk', { staff_type: 'NON_TEACHING', designation: 'Clerk' });
    expect((await api.get(`/teachers/${clerk.id}`)).body.data.staff_type).toBe('NON_TEACHING');
    // A creation request cannot start in a leaving status.
    const bad = await api.post('/teachers', person('Bad', uniq('Fam'), { status: 'RESIGNED' }));
    expect(bad.status).toBe(422);
    expect(code(bad)).toBe('VALIDATION_ERROR');
    expect(
      (await api.post('/teachers', person('Bad', uniq('Fam'), { staff_type: 'JANITOR' }))).status,
    ).toBe(422);
  });

  it('numbers teachers per school without gaps or repeats, even in parallel', async () => {
    const created = await Promise.all(
      Array.from({ length: 6 }, (_, i) => api.post('/teachers', person(`Par${i}`, uniq('Num')))),
    );
    expect(created.every((r) => r.status === 201)).toBe(true);
    const numbers = created.map((r) => r.body.data.teacher_number as string);
    expect(new Set(numbers).size).toBe(6);
    const seqs = numbers.map((n) => Number(n.split('-')[2])).sort((a, b) => a - b);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    // Another school has its own sequence.
    const other = await B.admin.api.post('/teachers', person('Other', uniq('Num')));
    expect(other.body.data.teacher_number).toMatch(/^TCH-\d{4}-\d{5}$/);
    expect(Number(other.body.data.teacher_number.split('-')[2])).toBeLessThan(seqs[0]! + 6);
  });

  it('accepts a school-supplied number, unique per school', async () => {
    const num = uniq('emp').toUpperCase();
    const first = await api.post('/teachers', person('Own', uniq('Fam'), { teacher_number: num }));
    expect(first.status).toBe(201);
    expect(first.body.data.teacher_number).toBe(num);
    const clash = await api.post('/teachers', person('Own2', uniq('Fam'), { teacher_number: num }));
    expect(clash.status).toBe(409);
    expect(code(clash)).toBe('DUPLICATE_RESOURCE');
    // Same number is fine in another school.
    expect(
      (await B.admin.api.post('/teachers', person('Own', uniq('Fam'), { teacher_number: num })))
        .status,
    ).toBe(201);
  });

  it('warns about duplicates (email, phone, name + date of birth) and creates only on confirmation', async () => {
    const email = `${uniq('dup')}@school.test`;
    const phone = '+91 90000 12345';
    const orig = (
      await api.post(
        '/teachers',
        person('Dup', 'Original', { email, phone, date_of_birth: '1980-01-01' }),
      )
    ).body.data;

    const byEmail = await api.post(
      '/teachers',
      person('Someone', uniq('Else'), { email: email.toUpperCase() }),
    );
    expect(byEmail.status).toBe(409);
    expect(code(byEmail)).toBe('CONFIRMATION_REQUIRED');
    expect(byEmail.body.error.details.duplicates[0]).toMatchObject({
      id: orig.id,
      teacher_number: orig.teacher_number,
      matched_on: ['email'],
    });

    const byPhone = await api.post('/teachers', person('Some', uniq('Else'), { phone }));
    expect(code(byPhone)).toBe('CONFIRMATION_REQUIRED');
    expect(byPhone.body.error.details.duplicates[0].matched_on).toEqual(['phone']);

    const byName = await api.post(
      '/teachers',
      person('dup', 'ORIGINAL', { date_of_birth: '1980-01-01' }),
    );
    expect(code(byName)).toBe('CONFIRMATION_REQUIRED');
    expect(byName.body.error.details.duplicates[0].matched_on).toEqual(['name_and_date_of_birth']);

    // Same name, different birth date and no other signal: not a duplicate.
    expect(
      (await api.post('/teachers', person('Dup', 'Original', { date_of_birth: '1990-02-02' })))
        .status,
    ).toBe(201);

    // Nothing was created by the refused attempts; confirming creates (no auto-merge).
    const confirmed = await api.post(
      '/teachers',
      person('Some', uniq('Else'), { phone, confirm_duplicate: true }),
    );
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.data.id).not.toBe(orig.id);
    // Another school's teachers are never reported.
    expect(
      (await B.admin.api.post('/teachers', person('Dup', 'Original', { email, phone }))).status,
    ).toBe(201);
  });
});

describe('reading and updating', () => {
  it('lists with filters, search and paging', async () => {
    const dept = uniq('Dept');
    const a = await newTeacher('Filt', { department: dept, employment_type: 'PART_TIME' });
    const b = await newTeacher('Filt', {
      department: dept,
      staff_type: 'NON_TEACHING',
      status: 'ONBOARDING',
    });
    const c = await newTeacher('Filt', { department: dept, ...withEmail() });
    const q = async (qs: string) =>
      (await api.get(`/teachers?department=${dept}&${qs}`)).body.data.map(
        (t: { id: string }) => t.id,
      );
    expect(await q('')).toHaveLength(3);
    expect(await q('staff_type=NON_TEACHING')).toEqual([b.id]);
    expect(await q('status=ONBOARDING')).toEqual([b.id]);
    expect(await q('employment_type=PART_TIME')).toEqual([a.id]);
    expect(await q('status=RESIGNED')).toEqual([]);
    expect(await q(`search=${c.teacher_number}`)).toEqual([c.id]);
    const page = await api.get(`/teachers?department=${dept}&page_size=2&page=2`);
    expect(page.body.meta).toEqual({ page: 2, page_size: 2, total: 3 });
    expect(page.body.data).toHaveLength(1);
    expect((await api.get('/teachers?sort=nonsense')).status).toBe(422);
    expect((await api.get('/teachers?status=NOPE')).status).toBe(422);
    const row = (await api.get(`/teachers?department=${dept}&search=${a.teacher_number}`)).body
      .data[0];
    expect(row).toMatchObject({ active_assignment_count: 0, has_login: false });
  });

  it('updates with optimistic concurrency and never edits the status', async () => {
    const t = await newTeacher('Edit', { department: 'Maths' });
    const ok = await api.patch(`/teachers/${t.id}`, {
      version: t.version,
      designation: 'HOD',
      middle_name: 'Kumar',
      department: null,
      status: 'RESIGNED', // ignored: lifecycle only changes through commands
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      version: 2,
      designation: 'HOD',
      middle_name: 'Kumar',
      department: null,
      status: 'ACTIVE',
    });
    const stale = await api.patch(`/teachers/${t.id}`, { version: 1, designation: 'Late' });
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe('CONFLICT');
    expect(stale.body.error.details.current_version).toBe(2);
    expect((await api.patch(`/teachers/${t.id}`, { designation: 'No version' })).status).toBe(422);
    const types = (await api.get(`/teachers/${t.id}/history`)).body.data.map(
      (e: { event_type: string }) => e.event_type,
    );
    expect(types).toContain('TEACHER_UPDATED');
  });

  it('refuses number clashes and edits of archived teachers', async () => {
    const one = await newTeacher('One');
    const two = await newTeacher('Two');
    const clash = await api.patch(`/teachers/${two.id}`, {
      version: two.version,
      teacher_number: one.teacher_number,
    });
    expect(clash.status).toBe(409);
    expect(code(clash)).toBe('DUPLICATE_RESOURCE');
    await cmd(api, two.id, 'deactivate', { reason: 'Left' });
    await cmd(api, two.id, 'archive');
    const edit = await api.patch(`/teachers/${two.id}`, { version: 99, designation: 'x' });
    expect(edit.status).toBe(422);
    const cur = (await api.get(`/teachers/${two.id}`)).body.data;
    const arch = await api.patch(`/teachers/${two.id}`, { version: cur.version, designation: 'x' });
    expect(arch.status).toBe(422);
    expect(code(arch)).toBe('INVALID_STATE');
  });

  it('rejects malformed input', async () => {
    expect((await api.post('/teachers', { last_name: 'NoFirst' })).status).toBe(422);
    expect((await api.post('/teachers', person('X', 'Y', { email: 'nope' }))).status).toBe(422);
    expect(
      (await api.post('/teachers', person('X', 'Y', { date_of_birth: '2999-01-01' }))).status,
    ).toBe(422);
    expect((await api.get('/teachers/not-a-uuid')).status).toBe(422);
  });
});

describe('lifecycle commands', () => {
  it('walks the whole lifecycle with history, exit data and version bumps', async () => {
    const t = await newTeacher('Life', { status: 'PROSPECTIVE', joining_date: '2020-01-01' });
    const step = async (c: string, body: object, to: string) => {
      const res = await cmd(api, t.id, c, body);
      expect(res.status, `${c}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body.data.status).toBe(to);
      return res.body.data;
    };
    await step('onboard', {}, 'ONBOARDING');
    await step('activate', {}, 'ACTIVE');
    await step('start-leave', { reason: 'Maternity' }, 'ON_LEAVE');
    await step('return-from-leave', {}, 'ACTIVE');
    await step('deactivate', { reason: 'Career break' }, 'INACTIVE');
    await step('activate', {}, 'ACTIVE');
    const resigned = await step(
      'resign',
      { reason: 'Moving abroad', exit_date: inDays(-1) },
      'RESIGNED',
    );
    expect(resigned).toMatchObject({ exit_date: inDays(-1), exit_reason: 'Moving abroad' });
    await step('archive', {}, 'ARCHIVED');
    const restored = await step('restore', {}, 'INACTIVE');
    expect(restored.exit_date).toBe(inDays(-1)); // kept while INACTIVE
    const back = await step('activate', {}, 'ACTIVE'); // re-hire clears the exit; history keeps it
    expect(back).toMatchObject({ exit_date: null, exit_reason: null });
    expect(back.version).toBeGreaterThanOrEqual(10);

    const history = (await api.get(`/teachers/${t.id}/history`)).body.data as {
      event_type: string;
      from_status: string | null;
      to_status: string | null;
      reason: string | null;
    }[];
    const types = history.map((e) => e.event_type);
    expect(types).toEqual(
      expect.arrayContaining([
        'TEACHER_CREATED',
        'TEACHER_ONBOARD',
        'TEACHER_START_LEAVE',
        'TEACHER_RETURN_FROM_LEAVE',
        'TEACHER_DEACTIVATE',
        'TEACHER_RESIGN',
        'TEACHER_ARCHIVE',
        'TEACHER_RESTORE',
      ]),
    );
    expect(history.find((e) => e.event_type === 'TEACHER_RESIGN')).toMatchObject({
      from_status: 'ACTIVE',
      to_status: 'RESIGNED',
      reason: 'Moving abroad',
    });
  });

  it('terminates with exit information', async () => {
    const t = await newTeacher('Term');
    const res = await cmd(api, t.id, 'terminate', { reason: 'Misconduct' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'TERMINATED',
      exit_date: today(),
      exit_reason: 'Misconduct',
    });
    expect((await cmd(api, t.id, 'archive')).body.data.status).toBe('ARCHIVED');
  });

  it('refuses invalid transitions with INVALID_STATE', async () => {
    const active = await newTeacher('Inv');
    const prospective = await newTeacher('Inv', { status: 'PROSPECTIVE' });
    const cases: [string, string, object?][] = [
      [active.id, 'onboard'],
      [active.id, 'activate'],
      [active.id, 'return-from-leave'],
      [active.id, 'restore'],
      [active.id, 'archive'],
      [prospective.id, 'start-leave'],
      [prospective.id, 'deactivate', { reason: 'nope' }],
      [prospective.id, 'resign', { reason: 'nope' }],
      [prospective.id, 'terminate', { reason: 'nope' }],
      [prospective.id, 'return-from-leave'],
    ];
    for (const [id, c, body] of cases) {
      const res = await cmd(api, id, c, body ?? {});
      expect(res.status, `${c}: ${JSON.stringify(res.body)}`).toBe(422);
      expect(code(res), c).toBe('INVALID_STATE');
    }
    const left = await newTeacher('Left');
    await cmd(api, left.id, 'resign', { reason: 'Gone' });
    for (const c of ['activate', 'start-leave', 'onboard', 'restore'])
      expect(code(await cmd(api, left.id, c)), c).toBe('INVALID_STATE');
    expect(code(await cmd(api, left.id, 'resign', { reason: 'Again' }))).toBe('INVALID_STATE');
    // Status unchanged by all refusals.
    expect((await api.get(`/teachers/${left.id}`)).body.data.status).toBe('RESIGNED');
    expect((await cmd(api, 'nonsense', 'onboard')).status).toBe(422);
  });

  it('requires reasons and sane exit dates', async () => {
    const t = await newTeacher('Rules', { joining_date: '2021-05-05' });
    for (const c of ['deactivate', 'resign', 'terminate']) {
      const res = await cmd(api, t.id, c, {});
      expect(res.status, c).toBe(422);
      expect(code(res), c).toBe('OPERATION_NOT_ALLOWED');
      expect(res.body.error.details.field).toBe('reason');
    }
    const future = await cmd(api, t.id, 'resign', { reason: 'Notice', exit_date: inDays(3) });
    expect(code(future)).toBe('OPERATION_NOT_ALLOWED');
    const early = await cmd(api, t.id, 'resign', { reason: 'Notice', exit_date: '2021-01-01' });
    expect(code(early)).toBe('OPERATION_NOT_ALLOWED');
    const stray = await cmd(api, t.id, 'deactivate', { reason: 'Left', exit_date: today() });
    expect(code(stray)).toBe('OPERATION_NOT_ALLOWED');
    expect((await api.get(`/teachers/${t.id}`)).body.data.status).toBe('ACTIVE');
  });

  it('ending employment closes open assignments in the same transaction', async () => {
    for (const [command, status] of [
      ['deactivate', 'INACTIVE'],
      ['resign', 'RESIGNED'],
      ['terminate', 'TERMINATED'],
    ] as const) {
      const t = await newTeacher(`Leave${command}`);
      const running = await assign(t.id, await freshOffering());
      const future = await assign(t.id, await freshOffering(), { start_date: inDays(30) });
      const res = await cmd(api, t.id, command, { reason: 'Leaving the school' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.status).toBe(status);
      expect(res.body.data.active_assignments).toEqual([]);
      const a1 = (await api.get(`/teaching-assignments/${running.id}`)).body.data;
      expect(a1).toMatchObject({ status: 'ENDED', end_date: today() });
      expect(a1.reason).toBe('Leaving the school');
      // An assignment that never started is cancelled instead of "ended".
      expect((await api.get(`/teaching-assignments/${future.id}`)).body.data.status).toBe(
        'CANCELLED',
      );
      const history = (await api.get(`/teachers/${t.id}/history`)).body.data as {
        event_type: string;
        details: { assignments_ended?: number } | null;
      }[];
      expect(
        history.find((e) => e.event_type === `TEACHER_${command.toUpperCase()}`)!.details,
      ).toEqual({ assignments_ended: 2 });
      expect(history.map((e) => e.event_type)).toContain('TEACHING_ASSIGNMENT_ENDED');
      const list = await api.get(`/teachers/${t.id}/assignments?status=ACTIVE`);
      expect(list.body.data).toHaveLength(0);
      expect((await api.get(`/teachers/${t.id}/assignments`)).body.data).toHaveLength(2);
    }
  });

  it('keeps assignments while on leave, but a teacher on leave gets no new ones', async () => {
    const t = await newTeacher('Leave');
    const a = await assign(t.id, await freshOffering());
    expect((await cmd(api, t.id, 'start-leave', { reason: 'Sabbatical' })).status).toBe(200);
    expect((await api.get(`/teaching-assignments/${a.id}`)).body.data.status).toBe('ACTIVE');
    const denied = await api.post(`/teachers/${t.id}/assignments`, {
      subject_offering_id: await freshOffering(),
    });
    expect(denied.status).toBe(422);
    expect(code(denied)).toBe('INVALID_STATE');
    await cmd(api, t.id, 'return-from-leave');
    expect((await api.get(`/teachers/${t.id}/assignments`)).body.data).toHaveLength(1);
  });

  it('is atomic: a refused command changes nothing', async () => {
    const t = await newTeacher('Atomic');
    await assign(t.id, await freshOffering());
    const before = await h.deps.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.tenantId, A.tenantId));
    const res = await cmd(api, t.id, 'resign', { reason: 'Notice', exit_date: inDays(9) });
    expect(res.status).toBe(422);
    const after = await h.deps.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.tenantId, A.tenantId));
    expect(after.length).toBe(before.length);
    expect((await api.get(`/teachers/${t.id}`)).body.data.active_assignments).toHaveLength(1);
  });
});

describe('teaching assignments', () => {
  it('assigns a teacher to an offering and embeds the offering context', async () => {
    const t = await newTeacher('Assign');
    const res = await api.post(`/teachers/${t.id}/assignments`, {
      subject_offering_id: sciSecA,
      role: 'PRIMARY',
      reason: 'Timetable 2026',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const a = res.body.data;
    expect(a).toMatchObject({
      status: 'ACTIVE',
      role: 'PRIMARY',
      start_date: today(),
      end_date: null,
      subject_offering_id: sciSecA,
      version: 1,
      reason: 'Timetable 2026',
    });
    expect(a.teacher).toMatchObject({ id: t.id, teacher_number: t.teacher_number });
    expect(a.academic_year).toEqual({ id: S.yearId, code: 'Y-A' });
    expect(a.class).toMatchObject({ id: S.classId, name: 'Grade7' });
    expect(a.section).toMatchObject({ id: S.secA, name: 'Section A' });
    expect(a.subject).toMatchObject({ name: 'Science' });
    // Class-wide offering: no section.
    const wide = await assign(t.id, mathWide);
    expect((await api.get(`/teaching-assignments/${wide.id}`)).body.data.section).toBeNull();
    const detail = (await api.get(`/teachers/${t.id}`)).body.data;
    expect(detail.active_assignments).toHaveLength(2);
    const row = (await api.get(`/teachers?search=${t.teacher_number}`)).body.data[0];
    expect(row.active_assignment_count).toBe(2);
  });

  it('allows several teachers on one offering (primary, co-teacher, substitute)', async () => {
    const off = await freshOffering();
    const [p, c, s] = await Promise.all([newTeacher('Prim'), newTeacher('Co'), newTeacher('Sub')]);
    await assign(p.id, off, { role: 'PRIMARY' });
    await assign(c.id, off, { role: 'CO_TEACHER' });
    await assign(s.id, off, { role: 'SUBSTITUTE', start_date: inDays(-2) });
    const list = await api.get(`/teaching-assignments?subject_offering_id=${off}`);
    expect(list.body.data).toHaveLength(3);
    expect(list.body.data.map((x: { role: string }) => x.role).sort()).toEqual([
      'CO_TEACHER',
      'PRIMARY',
      'SUBSTITUTE',
    ]);
  });

  it('refuses a second open assignment for the same teacher and offering', async () => {
    const t = await newTeacher('Twice');
    const off = await freshOffering();
    const first = await assign(t.id, off);
    const again = await api.post(`/teachers/${t.id}/assignments`, {
      subject_offering_id: off,
      role: 'CO_TEACHER',
    });
    expect(again.status).toBe(409);
    expect(code(again)).toBe('DUPLICATE_RESOURCE');
    expect(again.body.error.details.assignment_id).toBe(first.id);
    // After ending, the same teacher can be assigned again — history is kept.
    await api.post(`/teaching-assignments/${first.id}/end`, { reason: 'Rotation' });
    await assign(t.id, off);
    expect((await api.get(`/teachers/${t.id}/assignments`)).body.data).toHaveLength(2);
  });

  it('gives exactly one winner when the same assignment is created in parallel', async () => {
    const t = await newTeacher('Race');
    const off = await freshOffering();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api.post('/teaching-assignments', { teacher_id: t.id, subject_offering_id: off }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const rest = results.filter((r) => r.status !== 201);
    expect(rest.every((r) => r.status === 409 && code(r) === 'DUPLICATE_RESOURCE')).toBe(true);
  });

  it('enforces the database rule too: one open row per teacher and offering', async () => {
    const t = await newTeacher('Db');
    const off = await freshOffering();
    const row = {
      tenantId: A.tenantId,
      teacherId: t.id,
      subjectOfferingId: off,
      startDate: today(),
    };
    await h.deps.db.insert(teachingAssignments).values(row);
    await expect(h.deps.db.insert(teachingAssignments).values(row)).rejects.toThrow();
    // Closed rows are not restricted.
    await h.deps.db
      .insert(teachingAssignments)
      .values({ ...row, status: 'ENDED', endDate: today() });
    await h.deps.db
      .insert(teachingAssignments)
      .values({ ...row, status: 'ENDED', endDate: today() });
  });

  it('only accepts ACTIVE offerings of an upcoming or active year', async () => {
    const t = await newTeacher('Rules');
    const off = await freshOffering();
    expect((await api.post(`/subject-offerings/${off}/deactivate`)).status).toBe(200);
    const inactive = await api.post(`/teachers/${t.id}/assignments`, { subject_offering_id: off });
    expect(inactive.status).toBe(422);
    expect(code(inactive)).toBe('OPERATION_NOT_ALLOWED');
    expect(inactive.body.error.details.offering_status).toBe('INACTIVE');
    // A DRAFT year is not open for teaching yet; once opened (UPCOMING) it is.
    const draft = (
      await api.post('/academic-years', {
        code: uniq('NEXT'),
        name: 'Next year',
        start_date: '2030-04-01',
        end_date: '2031-03-31',
      })
    ).body.data.id;
    const subj = await newSubject(api, 'Future subject');
    const futureOffering = (
      await api.post('/subject-offerings', {
        academic_year_id: draft,
        subject_id: subj,
        class_id: S.classId,
      })
    ).body.data.id;
    const notOpen = await api.post(`/teachers/${t.id}/assignments`, {
      subject_offering_id: futureOffering,
    });
    expect(notOpen.status).toBe(422);
    expect(code(notOpen)).toBe('OPERATION_NOT_ALLOWED');
    expect(notOpen.body.error.details.academic_year_status).toBe('DRAFT');
    await api.post(`/academic-years/${draft}/open`);
    const upcoming = await api.post(`/teachers/${t.id}/assignments`, {
      subject_offering_id: futureOffering,
      start_date: '2030-04-01',
    });
    expect(upcoming.status, JSON.stringify(upcoming.body)).toBe(201);
    expect(upcoming.body.data.academic_year.id).toBe(draft);
  });

  it('refuses teachers who are not ACTIVE', async () => {
    const off = await freshOffering();
    for (const status of ['PROSPECTIVE', 'ONBOARDING']) {
      const t = await newTeacher('NotActive', { status });
      const res = await api.post(`/teachers/${t.id}/assignments`, { subject_offering_id: off });
      expect(res.status, status).toBe(422);
      expect(code(res), status).toBe('INVALID_STATE');
      expect(res.body.error.details.teacher_status).toBe(status);
    }
    const gone = await newTeacher('Gone');
    await cmd(api, gone.id, 'deactivate', { reason: 'Left' });
    expect(
      code(await api.post(`/teachers/${gone.id}/assignments`, { subject_offering_id: off })),
    ).toBe('INVALID_STATE');
  });

  it('ends a running assignment and cancels a future or mistaken one', async () => {
    const t = await newTeacher('EndCancel');
    const running = await assign(t.id, await freshOffering(), { start_date: inDays(-10) });
    const ended = await api.post(`/teaching-assignments/${running.id}/end`, {
      end_date: inDays(-1),
      reason: 'Reassigned to Grade 8',
    });
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body.data).toMatchObject({
      status: 'ENDED',
      end_date: inDays(-1),
      reason: 'Reassigned to Grade 8',
      version: 2,
    });
    expect((await api.post(`/teaching-assignments/${running.id}/end`, {})).status).toBe(422);
    expect(
      code(await api.post(`/teaching-assignments/${running.id}/cancel`, { reason: 'Oops' })),
    ).toBe('INVALID_STATE');

    const bad = await assign(t.id, await freshOffering(), { start_date: inDays(-3) });
    const early = await api.post(`/teaching-assignments/${bad.id}/end`, { end_date: inDays(-5) });
    expect(early.status).toBe(422);
    expect(code(early)).toBe('OPERATION_NOT_ALLOWED');
    const future = await api.post(`/teaching-assignments/${bad.id}/end`, { end_date: inDays(2) });
    expect(code(future)).toBe('OPERATION_NOT_ALLOWED');

    const planned = await assign(t.id, await freshOffering(), { start_date: inDays(20) });
    const notStarted = await api.post(`/teaching-assignments/${planned.id}/end`, {});
    expect(notStarted.status).toBe(422);
    expect(code(notStarted)).toBe('OPERATION_NOT_ALLOWED');
    expect((await api.post(`/teaching-assignments/${planned.id}/cancel`, {})).status).toBe(422); // reason required
    const cancelled = await api.post(`/teaching-assignments/${planned.id}/cancel`, {
      reason: 'Entered in error',
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', reason: 'Entered in error' });
    // Cancelling frees the slot for a correct assignment.
    const bad2 = (await api.get(`/teaching-assignments/${planned.id}`)).body.data;
    await assign(t.id, bad2.subject_offering_id);
    const types = (await api.get(`/teachers/${t.id}/history`)).body.data.map(
      (e: { event_type: string }) => e.event_type,
    );
    expect(types).toEqual(
      expect.arrayContaining([
        'TEACHING_ASSIGNED',
        'TEACHING_ASSIGNMENT_ENDED',
        'TEACHING_ASSIGNMENT_CANCELLED',
      ]),
    );
  });

  it('filters the assignment list by teacher, offering, year, class, section and status', async () => {
    const t = await newTeacher('Filter');
    const secOff = await offering(api, S, await newSubject(api, uniq('Sec')), S.secB);
    const wide = await freshOffering();
    const a1 = await assign(t.id, secOff);
    const a2 = await assign(t.id, wide);
    await api.post(`/teaching-assignments/${a2.id}/end`, {});
    const ids = async (qs: string) =>
      (await api.get(`/teaching-assignments?teacher_id=${t.id}&${qs}`)).body.data.map(
        (x: { id: string }) => x.id,
      );
    expect(await ids('')).toHaveLength(2);
    expect(await ids('status=ACTIVE')).toEqual([a1.id]);
    expect(await ids('status=ENDED')).toEqual([a2.id]);
    expect(await ids(`section_id=${S.secB}`)).toEqual([a1.id]);
    expect(await ids(`class_id=${S.classId}`)).toHaveLength(2);
    expect(await ids(`class_id=${S.class2Id}`)).toEqual([]);
    expect(await ids(`academic_year_id=${S.yearId}`)).toHaveLength(2);
    expect(await ids(`subject_offering_id=${wide}`)).toEqual([a2.id]);
    expect(
      (await api.get(`/teaching-assignments?search=${t.teacher_number}`)).body.data,
    ).toHaveLength(2);
    expect((await api.get('/teaching-assignments?status=NOPE')).status).toBe(422);
  });

  it("rejects another school's offering or teacher as not found, and the database refuses too", async () => {
    const t = await newTeacher('Iso');
    const bOffering = await freshOffering(B.admin.api, SB);
    const res = await api.post(`/teachers/${t.id}/assignments`, { subject_offering_id: bOffering });
    expect(res.status).toBe(404);
    const bTeacher = await newTeacher('BTeach', {}, B.admin.api);
    expect(
      (await api.post(`/teachers/${bTeacher.id}/assignments`, { subject_offering_id: mathWide }))
        .status,
    ).toBe(404);
    expect(
      (
        await api.post('/teaching-assignments', {
          teacher_id: bTeacher.id,
          subject_offering_id: mathWide,
        })
      ).status,
    ).toBe(404);
    // Bypass the service: the composite foreign key still refuses the cross-school row.
    await expect(
      h.deps.db.insert(teachingAssignments).values({
        tenantId: A.tenantId,
        teacherId: t.id,
        subjectOfferingId: bOffering, // belongs to school B
        startDate: today(),
      }),
    ).rejects.toThrow();
    await expect(
      h.deps.db.insert(teachingAssignments).values({
        tenantId: A.tenantId,
        teacherId: bTeacher.id, // belongs to school B
        subjectOfferingId: mathWide,
        startDate: today(),
      }),
    ).rejects.toThrow();
  });
});

describe('qualifications', () => {
  it('adds, lists, edits (with versions) and removes qualifications', async () => {
    const t = await newTeacher('Qual');
    const add = await api.post(`/teachers/${t.id}/qualifications`, {
      type: 'DEGREE',
      title: 'B.Ed',
      institution: 'Delhi University',
      field_of_study: 'Education',
      completion_year: 2012,
    });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    const q = add.body.data;
    expect(q).toMatchObject({
      type: 'DEGREE',
      title: 'B.Ed',
      institution: 'Delhi University',
      field_of_study: 'Education',
      completion_year: 2012,
      status: 'ACTIVE',
      version: 1,
      teacher_id: t.id,
    });
    const second = (
      await api.post(`/teachers/${t.id}/qualifications`, {
        type: 'LICENSE',
        title: 'State licence',
      })
    ).body.data;
    expect((await api.get(`/teachers/${t.id}/qualifications`)).body.data).toHaveLength(2);

    const edit = await api.patch(`/teachers/${t.id}/qualifications/${q.id}`, {
      version: 1,
      title: 'B.Ed (Hons)',
      institution: null,
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body.data).toMatchObject({ title: 'B.Ed (Hons)', institution: null, version: 2 });
    const stale = await api.patch(`/teachers/${t.id}/qualifications/${q.id}`, {
      version: 1,
      title: 'Late',
    });
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe('CONFLICT');

    expect((await api.delete(`/teachers/${t.id}/qualifications/${second.id}`)).status).toBe(204);
    expect((await api.delete(`/teachers/${t.id}/qualifications/${second.id}`)).status).toBe(404);
    const left = (await api.get(`/teachers/${t.id}`)).body.data.qualifications;
    expect(left.map((x: { id: string }) => x.id)).toEqual([q.id]);
    const types = (await api.get(`/teachers/${t.id}/history`)).body.data.map(
      (e: { event_type: string }) => e.event_type,
    );
    expect(types).toEqual(
      expect.arrayContaining([
        'QUALIFICATION_ADDED',
        'QUALIFICATION_UPDATED',
        'QUALIFICATION_REMOVED',
      ]),
    );
  });

  it('validates input and never crosses teachers or schools', async () => {
    const t = await newTeacher('Q1');
    const other = await newTeacher('Q2');
    const q = (await api.post(`/teachers/${t.id}/qualifications`, { type: 'OTHER', title: 'Yoga' }))
      .body.data;
    expect(
      (await api.post(`/teachers/${t.id}/qualifications`, { type: 'PHD', title: 'x' })).status,
    ).toBe(422);
    expect((await api.post(`/teachers/${t.id}/qualifications`, { type: 'DEGREE' })).status).toBe(
      422,
    );
    expect(
      (
        await api.post(`/teachers/${t.id}/qualifications`, {
          type: 'DEGREE',
          title: 'x',
          completion_year: 1800,
        })
      ).status,
    ).toBe(422);
    // The qualification belongs to another teacher of the same school.
    expect(
      (await api.patch(`/teachers/${other.id}/qualifications/${q.id}`, { version: 1, title: 'x' }))
        .status,
    ).toBe(404);
    expect((await api.delete(`/teachers/${other.id}/qualifications/${q.id}`)).status).toBe(404);
    // Another school cannot touch it.
    expect((await B.admin.api.get(`/teachers/${t.id}/qualifications`)).status).toBe(404);
    expect(
      (
        await B.admin.api.patch(`/teachers/${t.id}/qualifications/${q.id}`, {
          version: 1,
          title: 'x',
        })
      ).status,
    ).toBe(404);
    expect(
      (await B.admin.api.post(`/teachers/${t.id}/qualifications`, { type: 'OTHER', title: 'x' }))
        .status,
    ).toBe(404);
    // Archived teachers are read-only.
    await cmd(api, other.id, 'deactivate', { reason: 'Left' });
    await cmd(api, other.id, 'archive');
    const arch = await api.post(`/teachers/${other.id}/qualifications`, {
      type: 'OTHER',
      title: 'x',
    });
    expect(code(arch)).toBe('INVALID_STATE');
  });
});

describe('portal access (optional login)', () => {
  let learnerRole: string;
  beforeAll(async () => {
    learnerRole = await h.roleId(api, 'TEACHER');
  });
  const members = async (id: string) => (await api.get(`/members/${id}`)).body.data;

  it('invites a teacher through the members service and links the membership', async () => {
    const t = await newTeacher('Portal', withEmail());
    const res = await api.post(`/teachers/${t.id}/portal-access`, { role_id: learnerRole });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const pa = res.body.data.portal_access;
    expect(pa).toMatchObject({ status: 'INVITED', email: t.email });
    expect(pa.roles.map((r: { code: string }) => r.code)).toEqual(['TEACHER']);
    expect(res.body.data.has_login).toBe(true);
    expect((await members(pa.membership_id)).status).toBe('INVITED');
    expect(
      (await api.get(`/teachers?has_login=true&search=${t.teacher_number}`)).body.data,
    ).toHaveLength(1);
    expect(
      (await api.get(`/teachers?has_login=false&search=${t.teacher_number}`)).body.data,
    ).toHaveLength(0);
    // A second invitation is refused while the login exists.
    const again = await api.post(`/teachers/${t.id}/portal-access`, { role_id: learnerRole });
    expect(again.status).toBe(409);
    expect(code(again)).toBe('DUPLICATE_RESOURCE');
    // The invitee accepts and signs in; the teacher profile shows the live login.
    const session = await h.acceptAndLogin(t.email);
    expect(session.api).toBeTruthy();
    expect((await api.get(`/teachers/${t.id}`)).body.data.portal_access.status).toBe('ACTIVE');
    const types = (await api.get(`/teachers/${t.id}/history`)).body.data.map(
      (e: { event_type: string }) => e.event_type,
    );
    expect(types).toContain('PORTAL_ACCESS_INVITED');
  });

  it('works for a teacher without email only when an email is supplied', async () => {
    const t = await newTeacher('NoMail');
    const missing = await api.post(`/teachers/${t.id}/portal-access`, { role_id: learnerRole });
    expect(missing.status).toBe(422);
    expect(code(missing)).toBe('VALIDATION_ERROR');
    expect(missing.body.error.details.issues[0].path).toBe('email');
    expect((await api.get(`/teachers/${t.id}`)).body.data.has_login).toBe(false);
    const email = `${uniq('given')}@school.test`;
    const ok = await api.post(`/teachers/${t.id}/portal-access`, { role_id: learnerRole, email });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.portal_access.email).toBe(email);
    expect(ok.body.data.email).toBeNull(); // the teacher's contact email is untouched
  });

  it('never invalidates the teacher when the invitation fails', async () => {
    const t = await newTeacher('Fail', withEmail());
    const badRole = await api.post(`/teachers/${t.id}/portal-access`, {
      role_id: '019a0000-0000-7000-8000-000000000000',
    });
    expect(badRole.status).toBe(404);
    const platformRole = await api.post(`/teachers/${t.id}/portal-access`, { role_id: 'x' });
    expect(platformRole.status).toBe(422);
    const after = (await api.get(`/teachers/${t.id}`)).body.data;
    expect(after).toMatchObject({ has_login: false, version: 1, status: 'ACTIVE' });
    // An address that is already a member of the school conflicts, teacher untouched.
    const clash = await api.post(`/teachers/${t.id}/portal-access`, {
      role_id: learnerRole,
      email: A.adminEmail,
    });
    expect(clash.status).toBe(409);
    expect((await api.get(`/teachers/${t.id}`)).body.data.has_login).toBe(false);
  });

  it('applies anti-escalation: a manager cannot hand out permissions they lack', async () => {
    const managerRole = await api.post('/roles', {
      name: uniq('Portal manager'),
      permissions: ['teachers.read', 'teachers.portal.manage'],
    });
    expect(managerRole.status, JSON.stringify(managerRole.body)).toBe(201);
    const readerRole = await api.post('/roles', {
      name: uniq('Staff reader'),
      permissions: ['teachers.read'],
    });
    const manager = await h.addMember(api, [{ role_id: managerRole.body.data.id }]);
    const t = await newTeacher('Esc', withEmail());
    const t2 = await newTeacher('Esc2', withEmail());
    const denied = await manager.api.post(`/teachers/${t.id}/portal-access`, {
      role_id: learnerRole, // grants students.read etc. that the manager does not hold
    });
    expect(denied.status).toBe(403);
    expect(code(denied)).toBe('PERMISSION_DENIED');
    expect((await api.get(`/teachers/${t.id}`)).body.data.has_login).toBe(false);
    const allowed = await manager.api.post(`/teachers/${t2.id}/portal-access`, {
      role_id: readerRole.body.data.id,
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
  });

  it('revokes the login, clears the link and allows a fresh invitation', async () => {
    const t = await newTeacher('Revoke', withEmail());
    const membershipId = (
      await api.post(`/teachers/${t.id}/portal-access`, { role_id: learnerRole })
    ).body.data.portal_access.membership_id as string;
    await h.acceptAndLogin(t.email);
    const res = await api.delete(`/teachers/${t.id}/portal-access`, {
      reason: 'Shared device abuse',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ has_login: false, status: 'ACTIVE' });
    expect(res.body.data.portal_access.status).toBe('NONE');
    expect((await members(membershipId)).status).toBe('REVOKED');
    expect((await api.delete(`/teachers/${t.id}/portal-access`)).status).toBe(404);
    const types = (await api.get(`/teachers/${t.id}/history`)).body.data.map(
      (e: { event_type: string }) => e.event_type,
    );
    expect(types).toContain('PORTAL_ACCESS_REVOKED');
    const again = await api.post(`/teachers/${t.id}/portal-access`, { role_id: learnerRole });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data.portal_access.status).toBe('INVITED');
  });

  it('suspends the login when the teacher leaves, and does not restore it on activation', async () => {
    const t = await newTeacher('Suspend', withEmail());
    const membershipId = (
      await api.post(`/teachers/${t.id}/portal-access`, { role_id: learnerRole })
    ).body.data.portal_access.membership_id as string;
    const login = await h.acceptAndLogin(t.email);
    expect((await login.api.get('/students')).status).toBe(200);

    const off = await cmd(api, t.id, 'deactivate', { reason: 'Career break' });
    expect(off.status).toBe(200);
    expect(off.body.meta).toBeUndefined();
    expect(off.body.data.portal_access.status).toBe('SUSPENDED');
    expect((await members(membershipId)).status).toBe('SUSPENDED');
    expect((await login.api.get('/students')).status).not.toBe(200);

    // Activating the teacher does not reinstate access...
    const on = await cmd(api, t.id, 'activate');
    expect(on.body.data.status).toBe('ACTIVE');
    expect(on.body.data.portal_access.status).toBe('SUSPENDED');
    // ...that is an explicit decision, made through the members API.
    const back = await api.post(`/members/${membershipId}/reactivate`, { reason: 'Returned' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await api.get(`/teachers/${t.id}`)).body.data.portal_access.status).toBe('ACTIVE');

    // Resigning suspends again.
    await cmd(api, t.id, 'resign', { reason: 'Moved' });
    expect((await members(membershipId)).status).toBe('SUSPENDED');
  });

  it('revokes a never-accepted invitation when the teacher leaves', async () => {
    const t = await newTeacher('Pending', withEmail());
    const membershipId = (
      await api.post(`/teachers/${t.id}/portal-access`, { role_id: learnerRole })
    ).body.data.portal_access.membership_id as string;
    const res = await cmd(api, t.id, 'terminate', { reason: 'Dismissed' });
    expect(res.status).toBe(200);
    expect(res.body.data.has_login).toBe(false);
    expect((await members(membershipId)).status).toBe('REVOKED');
  });

  it('never fails the command when the login cannot be suspended, and says so', async () => {
    const hrRole = await api.post('/roles', {
      name: uniq('HR lead'),
      permissions: ['teachers.read', 'teachers.update', 'teachers.archive'],
    });
    const hr = await h.addMember(api, [{ role_id: hrRole.body.data.id }]);
    const t = await newTeacher('Stuck', withEmail());
    const membershipId = (
      await api.post(`/teachers/${t.id}/portal-access`, { role_id: learnerRole })
    ).body.data.portal_access.membership_id as string;
    await h.acceptAndLogin(t.email);
    const res = await cmd(hr.api, t.id, 'resign', { reason: 'Left the school' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe('RESIGNED');
    expect(res.body.meta.warnings[0].code).toBe('PORTAL_ACCESS_NOT_SUSPENDED');
    // HR may not manage a login holding permissions they lack, so it stays active.
    expect((await members(membershipId)).status).toBe('ACTIVE');
    // A school admin can finish the job.
    expect(
      (await api.post(`/members/${membershipId}/suspend`, { reason: 'Resigned' })).status,
    ).toBe(200);
  });

  it('refuses portal access for departed teachers', async () => {
    const t = await newTeacher('Departed', withEmail());
    await cmd(api, t.id, 'resign', { reason: 'Left' });
    const res = await api.post(`/teachers/${t.id}/portal-access`, { role_id: learnerRole });
    expect(res.status).toBe(422);
    expect(code(res)).toBe('OPERATION_NOT_ALLOWED');
  });

  it('is enforced by the database: a teacher cannot link another school membership', async () => {
    const t = await newTeacher('Link');
    const bMembership = B.admin.membership.membership_id;
    await expect(
      h.deps.db.update(teachers).set({ membershipId: bMembership }).where(eq(teachers.id, t.id)),
    ).rejects.toThrow();
    // Its own school's membership is accepted, but only by one teacher.
    const own = A.admin.membership.membership_id;
    const t2 = await newTeacher('Link2');
    await h.deps.db.update(teachers).set({ membershipId: own }).where(eq(teachers.id, t.id));
    await expect(
      h.deps.db.update(teachers).set({ membershipId: own }).where(eq(teachers.id, t2.id)),
    ).rejects.toThrow();
    await h.deps.db.update(teachers).set({ membershipId: null }).where(eq(teachers.id, t.id));
  });
});

describe('permissions and plan', () => {
  it('denies staff without teacher permissions', async () => {
    const clerk = await h.addMember(api, [{ role_id: await h.roleId(api, 'RECEPTIONIST') }]);
    const t = await newTeacher('Hidden');
    for (const res of [
      await clerk.api.get('/teachers'),
      await clerk.api.get(`/teachers/${t.id}`),
      await clerk.api.get('/teaching-assignments'),
      await clerk.api.post('/teachers', person('No', 'Way')),
    ]) {
      expect(res.status).toBe(403);
      expect(code(res)).toBe('PERMISSION_DENIED');
    }
    const teacher = await h.addMember(api, [{ role_id: await h.roleId(api, 'TEACHER') }]);
    const create = await teacher.api.post('/teachers', person('Self', 'Serve'));
    expect(create.status).toBe(403);
    expect(code(create)).toBe('PERMISSION_DENIED');
  });

  it('gives the principal oversight (read, assign, export) but not personnel changes', async () => {
    const principal = await h.addMember(api, [{ role_id: await h.roleId(api, 'PRINCIPAL') }]);
    const t = await newTeacher('Oversee', withEmail());
    expect((await principal.api.get(`/teachers/${t.id}`)).status).toBe(200);
    expect((await principal.api.get('/teachers/export')).status).toBe(200);
    const off = await freshOffering();
    const made = await principal.api.post(`/teachers/${t.id}/assignments`, {
      subject_offering_id: off,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(
      (await principal.api.post(`/teaching-assignments/${made.body.data.id}/end`, {})).status,
    ).toBe(200);
    for (const res of [
      await principal.api.post('/teachers', person('No', 'Way')),
      await principal.api.patch(`/teachers/${t.id}`, { version: 1, designation: 'x' }),
      await principal.api.post(`/teachers/${t.id}/qualifications`, { type: 'OTHER', title: 'x' }),
      await cmd(principal.api, t.id, 'activate'),
      await cmd(principal.api, t.id, 'resign', { reason: 'nope nope' }),
      await principal.api.post(`/teachers/${t.id}/portal-access`, {
        role_id: await h.roleId(api, 'TEACHER'),
      }),
    ]) {
      expect(res.status).toBe(403);
      expect(code(res)).toBe('PERMISSION_DENIED');
    }
  });

  it('needs the school plan to include the teachers feature', async () => {
    const S2 = await h.provisionSchool({ plan: 'STANDARD' });
    expect((await S2.admin.api.get('/teachers')).status).toBe(200);
    const deny = await S2.root.put(
      `/platform/tenants/${S2.tenantId}/entitlements/overrides/teachers`,
      {
        effect: 'DENY',
        reason: 'Test',
        confirm: true,
      },
    );
    expect(deny.status, JSON.stringify(deny.body)).toBe(200);
    for (const res of [
      await S2.admin.api.get('/teachers'),
      await S2.admin.api.post('/teachers', person('No', 'Plan')),
      await S2.admin.api.get('/teaching-assignments'),
      await S2.admin.api.get('/teachers/export'),
    ]) {
      expect(res.status).toBe(403);
      expect(code(res)).toBe('FEATURE_NOT_ENABLED');
      expect(res.body.error.details.feature).toBe('teachers');
    }
  });

  it('scoped (non tenant-wide) grants cannot read personnel records', async () => {
    const scoped = await h.addMember(api, [
      {
        role_id: await h.scopableRole(api, 'PRINCIPAL'),
        scope_type: 'ASSIGNED_SECTION',
        scope_ref: { section_ids: [S.secA] },
      },
    ]);
    const t = await newTeacher('Scoped');
    expect((await scoped.api.get('/teachers')).body.data).toHaveLength(0);
    expect((await scoped.api.get(`/teachers/${t.id}`)).status).toBe(404);
  });
});

describe('tenant isolation', () => {
  it("treats another school's teachers, qualifications and assignments as not found", async () => {
    const bs = B.admin.api;
    const bOff = await freshOffering(bs, SB);
    const bt = await newTeacher(
      'BeeTeacher',
      { ...withEmail(), qualifications: [{ type: 'OTHER', title: 'Q' }] },
      bs,
    );
    const bAssign = await assign(bt.id, bOff, {}, bs);
    const bq = (await bs.get(`/teachers/${bt.id}/qualifications`)).body.data[0];

    const reads = [
      `/teachers/${bt.id}`,
      `/teachers/${bt.id}/history`,
      `/teachers/${bt.id}/qualifications`,
      `/teachers/${bt.id}/assignments`,
      `/teaching-assignments/${bAssign.id}`,
    ];
    for (const url of reads) expect((await api.get(url)).status, url).toBe(404);
    expect((await api.patch(`/teachers/${bt.id}`, { version: 1, first_name: 'Hack' })).status).toBe(
      404,
    );
    for (const c of [
      'onboard',
      'activate',
      'start-leave',
      'return-from-leave',
      'deactivate',
      'resign',
      'terminate',
      'archive',
      'restore',
    ])
      expect((await cmd(api, bt.id, c, { reason: 'cross school' })).status, c).toBe(404);
    expect(
      (
        await api.post(`/teachers/${bt.id}/portal-access`, {
          role_id: await h.roleId(api, 'TEACHER'),
        })
      ).status,
    ).toBe(404);
    expect((await api.delete(`/teachers/${bt.id}/portal-access`)).status).toBe(404);
    expect(
      (await api.patch(`/teachers/${bt.id}/qualifications/${bq.id}`, { version: 1, title: 'x' }))
        .status,
    ).toBe(404);
    expect((await api.delete(`/teachers/${bt.id}/qualifications/${bq.id}`)).status).toBe(404);
    expect((await api.post(`/teaching-assignments/${bAssign.id}/end`, {})).status).toBe(404);
    expect(
      (await api.post(`/teaching-assignments/${bAssign.id}/cancel`, { reason: 'cross school' }))
        .status,
    ).toBe(404);

    // Lists and filters never leak, even when the filter names the other school's id.
    expect((await api.get('/teachers?search=BeeTeacher')).body.data).toHaveLength(0);
    expect(
      (await api.get(`/teachers?search=${bt.teacher_number}&page_size=100`)).body.data.every(
        (t: { id: string }) => t.id !== bt.id,
      ),
    ).toBe(true);
    expect((await api.get(`/teaching-assignments?teacher_id=${bt.id}`)).body.data).toHaveLength(0);
    expect(
      (await api.get(`/teaching-assignments?subject_offering_id=${bOff}`)).body.data,
    ).toHaveLength(0);
    expect(
      (await api.get(`/teaching-assignments?academic_year_id=${SB.yearId}`)).body.data,
    ).toHaveLength(0);
    expect(
      (await api.get('/teachers/export?search=BeeTeacher')).text.trim().split('\n'),
    ).toHaveLength(1);

    // Nothing changed for B.
    const still = (await bs.get(`/teachers/${bt.id}`)).body.data;
    expect(still).toMatchObject({ first_name: 'BeeTeacher', status: 'ACTIVE', version: 1 });
    expect(still.active_assignments).toHaveLength(1);
    expect((await bs.get(`/teaching-assignments/${bAssign.id}`)).body.data.status).toBe('ACTIVE');
  });
});

describe('audit, events and export', () => {
  it('writes audit rows and outbox events with each change', async () => {
    const t = await newTeacher('Audited', { qualifications: [{ type: 'DEGREE', title: 'B.A.' }] });
    const a = await assign(t.id, await freshOffering());
    await api.patch(`/teachers/${t.id}`, { version: 1, designation: 'Coordinator' });
    await api.post(`/teaching-assignments/${a.id}/cancel`, { reason: 'Mistake' });
    await cmd(api, t.id, 'start-leave', { reason: 'Sabbatical' });
    await cmd(api, t.id, 'return-from-leave');
    await cmd(api, t.id, 'resign', { reason: 'Moved city' });

    const events = (
      await h.deps.db.select().from(outboxEvents).where(eq(outboxEvents.tenantId, A.tenantId))
    )
      .filter((e) => JSON.stringify(e.payload).includes(t.id))
      .map((e) => e.eventType);
    expect(events).toEqual(
      expect.arrayContaining([
        'teacher.created',
        'teacher.qualification_added',
        'teaching_assignment.created',
        'teacher.updated',
        'teaching_assignment.cancelled',
        'teacher.status_changed',
      ]),
    );
    const statusEvents = (
      await h.deps.db.select().from(outboxEvents).where(eq(outboxEvents.tenantId, A.tenantId))
    ).filter(
      (e) => e.eventType === 'teacher.status_changed' && JSON.stringify(e.payload).includes(t.id),
    );
    expect(statusEvents).toHaveLength(3);
    expect(JSON.stringify(statusEvents.map((e) => e.payload))).not.toContain('Audited'); // ids, not personal data

    const audit = await api.get('/audit-logs?page_size=100');
    const actions = audit.body.data
      .filter((x: { entity_id?: string }) => x.entity_id === t.id || x.entity_id === a.id)
      .map((x: { action: string }) => x.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'TEACHER_CREATED',
        'TEACHER_UPDATED',
        'TEACHER_START_LEAVE',
        'TEACHER_RETURN_FROM_LEAVE',
        'TEACHER_RESIGN',
        'TEACHING_ASSIGNMENT_CREATED',
        'TEACHING_ASSIGNMENT_CANCELLED',
      ]),
    );
    const rows = await h.deps.db
      .select()
      .from(teacherHistory)
      .where(eq(teacherHistory.teacherId, t.id));
    expect(rows.length).toBeGreaterThanOrEqual(8);
  });

  it('records nothing for a refused request', async () => {
    const t = await newTeacher('Refused');
    const off = await freshOffering();
    await assign(t.id, off);
    const count = async () =>
      (await h.deps.db.select().from(outboxEvents).where(eq(outboxEvents.tenantId, A.tenantId)))
        .length;
    const before = await count();
    expect(
      (await api.post(`/teachers/${t.id}/assignments`, { subject_offering_id: off })).status,
    ).toBe(409);
    expect((await api.patch(`/teachers/${t.id}`, { version: 99, designation: 'x' })).status).toBe(
      409,
    );
    expect(await count()).toBe(before);
  });

  it('exports CSV with an audit record and neutralises spreadsheet formulas', async () => {
    const dept = uniq('Exp');
    await newTeacher('=HYPERLINK("evil")', { department: dept, designation: 'Head, Science' });
    await newTeacher('Plain', { department: dept, staff_type: 'NON_TEACHING' });
    const res = await api.get(`/teachers/export?department=${dept}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('teachers.csv');
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toContain('Teacher number');
    expect(lines).toHaveLength(3);
    expect(res.text).toContain("'=HYPERLINK");
    expect(res.text).toContain('"Head, Science"');
    expect(res.text).not.toMatch(/salary|password/i);
    const nt = await api.get(`/teachers/export?department=${dept}&staff_type=NON_TEACHING`);
    expect(nt.text.trim().split('\n')).toHaveLength(2);
    const audit = await api.get('/audit-logs?page_size=100');
    expect(audit.body.data.some((a: { action: string }) => a.action === 'TEACHERS_EXPORTED')).toBe(
      true,
    );
    // Reading is not enough: exporting needs its own permission.
    const teacher = await h.addMember(api, [{ role_id: await h.roleId(api, 'TEACHER') }]);
    expect((await teacher.api.get('/teachers/export')).status).toBe(403);
  });
});
