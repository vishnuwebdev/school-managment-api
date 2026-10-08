import { createHash } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  bankStatementLines,
  bankStatements,
  schoolPayments,
  students,
} from '../../db/schema/index.js';
import { recordChange } from '../../platform/record.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import { offsetOf, pageOf } from '../../shared/pagination.js';
import { parseBankStatement } from './bank-csv.js';
import type {
  BankLineListQuery,
  ConfirmLineBody,
  IgnoreLineBody,
  RecordLineBody,
  UnconfirmedPaymentsQuery,
} from './collections.schemas.js';
import { fromMinor, toMinor } from './money.js';
import type { PaymentService } from './payments.service.js';
import { businessRule, likeOf, requireWide, studentMini, type Caller } from './support.js';

type LineRow = typeof bankStatementLines.$inferSelect;
const CONFIRMABLE = ['RECEIVED', 'VERIFIED'] as const;
const PERMISSION = 'fees.reconcile';
const norm = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const iso = (d: Date | null) => d?.toISOString() ?? null;

/**
 * Bank reconciliation. The portal never moves money, so a recorded payment stays "unconfirmed"
 * until a bank statement line is tied to it. Matching is deliberately conservative: only an
 * identical reference AND amount is matched automatically; everything else waits for a person.
 */
export class ReconciliationService {
  constructor(
    private readonly deps: Deps,
    private readonly payments: PaymentService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  // ---- import ----------------------------------------------------------------------------------

  async importStatement(c: Caller, input: { text: string; filename?: string }) {
    requireWide(c.principal, PERMISSION);
    const parsed = parseBankStatement(input.text);
    if (!parsed.rows.length)
      throw new ValidationError('The statement has no money-in lines', {
        location: 'body',
        issues: [
          {
            path: 'file',
            code: 'custom',
            message: `No credit lines found${parsed.skippedDebits ? ` (${parsed.skippedDebits} debit lines were skipped)` : ''}.`,
          },
        ],
      });
    const seen = new Map<string, number>();
    const hashed = parsed.rows.map((r) => {
      const key = [r.date, r.amount, norm(r.reference), r.description.toLowerCase()].join('|');
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return { ...r, hash: createHash('sha256').update(`${key}#${n}`).digest('hex') };
    });
    const result = await this.db.transaction(async (tx) => {
      const existing = new Set<string>();
      for (let i = 0; i < hashed.length; i += 500) {
        const rows = await tx
          .select({ h: bankStatementLines.lineHash })
          .from(bankStatementLines)
          .where(
            and(
              eq(bankStatementLines.tenantId, c.tenantId),
              inArray(
                bankStatementLines.lineHash,
                hashed.slice(i, i + 500).map((r) => r.hash),
              ),
            ),
          );
        rows.forEach((r) => existing.add(r.h));
      }
      const fresh = hashed.filter((r) => !existing.has(r.hash));
      if (!fresh.length)
        return {
          statementId: null,
          fresh: 0,
          duplicates: hashed.length,
          matching: await this.runMatching(tx, c.tenantId),
        };
      const dates = hashed.map((r) => r.date).sort();
      const statementId = uuidv7();
      await tx.insert(bankStatements).values({
        id: statementId,
        tenantId: c.tenantId,
        fileName: (input.filename ?? 'statement.csv').slice(0, 255),
        statementFrom: dates[0] ?? null,
        statementTo: dates[dates.length - 1] ?? null,
        lineCount: fresh.length,
        duplicateCount: hashed.length - fresh.length,
        importedBy: c.actor.userId,
      });
      for (let i = 0; i < fresh.length; i += 200) {
        await tx.insert(bankStatementLines).values(
          fresh.slice(i, i + 200).map((r) => ({
            id: uuidv7(),
            tenantId: c.tenantId,
            statementId,
            lineDate: r.date,
            description: r.description,
            reference: r.reference,
            amount: r.amount,
            lineHash: r.hash,
          })),
        );
      }
      const matching = await this.runMatching(tx, c.tenantId);
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_STATEMENT_IMPORTED',
        entityType: 'bank_statement',
        entityId: statementId,
        after: {
          file_name: input.filename ?? null,
          imported: fresh.length,
          duplicates: hashed.length - fresh.length,
          ...matching,
        },
      });
      return {
        statementId,
        fresh: fresh.length,
        duplicates: hashed.length - fresh.length,
        matching,
      };
    });
    return {
      statement_id: result.statementId,
      imported: result.fresh,
      duplicates_skipped: result.duplicates,
      debits_skipped: parsed.skippedDebits,
      rejected: parsed.rejected.slice(0, 20),
      rejected_count: parsed.rejected.length,
      ...result.matching,
    };
  }

  /** (Re)matches every line that is not MATCHED or IGNORED against payments not yet confirmed. */
  private async runMatching(tx: Executor, tenantId: string) {
    const lines = await tx
      .select()
      .from(bankStatementLines)
      .where(
        and(
          eq(bankStatementLines.tenantId, tenantId),
          inArray(bankStatementLines.status, ['UNMATCHED', 'SUGGESTED']),
        ),
      )
      .orderBy(asc(bankStatementLines.lineDate), asc(bankStatementLines.id))
      .for('update');
    const free = await tx
      .select({ p: schoolPayments })
      .from(schoolPayments)
      .leftJoin(
        bankStatementLines,
        and(
          eq(bankStatementLines.tenantId, schoolPayments.tenantId),
          eq(bankStatementLines.paymentId, schoolPayments.id),
        ),
      )
      .where(
        and(
          eq(schoolPayments.tenantId, tenantId),
          inArray(schoolPayments.status, [...CONFIRMABLE]),
          isNull(bankStatementLines.id),
        ),
      )
      .orderBy(asc(schoolPayments.receivedOn), asc(schoolPayments.id));
    const pool = free.map((r) => r.p);
    const taken = new Set<string>();
    let matched = 0;
    let suggested = 0;
    let unmatched = 0;
    for (const l of lines) {
      const key = norm(l.reference);
      const sameAmount = pool.filter(
        (p) => !taken.has(p.id) && toMinor(p.amount) === toMinor(l.amount),
      );
      const refOf = (p: (typeof pool)[number]) => [
        norm(p.providerReference),
        norm(p.payerReference),
      ];
      const exact = key ? sameAmount.filter((p) => refOf(p).includes(key)) : [];
      let next: Partial<LineRow> = { status: 'UNMATCHED', suggestedPaymentId: null };
      if (exact.length === 1) {
        taken.add(exact[0]!.id);
        next = {
          status: 'MATCHED',
          matchType: 'REFERENCE_AMOUNT',
          paymentId: exact[0]!.id,
          suggestedPaymentId: null,
          resolvedAt: this.deps.clock.now(),
        };
        matched++;
      } else if (exact.length > 1) {
        next = { status: 'SUGGESTED', suggestedPaymentId: exact[0]!.id };
        suggested++;
      } else {
        const byRef = key ? pool.filter((p) => !taken.has(p.id) && refOf(p).includes(key)) : [];
        if (byRef.length === 1) {
          next = { status: 'SUGGESTED', suggestedPaymentId: byRef[0]!.id };
          suggested++;
        } else if (sameAmount.length === 1) {
          next = { status: 'SUGGESTED', suggestedPaymentId: sameAmount[0]!.id };
          suggested++;
        } else unmatched++;
      }
      if (next.status !== l.status || next.suggestedPaymentId !== l.suggestedPaymentId) {
        await tx
          .update(bankStatementLines)
          .set(next)
          .where(and(eq(bankStatementLines.id, l.id), eq(bankStatementLines.tenantId, tenantId)));
      }
    }
    return { auto_matched: matched, needs_review: suggested + unmatched, suggested, unmatched };
  }

  async rematch(c: Caller) {
    requireWide(c.principal, PERMISSION);
    return this.db.transaction(async (tx) => {
      const out = await this.runMatching(tx, c.tenantId);
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_RECONCILIATION_RERUN',
        entityType: 'bank_statement',
        entityId: c.tenantId,
        after: out,
      });
      return out;
    });
  }

  // ---- reads -----------------------------------------------------------------------------------

  async statements(c: Caller) {
    requireWide(c.principal, PERMISSION);
    const rows = await this.db
      .select()
      .from(bankStatements)
      .where(eq(bankStatements.tenantId, c.tenantId))
      .orderBy(desc(bankStatements.createdAt))
      .limit(24);
    const ids = rows.map((r) => r.id);
    const by = ids.length
      ? await this.db
          .select({
            id: bankStatementLines.statementId,
            status: bankStatementLines.status,
            n: count(),
          })
          .from(bankStatementLines)
          .where(
            and(
              eq(bankStatementLines.tenantId, c.tenantId),
              inArray(bankStatementLines.statementId, ids),
            ),
          )
          .groupBy(bankStatementLines.statementId, bankStatementLines.status)
      : [];
    return rows.map((r) => {
      const mine = by.filter((x) => x.id === r.id);
      const n = (s: string) => Number(mine.find((x) => x.status === s)?.n ?? 0);
      return {
        id: r.id,
        file_name: r.fileName,
        statement_from: r.statementFrom,
        statement_to: r.statementTo,
        imported_at: r.createdAt.toISOString(),
        line_count: r.lineCount,
        duplicates_skipped: r.duplicateCount,
        matched: n('MATCHED'),
        needs_review: n('SUGGESTED') + n('UNMATCHED'),
        ignored: n('IGNORED'),
      };
    });
  }

  async summary(c: Caller) {
    requireWide(c.principal, PERMISSION);
    const lines = await this.db
      .select({
        status: bankStatementLines.status,
        n: count(),
        total: sql<string>`coalesce(sum(${bankStatementLines.amount}), 0)`,
      })
      .from(bankStatementLines)
      .where(eq(bankStatementLines.tenantId, c.tenantId))
      .groupBy(bankStatementLines.status);
    const of = (s: string) => lines.find((l) => l.status === s);
    const [unconf] = await this.db
      .select({ n: count(), total: sql<string>`coalesce(sum(${schoolPayments.amount}), 0)` })
      .from(schoolPayments)
      .leftJoin(
        bankStatementLines,
        and(
          eq(bankStatementLines.tenantId, schoolPayments.tenantId),
          eq(bankStatementLines.paymentId, schoolPayments.id),
        ),
      )
      .where(
        and(
          eq(schoolPayments.tenantId, c.tenantId),
          inArray(schoolPayments.status, [...CONFIRMABLE]),
          isNull(bankStatementLines.id),
        ),
      );
    const money = (v: string | undefined) => fromMinor(toMinor(v ?? '0'));
    const review = Number(of('SUGGESTED')?.n ?? 0) + Number(of('UNMATCHED')?.n ?? 0);
    const matched = Number(of('MATCHED')?.n ?? 0);
    const [last] = await this.db
      .select({ at: bankStatements.createdAt })
      .from(bankStatements)
      .where(eq(bankStatements.tenantId, c.tenantId))
      .orderBy(desc(bankStatements.createdAt))
      .limit(1);
    return {
      lines_total: review + matched + Number(of('IGNORED')?.n ?? 0),
      matched,
      matched_amount: money(of('MATCHED')?.total),
      needs_review: review,
      suggested: Number(of('SUGGESTED')?.n ?? 0),
      unmatched: Number(of('UNMATCHED')?.n ?? 0),
      /** Money on the bank statement that is not tied to any recorded payment. */
      unallocated_amount: fromMinor(
        toMinor(money(of('SUGGESTED')?.total)) + toMinor(money(of('UNMATCHED')?.total)),
      ),
      ignored: Number(of('IGNORED')?.n ?? 0),
      unconfirmed_payments: Number(unconf?.n ?? 0),
      unconfirmed_amount: money(unconf?.total),
      last_import_at: iso(last?.at ?? null),
    };
  }

  private async presentLines(tenantId: string, rows: LineRow[]) {
    const ids = [
      ...new Set(
        rows.flatMap((r) => [r.paymentId, r.suggestedPaymentId]).filter(Boolean) as string[],
      ),
    ];
    const pays = ids.length
      ? await this.db
          .select({ p: schoolPayments, s: students })
          .from(schoolPayments)
          .innerJoin(
            students,
            and(
              eq(students.tenantId, schoolPayments.tenantId),
              eq(students.id, schoolPayments.studentId),
            ),
          )
          .where(and(eq(schoolPayments.tenantId, tenantId), inArray(schoolPayments.id, ids)))
      : [];
    const view = (id: string | null) => {
      const x = pays.find((p) => p.p.id === id);
      return x
        ? {
            id: x.p.id,
            payment_number: x.p.paymentNumber,
            amount: x.p.amount,
            method: x.p.method,
            received_on: x.p.receivedOn,
            reference: x.p.providerReference ?? x.p.payerReference,
            student: studentMini(x.s),
          }
        : null;
    };
    return rows.map((r) => ({
      id: r.id,
      statement_id: r.statementId,
      line_date: r.lineDate,
      description: r.description,
      reference: r.reference,
      amount: r.amount,
      status: r.status,
      match_type: r.matchType,
      payment: view(r.paymentId),
      suggestion: view(r.suggestedPaymentId),
      note: r.note,
      resolved_at: iso(r.resolvedAt),
    }));
  }

  async lines(c: Caller, q: z.infer<typeof BankLineListQuery>) {
    requireWide(c.principal, PERMISSION);
    const l = bankStatementLines;
    const where = and(
      eq(l.tenantId, c.tenantId),
      q.status ? eq(l.status, q.status) : undefined,
      q.statement_id ? eq(l.statementId, q.statement_id) : undefined,
      q.search
        ? or(like(l.reference, likeOf(q.search)), like(l.description, likeOf(q.search)))
        : undefined,
    );
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(l)
        .where(where)
        .orderBy(desc(l.lineDate), desc(l.id))
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(l).where(where),
    ]);
    return pageOf(await this.presentLines(c.tenantId, rows), total?.n ?? 0, q);
  }

  /** Recorded payments that no bank line has confirmed yet. */
  async unconfirmedPayments(c: Caller, q: z.infer<typeof UnconfirmedPaymentsQuery>) {
    requireWide(c.principal, PERMISSION);
    const p = schoolPayments;
    const where = and(
      eq(p.tenantId, c.tenantId),
      inArray(p.status, [...CONFIRMABLE]),
      isNull(bankStatementLines.id),
      q.method ? eq(p.method, q.method) : undefined,
    );
    const join = (b: ReturnType<typeof this.db.select>) => b;
    void join;
    const [rows, [total]] = await Promise.all([
      this.db
        .select({ p, s: students })
        .from(p)
        .innerJoin(students, and(eq(students.tenantId, p.tenantId), eq(students.id, p.studentId)))
        .leftJoin(
          bankStatementLines,
          and(eq(bankStatementLines.tenantId, p.tenantId), eq(bankStatementLines.paymentId, p.id)),
        )
        .where(where)
        .orderBy(asc(p.receivedOn), asc(p.id))
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db
        .select({ n: count() })
        .from(p)
        .leftJoin(
          bankStatementLines,
          and(eq(bankStatementLines.tenantId, p.tenantId), eq(bankStatementLines.paymentId, p.id)),
        )
        .where(where),
    ]);
    return pageOf(
      rows.map((r) => ({
        id: r.p.id,
        payment_number: r.p.paymentNumber,
        amount: r.p.amount,
        method: r.p.method,
        received_on: r.p.receivedOn,
        reference: r.p.providerReference ?? r.p.payerReference,
        student: studentMini(r.s),
      })),
      total?.n ?? 0,
      q,
    );
  }

  // ---- decisions on one line ----------------------------------------------------------------------

  private async loadLine(tx: Executor, tenantId: string, id: string): Promise<LineRow> {
    const [row] = await tx
      .select()
      .from(bankStatementLines)
      .where(and(eq(bankStatementLines.id, id), eq(bankStatementLines.tenantId, tenantId)))
      .for('update');
    if (!row) throw new NotFoundError('Bank statement line');
    return row;
  }

  private open(l: LineRow) {
    if (l.status === 'MATCHED' || l.status === 'IGNORED')
      throw businessRule(
        'LINE_RESOLVED',
        l.status === 'MATCHED' ? 'This line is already matched' : 'This line was set aside',
        { status: l.status },
      );
  }

  async confirm(c: Caller, id: string, input: z.infer<typeof ConfirmLineBody>) {
    requireWide(c.principal, PERMISSION);
    return this.db.transaction(async (tx) => {
      const line = await this.loadLine(tx, c.tenantId, id);
      this.open(line);
      const [p] = await tx
        .select()
        .from(schoolPayments)
        .where(
          and(eq(schoolPayments.id, input.payment_id), eq(schoolPayments.tenantId, c.tenantId)),
        )
        .for('update');
      if (!p) throw new NotFoundError('Payment');
      if (!(CONFIRMABLE as readonly string[]).includes(p.status))
        throw businessRule('PAYMENT_NOT_CONFIRMABLE', 'Only a received payment can be confirmed', {
          status: p.status,
        });
      if (toMinor(p.amount) !== toMinor(line.amount))
        throw businessRule(
          'AMOUNT_MISMATCH',
          `The bank line is ${line.amount} but the payment is ${p.amount}. They must be equal.`,
          { line_amount: line.amount, payment_amount: p.amount },
          'OPERATION_NOT_ALLOWED',
        );
      const [taken] = await tx
        .select({ id: bankStatementLines.id })
        .from(bankStatementLines)
        .where(
          and(eq(bankStatementLines.tenantId, c.tenantId), eq(bankStatementLines.paymentId, p.id)),
        );
      if (taken)
        throw businessRule(
          'PAYMENT_ALREADY_CONFIRMED',
          'This payment is already confirmed by another bank line',
        );
      await tx
        .update(bankStatementLines)
        .set({
          status: 'MATCHED',
          matchType: 'MANUAL',
          paymentId: p.id,
          suggestedPaymentId: null,
          resolvedBy: c.actor.userId,
          resolvedAt: this.deps.clock.now(),
        })
        .where(eq(bankStatementLines.id, line.id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_BANK_LINE_CONFIRMED',
        entityType: 'bank_statement_line',
        entityId: line.id,
        after: { payment_id: p.id, payment_number: p.paymentNumber, amount: line.amount },
      });
      return { id: line.id, status: 'MATCHED' as const, payment_id: p.id };
    });
  }

  /** The money is in the bank but nobody recorded it: record the payment from the line and match. */
  async recordFromLine(c: Caller, id: string, input: z.infer<typeof RecordLineBody>) {
    requireWide(c.principal, PERMISSION);
    const line = await this.loadLine(this.db, c.tenantId, id);
    this.open(line);
    const out = await this.payments.create(c, {
      student_id: input.student_id,
      amount: line.amount,
      method: 'BANK_TRANSFER',
      status: 'RECEIVED',
      received_at: `${line.lineDate}T12:00:00.000Z`,
      payer_type: 'GUARDIAN',
      payer_name: input.payer_name ?? null,
      payer_reference: line.reference ?? null,
      notes: input.notes ?? `Recorded from bank statement line of ${line.lineDate}`,
      idempotency_key: `bankline-${line.id}`,
      allocation: { mode: 'AUTO' },
    });
    await this.db.transaction(async (tx) => {
      const fresh = await this.loadLine(tx, c.tenantId, id);
      if (fresh.status === 'MATCHED') return;
      await tx
        .update(bankStatementLines)
        .set({
          status: 'MATCHED',
          matchType: 'RECORDED',
          paymentId: out.payment.id,
          suggestedPaymentId: null,
          resolvedBy: c.actor.userId,
          resolvedAt: this.deps.clock.now(),
        })
        .where(eq(bankStatementLines.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_BANK_LINE_RECORDED',
        entityType: 'bank_statement_line',
        entityId: id,
        after: { payment_id: out.payment.id, student_id: input.student_id, amount: line.amount },
      });
    });
    return { id, status: 'MATCHED' as const, payment_id: out.payment.id };
  }

  async ignore(c: Caller, id: string, input: z.infer<typeof IgnoreLineBody>) {
    requireWide(c.principal, PERMISSION);
    return this.db.transaction(async (tx) => {
      const line = await this.loadLine(tx, c.tenantId, id);
      this.open(line);
      await tx
        .update(bankStatementLines)
        .set({
          status: 'IGNORED',
          suggestedPaymentId: null,
          note: input.reason,
          resolvedBy: c.actor.userId,
          resolvedAt: this.deps.clock.now(),
        })
        .where(eq(bankStatementLines.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_BANK_LINE_IGNORED',
        entityType: 'bank_statement_line',
        entityId: id,
        after: { reason: input.reason, amount: line.amount },
      });
      return { id, status: 'IGNORED' as const };
    });
  }

  /** Undo a match or an ignore: the line goes back to the queue (the payment itself is untouched). */
  async reopen(c: Caller, id: string) {
    requireWide(c.principal, PERMISSION);
    return this.db.transaction(async (tx) => {
      const line = await this.loadLine(tx, c.tenantId, id);
      if (line.status !== 'MATCHED' && line.status !== 'IGNORED')
        throw businessRule('LINE_NOT_RESOLVED', 'This line is already waiting for review');
      await tx
        .update(bankStatementLines)
        .set({
          status: 'UNMATCHED',
          matchType: null,
          paymentId: null,
          suggestedPaymentId: null,
          note: null,
          resolvedBy: null,
          resolvedAt: null,
        })
        .where(eq(bankStatementLines.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_BANK_LINE_REOPENED',
        entityType: 'bank_statement_line',
        entityId: id,
        after: { previous_status: line.status, payment_id: line.paymentId },
      });
      await this.runMatching(tx, c.tenantId);
      return { id };
    });
  }
}
