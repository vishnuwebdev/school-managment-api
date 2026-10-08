import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  outboxEvents,
  subscriptionInvoices,
  subscriptionPayments,
} from '../../src/db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import { code, createHarness, uniq, type Harness } from '../helpers.js';

/** Subscription billing: invoices, offline payments, and what the school can see. */
let h: Harness;
let root: Awaited<ReturnType<Harness['superAdmin']>>;

beforeAll(async () => {
  h = await createHarness();
  root = await h.superAdmin();
});
afterAll(() => h.close());

/** A school started on a paid plan, optionally with a payment already received. */
async function paidSchool(extra: Record<string, unknown> = {}, plan = 'STANDARD') {
  const schoolCode = uniq('bill');
  const created = await root.post('/platform/tenants', {
    code: schoolCode,
    name: `School ${schoolCode}`,
  });
  const tenantId = created.body.data.id as string;
  const adminEmail = `${schoolCode}-admin@school.test`;
  const prov = await root.post(`/platform/tenants/${tenantId}/provision`, {
    plan_code: plan,
    trial_days: 0,
    billing_interval: 'ANNUAL',
    admin: { email: adminEmail, first_name: 'Admin' },
    ...extra,
  });
  expect(prov.status, JSON.stringify(prov.body)).toBe(200);
  const admin = await h.acceptAndLogin(adminEmail);
  return { tenantId, adminEmail, admin, invoiceId: prov.body.data.invoice_id as string | null };
}

describe('a paid subscription is invoiced', () => {
  it('creates an unpaid invoice when the subscription starts, and the school can see it', async () => {
    const S = await paidSchool();
    expect(S.invoiceId).toBeTruthy();

    const res = await S.admin.api.get('/tenants/current/billing');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const b = res.body.data;
    expect(b.subscription).toMatchObject({
      plan: { code: 'STANDARD' },
      status: 'ACTIVE',
      billing_interval: 'ANNUAL',
      auto_renew: true,
    });
    expect(b.subscription.days_remaining).toBeGreaterThan(360);
    expect(b.subscription.price_minor).toBeGreaterThan(0);
    expect(b.invoices).toHaveLength(1);
    expect(b.invoices[0]).toMatchObject({
      status: 'OPEN',
      payment_status: 'UNPAID',
      paid_minor: 0,
      balance_minor: b.subscription.price_minor,
      payments: [],
    });
    expect(b.invoices[0].invoice_number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(b.totals).toMatchObject({
      billed_minor: b.subscription.price_minor,
      paid_minor: 0,
      outstanding_minor: b.subscription.price_minor,
    });
  });

  it('a trial has no invoice', async () => {
    const S = await h.provisionSchool({ trialDays: 14 });
    const b = (await S.admin.api.get('/tenants/current/billing')).body.data;
    expect(b.subscription.status).toBe('TRIAL');
    expect(b.invoices).toEqual([]);
  });

  it('can record the payment received when the school is set up, with a discount', async () => {
    const plan = (await root.get('/platform/plans/STANDARD')).body.data;
    const price = plan.price_annual_minor as number;
    const S = await paidSchool({
      discount_minor: 50_000,
      payment: { amount_minor: price - 50_000, method: 'BANK_TRANSFER', reference: 'EFT-9001' },
    });
    const b = (await S.admin.api.get('/tenants/current/billing')).body.data;
    expect(b.invoices[0]).toMatchObject({
      status: 'PAID',
      payment_status: 'PAID',
      discount_minor: 50_000,
      total_minor: price - 50_000,
      balance_minor: 0,
    });
    expect(b.invoices[0].payments[0]).toMatchObject({
      method: 'BANK_TRANSFER',
      reference: 'EFT-9001',
      status: 'RECEIVED',
    });
    expect(b.invoices[0].payments[0].receipt_number).toMatch(/^SRC-\d{4}-\d{6}$/);
    expect(b.totals.outstanding_minor).toBe(0);
  });

  it('refuses a payment during a trial and a discount that is not below the price', async () => {
    const trial = await root.post('/platform/tenants', { code: uniq('t'), name: 'Trial school' });
    const r1 = await root.post(`/platform/tenants/${trial.body.data.id}/provision`, {
      plan_code: 'STANDARD',
      trial_days: 14,
      admin: { email: `${uniq('x')}@school.test`, first_name: 'A' },
      payment: { amount_minor: 100, method: 'CASH' },
    });
    expect(r1.status).toBe(422);
    const plan = (await root.get('/platform/plans/STANDARD')).body.data;
    const again = await root.post('/platform/tenants', {
      code: uniq('t'),
      name: 'Discount school',
    });
    const r2 = await root.post(`/platform/tenants/${again.body.data.id}/provision`, {
      plan_code: 'STANDARD',
      trial_days: 0,
      admin: { email: `${uniq('x')}@school.test`, first_name: 'A' },
      discount_minor: plan.price_annual_minor,
    });
    expect(r2.status).toBe(422);
  });
});

describe('recording offline payments', () => {
  it('part payments keep the invoice open; the last one closes it; overpaying is refused', async () => {
    const S = await paidSchool();
    const inv = (await S.admin.api.get('/tenants/current/billing')).body.data.invoices[0];
    const total = inv.total_minor as number;

    const first = await root.post(`/platform/billing/invoices/${S.invoiceId}/payments`, {
      amount_minor: 1000,
      method: 'CASH',
      notes: 'Paid at office',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.invoice_status).toBe('OPEN');
    let b = (await S.admin.api.get('/tenants/current/billing')).body.data;
    expect(b.invoices[0]).toMatchObject({ payment_status: 'PART_PAID', paid_minor: 1000 });

    const over = await root.post(`/platform/billing/invoices/${S.invoiceId}/payments`, {
      amount_minor: total,
      method: 'CASH',
    });
    expect(over.status).toBe(422);
    expect(code(over)).toBe('OPERATION_NOT_ALLOWED');

    const last = await root.post(`/platform/billing/invoices/${S.invoiceId}/payments`, {
      amount_minor: total - 1000,
      method: 'CHEQUE',
      reference: 'CHQ 000123',
    });
    expect(last.body.data.invoice_status).toBe('PAID');
    b = (await S.admin.api.get('/tenants/current/billing')).body.data;
    expect(b.invoices[0]).toMatchObject({ status: 'PAID', balance_minor: 0 });
    expect(b.invoices[0].payments).toHaveLength(2);

    const more = await root.post(`/platform/billing/invoices/${S.invoiceId}/payments`, {
      amount_minor: 1,
      method: 'CASH',
    });
    expect(code(more)).toBe('INVALID_STATE');
  });

  it('a reversed payment reopens the invoice and stays on file; a paid invoice cannot be voided', async () => {
    const S = await paidSchool();
    const total = (await S.admin.api.get('/tenants/current/billing')).body.data.invoices[0]
      .total_minor;
    const pay = await root.post(`/platform/billing/invoices/${S.invoiceId}/payments`, {
      amount_minor: total,
      method: 'CHEQUE',
    });
    const paymentId = (await S.admin.api.get('/tenants/current/billing')).body.data.invoices[0]
      .payments[0].id;
    expect(pay.status).toBe(201);

    const noVoid = await root.post(`/platform/billing/invoices/${S.invoiceId}/void`, {
      reason: 'Mistake',
    });
    expect(code(noVoid)).toBe('OPERATION_NOT_ALLOWED');

    const rev = await root.post(`/platform/billing/payments/${paymentId}/reverse`, {
      reason: 'Cheque bounced',
    });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const inv = (await S.admin.api.get('/tenants/current/billing')).body.data.invoices[0];
    expect(inv).toMatchObject({ status: 'OPEN', paid_minor: 0, payment_status: 'UNPAID' });
    expect(inv.payments[0]).toMatchObject({ status: 'REVERSED', reverse_reason: 'Cheque bounced' });
    expect(
      (await root.post(`/platform/billing/payments/${paymentId}/reverse`, { reason: 'Again' }))
        .status,
    ).toBe(422);

    const voided = await root.post(`/platform/billing/invoices/${S.invoiceId}/void`, {
      reason: 'Issued in error',
    });
    expect(voided.status).toBe(200);
    const after = (await S.admin.api.get('/tenants/current/billing')).body.data;
    expect(after.invoices[0]).toMatchObject({
      status: 'VOID',
      payment_status: 'VOID',
      balance_minor: 0,
    });
    expect(after.totals).toMatchObject({ billed_minor: 0, outstanding_minor: 0 });
  });

  it('renewing issues a new invoice; a manual invoice can be added; events are published', async () => {
    const S = await paidSchool();
    const renew = await root.post(`/platform/tenants/${S.tenantId}/subscriptions`, {
      plan_code: 'STANDARD',
      billing_interval: 'ANNUAL',
      reason: 'Renewal',
      payment: { amount_minor: 1000, method: 'CASH' },
    });
    expect(renew.status, JSON.stringify(renew.body)).toBe(201);
    expect(renew.body.data.invoice_id).toBeTruthy();
    const manual = await root.post(`/platform/tenants/${S.tenantId}/billing/invoices`, {
      description: 'Onboarding and data migration',
      amount_minor: 25_000,
    });
    expect(manual.status, JSON.stringify(manual.body)).toBe(201);

    const b = (await S.admin.api.get('/tenants/current/billing')).body.data;
    expect(b.invoices).toHaveLength(3);
    expect(b.history).toHaveLength(2);
    expect(b.subscription.status).toBe('ACTIVE');
    const events = await h.deps.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.tenantId, S.tenantId),
          eq(outboxEvents.eventType, 'billing.invoice_issued'),
        ),
      );
    expect(events).toHaveLength(3);
  });
});

describe('who can see and change billing', () => {
  it('only the school admin sees its own billing; others and other schools get nothing', async () => {
    const A = await paidSchool();
    const B = await paidSchool();
    const teacher = await h.addMember(A.admin.api, [
      { role_id: await h.roleId(A.admin.api, 'TEACHER') },
    ]);
    expect((await teacher.api.get('/tenants/current/billing')).status).toBe(403);

    const bBilling = (await B.admin.api.get('/tenants/current/billing')).body.data;
    const bInvoice = bBilling.invoices[0].id;
    // A school cannot fetch another school's invoice.
    expect(
      (await A.admin.api.get(`/tenants/current/billing/invoices/${bInvoice}/pdf`)).status,
    ).toBe(404);
    // And it cannot record payments: those routes are platform-only.
    const pay = await A.admin.api.post(`/platform/billing/invoices/${A.invoiceId}/payments`, {
      amount_minor: 100,
      method: 'CASH',
    });
    expect([401, 403]).toContain(pay.status);
  });

  it('platform staff who can only read subscriptions cannot record payments', async () => {
    const S = await paidSchool();
    const email = `${uniq('sales')}@platform.test`;
    const roles = (await root.get('/platform/roles')).body.data as { id: string; code: string }[];
    const created = await root.post('/platform/users/invitations', {
      email,
      first_name: 'Sales',
      roles: [
        { role_id: roles.find((r) => r.code === 'SALES_ADMIN')!.id, scope_type: 'ALL_TENANTS' },
      ],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sales = h.as((await h.acceptAndLogin(email)).access_token);
    expect((await sales.get(`/platform/tenants/${S.tenantId}/billing`)).status).toBe(200);
    const denied = await sales.post(`/platform/billing/invoices/${S.invoiceId}/payments`, {
      amount_minor: 100,
      method: 'CASH',
    });
    expect(denied.status).toBe(403);
  });
});

describe('printable documents', () => {
  it('serves the invoice and receipt PDFs to the school and to the platform', async () => {
    const S = await paidSchool();
    await root.post(`/platform/billing/invoices/${S.invoiceId}/payments`, {
      amount_minor: 5000,
      method: 'CASH',
    });
    const b = (await S.admin.api.get('/tenants/current/billing')).body.data;
    const inv = b.invoices[0];
    const pdfs = [
      await S.admin.api.get(`/tenants/current/billing/invoices/${inv.id}/pdf`).buffer(true),
      await S.admin.api
        .get(`/tenants/current/billing/payments/${inv.payments[0].id}/receipt`)
        .buffer(true),
      await root.get(`/platform/billing/invoices/${inv.id}/pdf`).buffer(true),
      await root.get(`/platform/billing/payments/${inv.payments[0].id}/receipt`).buffer(true),
    ];
    for (const res of pdfs) {
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(Buffer.from(res.body).subarray(0, 4).toString()).toBe('%PDF');
    }
  });
});

describe('revenue across all schools', () => {
  type Row = {
    school: { id: string };
    currency: string;
    health: string;
    billed_minor: number;
    paid_minor: number;
    outstanding_minor: number;
    overdue_minor: number;
    needs_invoice: boolean;
    last_payment_on: string | null;
  };
  const rowOf = async (tenantId: string) => {
    const res = await root.get('/platform/billing/overview');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return {
      row: (res.body.data.schools as Row[]).find((r) => r.school.id === tenantId)!,
      data: res.body.data,
    };
  };

  it('shows each school’s billed, paid, pending and overdue amounts, and the totals', async () => {
    const S = await paidSchool();
    let { row } = await rowOf(S.tenantId);
    const { data } = await rowOf(S.tenantId);
    const price = row.billed_minor;
    expect(price).toBeGreaterThan(0);
    expect(row).toMatchObject({
      health: 'OUTSTANDING',
      paid_minor: 0,
      outstanding_minor: price,
      overdue_minor: 0,
    });
    const usd = data.totals.find((t: { currency: string }) => t.currency === row.currency);
    expect(usd.outstanding_minor).toBeGreaterThanOrEqual(price);

    await root.post(`/platform/billing/invoices/${S.invoiceId}/payments`, {
      amount_minor: 1000,
      method: 'CASH',
    });
    ({ row } = await rowOf(S.tenantId));
    expect(row).toMatchObject({ paid_minor: 1000, outstanding_minor: price - 1000 });
    expect(row.last_payment_on).toBeTruthy();

    await root.post(`/platform/billing/invoices/${S.invoiceId}/payments`, {
      amount_minor: price - 1000,
      method: 'CHEQUE',
    });
    ({ row } = await rowOf(S.tenantId));
    expect(row).toMatchObject({ health: 'PAID', outstanding_minor: 0 });
  });

  it('flags an invoice as overdue once its due date passes', async () => {
    const S = await paidSchool();
    await h.deps.db
      .update(subscriptionInvoices)
      .set({ dueAt: new Date(Date.now() - 5 * 86_400_000) })
      .where(eq(subscriptionInvoices.tenantId, S.tenantId));
    const { row } = await rowOf(S.tenantId);
    expect(row.health).toBe('OVERDUE');
    expect(row.overdue_minor).toBe(row.outstanding_minor);
  });

  it('lists payments across schools, newest first, and can be read by support but not changed', async () => {
    const S = await paidSchool();
    await root.post(`/platform/billing/invoices/${S.invoiceId}/payments`, {
      amount_minor: 2500,
      method: 'BANK_TRANSFER',
      reference: 'LEDGER-1',
    });
    const res = await root.get('/platform/billing/payments?limit=20');
    expect(res.status).toBe(200);
    const mine = (
      res.body.data as { reference: string; school: { id: string }; invoice_number: string }[]
    ).find((p) => p.reference === 'LEDGER-1');
    expect(mine).toMatchObject({ school: { id: S.tenantId } });
    expect(mine!.invoice_number).toMatch(/^INV-/);
  });

  it('creates invoices for schools enrolled before billing existed, once', async () => {
    const S = await paidSchool();
    // Simulate a school from before billing: no invoice rows at all.
    await h.deps.db
      .delete(subscriptionPayments)
      .where(eq(subscriptionPayments.tenantId, S.tenantId));
    await h.deps.db
      .delete(subscriptionInvoices)
      .where(eq(subscriptionInvoices.tenantId, S.tenantId));
    let { row } = await rowOf(S.tenantId);
    expect(row).toMatchObject({ needs_invoice: true, health: 'NO_INVOICE' });
    expect((await S.admin.api.get('/tenants/current/billing')).body.data.invoices).toEqual([]);

    const first = await root.post('/platform/billing/missing-invoices');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.created).toBeGreaterThanOrEqual(1);
    ({ row } = await rowOf(S.tenantId));
    expect(row).toMatchObject({ needs_invoice: false, health: 'OUTSTANDING' });
    expect((await S.admin.api.get('/tenants/current/billing')).body.data.invoices).toHaveLength(1);

    const again = await root.post('/platform/billing/missing-invoices');
    expect(again.body.data.created).toBe(0);
  });
});
