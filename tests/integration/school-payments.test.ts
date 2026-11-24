import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SUPER, code, createHarness, uniq, type Api, type Harness } from '../helpers.js';
import { istDay, sessionOf } from '../../src/modules/school-payments/school-payments.service.js';

/**
 * School payments (simple mode): the yearly platform fee, set per session with agreed
 * instalments, paid offline, with invoices, receipts and a payment record.
 */
let h: Harness;
let root: Api;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
function ok<T = Json>(res: { status: number; body: Json }, status = 200) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
}

const PASSWORD = 'School12345';
const DAY = 86_400_000;
const today = () => istDay(new Date());
const shift = (n: number) => new Date(Date.parse(today()) + n * DAY).toISOString().slice(0, 10);
const SESSION = sessionOf(istDay(new Date()));

async function newSchool() {
  const schoolCode = uniq('pay');
  const tenantId = ok(
    await root.post('/platform/tenants', { code: schoolCode, name: `School ${schoolCode}` }),
    201,
  ).id as string;
  const adminEmail = `${schoolCode}-admin@school.test`;
  ok(
    await root.post(`/platform/tenants/${tenantId}/provision`, {
      admin: { email: adminEmail, first_name: 'Admin', password: PASSWORD },
    }),
  );
  const res = await h.http
    .post('/api/v1/auth/login')
    .send({ email: adminEmail, password: PASSWORD, app: 'admin' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { tenantId, api: h.as(res.body.data.access_token) };
}

beforeAll(async () => {
  h = await createHarness({ mode: 'simple' });
  const res = await h.http
    .post('/api/v1/auth/login')
    .send({ email: SUPER.email, password: SUPER.password, app: 'admin' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  root = h.as(res.body.data.access_token);
}, 60_000);
afterAll(() => h.close());

describe('default fee', () => {
  it('starts at ₹10,000 and can be changed', async () => {
    const s = ok(await root.get('/platform/school-payments/settings'));
    expect(s).toMatchObject({ currency: 'INR', current_session: SESSION });
    expect(s.default_fee_minor).toBeGreaterThan(0);
    ok(await root.put('/platform/school-payments/settings', { default_fee_minor: 12_000_00 }));
    expect(ok(await root.get('/platform/school-payments/settings')).default_fee_minor).toBe(12_000_00);
    ok(await root.put('/platform/school-payments/settings', { default_fee_minor: 10_000_00 }));
  });
});

describe('a school’s yearly fee', () => {
  let S: Awaited<ReturnType<typeof newSchool>>;
  let feeId: string;

  beforeAll(async () => {
    S = await newSchool();
  });

  it('checks the instalments add up', async () => {
    const res = await root.post(`/platform/tenants/${S.tenantId}/school-payments`, {
      session: SESSION,
      amount_minor: 10_000_00,
      instalments: [{ amount_minor: 4_000_00, due_on: shift(-10) }],
    });
    expect(res.status).toBe(422);
  });

  it('sets the fee with a discount and two instalments; one already overdue', async () => {
    const created = ok(
      await root.post(`/platform/tenants/${S.tenantId}/school-payments`, {
        session: SESSION,
        amount_minor: 11_000_00,
        discount_minor: 1_000_00,
        discount_reason: 'Early sign-up',
        instalments: [
          { amount_minor: 5_000_00, due_on: shift(3) },
          { amount_minor: 5_000_00, due_on: shift(-10) },
        ],
      }),
      201,
    );
    feeId = created.invoice_id;
    expect(created.invoice_number).toMatch(/^INV-/);

    const v = ok(await root.get(`/platform/tenants/${S.tenantId}/school-payments`));
    expect(v.current_set_up).toBe(true);
    const fee = v.fees[0];
    expect(fee).toMatchObject({
      session: SESSION,
      status: 'OVERDUE',
      total_minor: 10_000_00,
      pending_minor: 10_000_00,
      overdue_minor: 5_000_00,
      overdue_days: 10,
      discount_reason: 'Early sign-up',
      next_due: { due_on: shift(-10), amount_minor: 5_000_00 },
    });
    // Sorted by due date.
    expect(fee.instalments.map((i: Json) => i.status)).toEqual(['OVERDUE', 'DUE_SOON']);
  });

  it('refuses a second fee for the same session', async () => {
    const res = await root.post(`/platform/tenants/${S.tenantId}/school-payments`, {
      session: SESSION,
      amount_minor: 10_000_00,
      instalments: [{ amount_minor: 10_000_00, due_on: shift(5) }],
    });
    expect(res.status).toBe(422);
    expect(code(res)).toBe('INVALID_STATE');
  });

  it('records payments, marks late / on time, and refuses overpaying', async () => {
    ok(
      await root.post(`/platform/school-payments/fees/${feeId}/payments`, {
        amount_minor: 5_000_00,
        method: 'UPI',
        reference: 'UPI-123',
        received_on: shift(-1),
      }),
      201,
    );
    let fee = ok(await root.get(`/platform/tenants/${S.tenantId}/school-payments`)).fees[0];
    expect(fee.status).toBe('DUE_SOON');
    expect(fee.instalments[0]).toMatchObject({ status: 'PAID_LATE', days_late: 9 });

    const over = await root.post(`/platform/school-payments/fees/${feeId}/payments`, {
      amount_minor: 6_000_00,
      method: 'CASH',
    });
    expect(over.status).toBe(422);

    ok(
      await root.post(`/platform/school-payments/fees/${feeId}/payments`, {
        amount_minor: 5_000_00,
        method: 'BANK_TRANSFER',
      }),
      201,
    );
    const v = ok(await root.get(`/platform/tenants/${S.tenantId}/school-payments`));
    fee = v.fees[0];
    expect(fee).toMatchObject({ status: 'PAID', pending_minor: 0, paid_minor: 10_000_00 });
    expect(fee.instalments[1]).toMatchObject({ status: 'PAID_ON_TIME' });
    expect(v.record).toMatchObject({ on_time: 1, late: 1 });
    expect(fee.payments).toHaveLength(2);
  });

  it('will not lower the fee below what is paid, and cannot cancel a fee with payments', async () => {
    const res = await root.put(`/platform/school-payments/fees/${feeId}`, {
      amount_minor: 8_000_00,
      instalments: [{ amount_minor: 8_000_00, due_on: shift(1) }],
    });
    expect(res.status).toBe(422);
    const cancel = await root.post(`/platform/school-payments/fees/${feeId}/cancel`, { reason: 'Mistake' });
    expect(cancel.status).toBe(422);
  });

  it('a reversed payment reopens the fee', async () => {
    const fee = ok(await root.get(`/platform/tenants/${S.tenantId}/school-payments`)).fees[0];
    const latest = fee.payments[0];
    ok(await root.post(`/platform/school-payments/payments/${latest.id}/reverse`, { reason: 'Bounced' }));
    const after = ok(await root.get(`/platform/tenants/${S.tenantId}/school-payments`)).fees[0];
    expect(after.pending_minor).toBe(5_000_00);
    expect(after.status).toBe('DUE_SOON');
    expect(after.payments[0].status).toBe('REVERSED');
  });

  it('the fee can be raised and its schedule changed', async () => {
    ok(
      await root.put(`/platform/school-payments/fees/${feeId}`, {
        amount_minor: 12_000_00,
        instalments: [
          { amount_minor: 5_000_00, due_on: shift(-10) },
          { amount_minor: 7_000_00, due_on: shift(30) },
        ],
      }),
    );
    const fee = ok(await root.get(`/platform/tenants/${S.tenantId}/school-payments`)).fees[0];
    expect(fee).toMatchObject({ total_minor: 12_000_00, pending_minor: 7_000_00, status: 'PART_PAID', discount_minor: 0 });
  });

  it('shows in the overview and the ledger, with PDFs', async () => {
    const o = ok(await root.get(`/platform/school-payments/overview?session=${SESSION}`));
    expect(o.sessions).toContain(SESSION);
    const row = o.schools.find((r: Json) => r.school.id === S.tenantId);
    expect(row).toMatchObject({ status: 'PART_PAID', fee: { pending_minor: 7_000_00 } });
    expect(o.totals.billed_minor).toBeGreaterThanOrEqual(12_000_00);

    const ledger = ok(await root.get(`/platform/school-payments/payments?session=${SESSION}`));
    const mine = ledger.filter((p: Json) => p.school.id === S.tenantId);
    expect(mine).toHaveLength(2);

    const pdf = await root.get(`/platform/school-payments/fees/${feeId}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const receipt = await root.get(`/platform/school-payments/payments/${mine[0].id}/receipt`);
    expect(receipt.status).toBe(200);
  });

  it('the school sees its own fees read-only, and not another school’s', async () => {
    const v = ok(await S.api.get('/tenants/current/school-payments'));
    expect(v.fees[0].id).toBe(feeId);
    expect((await S.api.get(`/tenants/current/school-payments/fees/${feeId}/pdf`)).status).toBe(200);
    expect(
      (await S.api.post(`/platform/school-payments/fees/${feeId}/payments`, { amount_minor: 100, method: 'CASH' })).status,
    ).toBeGreaterThanOrEqual(401);

    const other = await newSchool();
    expect((await other.api.get(`/tenants/current/school-payments/fees/${feeId}/pdf`)).status).toBe(404);
    expect(ok(await other.api.get('/tenants/current/school-payments')).fees).toHaveLength(0);
  });

  it('a fee set up by mistake is cancelled and can be set up again', async () => {
    const T = await newSchool();
    const first = ok(
      await root.post(`/platform/tenants/${T.tenantId}/school-payments`, {
        session: SESSION,
        amount_minor: 10_000_00,
        instalments: [{ amount_minor: 10_000_00, due_on: shift(20) }],
      }),
      201,
    );
    ok(await root.post(`/platform/school-payments/fees/${first.invoice_id}/cancel`, { reason: 'Wrong amount' }));
    let o = ok(await root.get('/platform/school-payments/overview'));
    expect(o.schools.find((r: Json) => r.school.id === T.tenantId).status).toBe('NOT_SET_UP');
    ok(
      await root.post(`/platform/tenants/${T.tenantId}/school-payments`, {
        session: SESSION,
        amount_minor: 9_000_00,
        instalments: [{ amount_minor: 9_000_00, due_on: shift(20) }],
      }),
      201,
    );
    o = ok(await root.get('/platform/school-payments/overview'));
    expect(o.schools.find((r: Json) => r.school.id === T.tenantId).status).toBe('NOT_DUE');
  });
});
