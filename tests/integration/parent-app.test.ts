import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

/**
 * /api/v1/parent/*: the parent app. The school turns the app on for a guardian, the parent
 * signs in with the mobile number and sees only their own children: profile, attendance,
 * results (with shared remarks and PDFs), fees (invoice and receipt PDFs) and notices.
 */
let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
function ok<T = Json>(res: { status: number; body: Json }, status = 200) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
}

let yearId: string;
let classId: string;
let secA: string;
let secB: string;
let mine: Json; // child of the parent under test (section A)
let other: Json; // another family's child (section B)
let guardianId: string;
let parent: Api;
const PASSWORD = 'Parent12345';
const PHONE = '+91 98765 11111';

async function student(section: string, first: string, guardianPhone: string) {
  return ok(
    await api.post('/students', {
      first_name: first,
      last_name: uniq('Fam'),
      gender: 'FEMALE',
      date_of_birth: '2015-04-02',
      guardians: [
        {
          guardian: { first_name: 'Ravi', last_name: uniq('Par'), phone: guardianPhone },
          relationship_type: 'PARENT',
          relationship_label: 'Father',
        },
      ],
      enrollment: {
        academic_year_id: yearId,
        class_id: classId,
        section_id: section,
        start_date: daysAgo(60),
      },
    }),
    201,
  );
}

async function signInByPhone(phone: string, password = PASSWORD) {
  return h.http.post('/api/v1/auth/login').send({ phone, password });
}

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool({ plan: 'STANDARD' });
  api = A.admin.api;
  yearId = ok(
    await api.post('/academic-years', {
      code: 'PY',
      name: '2026-27',
      start_date: daysAgo(120),
      end_date: inDays(200),
    }),
    201,
  ).id;
  ok(await api.post(`/academic-years/${yearId}/activate`, { complete_current: true }));
  classId = ok(
    await api.post('/academic-classes', { code: 'G5', name: 'Grade 5', sequence: 5 }),
    201,
  ).id;
  const sec = async (c: string) =>
    ok(
      await api.post(`/academic-years/${yearId}/sections`, {
        class_id: classId,
        code: c,
        name: c,
      }),
      201,
    ).id as string;
  secA = await sec('A');
  secB = await sec('B');
  const subj = ok(
    await api.post('/subjects', { code: uniq('M').toUpperCase(), name: 'Maths' }),
    201,
  );
  ok(
    await api.post('/subject-offerings', {
      academic_year_id: yearId,
      subject_id: subj.id,
      class_id: classId,
    }),
    201,
  );
  mine = await student(secA, 'Aanya', PHONE);
  other = await student(secB, 'Other', '+91 90000 22222');
  guardianId = mine.guardians[0].guardian.id;
}, 120_000);
afterAll(() => h.close());

describe('parent login', () => {
  it('needs a password for a new login, then signs in with the mobile number', async () => {
    const noPw = await api.post(`/guardians/${guardianId}/app-access`, {});
    expect(noPw.status).toBe(422);
    const on = ok(
      await api.post(`/guardians/${guardianId}/app-access`, { password: PASSWORD }),
      201,
    );
    expect(on).toMatchObject({ enabled: true, login_phone: '919876511111', new_login: true });
    expect(
      code(await api.post(`/guardians/${guardianId}/app-access`, { password: PASSWORD })),
    ).toBe('DUPLICATE_RESOURCE');

    for (const typed of ['+919876511111', '98765 11111', '098765-11111'])
      expect((await signInByPhone(typed)).status, typed).toBe(200);
    const bad = await signInByPhone('9876511111', 'wrong-password');
    expect(code(bad)).toBe('INVALID_CREDENTIALS');
    const res = await signInByPhone(PHONE);
    parent = h.as(res.body.data.access_token);
  });

  it('the same number cannot sign in to two accounts', async () => {
    const g2 = other.guardians[0].guardian.id;
    expect(
      code(
        await api.post(`/guardians/${g2}/app-access`, { password: PASSWORD, phone: '9876511111' }),
      ),
    ).toBe('DUPLICATE_RESOURCE');
  });

  it('is only for parents', async () => {
    expect((await api.get('/parent/me')).status).toBe(403);
  });
});

describe('my children only', () => {
  it('lists my child and hides another family', async () => {
    const me = ok(await parent.get('/parent/me'));
    expect(me.children.map((c: Json) => c.id)).toEqual([mine.id]);
    expect(me.children[0]).toMatchObject({ class: { name: 'Grade 5' }, section: { name: 'A' } });
    expect(me.school.name).toBeTruthy();
    expect(code(await parent.get(`/parent/children/${other.id}`))).toBe('RESOURCE_NOT_FOUND');
    expect(code(await parent.get(`/parent/children/${other.id}/attendance`))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(code(await parent.get(`/parent/children/${other.id}/fees`))).toBe('RESOURCE_NOT_FOUND');
  });

  it('shows the roll number the school sets', async () => {
    const en = ok(await api.get(`/students/${mine.id}/enrollments`));
    const enrollmentId = (Array.isArray(en) ? en : en.data)[0].id;
    const otherEn = ok(await api.get(`/students/${other.id}/enrollments`));
    const otherId = (Array.isArray(otherEn) ? otherEn : otherEn.data)[0].id;
    ok(
      await api.put('/enrollments/roll-numbers', {
        items: [{ enrollment_id: enrollmentId, roll_number: '07' }],
      }),
    );
    // Same number in another section is fine.
    ok(
      await api.put('/enrollments/roll-numbers', {
        items: [{ enrollment_id: otherId, roll_number: '07' }],
      }),
    );
    const p = ok(await parent.get(`/parent/children/${mine.id}`));
    expect(p.roll_number).toBe('07');
    expect(p.guardians.find((g: Json) => g.is_you)).toBeTruthy();
    const auto = ok(await api.post(`/sections/${secA}/roll-numbers/auto`));
    expect(auto.data ?? auto).toBeTruthy();
  });

  it('shows attendance and the calendar', async () => {
    const a = ok(await parent.get(`/parent/children/${mine.id}/attendance`));
    expect(a.summary).toBeTruthy();
    expect(a.today).toHaveProperty('status');
    expect(Array.isArray(a.off_days)).toBe(true);
    ok(await parent.get(`/parent/children/${mine.id}/calendar`));
    ok(await parent.get('/parent/home'));
  });
});

describe('results', () => {
  let examId: string;
  it('shows published results with the remark only when shared, and a report card PDF', async () => {
    const exam = ok(
      await api.post('/exams', {
        name: 'Term 1',
        exam_type: 'MID_TERM',
        start_date: daysAgo(20),
        end_date: daysAgo(15),
        class_ids: [classId],
        default_max_marks: 100,
        default_pass_marks: 33,
      }),
      201,
    );
    examId = exam.id;
    const papers = ok<Json[]>(await api.get(`/exams/${examId}/papers?class_id=${classId}`));
    ok(
      await api.put(`/exams/papers/${papers[0]!.id}/marks`, {
        records: [
          { student_id: mine.id, marks: 88 },
          { student_id: other.id, marks: 60 },
        ],
      }),
    );
    ok(await api.post(`/exams/${examId}/publish`, { allow_incomplete: true }));

    ok(
      await api.put(`/exams/${examId}/remarks`, {
        remarks: [{ student_id: mine.id, remark: 'Works hard.', share_with_parent: false }],
      }),
    );
    let r = ok(await parent.get(`/parent/children/${mine.id}/exams`));
    expect(r.exams).toHaveLength(1);
    expect(r.exams[0]).toMatchObject({ exam_name: 'Term 1', rank: 1, class_size: 2, remark: null });
    expect(r.exams[0].class_average).toBe(74);

    ok(
      await api.put(`/exams/${examId}/remarks`, {
        remarks: [{ student_id: mine.id, remark: 'Works hard.', share_with_parent: true }],
      }),
    );
    r = ok(await parent.get(`/parent/children/${mine.id}/exams/${examId}`));
    expect(r.remark).toBe('Works hard.');

    const pdf = await parent.get(`/parent/children/${mine.id}/exams/${examId}/report-card.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(pdf.body).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('lists an upcoming exam once its papers are dated', async () => {
    const e = ok(
      await api.post('/exams', { name: 'Term 2', class_ids: [classId], exam_type: 'FINAL' }),
      201,
    );
    let r = ok(await parent.get(`/parent/children/${mine.id}/exams`));
    expect(r.upcoming).toHaveLength(0);
    const papers = ok<Json[]>(await api.get(`/exams/${e.id}/papers?class_id=${classId}`));
    ok(await api.patch(`/exams/papers/${papers[0]!.id}`, { exam_date: inDays(10) }));
    r = ok(await parent.get(`/parent/children/${mine.id}/exams`));
    expect(r.upcoming[0]).toMatchObject({
      name: 'Term 2',
      start_date: inDays(10),
      papers_count: 1,
    });
  });
});

describe('fees', () => {
  it('shows the fee account with invoice and receipt PDFs for my child only', async () => {
    ok(await api.put('/fees/grade-fees', { fees: [{ class_id: classId, annual_fee: '12000' }] }));
    let f = ok(await parent.get(`/parent/children/${mine.id}/fees`));
    expect(f.instalments.length).toBeGreaterThan(0);
    expect(f).not.toHaveProperty('plan_options');
    const first = f.instalments[0];
    const inv = await parent.get(`/parent/children/${mine.id}/fees/invoices/${first.id}/pdf`);
    expect(inv.status).toBe(200);
    expect(inv.headers['content-type']).toBe('application/pdf');

    ok(
      await api.post('/fees/payments', {
        student_id: mine.id,
        amount: first.amount,
        method: 'CASH',
        allocation: { mode: 'AUTO' },
      }),
      201,
    );
    const otherPay = ok(
      await api.post('/fees/payments', {
        student_id: other.id,
        amount: '100.00',
        method: 'CASH',
        allocation: { mode: 'AUTO' },
      }),
      201,
    );
    f = ok(await parent.get(`/parent/children/${mine.id}/fees`));
    expect(f.instalments[0].state).toBe('PAID');
    const pay = f.payments[0];
    expect(pay.receipt_pdf).toBeTruthy();
    const rc = await parent.get(`/parent/receipts/${pay.receipt_id}/pdf`);
    expect(rc.status).toBe(200);

    const otherAcc = ok(await api.get(`/fees/learners/${other.id}`));
    const otherReceipt = otherAcc.payments.find((p: Json) => p.id === otherPay.id)?.receipt_id;
    if (otherReceipt)
      expect(code(await parent.get(`/parent/receipts/${otherReceipt}/pdf`))).toBe(
        'RESOURCE_NOT_FOUND',
      );
    const otherDemand = otherAcc.instalments[0].id;
    expect(
      code(await parent.get(`/parent/children/${mine.id}/fees/invoices/${otherDemand}/pdf`)),
    ).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('notices', () => {
  it('shows school and my-section notices, tracks read and acknowledgement', async () => {
    const school = ok(
      await api.post('/notices', {
        category: 'CIRCULAR',
        title: 'Annual day',
        body: 'Annual day is on Friday.\n\nPlease send the consent form.',
        requires_acknowledgement: true,
        event_date: inDays(5),
      }),
      201,
    );
    ok(
      await api.post('/notices', {
        title: 'Section B trip',
        body: 'Only for B.',
        audience: 'SECTIONS',
        section_ids: [secB],
      }),
      201,
    );
    ok(
      await api.post('/notices', {
        title: 'Later',
        body: 'Not yet.',
        publish_at: new Date(Date.now() + 3 * DAY).toISOString(),
      }),
      201,
    );
    const list = await parent.get('/parent/notices');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data.map((n: Json) => n.title)).toEqual(['Annual day']);
    expect(list.body.meta.unread).toBe(1);
    expect(list.body.data[0].paragraphs).toHaveLength(2);

    ok(await parent.post(`/parent/notices/${school.id}/read`));
    expect((await parent.get('/parent/notices')).body.meta.unread).toBe(0);
    const ack = ok(await parent.post(`/parent/notices/${school.id}/acknowledge`));
    expect(ack.acknowledged).toBe(true);
    const receipts = await api.get(`/notices/${school.id}/receipts`);
    expect(receipts.body.data[0].acknowledged_at).toBeTruthy();

    const home = ok(await parent.get('/parent/home'));
    expect(home.coming_up.some((c: Json) => c.kind === 'NOTICE' && c.notice_id === school.id)).toBe(
      true,
    );

    ok(await api.post(`/notices/${school.id}/cancel`, {}));
    expect(code(await parent.get(`/parent/notices/${school.id}`))).toBe('RESOURCE_NOT_FOUND');
  });

  it('a teacher posts only to their own sections', async () => {
    const grant = await A.root.put(
      `/platform/tenants/${A.tenantId}/entitlements/overrides/teachers.mobile_app`,
      { effect: 'GRANT', reason: 'Teacher app' },
    );
    expect(grant.status).toBe(200);
    await h.flushTenantCache(A.tenantId);
    const t = ok(
      await api.post('/teachers', {
        first_name: 'Priya',
        last_name: uniq('T'),
        email: `${uniq('t')}@school.test`,
      }),
      201,
    );
    ok(await api.put(`/sections/${secA}/class-teacher`, { teacher_id: t.id }));
    ok(
      await api.post(`/teachers/${t.id}/portal-access`, {
        role_id: await h.roleId(api, 'TEACHER'),
      }),
      201,
    );
    const teacher = (await h.acceptAndLogin(t.email)).api;
    const okPost = await teacher.post('/teacher/notices', {
      title: 'Bring crayons',
      body: 'Tomorrow is art day.',
      audience: 'SECTIONS',
      section_ids: [secA],
    });
    expect(okPost.status, JSON.stringify(okPost.body)).toBe(201);
    expect(okPost.body.data.posted_by.name).toContain('Priya');
    const refused = await teacher.post('/teacher/notices', {
      title: 'Nope',
      body: 'x',
      audience: 'SECTIONS',
      section_ids: [secB],
    });
    expect(refused.status).toBe(403);
    const seen = await parent.get('/parent/notices');
    expect(seen.body.data.map((n: Json) => n.title)).toContain('Bring crayons');

    // The class teacher writes remarks only for their own section.
    const exams = ok<Json>(await api.get('/exams'));
    const term1 = (Array.isArray(exams) ? exams : exams.data).find(
      (e: Json) => e.name === 'Term 1',
    );
    const mineRemark = await teacher.put(`/teacher/exams/${term1.id}/remarks`, {
      remarks: [{ student_id: mine.id, remark: 'Lovely work', share_with_parent: true }],
    });
    expect(mineRemark.status, JSON.stringify(mineRemark.body)).toBe(200);
    const otherRemark = await teacher.put(`/teacher/exams/${term1.id}/remarks`, {
      remarks: [{ student_id: other.id, remark: 'x', share_with_parent: true }],
    });
    expect(otherRemark.status).toBe(403);
  });
});

describe('turning the app off', () => {
  it('signs the parent out and frees the number', async () => {
    ok(await api.delete(`/guardians/${guardianId}/app-access`, {}));
    expect((await parent.get('/parent/me')).status).toBe(401);
    expect(code(await signInByPhone(PHONE))).toBe('INVALID_CREDENTIALS');
    const st = ok(await api.get(`/guardians/${guardianId}/app-access`));
    expect(st).toMatchObject({ enabled: false, login_phone: null });
  });
});
