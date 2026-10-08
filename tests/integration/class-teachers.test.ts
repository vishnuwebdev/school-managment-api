import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;
let yearId: string;
let classId: string;
let secA: string;
let secB: string;
let teacherRole: string;

const today = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  api = A.admin.api;
  const y = await api.post('/academic-years', {
    code: `Y-${uniq('y')}`,
    name: 'Year',
    start_date: '2026-04-01',
    end_date: '2027-03-31',
  });
  yearId = y.body.data.id;
  await api.post(`/academic-years/${yearId}/activate`, { complete_current: true });
  classId = (await api.post('/academic-classes', { code: uniq('G'), name: 'Grade 7', sequence: 7 }))
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

async function newTeacher(first: string) {
  const res = await api.post('/teachers', {
    first_name: first,
    last_name: uniq('Fam'),
    email: `${uniq('t')}@school.test`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; email: string };
}
async function student(section: string, first: string) {
  const res = await api.post('/students', {
    first_name: first,
    last_name: uniq('Fam'),
    gender: 'FEMALE',
    enrollment: {
      academic_year_id: yearId,
      class_id: classId,
      section_id: section,
      start_date: '2026-04-02',
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string };
}
async function offering(sectionId?: string) {
  const subj = await api.post('/subjects', { code: uniq('SUB').toUpperCase(), name: uniq('Subj') });
  const res = await api.post('/subject-offerings', {
    academic_year_id: yearId,
    subject_id: subj.body.data.id,
    class_id: classId,
    ...(sectionId ? { section_id: sectionId } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}
async function login(t: { id: string; email: string }) {
  const inv = await api.post(`/teachers/${t.id}/portal-access`, { role_id: teacherRole });
  expect(inv.status, JSON.stringify(inv.body)).toBe(201);
  return h.acceptAndLogin(t.email);
}
const ids = (res: { body: { data: { id: string }[] } }) => res.body.data.map((s) => s.id);

describe('class teacher', () => {
  it('sets, replaces and removes the class teacher with history', async () => {
    const t1 = await newTeacher('First');
    const t2 = await newTeacher('Second');
    const set = await api.put(`/sections/${secA}/class-teacher`, { teacher_id: t1.id });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data.class_teacher.teacher_id).toBe(t1.id);
    expect((await api.put(`/sections/${secA}/class-teacher`, { teacher_id: t1.id })).status).toBe(
      409,
    );

    const swap = await api.put(`/sections/${secA}/class-teacher`, {
      teacher_id: t2.id,
      reason: 'Rotation',
    });
    expect(swap.body.data.class_teacher.teacher_id).toBe(t2.id);
    const hist = (await api.get(`/teachers/${t1.id}/history`)).body.data.map(
      (e: { event_type: string }) => e.event_type,
    );
    expect(hist).toEqual(expect.arrayContaining(['CLASS_TEACHER_ASSIGNED', 'CLASS_TEACHER_ENDED']));

    const list = await api.get(`/class-teachers?academic_year_id=${yearId}`);
    const row = list.body.data.find((r: { section_id: string }) => r.section_id === secA);
    expect(row.class_teacher.teacher_id).toBe(t2.id);

    const gone = await api.delete(`/sections/${secA}/class-teacher`, { reason: 'Vacant for now' });
    expect(gone.status).toBe(204);
    const after = await api.get(`/class-teachers?academic_year_id=${yearId}`);
    expect(
      after.body.data.find((r: { section_id: string }) => r.section_id === secA).class_teacher,
    ).toBeNull();
  });

  it('only accepts active teaching staff, and requires a reason to remove', async () => {
    const nonTeaching = await api.post('/teachers', {
      first_name: 'Clerk',
      last_name: uniq('Fam'),
      staff_type: 'NON_TEACHING',
    });
    const res = await api.put(`/sections/${secB}/class-teacher`, {
      teacher_id: nonTeaching.body.data.id,
    });
    expect(res.status).toBe(422);
    const t = await newTeacher('Leaver');
    await api.post(`/teachers/${t.id}/resign`, { reason: 'Moving abroad' });
    const inactive = await api.put(`/sections/${secB}/class-teacher`, { teacher_id: t.id });
    expect(code(inactive)).toBe('INVALID_STATE');
    expect((await api.delete(`/sections/${secB}/class-teacher`, {})).status).toBe(422);
  });
});

describe('teacher sees only assigned classes', () => {
  it('follows assignments and class teacher, with no hand-typed section ids', async () => {
    const sA = await student(secA, 'InA');
    const sB = await student(secB, 'InB');
    const t = await newTeacher('Scoped');
    const session = await login(t);

    // Nothing assigned yet: no students.
    expect(ids(await session.api.get('/students'))).toHaveLength(0);

    // A section-level teaching assignment opens that section only.
    const a = await api.post(`/teachers/${t.id}/assignments`, {
      subject_offering_id: await offering(secA),
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    let seen = ids(await session.api.get('/students'));
    expect(seen).toContain(sA.id);
    expect(seen).not.toContain(sB.id);
    expect((await session.api.get(`/students/${sB.id}`)).status).toBe(404);

    // Becoming class teacher of B adds B.
    await api.put(`/sections/${secB}/class-teacher`, { teacher_id: t.id });
    seen = ids(await session.api.get('/students'));
    expect(seen).toEqual(expect.arrayContaining([sA.id, sB.id]));

    // Ending the assignment and class-teacher link removes access again.
    await api.post(`/teaching-assignments/${a.body.data.id}/end`, {});
    await api.delete(`/sections/${secB}/class-teacher`, { reason: 'Changed duties' });
    expect(ids(await session.api.get('/students'))).toHaveLength(0);
  });

  it('a class-wide offering covers every section of the class', async () => {
    const sA = await student(secA, 'WideA');
    const sB = await student(secB, 'WideB');
    const t = await newTeacher('Wide');
    const session = await login(t);
    await api.post(`/teachers/${t.id}/assignments`, { subject_offering_id: await offering() });
    expect(ids(await session.api.get('/students'))).toEqual(expect.arrayContaining([sA.id, sB.id]));
  });

  it('a teacher who leaves loses access immediately and stops being class teacher', async () => {
    const sA = await student(secA, 'Leave');
    const t = await newTeacher('Quitter');
    const session = await login(t);
    await api.put(`/sections/${secA}/class-teacher`, { teacher_id: t.id });
    expect(ids(await session.api.get('/students'))).toContain(sA.id);
    const res = await api.post(`/teachers/${t.id}/resign`, {
      reason: 'Resigned',
      exit_date: today(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const list = await api.get(`/class-teachers?academic_year_id=${yearId}`);
    expect(
      list.body.data.find((r: { section_id: string }) => r.section_id === secA).class_teacher,
    ).toBeNull();
  });
});

describe('my classes and own profile', () => {
  it('lets a teacher open only their own record and see their classes', async () => {
    const t = await newTeacher('Mine');
    const other = await newTeacher('Other');
    const session = await login(t);
    await api.put(`/sections/${secA}/class-teacher`, { teacher_id: t.id });
    await api.post(`/teachers/${t.id}/assignments`, { subject_offering_id: await offering(secB) });

    const mine = await session.api.get('/teachers/me');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.data.teacher.id).toBe(t.id);
    expect(
      mine.body.data.class_teacher_of.map((c: { section_id: string }) => c.section_id),
    ).toEqual([secA]);
    expect(mine.body.data.teaching.map((c: { section_id: string }) => c.section_id)).toEqual([
      secB,
    ]);

    expect((await session.api.get(`/teachers/${t.id}`)).status).toBe(200);
    expect((await session.api.get(`/teachers/${other.id}`)).status).toBe(404);
    expect(ids(await session.api.get('/teachers'))).toEqual([t.id]);
    // Reading is all a teacher can do to personnel records.
    expect((await session.api.patch(`/teachers/${t.id}`, { version: 1, phone: '1' })).status).toBe(
      403,
    );
    expect(
      (await session.api.put(`/sections/${secA}/class-teacher`, { teacher_id: t.id })).status,
    ).toBe(403);
  });

  it('an admin without a teacher record gets 404 from /teachers/me', async () => {
    expect((await api.get('/teachers/me')).status).toBe(404);
  });
});
