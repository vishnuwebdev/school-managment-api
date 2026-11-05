import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

/**
 * /api/v1/teacher/*: the teacher app's API. Paid add-on gate, teacher-only
 * guard, and the teacher's section scope carried through every wrapper.
 */
let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;
let yearId: string;
let classId: string;
let secA: string;
let secB: string;
let teacherRole: string;

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool({ plan: 'STANDARD' });
  api = A.admin.api;
  const y = await api.post('/academic-years', {
    code: `Y-${uniq('y')}`,
    name: 'Year',
    start_date: '2026-01-01',
    end_date: '2026-12-31',
  });
  yearId = y.body.data.id;
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
  teacherRole = await h.roleId(api, 'TEACHER');
});
afterAll(() => h.close());

async function student(section: string, first: string) {
  const res = await api.post('/students', {
    first_name: first,
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
  return res.body.data as { id: string };
}

/** A teacher who is class teacher of [section], signed in to the app. */
async function classTeacher(section: string) {
  const t = await api.post('/teachers', {
    first_name: 'Naledi',
    last_name: uniq('Fam'),
    email: `${uniq('t')}@school.test`,
  });
  expect(t.status, JSON.stringify(t.body)).toBe(201);
  const set = await api.put(`/sections/${section}/class-teacher`, { teacher_id: t.body.data.id });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  const inv = await api.post(`/teachers/${t.body.data.id}/portal-access`, { role_id: teacherRole });
  expect(inv.status, JSON.stringify(inv.body)).toBe(201);
  const session = await h.acceptAndLogin(t.body.data.email);
  return { id: t.body.data.id as string, api: session.api };
}

async function grantTeacherApp() {
  const res = await A.root.put(
    `/platform/tenants/${A.tenantId}/entitlements/overrides/teachers.mobile_app`,
    { effect: 'GRANT', reason: 'School bought the teacher app add-on' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await h.flushTenantCache(A.tenantId);
}

describe('teacher app API', () => {
  it('is a paid add-on: refused until the school has it', async () => {
    const t = await classTeacher(secA);
    expect(code(await t.api.get('/teacher/today'))).toBe('FEATURE_NOT_ENABLED');
    await grantTeacherApp();
    expect((await t.api.get('/teacher/today')).status).toBe(200);
  });

  it('is for teachers only', async () => {
    // The school admin holds every permission but has no teacher record.
    expect(code(await api.get('/teacher/today'))).toBe('NOT_A_TEACHER');
  });

  it('runs a day: classes, roster, register, student profile — inside my sections only', async () => {
    const mine = await student(secA, 'Mine');
    const other = await student(secB, 'Other');
    const t = await classTeacher(secA);

    const classes = await t.api.get('/teacher/classes');
    expect(classes.status, JSON.stringify(classes.body)).toBe(200);
    const sections = classes.body.data.classes.map(
      (c: { section: { id: string } }) => c.section.id,
    );
    expect(sections).toContain(secA);
    expect(sections).not.toContain(secB);
    const a = classes.body.data.classes.find(
      (c: { section: { id: string } }) => c.section.id === secA,
    );
    expect(a.is_class_teacher).toBe(true);
    expect(a.register.state).toBe('NOT_STARTED');

    const roster = await t.api.get(`/teacher/classes/${secA}/students`);
    expect(roster.status, JSON.stringify(roster.body)).toBe(200);
    const onRoster = roster.body.data.map(
      (e: { student_id?: string; student?: { id: string } }) => e.student_id ?? e.student?.id,
    );
    expect(onRoster).toContain(mine.id);
    expect(onRoster).not.toContain(other.id);
    expect((await t.api.get(`/teacher/classes/${secB}/students`)).body.data ?? []).toEqual([]);

    const opened = await t.api.post(`/teacher/classes/${secA}/register`, {});
    expect([200, 201]).toContain(opened.status);
    expect(opened.body.meta.created).toBe(true);
    const sessionId = opened.body.data.id as string;
    expect(code(await t.api.post(`/teacher/classes/${secB}/register`, {}))).toBe(
      'RESOURCE_NOT_FOUND',
    );

    const all = await t.api.post(`/teacher/registers/${sessionId}/mark-all`, {});
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const sub = await t.api.post(`/teacher/registers/${sessionId}/submit`, {});
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const after = await t.api.get('/teacher/classes');
    const state = after.body.data.classes.find(
      (c: { section: { id: string } }) => c.section.id === secA,
    ).register.state;
    expect(['SUBMITTED', 'FINAL']).toContain(state);

    const profile = await t.api.get(`/teacher/students/${mine.id}`);
    expect(profile.status, JSON.stringify(profile.body)).toBe(200);
    expect(profile.body.data.student.id).toBe(mine.id);
    expect(Array.isArray(profile.body.data.guardians)).toBe(true);
    expect((await t.api.get(`/teacher/students/${other.id}`)).status).toBe(404);
    expect((await t.api.get(`/teacher/students/${other.id}/marks`)).status).toBe(404);
    expect((await t.api.get(`/teacher/students/${mine.id}/attendance`)).status).toBe(200);
  });

  it('shows my own records and attendance (leave is gone)', async () => {
    const t = await classTeacher(secB);
    const me = await t.api.get('/teacher/me');
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.data.id).toBe(t.id);
    for (const path of [
      '/teacher/qualifications',
      '/teacher/assignments',
      '/teacher/attendance-statuses',
      '/teacher/calendar',
    ]) {
      const res = await t.api.get(path);
      expect(res.status, `${path} ${JSON.stringify(res.body)}`).toBe(200);
    }
    expect((await t.api.get('/teacher/leave/requests')).status).toBe(404);
    const mine = await t.api.get(
      `/teacher/my-attendance?month=${new Date().toISOString().slice(0, 7)}`,
    );
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
  });
  it('shows me the school calendar: holidays and the events meant for me', async () => {
    const t = await classTeacher(secA);
    const otherClass = (
      await api.post('/academic-classes', { code: uniq('G'), name: 'Grade 11', sequence: 11 })
    ).body.data.id as string;
    const day = '2026-11-12';
    const ev = async (title: string, audience: string, classIds?: string[]) => {
      const res = await api.post('/calendar/events', {
        type: 'EVENT',
        title,
        start_date: day,
        end_date: day,
        audience,
        ...(classIds ? { class_ids: classIds } : {}),
        staff_action: audience === 'STAFF' ? 'Bring your mark books' : undefined,
        action_link: audience === 'STAFF' ? 'MARKS' : undefined,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.data.id as string;
    };
    const everyone = await ev('Prize giving', 'ALL');
    const staff = await ev('Staff meeting', 'STAFF');
    const mineEv = await ev('Grade 8 outing', 'CLASSES', [classId]);
    const notMine = await ev('Grade 11 outing', 'CLASSES', [otherClass]);

    const res = await t.api.get(`/teacher/calendar?from=${day}&to=${day}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids = res.body.data.events.map((e: { id: string }) => e.id);
    expect(ids).toEqual(expect.arrayContaining([everyone, staff, mineEv]));
    expect(ids).not.toContain(notMine);
    const s = res.body.data.events.find((e: { id: string }) => e.id === staff);
    expect(s.staff_action).toBe('Bring your mark books');
    expect(s.action_link).toBe('MARKS');
    expect(Array.isArray(res.body.data.holidays)).toBe(true);
    expect(Array.isArray(res.body.data.weekly_off_days)).toBe(true);
  });
});
