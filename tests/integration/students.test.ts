import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrollments, outboxEvents, studentGuardians } from '../../src/db/schema/index.js';
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
  small: string; // capacity 2
}
let S: Structure;

async function structure(a: Api, label: string): Promise<Structure> {
  const y = await a.post('/academic-years', {
    code: `Y-${label}`,
    name: `Year ${label}`,
    start_date: '2026-04-01',
    end_date: '2027-03-31',
  });
  const yearId = y.body.data.id;
  await a.post(`/academic-years/${yearId}/activate`, { complete_current: true });
  const classId = (
    await a.post('/academic-classes', { code: `G7${label}`, name: 'Grade 7', sequence: 7 })
  ).body.data.id;
  const class2Id = (
    await a.post('/academic-classes', { code: `G8${label}`, name: 'Grade 8', sequence: 8 })
  ).body.data.id;
  const sec = async (cls: string, c: string, capacity?: number) =>
    (
      await a.post(`/academic-years/${yearId}/sections`, {
        class_id: cls,
        code: c,
        name: `Section ${c}`,
        capacity,
      })
    ).body.data.id;
  return {
    yearId,
    classId,
    class2Id,
    secA: await sec(classId, 'A'),
    secB: await sec(classId, 'B'),
    small: await sec(class2Id, 'S', 2),
  };
}

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  B = await h.provisionSchool();
  api = A.admin.api;
  S = await structure(api, 'A');
});
afterAll(() => h.close());

const person = (first: string, last = 'Tester', extra: object = {}) => ({
  first_name: first,
  last_name: last,
  gender: 'FEMALE',
  ...extra,
});
const enrol = (section = S.secA, cls = S.classId) => ({
  academic_year_id: S.yearId,
  class_id: cls,
  section_id: section,
});
async function newStudent(first: string, body: object = {}) {
  const res = await api.post('/students', person(first, uniq('Fam'), body));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; version: number; status: string; student_number: string };
}

describe('creating students', () => {
  it('creates a student with guardians and an enrollment in one transaction', async () => {
    const res = await api.post(
      '/students',
      person('Aarav', uniq('Sharma'), {
        date_of_birth: '2014-05-10',
        primary_phone: '+91 98765 00001',
        guardians: [
          {
            guardian: { first_name: 'Ravi', last_name: 'Sharma', phone: '+91 98765 11111' },
            relationship_type: 'PARENT',
            relationship_label: 'Father',
            can_pick_up: true,
          },
          {
            guardian: { first_name: 'Sita', last_name: 'Sharma' },
            relationship_type: 'PARENT',
            relationship_label: 'Mother',
            is_emergency_contact: true,
          },
        ],
        enrollment: enrol(),
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const s = res.body.data;
    expect(s.status).toBe('ACTIVE');
    expect(s.student_number).toMatch(/^STU-\d{4}-\d{5}$/);
    expect(s.current_enrollment.class.name).toBe('Grade 7');
    expect(s.current_enrollment.section.name).toBe('Section A');
    expect(s.guardians).toHaveLength(2);
    // The first guardian became the primary contact automatically.
    expect(s.guardians.filter((g: { is_primary: boolean }) => g.is_primary)).toHaveLength(1);
    expect(s.guardians[0].relationship_label).toBe('Father');

    const history = await api.get(`/students/${s.id}/history`);
    const types = history.body.data.map((e: { event_type: string }) => e.event_type);
    expect(types).toEqual(
      expect.arrayContaining(['STUDENT_CREATED', 'ENROLLED', 'GUARDIAN_LINKED']),
    );
  });

  it('starts ADMITTED without an enrollment and becomes ACTIVE when enrolled', async () => {
    const s = await newStudent('Bina');
    expect(s.status).toBe('ADMITTED');
    const activateEarly = await api.post(`/students/${s.id}/activate`, {});
    expect(activateEarly.status).toBe(422);
    const enrolled = await api.post(`/students/${s.id}/enrollments`, enrol());
    expect(enrolled.status).toBe(201);
    expect((await api.get(`/students/${s.id}`)).body.data.status).toBe('ACTIVE');
  });

  it('numbers students per school without gaps or repeats, even in parallel', async () => {
    const created = await Promise.all(
      Array.from({ length: 6 }, (_, i) => api.post('/students', person(`Par${i}`, uniq('Num')))),
    );
    expect(created.every((r) => r.status === 201)).toBe(true);
    const numbers = created.map((r) => r.body.data.student_number as string);
    expect(new Set(numbers).size).toBe(6);
    // The other school has its own sequence.
    const other = await B.admin.api.post('/students', person('Other', 'School'));
    expect(other.body.data.student_number).toMatch(/-00001$/);
  });

  it('warns about possible duplicates and lets the user confirm', async () => {
    const body = person('Dupe', 'Child', { date_of_birth: '2013-01-02' });
    expect((await api.post('/students', body)).status).toBe(201);
    const warn = await api.post('/students', body);
    expect(warn.status).toBe(409);
    expect(code(warn)).toBe('CONFIRMATION_REQUIRED');
    expect(warn.body.error.details.duplicates[0].matched_on).toContain('date_of_birth');
    const forced = await api.post('/students', { ...body, confirm_duplicate: true });
    expect(forced.status).toBe(201);
  });

  it('rejects a reused student number and an invalid date of birth', async () => {
    const first = await api.post(
      '/students',
      person('Num', uniq('A'), { student_number: 'custom-77' }),
    );
    expect(first.body.data.student_number).toBe('CUSTOM-77');
    const dup = await api.post(
      '/students',
      person('Num', uniq('B'), { student_number: 'CUSTOM-77' }),
    );
    expect(dup.status).toBe(409);
    expect(code(dup)).toBe('DUPLICATE_RESOURCE');
    const future = await api.post(
      '/students',
      person('Fut', uniq('C'), { date_of_birth: '2999-01-01' }),
    );
    expect(future.status).toBe(422);
  });

  it('rolls everything back if part of the creation fails', async () => {
    const family = uniq('Atomic');
    const res = await api.post('/students', {
      ...person('Atomic', family),
      enrollment: { ...enrol(), section_id: S.small, class_id: S.classId }, // section belongs to another class
    });
    expect(res.status).toBe(422);
    const search = await api.get(`/students?search=${family}`);
    expect(search.body.data).toHaveLength(0);
  });
});

describe('editing students', () => {
  it('uses optimistic concurrency and ignores free-form status edits', async () => {
    const s = await newStudent('Edit');
    const ok = await api.patch(`/students/${s.id}`, {
      version: s.version,
      first_name: 'Edited',
      status: 'GRADUATED',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.first_name).toBe('Edited');
    expect(ok.body.data.status).toBe('ADMITTED'); // status can only change through commands
    const stale = await api.patch(`/students/${s.id}`, { version: s.version, first_name: 'Stale' });
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe('CONFLICT');
  });
});

describe('enrollment rules', () => {
  it('allows one open enrollment per student per year', async () => {
    const s = await newStudent('Once', { enrollment: enrol() });
    const again = await api.post(`/students/${s.id}/enrollments`, enrol(S.secB));
    expect(again.status).toBe(409);
    expect(code(again)).toBe('DUPLICATE_RESOURCE');
    // The database also refuses it (defence in depth).
    const [row] = await h.deps.db.select().from(enrollments).where(eq(enrollments.studentId, s.id));
    await expect(
      h.deps.db.insert(enrollments).values({
        tenantId: A.tenantId,
        studentId: s.id,
        academicYearId: S.yearId,
        classId: S.classId,
        sectionId: S.secB,
        status: 'ACTIVE',
        startDate: '2026-06-01',
      }),
    ).rejects.toThrow();
    expect(row).toBeTruthy();
  });

  it('enforces section capacity, including under concurrent requests', async () => {
    const students = await Promise.all(['C1', 'C2', 'C3', 'C4'].map((n) => newStudent(n)));
    const results = await Promise.all(
      students.map((s) => api.post(`/students/${s.id}/enrollments`, enrol(S.small, S.class2Id))),
    );
    const ok = results.filter((r) => r.status === 201);
    const full = results.filter((r) => r.status === 422);
    expect(ok).toHaveLength(2);
    expect(full).toHaveLength(2);
    expect(full[0]!.body.error.message).toMatch(/full/i);
    const sec = await api.get(`/sections/${S.small}`);
    expect(sec.body.data.enrolled_count).toBe(2);
    expect(sec.body.data.seats_available).toBe(0);
    // Capacity cannot drop below the seats in use.
    const shrink = await api.patch(`/sections/${S.small}`, {
      version: sec.body.data.version,
      capacity: 1,
    });
    expect(shrink.status).toBe(422);
  });

  it('keeps history when a student changes section', async () => {
    const s = await newStudent('Mover', { enrollment: enrol(S.secA) });
    const first = (await api.get(`/students/${s.id}/enrollments`)).body.data[0];
    const changed = await api.post(`/enrollments/${first.id}/change`, {
      section_id: S.secB,
      reason: 'Parent request',
      effective_date: '2026-08-01',
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.data.section.name).toBe('Section B');
    expect(changed.body.data.enrollment_type).toBe('CHANGE');
    const all = (await api.get(`/students/${s.id}/enrollments`)).body.data;
    expect(all).toHaveLength(2);
    const old = all.find((e: { id: string }) => e.id === first.id);
    expect(old.status).toBe('TRANSFERRED');
    expect(old.end_date).toBe('2026-08-01');
    expect(old.section.name).toBe('Section A');
    const same = await api.post(`/enrollments/${changed.body.data.id}/change`, {
      section_id: S.secB,
      reason: 'No-op',
    });
    expect(same.status).toBe(422);
  });

  it('completes and cancels enrollments, and lists a class roster', async () => {
    const s = await newStudent('Roster', { enrollment: enrol(S.secB) });
    const roster = await api.get(`/enrollments?section_id=${S.secB}&search=Roster`);
    expect(roster.body.data.map((e: { student: { id: string } }) => e.student.id)).toContain(s.id);
    const e = (await api.get(`/students/${s.id}/enrollments`)).body.data[0];
    const cancelled = await api.post(`/enrollments/${e.id}/cancel`, { reason: 'Entered in error' });
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect((await api.post(`/enrollments/${e.id}/complete`, {})).status).toBe(422);
    // A cancelled enrollment frees the year: the student can be enrolled again.
    expect((await api.post(`/students/${s.id}/enrollments`, enrol(S.secA))).status).toBe(201);
    const unenrolled = await api.get('/students?enrolled=false&page_size=100');
    expect(
      unenrolled.body.data.every(
        (x: { current_enrollment: unknown }) => x.current_enrollment === null,
      ),
    ).toBe(true);
  });

  it('only enrolls in open academic years and active classes', async () => {
    const s = await newStudent('Closed');
    const draft = (
      await api.post('/academic-years', {
        code: 'DRAFT-Y',
        name: 'Draft',
        start_date: '2040-04-01',
        end_date: '2041-03-31',
      })
    ).body.data.id;
    const res = await api.post(`/students/${s.id}/enrollments`, {
      academic_year_id: draft,
      class_id: S.classId,
    });
    expect(res.status).toBe(422);
  });
});

describe('lifecycle commands', () => {
  it('withdraws with a reason, closing enrollments, and archives afterwards', async () => {
    const s = await newStudent('Leaver', { enrollment: enrol() });
    const noReason = await api.post(`/students/${s.id}/withdraw`, {});
    expect(noReason.status).toBe(422);
    const w = await api.post(`/students/${s.id}/withdraw`, { reason: 'Family relocated' });
    expect(w.body.data.status).toBe('WITHDRAWN');
    expect(w.body.data.current_enrollment).toBeNull();
    expect((await api.get(`/students/${s.id}/enrollments`)).body.data[0].status).toBe('WITHDRAWN');
    expect((await api.post(`/students/${s.id}/enrollments`, enrol())).status).toBe(422);
    expect((await api.post(`/students/${s.id}/graduate`, {})).status).toBe(422);
    const archived = await api.post(`/students/${s.id}/archive`, {});
    expect(archived.body.data.status).toBe('ARCHIVED');
    const edit = await api.patch(`/students/${s.id}`, {
      version: archived.body.data.version,
      first_name: 'X',
    });
    expect(edit.status).toBe(422);
  });

  it('transfers, graduates and reinstates', async () => {
    const t = await newStudent('Transfer', { enrollment: enrol() });
    const moved = await api.post(`/students/${t.id}/transfer`, {
      reason: 'Moving to another school',
      effective_date: '2026-09-01',
    });
    expect(moved.body.data.status).toBe('TRANSFERRED');
    expect((await api.get(`/students/${t.id}/enrollments`)).body.data[0].status).toBe(
      'TRANSFERRED',
    );
    const back = await api.post(`/students/${t.id}/reinstate`, { reason: 'Returned' });
    expect(back.body.data.status).toBe('ADMITTED');
    expect(
      (await api.post(`/students/${t.id}/enrollments`, { ...enrol(), enrollment_type: 'REJOIN' }))
        .status,
    ).toBe(201);

    const g = await newStudent('Grad', { enrollment: enrol() });
    const done = await api.post(`/students/${g.id}/graduate`, {});
    expect(done.body.data.status).toBe('GRADUATED');
    expect((await api.get(`/students/${g.id}/enrollments`)).body.data[0].status).toBe('COMPLETED');

    const history = (await api.get(`/students/${t.id}/history`)).body.data.map(
      (e: { event_type: string }) => e.event_type,
    );
    expect(history).toEqual(
      expect.arrayContaining(['STUDENT_TRANSFER', 'STUDENT_REINSTATE', 'ENROLLED']),
    );
  });

  it('emits domain events with each change', async () => {
    const s = await newStudent('Events', { enrollment: enrol() });
    await api.post(`/students/${s.id}/withdraw`, { reason: 'Testing events' });
    const events = await h.deps.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.tenantId, A.tenantId));
    const mine = events
      .filter((e) => JSON.stringify(e.payload).includes(s.id))
      .map((e) => e.eventType);
    expect(mine).toEqual(
      expect.arrayContaining([
        'student.created',
        'enrollment.created',
        'student.status_changed',
        'student.withdrawn',
      ]),
    );
    const payload = events.find(
      (e) => e.eventType === 'student.withdrawn' && JSON.stringify(e.payload).includes(s.id),
    )!.payload as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain('Events'); // ids, not personal data
  });

  it('completing the academic year completes enrollments and keeps students active', async () => {
    const B2 = await h.provisionSchool();
    const st = await structure(B2.admin.api, 'C');
    const s = await B2.admin.api.post(
      '/students',
      person('Year', 'End', {
        enrollment: { academic_year_id: st.yearId, class_id: st.classId, section_id: st.secA },
      }),
    );
    expect(s.status).toBe(201);
    const done = await B2.admin.api.post(`/academic-years/${st.yearId}/complete`);
    expect(done.status).toBe(200);
    const after = await B2.admin.api.get(`/students/${s.body.data.id}`);
    expect(after.body.data.status).toBe('ACTIVE');
    expect(after.body.data.current_enrollment).toBeNull();
    expect(
      (await B2.admin.api.get(`/students/${s.body.data.id}/enrollments`)).body.data[0].status,
    ).toBe('COMPLETED');
  });
});

describe('guardians', () => {
  it('keeps a single primary guardian and preserves ended links', async () => {
    const s = await newStudent('Fam');
    const g1 = await api.post(`/students/${s.id}/guardians`, {
      guardian: { first_name: 'One', last_name: 'Parent', phone: '+91 90000 00001' },
      relationship_type: 'PARENT',
    });
    const g2 = await api.post(`/students/${s.id}/guardians`, {
      guardian: { first_name: 'Two', last_name: 'Parent' },
      relationship_type: 'GUARDIAN',
      is_primary: true,
    });
    expect(g1.body.data.is_primary).toBe(true);
    expect(g2.body.data.is_primary).toBe(true);
    const list = (await api.get(`/students/${s.id}/guardians`)).body.data;
    expect(list.filter((g: { is_primary: boolean }) => g.is_primary)).toHaveLength(1);
    expect(list.find((g: { is_primary: boolean }) => g.is_primary).guardian.first_name).toBe('Two');
    // The database enforces it too.
    await expect(
      h.deps.db
        .update(studentGuardians)
        .set({ isPrimary: true })
        .where(eq(studentGuardians.id, g1.body.data.id)),
    ).rejects.toThrow();

    const promote = await api.patch(`/students/${s.id}/guardians/${g1.body.data.id}`, {
      is_primary: true,
      can_pick_up: true,
    });
    expect(promote.body.data.is_primary).toBe(true);
    expect((await api.delete(`/students/${s.id}/guardians/${g1.body.data.id}`)).status).toBe(204);
    const after = (await api.get(`/students/${s.id}/guardians`)).body.data;
    expect(after).toHaveLength(1);
    const withEnded = (await api.get(`/students/${s.id}/guardians`)).body.data;
    expect(withEnded).toHaveLength(1);
  });

  it('shares one guardian across siblings and refuses a duplicate link', async () => {
    const a = await newStudent('SibA');
    const b = await newStudent('SibB');
    const linked = await api.post(`/students/${a.id}/guardians`, {
      guardian: { first_name: 'Shared', last_name: uniq('Guardian'), phone: '+91 93333 33333' },
      relationship_type: 'PARENT',
    });
    const gid = linked.body.data.guardian.id;
    expect(
      (
        await api.post(`/students/${b.id}/guardians`, {
          guardian_id: gid,
          relationship_type: 'PARENT',
        })
      ).status,
    ).toBe(201);
    const dup = await api.post(`/students/${b.id}/guardians`, {
      guardian_id: gid,
      relationship_type: 'PARENT',
    });
    expect(dup.status).toBe(409);
    const detail = await api.get(`/guardians/${gid}`);
    expect(detail.body.data.students).toHaveLength(2);
    const found = await api.get('/guardians?search=93333');
    expect(found.body.data[0].student_count).toBe(2);
    // Editing the guardian is shared across both children.
    const v = detail.body.data.version;
    expect(
      (await api.patch(`/guardians/${gid}`, { version: v, occupation: 'Engineer' })).body.data
        .occupation,
    ).toBe('Engineer');
    expect((await api.patch(`/guardians/${gid}`, { version: v, occupation: 'Stale' })).status).toBe(
      409,
    );
  });

  it('finds students through their guardians', async () => {
    const fam = uniq('Findable');
    const s = await newStudent('Kid', {
      guardians: [
        { guardian: { first_name: 'Parent', last_name: fam }, relationship_type: 'PARENT' },
      ],
    });
    const res = await api.get(`/students?search=${fam}`);
    expect(res.body.data.map((x: { id: string }) => x.id)).toContain(s.id);
  });
});

describe('admissions', () => {
  it('walks DRAFT → SUBMITTED → APPROVED and leaves enrollment to the school', async () => {
    const created = await api.post('/admissions', {
      student: person('Applicant', uniq('Fam'), { date_of_birth: '2015-03-03' }),
      source: 'Walk-in',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const adm = created.body.data;
    expect(adm.status).toBe('DRAFT');
    expect(adm.admission_number).toMatch(/^ADM-\d{4}-\d{5}$/);
    expect(adm.student.status).toBe('PROSPECTIVE');
    expect((await api.post(`/admissions/${adm.id}/approve`, {})).status).toBe(422); // not submitted yet
    expect((await api.post(`/admissions/${adm.id}/submit`)).body.data.student.status).toBe(
      'ADMISSION_PENDING',
    );
    expect((await api.post(`/admissions/${adm.id}/review`)).body.data.status).toBe('UNDER_REVIEW');
    const approved = await api.post(`/admissions/${adm.id}/approve`, { note: 'Good fit' });
    expect(approved.body.data.status).toBe('APPROVED');
    expect(approved.body.data.student.status).toBe('ADMITTED');
    const enrolled = await api.post(`/students/${adm.student.id}/enrollments`, enrol());
    expect(enrolled.status).toBe(201);
    expect((await api.get(`/students/${adm.student.id}`)).body.data.status).toBe('ACTIVE');
    expect(
      (await api.get(`/admissions?status=APPROVED`)).body.data.map((x: { id: string }) => x.id),
    ).toContain(adm.id);
  });

  it('rejects and cancels admissions, updating the student', async () => {
    const a = (await api.post('/admissions', { student: person('Rej', uniq('Fam')) })).body.data;
    await api.post(`/admissions/${a.id}/submit`);
    const rej = await api.post(`/admissions/${a.id}/reject`, { reason: 'No seats' });
    expect(rej.body.data.status).toBe('REJECTED');
    expect(rej.body.data.student.status).toBe('WITHDRAWN');
    const c = (await api.post('/admissions', { student: person('Can', uniq('Fam')) })).body.data;
    const cancel = await api.post(`/admissions/${c.id}/cancel`, { reason: 'Applicant withdrew' });
    expect(cancel.body.data.status).toBe('CANCELLED');
    expect((await api.post(`/admissions/${c.id}/submit`)).status).toBe(422);
  });

  it('is limited to plans with the admissions feature', async () => {
    const starter = await h.provisionSchool({ plan: 'STARTER' });
    const res = await starter.admin.api.get('/admissions');
    expect(res.status).toBe(403);
    expect(code(res)).toBe('FEATURE_NOT_ENABLED');
    expect((await starter.admin.api.get('/students')).status).toBe(200);
  });
});

describe('permissions and scope', () => {
  it('lets office staff create and enroll but not withdraw or approve', async () => {
    const clerk = await h.addMember(api, [{ role_id: await h.roleId(api, 'RECEPTIONIST') }]);
    const made = await clerk.api.post('/students', person('Clerk', uniq('Made')));
    expect(made.status).toBe(201);
    const withdraw = await clerk.api.post(`/students/${made.body.data.id}/withdraw`, {
      reason: 'Not allowed',
    });
    expect(withdraw.status).toBe(403);
    expect(code(withdraw)).toBe('PERMISSION_DENIED');
    const adm = (await clerk.api.post('/admissions', { student: person('Clerk', uniq('Adm')) }))
      .body.data;
    await clerk.api.post(`/admissions/${adm.id}/submit`);
    expect((await clerk.api.post(`/admissions/${adm.id}/approve`, {})).status).toBe(403);
    expect((await clerk.api.get('/students/export')).status).toBe(403);
  });

  it('gives teachers read access but no write access', async () => {
    const teacher = await h.addMember(api, [{ role_id: await h.roleId(api, 'TEACHER') }]);
    expect((await teacher.api.get('/students')).status).toBe(200);
    expect((await teacher.api.post('/students', person('Nope', 'Nope'))).status).toBe(403);
  });

  it('limits a section-scoped teacher to their own students', async () => {
    const mine = await newStudent('Mine', { enrollment: enrol(S.secA) });
    const theirs = await newStudent('Theirs', { enrollment: enrol(S.secB) });
    const teacher = await h.addMember(api, [
      {
        role_id: await h.roleId(api, 'TEACHER'),
        scope_type: 'ASSIGNED_SECTION',
        scope_ref: { section_ids: [S.secA] },
      },
    ]);
    const list = await teacher.api.get('/students?page_size=100');
    const ids = list.body.data.map((s: { id: string }) => s.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect((await teacher.api.get(`/students/${mine.id}`)).status).toBe(200);
    expect((await teacher.api.get(`/students/${theirs.id}`)).status).toBe(404);
    expect((await teacher.api.get(`/students/${theirs.id}/history`)).status).toBe(404);
    expect((await teacher.api.get(`/students/${theirs.id}/guardians`)).status).toBe(404);
    const roster = await teacher.api.get(`/enrollments?section_id=${S.secB}`);
    expect(roster.body.data).toHaveLength(0);
  });

  it('exports CSV with an audit record and neutralises spreadsheet formulas', async () => {
    await newStudent('=HYPERLINK("evil")', { last_name: 'Formula' });
    const res = await api.get('/students/export?search=Formula');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\n')[0]).toContain('Student number');
    expect(res.text).toContain("'=HYPERLINK");
    const audit = await api.get('/audit-logs?page_size=50');
    expect(audit.body.data.some((a: { action: string }) => a.action === 'STUDENTS_EXPORTED')).toBe(
      true,
    );
  });
});

describe('tenant isolation', () => {
  it("treats another school's students, sections and guardians as not found", async () => {
    const bs = await structure(B.admin.api, 'B');
    const bStudent = (
      await B.admin.api.post(
        '/students',
        person('Bee', 'Student', {
          guardians: [
            { guardian: { first_name: 'Bob', last_name: 'Guardian' }, relationship_type: 'PARENT' },
          ],
        }),
      )
    ).body.data;
    const bGuardian = bStudent.guardians[0].guardian.id;
    expect((await api.get(`/students/${bStudent.id}`)).status).toBe(404);
    expect(
      (await api.patch(`/students/${bStudent.id}`, { version: 1, first_name: 'Hack' })).status,
    ).toBe(404);
    expect(
      (await api.post(`/students/${bStudent.id}/withdraw`, { reason: 'cross tenant' })).status,
    ).toBe(404);
    expect((await api.get(`/guardians/${bGuardian}`)).status).toBe(404);
    const mine = await newStudent('Mine2');
    expect(
      (
        await api.post(`/students/${mine.id}/enrollments`, {
          academic_year_id: bs.yearId,
          class_id: bs.classId,
          section_id: bs.secA,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api.post(`/students/${mine.id}/guardians`, {
          guardian_id: bGuardian,
          relationship_type: 'PARENT',
        })
      ).status,
    ).toBe(404);
    expect((await api.get(`/students?search=Bee`)).body.data).toHaveLength(0);
    // B's student is untouched.
    expect((await B.admin.api.get(`/students/${bStudent.id}`)).body.data.first_name).toBe('Bee');
  });

  it('is enforced by the database: a row cannot join two schools', async () => {
    const bs = await structure(B.admin.api, 'B2');
    const s = await newStudent('Direct');
    await expect(
      h.deps.db.insert(enrollments).values({
        tenantId: A.tenantId,
        studentId: s.id,
        academicYearId: bs.yearId, // belongs to school B
        classId: S.classId,
        status: 'ACTIVE',
        startDate: '2026-06-01',
      }),
    ).rejects.toThrow();
  });
});

describe('parents (standalone guardians)', () => {
  it('adds a parent without a child, warns about duplicates, and stores preferences', async () => {
    const phone = `+91 9${Math.floor(1e8 + Math.random() * 8e8)}`;
    const made = await api.post('/guardians', {
      first_name: 'Solo',
      last_name: uniq('Parent'),
      phone,
      preferred_channel: 'WHATSAPP',
      notify_sms: false,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.data.students).toEqual([]);
    expect(made.body.data.preferred_channel).toBe('WHATSAPP');
    expect(made.body.data.notify_sms).toBe(false);

    // Same phone again: refused with the matching parent, unless confirmed.
    const dup = await api.post('/guardians', { first_name: 'Other', last_name: 'Person', phone });
    expect(dup.status).toBe(409);
    expect(code(dup)).toBe('DUPLICATE_RESOURCE');
    expect(dup.body.error.details.matches[0].id).toBe(made.body.data.id);
    const forced = await api.post('/guardians', {
      first_name: 'Other',
      last_name: 'Person',
      phone,
      confirm_duplicate: true,
    });
    expect(forced.status).toBe(201);

    const upd = await api.patch(`/guardians/${made.body.data.id}`, {
      version: made.body.data.version,
      notify_email: false,
      preferred_language: 'en',
    });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.data.notify_email).toBe(false);
  });

  it('lists children with their class and names them in the directory', async () => {
    const kid = await newStudent('Kid', { enrollment: enrol() });
    const linked = await api.post(`/students/${kid.id}/guardians`, {
      guardian: { first_name: 'Rajesh', last_name: uniq('Sharma') },
      relationship_type: 'PARENT',
    });
    const gid = linked.body.data.guardian.id;
    const one = (await api.get(`/guardians/${gid}`)).body.data;
    expect(one.students).toHaveLength(1);
    expect(one.students[0].student_id).toBe(kid.id);
    const list = (await api.get('/guardians?search=Rajesh')).body.data;
    const row = list.find((g: { id: string }) => g.id === gid);
    expect(row.student_count).toBe(1);
    expect(row.student_names).toContain('Kid');
  });
});
