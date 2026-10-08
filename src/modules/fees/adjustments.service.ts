import { and, asc, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import { feeAdjustments, feeDemands } from '../../db/schema/index.js';
import { recordChange } from '../../platform/record.js';
import { AuthorizationError, ConflictError, NotFoundError } from '../../shared/errors.js';
import { offsetOf, orderFrom, pageOf } from '../../shared/pagination.js';
import { ADJUSTABLE, reduceDemand } from './demands.service.js';
import type { AdjustmentListQuery, CreateAdjustmentBody, DecisionBody } from './fees.schemas.js';
import { applyBp, fromMinor, percentToBp, toMinor } from './money.js';
import {
  businessRule,
  dateInZone,
  feeScope,
  loadDemand,
  moneyOf,
  outstandingOfMoney,
  presentAdjustment,
  schoolTimezone,
  schoolToday,
  separationOfDuties,
  staleVersion,
  studentMinis,
  type AdjustmentRow,
  type Caller,
  type DemandRow,
} from './support.js';

const stale = () => new ConflictError('CONFLICT', undefined, { reason: 'STALE_VERSION' });

/** What a request is worth against a demand's original amount. */
function amountOf(a: Pick<AdjustmentRow, 'valueType' | 'value'>, d: DemandRow): bigint {
  return a.valueType === 'AMOUNT'
    ? toMinor(a.value)
    : applyBp(moneyOf(d).original, percentToBp(a.value));
}

/**
 * Concessions and waivers: request → approve → apply. The approver must be a different person than
 * the requester (separation of duties), and applying is a third, separate command needing fees.manage.
 * Applying deducts from the demand under its row lock and can never exceed the outstanding balance.
 *
 * Lock order: adjustment → demand.
 */
export class AdjustmentService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  private async load(
    ex: Executor,
    c: Caller,
    id: string,
    permission: string,
    lock?: 'update' | 'share',
  ): Promise<AdjustmentRow> {
    const q = ex
      .select()
      .from(feeAdjustments)
      .where(
        and(
          eq(feeAdjustments.id, id),
          eq(feeAdjustments.tenantId, c.tenantId),
          feeScope(c.principal, permission, feeAdjustments),
        ),
      );
    const [row] = await (lock ? q.for(lock) : q);
    if (!row) throw new NotFoundError('Fee adjustment');
    return row;
  }

  private async decorate(ex: Executor, tenantId: string, rows: AdjustmentRow[]) {
    if (!rows.length) return [];
    const minis = await studentMinis(
      ex,
      tenantId,
      rows.map((r) => r.studentId),
    );
    const found = await ex
      .select({ id: feeDemands.id, n: feeDemands.demandNumber })
      .from(feeDemands)
      .where(
        and(
          eq(feeDemands.tenantId, tenantId),
          inArray(feeDemands.id, [...new Set(rows.map((r) => r.feeDemandId))]),
        ),
      );
    const numbers = new Map(found.map((d) => [d.id, d.n]));
    return rows.map((r) =>
      presentAdjustment(r, {
        student: minis.get(r.studentId),
        demandNumber: numbers.get(r.feeDemandId),
      }),
    );
  }

  async list(c: Caller, q: z.infer<typeof AdjustmentListQuery>) {
    const a = feeAdjustments;
    const where: SQL | undefined = and(
      eq(a.tenantId, c.tenantId),
      feeScope(c.principal, 'fees.read', a),
      q.type ? eq(a.type, q.type) : undefined,
      q.status ? eq(a.status, q.status) : undefined,
      q.student_id ? eq(a.studentId, q.student_id) : undefined,
      q.fee_demand_id ? eq(a.feeDemandId, q.fee_demand_id) : undefined,
    );
    const order = orderFrom(
      q,
      { requested_at: a.requestedAt, created_at: a.createdAt },
      'requested_at',
    );
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(a)
        .where(where)
        .orderBy(order, q.order === 'asc' ? asc(a.id) : desc(a.id))
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(a).where(where),
    ]);
    return pageOf(await this.decorate(this.db, c.tenantId, rows), total?.n ?? 0, q);
  }

  async get(c: Caller, id: string, ex: Executor = this.db) {
    const row = await this.load(ex, c, id, 'fees.read');
    return (await this.decorate(ex, c.tenantId, [row]))[0]!;
  }

  // ---- request -------------------------------------------------------------------------------------

  async request(c: Caller, input: z.infer<typeof CreateAdjustmentBody>) {
    let id!: string;
    await this.db.transaction(async (tx) => {
      const d = await loadDemand(
        tx,
        c.tenantId,
        input.fee_demand_id,
        c.principal,
        'fees.concessions.request',
        'share',
      );
      if (!(ADJUSTABLE as readonly string[]).includes(d.status))
        throw businessRule('DEMAND_NOT_ADJUSTABLE', 'This demand can no longer be adjusted', {
          demand_status: d.status,
        });
      const amount = amountOf({ valueType: input.value_type, value: input.value }, d);
      const out = outstandingOfMoney(moneyOf(d));
      if (amount <= 0n)
        throw businessRule(
          'ZERO_AMOUNT',
          'The request works out to nothing',
          {},
          'OPERATION_NOT_ALLOWED',
        );
      if (amount > out)
        throw businessRule(
          'EXCEEDS_OUTSTANDING',
          'The request is more than the outstanding balance of the demand',
          { outstanding_amount: fromMinor(out), requested_amount: fromMinor(amount) },
          'OPERATION_NOT_ALLOWED',
        );
      const now = this.deps.clock.now();
      const tz = await schoolTimezone(tx, c.tenantId);
      id = uuidv7();
      await tx.insert(feeAdjustments).values({
        id,
        tenantId: c.tenantId,
        type: input.type,
        studentId: d.studentId,
        feeDemandId: d.id,
        valueType: input.value_type,
        value: input.value,
        currency: d.currency,
        reason: input.reason,
        status: 'REQUESTED',
        requestedOn: dateInZone(tz, now),
        requestedBy: c.actor.userId,
        requestedAt: now,
      });
      await recordChange(tx, c.actor, c.tenantId, {
        action: `FEE_${input.type}_REQUESTED`,
        entityType: 'fee_adjustment',
        entityId: id,
        event: 'fee_adjustment.requested',
        after: {
          type: input.type,
          fee_demand_id: d.id,
          value_type: input.value_type,
          value: input.value,
          amount: fromMinor(amount),
        },
        reason: input.reason,
        payload: {
          type: input.type,
          student_id: d.studentId,
          fee_demand_id: d.id,
          amount: fromMinor(amount),
          currency: d.currency,
        },
      });
    });
    return this.get(c, id);
  }

  // ---- decisions --------------------------------------------------------------------------------------

  async approve(c: Caller, id: string, input: z.infer<typeof DecisionBody>, version?: number) {
    await this.db.transaction(async (tx) => {
      const a = await this.load(tx, c, id, 'fees.waivers.approve', 'update');
      if (staleVersion(a.version, version)) throw stale();
      if (a.status !== 'REQUESTED')
        throw businessRule('NOT_REQUESTED', 'Only a requested adjustment can be approved', {
          adjustment_status: a.status,
        });
      if (a.requestedBy !== null && a.requestedBy === c.actor.userId)
        throw separationOfDuties('A concession or waiver must be approved');
      const now = this.deps.clock.now();
      await tx
        .update(feeAdjustments)
        .set({
          status: 'APPROVED',
          approvedBy: c.actor.userId,
          approvedAt: now,
          decisionNote: input.note ?? null,
          version: a.version + 1,
        })
        .where(eq(feeAdjustments.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: `FEE_${a.type}_APPROVED`,
        entityType: 'fee_adjustment',
        entityId: id,
        event: a.type === 'CONCESSION' ? 'concession.approved' : 'waiver.approved',
        before: { status: 'REQUESTED' },
        after: { status: 'APPROVED', approved_by: c.actor.userId },
        reason: input.note ?? null,
        payload: {
          type: a.type,
          student_id: a.studentId,
          fee_demand_id: a.feeDemandId,
          requested_by: a.requestedBy,
        },
      });
    });
    return this.get(c, id);
  }

  async reject(c: Caller, id: string, reason: string) {
    await this.db.transaction(async (tx) => {
      const a = await this.load(tx, c, id, 'fees.waivers.approve', 'update');
      if (a.status !== 'REQUESTED')
        throw businessRule('NOT_REQUESTED', 'Only a requested adjustment can be rejected', {
          adjustment_status: a.status,
        });
      await tx
        .update(feeAdjustments)
        .set({
          status: 'REJECTED',
          rejectedBy: c.actor.userId,
          rejectedAt: this.deps.clock.now(),
          decisionNote: reason,
          version: a.version + 1,
        })
        .where(eq(feeAdjustments.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: `FEE_${a.type}_REJECTED`,
        entityType: 'fee_adjustment',
        entityId: id,
        event: 'fee_adjustment.rejected',
        before: { status: 'REQUESTED' },
        after: { status: 'REJECTED' },
        reason,
        payload: { type: a.type, student_id: a.studentId, fee_demand_id: a.feeDemandId },
      });
    });
    return this.get(c, id);
  }

  /** Requester, an approver, or a fee manager may withdraw a request that has not been applied. */
  async cancel(c: Caller, id: string, reason: string) {
    await this.db.transaction(async (tx) => {
      const a = await this.load(tx, c, id, 'fees.read', 'update');
      const isRequester = a.requestedBy !== null && a.requestedBy === c.actor.userId;
      if (
        !isRequester &&
        !c.principal.permissions.has('fees.waivers.approve') &&
        !c.principal.permissions.has('fees.manage')
      )
        throw new AuthorizationError('PERMISSION_DENIED', undefined, {
          permission: 'fees.waivers.approve',
        });
      if (a.status !== 'REQUESTED' && a.status !== 'APPROVED')
        throw businessRule(
          'NOT_CANCELLABLE',
          'Only a requested or approved adjustment can be cancelled',
          {
            adjustment_status: a.status,
          },
        );
      await tx
        .update(feeAdjustments)
        .set({
          status: 'CANCELLED',
          cancelledBy: c.actor.userId,
          cancelledAt: this.deps.clock.now(),
          cancelReason: reason,
          version: a.version + 1,
        })
        .where(eq(feeAdjustments.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: `FEE_${a.type}_CANCELLED`,
        entityType: 'fee_adjustment',
        entityId: id,
        event: 'fee_adjustment.cancelled',
        before: { status: a.status },
        after: { status: 'CANCELLED' },
        reason,
        payload: { type: a.type, student_id: a.studentId, fee_demand_id: a.feeDemandId },
      });
    });
    return this.get(c, id);
  }

  /** APPROVED → APPLIED: deduct from the demand (concession_amount / waiver_amount) under its row lock. */
  async apply(c: Caller, id: string, version?: number) {
    await this.db.transaction(async (tx) => {
      const a = await this.load(tx, c, id, 'fees.waivers.approve', 'update');
      if (staleVersion(a.version, version)) throw stale();
      if (a.status !== 'APPROVED')
        throw businessRule('NOT_APPROVED', 'Only an approved adjustment can be applied', {
          adjustment_status: a.status,
        });
      const d = await loadDemand(
        tx,
        c.tenantId,
        a.feeDemandId,
        c.principal,
        'fees.waivers.approve',
        'update',
      );
      const amount = amountOf(a, d);
      const today = await schoolToday(tx, c.tenantId, this.deps.clock);
      const now = this.deps.clock.now();
      const { row } = await reduceDemand(
        tx,
        d,
        a.type === 'CONCESSION' ? 'concession' : 'waiver',
        amount,
        { today, now },
      );
      await tx
        .update(feeAdjustments)
        .set({
          status: 'APPLIED',
          appliedAmount: fromMinor(amount),
          appliedBy: c.actor.userId,
          appliedAt: now,
          version: a.version + 1,
        })
        .where(eq(feeAdjustments.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: `FEE_${a.type}_APPLIED`,
        entityType: 'fee_adjustment',
        entityId: id,
        event: 'fee_adjustment.applied',
        before: { status: 'APPROVED', demand_final_amount: d.finalAmount },
        after: {
          status: 'APPLIED',
          applied_amount: fromMinor(amount),
          demand_final_amount: row.finalAmount,
          demand_status: row.status,
        },
        payload: {
          type: a.type,
          student_id: a.studentId,
          fee_demand_id: a.feeDemandId,
          applied_amount: fromMinor(amount),
          currency: a.currency,
        },
      });
    });
    return this.get(c, id);
  }
}
