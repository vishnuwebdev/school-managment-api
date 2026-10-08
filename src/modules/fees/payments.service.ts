import { and, asc, count, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  ALLOCATABLE_PAYMENT_STATUSES,
  feeDemands,
  feeReceipts,
  feeRefunds,
  OPEN_REFUND_STATUSES,
  paymentAllocations,
  schoolPayments,
  students,
} from '../../db/schema/index.js';
import { publishEvent } from '../../platform/outbox.js';
import { recordChange } from '../../platform/record.js';
import { ConflictError, NotFoundError, isDuplicateKeyError } from '../../shared/errors.js';
import { offsetOf, orderFrom, pageOf } from '../../shared/pagination.js';
import { loadStudent } from '../students/support.js';
import type {
  AllocationRequest,
  CreatePaymentBody,
  PaymentListQuery,
  ReceiptListQuery,
} from './fees.schemas.js';
import { fromMinor, minBig, toMinor } from './money.js';
import {
  businessRule,
  dateInZone,
  ensureSettings,
  feeScope,
  likeOf,
  loadPayment,
  lockDemands,
  moneyOf,
  nextNumber,
  outstandingOfMoney,
  presentAllocation,
  presentPayment,
  presentReceipt,
  presentRefund,
  readSettings,
  schoolTimezone,
  schoolToday,
  staleVersion,
  studentMini,
  studentMinis,
  validationIssue,
  withDeadlockRetry,
  writeDemand,
  type AllocationRow,
  type Caller,
  type DemandRow,
  type PaymentRow,
  type ReceiptRow,
} from './support.js';

type AllocationInput = z.infer<typeof AllocationRequest>;
const stale = () => new ConflictError('CONFLICT', undefined, { reason: 'STALE_VERSION' });
const COLLECTABLE = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] as const;

class DuplicateRace extends Error {}

/** Oldest due first, then oldest created, then number. */
const byDue = (a: DemandRow, b: DemandRow) =>
  a.dueDate.localeCompare(b.dueDate) ||
  a.createdAt.getTime() - b.createdAt.getTime() ||
  a.demandNumber.localeCompare(b.demandNumber);

const netOf = (a: AllocationRow) => toMinor(a.allocatedAmount) - toMinor(a.reversedAmount);

export interface Reversal {
  allocation: AllocationRow;
  amount: bigint;
}

/**
 * School payments, allocations and receipts. A payment is money received; it is never deleted —
 * it is cancelled or refunded. Allocations connect it to demands. Everything that moves money
 * between a payment and demands runs under row locks in ONE order:
 *
 *   payment (FOR UPDATE) → allocations → demands (FOR UPDATE, ascending id) → number sequences (last)
 *
 * so concurrent allocations serialise on the payment and on each demand, and can never allocate more
 * than the payment holds or more than a demand still owes. CHECK constraints on the balance columns
 * are the last line of defence.
 */
export class PaymentService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  // ---- reads ----------------------------------------------------------------------------------------

  async list(c: Caller, q: z.infer<typeof PaymentListQuery>) {
    const p = schoolPayments;
    const where = and(
      eq(p.tenantId, c.tenantId),
      feeScope(c.principal, 'fees.read', p),
      q.student_id ? eq(p.studentId, q.student_id) : undefined,
      q.status ? eq(p.status, q.status) : undefined,
      q.method ? eq(p.method, q.method) : undefined,
      q.from ? sql`${p.receivedOn} >= ${q.from}` : undefined,
      q.to ? sql`${p.receivedOn} <= ${q.to}` : undefined,
      q.search
        ? or(
            like(p.paymentNumber, likeOf(q.search)),
            like(p.providerReference, likeOf(q.search)),
            like(students.studentNumber, likeOf(q.search)),
            like(students.firstName, likeOf(q.search)),
            like(students.lastName, likeOf(q.search)),
          )
        : undefined,
    );
    const order = orderFrom(
      q,
      { received_on: p.receivedOn, created_at: p.createdAt, amount: p.amount },
      'created_at',
    );
    const [rows, [total]] = await Promise.all([
      this.db
        .select({ p, s: students })
        .from(p)
        .innerJoin(students, and(eq(students.tenantId, p.tenantId), eq(students.id, p.studentId)))
        .where(where)
        .orderBy(order, q.order === 'asc' ? asc(p.id) : desc(p.id))
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db
        .select({ n: count() })
        .from(p)
        .innerJoin(students, and(eq(students.tenantId, p.tenantId), eq(students.id, p.studentId)))
        .where(where),
    ]);
    return pageOf(
      rows.map((r) => presentPayment(r.p, { student: studentMini(r.s) })),
      total?.n ?? 0,
      q,
    );
  }

  private async openRefundTotal(ex: Executor, tenantId: string, paymentId: string, lock: boolean) {
    const q = ex
      .select({ amount: feeRefunds.amount })
      .from(feeRefunds)
      .where(
        and(
          eq(feeRefunds.tenantId, tenantId),
          eq(feeRefunds.paymentId, paymentId),
          inArray(feeRefunds.status, [...OPEN_REFUND_STATUSES]),
        ),
      );
    const rows = await (lock ? q.for('share') : q);
    return rows.reduce((a, r) => a + toMinor(r.amount), 0n);
  }

  async get(c: Caller, id: string, ex: Executor = this.db) {
    const p = await loadPayment(ex, c.tenantId, id, c.principal, 'fees.read');
    const [s] = await ex
      .select()
      .from(students)
      .where(and(eq(students.tenantId, c.tenantId), eq(students.id, p.studentId)));
    const allocs = await ex
      .select({ a: paymentAllocations, d: feeDemands })
      .from(paymentAllocations)
      .innerJoin(
        feeDemands,
        and(
          eq(feeDemands.tenantId, paymentAllocations.tenantId),
          eq(feeDemands.id, paymentAllocations.feeDemandId),
        ),
      )
      .where(and(eq(paymentAllocations.tenantId, c.tenantId), eq(paymentAllocations.paymentId, id)))
      .orderBy(asc(paymentAllocations.createdAt), asc(paymentAllocations.id));
    const receipts = await ex
      .select()
      .from(feeReceipts)
      .where(and(eq(feeReceipts.tenantId, c.tenantId), eq(feeReceipts.paymentId, id)))
      .orderBy(asc(feeReceipts.issuedAt), asc(feeReceipts.id));
    const refunds = await ex
      .select()
      .from(feeRefunds)
      .where(and(eq(feeRefunds.tenantId, c.tenantId), eq(feeRefunds.paymentId, id)))
      .orderBy(asc(feeRefunds.requestedAt), asc(feeRefunds.id));
    const reserved = refunds
      .filter((r) => (OPEN_REFUND_STATUSES as readonly string[]).includes(r.status))
      .reduce((a, r) => a + toMinor(r.amount), 0n);
    const mini = s ? studentMini(s) : undefined;
    const view = presentPayment(p, { student: mini });
    const available =
      toMinor(p.amount) - toMinor(p.allocatedAmount) - toMinor(p.refundedAmount) - reserved;
    return {
      ...view,
      reserved_for_refunds: fromMinor(reserved),
      available_to_allocate: fromMinor(
        (ALLOCATABLE_PAYMENT_STATUSES as readonly string[]).includes(p.status) && available > 0n
          ? available
          : 0n,
      ),
      allocations: allocs.map((r) =>
        presentAllocation(r.a, { demandNumber: r.d.demandNumber, description: r.d.description }),
      ),
      receipts: receipts.map((r) => presentReceipt(r, { student: mini })),
      refunds: refunds.map((r) =>
        presentRefund(r, { student: mini, paymentNumber: p.paymentNumber }),
      ),
    };
  }

  // ---- receipts ---------------------------------------------------------------------------------------

  private async issueReceipt(
    tx: Executor,
    c: Caller,
    p: PaymentRow,
    now: Date,
  ): Promise<ReceiptRow> {
    const number = await nextNumber(tx, c.tenantId, 'RCT', now);
    const id = uuidv7();
    await tx.insert(feeReceipts).values({
      id,
      tenantId: c.tenantId,
      paymentId: p.id,
      studentId: p.studentId,
      receiptNumber: number,
      amount: p.amount,
      currency: p.currency,
      issuedAt: now,
      issuedBy: c.actor.userId,
    });
    const [row] = await tx.select().from(feeReceipts).where(eq(feeReceipts.id, id));
    await recordChange(tx, c.actor, c.tenantId, {
      action: 'FEE_RECEIPT_ISSUED',
      entityType: 'receipt',
      entityId: id,
      event: 'receipt.issued',
      after: { receipt_number: number, payment_id: p.id, amount: p.amount },
      payload: {
        payment_id: p.id,
        student_id: p.studentId,
        receipt_number: number,
        amount: p.amount,
        currency: p.currency,
      },
    });
    return row!;
  }

  private async receiptView(ex: Executor, c: Caller, r: ReceiptRow) {
    const [p] = await ex
      .select()
      .from(schoolPayments)
      .where(and(eq(schoolPayments.tenantId, c.tenantId), eq(schoolPayments.id, r.paymentId)));
    const minis = await studentMinis(ex, c.tenantId, [r.studentId]);
    return presentReceipt(r, {
      student: minis.get(r.studentId),
      payment: p
        ? { payment_number: p.paymentNumber, method: p.method, received_on: p.receivedOn }
        : undefined,
    });
  }

  async listReceipts(c: Caller, q: z.infer<typeof ReceiptListQuery>) {
    const r = feeReceipts;
    const where = and(
      eq(r.tenantId, c.tenantId),
      feeScope(c.principal, 'fees.read', r),
      q.student_id ? eq(r.studentId, q.student_id) : undefined,
      q.status ? eq(r.status, q.status) : undefined,
      q.from ? sql`date(${r.issuedAt}) >= ${q.from}` : undefined,
      q.to ? sql`date(${r.issuedAt}) <= ${q.to}` : undefined,
      q.search
        ? or(
            like(r.receiptNumber, likeOf(q.search)),
            like(students.studentNumber, likeOf(q.search)),
            like(students.firstName, likeOf(q.search)),
            like(students.lastName, likeOf(q.search)),
          )
        : undefined,
    );
    const order = orderFrom(
      q,
      { issued_at: r.issuedAt, receipt_number: r.receiptNumber },
      'issued_at',
    );
    const [rows, [total]] = await Promise.all([
      this.db
        .select({ r, s: students, p: schoolPayments })
        .from(r)
        .innerJoin(students, and(eq(students.tenantId, r.tenantId), eq(students.id, r.studentId)))
        .innerJoin(
          schoolPayments,
          and(eq(schoolPayments.tenantId, r.tenantId), eq(schoolPayments.id, r.paymentId)),
        )
        .where(where)
        .orderBy(order, q.order === 'asc' ? asc(r.id) : desc(r.id))
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db
        .select({ n: count() })
        .from(r)
        .innerJoin(students, and(eq(students.tenantId, r.tenantId), eq(students.id, r.studentId)))
        .where(where),
    ]);
    return pageOf(
      rows.map((x) =>
        presentReceipt(x.r, {
          student: studentMini(x.s),
          payment: {
            payment_number: x.p.paymentNumber,
            method: x.p.method,
            received_on: x.p.receivedOn,
          },
        }),
      ),
      total?.n ?? 0,
      q,
    );
  }

  private async loadReceipt(
    ex: Executor,
    c: Caller,
    id: string,
    permission: string,
    lock?: 'update',
  ): Promise<ReceiptRow> {
    const q = ex
      .select()
      .from(feeReceipts)
      .where(
        and(
          eq(feeReceipts.id, id),
          eq(feeReceipts.tenantId, c.tenantId),
          feeScope(c.principal, permission, feeReceipts),
        ),
      );
    const [row] = await (lock ? q.for(lock) : q);
    if (!row) throw new NotFoundError('Receipt');
    return row;
  }

  async getReceipt(c: Caller, id: string) {
    return this.receiptView(this.db, c, await this.loadReceipt(this.db, c, id, 'fees.read'));
  }

  /** Issue a new receipt for a payment that has money received but no valid receipt (e.g. after a void). */
  async issueReceiptFor(c: Caller, paymentId: string) {
    let receiptId!: string;
    await this.db.transaction(async (tx) => {
      const p = await loadPayment(
        tx,
        c.tenantId,
        paymentId,
        c.principal,
        'fees.payments.create',
        'update',
      );
      if (
        !(ALLOCATABLE_PAYMENT_STATUSES as readonly string[]).includes(p.status) &&
        p.status !== 'REFUNDED'
      )
        throw businessRule(
          'PAYMENT_NOT_RECEIVED',
          'A receipt needs a payment whose money has been received',
          {
            payment_status: p.status,
          },
        );
      const [active] = await tx
        .select({ id: feeReceipts.id })
        .from(feeReceipts)
        .where(
          and(
            eq(feeReceipts.tenantId, c.tenantId),
            eq(feeReceipts.paymentId, paymentId),
            eq(feeReceipts.status, 'ISSUED'),
          ),
        );
      if (active)
        throw businessRule('RECEIPT_EXISTS', 'The payment already has a valid receipt', {
          receipt_id: active.id,
        });
      receiptId = (await this.issueReceipt(tx, c, p, this.deps.clock.now())).id;
    });
    return this.getReceipt(c, receiptId);
  }

  async voidReceipt(c: Caller, id: string, reason: string) {
    await this.db.transaction(async (tx) => {
      const r = await this.loadReceipt(tx, c, id, 'fees.payments.verify', 'update');
      if (r.status === 'VOID') throw businessRule('ALREADY_VOID', 'The receipt is already void');
      await tx
        .update(feeReceipts)
        .set({
          status: 'VOID',
          voidedAt: this.deps.clock.now(),
          voidedBy: c.actor.userId,
          voidReason: reason,
          version: r.version + 1,
        })
        .where(eq(feeReceipts.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_RECEIPT_VOIDED',
        entityType: 'receipt',
        entityId: id,
        event: 'receipt.voided',
        before: { status: 'ISSUED', receipt_number: r.receiptNumber },
        after: { status: 'VOID' },
        reason,
        payload: {
          payment_id: r.paymentId,
          student_id: r.studentId,
          receipt_number: r.receiptNumber,
        },
      });
    });
    return this.getReceipt(c, id);
  }

  // ---- allocation core --------------------------------------------------------------------------------

  /**
   * Which demands a request wants and how much of each. AUTO walks the locked demands oldest due first;
   * MANUAL takes the amounts as given. Nothing is validated against balances here.
   */
  private plan(
    req: AllocationInput,
    payment: PaymentRow,
    locked: Map<string, DemandRow>,
    available: bigint,
  ): { demandId: string; amount: bigint }[] {
    if (req.mode === 'MANUAL')
      return req.allocations.map((a) => ({ demandId: a.fee_demand_id, amount: toMinor(a.amount) }));
    const eligible = [...locked.values()]
      .filter(
        (d) =>
          d.studentId === payment.studentId &&
          d.currency === payment.currency &&
          (COLLECTABLE as readonly string[]).includes(d.status) &&
          outstandingOfMoney(moneyOf(d)) > 0n &&
          (!req.demand_ids || req.demand_ids.includes(d.id)),
      )
      .sort(byDue);
    const out: { demandId: string; amount: bigint }[] = [];
    let left = available;
    for (const d of eligible) {
      if (left <= 0n) break;
      const take = minBig(left, outstandingOfMoney(moneyOf(d)));
      out.push({ demandId: d.id, amount: take });
      left -= take;
    }
    return out;
  }

  /** Ids of a student's collectable demands, oldest due first (unlocked read; the caller then locks them). */
  private async candidateDemandIds(
    ex: Executor,
    tenantId: string,
    studentId: string,
    only?: string[],
  ): Promise<string[]> {
    const rows = await ex
      .select({ id: feeDemands.id })
      .from(feeDemands)
      .where(
        and(
          eq(feeDemands.tenantId, tenantId),
          eq(feeDemands.studentId, studentId),
          inArray(feeDemands.status, [...COLLECTABLE]),
          only ? inArray(feeDemands.id, only) : undefined,
        ),
      )
      .orderBy(asc(feeDemands.dueDate), asc(feeDemands.createdAt), asc(feeDemands.id))
      .limit(200);
    return rows.map((r) => r.id);
  }

  /**
   * Applies allocations. The payment row and the demands are already locked by the caller (payment
   * first, demands in id order); balances are re-read from those locked rows, so a concurrent request
   * cannot make both succeed. All or nothing.
   */
  private async allocateLocked(
    tx: Executor,
    c: Caller,
    payment: PaymentRow,
    locked: Map<string, DemandRow>,
    req: AllocationInput,
    o: { today: string; now: Date; freshPayment: boolean },
  ) {
    if (!(ALLOCATABLE_PAYMENT_STATUSES as readonly string[]).includes(payment.status))
      throw businessRule(
        'PAYMENT_NOT_ALLOCATABLE',
        'Money can only be allocated from a received or verified payment',
        { payment_status: payment.status },
        'OPERATION_NOT_ALLOWED',
      );
    const reserved = o.freshPayment
      ? 0n
      : await this.openRefundTotal(tx, c.tenantId, payment.id, true);
    const available =
      toMinor(payment.amount) -
      toMinor(payment.allocatedAmount) -
      toMinor(payment.refundedAmount) -
      reserved;
    const planned = this.plan(req, payment, locked, available > 0n ? available : 0n);
    let total = 0n;
    const done: {
      allocation_id: string;
      fee_demand_id: string;
      amount: string;
      demand_status: string;
    }[] = [];
    const seen = new Set<string>();
    for (const item of planned) {
      const d = locked.get(item.demandId);
      if (!d) throw new NotFoundError('Fee demand');
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      if (d.studentId !== payment.studentId)
        throw businessRule(
          'STUDENT_MISMATCH',
          'A payment can only be allocated to demands of the same student',
          { fee_demand_id: d.id },
          'OPERATION_NOT_ALLOWED',
        );
      if (d.currency !== payment.currency)
        throw businessRule(
          'CURRENCY_MISMATCH',
          'The demand is in another currency than the payment',
          { fee_demand_id: d.id },
          'OPERATION_NOT_ALLOWED',
        );
      if (!(COLLECTABLE as readonly string[]).includes(d.status))
        throw businessRule(
          d.status === 'DRAFT' ? 'DEMAND_NOT_ISSUED' : 'DEMAND_NOT_PAYABLE',
          d.status === 'DRAFT'
            ? 'The demand has not been issued yet'
            : 'The demand cannot receive payments in its current status',
          { fee_demand_id: d.id, demand_status: d.status },
          'OPERATION_NOT_ALLOWED',
        );
      const out = outstandingOfMoney(moneyOf(d));
      if (item.amount > out)
        throw businessRule(
          'EXCEEDS_OUTSTANDING',
          'The allocation is more than the demand still owes',
          {
            fee_demand_id: d.id,
            outstanding_amount: fromMinor(out),
            requested_amount: fromMinor(item.amount),
          },
          'OPERATION_NOT_ALLOWED',
        );
      total += item.amount;
    }
    if (total > (available > 0n ? available : 0n))
      throw businessRule(
        'EXCEEDS_PAYMENT',
        'The allocations are more than the unallocated amount of the payment',
        {
          available_amount: fromMinor(available > 0n ? available : 0n),
          requested_amount: fromMinor(total),
        },
        'OPERATION_NOT_ALLOWED',
      );
    if (total === 0n) return { total, done, paidDemands: [] as DemandRow[] };
    const paidDemands: DemandRow[] = [];
    for (const item of planned) {
      if (item.amount <= 0n) continue;
      const d = locked.get(item.demandId)!;
      const id = uuidv7();
      await tx.insert(paymentAllocations).values({
        id,
        tenantId: c.tenantId,
        paymentId: payment.id,
        feeDemandId: d.id,
        studentId: payment.studentId,
        currency: payment.currency,
        allocatedAmount: fromMinor(item.amount),
        allocatedBy: c.actor.userId,
      });
      const m = moneyOf(d);
      const { row, to } = await writeDemand(
        tx,
        d,
        { paid: m.paid + item.amount },
        { today: o.today, now: o.now },
      );
      locked.set(d.id, row);
      if (to === 'PAID') paidDemands.push(row);
      done.push({
        allocation_id: id,
        fee_demand_id: d.id,
        amount: fromMinor(item.amount),
        demand_status: to,
      });
    }
    await tx
      .update(schoolPayments)
      .set({
        allocatedAmount: fromMinor(toMinor(payment.allocatedAmount) + total),
        version: payment.version + 1,
      })
      .where(eq(schoolPayments.id, payment.id));
    payment.allocatedAmount = fromMinor(toMinor(payment.allocatedAmount) + total);
    payment.version += 1;
    await recordChange(tx, c.actor, c.tenantId, {
      action: 'FEE_PAYMENT_ALLOCATED',
      entityType: 'payment',
      entityId: payment.id,
      event: 'payment.allocated',
      after: { allocated_amount: payment.allocatedAmount, allocations: done },
      payload: {
        student_id: payment.studentId,
        payment_number: payment.paymentNumber,
        amount: fromMinor(total),
        currency: payment.currency,
        allocations: done,
      },
    });
    for (const d of paidDemands)
      await publishEvent(tx, c.actor, {
        tenantId: c.tenantId,
        eventType: 'fee_demand.paid',
        aggregateType: 'fee_demand',
        aggregateId: d.id,
        payload: {
          fee_demand_id: d.id,
          student_id: d.studentId,
          demand_number: d.demandNumber,
          final_amount: d.finalAmount,
          currency: d.currency,
        },
      });
    return { total, done, paidDemands };
  }

  async allocate(c: Caller, paymentId: string, req: AllocationInput, version?: number) {
    await withDeadlockRetry(() =>
      this.db.transaction(async (tx) => {
        const p = await loadPayment(
          tx,
          c.tenantId,
          paymentId,
          c.principal,
          'fees.payments.create',
          'update',
        );
        if (staleVersion(p.version, version)) throw stale();
        const ids =
          req.mode === 'MANUAL'
            ? req.allocations.map((a) => a.fee_demand_id)
            : await this.candidateDemandIds(tx, c.tenantId, p.studentId, req.demand_ids);
        const locked = await lockDemands(tx, c.tenantId, [...new Set(ids)]);
        if (req.mode === 'MANUAL')
          for (const id of ids) if (!locked.has(id)) throw new NotFoundError('Fee demand');
        await this.allocateLocked(tx, c, p, locked, req, {
          today: await schoolToday(tx, c.tenantId, this.deps.clock),
          now: this.deps.clock.now(),
          freshPayment: false,
        });
      }),
    );
    return this.get(c, paymentId);
  }

  // ---- reversal core (cancel, correction, refund) ------------------------------------------------------------

  /**
   * Takes money back out of allocations: raises `reversed_amount`, lowers the demand's `paid_amount`
   * (re-opening its balance and recomputing its status) and the payment's `allocated_amount`.
   * The caller holds the payment lock and has locked the allocation rows.
   */
  async reverseLocked(
    tx: Executor,
    c: Caller,
    payment: PaymentRow,
    reversals: Reversal[],
    o: { reason: string; today: string; now: Date },
  ): Promise<
    { allocation_id: string; fee_demand_id: string; amount: string; demand_status: string }[]
  > {
    if (!reversals.length) return [];
    const demandIds = [...new Set(reversals.map((r) => r.allocation.feeDemandId))];
    const locked = await lockDemands(tx, c.tenantId, demandIds);
    const out: {
      allocation_id: string;
      fee_demand_id: string;
      amount: string;
      demand_status: string;
    }[] = [];
    let total = 0n;
    for (const r of reversals) {
      const a = r.allocation;
      const newReversed = toMinor(a.reversedAmount) + r.amount;
      const full = newReversed >= toMinor(a.allocatedAmount);
      await tx
        .update(paymentAllocations)
        .set({
          reversedAmount: fromMinor(newReversed),
          status: full ? 'REVERSED' : 'PARTIALLY_REVERSED',
          reversedAt: o.now,
          reversedBy: c.actor.userId,
          reversalReason: o.reason,
        })
        .where(eq(paymentAllocations.id, a.id));
      const d = locked.get(a.feeDemandId)!;
      const m = moneyOf(d);
      const { row, to } = await writeDemand(
        tx,
        d,
        { paid: m.paid - r.amount },
        { today: o.today, now: o.now },
      );
      locked.set(d.id, row);
      total += r.amount;
      out.push({
        allocation_id: a.id,
        fee_demand_id: d.id,
        amount: fromMinor(r.amount),
        demand_status: to,
      });
    }
    await tx
      .update(schoolPayments)
      .set({
        allocatedAmount: fromMinor(toMinor(payment.allocatedAmount) - total),
        version: payment.version + 1,
      })
      .where(eq(schoolPayments.id, payment.id));
    payment.allocatedAmount = fromMinor(toMinor(payment.allocatedAmount) - total);
    payment.version += 1;
    return out;
  }

  /** Correct a wrong allocation without refunding: the money returns to the payment's unallocated balance. */
  async reverseAllocation(c: Caller, paymentId: string, allocationId: string, reason: string) {
    await withDeadlockRetry(() =>
      this.db.transaction(async (tx) => {
        const p = await loadPayment(
          tx,
          c.tenantId,
          paymentId,
          c.principal,
          'fees.payments.verify',
          'update',
        );
        const [a] = await tx
          .select()
          .from(paymentAllocations)
          .where(
            and(
              eq(paymentAllocations.id, allocationId),
              eq(paymentAllocations.tenantId, c.tenantId),
              eq(paymentAllocations.paymentId, paymentId),
            ),
          )
          .for('update');
        if (!a) throw new NotFoundError('Allocation');
        if (netOf(a) <= 0n)
          throw businessRule('ALREADY_REVERSED', 'The allocation has already been reversed');
        const today = await schoolToday(tx, c.tenantId, this.deps.clock);
        const done = await this.reverseLocked(tx, c, p, [{ allocation: a, amount: netOf(a) }], {
          reason,
          today,
          now: this.deps.clock.now(),
        });
        await recordChange(tx, c.actor, c.tenantId, {
          action: 'FEE_PAYMENT_ALLOCATION_REVERSED',
          entityType: 'payment',
          entityId: paymentId,
          event: 'payment.allocation_reversed',
          before: { allocation_id: allocationId, net_amount: fromMinor(netOf(a)) },
          after: { reversed: done },
          reason,
          payload: { student_id: p.studentId, payment_number: p.paymentNumber, reversed: done },
        });
      }),
    );
    return this.get(c, paymentId);
  }

  // ---- create ---------------------------------------------------------------------------------------------------

  private sameRequest(p: PaymentRow, input: z.infer<typeof CreatePaymentBody>) {
    return (
      p.studentId === input.student_id &&
      toMinor(p.amount) === toMinor(input.amount) &&
      p.method === input.method &&
      (p.providerReference ?? null) === (input.provider_reference ?? null)
    );
  }

  /** The payment a retry refers to (same idempotency key or provider reference), if any. */
  private async findExisting(tenantId: string, input: z.infer<typeof CreatePaymentBody>) {
    const conds = [];
    if (input.idempotency_key) conds.push(eq(schoolPayments.idempotencyKey, input.idempotency_key));
    if (input.provider_reference)
      conds.push(eq(schoolPayments.providerReference, input.provider_reference));
    if (!conds.length) return null;
    const rows = await this.db
      .select()
      .from(schoolPayments)
      .where(and(eq(schoolPayments.tenantId, tenantId), or(...conds)));
    return rows;
  }

  private resolveRetry(rows: PaymentRow[], input: z.infer<typeof CreatePaymentBody>) {
    const byKey = input.idempotency_key
      ? rows.find((r) => r.idempotencyKey === input.idempotency_key)
      : undefined;
    const byRef = input.provider_reference
      ? rows.find((r) => r.providerReference === input.provider_reference)
      : undefined;
    if (byKey) {
      if (!this.sameRequest(byKey, input))
        throw new ConflictError(
          'DUPLICATE_RESOURCE',
          'This idempotency key was already used for a different payment',
          { reason: 'IDEMPOTENCY_KEY_REUSED', payment_id: byKey.id },
        );
      if (!byRef || byRef.id === byKey.id) return { replay: byKey };
    }
    if (byRef) {
      // The same external transaction reported again is still one logical payment.
      if (!byKey && this.sameRequest(byRef, input)) return { replay: byRef };
      throw new ConflictError(
        'DUPLICATE_RESOURCE',
        'A payment with this provider reference has already been recorded',
        { reason: 'DUPLICATE_PROVIDER_REFERENCE', payment_id: byRef.id },
      );
    }
    return { replay: undefined };
  }

  /**
   * Record a payment. RECEIVED (default) issues a receipt at once; PENDING waits for `receive` or
   * `verify`. Retrying with the same idempotency_key (or provider_reference) and the same content
   * returns the same payment (`replayed: true`); a different content is 409.
   */
  async create(c: Caller, input: z.infer<typeof CreatePaymentBody>) {
    await ensureSettings(this.db, c.tenantId);
    if (input.allocation && input.status !== 'RECEIVED')
      throw validationIssue('allocation', 'Only a RECEIVED payment can be allocated');
    const now = this.deps.clock.now();
    const receivedAt = input.received_at ? new Date(input.received_at) : now;
    if (receivedAt.getTime() > now.getTime() + 5 * 60_000)
      throw validationIssue('received_at', 'The payment cannot be received in the future');

    const existing = await this.findExisting(c.tenantId, input);
    if (existing) {
      const r = this.resolveRetry(existing, input);
      if (r.replay) return { payment: await this.get(c, r.replay.id), replayed: true };
    }

    let id!: string;
    try {
      await withDeadlockRetry(() =>
        this.db.transaction(async (tx) => {
          const student = await loadStudent(
            tx,
            c.tenantId,
            input.student_id,
            c.principal,
            'fees.payments.create',
          );
          const settings = await readSettings(tx, c.tenantId, 'share');
          const tz = await schoolTimezone(tx, c.tenantId);
          const today = await schoolToday(tx, c.tenantId, this.deps.clock);
          // Demands first (in id order), the payment number and the receipt number last.
          let locked = new Map<string, DemandRow>();
          if (input.allocation) {
            const ids =
              input.allocation.mode === 'MANUAL'
                ? input.allocation.allocations.map((a) => a.fee_demand_id)
                : await this.candidateDemandIds(
                    tx,
                    c.tenantId,
                    student.id,
                    input.allocation.demand_ids,
                  );
            locked = await lockDemands(tx, c.tenantId, [...new Set(ids)]);
            if (input.allocation.mode === 'MANUAL')
              for (const did of ids) if (!locked.has(did)) throw new NotFoundError('Fee demand');
          }
          const number = await nextNumber(tx, c.tenantId, 'PAY', now);
          id = uuidv7();
          const received = input.status === 'RECEIVED';
          try {
            await tx.insert(schoolPayments).values({
              id,
              tenantId: c.tenantId,
              paymentNumber: number,
              studentId: student.id,
              payerType: input.payer_type,
              payerName: input.payer_name ?? null,
              payerReference: input.payer_reference ?? null,
              amount: input.amount,
              currency: settings.currency,
              method: input.method,
              status: received ? 'RECEIVED' : 'PENDING',
              provider: input.provider ?? null,
              providerReference: input.provider_reference ?? null,
              idempotencyKey: input.idempotency_key ?? null,
              notes: input.notes ?? null,
              receivedOn: dateInZone(tz, receivedAt),
              receivedAt: received ? receivedAt : null,
              recordedBy: c.actor.userId,
            });
          } catch (err) {
            if (isDuplicateKeyError(err)) throw new DuplicateRace();
            throw err;
          }
          const [p] = await tx.select().from(schoolPayments).where(eq(schoolPayments.id, id));
          await recordChange(tx, c.actor, c.tenantId, {
            action: received ? 'FEE_PAYMENT_RECEIVED' : 'FEE_PAYMENT_RECORDED',
            entityType: 'payment',
            entityId: id,
            event: received ? 'payment.received' : 'payment.initiated',
            after: presentPayment(p!),
            payload: {
              student_id: student.id,
              payment_number: number,
              amount: p!.amount,
              currency: p!.currency,
              method: p!.method,
            },
          });
          if (received) await this.issueReceipt(tx, c, p!, now);
          if (input.allocation)
            await this.allocateLocked(tx, c, p!, locked, input.allocation, {
              today,
              now,
              freshPayment: true,
            });
        }),
      );
    } catch (err) {
      if (err instanceof DuplicateRace) {
        // A concurrent request with the same key or reference won: resolve like a retry.
        const rows = (await this.findExisting(c.tenantId, input)) ?? [];
        const r = this.resolveRetry(rows, input);
        if (r.replay) return { payment: await this.get(c, r.replay.id), replayed: true };
        throw new ConflictError('DUPLICATE_RESOURCE', 'The payment was recorded at the same time', {
          reason: 'DUPLICATE_PAYMENT',
        });
      }
      throw err;
    }
    return { payment: await this.get(c, id), replayed: false };
  }

  // ---- lifecycle -----------------------------------------------------------------------------------------------

  /** PENDING → RECEIVED: the money is in. Issues the receipt. */
  async receive(c: Caller, id: string, version?: number) {
    await this.db.transaction(async (tx) => {
      const p = await loadPayment(
        tx,
        c.tenantId,
        id,
        c.principal,
        'fees.payments.create',
        'update',
      );
      if (staleVersion(p.version, version)) throw stale();
      if (p.status !== 'PENDING')
        throw businessRule('NOT_PENDING', 'Only a pending payment can be marked received', {
          payment_status: p.status,
        });
      const now = this.deps.clock.now();
      const tz = await schoolTimezone(tx, c.tenantId);
      await tx
        .update(schoolPayments)
        .set({
          status: 'RECEIVED',
          receivedAt: now,
          receivedOn: dateInZone(tz, now),
          version: p.version + 1,
        })
        .where(eq(schoolPayments.id, id));
      const fresh = { ...p, status: 'RECEIVED' as const };
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_PAYMENT_RECEIVED',
        entityType: 'payment',
        entityId: id,
        event: 'payment.received',
        before: { status: 'PENDING' },
        after: { status: 'RECEIVED' },
        payload: {
          student_id: p.studentId,
          payment_number: p.paymentNumber,
          amount: p.amount,
          currency: p.currency,
          method: p.method,
        },
      });
      await this.issueReceipt(tx, c, fresh, now);
    });
    return this.get(c, id);
  }

  /** PENDING / RECEIVED → VERIFIED. A payment that was still pending gets its receipt now. */
  async verify(c: Caller, id: string, note: string | undefined, version?: number) {
    await this.db.transaction(async (tx) => {
      const p = await loadPayment(
        tx,
        c.tenantId,
        id,
        c.principal,
        'fees.payments.verify',
        'update',
      );
      if (staleVersion(p.version, version)) throw stale();
      if (p.status !== 'PENDING' && p.status !== 'RECEIVED')
        throw businessRule('NOT_VERIFIABLE', 'Only a pending or received payment can be verified', {
          payment_status: p.status,
        });
      const now = this.deps.clock.now();
      const tz = await schoolTimezone(tx, c.tenantId);
      const wasPending = p.status === 'PENDING';
      await tx
        .update(schoolPayments)
        .set({
          status: 'VERIFIED',
          verifiedAt: now,
          verifiedBy: c.actor.userId,
          ...(wasPending ? { receivedAt: now, receivedOn: dateInZone(tz, now) } : {}),
          version: p.version + 1,
        })
        .where(eq(schoolPayments.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_PAYMENT_VERIFIED',
        entityType: 'payment',
        entityId: id,
        event: 'payment.verified',
        before: { status: p.status },
        after: { status: 'VERIFIED', verified_by: c.actor.userId },
        reason: note ?? null,
        payload: {
          student_id: p.studentId,
          payment_number: p.paymentNumber,
          amount: p.amount,
          currency: p.currency,
        },
      });
      const [any] = await tx
        .select({ id: feeReceipts.id })
        .from(feeReceipts)
        .where(and(eq(feeReceipts.tenantId, c.tenantId), eq(feeReceipts.paymentId, id)))
        .limit(1);
      if (!any) await this.issueReceipt(tx, c, { ...p, status: 'VERIFIED' }, now);
    });
    return this.get(c, id);
  }

  /** PENDING → FAILED (bounced cheque, declined transfer …). */
  async fail(c: Caller, id: string, reason: string) {
    await this.db.transaction(async (tx) => {
      const p = await loadPayment(
        tx,
        c.tenantId,
        id,
        c.principal,
        'fees.payments.verify',
        'update',
      );
      if (p.status !== 'PENDING')
        throw businessRule('NOT_PENDING', 'Only a pending payment can be marked failed', {
          payment_status: p.status,
        });
      await tx
        .update(schoolPayments)
        .set({ status: 'FAILED', failedReason: reason, version: p.version + 1 })
        .where(eq(schoolPayments.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_PAYMENT_FAILED',
        entityType: 'payment',
        entityId: id,
        event: 'payment.failed',
        before: { status: 'PENDING' },
        after: { status: 'FAILED' },
        reason,
        payload: { student_id: p.studentId, payment_number: p.paymentNumber },
      });
    });
    return this.get(c, id);
  }

  /**
   * Void a payment (recorded in error): every allocation is reversed (demands re-open), the receipt is
   * voided, the payment stays as CANCELLED history. Not possible once money has been refunded or a
   * refund is in flight.
   */
  async cancel(c: Caller, id: string, reason: string) {
    await withDeadlockRetry(() =>
      this.db.transaction(async (tx) => {
        const p = await loadPayment(
          tx,
          c.tenantId,
          id,
          c.principal,
          'fees.payments.verify',
          'update',
        );
        if (!['PENDING', 'RECEIVED', 'VERIFIED'].includes(p.status))
          throw businessRule('NOT_CANCELLABLE', 'This payment cannot be cancelled', {
            payment_status: p.status,
          });
        if (toMinor(p.refundedAmount) > 0n)
          throw businessRule('HAS_REFUNDS', 'A refunded payment cannot be cancelled', {
            refunded_amount: p.refundedAmount,
          });
        if ((await this.openRefundTotal(tx, c.tenantId, id, true)) > 0n)
          throw businessRule('REFUND_IN_PROGRESS', 'Finish or cancel the open refund first');
        const allocs = await tx
          .select()
          .from(paymentAllocations)
          .where(
            and(eq(paymentAllocations.tenantId, c.tenantId), eq(paymentAllocations.paymentId, id)),
          )
          .orderBy(asc(paymentAllocations.id))
          .for('update');
        const today = await schoolToday(tx, c.tenantId, this.deps.clock);
        const now = this.deps.clock.now();
        const reversals = allocs
          .filter((a) => netOf(a) > 0n)
          .map((a) => ({ allocation: a, amount: netOf(a) }));
        const reversed = await this.reverseLocked(tx, c, p, reversals, {
          reason: `Payment cancelled: ${reason}`.slice(0, 500),
          today,
          now,
        });
        await tx
          .update(feeReceipts)
          .set({
            status: 'VOID',
            voidedAt: now,
            voidedBy: c.actor.userId,
            voidReason: `Payment cancelled: ${reason}`.slice(0, 500),
          })
          .where(
            and(
              eq(feeReceipts.tenantId, c.tenantId),
              eq(feeReceipts.paymentId, id),
              eq(feeReceipts.status, 'ISSUED'),
            ),
          );
        await tx
          .update(schoolPayments)
          .set({
            status: 'CANCELLED',
            cancelledAt: now,
            cancelledBy: c.actor.userId,
            cancelReason: reason,
            // reverseLocked already advanced the version when it changed the payment
            version: reversals.length ? p.version : p.version + 1,
          })
          .where(eq(schoolPayments.id, id));
        await recordChange(tx, c.actor, c.tenantId, {
          action: 'FEE_PAYMENT_CANCELLED',
          entityType: 'payment',
          entityId: id,
          event: 'payment.cancelled',
          before: { status: p.status, allocated_amount: p.allocatedAmount },
          after: { status: 'CANCELLED', reversed },
          reason,
          payload: {
            student_id: p.studentId,
            payment_number: p.paymentNumber,
            amount: p.amount,
            currency: p.currency,
            reversed,
          },
        });
      }),
    );
    return this.get(c, id);
  }
}
