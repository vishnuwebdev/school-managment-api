import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  billingSequences,
  planVersions,
  plans,
  subscriptionInvoices,
  subscriptionItems,
  subscriptionPayments,
  subscriptions,
  tenants,
} from '../../db/schema/index.js';
import { recordAudit } from '../../platform/audit.js';
import type { Actor } from '../../platform/context.js';
import { publishEvent } from '../../platform/outbox.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { addDays } from '../../shared/time.js';
import { renderInvoice, renderPaymentReceipt } from './billing.pdf.js';
import type { PaymentInput } from './billing.schemas.js';

type InvoiceRow = typeof subscriptionInvoices.$inferSelect;
type PaymentRow = typeof subscriptionPayments.$inferSelect;

const LIVE = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'PENDING'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface NewInvoice {
  tenantId: string;
  subscriptionId?: string | null;
  description: string;
  planName?: string | null;
  currency: string;
  subtotalMinor: number;
  discountMinor?: number;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  issuedAt?: Date;
  dueAt?: Date;
}

/**
 * Subscription billing: what a school is invoiced and what has been paid.
 * Payments are made offline and recorded by the platform team; schools can
 * only read the result.
 */
export class BillingService {
  constructor(private readonly deps: Deps) {}

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /** Platform-wide running number, incremented inside the caller's transaction. */
  private async nextNumber(tx: Executor, prefix: 'INV' | 'SRC', now: Date): Promise<string> {
    const key = `${prefix}:${now.getUTCFullYear()}`;
    await tx
      .insert(billingSequences)
      .values({ sequenceKey: key, lastValue: 0 })
      .onDuplicateKeyUpdate({ set: { lastValue: sql`${billingSequences.lastValue}` } });
    const [row] = await tx
      .select()
      .from(billingSequences)
      .where(eq(billingSequences.sequenceKey, key))
      .for('update');
    const next = (row?.lastValue ?? 0) + 1;
    await tx
      .update(billingSequences)
      .set({ lastValue: next })
      .where(eq(billingSequences.sequenceKey, key));
    return `${prefix}-${now.getUTCFullYear()}-${String(next).padStart(6, '0')}`;
  }

  /** Creates an OPEN invoice inside the caller's transaction. */
  async createInvoice(tx: Executor, actor: Actor, input: NewInvoice) {
    const discount = input.discountMinor ?? 0;
    if (input.subtotalMinor < 1) throw new ValidationError('An invoice needs an amount above zero');
    if (discount < 0 || discount >= input.subtotalMinor)
      throw new ValidationError('The discount must be smaller than the amount');
    const now = this.deps.clock.now();
    const number = await this.nextNumber(tx, 'INV', now);
    const [row] = await tx
      .insert(subscriptionInvoices)
      .values({
        tenantId: input.tenantId,
        subscriptionId: input.subscriptionId ?? null,
        invoiceNumber: number,
        currency: input.currency,
        description: input.description,
        planName: input.planName ?? null,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        issuedAt: input.issuedAt ?? now,
        dueAt: input.dueAt ?? addDays(now, this.deps.env.BILLING_DUE_DAYS),
        subtotalMinor: input.subtotalMinor,
        discountMinor: discount,
        totalMinor: input.subtotalMinor - discount,
        createdBy: actor.userId,
      })
      .$returningId();
    await recordAudit(tx, actor, {
      tenantId: input.tenantId,
      action: 'BILLING_INVOICE_ISSUED',
      entityType: 'subscription_invoice',
      entityId: row!.id,
      after: { invoice_number: number, total_minor: input.subtotalMinor - discount },
    });
    await publishEvent(tx, actor, {
      tenantId: input.tenantId,
      eventType: 'billing.invoice_issued',
      aggregateType: 'subscription_invoice',
      aggregateId: row!.id,
      payload: {
        tenant_id: input.tenantId,
        invoice_id: row!.id,
        invoice_number: number,
        total_minor: input.subtotalMinor - discount,
        currency: input.currency,
      },
    });
    return { id: row!.id, number };
  }

  /** Records a payment against an invoice inside the caller's transaction (locks the invoice). */
  async recordPaymentTx(tx: Executor, actor: Actor, invoiceId: string, input: PaymentInput) {
    const [inv] = await tx
      .select()
      .from(subscriptionInvoices)
      .where(eq(subscriptionInvoices.id, invoiceId))
      .for('update');
    if (!inv) throw new NotFoundError('Invoice');
    if (inv.status === 'VOID')
      throw new BusinessRuleError('INVALID_STATE', 'A voided invoice cannot take payments');
    if (inv.status === 'PAID')
      throw new BusinessRuleError('INVALID_STATE', 'This invoice is already fully paid');
    const balance = inv.totalMinor - inv.paidMinor;
    if (input.amount_minor > balance)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'The payment is more than the amount still owing on this invoice',
        { balance_minor: balance },
      );
    const now = this.deps.clock.now();
    const receivedAt = input.received_on ?? now;
    if (receivedAt.getTime() > now.getTime() + DAY_MS)
      throw new ValidationError('The payment date cannot be in the future');
    const receipt = await this.nextNumber(tx, 'SRC', now);
    const [row] = await tx
      .insert(subscriptionPayments)
      .values({
        tenantId: inv.tenantId,
        invoiceId: inv.id,
        receiptNumber: receipt,
        amountMinor: input.amount_minor,
        currency: inv.currency,
        method: input.method,
        reference: input.reference || null,
        receivedAt,
        notes: input.notes || null,
        recordedBy: actor.userId,
      })
      .$returningId();
    const status = await this.settle(tx, inv.id);
    await recordAudit(tx, actor, {
      tenantId: inv.tenantId,
      action: 'BILLING_PAYMENT_RECORDED',
      entityType: 'subscription_invoice',
      entityId: inv.id,
      after: {
        receipt_number: receipt,
        amount_minor: input.amount_minor,
        method: input.method,
        reference: input.reference ?? null,
        invoice_status: status,
      },
    });
    await publishEvent(tx, actor, {
      tenantId: inv.tenantId,
      eventType: 'billing.payment_recorded',
      aggregateType: 'subscription_invoice',
      aggregateId: inv.id,
      payload: {
        tenant_id: inv.tenantId,
        invoice_id: inv.id,
        payment_id: row!.id,
        receipt_number: receipt,
        amount_minor: input.amount_minor,
        currency: inv.currency,
        invoice_status: status,
      },
    });
    return { id: row!.id, receipt_number: receipt, invoice_status: status };
  }

  async recordPayment(invoiceId: string, input: PaymentInput, actor: Actor) {
    return this.deps.db.transaction(async (tx) => {
      const [inv] = await tx
        .select({ tenantId: subscriptionInvoices.tenantId })
        .from(subscriptionInvoices)
        .where(eq(subscriptionInvoices.id, invoiceId));
      if (!inv) throw new NotFoundError('Invoice');
      return this.recordPaymentTx(tx, { ...actor, tenantId: inv.tenantId }, invoiceId, input);
    });
  }

  /** Issues an invoice not tied to starting a subscription (renewal fee, extra, correction). */
  async createManualInvoice(
    tenantId: string,
    input: {
      description: string;
      amountMinor: number;
      discountMinor?: number;
      dueAt?: Date;
      subscriptionId?: string;
      payment?: PaymentInput;
    },
    actor: Actor,
  ) {
    return this.deps.db.transaction(async (tx) => {
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId));
      if (!tenant) throw new NotFoundError('School');
      let sub: typeof subscriptions.$inferSelect | undefined;
      if (input.subscriptionId) {
        [sub] = await tx
          .select()
          .from(subscriptions)
          .where(
            and(eq(subscriptions.id, input.subscriptionId), eq(subscriptions.tenantId, tenantId)),
          );
        if (!sub) throw new NotFoundError('Subscription');
      } else {
        [sub] = await tx
          .select()
          .from(subscriptions)
          .where(and(eq(subscriptions.tenantId, tenantId), inArray(subscriptions.status, LIVE)))
          .orderBy(desc(subscriptions.startsAt))
          .limit(1);
      }
      if (!sub)
        throw new BusinessRuleError(
          'INVALID_STATE',
          'The school has no subscription to invoice. Start one first.',
        );
      const a: Actor = { ...actor, tenantId };
      const invoice = await this.createInvoice(tx, a, {
        tenantId,
        subscriptionId: sub.id,
        description: input.description,
        currency: sub.currency,
        subtotalMinor: input.amountMinor,
        discountMinor: input.discountMinor,
        dueAt: input.dueAt,
      });
      const payment = input.payment
        ? await this.recordPaymentTx(tx, a, invoice.id, input.payment)
        : null;
      return { invoice, payment };
    });
  }

  async voidInvoice(invoiceId: string, reason: string, actor: Actor) {
    await this.deps.db.transaction(async (tx) => {
      const [inv] = await tx
        .select()
        .from(subscriptionInvoices)
        .where(eq(subscriptionInvoices.id, invoiceId))
        .for('update');
      if (!inv) throw new NotFoundError('Invoice');
      if (inv.status === 'VOID')
        throw new BusinessRuleError('INVALID_STATE', 'This invoice is already void');
      if (inv.paidMinor > 0)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'Reverse the payments on this invoice before voiding it',
        );
      const now = this.deps.clock.now();
      await tx
        .update(subscriptionInvoices)
        .set({ status: 'VOID', voidedAt: now, voidReason: reason })
        .where(eq(subscriptionInvoices.id, inv.id));
      const a: Actor = { ...actor, tenantId: inv.tenantId };
      await recordAudit(tx, a, {
        tenantId: inv.tenantId,
        action: 'BILLING_INVOICE_VOIDED',
        entityType: 'subscription_invoice',
        entityId: inv.id,
        before: { status: inv.status },
        after: { status: 'VOID' },
        reason,
      });
      await publishEvent(tx, a, {
        tenantId: inv.tenantId,
        eventType: 'billing.invoice_voided',
        aggregateType: 'subscription_invoice',
        aggregateId: inv.id,
        payload: { tenant_id: inv.tenantId, invoice_id: inv.id, invoice_number: inv.invoiceNumber },
      });
    });
  }

  /** For a payment recorded by mistake (bounced cheque, wrong amount). The receipt stays on file, marked reversed. */
  async reversePayment(paymentId: string, reason: string, actor: Actor) {
    await this.deps.db.transaction(async (tx) => {
      const [pay] = await tx
        .select()
        .from(subscriptionPayments)
        .where(eq(subscriptionPayments.id, paymentId))
        .for('update');
      if (!pay) throw new NotFoundError('Payment');
      if (pay.status === 'REVERSED')
        throw new BusinessRuleError('INVALID_STATE', 'This payment is already reversed');
      await tx
        .select()
        .from(subscriptionInvoices)
        .where(eq(subscriptionInvoices.id, pay.invoiceId))
        .for('update');
      await tx
        .update(subscriptionPayments)
        .set({ status: 'REVERSED', reversedAt: this.deps.clock.now(), reverseReason: reason })
        .where(eq(subscriptionPayments.id, pay.id));
      const status = await this.settle(tx, pay.invoiceId);
      const a: Actor = { ...actor, tenantId: pay.tenantId };
      await recordAudit(tx, a, {
        tenantId: pay.tenantId,
        action: 'BILLING_PAYMENT_REVERSED',
        entityType: 'subscription_invoice',
        entityId: pay.invoiceId,
        before: { receipt_number: pay.receiptNumber, amount_minor: pay.amountMinor },
        after: { invoice_status: status },
        reason,
      });
      await publishEvent(tx, a, {
        tenantId: pay.tenantId,
        eventType: 'billing.payment_reversed',
        aggregateType: 'subscription_invoice',
        aggregateId: pay.invoiceId,
        payload: {
          tenant_id: pay.tenantId,
          invoice_id: pay.invoiceId,
          payment_id: pay.id,
          receipt_number: pay.receiptNumber,
        },
      });
    });
  }

  /** Brings `paid_minor` and the status back in line with the RECEIVED payments. */
  private async settle(tx: Executor, invoiceId: string): Promise<'OPEN' | 'PAID'> {
    const [sum] = await tx
      .select({ total: sql<string>`COALESCE(SUM(${subscriptionPayments.amountMinor}), 0)` })
      .from(subscriptionPayments)
      .where(
        and(
          eq(subscriptionPayments.invoiceId, invoiceId),
          eq(subscriptionPayments.status, 'RECEIVED'),
        ),
      );
    const paid = Number(sum?.total ?? 0);
    const [inv] = await tx
      .select()
      .from(subscriptionInvoices)
      .where(eq(subscriptionInvoices.id, invoiceId));
    const status = paid >= inv!.totalMinor ? 'PAID' : 'OPEN';
    await tx
      .update(subscriptionInvoices)
      .set({
        paidMinor: paid,
        status,
        paidAt: status === 'PAID' ? this.deps.clock.now() : null,
      })
      .where(eq(subscriptionInvoices.id, invoiceId));
    return status;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  private presentPayment(p: PaymentRow) {
    return {
      id: p.id,
      receipt_number: p.receiptNumber,
      amount_minor: p.amountMinor,
      currency: p.currency,
      method: p.method,
      reference: p.reference,
      received_on: p.receivedAt.toISOString().slice(0, 10),
      status: p.status,
      notes: p.notes,
      reversed_at: p.reversedAt?.toISOString() ?? null,
      reverse_reason: p.reverseReason,
    };
  }

  private presentInvoice(i: InvoiceRow, payments: PaymentRow[]) {
    const now = this.deps.clock.now();
    const balance = i.status === 'VOID' ? 0 : Math.max(0, i.totalMinor - i.paidMinor);
    const paymentStatus =
      i.status === 'VOID'
        ? 'VOID'
        : i.status === 'PAID'
          ? 'PAID'
          : i.paidMinor > 0
            ? 'PART_PAID'
            : 'UNPAID';
    return {
      id: i.id,
      invoice_number: i.invoiceNumber,
      status: i.status,
      payment_status: paymentStatus,
      overdue: i.status === 'OPEN' && i.dueAt.getTime() < now.getTime(),
      description: i.description,
      plan_name: i.planName,
      currency: i.currency,
      issued_on: i.issuedAt.toISOString().slice(0, 10),
      due_on: i.dueAt.toISOString().slice(0, 10),
      period_start: i.periodStart?.toISOString() ?? null,
      period_end: i.periodEnd?.toISOString() ?? null,
      subtotal_minor: i.subtotalMinor,
      discount_minor: i.discountMinor,
      total_minor: i.totalMinor,
      paid_minor: i.paidMinor,
      balance_minor: balance,
      paid_on: i.paidAt?.toISOString().slice(0, 10) ?? null,
      void_reason: i.voidReason,
      payments: payments.map((p) => this.presentPayment(p)),
    };
  }

  /** Plan, dates, invoices and payments of one school. Used by both the school and the platform screens. */
  async overview(tenantId: string) {
    const [tenant] = await this.deps.db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant) throw new NotFoundError('School');
    const subs = await this.deps.db
      .select({
        s: subscriptions,
        planCode: plans.code,
        planName: plans.name,
        price: subscriptionItems.finalPriceMinor,
        discount: subscriptionItems.discountMinor,
      })
      .from(subscriptions)
      .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
      .innerJoin(plans, eq(plans.id, planVersions.planId))
      .leftJoin(
        subscriptionItems,
        and(
          eq(subscriptionItems.subscriptionId, subscriptions.id),
          eq(subscriptionItems.itemType, 'PLAN'),
        ),
      )
      .where(eq(subscriptions.tenantId, tenantId))
      .orderBy(desc(subscriptions.startsAt));
    const now = this.deps.clock.now();
    const shape = (r: (typeof subs)[number]) => ({
      id: r.s.id,
      plan: { code: r.planCode, name: r.planName },
      status: r.s.status,
      billing_interval: r.s.billingInterval,
      currency: r.s.currency,
      purchased_on: r.s.startsAt.toISOString(),
      trial_ends_at: r.s.trialEndsAt?.toISOString() ?? null,
      period_start: r.s.currentPeriodStart.toISOString(),
      period_end: r.s.currentPeriodEnd.toISOString(),
      days_remaining: Math.max(
        0,
        Math.ceil((r.s.currentPeriodEnd.getTime() - now.getTime()) / DAY_MS),
      ),
      auto_renew: r.s.autoRenew,
      cancelled_at: r.s.cancelledAt?.toISOString() ?? null,
      ended_at: r.s.endedAt?.toISOString() ?? null,
      price_minor: r.price ?? 0,
      discount_minor: r.discount ?? 0,
    });
    const current = subs.find((r) => r.s.status !== 'SUPERSEDED') ?? subs[0];

    const invoices = await this.deps.db
      .select()
      .from(subscriptionInvoices)
      .where(eq(subscriptionInvoices.tenantId, tenantId))
      .orderBy(desc(subscriptionInvoices.issuedAt), desc(subscriptionInvoices.invoiceNumber));
    const payments = invoices.length
      ? await this.deps.db
          .select()
          .from(subscriptionPayments)
          .where(eq(subscriptionPayments.tenantId, tenantId))
          .orderBy(asc(subscriptionPayments.receivedAt), asc(subscriptionPayments.createdAt))
      : [];
    const byInvoice = new Map<string, PaymentRow[]>();
    for (const p of payments)
      byInvoice.set(p.invoiceId, [...(byInvoice.get(p.invoiceId) ?? []), p]);

    const live = invoices.filter((i) => i.status !== 'VOID');
    const currency = current?.s.currency ?? live[0]?.currency ?? null;
    return {
      subscription: current ? shape(current) : null,
      history: subs.map(shape),
      totals: {
        currency,
        billed_minor: live.reduce((n, i) => n + i.totalMinor, 0),
        paid_minor: live.reduce((n, i) => n + i.paidMinor, 0),
        outstanding_minor: live.reduce((n, i) => n + Math.max(0, i.totalMinor - i.paidMinor), 0),
        overdue_count: live.filter((i) => i.status === 'OPEN' && i.dueAt.getTime() < now.getTime())
          .length,
      },
      invoices: invoices.map((i) => this.presentInvoice(i, byInvoice.get(i.id) ?? [])),
    };
  }

  // ---------------------------------------------------------------------------
  // Platform-wide revenue view
  // ---------------------------------------------------------------------------

  /**
   * Every school with its plan, dates and money position, plus totals per
   * currency. This is how the platform team sees what is owed and what has
   * been collected.
   */
  async revenueOverview() {
    const now = this.deps.clock.now();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const subs = await this.deps.db
      .select({
        s: subscriptions,
        planCode: plans.code,
        planName: plans.name,
        price: subscriptionItems.finalPriceMinor,
      })
      .from(subscriptions)
      .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
      .innerJoin(plans, eq(plans.id, planVersions.planId))
      .leftJoin(
        subscriptionItems,
        and(
          eq(subscriptionItems.subscriptionId, subscriptions.id),
          eq(subscriptionItems.itemType, 'PLAN'),
        ),
      )
      .orderBy(desc(subscriptions.startsAt));
    const currentByTenant = new Map<string, (typeof subs)[number]>();
    for (const r of subs) {
      const have = currentByTenant.get(r.s.tenantId);
      if (!have && r.s.status !== 'SUPERSEDED') currentByTenant.set(r.s.tenantId, r);
    }

    const schools = await this.deps.db
      .select({
        id: tenants.id,
        code: tenants.code,
        name: tenants.name,
        status: tenants.status,
      })
      .from(tenants)
      .where(inArray(tenants.status, ['ACTIVE', 'SUSPENDED', 'PROVISIONING', 'ARCHIVED']));
    const invoices = await this.deps.db.select().from(subscriptionInvoices);
    const payments = await this.deps.db
      .select()
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.status, 'RECEIVED'));

    const lastPayment = new Map<string, Date>();
    const collectedThisMonth = new Map<string, number>();
    for (const p of payments) {
      const prev = lastPayment.get(p.tenantId);
      if (!prev || p.receivedAt > prev) lastPayment.set(p.tenantId, p.receivedAt);
      if (p.receivedAt >= monthStart)
        collectedThisMonth.set(
          p.currency,
          (collectedThisMonth.get(p.currency) ?? 0) + p.amountMinor,
        );
    }
    const invByTenant = new Map<string, InvoiceRow[]>();
    for (const i of invoices)
      invByTenant.set(i.tenantId, [...(invByTenant.get(i.tenantId) ?? []), i]);

    const rows = schools.map((t) => {
      const cur = currentByTenant.get(t.id);
      const inv = (invByTenant.get(t.id) ?? []).filter((i) => i.status !== 'VOID');
      const open = inv.filter((i) => i.status === 'OPEN');
      const overdue = open.filter((i) => i.dueAt.getTime() < now.getTime());
      const bal = (i: InvoiceRow) => Math.max(0, i.totalMinor - i.paidMinor);
      const billed = inv.reduce((n, i) => n + i.totalMinor, 0);
      const paid = inv.reduce((n, i) => n + i.paidMinor, 0);
      const outstanding = open.reduce((n, i) => n + bal(i), 0);
      const overdueMinor = overdue.reduce((n, i) => n + bal(i), 0);
      const sub = cur?.s;
      const live = !!sub && ['TRIAL', 'ACTIVE', 'PAST_DUE'].includes(sub.status);
      const daysRemaining = sub
        ? Math.max(0, Math.ceil((sub.currentPeriodEnd.getTime() - now.getTime()) / DAY_MS))
        : 0;
      const needsInvoice =
        !!sub && sub.status !== 'TRIAL' && (cur?.price ?? 0) > 0 && inv.length === 0;
      let health: string;
      if (!sub) health = 'NO_SUBSCRIPTION';
      else if (overdueMinor > 0) health = 'OVERDUE';
      else if (outstanding > 0) health = 'OUTSTANDING';
      else if (needsInvoice) health = 'NO_INVOICE';
      else if (sub.status === 'TRIAL') health = 'TRIAL';
      else if (!live) health = 'ENDED';
      else health = 'PAID';
      return {
        school: { id: t.id, code: t.code, name: t.name, status: t.status },
        plan: cur ? { code: cur.planCode, name: cur.planName } : null,
        subscription_status: sub?.status ?? null,
        billing_interval: sub?.billingInterval ?? null,
        currency: sub?.currency ?? inv[0]?.currency ?? null,
        enrolled_on: sub?.startsAt.toISOString() ?? null,
        period_end: sub?.currentPeriodEnd.toISOString() ?? null,
        days_remaining: daysRemaining,
        auto_renew: sub?.autoRenew ?? false,
        price_minor: cur?.price ?? 0,
        invoice_count: inv.length,
        billed_minor: billed,
        paid_minor: paid,
        outstanding_minor: outstanding,
        overdue_minor: overdueMinor,
        overdue_count: overdue.length,
        next_due_on:
          open.length > 0
            ? new Date(Math.min(...open.map((i) => i.dueAt.getTime()))).toISOString().slice(0, 10)
            : null,
        last_payment_on: lastPayment.get(t.id)?.toISOString().slice(0, 10) ?? null,
        needs_invoice: needsInvoice,
        health,
        expiring_soon: live && daysRemaining <= 30,
      };
    });

    const byCurrency = new Map<
      string,
      {
        currency: string;
        billed_minor: number;
        collected_minor: number;
        outstanding_minor: number;
        overdue_minor: number;
        collected_this_month_minor: number;
        schools_with_balance: number;
      }
    >();
    for (const r of rows) {
      if (!r.currency) continue;
      const c = byCurrency.get(r.currency) ?? {
        currency: r.currency,
        billed_minor: 0,
        collected_minor: 0,
        outstanding_minor: 0,
        overdue_minor: 0,
        collected_this_month_minor: collectedThisMonth.get(r.currency) ?? 0,
        schools_with_balance: 0,
      };
      c.billed_minor += r.billed_minor;
      c.collected_minor += r.paid_minor;
      c.outstanding_minor += r.outstanding_minor;
      c.overdue_minor += r.overdue_minor;
      if (r.outstanding_minor > 0) c.schools_with_balance += 1;
      byCurrency.set(r.currency, c);
    }
    for (const [currency, minor] of collectedThisMonth)
      if (!byCurrency.has(currency))
        byCurrency.set(currency, {
          currency,
          billed_minor: 0,
          collected_minor: 0,
          outstanding_minor: 0,
          overdue_minor: 0,
          collected_this_month_minor: minor,
          schools_with_balance: 0,
        });

    return {
      totals: [...byCurrency.values()],
      counts: {
        schools: rows.length,
        paying: rows.filter((r) => r.subscription_status === 'ACTIVE').length,
        on_trial: rows.filter((r) => r.subscription_status === 'TRIAL').length,
        expiring_soon: rows.filter((r) => r.expiring_soon).length,
        ended: rows.filter((r) => r.health === 'ENDED').length,
        overdue: rows.filter((r) => r.health === 'OVERDUE').length,
        needs_invoice: rows.filter((r) => r.needs_invoice).length,
      },
      schools: rows.sort(
        (a, b) =>
          b.overdue_minor - a.overdue_minor ||
          b.outstanding_minor - a.outstanding_minor ||
          a.school.name.localeCompare(b.school.name),
      ),
    };
  }

  /** Every payment recorded across schools, newest first. */
  async paymentLedger(opts: { limit: number; since?: Date }) {
    const rows = await this.deps.db
      .select({
        p: subscriptionPayments,
        invoiceNumber: subscriptionInvoices.invoiceNumber,
        schoolId: tenants.id,
        schoolName: tenants.name,
      })
      .from(subscriptionPayments)
      .innerJoin(subscriptionInvoices, eq(subscriptionInvoices.id, subscriptionPayments.invoiceId))
      .innerJoin(tenants, eq(tenants.id, subscriptionPayments.tenantId))
      .where(opts.since ? gte(subscriptionPayments.receivedAt, opts.since) : undefined)
      .orderBy(desc(subscriptionPayments.receivedAt), desc(subscriptionPayments.createdAt))
      .limit(opts.limit);
    return rows.map(({ p, invoiceNumber, schoolId, schoolName }) => ({
      ...this.presentPayment(p),
      invoice_id: p.invoiceId,
      invoice_number: invoiceNumber,
      school: { id: schoolId, name: schoolName },
    }));
  }

  /**
   * Schools that were enrolled before billing existed have a paid
   * subscription but no invoice. This creates one for each (dated from the
   * purchase, due in the usual number of days from today) so what they owe
   * is visible and payments can be recorded.
   */
  async createMissingInvoices(actor: Actor) {
    return this.deps.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          s: subscriptions,
          planName: plans.name,
          price: subscriptionItems.finalPriceMinor,
          standard: subscriptionItems.standardPriceMinor,
        })
        .from(subscriptions)
        .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
        .innerJoin(plans, eq(plans.id, planVersions.planId))
        .innerJoin(
          subscriptionItems,
          and(
            eq(subscriptionItems.subscriptionId, subscriptions.id),
            eq(subscriptionItems.itemType, 'PLAN'),
          ),
        )
        .where(inArray(subscriptions.status, ['ACTIVE', 'PAST_DUE']));
      const created: { tenant_id: string; invoice_number: string }[] = [];
      for (const r of rows) {
        if ((r.price ?? 0) <= 0) continue;
        const [existing] = await tx
          .select({ id: subscriptionInvoices.id })
          .from(subscriptionInvoices)
          .where(eq(subscriptionInvoices.subscriptionId, r.s.id))
          .limit(1);
        if (existing) continue;
        const interval = { MONTHLY: 'monthly', ANNUAL: 'annual', CUSTOM: 'custom-term' }[
          r.s.billingInterval
        ];
        const inv = await this.createInvoice(
          tx,
          { ...actor, tenantId: r.s.tenantId },
          {
            tenantId: r.s.tenantId,
            subscriptionId: r.s.id,
            description: `${r.planName} plan, ${interval} subscription`,
            planName: r.planName,
            currency: r.s.currency,
            subtotalMinor: r.standard,
            discountMinor: Math.max(0, r.standard - (r.price ?? r.standard)),
            periodStart: r.s.currentPeriodStart,
            periodEnd: r.s.currentPeriodEnd,
            issuedAt: r.s.startsAt,
            dueAt: addDays(this.deps.clock.now(), this.deps.env.BILLING_DUE_DAYS),
          },
        );
        created.push({ tenant_id: r.s.tenantId, invoice_number: inv.number });
      }
      return { created: created.length, invoices: created };
    });
  }

  // ---------------------------------------------------------------------------
  // PDFs. `tenantId` limits the lookup to one school (school-side routes).
  // ---------------------------------------------------------------------------

  private issuer() {
    return {
      name: this.deps.env.BILLING_ISSUER_NAME,
      details: this.deps.env.BILLING_ISSUER_DETAILS.replace(/\\n/g, '\n'),
    };
  }

  async invoicePdf(invoiceId: string, tenantId?: string) {
    const [inv] = await this.deps.db
      .select()
      .from(subscriptionInvoices)
      .where(
        tenantId
          ? and(eq(subscriptionInvoices.id, invoiceId), eq(subscriptionInvoices.tenantId, tenantId))
          : eq(subscriptionInvoices.id, invoiceId),
      );
    if (!inv) throw new NotFoundError('Invoice');
    const [t] = await this.deps.db.select().from(tenants).where(eq(tenants.id, inv.tenantId));
    const pays = await this.deps.db
      .select()
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.invoiceId, inv.id))
      .orderBy(asc(subscriptionPayments.receivedAt));
    const data = await renderInvoice({
      issuer: this.issuer(),
      invoice_number: inv.invoiceNumber,
      status: inv.status,
      void_reason: inv.voidReason,
      currency: inv.currency,
      description: inv.description,
      plan_name: inv.planName,
      issued_at: inv.issuedAt,
      due_at: inv.dueAt,
      period_start: inv.periodStart,
      period_end: inv.periodEnd,
      subtotal_minor: inv.subtotalMinor,
      discount_minor: inv.discountMinor,
      total_minor: inv.totalMinor,
      paid_minor: inv.paidMinor,
      bill_to: {
        name: t?.name ?? 'School',
        address: [t?.addressLine1, t?.addressLine2, t?.city, t?.state, t?.postalCode]
          .filter(Boolean)
          .join(', '),
        email: t?.contactEmail ?? null,
      },
      payments: pays.map((p) => ({
        receipt_number: p.receiptNumber,
        received_at: p.receivedAt,
        method: p.method,
        reference: p.reference,
        amount_minor: p.amountMinor,
        reversed: p.status === 'REVERSED',
      })),
    });
    return { data, filename: `${inv.invoiceNumber}.pdf` };
  }

  async receiptPdf(paymentId: string, tenantId?: string) {
    const [pay] = await this.deps.db
      .select()
      .from(subscriptionPayments)
      .where(
        tenantId
          ? and(eq(subscriptionPayments.id, paymentId), eq(subscriptionPayments.tenantId, tenantId))
          : eq(subscriptionPayments.id, paymentId),
      );
    if (!pay) throw new NotFoundError('Payment');
    const [inv] = await this.deps.db
      .select()
      .from(subscriptionInvoices)
      .where(eq(subscriptionInvoices.id, pay.invoiceId));
    const [t] = await this.deps.db.select().from(tenants).where(eq(tenants.id, pay.tenantId));
    const data = await renderPaymentReceipt({
      issuer: this.issuer(),
      receipt_number: pay.receiptNumber,
      reversed: pay.status === 'REVERSED',
      reverse_reason: pay.reverseReason,
      currency: pay.currency,
      amount_minor: pay.amountMinor,
      method: pay.method,
      reference: pay.reference,
      received_at: pay.receivedAt,
      invoice_number: inv!.invoiceNumber,
      invoice_total_minor: inv!.totalMinor,
      invoice_paid_minor: inv!.paidMinor,
      received_from: t?.name ?? 'School',
      notes: pay.notes,
    });
    return { data, filename: `${pay.receiptNumber}.pdf` };
  }
}
