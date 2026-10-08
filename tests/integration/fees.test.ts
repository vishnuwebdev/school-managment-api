import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLogs,
  feeDemands,
  outboxEvents,
  paymentAllocations,
  schoolPayments,
} from '../../src/db/schema/index.js';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

// These tests assign and bill by hand; automatic billing on enrolment has its own test file.
process.env.FEES_AUTO_BILL = 'false';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let B: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api; // school A admin (has every fee permission)
let bapi: Api; // school B admin
let acct: Api; // accountant: records, requests, verifies; cannot approve
let prin: Api; // principal: approves, publishes, exports
let recep: Api; // receptionist: read + record payments
let teach: Api; // teacher: no fee access
let FA: Fixture;
let FB: Fixture;

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

interface Fixture {
  yearId: string;
  classId: string;
  secA: string;
  secB: string;
  catTuition: string;
  catAnnual: string;
  structureId: string;
  tuitionComponentId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

function ok<T = Json>(res: { status: number; body: Json }, status = 200) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
}
const reason = (res: { body: Json }) => res.body.error?.details?.reason as string | undefined;
/** Expect a rejected call with an HTTP status, an error code and (optionally) a details.reason. */
function bad(res: { status: number; body: Json }, status: number, errCode?: string, why?: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  if (errCode) expect(code(res)).toBe(errCode);
  if (why) expect(reason(res)).toBe(why);
}

/**
 * Every school gets: an open academic year, one class with sections A and B, two categories and a
 * PUBLISHED structure whose demands are easy to reason about:
 *   Tuition, CUSTOM, 1000.00 x 3 due 60 and 30 days ago and in 30 days (C1, C2, C3)
 *   Annual charges, ANNUAL, 500.00 due in 20 days.
 * A billed student therefore owes 3500.00 of which 2000.00 is overdue.
 */
async function fixture(a: Api, label: string): Promise<Fixture> {
  const y = ok(
    await a.post('/academic-years', {
      code: `Y-${label}`,
      name: `Year ${label}`,
      start_date: daysAgo(200),
      end_date: inDays(160),
    }),
    201,
  );
  ok(await a.post(`/academic-years/${y.id}/activate`, { complete_current: true }));
  const cls = ok(
    await a.post('/academic-classes', { code: `G7${label}`, name: 'Grade 7', sequence: 7 }),
    201,
  );
  const sec = async (c: string) =>
    ok(
      await a.post(`/academic-years/${y.id}/sections`, {
        class_id: cls.id,
        code: c,
        name: `Section ${c}`,
      }),
      201,
    ).id as string;
  const secA = await sec('A');
  const secB = await sec('B');
  const catTuition = ok(await a.post('/fees/categories', { code: 'TUITION', name: 'Tuition' }), 201)
    .id as string;
  const catAnnual = ok(await a.post('/fees/categories', { code: 'ANNUAL', name: 'Annual' }), 201)
    .id as string;
  const st = ok(
    await a.post('/fees/structures', {
      code: `STD-${label}`,
      name: `Grade 7 fees ${label}`,
      academic_year_id: y.id,
      academic_class_id: cls.id,
    }),
    201,
  );
  const tuition = ok(
    await a.post(`/fees/structures/${st.id}/components`, {
      fee_category_id: catTuition,
      name: 'Tuition',
      amount: '1000.00',
      frequency: 'CUSTOM',
      due_rule: { type: 'CUSTOM_DATES', dates: [daysAgo(60), daysAgo(30), inDays(30)] },
      display_order: 1,
    }),
    201,
  );
  ok(
    await a.post(`/fees/structures/${st.id}/components`, {
      fee_category_id: catAnnual,
      name: 'Annual charges',
      amount: '500.00',
      frequency: 'ANNUAL',
      due_rule: { type: 'FIXED_DATE', date: inDays(20) },
      display_order: 2,
    }),
    201,
  );
  ok(await a.post(`/fees/structures/${st.id}/publish`, {}));
  return {
    yearId: y.id,
    classId: cls.id,
    secA,
    secB,
    catTuition,
    catAnnual,
    structureId: st.id,
    tuitionComponentId: tuition.id,
  };
}

async function newStudent(a: Api, F: Fixture, section?: string, enrolled = true) {
  const res = await a.post('/students', {
    first_name: 'Fee',
    last_name: uniq('Kid'),
    gender: 'FEMALE',
    ...(enrolled
      ? {
          enrollment: {
            academic_year_id: F.yearId,
            class_id: F.classId,
            section_id: section ?? F.secA,
          },
        }
      : {}),
  });
  return ok(res, 201) as { id: string; student_number: string };
}

interface Billed {
  student: { id: string; student_number: string };
  assignment: Json;
  c1: Json;
  c2: Json;
  an: Json;
  c3: Json;
  all: Json[];
}

/** A new student, assigned the fixture structure with all demands generated and issued. */
async function bill(a: Api, F: Fixture, section?: string): Promise<Billed> {
  const student = await newStudent(a, F, section);
  const assignment = ok(
    await a.post('/fees/assignments', { student_id: student.id, fee_structure_id: F.structureId }),
    201,
  );
  ok(await a.post(`/fees/assignments/${assignment.id}/generate-demands`, { issue: true }));
  const all = await demandsOf(a, student.id);
  const by = (k: string) => all.find((d) => d.period_key === k)!;
  return { student, assignment, c1: by('C1'), c2: by('C2'), an: by('ANNUAL'), c3: by('C3'), all };
}

async function demandsOf(a: Api, studentId: string) {
  const list = ok<Json[]>(await a.get(`/fees/demands?student_id=${studentId}&page_size=100`));
  return list.sort((x, y) => String(x.due_date).localeCompare(String(y.due_date)));
}
const demand = async (a: Api, id: string) => ok(await a.get(`/fees/demands/${id}`));
const payment = async (a: Api, id: string) => ok(await a.get(`/fees/payments/${id}`));

function pay(a: Api, studentId: string, amount: string, extra: Json = {}) {
  return a.post('/fees/payments', { student_id: studentId, amount, method: 'CASH', ...extra });
}
/** Record a RECEIVED payment; returns the payment detail. */
async function paid(a: Api, studentId: string, amount: string, extra: Json = {}) {
  return ok(await pay(a, studentId, amount, extra), 201);
}
const manual = (...lines: [Json, string][]) => ({
  mode: 'MANUAL',
  allocations: lines.map(([d, amount]) => ({ fee_demand_id: d.id, amount })),
});

/** Full refund lifecycle up to COMPLETED (requested by `acct`, approved by `prin`). */
async function refundOf(paymentId: string, amount: string) {
  const r = ok(
    await acct.post('/fees/refunds', {
      payment_id: paymentId,
      amount,
      reason: 'Withdrawn student',
    }),
    201,
  );
  ok(await prin.post(`/fees/refunds/${r.id}/approve`, {}));
  ok(await prin.post(`/fees/refunds/${r.id}/process`, {}));
  return ok(await prin.post(`/fees/refunds/${r.id}/complete`, { provider_reference: uniq('RFD') }));
}

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  B = await h.provisionSchool();
  api = A.admin.api;
  bapi = B.admin.api;
  const member = async (role: string) =>
    (await h.addMember(api, [{ role_id: await h.roleId(api, role) }])).api;
  acct = await member('ACCOUNTANT');
  prin = await member('PRINCIPAL');
  recep = await member('RECEPTIONIST');
  teach = await member('TEACHER');
  FA = await fixture(api, 'A');
  FB = await fixture(bapi, 'B');
}, 120_000);
afterAll(() => h.close());

// ==================================================================================
describe('configuration: settings, categories and structures', () => {
  it('creates default fee settings on first read and updates them with the version', async () => {
    const s = ok(await api.get('/fees/settings'));
    expect(s.currency).toBeTruthy();
    expect(s.late_fee_enabled).toBe(false);
    const upd = ok(
      await api.patch('/fees/settings', {
        version: s.version,
        late_fee_enabled: true,
        late_fee_type: 'FIXED',
        late_fee_value: '75.50',
        late_fee_grace_days: 3,
      }),
    );
    expect(upd.late_fee_enabled).toBe(true);
    expect(upd.late_fee_value).toBe('75.50');
    expect(upd.version).toBe(s.version + 1);
    bad(
      await api.patch('/fees/settings', { version: s.version, late_fee_grace_days: 1 }),
      409,
      'CONFLICT',
      'STALE_VERSION',
    );
    // school A is left with late fees off again for the other tests
    ok(await api.patch('/fees/settings', { version: upd.version, late_fee_enabled: false }));
  });

  it('manages categories: unique codes, edits with versions, deactivate and reactivate', async () => {
    const c = ok(await api.post('/fees/categories', { code: 'lab', name: 'Lab fee' }), 201);
    expect(c.code).toBe('LAB');
    bad(
      await api.post('/fees/categories', { code: 'LAB', name: 'Again' }),
      409,
      'DUPLICATE_RESOURCE',
      'DUPLICATE_CODE',
    );
    const edited = ok(
      await api.patch(`/fees/categories/${c.id}`, { version: c.version, name: 'Laboratory' }),
    );
    expect(edited.name).toBe('Laboratory');
    bad(
      await api.patch(`/fees/categories/${c.id}`, { version: c.version, name: 'X' }),
      409,
      'CONFLICT',
    );
    const off = ok(await api.post(`/fees/categories/${c.id}/deactivate`, {}));
    expect(off.status).toBe('INACTIVE');
    const list = ok<Json[]>(await api.get('/fees/categories?status=INACTIVE'));
    expect(list.map((x) => x.id)).toContain(c.id);
    expect(ok(await api.post(`/fees/categories/${c.id}/activate`, {})).status).toBe('ACTIVE');
  });

  it('does not let an inactive category into a component', async () => {
    const c = ok(
      await api.post('/fees/categories', {
        code: uniq('OLD').toUpperCase().slice(0, 30),
        name: 'Old',
      }),
      201,
    );
    ok(await api.post(`/fees/categories/${c.id}/deactivate`, {}));
    const st = ok(
      await api.post('/fees/structures', {
        code: uniq('X').toUpperCase().slice(0, 30),
        name: 'Draft',
        academic_year_id: FA.yearId,
      }),
      201,
    );
    const res = await api.post(`/fees/structures/${st.id}/components`, {
      fee_category_id: c.id,
      name: 'Old fee',
      amount: '10.00',
      frequency: 'ONE_TIME',
    });
    bad(res, 422, undefined, 'CATEGORY_INACTIVE');
  });

  it('validates money, frequencies and due rules', async () => {
    const st = ok(
      await api.post('/fees/structures', {
        code: uniq('V').toUpperCase().slice(0, 30),
        name: 'Validation',
        academic_year_id: FA.yearId,
      }),
      201,
    );
    const add = (b: Json) =>
      api.post(`/fees/structures/${st.id}/components`, {
        fee_category_id: FA.catTuition,
        name: 'Fee',
        amount: '100.00',
        frequency: 'MONTHLY',
        ...b,
      });
    expect((await add({ amount: '10.999' })).status).toBe(422); // three decimals
    expect((await add({ amount: '0.00' })).status).toBe(422); // zero
    expect((await add({ amount: '-5.00' })).status).toBe(422); // negative
    expect((await add({ amount: 'ten' })).status).toBe(422);
    expect((await add({ due_rule: { type: 'FIXED_DATE', date: inDays(5) } })).status).toBe(422); // MONTHLY + fixed date
    expect((await add({ frequency: 'CUSTOM' })).status).toBe(422); // CUSTOM needs dates
    expect(
      (await add({ frequency: 'ONE_TIME', due_rule: { type: 'DAY_OF_MONTH', day: 40 } })).status,
    ).toBe(422);
    const good = ok(
      await add({ amount: '1234.50', due_rule: { type: 'DAY_OF_MONTH', day: 10 } }),
      201,
    );
    expect(good.amount).toBe('1234.50');
    expect(good.frequency).toBe('MONTHLY');
  });

  it('will not publish a structure without components, and publishes one that has them', async () => {
    const st = ok(
      await api.post('/fees/structures', {
        code: uniq('E').toUpperCase().slice(0, 30),
        name: 'Empty',
        academic_year_id: FA.yearId,
      }),
      201,
    );
    const res = await prin.post(`/fees/structures/${st.id}/publish`, {});
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('NO_COMPONENTS');
    ok(
      await api.post(`/fees/structures/${st.id}/components`, {
        fee_category_id: FA.catTuition,
        name: 'One',
        amount: '10.00',
        frequency: 'ONE_TIME',
      }),
      201,
    );
    const pub = ok(await prin.post(`/fees/structures/${st.id}/publish`, {}));
    expect(pub.status).toBe('PUBLISHED');
    expect(pub.published_at ?? pub.effective_from).toBeTruthy();
  });

  it('makes a published structure immutable; the way to change it is a new version', async () => {
    const st = ok(await api.get(`/fees/structures/${FA.structureId}`));
    expect(st.status).toBe('PUBLISHED');
    bad(
      await api.patch(`/fees/structures/${st.id}`, { version: st.version, name: 'Renamed' }),
      422,
      'INVALID_STATE',
      'STRUCTURE_NOT_DRAFT',
    );
    bad(
      await api.post(`/fees/structures/${st.id}/components`, {
        fee_category_id: FA.catTuition,
        name: 'Late add',
        amount: '1.00',
        frequency: 'ONE_TIME',
      }),
      422,
      'INVALID_STATE',
      'STRUCTURE_NOT_DRAFT',
    );
    const comp = st.components[0];
    bad(
      await api.patch(`/fees/components/${comp.id}`, { version: comp.version, amount: '1.00' }),
      422,
      'INVALID_STATE',
      'STRUCTURE_NOT_DRAFT',
    );
    bad(
      await api.delete(`/fees/components/${comp.id}?version=${comp.version}`),
      422,
      'INVALID_STATE',
      'STRUCTURE_NOT_DRAFT',
    );
  });

  it('only fees.structures.publish can publish or archive; managers can draft and duplicate', async () => {
    const dup = ok(
      await acct.post(`/fees/structures/${FA.structureId}/duplicate`, { name: 'Copy for review' }),
      201,
    );
    expect(dup.status).toBe('DRAFT');
    bad(await acct.post(`/fees/structures/${dup.id}/publish`, {}), 403, 'PERMISSION_DENIED');
    bad(await acct.post(`/fees/structures/${dup.id}/archive`, {}), 403, 'PERMISSION_DENIED');
    bad(
      await recep.post('/fees/structures', {
        code: 'NOPE',
        name: 'No',
        academic_year_id: FA.yearId,
      }),
      403,
      'PERMISSION_DENIED',
    );
    ok(await prin.post(`/fees/structures/${dup.id}/archive`, { reason: 'Not needed' }));
  });

  it('keeps issued demands unchanged when the structure gets a new published version', async () => {
    // A separate class so that this version chain does not disturb the shared fixture.
    const cls = ok(
      await api.post('/academic-classes', {
        code: uniq('G9').toUpperCase().slice(0, 30),
        name: 'Grade 9',
        sequence: 9,
      }),
      201,
    );
    const sec = ok(
      await api.post(`/academic-years/${FA.yearId}/sections`, {
        class_id: cls.id,
        code: 'Z',
        name: 'Section Z',
      }),
      201,
    );
    const code1 = uniq('CH').toUpperCase().slice(0, 30);
    const v1 = ok(
      await api.post('/fees/structures', {
        code: code1,
        name: 'Chain',
        academic_year_id: FA.yearId,
        academic_class_id: cls.id,
      }),
      201,
    );
    ok(
      await api.post(`/fees/structures/${v1.id}/components`, {
        fee_category_id: FA.catTuition,
        name: 'Tuition',
        amount: '1000.00',
        frequency: 'ONE_TIME',
        due_rule: { type: 'FIXED_DATE', date: daysAgo(5) },
      }),
      201,
    );
    ok(await prin.post(`/fees/structures/${v1.id}/publish`, {}));
    const s1 = ok(
      await api.post('/students', {
        first_name: 'Old',
        last_name: uniq('V1'),
        gender: 'MALE',
        enrollment: { academic_year_id: FA.yearId, class_id: cls.id, section_id: sec.id },
      }),
      201,
    );
    const a1 = ok(
      await api.post('/fees/assignments', { student_id: s1.id, fee_structure_id: v1.id }),
      201,
    );
    ok(await api.post(`/fees/assignments/${a1.id}/generate-demands`, { issue: true }));
    const before = (await demandsOf(api, s1.id))[0]!;
    expect(before.original_amount).toBe('1000.00');

    // version 2: same code, a higher amount
    const v2 = ok(await api.post(`/fees/structures/${v1.id}/duplicate`, {}), 201);
    expect(v2.code).toBe(code1);
    expect(v2.version_no).toBe(2);
    expect(v2.components).toHaveLength(1);
    ok(
      await api.patch(`/fees/components/${v2.components[0].id}`, {
        version: v2.components[0].version,
        amount: '2000.00',
      }),
    );
    ok(await prin.post(`/fees/structures/${v2.id}/publish`, {}));
    expect(ok(await api.get(`/fees/structures/${v1.id}`)).status).toBe('ARCHIVED');
    expect(ok(await api.get(`/fees/structures/${v2.id}`)).status).toBe('PUBLISHED');

    const after = await demand(api, before.id);
    expect(after.original_amount).toBe('1000.00');
    expect(after.final_amount).toBe('1000.00');
    expect(after.due_date).toBe(before.due_date);
    // regenerating for the old assignment does not touch existing demands or create new ones
    const again = ok(
      await api.post(`/fees/assignments/${a1.id}/generate-demands`, { issue: true }),
    );
    expect(again.created_count).toBe(0);
    // a student assigned to the new version pays the new amount
    const s2 = ok(
      await api.post('/students', {
        first_name: 'New',
        last_name: uniq('V2'),
        gender: 'MALE',
        enrollment: { academic_year_id: FA.yearId, class_id: cls.id, section_id: sec.id },
      }),
      201,
    );
    const a2 = ok(
      await api.post('/fees/assignments', { student_id: s2.id, fee_structure_id: v2.id }),
      201,
    );
    ok(await api.post(`/fees/assignments/${a2.id}/generate-demands`, { issue: true }));
    expect((await demandsOf(api, s2.id))[0]!.original_amount).toBe('2000.00');
    // archived versions cannot be assigned any more
    const s3 = ok(
      await api.post('/students', {
        first_name: 'Late',
        last_name: uniq('V3'),
        gender: 'MALE',
        enrollment: { academic_year_id: FA.yearId, class_id: cls.id, section_id: sec.id },
      }),
      201,
    );
    expect(
      (await api.post('/fees/assignments', { student_id: s3.id, fee_structure_id: v1.id })).status,
    ).toBe(422);
  });

  it('lists structures with filters', async () => {
    const list = await api.get(
      `/fees/structures?academic_year_id=${FA.yearId}&status=PUBLISHED&page_size=100`,
    );
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBeGreaterThanOrEqual(1);
    expect(list.body.data.every((s: Json) => s.status === 'PUBLISHED')).toBe(true);
    expect(list.body.data.map((s: Json) => s.id)).toContain(FA.structureId);
  });
});

// ==================================================================================
describe('assignments and demand generation', () => {
  it('assigns a published structure to an enrolled student and rejects a second assignment', async () => {
    const s = await newStudent(api, FA);
    const a = ok(
      await api.post('/fees/assignments', { student_id: s.id, fee_structure_id: FA.structureId }),
      201,
    );
    expect(a.status).toBe('ACTIVE');
    expect(a.structure_code).toBe(`STD-A`);
    bad(
      await api.post('/fees/assignments', { student_id: s.id, fee_structure_id: FA.structureId }),
      409,
      undefined,
      'ALREADY_ASSIGNED',
    );
  });

  it('summarises what one student was billed, paid and still owes', async () => {
    const b = await bill(api, FA);
    const before = ok(await api.get(`/fees/students/${b.student.id}/summary`));
    expect(Number(before.billed)).toBeGreaterThan(0);
    expect(Number(before.paid)).toBe(0);
    expect(before.outstanding).toBe(before.billed);
    expect(before.demands).toBe(b.all.length);
    const p = await paid(api, b.student.id, '100.00');
    ok(await api.post(`/fees/payments/${p.id}/allocate`, manual([b.c1, '100.00'])));
    const after = ok(await api.get(`/fees/students/${b.student.id}/summary`));
    expect(Number(after.paid)).toBe(100);
    expect(Number(after.outstanding)).toBeCloseTo(Number(before.billed) - 100, 2);
    expect(ok(await bapi.get(`/fees/students/${b.student.id}/summary`)).demands).toBe(0);
  });

  it('refuses a draft structure and a student without an enrollment', async () => {
    const draft = ok(
      await api.post('/fees/structures', {
        code: uniq('D').toUpperCase().slice(0, 30),
        name: 'Draft',
        academic_year_id: FA.yearId,
      }),
      201,
    );
    const s = await newStudent(api, FA);
    expect(
      (await api.post('/fees/assignments', { student_id: s.id, fee_structure_id: draft.id }))
        .status,
    ).toBe(422);
    const unenrolled = await newStudent(api, FA, undefined, false);
    expect(
      (
        await api.post('/fees/assignments', {
          student_id: unenrolled.id,
          fee_structure_id: FA.structureId,
        })
      ).status,
    ).toBe(422);
  });

  it('bulk-assigns a whole section and is idempotent', async () => {
    const sec = ok(
      await api.post(`/academic-years/${FA.yearId}/sections`, {
        class_id: FA.classId,
        code: uniq('S').toUpperCase().slice(0, 20),
        name: 'Bulk',
      }),
      201,
    );
    for (let i = 0; i < 3; i++) await newStudent(api, FA, sec.id);
    const first = ok(
      await api.post('/fees/assignments/bulk', {
        fee_structure_id: FA.structureId,
        section_id: sec.id,
      }),
    );
    expect(first.assigned).toBe(3);
    expect(first.skipped_existing).toBe(0);
    const second = ok(
      await api.post('/fees/assignments/bulk', {
        fee_structure_id: FA.structureId,
        section_id: sec.id,
      }),
    );
    expect(second.assigned).toBe(0);
    expect(second.skipped_existing).toBe(3);
    // a class-wide assignment is allowed too; students already assigned are skipped
    const classWide = ok(
      await api.post('/fees/assignments/bulk', {
        fee_structure_id: FA.structureId,
        class_id: FA.classId,
      }),
    );
    expect(classWide.skipped_existing).toBeGreaterThanOrEqual(3);
    const gen = ok(
      await api.post('/fees/assignments/generate-demands', {
        fee_structure_id: FA.structureId,
        section_id: sec.id,
      }),
    );
    expect(gen.assignments).toBe(3);
    expect(gen.created_count).toBe(12);
    expect(
      ok(
        await api.post('/fees/assignments/generate-demands', {
          fee_structure_id: FA.structureId,
          section_id: sec.id,
        }),
      ).created_count,
    ).toBe(0);
  });

  it('generates demands as DRAFT with every amount part and a snapshot of the due date', async () => {
    const s = await newStudent(api, FA);
    const a = ok(
      await api.post('/fees/assignments', { student_id: s.id, fee_structure_id: FA.structureId }),
      201,
    );
    const preview = ok(await api.get(`/fees/assignments/${a.id}/preview-demands`));
    expect(JSON.stringify(preview)).toContain('C1');
    expect(await demandsOf(api, s.id)).toHaveLength(0); // a preview creates nothing
    const gen = ok(await api.post(`/fees/assignments/${a.id}/generate-demands`, {}));
    expect(gen.created_count).toBe(4);
    const ds = await demandsOf(api, s.id);
    expect(ds.map((d) => d.period_key)).toEqual(['C1', 'C2', 'ANNUAL', 'C3']);
    expect(ds.every((d) => d.status === 'DRAFT')).toBe(true);
    const c1 = ds[0]!;
    expect(c1).toMatchObject({
      original_amount: '1000.00',
      discount_amount: '0.00',
      concession_amount: '0.00',
      waiver_amount: '0.00',
      late_fee_amount: '0.00',
      final_amount: '1000.00',
      paid_amount: '0.00',
      outstanding_amount: '1000.00',
      due_date: daysAgo(60),
    });
    expect(c1.demand_number).toMatch(/^FEE-\d{4}-\d{5}$/);
    expect(new Set(ds.map((d) => d.demand_number)).size).toBe(4);
  });

  it('generates idempotently: the same assignment, component and period never gets a second demand', async () => {
    const s = await newStudent(api, FA);
    const a = ok(
      await api.post('/fees/assignments', { student_id: s.id, fee_structure_id: FA.structureId }),
      201,
    );
    const [x, y] = await Promise.all([
      api.post(`/fees/assignments/${a.id}/generate-demands`, {}),
      api.post(`/fees/assignments/${a.id}/generate-demands`, {}),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 200]);
    expect(x.body.data.created_count + y.body.data.created_count).toBe(4);
    expect(await demandsOf(api, s.id)).toHaveLength(4);
    const only = ok(
      await api.post(`/fees/assignments/${a.id}/generate-demands`, { period_keys: ['C1'] }),
    );
    expect(only.created_count).toBe(0);
    expect(only.skipped_existing).toBe(1);
  });

  it('issues draft demands one by one and in bulk, and rejects issuing twice', async () => {
    const s = await newStudent(api, FA);
    const a = ok(
      await api.post('/fees/assignments', { student_id: s.id, fee_structure_id: FA.structureId }),
      201,
    );
    ok(await api.post(`/fees/assignments/${a.id}/generate-demands`, {}));
    const ds = await demandsOf(api, s.id);
    const one = ok(await api.post(`/fees/demands/${ds[0]!.id}/issue`, {}));
    expect(one.status).toBe('OVERDUE'); // due 60 days ago
    bad(await api.post(`/fees/demands/${ds[0]!.id}/issue`, {}), 422, 'INVALID_STATE', 'NOT_DRAFT');
    const bulk = ok(
      await api.post('/fees/demands/issue', { demand_ids: ds.slice(1).map((d) => d.id) }),
    );
    expect(bulk.issued).toBe(3);
    const after = await demandsOf(api, s.id);
    expect(after.map((d) => d.status)).toEqual(['OVERDUE', 'OVERDUE', 'ISSUED', 'ISSUED']);
  });

  it('reads past-due demands as OVERDUE, filters on it and can persist the status', async () => {
    const b = await bill(api, FA);
    expect([b.c1.status, b.c2.status, b.an.status, b.c3.status]).toEqual([
      'OVERDUE',
      'OVERDUE',
      'ISSUED',
      'ISSUED',
    ]);
    expect(b.c1.days_overdue).toBeGreaterThanOrEqual(59);
    const overdue = ok<Json[]>(
      await api.get(`/fees/demands?student_id=${b.student.id}&status=OVERDUE`),
    );
    expect(overdue).toHaveLength(2);
    const swept = ok(await api.post('/fees/demands/mark-overdue', {}));
    expect(JSON.stringify(swept)).toMatch(/\d/);
    const again = ok(await api.post('/fees/demands/mark-overdue', {}));
    expect(JSON.stringify(again)).not.toEqual('');
    expect((await demand(api, b.c1.id)).status).toBe('OVERDUE');
  });

  it('cancels a demand with a reason but not one that has payments', async () => {
    const b = await bill(api, FA);
    bad(await api.post(`/fees/demands/${b.c3.id}/cancel`, {}), 422, 'VALIDATION_ERROR');
    const cancelled = ok(
      await api.post(`/fees/demands/${b.c3.id}/cancel`, { reason: 'Student left early' }),
    );
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.outstanding_amount).toBe('0.00');
    const p = await paid(api, b.student.id, '100.00');
    ok(await api.post(`/fees/payments/${p.id}/allocate`, manual([b.an, '100.00'])));
    bad(
      await api.post(`/fees/demands/${b.an.id}/cancel`, { reason: 'Mistake' }),
      422,
      'OPERATION_NOT_ALLOWED',
      'HAS_PAYMENTS',
    );
  });

  it('cancels an assignment: draft demands are cancelled, issued demands stay', async () => {
    const s = await newStudent(api, FA);
    const a = ok(
      await api.post('/fees/assignments', { student_id: s.id, fee_structure_id: FA.structureId }),
      201,
    );
    ok(await api.post(`/fees/assignments/${a.id}/generate-demands`, {}));
    const ds = await demandsOf(api, s.id);
    ok(await api.post(`/fees/demands/${ds[0]!.id}/issue`, {}));
    const res = ok(
      await api.post(`/fees/assignments/${a.id}/cancel`, { reason: 'Moved to another school' }),
    );
    expect(res.status).toBe('CANCELLED');
    const after = await demandsOf(api, s.id);
    expect(after[0]!.status).toBe('OVERDUE');
    expect(after.slice(1).every((d) => d.status === 'CANCELLED')).toBe(true);
    bad(
      await api.post(`/fees/assignments/${a.id}/cancel`, { reason: 'Again' }),
      422,
      undefined,
      'ALREADY_CANCELLED',
    );
  });

  it('writes off a balance only with a reason and fees.waivers.approve', async () => {
    const b = await bill(api, FA);
    bad(
      await acct.post(`/fees/demands/${b.c1.id}/write-off`, { reason: 'Uncollectable' }),
      403,
      'PERMISSION_DENIED',
    );
    bad(await prin.post(`/fees/demands/${b.c1.id}/write-off`, {}), 422, 'VALIDATION_ERROR');
    const w = ok(
      await prin.post(`/fees/demands/${b.c1.id}/write-off`, {
        reason: 'Uncollectable after 60 days',
      }),
    );
    expect(w.status).toBe('WRITTEN_OFF');
    expect(w.written_off_amount).toBe('1000.00');
    expect(w.outstanding_amount).toBe('0.00');
    expect(w.write_off_reason).toBe('Uncollectable after 60 days');
    bad(await prin.post(`/fees/demands/${b.c1.id}/write-off`, { reason: 'Again' }), 422);
  });

  it('applies a direct discount (percent) and only for those who may waive', async () => {
    const b = await bill(api, FA);
    bad(
      await acct.post(`/fees/demands/${b.c3.id}/discount`, {
        value_type: 'PERCENT',
        value: '10.00',
        reason: 'Staff child',
      }),
      403,
      'PERMISSION_DENIED',
    );
    const d = ok(
      await prin.post(`/fees/demands/${b.c3.id}/discount`, {
        value_type: 'PERCENT',
        value: '10.00',
        reason: 'Staff child',
      }),
    );
    expect(d.discount_amount).toBe('100.00');
    expect(d.final_amount).toBe('900.00');
    expect(d.original_amount).toBe('1000.00');
    expect(d.outstanding_amount).toBe('900.00');
    const over = await prin.post(`/fees/demands/${b.c3.id}/discount`, {
      value_type: 'AMOUNT',
      value: '5000.00',
      reason: 'Too much',
    });
    bad(over, 422, 'OPERATION_NOT_ALLOWED', 'EXCEEDS_OUTSTANDING');
  });

  it('assigns with a percentage discount only for those who may waive; demands carry it', async () => {
    const s1 = await newStudent(api, FA);
    bad(
      await acct.post('/fees/assignments', {
        student_id: s1.id,
        fee_structure_id: FA.structureId,
        discount_percent: '20.00',
        discount_reason: 'Scholarship',
      }),
      403,
      'PERMISSION_DENIED',
    );
    const a = ok(
      await api.post('/fees/assignments', {
        student_id: s1.id,
        fee_structure_id: FA.structureId,
        discount_percent: '20.00',
        discount_reason: 'Scholarship',
      }),
      201,
    );
    expect(a.discount_percent).toBe('20.00');
    ok(await api.post(`/fees/assignments/${a.id}/generate-demands`, { issue: true }));
    const c3 = (await demandsOf(api, s1.id)).find((d) => d.period_key === 'C3')!;
    expect(c3.original_amount).toBe('1000.00');
    expect(c3.discount_amount).toBe('200.00');
    expect(c3.final_amount).toBe('800.00');
  });

  it('applies the late fee rule once per demand, never twice', async () => {
    // school B, so that the late fee setting does not leak into the other tests
    const s = ok(await bapi.get('/fees/settings'));
    const on = ok(
      await bapi.patch('/fees/settings', {
        version: s.version,
        late_fee_enabled: true,
        late_fee_type: 'FIXED',
        late_fee_value: '50.00',
        late_fee_grace_days: 0,
      }),
    );
    const b = await bill(bapi, FB);
    const one = ok(await bapi.post(`/fees/demands/${b.c1.id}/late-fee`, {}));
    expect(one.late_fee_amount).toBe('50.00');
    expect(one.final_amount).toBe('1050.00');
    expect(one.outstanding_amount).toBe('1050.00');
    const second = await bapi.post(`/fees/demands/${b.c1.id}/late-fee`, {});
    expect([200, 422]).toContain(second.status);
    expect((await demand(bapi, b.c1.id)).late_fee_amount).toBe('50.00');
    // a demand that is not overdue gets none
    expect([200, 422]).toContain((await bapi.post(`/fees/demands/${b.c3.id}/late-fee`, {})).status);
    expect((await demand(bapi, b.c3.id)).late_fee_amount).toBe('0.00');
    const bulk = ok(
      await bapi.post('/fees/demands/apply-late-fees', { demand_ids: [b.c1.id, b.c2.id, b.c3.id] }),
    );
    expect(JSON.stringify(bulk)).toBeTruthy();
    expect((await demand(bapi, b.c1.id)).late_fee_amount).toBe('50.00');
    expect((await demand(bapi, b.c2.id)).late_fee_amount).toBe('50.00');
    expect((await demand(bapi, b.c3.id)).late_fee_amount).toBe('0.00');
    ok(await bapi.patch('/fees/settings', { version: on.version, late_fee_enabled: false }));
    const off = await bapi.post(`/fees/demands/${b.an.id}/late-fee`, {});
    expect(off.status).toBe(422);
  });
});

// ==================================================================================
describe('concessions and waivers: request, approve, apply', () => {
  const request = (a: Api, d: Json, b: Json = {}) =>
    a.post('/fees/adjustments', {
      type: 'CONCESSION',
      fee_demand_id: d.id,
      value_type: 'AMOUNT',
      value: '200.00',
      reason: 'Sibling concession',
      ...b,
    });

  it('runs request, approve and apply; the demand changes only on apply', async () => {
    const b = await bill(api, FA);
    const r = ok(await request(acct, b.c3), 201);
    expect(r.status).toBe('REQUESTED');
    expect((await demand(api, b.c3.id)).final_amount).toBe('1000.00');
    const ap = ok(await prin.post(`/fees/adjustments/${r.id}/approve`, { note: 'OK' }));
    expect(ap.status).toBe('APPROVED');
    expect((await demand(api, b.c3.id)).final_amount).toBe('1000.00'); // approved is not applied yet
    const applied = ok(await prin.post(`/fees/adjustments/${r.id}/apply`, {}));
    expect(applied.status).toBe('APPLIED');
    expect(applied.applied_amount).toBe('200.00');
    const d = await demand(api, b.c3.id);
    expect(d.concession_amount).toBe('200.00');
    expect(d.final_amount).toBe('800.00');
    expect(d.original_amount).toBe('1000.00');
    expect(d.adjustments.map((x: Json) => x.id)).toContain(r.id);
  });

  it('separates duties: the requester can never approve their own request', async () => {
    const b = await bill(api, FA);
    const r = ok(await request(acct, b.c3), 201);
    bad(await acct.post(`/fees/adjustments/${r.id}/approve`, {}), 403, 'PERMISSION_DENIED'); // no approval right at all
    const own = ok(await request(api, b.c2), 201); // the admin has both rights
    bad(
      await api.post(`/fees/adjustments/${own.id}/approve`, {}),
      403,
      'PERMISSION_DENIED',
      'SEPARATION_OF_DUTIES',
    );
    expect(ok(await prin.post(`/fees/adjustments/${own.id}/approve`, {})).status).toBe('APPROVED');
  });

  it('prices a percentage concession from the original amount', async () => {
    const b = await bill(api, FA);
    const r = ok(
      await request(acct, b.c3, { value_type: 'PERCENT', value: '25.00', type: 'WAIVER' }),
      201,
    );
    ok(await prin.post(`/fees/adjustments/${r.id}/approve`, {}));
    const applied = ok(await prin.post(`/fees/adjustments/${r.id}/apply`, {}));
    expect(applied.applied_amount).toBe('250.00');
    const d = await demand(api, b.c3.id);
    expect(d.waiver_amount).toBe('250.00');
    expect(d.final_amount).toBe('750.00');
  });

  it('rejects with a reason, and refuses to apply what is not approved', async () => {
    const b = await bill(api, FA);
    const r = ok(await request(acct, b.c3), 201);
    bad(
      await prin.post(`/fees/adjustments/${r.id}/apply`, {}),
      422,
      'INVALID_STATE',
      'NOT_APPROVED',
    );
    bad(await prin.post(`/fees/adjustments/${r.id}/reject`, {}), 422, 'VALIDATION_ERROR');
    const rej = ok(
      await prin.post(`/fees/adjustments/${r.id}/reject`, { reason: 'No evidence provided' }),
    );
    expect(rej.status).toBe('REJECTED');
    bad(await prin.post(`/fees/adjustments/${r.id}/approve`, {}), 422, 'INVALID_STATE');
    expect((await demand(api, b.c3.id)).final_amount).toBe('1000.00');
  });

  it('lets the requester withdraw a request, and no one else without approval rights', async () => {
    const b = await bill(api, FA);
    const r = ok(await request(acct, b.c3), 201);
    bad(
      await recep.post(`/fees/adjustments/${r.id}/cancel`, { reason: 'Not mine' }),
      403,
      'PERMISSION_DENIED',
    );
    const c = ok(
      await acct.post(`/fees/adjustments/${r.id}/cancel`, { reason: 'Entered by mistake' }),
    );
    expect(c.status).toBe('CANCELLED');
  });

  it('refuses more than the outstanding balance and requests from people without the right', async () => {
    const b = await bill(api, FA);
    bad(await request(acct, b.c3, { value: '5000.00' }), 422, undefined, 'EXCEEDS_OUTSTANDING');
    bad(await request(teach, b.c3), 403, 'PERMISSION_DENIED');
    bad(await request(recep, b.c3), 403, 'PERMISSION_DENIED');
    expect((await request(acct, b.c3, { value: '0.00' })).status).toBe(422);
  });
});

// ==================================================================================
describe('payments and receipts', () => {
  it('reports billed and collected per class', async () => {
    const b = await bill(api, FA);
    await paid(acct, b.student.id, '100.00');
    const rep = ok(await api.get('/fees/reports/by-class'));
    expect(rep.academic_year).toBeTruthy();
    const total = rep.classes.reduce((n: number, c: Json) => n + Number(c.billed), 0);
    expect(total).toBeGreaterThan(0);
    expect(Number(rep.totals.billed)).toBeCloseTo(total, 2);
    expect(Number(rep.totals.collected)).toBeGreaterThanOrEqual(100);
    for (const c of rep.classes) {
      expect(Number(c.collected)).toBeLessThanOrEqual(Number(c.billed));
    }
    expect((await teach.get('/fees/reports/by-class')).status).toBe(403);
  });

  it('refuses gateway methods: payments are recorded, never collected here', async () => {
    const b = await bill(api, FA);
    for (const method of ['UPI', 'ONLINE_GATEWAY']) {
      const r = await pay(acct, b.student.id, '10.00', { method, provider_reference: uniq('G') });
      expect(r.status, method).toBe(422);
    }
  });

  it('prints a receipt as a PDF and keeps proof of payment', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '250.00', {
      method: 'BANK_TRANSFER',
      provider_reference: uniq('EFT'),
      payer_name: 'J. Botha',
    });
    const bin = (url: string) =>
      h.http
        .get(`/api/v1${url}`)
        .set('Authorization', `Bearer ${acct.token}`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
    const pdf = await bin(`/fees/receipts/${p.receipts[0].id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const slip = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
    const up = await h.http
      .post(`/api/v1/fees/payments/${p.id}/proofs?filename=eft.pdf`)
      .set('Authorization', `Bearer ${acct.token}`)
      .set('Content-Type', 'application/pdf')
      .send(slip);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const list = ok<Json[]>(await acct.get(`/fees/payments/${p.id}/proofs`));
    expect(list).toHaveLength(1);
    expect(list[0]!.file_name).toBe('eft.pdf');
    expect((await bin(`/fees/payments/${p.id}/proofs/${list[0]!.id}/file`)).status).toBe(200);
    // a teacher cannot attach proof
    const denied = await h.http
      .post(`/api/v1/fees/payments/${p.id}/proofs?filename=x.pdf`)
      .set('Authorization', `Bearer ${teach.token}`)
      .set('Content-Type', 'application/pdf')
      .send(slip);
    expect([403, 404]).toContain(denied.status);
  });

  it('records a RECEIVED payment: numbered, receipted and available to allocate', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '600.00', { payer_name: 'Ravi Sharma' });
    expect(p.status).toBe('RECEIVED');
    expect(p.payment_number).toMatch(/^PAY-\d{4}-\d{5}$/);
    expect(p.available_to_allocate).toBe('600.00');
    expect(p.receipts).toHaveLength(1);
    expect(p.receipts[0].receipt_number).toMatch(/^RCT-\d{4}-\d{5}$/);
    expect(p.receipts[0].status).toBe('ISSUED');
    expect(p.receipts[0].amount).toBe('600.00');
  });

  it('holds a PENDING cheque without a receipt until it is received', async () => {
    const b = await bill(api, FA);
    const p = ok(
      await pay(acct, b.student.id, '300.00', {
        method: 'CHEQUE',
        status: 'PENDING',
        provider_reference: uniq('CHQ'),
      }),
      201,
    );
    expect(p.status).toBe('PENDING');
    expect(p.receipts).toHaveLength(0);
    expect(p.available_to_allocate).toBe('0.00');
    bad(
      await acct.post(`/fees/payments/${p.id}/allocate`, { mode: 'AUTO' }),
      422,
      'OPERATION_NOT_ALLOWED',
      'PAYMENT_NOT_ALLOCATABLE',
    );
    const rec = ok(await acct.post(`/fees/payments/${p.id}/receive`, {}));
    expect(rec.status).toBe('RECEIVED');
    expect(rec.receipts).toHaveLength(1);
    bad(await acct.post(`/fees/payments/${p.id}/receive`, {}), 422, 'INVALID_STATE', 'NOT_PENDING');
  });

  it('is idempotent on the idempotency key: a retry returns the same payment', async () => {
    const b = await bill(api, FA);
    const key = uniq('idem');
    const first = await pay(acct, b.student.id, '250.00', { idempotency_key: key });
    expect(first.status).toBe(201);
    const retry = await pay(acct, b.student.id, '250.00', { idempotency_key: key });
    expect(retry.status).toBe(200);
    expect(retry.body.meta.replayed).toBe(true);
    expect(retry.body.data.id).toBe(first.body.data.id);
    expect(retry.body.data.receipts).toHaveLength(1);
    const list = ok<Json[]>(await api.get(`/fees/payments?student_id=${b.student.id}`));
    expect(list).toHaveLength(1);
    // the same key with different content is a conflict, not a second payment
    bad(
      await pay(acct, b.student.id, '999.00', { idempotency_key: key }),
      409,
      'DUPLICATE_RESOURCE',
      'IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('records parallel retries of one idempotency key exactly once', async () => {
    const b = await bill(api, FA);
    const key = uniq('race');
    const res = await Promise.all(
      Array.from({ length: 5 }, () => pay(acct, b.student.id, '100.00', { idempotency_key: key })),
    );
    expect(res.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(res.map((r) => r.body.data.id)).size).toBe(1);
    const receipts = new Set(res.map((r) => r.body.data.receipts[0]?.receipt_number));
    expect(receipts.size).toBe(1);
  });

  it('keeps provider references unique per school, and only per school', async () => {
    const b = await bill(api, FA);
    const ref = uniq('UTR');
    ok(
      await pay(acct, b.student.id, '100.00', { method: 'BANK_TRANSFER', provider_reference: ref }),
      201,
    );
    const other = await bill(api, FA);
    bad(
      await pay(acct, other.student.id, '100.00', {
        method: 'BANK_TRANSFER',
        provider_reference: ref,
      }),
      409,
      'DUPLICATE_RESOURCE',
      'DUPLICATE_PROVIDER_REFERENCE',
    );
    const bb = await bill(bapi, FB);
    ok(
      await pay(bapi, bb.student.id, '100.00', {
        method: 'BANK_TRANSFER',
        provider_reference: ref,
      }),
      201,
    );
  });

  it('validates payments: amount, method, future date', async () => {
    const b = await bill(api, FA);
    expect((await pay(acct, b.student.id, '0.00')).status).toBe(422);
    expect((await pay(acct, b.student.id, '10.001')).status).toBe(422);
    expect((await pay(acct, b.student.id, '10.00', { method: 'BITCOIN' })).status).toBe(422);
    expect(
      (
        await pay(acct, b.student.id, '10.00', {
          received_at: new Date(Date.now() + 3 * DAY).toISOString(),
        })
      ).status,
    ).toBe(422);
    expect((await pay(acct, b.student.id, '10.00', { idempotency_key: 'short' })).status).toBe(422);
  });

  it('allocates automatically, oldest due date first', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '1500.00');
    const res = ok(await acct.post(`/fees/payments/${p.id}/allocate`, { mode: 'AUTO' }));
    expect(res.allocated_amount).toBe('1500.00');
    expect(res.available_to_allocate).toBe('0.00');
    expect(res.allocations.map((a: Json) => a.allocated_amount)).toEqual(['1000.00', '500.00']);
    const c1 = await demand(api, b.c1.id);
    const c2 = await demand(api, b.c2.id);
    expect(c1.status).toBe('PAID');
    expect(c1.outstanding_amount).toBe('0.00');
    expect(c2.status).toBe('OVERDUE'); // partly paid but past due
    expect(c2.paid_amount).toBe('500.00');
    expect(c2.outstanding_amount).toBe('500.00');
    expect((await demand(api, b.c3.id)).paid_amount).toBe('0.00');
  });

  it('allocates at creation, leaves the rest as credit, and marks demands PARTIALLY_PAID when not yet due', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '5000.00', { allocation: { mode: 'AUTO' } });
    expect(p.allocated_amount).toBe('3500.00');
    expect(p.unallocated_amount).toBe('1500.00');
    expect(p.available_to_allocate).toBe('1500.00');
    const all = await demandsOf(api, b.student.id);
    expect(all.every((d) => d.status === 'PAID' && d.outstanding_amount === '0.00')).toBe(true);
    const ledger = ok(await api.get(`/fees/students/${b.student.id}/ledger`));
    expect(ledger.summary.unallocated_credit).toBe('1500.00');
    expect(ledger.summary.net_balance).toBe('-1500.00');
    const b2 = await bill(api, FA);
    const p2 = await paid(acct, b2.student.id, '3000.00');
    ok(await acct.post(`/fees/payments/${p2.id}/allocate`, manual([b2.c3, '400.00'])));
    const part = await demand(api, b2.c3.id);
    expect(part.status).toBe('PARTIALLY_PAID');
    expect(part.outstanding_amount).toBe('600.00');
  });

  it('never allocates more than the demand outstanding or the payment holds', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '1500.00');
    bad(
      await acct.post(`/fees/payments/${p.id}/allocate`, manual([b.c1, '1000.01'])),
      422,
      'OPERATION_NOT_ALLOWED',
      'EXCEEDS_OUTSTANDING',
    );
    bad(
      await acct.post(
        `/fees/payments/${p.id}/allocate`,
        manual([b.c1, '1000.00'], [b.c2, '1000.00']),
      ),
      422,
      'OPERATION_NOT_ALLOWED',
      'EXCEEDS_PAYMENT',
    );
    const pay2 = await paid(acct, b.student.id, '1000.00');
    ok(await acct.post(`/fees/payments/${pay2.id}/allocate`, manual([b.c1, '1000.00'])));
    const p3 = await paid(acct, b.student.id, '10.00');
    bad(
      await acct.post(`/fees/payments/${p3.id}/allocate`, manual([b.c1, '10.00'])),
      422,
      'OPERATION_NOT_ALLOWED',
      'DEMAND_NOT_PAYABLE',
    ); // c1 is settled
    expect((await payment(api, p.id)).allocated_amount).toBe('0.00'); // failed calls changed nothing
  });

  it('rejects allocating to another student’s demand, and to a cancelled demand', async () => {
    const b1 = await bill(api, FA);
    const b2 = await bill(api, FA);
    const p = await paid(acct, b1.student.id, '500.00');
    bad(
      await acct.post(`/fees/payments/${p.id}/allocate`, manual([b2.c1, '100.00'])),
      422,
      'OPERATION_NOT_ALLOWED',
      'STUDENT_MISMATCH',
    );
    ok(await api.post(`/fees/demands/${b1.c3.id}/cancel`, { reason: 'Not applicable' }));
    expect(
      (await acct.post(`/fees/payments/${p.id}/allocate`, manual([b1.c3, '100.00']))).status,
    ).toBe(422);
  });

  it('reverses one allocation and re-opens the demand balance', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '1000.00', { allocation: { mode: 'AUTO' } });
    expect((await demand(api, b.c1.id)).status).toBe('PAID');
    const alloc = p.allocations[0];
    bad(
      await recep.post(`/fees/payments/${p.id}/allocations/${alloc.id}/reverse`, {
        reason: 'Wrong demand',
      }),
      403,
      'PERMISSION_DENIED',
    ); // needs payments.verify
    bad(
      await acct.post(`/fees/payments/${p.id}/allocations/${alloc.id}/reverse`, {}),
      422,
      'VALIDATION_ERROR',
    );
    const res = ok(
      await acct.post(`/fees/payments/${p.id}/allocations/${alloc.id}/reverse`, {
        reason: 'Wrong demand',
      }),
    );
    expect(res.allocated_amount).toBe('0.00');
    expect(res.available_to_allocate).toBe('1000.00');
    expect(res.allocations[0].status).toBe('REVERSED');
    const c1 = await demand(api, b.c1.id);
    expect(c1.paid_amount).toBe('0.00');
    expect(c1.outstanding_amount).toBe('1000.00');
    expect(c1.status).toBe('OVERDUE');
    bad(
      await acct.post(`/fees/payments/${p.id}/allocations/${alloc.id}/reverse`, {
        reason: 'Again',
      }),
      422,
      'INVALID_STATE',
      'ALREADY_REVERSED',
    );
    // the money can be applied to a different demand
    ok(await acct.post(`/fees/payments/${p.id}/allocate`, manual([b.c2, '1000.00'])));
    expect((await demand(api, b.c2.id)).status).toBe('PAID');
  });
});

// ==================================================================================
describe('verification, failure, cancellation and receipts', () => {
  it('verifies a received payment once; recording needs no verify right', async () => {
    const b = await bill(api, FA);
    const p = await paid(recep, b.student.id, '100.00'); // the receptionist may record cash
    bad(await recep.post(`/fees/payments/${p.id}/verify`, {}), 403, 'PERMISSION_DENIED');
    const v = ok(await acct.post(`/fees/payments/${p.id}/verify`, { note: 'Seen on statement' }));
    expect(v.status).toBe('VERIFIED');
    expect(v.verified_at).toBeTruthy();
    bad(
      await acct.post(`/fees/payments/${p.id}/verify`, {}),
      422,
      'INVALID_STATE',
      'NOT_VERIFIABLE',
    );
    // a verified payment can still be allocated
    ok(await acct.post(`/fees/payments/${p.id}/allocate`, { mode: 'AUTO' }));
  });

  it('fails a pending payment and refuses to fail a received one', async () => {
    const b = await bill(api, FA);
    const chq = ok(
      await pay(acct, b.student.id, '100.00', { method: 'CHEQUE', status: 'PENDING' }),
      201,
    );
    const f = ok(await acct.post(`/fees/payments/${chq.id}/fail`, { reason: 'Cheque bounced' }));
    expect(f.status).toBe('FAILED');
    expect(f.failed_reason).toBe('Cheque bounced');
    const rec = await paid(acct, b.student.id, '100.00');
    bad(
      await acct.post(`/fees/payments/${rec.id}/fail`, { reason: 'Nope' }),
      422,
      'INVALID_STATE',
      'NOT_PENDING',
    );
  });

  it('cancels a payment: allocations reversed, demands re-opened, receipt voided', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '1200.00', { allocation: { mode: 'AUTO' } });
    expect((await demand(api, b.c1.id)).status).toBe('PAID');
    const c = ok(
      await acct.post(`/fees/payments/${p.id}/cancel`, {
        reason: 'Recorded against the wrong child',
      }),
    );
    expect(c.status).toBe('CANCELLED');
    expect(c.allocated_amount).toBe('0.00');
    expect(c.receipts[0].status).toBe('VOID');
    expect(c.available_to_allocate).toBe('0.00');
    const [d1, d2] = [await demand(api, b.c1.id), await demand(api, b.c2.id)];
    expect(d1.outstanding_amount).toBe('1000.00');
    expect(d2.outstanding_amount).toBe('1000.00');
    expect(d1.paid_amount).toBe('0.00');
    expect(d1.status).toBe('OVERDUE');
    bad(
      await acct.post(`/fees/payments/${p.id}/cancel`, { reason: 'Twice' }),
      422,
      'INVALID_STATE',
      'NOT_CANCELLABLE',
    );
  });

  it('numbers receipts per school without gaps and never reuses a voided number', async () => {
    const b = await bill(bapi, FB);
    const nums: number[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await paid(bapi, b.student.id, '10.00');
      nums.push(Number(p.receipts[0].receipt_number.split('-')[2]));
    }
    expect(nums[1]).toBe(nums[0]! + 1);
    expect(nums[2]).toBe(nums[1]! + 1);
    // parallel payments still get distinct consecutive numbers
    const par = await Promise.all(
      Array.from({ length: 6 }, () => pay(bapi, b.student.id, '10.00')),
    );
    const parNums = par
      .map((r) => Number(r.body.data.receipts[0].receipt_number.split('-')[2]))
      .sort((x, y) => x - y);
    expect(par.every((r) => r.status === 201)).toBe(true);
    expect(parNums).toEqual(Array.from({ length: 6 }, (_, i) => nums[2]! + 1 + i));
    // school A has its own sequence
    const a = await bill(api, FA);
    const pa = await paid(acct, a.student.id, '10.00');
    expect(pa.receipts[0].receipt_number).not.toBe('');
    // voiding keeps the number burnt; a re-issued receipt takes the next one
    const last = par[0]!.body.data;
    bad(
      await bapi.post(`/fees/payments/${last.id}/receipt`, {}),
      422,
      'INVALID_STATE',
      'RECEIPT_EXISTS',
    );
    bad(await bapi.post(`/fees/receipts/${last.receipts[0].id}/void`, {}), 422, 'VALIDATION_ERROR');
    const v = ok(
      await bapi.post(`/fees/receipts/${last.receipts[0].id}/void`, {
        reason: 'Printed on the wrong stock',
      }),
    );
    expect(v.status).toBe('VOID');
    expect(v.void_reason).toBe('Printed on the wrong stock');
    bad(
      await bapi.post(`/fees/receipts/${last.receipts[0].id}/void`, { reason: 'Twice' }),
      422,
      'INVALID_STATE',
      'ALREADY_VOID',
    );
    const reissued = ok(await bapi.post(`/fees/payments/${last.id}/receipt`, {}));
    expect(Number(reissued.receipt_number.split('-')[2])).toBe(nums[2]! + 7);
    const list = ok<Json[]>(
      await bapi.get(`/fees/receipts?student_id=${b.student.id}&page_size=100`),
    );
    expect(list.filter((r) => r.status === 'ISSUED')).toHaveLength(9);
  });

  it('lists payments and receipts with filters', async () => {
    const b = await bill(api, FA);
    await paid(acct, b.student.id, '100.00');
    await paid(acct, b.student.id, '50.00', { method: 'CARD', provider_reference: uniq('CARD') });
    const all = ok<Json[]>(await api.get(`/fees/payments?student_id=${b.student.id}`));
    expect(all).toHaveLength(2);
    expect(
      ok<Json[]>(await api.get(`/fees/payments?student_id=${b.student.id}&method=CARD`)),
    ).toHaveLength(1);
    expect(
      ok<Json[]>(await api.get(`/fees/payments?student_id=${b.student.id}&status=PENDING`)),
    ).toHaveLength(0);
    expect(ok<Json[]>(await api.get(`/fees/receipts?student_id=${b.student.id}`))).toHaveLength(2);
    expect((await api.get('/fees/payments?status=NOPE')).status).toBe(422);
  });
});

// ==================================================================================
describe('concurrency: allocations can never exceed what is owed or paid', () => {
  it('one payment allocated to many demands at once never exceeds the payment amount', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '1000.00');
    const targets = [b.c1, b.c2, b.an, b.c3];
    const res = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        acct.post(`/fees/payments/${p.id}/allocate`, manual([targets[i % 4]!, '600.00'])),
      ),
    );
    const okCount = res.filter((r) => r.status === 200).length;
    expect(okCount).toBe(1); // 600 fits once; a second 600 would exceed 1000
    for (const r of res.filter((x) => x.status !== 200)) {
      expect(r.status).toBe(422);
      expect(['EXCEEDS_PAYMENT', 'EXCEEDS_OUTSTANDING']).toContain(reason(r));
    }
    const [row] = await h.deps.db.select().from(schoolPayments).where(eq(schoolPayments.id, p.id));
    expect(row!.allocatedAmount).toBe('600.00');
    const [sum] = await h.deps.db
      .select({ n: sql<string>`coalesce(sum(${paymentAllocations.allocatedAmount}), 0)` })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, p.id));
    expect(sum!.n).toBe('600.00');
  });

  it('many payments hitting one demand at once never exceed its outstanding balance', async () => {
    const b = await bill(api, FA);
    const pays = await Promise.all(
      Array.from({ length: 5 }, () => paid(acct, b.student.id, '400.00')),
    );
    const res = await Promise.all(
      pays.map((p) => acct.post(`/fees/payments/${p.id}/allocate`, manual([b.c3, '400.00']))),
    );
    const wins = res.filter((r) => r.status === 200).length;
    expect(wins).toBe(2); // 2 x 400 = 800 <= 1000 < 1200
    expect(
      res.filter((r) => r.status !== 200).every((r) => reason(r) === 'EXCEEDS_OUTSTANDING'),
    ).toBe(true);
    const d = await demand(api, b.c3.id);
    expect(d.paid_amount).toBe('800.00');
    expect(d.outstanding_amount).toBe('200.00');
    const [row] = await h.deps.db.select().from(feeDemands).where(eq(feeDemands.id, b.c3.id));
    expect(Number(row!.paidAmount)).toBeLessThanOrEqual(Number(row!.finalAmount));
  });

  it('auto-allocations running in parallel on one student stay within the balance', async () => {
    const b = await bill(api, FA);
    const pays = await Promise.all(
      Array.from({ length: 6 }, () => paid(acct, b.student.id, '1000.00')),
    );
    const res = await Promise.all(
      pays.map((p) => acct.post(`/fees/payments/${p.id}/allocate`, { mode: 'AUTO' })),
    );
    expect(res.every((r) => r.status === 200 || r.status === 422)).toBe(true);
    const all = await demandsOf(api, b.student.id);
    const paidTotal = all.reduce((n, d) => n + Number(d.paid_amount), 0);
    expect(paidTotal).toBe(3500); // everything is paid, nothing over
    expect(all.every((d) => d.outstanding_amount === '0.00' && d.status === 'PAID')).toBe(true);
    const allocated = await Promise.all(
      pays.map(async (p) => Number((await payment(api, p.id)).allocated_amount)),
    );
    expect(allocated.reduce((x, y) => x + y, 0)).toBe(3500);
  });

  it('a refund completing while an allocation runs cannot leave the payment over-committed', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '1000.00');
    const r = ok(
      await acct.post('/fees/refunds', {
        payment_id: p.id,
        amount: '600.00',
        reason: 'Parallel test',
      }),
      201,
    );
    ok(await prin.post(`/fees/refunds/${r.id}/approve`, {}));
    ok(await prin.post(`/fees/refunds/${r.id}/process`, {}));
    const [done, alloc] = await Promise.all([
      prin.post(`/fees/refunds/${r.id}/complete`, {}),
      acct.post(`/fees/payments/${p.id}/allocate`, manual([b.c3, '600.00'])),
    ]);
    expect(done.status).toBe(200);
    expect([200, 422]).toContain(alloc.status); // 600 was reserved by the refund, so 600 no longer fits
    const final = await payment(api, p.id);
    expect(Number(final.allocated_amount) + Number(final.refunded_amount)).toBeLessThanOrEqual(
      1000,
    );
  });
});

// ==================================================================================
describe('refunds', () => {
  it('runs request, approve, process, complete and never deletes the payment', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '1000.00');
    const r = ok(
      await acct.post('/fees/refunds', {
        payment_id: p.id,
        amount: '400.00',
        reason: 'Fee paid twice',
      }),
      201,
    );
    expect(r.status).toBe('REQUESTED');
    expect(r.refund_number).toMatch(/^RFD-\d{4}-\d{5}$/);
    expect((await payment(api, p.id)).reserved_for_refunds).toBe('400.00');
    expect((await payment(api, p.id)).available_to_allocate).toBe('600.00');
    expect(ok(await prin.post(`/fees/refunds/${r.id}/approve`, {})).status).toBe('APPROVED');
    expect(ok(await prin.post(`/fees/refunds/${r.id}/process`, {})).status).toBe('PROCESSING');
    const done = ok(
      await prin.post(`/fees/refunds/${r.id}/complete`, { provider_reference: 'NEFT-REFUND-1' }),
    );
    expect(done.status).toBe('COMPLETED');
    expect(done.provider_reference).toBe('NEFT-REFUND-1');
    const after = await payment(api, p.id);
    expect(after.status).toBe('PARTIALLY_REFUNDED');
    expect(after.refunded_amount).toBe('400.00');
    expect(after.amount).toBe('1000.00');
    expect(after.reserved_for_refunds).toBe('0.00');
    expect(after.available_to_allocate).toBe('600.00');
    expect(after.refunds).toHaveLength(1);
    // the remaining 600 can still be allocated, and receipts are untouched
    ok(await acct.post(`/fees/payments/${p.id}/allocate`, manual([b.c1, '600.00'])));
    expect(after.receipts[0].status).toBe('ISSUED');
  });

  it('separates duties: the requester cannot approve their own refund', async () => {
    const b = await bill(api, FA);
    const p = await paid(api, b.student.id, '500.00');
    const r = ok(
      await api.post('/fees/refunds', {
        payment_id: p.id,
        amount: '100.00',
        reason: 'Requested by admin',
      }),
      201,
    );
    bad(
      await api.post(`/fees/refunds/${r.id}/approve`, {}),
      403,
      'PERMISSION_DENIED',
      'SEPARATION_OF_DUTIES',
    );
    bad(await acct.post(`/fees/refunds/${r.id}/approve`, {}), 403, 'PERMISSION_DENIED'); // accountants cannot approve at all
    expect(ok(await prin.post(`/fees/refunds/${r.id}/approve`, {})).approved_by).toBeTruthy();
  });

  it('reverses allocations on completion: unallocated money first, then the newest allocations', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '3000.00');
    ok(
      await acct.post(
        `/fees/payments/${p.id}/allocate`,
        manual([b.c1, '1000.00'], [b.c2, '1000.00']),
      ),
    );
    expect((await payment(api, p.id)).unallocated_amount).toBe('1000.00');

    // 1200 = 1000 unallocated + 200 taken back from the newest allocation (c2)
    const r1 = await refundOf(p.id, '1200.00');
    expect(r1.from_unallocated).toBe('1000.00');
    let pay1 = await payment(api, p.id);
    expect(pay1.refunded_amount).toBe('1200.00');
    expect(pay1.allocated_amount).toBe('1800.00');
    expect(pay1.status).toBe('PARTIALLY_REFUNDED');
    const c1 = await demand(api, b.c1.id);
    const c2 = await demand(api, b.c2.id);
    expect(c1.paid_amount).toBe('1000.00');
    expect(c1.status).toBe('PAID');
    expect(c2.paid_amount).toBe('800.00');
    expect(c2.outstanding_amount).toBe('200.00');
    expect(c2.status).toBe('OVERDUE');
    const allocs = pay1.allocations as Json[];
    expect(allocs.find((a) => a.fee_demand_id === b.c2.id)!.reversed_amount).toBe('200.00');
    expect(allocs.find((a) => a.fee_demand_id === b.c1.id)!.reversed_amount).toBe('0.00');

    // the remaining 1800 in full: c2 (800) then c1 (1000) are reversed, the payment is REFUNDED
    await refundOf(p.id, '1800.00');
    pay1 = await payment(api, p.id);
    expect(pay1.status).toBe('REFUNDED');
    expect(pay1.refunded_amount).toBe('3000.00');
    expect(pay1.allocated_amount).toBe('0.00');
    for (const id of [b.c1.id, b.c2.id]) {
      const d = await demand(api, id);
      expect(d.paid_amount).toBe('0.00');
      expect(d.outstanding_amount).toBe('1000.00');
      expect(d.status).toBe('OVERDUE');
    }
    bad(
      await acct.post(`/fees/payments/${p.id}/allocate`, { mode: 'AUTO' }),
      422,
      'OPERATION_NOT_ALLOWED',
      'PAYMENT_NOT_ALLOCATABLE',
    );
    const ledger = ok(await api.get(`/fees/students/${b.student.id}/ledger`));
    expect(ledger.summary.payments_received).toBe('3000.00');
    expect(ledger.summary.refunded_amount).toBe('3000.00');
    expect(ledger.summary.paid_amount).toBe('0.00');
    expect(ledger.summary.unallocated_credit).toBe('0.00');
  });

  it('refuses refunds above what is left, counting open requests as reserved', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '500.00');
    bad(
      await acct.post('/fees/refunds', { payment_id: p.id, amount: '500.01', reason: 'Too much' }),
      422,
      'OPERATION_NOT_ALLOWED',
      'EXCEEDS_REFUNDABLE',
    );
    const first = ok(
      await acct.post('/fees/refunds', { payment_id: p.id, amount: '300.00', reason: 'First' }),
      201,
    );
    bad(
      await acct.post('/fees/refunds', { payment_id: p.id, amount: '300.00', reason: 'Second' }),
      422,
      'OPERATION_NOT_ALLOWED',
      'EXCEEDS_REFUNDABLE',
    );
    ok(
      await acct.post('/fees/refunds', { payment_id: p.id, amount: '200.00', reason: 'Fits' }),
      201,
    );
    // withdrawing the first releases its reservation
    ok(
      await acct.post(`/fees/refunds/${first.id}/cancel`, { reason: 'Parent changed their mind' }),
    );
    expect((await payment(api, p.id)).reserved_for_refunds).toBe('200.00');
    ok(
      await acct.post('/fees/refunds', {
        payment_id: p.id,
        amount: '300.00',
        reason: 'Now it fits',
      }),
      201,
    );
  });

  it('rejects, fails and cancels refunds without touching the payment', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '1000.00', { allocation: { mode: 'AUTO' } });
    const before = await payment(api, p.id);
    const rejected = ok(
      await acct.post('/fees/refunds', { payment_id: p.id, amount: '100.00', reason: 'Reject me' }),
      201,
    );
    bad(await prin.post(`/fees/refunds/${rejected.id}/reject`, {}), 422, 'VALIDATION_ERROR');
    expect(
      ok(await prin.post(`/fees/refunds/${rejected.id}/reject`, { reason: 'Not eligible' })).status,
    ).toBe('CANCELLED');
    const failing = ok(
      await acct.post('/fees/refunds', {
        payment_id: p.id,
        amount: '100.00',
        reason: 'Bank issue',
      }),
      201,
    );
    ok(await prin.post(`/fees/refunds/${failing.id}/approve`, {}));
    ok(await prin.post(`/fees/refunds/${failing.id}/process`, {}));
    const f = ok(await prin.post(`/fees/refunds/${failing.id}/fail`, { reason: 'Account closed' }));
    expect(f.status).toBe('FAILED');
    expect(f.failed_reason).toBe('Account closed');
    const after = await payment(api, p.id);
    expect(after.refunded_amount).toBe('0.00');
    expect(after.allocated_amount).toBe(before.allocated_amount);
    expect(after.reserved_for_refunds).toBe('0.00');
    expect((await demand(api, b.c1.id)).status).toBe('PAID');
  });

  it('enforces the refund state machine', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '500.00');
    const r = ok(
      await acct.post('/fees/refunds', { payment_id: p.id, amount: '100.00', reason: 'Machine' }),
      201,
    );
    bad(await prin.post(`/fees/refunds/${r.id}/process`, {}), 422, 'INVALID_STATE');
    bad(
      await prin.post(`/fees/refunds/${r.id}/complete`, {}),
      422,
      'INVALID_STATE',
      'INVALID_REFUND_STATE',
    );
    ok(await prin.post(`/fees/refunds/${r.id}/approve`, {}));
    bad(await prin.post(`/fees/refunds/${r.id}/approve`, {}), 422, 'INVALID_STATE');
    bad(
      await prin.post(`/fees/refunds/${r.id}/complete`, {}),
      422,
      'INVALID_STATE',
      'INVALID_REFUND_STATE',
    );
    ok(await prin.post(`/fees/refunds/${r.id}/process`, {}));
    bad(
      await acct.post(`/fees/refunds/${r.id}/cancel`, { reason: 'Too late' }),
      422,
      'INVALID_STATE',
    ); // processing cannot be withdrawn
    ok(await prin.post(`/fees/refunds/${r.id}/complete`, {}));
    bad(await prin.post(`/fees/refunds/${r.id}/complete`, {}), 422, 'INVALID_STATE');
    bad(
      await recep.post('/fees/refunds', { payment_id: p.id, amount: '10.00', reason: 'No right' }),
      403,
      'PERMISSION_DENIED',
    );
  });

  it('will not cancel a payment that has refunds or an open refund', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '500.00');
    const r = ok(
      await acct.post('/fees/refunds', { payment_id: p.id, amount: '100.00', reason: 'Open one' }),
      201,
    );
    bad(
      await acct.post(`/fees/payments/${p.id}/cancel`, { reason: 'Mistake' }),
      422,
      'INVALID_STATE',
      'REFUND_IN_PROGRESS',
    );
    ok(await acct.post(`/fees/refunds/${r.id}/cancel`, { reason: 'Withdrawn' }));
    await refundOf(p.id, '100.00');
    bad(
      await acct.post(`/fees/payments/${p.id}/cancel`, { reason: 'Mistake' }),
      422,
      'INVALID_STATE',
      'NOT_CANCELLABLE',
    );
    const list = ok<Json[]>(await api.get(`/fees/refunds?payment_id=${p.id}`));
    expect(list.map((x) => x.status).sort()).toEqual(['CANCELLED', 'COMPLETED']);
  });
});

// ==================================================================================
describe('views and reports', () => {
  it('builds the student ledger with every amount part and a net balance', async () => {
    const b = await bill(api, FA);
    const r = ok(
      await acct.post('/fees/adjustments', {
        type: 'CONCESSION',
        fee_demand_id: b.c3.id,
        value_type: 'AMOUNT',
        value: '100.00',
        reason: 'Ledger test',
      }),
      201,
    );
    ok(await prin.post(`/fees/adjustments/${r.id}/approve`, {}));
    ok(await prin.post(`/fees/adjustments/${r.id}/apply`, {}));
    await paid(acct, b.student.id, '1500.00', { allocation: { mode: 'AUTO' } });
    const l = ok(await api.get(`/fees/students/${b.student.id}/ledger`));
    expect(l.summary).toMatchObject({
      original_amount: '3500.00',
      concession_amount: '100.00',
      billed_amount: '3400.00',
      paid_amount: '1500.00',
      outstanding_amount: '1900.00',
      overdue_amount: '500.00',
      payments_received: '1500.00',
      unallocated_credit: '0.00',
      net_balance: '1900.00',
    });
    expect(l.demands).toHaveLength(4);
    expect(l.payments).toHaveLength(1);
    expect(l.adjustments).toHaveLength(1);
    expect(
      ok(await api.get(`/fees/students/${b.student.id}/ledger?academic_year_id=${FA.yearId}`))
        .demands,
    ).toHaveLength(4);
  });

  it('reports outstanding and overdue balances filtered by section', async () => {
    const sec = ok(
      await api.post(`/academic-years/${FA.yearId}/sections`, {
        class_id: FA.classId,
        code: uniq('R').toUpperCase().slice(0, 20),
        name: 'Report',
      }),
      201,
    );
    const b1 = await bill(api, FA, sec.id);
    const b2 = await bill(api, FA, sec.id);
    await paid(acct, b1.student.id, '2000.00', { allocation: { mode: 'AUTO' } }); // clears everything overdue for b1
    const out = await api.get(`/fees/reports/outstanding?section_id=${sec.id}`);
    expect(out.status).toBe(200);
    expect(out.body.summary.student_count).toBe(2);
    expect(out.body.summary.outstanding_amount).toBe('5000.00'); // 1500 + 3500
    expect(out.body.summary.overdue_amount).toBe('2000.00');
    const rows = out.body.data as Json[];
    expect(rows.find((r) => r.student.id === b1.student.id)!.outstanding_amount).toBe('1500.00');
    expect(rows.find((r) => r.student.id === b2.student.id)!.overdue_amount).toBe('2000.00');
    const od = await api.get(`/fees/reports/overdue?section_id=${sec.id}&page_size=100`);
    expect(od.status).toBe(200);
    expect(od.body.data.every((r: Json) => r.student.id === b2.student.id)).toBe(true);
    expect(od.body.data).toHaveLength(2);
    expect(od.body.data.map((r: Json) => r.days_overdue).sort()).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(
      (await api.get(`/fees/reports/overdue?section_id=${sec.id}&min_days_overdue=45`)).body.data,
    ).toHaveLength(1);
  });

  it('reports collections by method and by day over a date range', async () => {
    const b = await bill(bapi, FB);
    const today = new Date().toISOString().slice(0, 10);
    const before = ok(await bapi.get(`/fees/reports/collection?from=${today}&to=${today}`));
    await paid(bapi, b.student.id, '700.00');
    await paid(bapi, b.student.id, '300.00', { method: 'CARD', provider_reference: uniq('CARD') });
    const cheque = ok(
      await pay(bapi, b.student.id, '900.00', { method: 'CHEQUE', status: 'PENDING' }),
      201,
    );
    const rep = ok(await bapi.get(`/fees/reports/collection?from=${today}&to=${today}`));
    const delta = (x: string, y: string) => Number(x) - Number(y);
    expect(delta(rep.totals.gross_amount, before.totals.gross_amount)).toBe(1000);
    expect(rep.totals.payment_count - before.totals.payment_count).toBe(2);
    const by = (r: Json, m: string) =>
      r.by_method.find((x: Json) => x.method === m)?.gross_amount ?? '0';
    expect(delta(by(rep, 'CASH'), by(before, 'CASH'))).toBe(700);
    expect(delta(by(rep, 'CARD'), by(before, 'CARD'))).toBe(300);
    expect(rep.daily.find((d: Json) => d.date === today)).toBeTruthy();
    expect(rep.pending.payment_count).toBeGreaterThanOrEqual(1); // the cheque is not money yet
    expect(cheque.status).toBe('PENDING');
    const onlyCard = ok(
      await bapi.get(`/fees/reports/collection?from=${today}&to=${today}&method=CARD`),
    );
    expect(onlyCard.by_method.every((m: Json) => m.method === 'CARD')).toBe(true);
    expect((await bapi.get(`/fees/reports/collection?from=${today}&to=${daysAgo(3)}`)).status).toBe(
      422,
    );
    expect((await bapi.get('/fees/reports/collection')).status).toBe(422);
  });

  it('shows refunds as net collections', async () => {
    const b = await bill(bapi, FB);
    const today = new Date().toISOString().slice(0, 10);
    const before = ok(await bapi.get(`/fees/reports/collection?from=${today}&to=${today}`));
    const p = await paid(bapi, b.student.id, '1000.00');
    const r = ok(
      await bapi.post('/fees/refunds', { payment_id: p.id, amount: '250.00', reason: 'Net test' }),
      201,
    );
    const bp = await h.addMember(bapi, [{ role_id: await h.roleId(bapi, 'PRINCIPAL') }]);
    ok(await bp.api.post(`/fees/refunds/${r.id}/approve`, {}));
    ok(await bp.api.post(`/fees/refunds/${r.id}/process`, {}));
    ok(await bp.api.post(`/fees/refunds/${r.id}/complete`, {}));
    const rep = ok(await bapi.get(`/fees/reports/collection?from=${today}&to=${today}`));
    expect(Number(rep.totals.net_amount) - Number(before.totals.net_amount)).toBe(750);
    const refunds = await bapi.get(`/fees/reports/refunds?status=COMPLETED`);
    expect(refunds.status).toBe(200);
    expect(refunds.body.data.map((x: Json) => x.id)).toContain(r.id);
  });

  it('reports concessions with totals and filters', async () => {
    const b = await bill(api, FA);
    const r = ok(
      await acct.post('/fees/adjustments', {
        type: 'WAIVER',
        fee_demand_id: b.c3.id,
        value_type: 'AMOUNT',
        value: '150.00',
        reason: 'Report test',
      }),
      201,
    );
    const rep = await api.get(
      `/fees/reports/concessions?type=WAIVER&status=REQUESTED&page_size=100`,
    );
    expect(rep.status).toBe(200);
    expect(rep.body.data.map((x: Json) => x.id)).toContain(r.id);
    expect(rep.body.data.every((x: Json) => x.type === 'WAIVER' && x.status === 'REQUESTED')).toBe(
      true,
    );
    expect(rep.body.summary ?? rep.body.meta).toBeTruthy();
  });

  it('returns a dashboard with billed, collected, outstanding and pending approvals', async () => {
    const d = ok(await api.get('/fees/dashboard'));
    expect(d.demands.billed_amount).toBeTruthy();
    expect(Number(d.demands.billed_amount)).toBeGreaterThanOrEqual(Number(d.demands.paid_amount));
    expect(Number(d.demands.outstanding_amount)).toBeGreaterThan(0);
    expect(d.demands.overdue_count).toBeGreaterThan(0);
    expect(d.approvals.adjustments_requested).toBeGreaterThan(0);
    expect(d.collections.today.payment_count).toBeGreaterThan(0);
    expect(Array.isArray(d.by_category)).toBe(true);
    expect((await teach.get('/fees/dashboard')).status).toBe(403);
  });

  it('exports CSV only with fees.export, and audits it', async () => {
    const b = await bill(api, FA);
    await paid(acct, b.student.id, '100.00');
    for (const report of [
      'demands',
      'payments',
      'outstanding',
      'overdue',
      'concessions',
      'refunds',
    ]) {
      const res = await prin.get(`/fees/reports/${report}/export`);
      expect(res.status, report).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('.csv');
    }
    const today = new Date().toISOString().slice(0, 10);
    const coll = await prin.get(`/fees/reports/collection/export?from=${today}&to=${today}`);
    expect(coll.status).toBe(200);
    const demandsCsv = await prin.get(`/fees/reports/demands/export?student_id=${b.student.id}`);
    expect(demandsCsv.text.split('\n').filter(Boolean)).toHaveLength(5); // header + 4 demands
    expect(demandsCsv.text).toContain('FEE-');
    bad(await recep.get('/fees/reports/demands/export'), 403, 'PERMISSION_DENIED');
    bad(await teach.get('/fees/reports/demands/export'), 403, 'PERMISSION_DENIED');
    expect((await prin.get('/fees/reports/nonsense/export')).status).toBe(422);
    const audit = await h.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.tenantId, A.tenantId), eq(auditLogs.action, 'FEES_EXPORTED')));
    expect(audit.length).toBeGreaterThanOrEqual(7);
    const ev = await h.deps.db
      .select()
      .from(outboxEvents)
      .where(
        and(eq(outboxEvents.tenantId, A.tenantId), eq(outboxEvents.eventType, 'fees.exported')),
      );
    expect(ev.length).toBeGreaterThanOrEqual(7);
  });

  it('neutralises spreadsheet formulas in exported text', async () => {
    const s = ok(
      await api.post('/students', {
        first_name: '=HYPERLINK("x")',
        last_name: uniq('Csv'),
        gender: 'MALE',
        enrollment: { academic_year_id: FA.yearId, class_id: FA.classId, section_id: FA.secA },
      }),
      201,
    );
    const a = ok(
      await api.post('/fees/assignments', { student_id: s.id, fee_structure_id: FA.structureId }),
      201,
    );
    ok(await api.post(`/fees/assignments/${a.id}/generate-demands`, { issue: true }));
    const res = await prin.get(`/fees/reports/demands/export?student_id=${s.id}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/(^|,|")=HYPERLINK/);
  });
});

// ==================================================================================
describe('permissions and student scope', () => {
  it('gives teachers no access to fees at all', async () => {
    for (const path of [
      '/fees/demands',
      '/fees/payments',
      '/fees/structures',
      '/fees/settings',
      '/fees/refunds',
      '/fees/receipts',
      '/fees/adjustments',
    ]) {
      bad(await teach.get(path), 403, 'PERMISSION_DENIED');
    }
    bad(
      await teach.post('/fees/payments', {
        student_id: FA.classId,
        amount: '1.00',
        method: 'CASH',
      }),
      403,
      'PERMISSION_DENIED',
    );
  });

  it('lets the receptionist read fees and record payments, and nothing else', async () => {
    const b = await bill(api, FA);
    expect((await recep.get(`/fees/demands?student_id=${b.student.id}`)).status).toBe(200);
    expect((await pay(recep, b.student.id, '50.00')).status).toBe(201);
    bad(
      await recep.post('/fees/assignments', {
        student_id: b.student.id,
        fee_structure_id: FA.structureId,
      }),
      403,
      'PERMISSION_DENIED',
    );
    bad(
      await recep.post(`/fees/demands/${b.c1.id}/cancel`, { reason: 'No right' }),
      403,
      'PERMISSION_DENIED',
    );
    bad(
      await recep.patch('/fees/settings', { version: 1, late_fee_enabled: true }),
      403,
      'PERMISSION_DENIED',
    );
    bad(
      await recep.post('/fees/categories', { code: 'NOPE', name: 'No' }),
      403,
      'PERMISSION_DENIED',
    );
  });

  it('keeps accountants out of approvals and structure publishing', async () => {
    const b = await bill(api, FA);
    bad(
      await acct.post(`/fees/demands/${b.c1.id}/write-off`, { reason: 'Not allowed' }),
      403,
      'PERMISSION_DENIED',
    );
    bad(
      await acct.post(`/fees/demands/${b.c1.id}/discount`, {
        value_type: 'AMOUNT',
        value: '1.00',
        reason: 'Nope',
      }),
      403,
      'PERMISSION_DENIED',
    );
    expect((await acct.get('/fees/settings')).status).toBe(200);
    const s = ok(await acct.get('/fees/settings'));
    expect(
      (await acct.patch('/fees/settings', { version: s.version, late_fee_grace_days: 2 })).status,
    ).toBe(200);
    ok(await acct.patch('/fees/settings', { version: s.version + 1, late_fee_grace_days: 0 }));
  });

  it('narrows every read to the assigned sections; other students act as missing', async () => {
    const mine = await bill(api, FA, FA.secA);
    const theirs = await bill(api, FA, FA.secB);
    const pm = await paid(acct, mine.student.id, '100.00');
    const pt = await paid(acct, theirs.student.id, '100.00');
    const rf = ok(
      await acct.post('/fees/refunds', { payment_id: pt.id, amount: '10.00', reason: 'Scope' }),
      201,
    );
    const adj = ok(
      await acct.post('/fees/adjustments', {
        type: 'CONCESSION',
        fee_demand_id: theirs.c3.id,
        value_type: 'AMOUNT',
        value: '10.00',
        reason: 'Scope',
      }),
      201,
    );
    const scoped = (
      await h.addMember(api, [
        {
          role_id: await h.scopableRole(api, 'PRINCIPAL'),
          scope_type: 'ASSIGNED_SECTION',
          scope_ref: { section_ids: [FA.secA] },
        },
      ])
    ).api;
    // own section
    expect((await scoped.get(`/fees/students/${mine.student.id}/ledger`)).status).toBe(200);
    expect((await scoped.get(`/fees/demands/${mine.c1.id}`)).status).toBe(200);
    expect((await scoped.get(`/fees/payments/${pm.id}`)).status).toBe(200);
    // another section behaves as missing, never as forbidden
    expect((await scoped.get(`/fees/students/${theirs.student.id}/ledger`)).status).toBe(404);
    expect((await scoped.get(`/fees/demands/${theirs.c1.id}`)).status).toBe(404);
    expect((await scoped.get(`/fees/payments/${pt.id}`)).status).toBe(404);
    expect((await scoped.get(`/fees/receipts/${pt.receipts[0].id}`)).status).toBe(404);
    expect((await scoped.get(`/fees/refunds/${rf.id}`)).status).toBe(404);
    expect((await scoped.get(`/fees/adjustments/${adj.id}`)).status).toBe(404);
    expect((await scoped.get(`/fees/assignments/${theirs.assignment.id}`)).status).toBe(404);
    bad(await scoped.post(`/fees/refunds/${rf.id}/approve`, {}), 404);
    bad(await scoped.post(`/fees/adjustments/${adj.id}/approve`, {}), 404);
    // lists and reports only contain the assigned section
    const dl = ok<Json[]>(await scoped.get(`/fees/demands?page_size=100&section_id=${FA.secB}`));
    expect(dl).toHaveLength(0);
    const all = ok<Json[]>(await scoped.get('/fees/demands?page_size=100'));
    expect(all.some((d) => d.student.id === theirs.student.id)).toBe(false);
    expect(all.some((d) => d.student.id === mine.student.id)).toBe(true);
    const pl = ok<Json[]>(await scoped.get('/fees/payments?page_size=100'));
    expect(pl.map((x) => x.id)).toContain(pm.id);
    expect(pl.map((x) => x.id)).not.toContain(pt.id);
    const out = await scoped.get('/fees/reports/outstanding?page_size=100');
    expect(out.body.data.some((r: Json) => r.student.id === theirs.student.id)).toBe(false);
    // whole-school operations need a school-wide grant
    bad(
      await scoped.post(`/fees/structures/${FA.structureId}/duplicate`, {}),
      403,
      'PERMISSION_DENIED',
    );
    const dash = await scoped.get('/fees/dashboard');
    expect(dash.status).toBe(200);
  });

  it('applies student scope to writes: a section-scoped recorder cannot pay for other sections', async () => {
    const mine = await bill(api, FA, FA.secA);
    const theirs = await bill(api, FA, FA.secB);
    const clerk = (
      await h.addMember(api, [
        {
          role_id: await h.scopableRole(api, 'RECEPTIONIST'),
          scope_type: 'ASSIGNED_SECTION',
          scope_ref: { section_ids: [FA.secA] },
        },
      ])
    ).api;
    expect((await pay(clerk, mine.student.id, '10.00')).status).toBe(201);
    expect((await pay(clerk, theirs.student.id, '10.00')).status).toBe(404);
  });
});

// ==================================================================================
describe('tenant isolation, audit and events', () => {
  it('hides every fee object of school A from school B', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '100.00');
    const r = ok(
      await acct.post('/fees/refunds', { payment_id: p.id, amount: '10.00', reason: 'Isolation' }),
      201,
    );
    const adj = ok(
      await acct.post('/fees/adjustments', {
        type: 'CONCESSION',
        fee_demand_id: b.c3.id,
        value_type: 'AMOUNT',
        value: '10.00',
        reason: 'Isolation',
      }),
      201,
    );
    const paths = [
      `/fees/demands/${b.c1.id}`,
      `/fees/payments/${p.id}`,
      `/fees/receipts/${p.receipts[0].id}`,
      `/fees/refunds/${r.id}`,
      `/fees/adjustments/${adj.id}`,
      `/fees/assignments/${b.assignment.id}`,
      `/fees/structures/${FA.structureId}`,
      `/fees/categories/${FA.catTuition}`,
      `/fees/components/${FA.tuitionComponentId}`,
      `/fees/students/${b.student.id}/ledger`,
    ];
    for (const path of paths) expect((await bapi.get(path)).status, path).toBe(404);
    const bDemands = ok<Json[]>(await bapi.get('/fees/demands?page_size=100'));
    expect(bDemands.some((d) => d.student.id === b.student.id)).toBe(false);
    // and cannot act on them
    bad(await bapi.post(`/fees/payments/${p.id}/allocate`, { mode: 'AUTO' }), 404);
    bad(await bapi.post(`/fees/demands/${b.c1.id}/write-off`, { reason: 'Cross tenant' }), 404);
    bad(
      await bapi.post('/fees/payments', {
        student_id: b.student.id,
        amount: '10.00',
        method: 'CASH',
      }),
      404,
    );
    bad(
      await bapi.post('/fees/assignments', {
        student_id: b.student.id,
        fee_structure_id: FA.structureId,
      }),
      404,
    );
  });

  it('refuses to allocate money across tenants even with valid ids', async () => {
    const a = await bill(api, FA);
    const bb = await bill(bapi, FB);
    const p = await paid(bapi, bb.student.id, '100.00');
    bad(await bapi.post(`/fees/payments/${p.id}/allocate`, manual([a.c1, '50.00'])), 404);
    expect((await payment(bapi, p.id)).allocated_amount).toBe('0.00');
  });

  it('writes audit rows and outbox events with the change', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '200.00', { allocation: { mode: 'AUTO' } });
    const actions = (
      await h.deps.db
        .select({ a: auditLogs.action, e: auditLogs.entityId })
        .from(auditLogs)
        .where(and(eq(auditLogs.tenantId, A.tenantId), like(auditLogs.action, 'FEE_%')))
    ).map((r) => `${r.a}:${r.e}`);
    expect(actions).toEqual(
      expect.arrayContaining([
        `FEE_PAYMENT_RECEIVED:${p.id}`,
        `FEE_DEMANDS_GENERATED_AND_ISSUED:${b.assignment.id}`,
      ]),
    );
    const events = await h.deps.db
      .select({ t: outboxEvents.eventType, id: outboxEvents.aggregateId })
      .from(outboxEvents)
      .where(eq(outboxEvents.tenantId, A.tenantId));
    const has = (t: string, id: string) => events.some((e) => e.t === t && e.id === id);
    expect(has('payment.received', p.id)).toBe(true);
    expect(has('fee_demand.issued', b.c1.id)).toBe(true);
    expect(events.some((e) => e.t === 'payment.allocated')).toBe(true);
    expect(events.some((e) => e.t === 'receipt.issued')).toBe(true);
    expect(events.some((e) => e.t === 'fee_demand.generated')).toBe(true);
    expect(events.some((e) => e.t === 'student_fee.assigned')).toBe(true);
  });

  it('rejects a stale version on editing, publishing and settings', async () => {
    const c = ok(
      await api.post('/fees/categories', {
        code: uniq('V').toUpperCase().slice(0, 30),
        name: 'Versioned',
      }),
      201,
    );
    ok(await api.patch(`/fees/categories/${c.id}`, { version: 1, name: 'v2' }));
    bad(
      await api.patch(`/fees/categories/${c.id}`, { version: 1, name: 'v3' }),
      409,
      'CONFLICT',
      'STALE_VERSION',
    );
    const st = ok(
      await api.post('/fees/structures', {
        code: uniq('SV').toUpperCase().slice(0, 30),
        name: 'Stale',
        academic_year_id: FA.yearId,
      }),
      201,
    );
    ok(await api.patch(`/fees/structures/${st.id}`, { version: st.version, name: 'Stale 2' }));
    bad(
      await api.patch(`/fees/structures/${st.id}`, { version: st.version, name: 'Stale 3' }),
      409,
      'CONFLICT',
      'STALE_VERSION',
    );
    ok(
      await api.post(`/fees/structures/${st.id}/components`, {
        fee_category_id: FA.catTuition,
        name: 'Only',
        amount: '5.00',
        frequency: 'ONE_TIME',
      }),
      201,
    );
    bad(
      await prin.post(`/fees/structures/${st.id}/publish`, { version: 1 }),
      409,
      'CONFLICT',
      'STALE_VERSION',
    );
  });

  it('keeps school fees apart from platform billing: platform users have no fee routes of their own', async () => {
    const root = await h.superAdmin();
    for (const path of ['/fees/demands', '/fees/payments', '/fees/settings']) {
      const res = await root.get(path);
      expect(res.status, path).toBeGreaterThanOrEqual(400); // a platform session has no school context
      expect(res.status).toBeLessThan(500);
    }
    // school payments are their own table; platform billing never sees them
    const [row] = await h.deps.db
      .select({ n: sql<number>`count(*)` })
      .from(schoolPayments)
      .where(eq(schoolPayments.tenantId, A.tenantId));
    expect(Number(row!.n)).toBeGreaterThan(0);
  });
});

// ==================================================================================
describe('bank reconciliation', () => {
  const upload = (a: Api, text: string, name = 'stmt.csv') =>
    h.http
      .post(`/api/v1/fees/reconciliation/statements?filename=${name}`)
      .set('Authorization', `Bearer ${a.token}`)
      .set('Content-Type', 'text/csv')
      .send(text);

  it('matches an identical reference and amount, queues the rest and never imports a line twice', async () => {
    const b = await bill(api, FA);
    const ref = uniq('EFT');
    const p = await paid(acct, b.student.id, '187.43', {
      method: 'BANK_TRANSFER',
      provider_reference: ref,
    });
    const text = [
      'Date,Description,Reference,Amount',
      `${daysAgo(1)},EFT school fees,${ref},187.43`,
      `${daysAgo(1)},Mystery deposit,,311.17`,
      `${daysAgo(1)},Debit order,,-99.00`,
    ].join('\n');
    const first = ok(await upload(acct, text), 201);
    expect(first.imported).toBe(2);
    expect(first.debits_skipped).toBe(1);
    expect(first.auto_matched).toBeGreaterThanOrEqual(1);

    const lines = ok<Json[]>(await acct.get('/fees/reconciliation/lines?page_size=100'));
    const matched = lines.find((l) => l.payment?.id === p.id)!;
    expect(matched.status).toBe('MATCHED');
    expect(matched.match_type).toBe('REFERENCE_AMOUNT');
    const mystery = lines.find((l) => l.amount === '311.17')!;
    expect(mystery.status).toBe('UNMATCHED');

    const again = ok(await upload(acct, text), 201);
    expect(again.imported).toBe(0);
    expect(again.duplicates_skipped).toBe(2);

    // the money is in the bank but nobody recorded it: record it from the line
    const rec = ok(
      await acct.post(`/fees/reconciliation/lines/${mystery.id}/record`, {
        student_id: b.student.id,
      }),
    );
    expect(rec.status).toBe('MATCHED');
    const made = await payment(acct, rec.payment_id);
    expect(made.amount).toBe('311.17');
    expect(made.method).toBe('BANK_TRANSFER');
    bad(
      await acct.post(`/fees/reconciliation/lines/${mystery.id}/ignore`, { reason: 'Not ours' }),
      422,
      undefined,
      'LINE_RESOLVED',
    );
  });

  it('confirms only a payment of exactly the same amount, and can ignore and reopen a line', async () => {
    const b = await bill(api, FA);
    const p = await paid(acct, b.student.id, '500.00', { method: 'BANK_TRANSFER' });
    const text = ['Date,Description,Reference,Amount', `${daysAgo(2)},Odd deposit,,412.31`].join(
      '\n',
    );
    ok(await upload(acct, text, 'odd.csv'), 201);
    const line = ok<Json[]>(await acct.get('/fees/reconciliation/lines?page_size=100')).find(
      (l) => l.amount === '412.31',
    )!;
    const res = await acct.post(`/fees/reconciliation/lines/${line.id}/confirm`, {
      payment_id: p.id,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(reason(res)).toBe('AMOUNT_MISMATCH');

    ok(await acct.post(`/fees/reconciliation/lines/${line.id}/ignore`, { reason: 'Rent refund' }));
    const ignored = ok<Json[]>(await acct.get('/fees/reconciliation/lines?status=IGNORED'));
    expect(ignored.some((l) => l.id === line.id)).toBe(true);
    ok(await acct.post(`/fees/reconciliation/lines/${line.id}/reopen`, {}));
    const summary = ok(await acct.get('/fees/reconciliation/summary'));
    expect(summary.needs_review).toBeGreaterThanOrEqual(1);
    expect(summary.unconfirmed_payments).toBeGreaterThanOrEqual(1);
  });

  it('is closed to people without fees.reconcile', async () => {
    expect([403, 404]).toContain((await teach.get('/fees/reconciliation/summary')).status);
    expect([403, 404]).toContain((await recep.get('/fees/reconciliation/summary')).status);
    const denied = await upload(recep, `Date,Amount\n${daysAgo(1)},10.00`);
    expect([403, 404]).toContain(denied.status);
  });
});

// ==================================================================================
describe('arrears, reminders and payment plans', () => {
  const arrearsOf = async (studentNumber: string) =>
    ok<Json[]>(await acct.get(`/fees/arrears?search=${studentNumber}`))[0] as Json;
  const planOf = (studentId: string, n: number, each: string, extra: Json = {}) => ({
    student_id: studentId,
    instalments: Array.from({ length: n }, (_, i) => ({
      due_date: inDays(5 + i * 7),
      amount: each,
    })),
    ...extra,
  });

  it('lists learners with the next step on the ladder and walks it in order', async () => {
    const b = await bill(api, FA);
    const row = await arrearsOf(b.student.student_number);
    expect(row.outstanding_amount).toBe('2000.00');
    expect(row.days_overdue).toBe(60);
    expect(row.next_step).toBe('DUE_FIRST');

    ok(
      await acct.post(`/fees/arrears/${b.student.id}/reminders`, { stage: 'FIRST_REMINDER' }),
      201,
    );
    expect((await arrearsOf(b.student.student_number)).next_step).toBe('DUE_SECOND');

    // the ladder cannot be skipped
    const skip = await prin.post(`/fees/arrears/${b.student.id}/reminders`, {
      stage: 'LETTER_OF_DEMAND',
    });
    expect(skip.status, JSON.stringify(skip.body)).toBe(422);
    expect(reason(skip)).toBe('OUT_OF_ORDER');

    ok(
      await acct.post(`/fees/arrears/${b.student.id}/reminders`, { stage: 'SECOND_REMINDER' }),
      201,
    );
    // a letter of demand needs escalation rights, which an accountant does not have
    expect(
      (await acct.post(`/fees/arrears/${b.student.id}/reminders`, { stage: 'LETTER_OF_DEMAND' }))
        .status,
    ).toBe(403);
    ok(
      await prin.post(`/fees/arrears/${b.student.id}/reminders`, {
        stage: 'LETTER_OF_DEMAND',
        note: 'Posted',
      }),
      201,
    );
    expect((await arrearsOf(b.student.student_number)).next_step).toBe('HANDOVER');
    const history = ok<Json[]>(await acct.get(`/fees/arrears/${b.student.id}/reminders`));
    expect(history.map((h) => h.stage)).toEqual([
      'LETTER_OF_DEMAND',
      'SECOND_REMINDER',
      'FIRST_REMINDER',
    ]);
  });

  it('records the automatic reminders that fell due, and previews them first', async () => {
    const b = await bill(api, FA);
    const preview = ok(await acct.post('/fees/arrears/reminders/run', { dry_run: true }));
    expect(preview.student_ids).toContain(b.student.id);
    expect(ok<Json[]>(await acct.get(`/fees/arrears/${b.student.id}/reminders`))).toHaveLength(0);
    const run = ok(await acct.post('/fees/arrears/reminders/run', { dry_run: false }));
    expect(run.student_ids).toContain(b.student.id);
    const history = ok<Json[]>(await acct.get(`/fees/arrears/${b.student.id}/reminders`));
    expect(history).toHaveLength(1);
    expect(history[0]!.stage).toBe('FIRST_REMINDER');
    expect(history[0]!.automatic).toBe(true);
  });

  it('creates a plan within the overdue amount, one active plan per learner', async () => {
    const b = await bill(api, FA);
    const plan = ok(await acct.post('/fees/payment-plans', planOf(b.student.id, 2, '600.00')), 201);
    expect(plan.status).toBe('ACTIVE');
    expect(plan.total_amount).toBe('1200.00');
    expect(plan.instalments.map((i: Json) => i.status)).toEqual(['UPCOMING', 'UPCOMING']);
    expect((await arrearsOf(b.student.student_number)).next_step).toBe('PLAN');

    const second = await acct.post('/fees/payment-plans', planOf(b.student.id, 2, '100.00'));
    expect(second.status).toBe(422);
    expect(reason(second)).toBe('PLAN_ALREADY_ACTIVE');

    const b2 = await bill(api, FA);
    const tooMuch = await acct.post('/fees/payment-plans', planOf(b2.student.id, 2, '1500.00'));
    expect(tooMuch.status).toBe(422);
    expect(reason(tooMuch)).toBe('PLAN_EXCEEDS_ARREARS');

    ok(await acct.post(`/fees/payment-plans/${plan.id}/cancel`, { reason: 'Family request' }));
    expect(ok(await acct.get(`/fees/payment-plans/${plan.id}`)).status).toBe('CANCELLED');
  });

  it('limits a plan to 6 instalments unless the finance committee (escalation rights) agrees', async () => {
    const b = await bill(api, FA);
    const long = planOf(b.student.id, 7, '100.00');
    const refused = await acct.post('/fees/payment-plans', long);
    expect(refused.status).toBe(422);
    expect(reason(refused)).toBe('EXCEEDS_POLICY');
    expect((await acct.post('/fees/payment-plans', { ...long, exceeds_policy: true })).status).toBe(
      403,
    );
    const plan = ok(await prin.post('/fees/payment-plans', { ...long, exceeds_policy: true }), 201);
    expect(plan.instalments).toHaveLength(7);
  });

  it('completes a plan once the instalments are paid', async () => {
    const b = await bill(api, FA);
    const plan = ok(await acct.post('/fees/payment-plans', planOf(b.student.id, 2, '500.00')), 201);
    await paid(acct, b.student.id, '1000.00', { allocation: { mode: 'AUTO' } });
    const list = ok<Json[]>(await acct.get('/fees/payment-plans?status=COMPLETED&page_size=100'));
    const done = list.find((p) => p.id === plan.id)!;
    expect(done.status).toBe('COMPLETED');
    expect(done.instalments.map((i: Json) => i.status)).toEqual(['PAID', 'PAID']);
  });

  it('charges no late fee while a plan is active, and resumes when it is cancelled', async () => {
    const s = ok(await bapi.get('/fees/settings'));
    const on = ok(
      await bapi.patch('/fees/settings', {
        version: s.version,
        late_fee_enabled: true,
        late_fee_type: 'FIXED',
        late_fee_value: '50.00',
        late_fee_grace_days: 0,
      }),
    );
    const b = await bill(bapi, FB);
    const plan = ok(await bapi.post('/fees/payment-plans', planOf(b.student.id, 2, '500.00')), 201);
    const blocked = await bapi.post(`/fees/demands/${b.c1.id}/late-fee`, {});
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(422);
    expect(reason(blocked)).toBe('ON_PAYMENT_PLAN');
    const bulk = ok(await bapi.post('/fees/demands/apply-late-fees', { demand_ids: [b.c1.id] }));
    expect(bulk.on_payment_plan).toBe(1);
    expect((await demand(bapi, b.c1.id)).late_fee_amount).toBe('0.00');

    ok(await bapi.post(`/fees/payment-plans/${plan.id}/cancel`, { reason: 'Plan abandoned' }));
    ok(await bapi.post(`/fees/demands/${b.c1.id}/late-fee`, {}));
    expect((await demand(bapi, b.c1.id)).late_fee_amount).toBe('50.00');
    ok(await bapi.patch('/fees/settings', { version: on.version, late_fee_enabled: false }));
  });

  it('is closed to people without fees.arrears.manage', async () => {
    expect([403, 404]).toContain((await recep.get('/fees/arrears')).status);
    expect([403, 404]).toContain((await teach.get('/fees/payment-plans')).status);
  });
});
