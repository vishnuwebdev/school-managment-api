import { and, asc, count, desc, eq, inArray, like, or, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  ALLOCATABLE_PAYMENT_STATUSES,
  feeRefunds,
  OPEN_REFUND_STATUSES,
  paymentAllocations,
  refundAllocations,
  schoolPayments,
  students,
} from '../../db/schema/index.js';
import { recordChange } from '../../platform/record.js';
import { AuthorizationError, ConflictError, NotFoundError } from '../../shared/errors.js';
import { offsetOf, orderFrom, pageOf } from '../../shared/pagination.js';
import type {
  CompleteRefundBody,
  CreateRefundBody,
  DecisionBody,
  RefundListQuery,
} from './fees.schemas.js';
import { fromMinor, minBig, toMinor } from './money.js';
import type { PaymentService, Reversal } from './payments.service.js';
import {
  businessRule,
  dateInZone,
  feeScope,
  likeOf,
  loadPayment,
  nextNumber,
  presentRefund,
  schoolTimezone,
  schoolToday,
  separationOfDuties,
  staleVersion,
  studentMinis,
  withDeadlockRetry,
  type Caller,
  type RefundRow,
} from './support.js';

const stale = () => new ConflictError('CONFLICT', undefined, { reason: 'STALE_VERSION' });

/**
 * Refunds: REQUESTED → APPROVED (someone other than the requester) → PROCESSING → COMPLETED, or
 * FAILED / CANCELLED. The payment is never deleted. A request reserves part of the payment; when the
 * refund COMPLETES its amount is taken first from the payment's unallocated balance and the rest from
 * allocations, newest first, which re-opens the balances of the demands they had paid.
 *
 * Lock order: payment → refund (complete) ; refund only (approve, reject, cancel, process, fail).
 */
export class RefundService {
  constructor(
    private readonly deps: Deps,
    private readonly payments: PaymentService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  private async load(
    ex: Executor,
    c: Caller,
    id: string,
    permission: string,
    lock?: 'update',
  ): Promise<RefundRow> {
    const q = ex
      .select()
      .from(feeRefunds)
      .where(
        and(
          eq(feeRefunds.id, id),
          eq(feeRefunds.tenantId, c.tenantId),
          feeScope(c.principal, permission, feeRefunds),
        ),
      );
    const [row] = await (lock ? q.for(lock) : q);
    if (!row) throw new NotFoundError('Refund');
    return row;
  }

  private async decorate(ex: Executor, tenantId: string, rows: RefundRow[]) {
    if (!rows.length) return [];
    const minis = await studentMinis(
      ex,
      tenantId,
      rows.map((r) => r.studentId),
    );
    const pays = await ex
      .select({ id: schoolPayments.id, n: schoolPayments.paymentNumber })
      .from(schoolPayments)
      .where(
        and(
          eq(schoolPayments.tenantId, tenantId),
          inArray(schoolPayments.id, [...new Set(rows.map((r) => r.paymentId))]),
        ),
      );
    const pm = new Map(pays.map((p) => [p.id, p.n]));
    return rows.map((r) =>
      presentRefund(r, { student: minis.get(r.studentId), paymentNumber: pm.get(r.paymentId) }),
    );
  }

  async list(c: Caller, q: z.infer<typeof RefundListQuery>) {
    const r = feeRefunds;
    const where: SQL | undefined = and(
      eq(r.tenantId, c.tenantId),
      feeScope(c.principal, 'fees.read', r),
      q.status ? eq(r.status, q.status) : undefined,
      q.student_id ? eq(r.studentId, q.student_id) : undefined,
      q.payment_id ? eq(r.paymentId, q.payment_id) : undefined,
      q.search
        ? or(
            like(r.refundNumber, likeOf(q.search)),
            like(students.studentNumber, likeOf(q.search)),
            like(students.firstName, likeOf(q.search)),
            like(students.lastName, likeOf(q.search)),
          )
        : undefined,
    );
    const order = orderFrom(q, { requested_at: r.requestedAt, amount: r.amount }, 'requested_at');
    const [rows, [total]] = await Promise.all([
      this.db
        .select({ r })
        .from(r)
        .innerJoin(students, and(eq(students.tenantId, r.tenantId), eq(students.id, r.studentId)))
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
      await this.decorate(
        this.db,
        c.tenantId,
        rows.map((x) => x.r),
      ),
      total?.n ?? 0,
      q,
    );
  }

  async get(c: Caller, id: string, ex: Executor = this.db) {
    const row = await this.load(ex, c, id, 'fees.read');
    const [view] = await this.decorate(ex, c.tenantId, [row]);
    const reversals = await ex
      .select({ ra: refundAllocations, a: paymentAllocations })
      .from(refundAllocations)
      .innerJoin(
        paymentAllocations,
        and(
          eq(paymentAllocations.tenantId, refundAllocations.tenantId),
          eq(paymentAllocations.id, refundAllocations.paymentAllocationId),
        ),
      )
      .where(and(eq(refundAllocations.tenantId, c.tenantId), eq(refundAllocations.refundId, id)))
      .orderBy(asc(refundAllocations.createdAt), asc(refundAllocations.id));
    return {
      ...view!,
      reversed_allocations: reversals.map((x) => ({
        allocation_id: x.a.id,
        fee_demand_id: x.a.feeDemandId,
        amount: x.ra.amount,
      })),
    };
  }

  // ---- request ---------------------------------------------------------------------------------------

  async request(c: Caller, input: z.infer<typeof CreateRefundBody>) {
    let id!: string;
    await withDeadlockRetry(() =>
      this.db.transaction(async (tx) => {
        const p = await loadPayment(
          tx,
          c.tenantId,
          input.payment_id,
          c.principal,
          'fees.refunds.request',
          'update',
        );
        if (!(ALLOCATABLE_PAYMENT_STATUSES as readonly string[]).includes(p.status))
          throw businessRule(
            'PAYMENT_NOT_REFUNDABLE',
            'Only money that has been received can be refunded',
            { payment_status: p.status },
            'OPERATION_NOT_ALLOWED',
          );
        const open = await tx
          .select({ amount: feeRefunds.amount })
          .from(feeRefunds)
          .where(
            and(
              eq(feeRefunds.tenantId, c.tenantId),
              eq(feeRefunds.paymentId, p.id),
              inArray(feeRefunds.status, [...OPEN_REFUND_STATUSES]),
            ),
          )
          .for('share');
        const reserved = open.reduce((a, r) => a + toMinor(r.amount), 0n);
        const refundable = toMinor(p.amount) - toMinor(p.refundedAmount) - reserved;
        const amount = toMinor(input.amount);
        if (amount > refundable)
          throw businessRule(
            'EXCEEDS_REFUNDABLE',
            'The refund is more than what is left to refund on this payment',
            {
              refundable_amount: fromMinor(refundable > 0n ? refundable : 0n),
              requested_amount: input.amount,
            },
            'OPERATION_NOT_ALLOWED',
          );
        const now = this.deps.clock.now();
        const tz = await schoolTimezone(tx, c.tenantId);
        const number = await nextNumber(tx, c.tenantId, 'RFD', now);
        id = uuidv7();
        await tx.insert(feeRefunds).values({
          id,
          tenantId: c.tenantId,
          refundNumber: number,
          paymentId: p.id,
          studentId: p.studentId,
          amount: input.amount,
          currency: p.currency,
          reason: input.reason,
          status: 'REQUESTED',
          requestedOn: dateInZone(tz, now),
          requestedBy: c.actor.userId,
          requestedAt: now,
        });
        await recordChange(tx, c.actor, c.tenantId, {
          action: 'FEE_REFUND_REQUESTED',
          entityType: 'fee_refund',
          entityId: id,
          event: 'refund.created',
          after: { refund_number: number, payment_id: p.id, amount: input.amount },
          reason: input.reason,
          payload: {
            student_id: p.studentId,
            payment_id: p.id,
            payment_number: p.paymentNumber,
            refund_number: number,
            amount: input.amount,
            currency: p.currency,
          },
        });
      }),
    );
    return this.get(c, id);
  }

  // ---- decisions and steps ------------------------------------------------------------------------------

  private async step(
    c: Caller,
    id: string,
    permission: string,
    from: RefundRow['status'][],
    to: RefundRow['status'],
    o: {
      action: string;
      event: string;
      set?: (r: RefundRow, now: Date) => Partial<typeof feeRefunds.$inferInsert>;
      reason?: string | null;
      guard?: (r: RefundRow) => void;
      version?: number;
    },
  ) {
    await this.db.transaction(async (tx) => {
      const r = await this.load(tx, c, id, permission, 'update');
      if (staleVersion(r.version, o.version)) throw stale();
      if (!from.includes(r.status))
        throw businessRule(
          'INVALID_REFUND_STATE',
          `A refund that is ${r.status} cannot move to ${to}`,
          { refund_status: r.status, allowed_from: from },
        );
      o.guard?.(r);
      const now = this.deps.clock.now();
      await tx
        .update(feeRefunds)
        .set({ status: to, ...(o.set?.(r, now) ?? {}), version: r.version + 1 })
        .where(eq(feeRefunds.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: o.action,
        entityType: 'fee_refund',
        entityId: id,
        event: o.event,
        before: { status: r.status },
        after: { status: to },
        reason: o.reason ?? null,
        payload: {
          student_id: r.studentId,
          payment_id: r.paymentId,
          refund_number: r.refundNumber,
          amount: r.amount,
          currency: r.currency,
        },
      });
    });
    return this.get(c, id);
  }

  approve(c: Caller, id: string, input: z.infer<typeof DecisionBody>, version?: number) {
    return this.step(c, id, 'fees.refunds.approve', ['REQUESTED'], 'APPROVED', {
      action: 'FEE_REFUND_APPROVED',
      event: 'refund.approved',
      reason: input.note ?? null,
      version,
      guard: (r) => {
        if (r.requestedBy !== null && r.requestedBy === c.actor.userId)
          throw separationOfDuties('A refund must be approved');
      },
      set: (_r, now) => ({ approvedBy: c.actor.userId, approvedAt: now }),
    });
  }

  /** The approver declines a request: it ends as CANCELLED with the reason. */
  reject(c: Caller, id: string, reason: string) {
    return this.step(c, id, 'fees.refunds.approve', ['REQUESTED'], 'CANCELLED', {
      action: 'FEE_REFUND_REJECTED',
      event: 'refund.cancelled',
      reason,
      set: (_r, now) => ({ cancelledAt: now, cancelledBy: c.actor.userId, cancelReason: reason }),
    });
  }

  /** The requester (or an approver) withdraws a refund that has not started processing. */
  cancel(c: Caller, id: string, reason: string) {
    return this.step(c, id, 'fees.read', ['REQUESTED', 'APPROVED'], 'CANCELLED', {
      action: 'FEE_REFUND_CANCELLED',
      event: 'refund.cancelled',
      reason,
      guard: (r) => {
        const isRequester = r.requestedBy !== null && r.requestedBy === c.actor.userId;
        if (
          !isRequester &&
          !c.principal.permissions.has('fees.refunds.approve') &&
          !c.principal.permissions.has('fees.refunds.request')
        )
          throw new AuthorizationError('PERMISSION_DENIED', undefined, {
            permission: 'fees.refunds.approve',
          });
      },
      set: (_r, now) => ({ cancelledAt: now, cancelledBy: c.actor.userId, cancelReason: reason }),
    });
  }

  startProcessing(c: Caller, id: string) {
    return this.step(c, id, 'fees.refunds.approve', ['APPROVED'], 'PROCESSING', {
      action: 'FEE_REFUND_PROCESSING',
      event: 'refund.processing',
      set: (_r, now) => ({ processingAt: now, processingBy: c.actor.userId }),
    });
  }

  fail(c: Caller, id: string, reason: string) {
    return this.step(c, id, 'fees.refunds.approve', ['APPROVED', 'PROCESSING'], 'FAILED', {
      action: 'FEE_REFUND_FAILED',
      event: 'refund.failed',
      reason,
      set: (_r, now) => ({ failedAt: now, failedReason: reason }),
    });
  }

  /**
   * PROCESSING → COMPLETED: the money went back. Under the payment lock the refund is taken from the
   * unallocated balance first, then from allocations (newest first); reversed allocations re-open their
   * demands; the payment becomes PARTIALLY_REFUNDED or REFUNDED. The payment itself is never deleted.
   */
  async complete(c: Caller, id: string, input: z.infer<typeof CompleteRefundBody>) {
    // Find the payment first (unlocked), so the payment lock is taken before the refund lock.
    const peek = await this.load(this.db, c, id, 'fees.refunds.approve');
    await withDeadlockRetry(() =>
      this.db.transaction(async (tx) => {
        const p = await loadPayment(
          tx,
          c.tenantId,
          peek.paymentId,
          c.principal,
          'fees.refunds.approve',
          'update',
        );
        const r = await this.load(tx, c, id, 'fees.refunds.approve', 'update');
        if (r.status !== 'PROCESSING')
          throw businessRule(
            'INVALID_REFUND_STATE',
            'Only a refund that is processing can be completed',
            {
              refund_status: r.status,
              allowed_from: ['PROCESSING'],
            },
          );
        const amount = toMinor(r.amount);
        const paid = toMinor(p.amount);
        const refunded = toMinor(p.refundedAmount);
        const allocated = toMinor(p.allocatedAmount);
        if (refunded + amount > paid)
          throw businessRule('EXCEEDS_REFUNDABLE', 'The payment no longer has that much to refund');
        const unallocated = paid - refunded - allocated;
        const fromUnallocated = minBig(amount, unallocated > 0n ? unallocated : 0n);
        let toReverse = amount - fromUnallocated;
        const allocs = await tx
          .select()
          .from(paymentAllocations)
          .where(
            and(
              eq(paymentAllocations.tenantId, c.tenantId),
              eq(paymentAllocations.paymentId, p.id),
            ),
          )
          .orderBy(desc(paymentAllocations.createdAt), desc(paymentAllocations.id))
          .for('update');
        const reversals: Reversal[] = [];
        for (const a of allocs) {
          if (toReverse <= 0n) break;
          const net = toMinor(a.allocatedAmount) - toMinor(a.reversedAmount);
          if (net <= 0n) continue;
          const take = minBig(net, toReverse);
          reversals.push({ allocation: a, amount: take });
          toReverse -= take;
        }
        if (toReverse > 0n)
          throw businessRule(
            'ALLOCATIONS_INSUFFICIENT',
            'The payment’s allocations do not cover the refund. This should not happen.',
          );
        const today = await schoolToday(tx, c.tenantId, this.deps.clock);
        const now = this.deps.clock.now();
        const reversed = await this.payments.reverseLocked(tx, c, p, reversals, {
          reason: `Refund ${r.refundNumber}`,
          today,
          now,
        });
        for (const rev of reversals)
          await tx.insert(refundAllocations).values({
            id: uuidv7(),
            tenantId: c.tenantId,
            refundId: r.id,
            paymentAllocationId: rev.allocation.id,
            amount: fromMinor(rev.amount),
          });
        const newRefunded = refunded + amount;
        await tx
          .update(schoolPayments)
          .set({
            refundedAmount: fromMinor(newRefunded),
            status: newRefunded === paid ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
            // reverseLocked already advanced the version when it changed the payment
            version: reversals.length ? p.version : p.version + 1,
          })
          .where(eq(schoolPayments.id, p.id));
        await tx
          .update(feeRefunds)
          .set({
            status: 'COMPLETED',
            completedAt: now,
            completedBy: c.actor.userId,
            fromUnallocated: fromMinor(fromUnallocated),
            ...(input.provider_reference ? { providerReference: input.provider_reference } : {}),
            version: r.version + 1,
          })
          .where(eq(feeRefunds.id, id));
        await recordChange(tx, c.actor, c.tenantId, {
          action: 'FEE_REFUND_COMPLETED',
          entityType: 'fee_refund',
          entityId: id,
          event: 'refund.completed',
          before: { status: 'PROCESSING', payment_status: p.status },
          after: {
            status: 'COMPLETED',
            payment_status: newRefunded === paid ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
            from_unallocated: fromMinor(fromUnallocated),
            reversed,
          },
          payload: {
            student_id: r.studentId,
            payment_id: r.paymentId,
            refund_number: r.refundNumber,
            amount: r.amount,
            currency: r.currency,
            from_unallocated: fromMinor(fromUnallocated),
            reversed,
          },
        });
      }),
    );
    return this.get(c, id);
  }
}
