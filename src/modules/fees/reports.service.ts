import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  enrollments,
  feeAdjustments,
  feeCategories,
  feeDemands,
  feeRefunds,
  OPEN_ENROLLMENT_STATUSES,
  schoolPayments,
  students,
} from '../../db/schema/index.js';
import { recordChange } from '../../platform/record.js';
import { csvLine } from '../../shared/csv.js';
import { ValidationError } from '../../shared/errors.js';
import { offsetOf, orderFrom, pageOf } from '../../shared/pagination.js';
import { loadStudent } from '../students/support.js';
import type {
  CollectionQuery,
  ConcessionReportQuery,
  DashboardQuery,
  ExportQuery,
  LedgerQuery,
  OutstandingQuery,
  OverdueQuery,
  RefundReportQuery,
  REPORTS,
} from './fees.schemas.js';
import { fromMinor, toMinor } from './money.js';
import {
  feeScope,
  inOwed,
  moneyOf,
  outstandingOfMoney,
  outstandingSql,
  presentAdjustment,
  presentDemand,
  presentPayment,
  presentRefund,
  schoolToday,
  studentMini,
  type Caller,
} from './support.js';

const OPEN = [...OPEN_ENROLLMENT_STATUSES];
/** Payments whose money has been received (counted in collections). */
const RECEIVED_STATUSES = ['RECEIVED', 'VERIFIED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const;
const CREDIT_STATUSES = ['RECEIVED', 'VERIFIED', 'PARTIALLY_REFUNDED'] as const;
/** Demands that count as billed: issued at some point and not cancelled. */
const BILLED = ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'PAID', 'WRITTEN_OFF', 'WAIVED'] as const;
const EXPORT_LIMIT = 20_000;

const dec = (v: unknown): string =>
  fromMinor(toMinor(v === null || v === undefined ? '0' : String(v)));
const int = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export type ReportName = (typeof REPORTS)[number];

/**
 * Read models over fee data: student ledger, outstanding, collection, overdue, concession and refund
 * reports, CSV exports and the dashboard. Every query is scoped to the caller's students (a student
 * outside the caller's scope behaves as missing) and money is summed exactly in SQL (DECIMAL) or in
 * integer minor units.
 */
export class FeeReportService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  // ---- ledger ---------------------------------------------------------------------------------------

  async ledger(c: Caller, studentId: string, q: z.infer<typeof LedgerQuery>) {
    const student = await loadStudent(this.db, c.tenantId, studentId, c.principal, 'fees.read');
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const mini = studentMini(student);
    const d = feeDemands;
    const demandRows = await this.db
      .select({ d, cat: feeCategories })
      .from(d)
      .innerJoin(
        feeCategories,
        and(eq(feeCategories.tenantId, d.tenantId), eq(feeCategories.id, d.feeCategoryId)),
      )
      .where(
        and(
          eq(d.tenantId, c.tenantId),
          eq(d.studentId, studentId),
          q.academic_year_id ? eq(d.academicYearId, q.academic_year_id) : undefined,
        ),
      )
      .orderBy(asc(d.dueDate), asc(d.demandNumber));
    const payments = await this.db
      .select()
      .from(schoolPayments)
      .where(and(eq(schoolPayments.tenantId, c.tenantId), eq(schoolPayments.studentId, studentId)))
      .orderBy(asc(schoolPayments.receivedOn), asc(schoolPayments.createdAt));
    const refunds = await this.db
      .select()
      .from(feeRefunds)
      .where(and(eq(feeRefunds.tenantId, c.tenantId), eq(feeRefunds.studentId, studentId)))
      .orderBy(asc(feeRefunds.requestedAt));
    const adjustments = await this.db
      .select()
      .from(feeAdjustments)
      .where(and(eq(feeAdjustments.tenantId, c.tenantId), eq(feeAdjustments.studentId, studentId)))
      .orderBy(asc(feeAdjustments.requestedAt));

    let original = 0n,
      discount = 0n,
      concession = 0n,
      waiver = 0n,
      late = 0n,
      billed = 0n,
      paid = 0n,
      writtenOff = 0n,
      outstanding = 0n,
      overdue = 0n,
      draft = 0n;
    for (const { d: row } of demandRows) {
      const m = moneyOf(row);
      if (row.status === 'DRAFT') {
        draft += toMinor(row.finalAmount);
        continue;
      }
      if (!(BILLED as readonly string[]).includes(row.status)) continue;
      original += m.original;
      discount += m.discount;
      concession += m.concession;
      waiver += m.waiver;
      late += m.late;
      billed += toMinor(row.finalAmount);
      paid += m.paid;
      writtenOff += m.writtenOff;
      const out = outstandingOfMoney(m);
      if (['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(row.status) && out > 0n) {
        outstanding += out;
        if (row.dueDate < today) overdue += out;
      }
    }
    let received = 0n,
      refunded = 0n,
      credit = 0n;
    for (const p of payments) {
      if ((RECEIVED_STATUSES as readonly string[]).includes(p.status)) {
        received += toMinor(p.amount);
        refunded += toMinor(p.refundedAmount);
      }
      if ((CREDIT_STATUSES as readonly string[]).includes(p.status))
        credit += toMinor(p.amount) - toMinor(p.allocatedAmount) - toMinor(p.refundedAmount);
    }
    return {
      student: mini,
      summary: {
        original_amount: fromMinor(original),
        discount_amount: fromMinor(discount),
        concession_amount: fromMinor(concession),
        waiver_amount: fromMinor(waiver),
        late_fee_amount: fromMinor(late),
        billed_amount: fromMinor(billed),
        paid_amount: fromMinor(paid),
        written_off_amount: fromMinor(writtenOff),
        outstanding_amount: fromMinor(outstanding),
        overdue_amount: fromMinor(overdue),
        draft_amount: fromMinor(draft),
        payments_received: fromMinor(received),
        refunded_amount: fromMinor(refunded),
        unallocated_credit: fromMinor(credit),
        /** Positive: the student owes this much after unallocated credit; negative: the school holds credit. */
        net_balance: fromMinor(outstanding - credit),
      },
      demands: demandRows.map((r) =>
        presentDemand(r.d, today, {
          student: mini,
          category: { id: r.cat.id, code: r.cat.code, name: r.cat.name },
        }),
      ),
      payments: payments.map((p) => presentPayment(p, { student: mini })),
      refunds: refunds.map((r) => presentRefund(r, { student: mini })),
      adjustments: adjustments.map((a) => presentAdjustment(a, { student: mini })),
    };
  }

  // ---- shared filters -----------------------------------------------------------------------------------

  private demandFilter(
    c: Caller,
    f: {
      academic_year_id?: string;
      class_id?: string;
      section_id?: string;
      fee_category_id?: string;
      student_id?: string;
    },
  ): SQL | undefined {
    const d = feeDemands;
    return and(
      eq(d.tenantId, c.tenantId),
      feeScope(c.principal, 'fees.read', d),
      f.academic_year_id ? eq(d.academicYearId, f.academic_year_id) : undefined,
      f.fee_category_id ? eq(d.feeCategoryId, f.fee_category_id) : undefined,
      f.student_id ? eq(d.studentId, f.student_id) : undefined,
      f.class_id ? eq(enrollments.classId, f.class_id) : undefined,
      f.section_id ? eq(enrollments.sectionId, f.section_id) : undefined,
    );
  }

  // ---- outstanding -------------------------------------------------------------------------------------------

  private async outstandingRows(
    c: Caller,
    q: z.infer<typeof OutstandingQuery>,
    page: { limit: number; offset: number },
    today: string,
  ) {
    const d = feeDemands;
    const where = and(
      this.demandFilter(c, q),
      inOwed,
      sql`${outstandingSql} > 0`,
      q.search
        ? sql`(${students.firstName} like ${`%${q.search}%`} or ${students.lastName} like ${`%${q.search}%`} or ${students.studentNumber} like ${`%${q.search}%`})`
        : undefined,
    );
    const base = () =>
      this.db
        .select({
          studentId: students.id,
          studentNumber: students.studentNumber,
          firstName: students.firstName,
          middleName: students.middleName,
          lastName: students.lastName,
          demands: sql<number>`count(*)`,
          outstanding: sql<string>`sum(${outstandingSql})`,
          overdue: sql<string>`sum(case when ${d.dueDate} < ${today} then ${outstandingSql} else 0 end)`,
          oldestDue: sql<string>`min(${d.dueDate})`,
        })
        .from(d)
        .innerJoin(students, and(eq(students.tenantId, d.tenantId), eq(students.id, d.studentId)))
        .innerJoin(
          enrollments,
          and(eq(enrollments.tenantId, d.tenantId), eq(enrollments.id, d.enrollmentId)),
        )
        .where(where)
        .groupBy(
          students.id,
          students.studentNumber,
          students.firstName,
          students.middleName,
          students.lastName,
        );
    const rows = await base()
      .orderBy(desc(sql`sum(${outstandingSql})`), asc(students.id))
      .limit(page.limit)
      .offset(page.offset);
    const [tot] = await this.db
      .select({
        students: sql<number>`count(distinct ${d.studentId})`,
        demands: sql<number>`count(*)`,
        outstanding: sql<string>`coalesce(sum(${outstandingSql}), 0)`,
        overdue: sql<string>`coalesce(sum(case when ${d.dueDate} < ${today} then ${outstandingSql} else 0 end), 0)`,
      })
      .from(d)
      .innerJoin(students, and(eq(students.tenantId, d.tenantId), eq(students.id, d.studentId)))
      .innerJoin(
        enrollments,
        and(eq(enrollments.tenantId, d.tenantId), eq(enrollments.id, d.enrollmentId)),
      )
      .where(where);
    // Class and section of each student's open enrollment (year filter applies when given).
    const placement = new Map<string, { class_name: string; section_name: string | null }>();
    if (rows.length) {
      const pl = await this.db
        .select({
          studentId: enrollments.studentId,
          className: academicClasses.name,
          sectionName: academicSections.name,
          year: enrollments.academicYearId,
          start: enrollments.startDate,
        })
        .from(enrollments)
        .innerJoin(academicClasses, eq(academicClasses.id, enrollments.classId))
        .leftJoin(academicSections, eq(academicSections.id, enrollments.sectionId))
        .where(
          and(
            eq(enrollments.tenantId, c.tenantId),
            inArray(enrollments.status, OPEN),
            inArray(
              enrollments.studentId,
              rows.map((r) => r.studentId),
            ),
            q.academic_year_id ? eq(enrollments.academicYearId, q.academic_year_id) : undefined,
          ),
        )
        .orderBy(asc(enrollments.startDate));
      for (const p of pl)
        placement.set(p.studentId, { class_name: p.className, section_name: p.sectionName });
    }
    return {
      rows: rows.map((r) => ({
        student: studentMini({
          id: r.studentId,
          studentNumber: r.studentNumber,
          firstName: r.firstName,
          middleName: r.middleName,
          lastName: r.lastName,
        }),
        class_name: placement.get(r.studentId)?.class_name ?? null,
        section_name: placement.get(r.studentId)?.section_name ?? null,
        demand_count: int(r.demands),
        outstanding_amount: dec(r.outstanding),
        overdue_amount: dec(r.overdue),
        oldest_due_date: r.oldestDue,
      })),
      summary: {
        student_count: int(tot?.students),
        demand_count: int(tot?.demands),
        outstanding_amount: dec(tot?.outstanding),
        overdue_amount: dec(tot?.overdue),
      },
    };
  }

  async outstanding(c: Caller, q: z.infer<typeof OutstandingQuery>) {
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const r = await this.outstandingRows(c, q, { limit: q.page_size, offset: offsetOf(q) }, today);
    return {
      ...pageOf(r.rows, r.summary.student_count, q),
      summary: r.summary,
      as_of: today,
    };
  }

  // ---- overdue -------------------------------------------------------------------------------------------------

  private overdueWhere(c: Caller, q: z.infer<typeof OverdueQuery>, today: string) {
    const d = feeDemands;
    return and(
      this.demandFilter(c, q),
      inOwed,
      sql`${outstandingSql} > 0`,
      sql`${d.dueDate} < ${today}`,
      q.min_days_overdue
        ? sql`datediff(${today}, ${d.dueDate}) >= ${q.min_days_overdue}`
        : undefined,
      q.search
        ? sql`(${students.firstName} like ${`%${q.search}%`} or ${students.lastName} like ${`%${q.search}%`} or ${students.studentNumber} like ${`%${q.search}%`} or ${d.demandNumber} like ${`%${q.search}%`})`
        : undefined,
    );
  }

  private overdueQuery(where: SQL | undefined) {
    const d = feeDemands;
    return this.db
      .select({ d, s: students, cat: feeCategories })
      .from(d)
      .innerJoin(students, and(eq(students.tenantId, d.tenantId), eq(students.id, d.studentId)))
      .innerJoin(
        feeCategories,
        and(eq(feeCategories.tenantId, d.tenantId), eq(feeCategories.id, d.feeCategoryId)),
      )
      .innerJoin(
        enrollments,
        and(eq(enrollments.tenantId, d.tenantId), eq(enrollments.id, d.enrollmentId)),
      )
      .where(where);
  }

  async overdue(c: Caller, q: z.infer<typeof OverdueQuery>) {
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const d = feeDemands;
    const where = this.overdueWhere(c, q, today);
    const days = sql`datediff(${today}, ${d.dueDate})`;
    const [rows, [tot]] = await Promise.all([
      this.overdueQuery(where)
        .orderBy(asc(d.dueDate), asc(d.id))
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db
        .select({
          n: count(),
          total: sql<string>`coalesce(sum(${outstandingSql}), 0)`,
          b1: sql<string>`coalesce(sum(case when ${days} <= 30 then ${outstandingSql} else 0 end), 0)`,
          b2: sql<string>`coalesce(sum(case when ${days} between 31 and 60 then ${outstandingSql} else 0 end), 0)`,
          b3: sql<string>`coalesce(sum(case when ${days} between 61 and 90 then ${outstandingSql} else 0 end), 0)`,
          b4: sql<string>`coalesce(sum(case when ${days} > 90 then ${outstandingSql} else 0 end), 0)`,
        })
        .from(d)
        .innerJoin(students, and(eq(students.tenantId, d.tenantId), eq(students.id, d.studentId)))
        .innerJoin(
          enrollments,
          and(eq(enrollments.tenantId, d.tenantId), eq(enrollments.id, d.enrollmentId)),
        )
        .where(where),
    ]);
    return {
      ...pageOf(
        rows.map((r) =>
          presentDemand(r.d, today, {
            student: studentMini(r.s),
            category: { id: r.cat.id, code: r.cat.code, name: r.cat.name },
          }),
        ),
        int(tot?.n),
        q,
      ),
      summary: {
        demand_count: int(tot?.n),
        outstanding_amount: dec(tot?.total),
        aging: {
          days_1_30: dec(tot?.b1),
          days_31_60: dec(tot?.b2),
          days_61_90: dec(tot?.b3),
          days_over_90: dec(tot?.b4),
        },
      },
      as_of: today,
    };
  }

  // ---- collection -------------------------------------------------------------------------------------------------

  async collection(c: Caller, q: z.infer<typeof CollectionQuery>) {
    const p = schoolPayments;
    const base = and(
      eq(p.tenantId, c.tenantId),
      feeScope(c.principal, 'fees.read', p),
      sql`${p.receivedOn} >= ${q.from}`,
      sql`${p.receivedOn} <= ${q.to}`,
      q.method ? eq(p.method, q.method) : undefined,
    );
    const received = and(base, inArray(p.status, [...RECEIVED_STATUSES]));
    const agg = {
      n: sql<number>`count(*)`,
      gross: sql<string>`coalesce(sum(${p.amount}), 0)`,
      refunded: sql<string>`coalesce(sum(${p.refundedAmount}), 0)`,
      verified: sql<string>`coalesce(sum(case when ${p.status} in ('VERIFIED','PARTIALLY_REFUNDED','REFUNDED') then ${p.amount} else 0 end), 0)`,
    };
    const [[tot], byMethod, daily, [pending]] = await Promise.all([
      this.db.select(agg).from(p).where(received),
      this.db
        .select({ method: p.method, ...agg })
        .from(p)
        .where(received)
        .groupBy(p.method)
        .orderBy(asc(p.method)),
      this.db
        .select({ day: p.receivedOn, ...agg })
        .from(p)
        .where(received)
        .groupBy(p.receivedOn)
        .orderBy(asc(p.receivedOn)),
      this.db
        .select({ n: sql<number>`count(*)`, amount: sql<string>`coalesce(sum(${p.amount}), 0)` })
        .from(p)
        .where(and(base, eq(p.status, 'PENDING'))),
    ]);
    const shape = (r: { n: unknown; gross: unknown; refunded: unknown; verified: unknown }) => ({
      payment_count: int(r.n),
      gross_amount: dec(r.gross),
      refunded_amount: dec(r.refunded),
      net_amount: fromMinor(toMinor(dec(r.gross)) - toMinor(dec(r.refunded))),
      verified_amount: dec(r.verified),
    });
    return {
      from: q.from,
      to: q.to,
      totals: shape(tot ?? { n: 0, gross: 0, refunded: 0, verified: 0 }),
      by_method: byMethod.map((r) => ({ method: r.method, ...shape(r) })),
      daily: daily.map((r) => ({ date: r.day, ...shape(r) })),
      pending: { payment_count: int(pending?.n), amount: dec(pending?.amount) },
      note: 'Grouped by the date the payment was received; refunded_amount is what was later refunded from those payments.',
    };
  }

  // ---- concessions / refunds -----------------------------------------------------------------------------------

  private concessionWhere(c: Caller, q: z.infer<typeof ConcessionReportQuery>) {
    const a = feeAdjustments;
    return and(
      eq(a.tenantId, c.tenantId),
      feeScope(c.principal, 'fees.read', a),
      q.type ? eq(a.type, q.type) : undefined,
      q.status ? eq(a.status, q.status) : undefined,
      q.from ? sql`${a.requestedOn} >= ${q.from}` : undefined,
      q.to ? sql`${a.requestedOn} <= ${q.to}` : undefined,
    );
  }

  async concessions(c: Caller, q: z.infer<typeof ConcessionReportQuery>) {
    const a = feeAdjustments;
    const where = this.concessionWhere(c, q);
    const order = orderFrom(q, { requested_at: a.requestedAt }, 'requested_at');
    const [rows, summary] = await Promise.all([
      this.db
        .select({ a, s: students, d: feeDemands })
        .from(a)
        .innerJoin(students, and(eq(students.tenantId, a.tenantId), eq(students.id, a.studentId)))
        .innerJoin(
          feeDemands,
          and(eq(feeDemands.tenantId, a.tenantId), eq(feeDemands.id, a.feeDemandId)),
        )
        .where(where)
        .orderBy(order, q.order === 'asc' ? asc(a.id) : desc(a.id))
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db
        .select({
          type: a.type,
          status: a.status,
          n: sql<number>`count(*)`,
          applied: sql<string>`coalesce(sum(${a.appliedAmount}), 0)`,
        })
        .from(a)
        .where(where)
        .groupBy(a.type, a.status),
    ]);
    const total = summary.reduce((n, r) => n + int(r.n), 0);
    return {
      ...pageOf(
        rows.map((r) =>
          presentAdjustment(r.a, { student: studentMini(r.s), demandNumber: r.d.demandNumber }),
        ),
        total,
        q,
      ),
      summary: {
        by_type_and_status: summary.map((r) => ({
          type: r.type,
          status: r.status,
          count: int(r.n),
          applied_amount: dec(r.applied),
        })),
        applied_concessions: dec(
          summary
            .filter((r) => r.type === 'CONCESSION')
            .reduce((s, r) => s + toMinor(dec(r.applied)), 0n),
        ),
        applied_waivers: dec(
          summary
            .filter((r) => r.type === 'WAIVER')
            .reduce((s, r) => s + toMinor(dec(r.applied)), 0n),
        ),
      },
    };
  }

  private refundWhere(c: Caller, q: z.infer<typeof RefundReportQuery>) {
    const r = feeRefunds;
    return and(
      eq(r.tenantId, c.tenantId),
      feeScope(c.principal, 'fees.read', r),
      q.status ? eq(r.status, q.status) : undefined,
      q.from ? sql`${r.requestedOn} >= ${q.from}` : undefined,
      q.to ? sql`${r.requestedOn} <= ${q.to}` : undefined,
    );
  }

  async refunds(c: Caller, q: z.infer<typeof RefundReportQuery>) {
    const r = feeRefunds;
    const where = this.refundWhere(c, q);
    const order = orderFrom(q, { requested_at: r.requestedAt, amount: r.amount }, 'requested_at');
    const [rows, summary] = await Promise.all([
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
        .select({
          status: r.status,
          n: sql<number>`count(*)`,
          amount: sql<string>`coalesce(sum(${r.amount}), 0)`,
        })
        .from(r)
        .where(where)
        .groupBy(r.status),
    ]);
    return {
      ...pageOf(
        rows.map((x) =>
          presentRefund(x.r, { student: studentMini(x.s), paymentNumber: x.p.paymentNumber }),
        ),
        summary.reduce((n, x) => n + int(x.n), 0),
        q,
      ),
      summary: {
        by_status: summary.map((x) => ({
          status: x.status,
          count: int(x.n),
          amount: dec(x.amount),
        })),
        completed_amount: dec(
          summary
            .filter((x) => x.status === 'COMPLETED')
            .reduce((s, x) => s + toMinor(dec(x.amount)), 0n),
        ),
      },
    };
  }

  // ---- dashboard ---------------------------------------------------------------------------------------------------

  // ---- collection by class --------------------------------------------------------------------------------

  /** Billed, collected and outstanding per class for one academic year (default: the active one). */
  async byClass(c: Caller, q: z.infer<typeof DashboardQuery>) {
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const [year] = await this.db
      .select()
      .from(academicYears)
      .where(
        and(
          eq(academicYears.tenantId, c.tenantId),
          q.academic_year_id
            ? eq(academicYears.id, q.academic_year_id)
            : eq(academicYears.status, 'ACTIVE'),
        ),
      );
    if (!year) return { academic_year: null, as_of: today, classes: [], totals: null };
    const d = feeDemands;
    const billed = sql`(${d.status} in ('ISSUED','PARTIALLY_PAID','OVERDUE','PAID'))`;
    const rows = await this.db
      .select({
        classId: academicClasses.id,
        code: academicClasses.code,
        name: academicClasses.name,
        phase: academicClasses.phase,
        sequence: academicClasses.sequence,
        pupils: sql<number>`count(distinct ${d.studentId})`,
        billed: sql<string>`coalesce(sum(case when ${billed} then ${d.finalAmount} else 0 end), 0)`,
        collected: sql<string>`coalesce(sum(case when ${billed} then ${d.paidAmount} else 0 end), 0)`,
        outstanding: sql<string>`coalesce(sum(case when ${inOwed} then ${outstandingSql} else 0 end), 0)`,
        overdue: sql<string>`coalesce(sum(case when ${inOwed} and ${d.dueDate} < ${today} then ${outstandingSql} else 0 end), 0)`,
      })
      .from(d)
      .innerJoin(
        enrollments,
        and(eq(enrollments.tenantId, d.tenantId), eq(enrollments.id, d.enrollmentId)),
      )
      .innerJoin(
        academicClasses,
        and(
          eq(academicClasses.tenantId, enrollments.tenantId),
          eq(academicClasses.id, enrollments.classId),
        ),
      )
      .where(and(this.demandFilter(c, { academic_year_id: year.id }), sql`${d.status} <> 'DRAFT'`))
      .groupBy(
        academicClasses.id,
        academicClasses.code,
        academicClasses.name,
        academicClasses.phase,
        academicClasses.sequence,
      )
      .orderBy(asc(academicClasses.sequence), asc(academicClasses.name));
    let tb = 0n;
    let tc = 0n;
    let to = 0n;
    let tv = 0n;
    const classes = rows.map((r) => {
      const b = toMinor(r.billed);
      const col = toMinor(r.collected);
      tb += b;
      tc += col;
      to += toMinor(r.outstanding);
      tv += toMinor(r.overdue);
      return {
        class_id: r.classId,
        code: r.code,
        name: r.name,
        phase: r.phase,
        pupils: Number(r.pupils),
        billed: fromMinor(b),
        collected: fromMinor(col),
        outstanding: fromMinor(toMinor(r.outstanding)),
        overdue: fromMinor(toMinor(r.overdue)),
        collection_rate: b === 0n ? null : Number((col * 10000n) / b) / 100,
      };
    });
    return {
      academic_year: { id: year.id, code: year.code, name: year.name },
      as_of: today,
      classes,
      totals: {
        billed: fromMinor(tb),
        collected: fromMinor(tc),
        outstanding: fromMinor(to),
        overdue: fromMinor(tv),
        collection_rate: tb === 0n ? null : Number((tc * 10000n) / tb) / 100,
      },
    };
  }

  async dashboard(c: Caller, q: z.infer<typeof DashboardQuery>) {
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    let year: { id: string; code: string; name: string } | null = null;
    if (q.academic_year_id) {
      const [y] = await this.db
        .select()
        .from(academicYears)
        .where(
          and(eq(academicYears.id, q.academic_year_id), eq(academicYears.tenantId, c.tenantId)),
        );
      if (!y)
        throw new ValidationError('The request is invalid', {
          location: 'query',
          issues: [{ path: 'academic_year_id', code: 'custom', message: 'Unknown academic year' }],
        });
      year = { id: y.id, code: y.code, name: y.name };
    } else {
      const [y] = await this.db
        .select()
        .from(academicYears)
        .where(and(eq(academicYears.tenantId, c.tenantId), eq(academicYears.isCurrent, true)));
      if (y) year = { id: y.id, code: y.code, name: y.name };
    }
    const d = feeDemands;
    const dWhere = and(
      eq(d.tenantId, c.tenantId),
      feeScope(c.principal, 'fees.read', d),
      year ? eq(d.academicYearId, year.id) : undefined,
    );
    const p = schoolPayments;
    const pBase = and(eq(p.tenantId, c.tenantId), feeScope(c.principal, 'fees.read', p));
    const monthStart = `${today.slice(0, 8)}01`;
    const [[dem], byCategory, [pay], [today_], [month], [adj], [ref]] = await Promise.all([
      this.db
        .select({
          billed: sql<string>`coalesce(sum(case when ${inArray(d.status, [...BILLED])} then ${d.finalAmount} else 0 end), 0)`,
          paid: sql<string>`coalesce(sum(case when ${inArray(d.status, [...BILLED])} then ${d.paidAmount} else 0 end), 0)`,
          writtenOff: sql<string>`coalesce(sum(case when ${inArray(d.status, [...BILLED])} then ${d.writtenOffAmount} else 0 end), 0)`,
          outstanding: sql<string>`coalesce(sum(case when ${inOwed} then ${outstandingSql} else 0 end), 0)`,
          overdue: sql<string>`coalesce(sum(case when ${inOwed} and ${d.dueDate} < ${today} then ${outstandingSql} else 0 end), 0)`,
          overdueCount: sql<number>`coalesce(sum(case when ${inOwed} and ${d.dueDate} < ${today} and ${outstandingSql} > 0 then 1 else 0 end), 0)`,
          draftCount: sql<number>`coalesce(sum(case when ${d.status} = 'DRAFT' then 1 else 0 end), 0)`,
          issuedCount: sql<number>`coalesce(sum(case when ${inArray(d.status, [...BILLED])} then 1 else 0 end), 0)`,
        })
        .from(d)
        .where(dWhere),
      this.db
        .select({
          id: feeCategories.id,
          code: feeCategories.code,
          name: feeCategories.name,
          billed: sql<string>`coalesce(sum(${d.finalAmount}), 0)`,
          paid: sql<string>`coalesce(sum(${d.paidAmount}), 0)`,
          outstanding: sql<string>`coalesce(sum(case when ${inOwed} then ${outstandingSql} else 0 end), 0)`,
        })
        .from(d)
        .innerJoin(
          feeCategories,
          and(eq(feeCategories.tenantId, d.tenantId), eq(feeCategories.id, d.feeCategoryId)),
        )
        .where(and(dWhere, inArray(d.status, [...BILLED])))
        .groupBy(feeCategories.id, feeCategories.code, feeCategories.name)
        .orderBy(asc(feeCategories.code)),
      this.db
        .select({
          pending: sql<number>`coalesce(sum(case when ${p.status} = 'PENDING' then 1 else 0 end), 0)`,
          unverified: sql<number>`coalesce(sum(case when ${p.status} = 'RECEIVED' then 1 else 0 end), 0)`,
          credit: sql<string>`coalesce(sum(case when ${inArray(p.status, [...CREDIT_STATUSES])} then ${p.amount} - ${p.allocatedAmount} - ${p.refundedAmount} else 0 end), 0)`,
        })
        .from(p)
        .where(pBase),
      this.db
        .select({
          n: sql<number>`count(*)`,
          net: sql<string>`coalesce(sum(${p.amount} - ${p.refundedAmount}), 0)`,
        })
        .from(p)
        .where(and(pBase, eq(p.receivedOn, today), inArray(p.status, [...RECEIVED_STATUSES]))),
      this.db
        .select({
          n: sql<number>`count(*)`,
          net: sql<string>`coalesce(sum(${p.amount} - ${p.refundedAmount}), 0)`,
        })
        .from(p)
        .where(
          and(
            pBase,
            sql`${p.receivedOn} >= ${monthStart}`,
            sql`${p.receivedOn} <= ${today}`,
            inArray(p.status, [...RECEIVED_STATUSES]),
          ),
        ),
      this.db
        .select({
          requested: sql<number>`coalesce(sum(case when ${feeAdjustments.status} = 'REQUESTED' then 1 else 0 end), 0)`,
          approved: sql<number>`coalesce(sum(case when ${feeAdjustments.status} = 'APPROVED' then 1 else 0 end), 0)`,
        })
        .from(feeAdjustments)
        .where(
          and(
            eq(feeAdjustments.tenantId, c.tenantId),
            feeScope(c.principal, 'fees.read', feeAdjustments),
          ),
        ),
      this.db
        .select({
          requested: sql<number>`coalesce(sum(case when ${feeRefunds.status} = 'REQUESTED' then 1 else 0 end), 0)`,
          approved: sql<number>`coalesce(sum(case when ${feeRefunds.status} = 'APPROVED' then 1 else 0 end), 0)`,
          processing: sql<number>`coalesce(sum(case when ${feeRefunds.status} = 'PROCESSING' then 1 else 0 end), 0)`,
        })
        .from(feeRefunds)
        .where(
          and(eq(feeRefunds.tenantId, c.tenantId), feeScope(c.principal, 'fees.read', feeRefunds)),
        ),
    ]);
    const billed = toMinor(dec(dem?.billed));
    const paid = toMinor(dec(dem?.paid));
    const rateBp = billed > 0n ? (paid * 10_000n) / billed : 0n;
    return {
      as_of: today,
      academic_year: year,
      demands: {
        billed_amount: dec(dem?.billed),
        paid_amount: dec(dem?.paid),
        written_off_amount: dec(dem?.writtenOff),
        outstanding_amount: dec(dem?.outstanding),
        overdue_amount: dec(dem?.overdue),
        overdue_count: int(dem?.overdueCount),
        issued_count: int(dem?.issuedCount),
        draft_count: int(dem?.draftCount),
        collection_rate_percent: fromMinor(rateBp),
      },
      collections: {
        today: { payment_count: int(today_?.n), net_amount: dec(today_?.net) },
        this_month: { payment_count: int(month?.n), net_amount: dec(month?.net) },
      },
      payments: {
        pending_count: int(pay?.pending),
        unverified_count: int(pay?.unverified),
        unallocated_credit: dec(pay?.credit),
      },
      approvals: {
        adjustments_requested: int(adj?.requested),
        adjustments_approved_not_applied: int(adj?.approved),
        refunds_requested: int(ref?.requested),
        refunds_approved: int(ref?.approved),
        refunds_processing: int(ref?.processing),
      },
      by_category: byCategory.map((r) => ({
        category: { id: r.id, code: r.code, name: r.name },
        billed_amount: dec(r.billed),
        paid_amount: dec(r.paid),
        outstanding_amount: dec(r.outstanding),
      })),
    };
  }

  // ---- exports -----------------------------------------------------------------------------------------------------

  private async audited(c: Caller, report: string, rows: number, filters: object) {
    await this.db.transaction(async (tx) => {
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEES_EXPORTED',
        entityType: 'fee_export',
        entityId: c.tenantId,
        event: 'fees.exported',
        payload: { report, rows, filters },
      });
    });
  }

  /** CSV of one report (formula-injection safe). Needs fees.read and fees.export; audited. */
  async exportCsv(c: Caller, report: ReportName, q: z.infer<typeof ExportQuery>) {
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const big = { page: 1, page_size: EXPORT_LIMIT, order: 'desc' as const };
    const lines: string[] = [];
    let n = 0;
    const tooLarge = (total: number) => {
      if (total > EXPORT_LIMIT)
        throw new ValidationError('The export is too large. Narrow the filters.', {
          location: 'query',
          issues: [{ path: 'from', code: 'custom', message: `More than ${EXPORT_LIMIT} rows` }],
        });
    };
    switch (report) {
      case 'outstanding': {
        const r = await this.outstandingRows(
          c,
          {
            ...big,
            academic_year_id: q.academic_year_id,
            class_id: q.class_id,
            section_id: q.section_id,
            fee_category_id: q.fee_category_id,
          },
          { limit: EXPORT_LIMIT + 1, offset: 0 },
          today,
        );
        tooLarge(r.rows.length);
        lines.push(
          csvLine([
            'Student number',
            'Student',
            'Class',
            'Section',
            'Open demands',
            'Outstanding',
            'Overdue',
            'Oldest due date',
          ]),
        );
        for (const x of r.rows)
          lines.push(
            csvLine([
              x.student.student_number,
              x.student.full_name,
              x.class_name,
              x.section_name,
              x.demand_count,
              x.outstanding_amount,
              x.overdue_amount,
              x.oldest_due_date,
            ]),
          );
        n = r.rows.length;
        break;
      }
      case 'overdue': {
        const rows = await this.overdueQuery(
          this.overdueWhere(
            c,
            {
              ...big,
              academic_year_id: q.academic_year_id,
              class_id: q.class_id,
              section_id: q.section_id,
              fee_category_id: q.fee_category_id,
              min_days_overdue: q.min_days_overdue,
            },
            today,
          ),
        )
          .orderBy(asc(feeDemands.dueDate), asc(feeDemands.id))
          .limit(EXPORT_LIMIT + 1);
        tooLarge(rows.length);
        lines.push(
          csvLine([
            'Demand number',
            'Student number',
            'Student',
            'Category',
            'Description',
            'Period',
            'Due date',
            'Days overdue',
            'Final amount',
            'Paid',
            'Outstanding',
            'Currency',
          ]),
        );
        for (const r of rows) {
          const v = presentDemand(r.d, today);
          lines.push(
            csvLine([
              v.demand_number,
              r.s.studentNumber,
              studentMini(r.s).full_name,
              r.cat.name,
              v.description,
              v.period_label,
              v.due_date,
              v.days_overdue,
              v.final_amount,
              v.paid_amount,
              v.outstanding_amount,
              v.currency,
            ]),
          );
        }
        n = rows.length;
        break;
      }
      case 'demands': {
        const d = feeDemands;
        const rows = await this.db
          .select({ d, s: students, cat: feeCategories })
          .from(d)
          .innerJoin(students, and(eq(students.tenantId, d.tenantId), eq(students.id, d.studentId)))
          .innerJoin(
            feeCategories,
            and(eq(feeCategories.tenantId, d.tenantId), eq(feeCategories.id, d.feeCategoryId)),
          )
          .innerJoin(
            enrollments,
            and(eq(enrollments.tenantId, d.tenantId), eq(enrollments.id, d.enrollmentId)),
          )
          .where(
            and(
              this.demandFilter(c, q),
              q.status
                ? sql`(case when ${d.status} in ('ISSUED','PARTIALLY_PAID') and ${d.dueDate} < ${today} then 'OVERDUE' else ${d.status} end) = ${q.status}`
                : undefined,
              q.due_from ? sql`${d.dueDate} >= ${q.due_from}` : undefined,
              q.due_to ? sql`${d.dueDate} <= ${q.due_to}` : undefined,
            ),
          )
          .orderBy(asc(d.dueDate), asc(d.demandNumber))
          .limit(EXPORT_LIMIT + 1);
        tooLarge(rows.length);
        lines.push(
          csvLine([
            'Demand number',
            'Student number',
            'Student',
            'Category',
            'Description',
            'Period',
            'Due date',
            'Status',
            'Original',
            'Discount',
            'Concession',
            'Waiver',
            'Late fee',
            'Final',
            'Paid',
            'Written off',
            'Outstanding',
            'Currency',
          ]),
        );
        for (const r of rows) {
          const v = presentDemand(r.d, today);
          lines.push(
            csvLine([
              v.demand_number,
              r.s.studentNumber,
              studentMini(r.s).full_name,
              r.cat.name,
              v.description,
              v.period_label,
              v.due_date,
              v.status,
              v.original_amount,
              v.discount_amount,
              v.concession_amount,
              v.waiver_amount,
              v.late_fee_amount,
              v.final_amount,
              v.paid_amount,
              v.written_off_amount,
              v.outstanding_amount,
              v.currency,
            ]),
          );
        }
        n = rows.length;
        break;
      }
      case 'payments': {
        const p = schoolPayments;
        const rows = await this.db
          .select({ p, s: students })
          .from(p)
          .innerJoin(students, and(eq(students.tenantId, p.tenantId), eq(students.id, p.studentId)))
          .where(
            and(
              eq(p.tenantId, c.tenantId),
              feeScope(c.principal, 'fees.read', p),
              q.student_id ? eq(p.studentId, q.student_id) : undefined,
              q.method ? eq(p.method, q.method) : undefined,
              q.status ? sql`${p.status} = ${q.status}` : undefined,
              q.from ? sql`${p.receivedOn} >= ${q.from}` : undefined,
              q.to ? sql`${p.receivedOn} <= ${q.to}` : undefined,
            ),
          )
          .orderBy(asc(p.receivedOn), asc(p.paymentNumber))
          .limit(EXPORT_LIMIT + 1);
        tooLarge(rows.length);
        lines.push(
          csvLine([
            'Payment number',
            'Received on',
            'Student number',
            'Student',
            'Method',
            'Status',
            'Reference',
            'Amount',
            'Allocated',
            'Refunded',
            'Currency',
          ]),
        );
        for (const r of rows)
          lines.push(
            csvLine([
              r.p.paymentNumber,
              r.p.receivedOn,
              r.s.studentNumber,
              studentMini(r.s).full_name,
              r.p.method,
              r.p.status,
              r.p.providerReference,
              r.p.amount,
              r.p.allocatedAmount,
              r.p.refundedAmount,
              r.p.currency,
            ]),
          );
        n = rows.length;
        break;
      }
      case 'collection': {
        if (!q.from || !q.to)
          throw new ValidationError('The request is invalid', {
            location: 'query',
            issues: [{ path: 'from', code: 'custom', message: 'from and to are required' }],
          });
        const r = await this.collection(c, { from: q.from, to: q.to, method: q.method });
        lines.push(csvLine(['Date', 'Payments', 'Gross', 'Refunded', 'Net', 'Verified']));
        for (const x of r.daily)
          lines.push(
            csvLine([
              x.date,
              x.payment_count,
              x.gross_amount,
              x.refunded_amount,
              x.net_amount,
              x.verified_amount,
            ]),
          );
        lines.push(
          csvLine([
            'Total',
            r.totals.payment_count,
            r.totals.gross_amount,
            r.totals.refunded_amount,
            r.totals.net_amount,
            r.totals.verified_amount,
          ]),
        );
        n = r.daily.length;
        break;
      }
      case 'concessions': {
        const a = feeAdjustments;
        const rows = await this.db
          .select({ a, s: students, d: feeDemands })
          .from(a)
          .innerJoin(students, and(eq(students.tenantId, a.tenantId), eq(students.id, a.studentId)))
          .innerJoin(
            feeDemands,
            and(eq(feeDemands.tenantId, a.tenantId), eq(feeDemands.id, a.feeDemandId)),
          )
          .where(
            and(
              eq(a.tenantId, c.tenantId),
              feeScope(c.principal, 'fees.read', a),
              q.type ? sql`${a.type} = ${q.type}` : undefined,
              q.status ? sql`${a.status} = ${q.status}` : undefined,
              q.from ? sql`${a.requestedOn} >= ${q.from}` : undefined,
              q.to ? sql`${a.requestedOn} <= ${q.to}` : undefined,
            ),
          )
          .orderBy(asc(a.requestedAt), asc(a.id))
          .limit(EXPORT_LIMIT + 1);
        tooLarge(rows.length);
        lines.push(
          csvLine([
            'Type',
            'Status',
            'Student number',
            'Student',
            'Demand number',
            'Value type',
            'Value',
            'Applied amount',
            'Currency',
            'Reason',
            'Requested at',
          ]),
        );
        for (const r of rows)
          lines.push(
            csvLine([
              r.a.type,
              r.a.status,
              r.s.studentNumber,
              studentMini(r.s).full_name,
              r.d.demandNumber,
              r.a.valueType,
              r.a.value,
              r.a.appliedAmount,
              r.a.currency,
              r.a.reason,
              r.a.requestedAt.toISOString(),
            ]),
          );
        n = rows.length;
        break;
      }
      case 'refunds': {
        const r0 = feeRefunds;
        const rows = await this.db
          .select({ r: r0, s: students, p: schoolPayments })
          .from(r0)
          .innerJoin(
            students,
            and(eq(students.tenantId, r0.tenantId), eq(students.id, r0.studentId)),
          )
          .innerJoin(
            schoolPayments,
            and(eq(schoolPayments.tenantId, r0.tenantId), eq(schoolPayments.id, r0.paymentId)),
          )
          .where(
            and(
              eq(r0.tenantId, c.tenantId),
              feeScope(c.principal, 'fees.read', r0),
              q.status ? sql`${r0.status} = ${q.status}` : undefined,
              q.from ? sql`${r0.requestedOn} >= ${q.from}` : undefined,
              q.to ? sql`${r0.requestedOn} <= ${q.to}` : undefined,
            ),
          )
          .orderBy(asc(r0.requestedAt), asc(r0.id))
          .limit(EXPORT_LIMIT + 1);
        tooLarge(rows.length);
        lines.push(
          csvLine([
            'Refund number',
            'Status',
            'Payment number',
            'Student number',
            'Student',
            'Amount',
            'Currency',
            'Reason',
            'Requested at',
            'Completed at',
          ]),
        );
        for (const r of rows)
          lines.push(
            csvLine([
              r.r.refundNumber,
              r.r.status,
              r.p.paymentNumber,
              r.s.studentNumber,
              studentMini(r.s).full_name,
              r.r.amount,
              r.r.currency,
              r.r.reason,
              r.r.requestedAt.toISOString(),
              r.r.completedAt?.toISOString() ?? '',
            ]),
          );
        n = rows.length;
        break;
      }
    }
    await this.audited(c, report, n, q);
    return { filename: `fees-${report}-${today}.csv`, body: lines.join('\n') + '\n' };
  }
}
