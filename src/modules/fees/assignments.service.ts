import { and, asc, count, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicSections,
  academicYears,
  enrollments,
  feeComponents,
  feeDemands,
  feeStructures,
  OPEN_ENROLLMENT_STATUSES,
  studentFeeAssignments,
  students,
} from '../../db/schema/index.js';
import { publishEvent } from '../../platform/outbox.js';
import { recordChange } from '../../platform/record.js';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  isDuplicateKeyError,
} from '../../shared/errors.js';
import { offsetOf, orderFrom, pageOf } from '../../shared/pagination.js';
import { loadStudent, studentScope } from '../students/support.js';
import type {
  AssignmentListQuery,
  BulkAssignBody,
  BulkGenerateBody,
  CreateAssignmentBody,
  GenerateDemandsBody,
} from './fees.schemas.js';
import { applyBp, fromMinor, percentToBp, toMinor } from './money.js';
import { periodsFor, type Period } from './schedule.js';
import {
  businessRule,
  ensureSettings,
  feeScope,
  loadAssignment,
  loadStructure,
  nextNumber,
  presentAssignment,
  presentDemand,
  schoolToday,
  statusAfter,
  studentMinis,
  validationIssue,
  type AssignmentRow,
  type Caller,
  type ComponentRow,
  type DemandRow,
  type StructureRow,
} from './support.js';

const OPEN = [...OPEN_ENROLLMENT_STATUSES];
const BULK_LIMIT = 1000;

export interface Selection {
  component_ids?: string[];
  period_keys?: string[];
  issue: boolean;
}

interface Planned {
  component: ComponentRow;
  period: Period;
}

/**
 * Student fee assignments and demand generation. An assignment says "this student, in this
 * enrollment, is charged by this PUBLISHED structure version"; demands are then generated from it,
 * one per component and period, as snapshots that never follow the structure again.
 *
 * Lock order: assignment (FOR UPDATE) → number sequence (last) → inserts.
 */
export class AssignmentService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  // ---- reads ------------------------------------------------------------------------------

  private async decorate(ex: Executor, tenantId: string, rows: AssignmentRow[]) {
    if (!rows.length) return [];
    const [minis, structs, counts] = await Promise.all([
      studentMinis(
        ex,
        tenantId,
        rows.map((r) => r.studentId),
      ),
      ex
        .select()
        .from(feeStructures)
        .where(
          and(
            eq(feeStructures.tenantId, tenantId),
            inArray(feeStructures.id, [...new Set(rows.map((r) => r.feeStructureId))]),
          ),
        ),
      ex
        .select({ id: feeDemands.studentFeeAssignmentId, n: sql<number>`count(*)` })
        .from(feeDemands)
        .where(
          and(
            eq(feeDemands.tenantId, tenantId),
            inArray(
              feeDemands.studentFeeAssignmentId,
              rows.map((r) => r.id),
            ),
          ),
        )
        .groupBy(feeDemands.studentFeeAssignmentId),
    ]);
    const sm = new Map(structs.map((s) => [s.id, s]));
    const cm = new Map(counts.map((r) => [r.id, Number(r.n)]));
    return rows.map((a) => {
      const s = sm.get(a.feeStructureId);
      return presentAssignment(a, {
        student: minis.get(a.studentId),
        structure: s
          ? { id: s.id, code: s.code, name: s.name, version_no: s.versionNo, status: s.status }
          : undefined,
        demandCount: cm.get(a.id) ?? 0,
      });
    });
  }

  async list(c: Caller, q: z.infer<typeof AssignmentListQuery>) {
    const a = studentFeeAssignments;
    const where = and(
      eq(a.tenantId, c.tenantId),
      feeScope(c.principal, 'fees.read', a),
      q.student_id ? eq(a.studentId, q.student_id) : undefined,
      q.fee_structure_id ? eq(a.feeStructureId, q.fee_structure_id) : undefined,
      q.academic_year_id ? eq(a.academicYearId, q.academic_year_id) : undefined,
      q.status ? eq(a.status, q.status) : undefined,
      q.class_id ? eq(enrollments.classId, q.class_id) : undefined,
      q.section_id ? eq(enrollments.sectionId, q.section_id) : undefined,
    );
    const base = this.db
      .select({ a })
      .from(a)
      .innerJoin(
        enrollments,
        and(eq(enrollments.tenantId, a.tenantId), eq(enrollments.id, a.enrollmentId)),
      )
      .where(where);
    const order = orderFrom(
      q,
      { assigned_at: a.assignedAt, created_at: a.createdAt },
      'assigned_at',
    );
    const [rows, [total]] = await Promise.all([
      base.orderBy(order, desc(a.id)).limit(q.page_size).offset(offsetOf(q)),
      this.db
        .select({ n: count() })
        .from(a)
        .innerJoin(
          enrollments,
          and(eq(enrollments.tenantId, a.tenantId), eq(enrollments.id, a.enrollmentId)),
        )
        .where(where),
    ]);
    return pageOf(
      await this.decorate(
        this.db,
        c.tenantId,
        rows.map((r) => r.a),
      ),
      total?.n ?? 0,
      q,
    );
  }

  async get(c: Caller, id: string, ex: Executor = this.db) {
    const row = await loadAssignment(ex, c.tenantId, id, c.principal, 'fees.read');
    return (await this.decorate(ex, c.tenantId, [row]))[0]!;
  }

  // ---- create -------------------------------------------------------------------------------

  private requireDiscountRight(c: Caller, percent: string | undefined) {
    if (percent !== undefined && !c.principal.permissions.has('fees.waivers.approve'))
      throw new AuthorizationError(
        'PERMISSION_DENIED',
        'Giving a discount needs the waiver approval permission',
        { permission: 'fees.waivers.approve' },
      );
  }

  private async insertAssignment(
    tx: Executor,
    c: Pick<Caller, 'tenantId' | 'actor'>,
    s: StructureRow,
    enrollment: { id: string; studentId: string },
    o: { discount_percent?: string; discount_reason?: string; notes?: string | null },
  ): Promise<string> {
    const id = uuidv7();
    const now = this.deps.clock.now();
    try {
      await tx.insert(studentFeeAssignments).values({
        id,
        tenantId: c.tenantId,
        studentId: enrollment.studentId,
        enrollmentId: enrollment.id,
        academicYearId: s.academicYearId,
        feeStructureId: s.id,
        structureCode: s.code,
        discountPercent: o.discount_percent ?? '0.00',
        discountReason: o.discount_percent ? (o.discount_reason ?? null) : null,
        notes: o.notes ?? null,
        assignedAt: now,
        assignedBy: c.actor.userId,
      });
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw new ConflictError(
          'DUPLICATE_RESOURCE',
          'The student already has an active assignment for this fee structure',
          { reason: 'ALREADY_ASSIGNED' },
        );
      throw err;
    }
    return id;
  }

  private assertAssignable(s: StructureRow) {
    if (s.status !== 'PUBLISHED')
      throw businessRule(
        'STRUCTURE_NOT_PUBLISHED',
        'Only a published fee structure can be assigned',
        { structure_status: s.status },
        'OPERATION_NOT_ALLOWED',
      );
  }

  async create(c: Caller, input: z.infer<typeof CreateAssignmentBody>) {
    this.requireDiscountRight(c, input.discount_percent);
    if (input.discount_percent && !input.discount_reason)
      throw validationIssue('discount_reason', 'A reason is required for a discount');
    let id!: string;
    await this.db.transaction(async (tx) => {
      const s = await loadStructure(tx, c.tenantId, input.fee_structure_id, 'share');
      this.assertAssignable(s);
      const student = await loadStudent(
        tx,
        c.tenantId,
        input.student_id,
        c.principal,
        'fees.manage',
      );
      const enrolQ = tx
        .select()
        .from(enrollments)
        .where(
          and(
            eq(enrollments.tenantId, c.tenantId),
            eq(enrollments.studentId, student.id),
            eq(enrollments.academicYearId, s.academicYearId),
            inArray(enrollments.status, OPEN),
            input.enrollment_id ? eq(enrollments.id, input.enrollment_id) : undefined,
          ),
        );
      const [enrollment] = await enrolQ;
      if (!enrollment)
        throw businessRule(
          input.enrollment_id ? 'ENROLLMENT_MISMATCH' : 'NO_ENROLLMENT',
          input.enrollment_id
            ? 'That enrollment is not an open enrollment of the student in the structure’s academic year'
            : 'The student has no open enrollment in the structure’s academic year',
          {},
          'OPERATION_NOT_ALLOWED',
        );
      if (s.academicSectionId && enrollment.sectionId !== s.academicSectionId)
        throw businessRule(
          'SECTION_MISMATCH',
          'The fee structure is for another section than the student’s enrollment',
          { structure_section_id: s.academicSectionId },
          'OPERATION_NOT_ALLOWED',
        );
      if (s.academicClassId && enrollment.classId !== s.academicClassId)
        throw businessRule(
          'CLASS_MISMATCH',
          'The fee structure is for another class than the student’s enrollment',
          { structure_class_id: s.academicClassId, enrollment_class_id: enrollment.classId },
          'OPERATION_NOT_ALLOWED',
        );
      id = await this.insertAssignment(tx, c, s, enrollment, input);
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'STUDENT_FEE_ASSIGNED',
        entityType: 'student_fee_assignment',
        entityId: id,
        event: 'student_fee.assigned',
        after: {
          student_id: student.id,
          fee_structure_id: s.id,
          enrollment_id: enrollment.id,
          discount_percent: input.discount_percent ?? '0.00',
        },
        reason: input.discount_percent ? (input.discount_reason ?? null) : null,
        payload: {
          student_id: student.id,
          fee_structure_id: s.id,
          structure_code: s.code,
          academic_year_id: s.academicYearId,
          enrollment_id: enrollment.id,
        },
      });
    });
    return this.get(c, id);
  }

  /**
   * Automatic billing: called inside the enrolment transaction when a student is enrolled or moved.
   * Gives the student every published fee plan that applies to their year, class and section, and
   * issues the bills straight away. Idempotent (plans the student already has are skipped) and
   * isolated in a savepoint, so a billing problem can never block an enrolment.
   */
  async autoApplyForEnrollment(
    tx: Executor,
    tenantId: string,
    enrollmentId: string,
    actor: Pick<Caller, 'actor'>['actor'],
  ): Promise<number> {
    if (this.deps.env.FEES_AUTO_BILL === 'false') return 0;
    const [e] = await tx
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.tenantId, tenantId), eq(enrollments.id, enrollmentId)));
    if (!e || !OPEN.includes(e.status)) return 0;
    const plans = await tx
      .select()
      .from(feeStructures)
      .where(
        and(
          eq(feeStructures.tenantId, tenantId),
          eq(feeStructures.academicYearId, e.academicYearId),
          eq(feeStructures.status, 'PUBLISHED'),
          or(isNull(feeStructures.academicClassId), eq(feeStructures.academicClassId, e.classId)),
          e.sectionId
            ? or(
                isNull(feeStructures.academicSectionId),
                eq(feeStructures.academicSectionId, e.sectionId),
              )
            : isNull(feeStructures.academicSectionId),
        ),
      );
    if (!plans.length) return 0;
    const have = await tx
      .select({ code: studentFeeAssignments.structureCode })
      .from(studentFeeAssignments)
      .where(
        and(
          eq(studentFeeAssignments.tenantId, tenantId),
          eq(studentFeeAssignments.studentId, e.studentId),
          eq(studentFeeAssignments.academicYearId, e.academicYearId),
          eq(studentFeeAssignments.status, 'ACTIVE'),
        ),
      );
    const owned = new Set(have.map((r) => r.code));
    const todo = plans.filter((p) => !owned.has(p.code));
    if (!todo.length) return 0;
    await ensureSettings(tx, tenantId);
    const today = await schoolToday(tx, tenantId, this.deps.clock);
    const c = { tenantId, actor };
    let applied = 0;
    for (const s of todo) {
      try {
        await tx.transaction(async (sp) => {
          const id = await this.insertAssignment(sp, c, s, e, {});
          const [a] = await sp
            .select()
            .from(studentFeeAssignments)
            .where(eq(studentFeeAssignments.id, id));
          await this.generateInTx(sp, c, a!, { issue: true }, false, today);
          await publishEvent(sp, actor, {
            tenantId,
            eventType: 'student_fee.assigned',
            aggregateType: 'student_fee_assignment',
            aggregateId: id,
            payload: {
              student_fee_assignment_id: id,
              student_id: e.studentId,
              fee_structure_id: s.id,
              structure_code: s.code,
              academic_year_id: s.academicYearId,
              enrollment_id: e.id,
              automatic: true,
            },
          });
        });
        applied++;
      } catch (err) {
        this.deps.log.warn({ err, enrollmentId, structure: s.code }, 'automatic fee billing failed');
      }
    }
    return applied;
  }

  /** Assign one structure to every open enrollment of a section or class. Idempotent: existing active assignments are skipped. */
  async bulkAssign(c: Caller, input: z.infer<typeof BulkAssignBody>) {
    this.requireDiscountRight(c, input.discount_percent);
    if (input.discount_percent && !input.discount_reason)
      throw validationIssue('discount_reason', 'A reason is required for a discount');
    const out = {
      assigned: 0,
      skipped_existing: 0,
      total_students: 0,
      assignment_ids: [] as string[],
    };
    await this.db.transaction(async (tx) => {
      const s = await loadStructure(tx, c.tenantId, input.fee_structure_id, 'share');
      this.assertAssignable(s);
      let classId = input.class_id ?? null;
      if (input.section_id) {
        const [sec] = await tx
          .select()
          .from(academicSections)
          .where(
            and(
              eq(academicSections.id, input.section_id),
              eq(academicSections.tenantId, c.tenantId),
            ),
          );
        if (!sec) throw new NotFoundError('Section');
        if (sec.academicYearId !== s.academicYearId)
          throw businessRule(
            'SECTION_YEAR_MISMATCH',
            'The section belongs to another academic year than the fee structure',
            {},
            'OPERATION_NOT_ALLOWED',
          );
        if (classId && classId !== sec.classId)
          throw validationIssue('class_id', 'The section is not in that class');
        classId = sec.classId;
      }
      if (s.academicClassId && classId && classId !== s.academicClassId)
        throw businessRule(
          'CLASS_MISMATCH',
          'The fee structure is for another class than the one selected',
          { structure_class_id: s.academicClassId },
          'OPERATION_NOT_ALLOWED',
        );
      const targets = await tx
        .select({ e: enrollments })
        .from(enrollments)
        .innerJoin(
          students,
          and(eq(students.tenantId, enrollments.tenantId), eq(students.id, enrollments.studentId)),
        )
        .where(
          and(
            eq(enrollments.tenantId, c.tenantId),
            eq(enrollments.academicYearId, s.academicYearId),
            inArray(enrollments.status, OPEN),
            input.section_id ? eq(enrollments.sectionId, input.section_id) : undefined,
            classId ? eq(enrollments.classId, classId) : undefined,
            s.academicClassId ? eq(enrollments.classId, s.academicClassId) : undefined,
            s.academicSectionId ? eq(enrollments.sectionId, s.academicSectionId) : undefined,
            studentScope(c.principal, 'fees.manage'),
          ),
        )
        .orderBy(asc(enrollments.id))
        .limit(BULK_LIMIT + 1);
      if (targets.length > BULK_LIMIT)
        throw businessRule(
          'BULK_LIMIT',
          `A bulk assignment covers at most ${BULK_LIMIT} students. Assign section by section.`,
          { limit: BULK_LIMIT },
          'OPERATION_NOT_ALLOWED',
        );
      out.total_students = targets.length;
      const existing = targets.length
        ? await tx
            .select({ enrollmentId: studentFeeAssignments.enrollmentId })
            .from(studentFeeAssignments)
            .where(
              and(
                eq(studentFeeAssignments.tenantId, c.tenantId),
                eq(studentFeeAssignments.structureCode, s.code),
                eq(studentFeeAssignments.status, 'ACTIVE'),
                inArray(
                  studentFeeAssignments.enrollmentId,
                  targets.map((t) => t.e.id),
                ),
              ),
            )
        : [];
      const have = new Set(existing.map((r) => r.enrollmentId));
      for (const { e } of targets) {
        if (have.has(e.id)) {
          out.skipped_existing++;
          continue;
        }
        try {
          const id = await this.insertAssignment(tx, c, s, e, input);
          out.assigned++;
          out.assignment_ids.push(id);
          await publishEvent(tx, c.actor, {
            tenantId: c.tenantId,
            eventType: 'student_fee.assigned',
            aggregateType: 'student_fee_assignment',
            aggregateId: id,
            payload: {
              student_fee_assignment_id: id,
              student_id: e.studentId,
              fee_structure_id: s.id,
              structure_code: s.code,
              academic_year_id: s.academicYearId,
              enrollment_id: e.id,
              bulk: true,
            },
          });
        } catch (err) {
          if (err instanceof ConflictError) out.skipped_existing++;
          else throw err;
        }
      }
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'STUDENT_FEES_BULK_ASSIGNED',
        entityType: 'fee_structure',
        entityId: s.id,
        after: { ...out, assignment_ids: undefined },
        reason: input.discount_percent ? (input.discount_reason ?? null) : null,
        payload: { section_id: input.section_id ?? null, class_id: classId },
      });
    });
    return out;
  }

  async cancel(c: Caller, id: string, reason: string) {
    await this.db.transaction(async (tx) => {
      const a = await loadAssignment(tx, c.tenantId, id, c.principal, 'fees.manage', 'update');
      if (a.status === 'CANCELLED')
        throw businessRule('ALREADY_CANCELLED', 'The assignment is already cancelled');
      const now = this.deps.clock.now();
      await tx
        .update(studentFeeAssignments)
        .set({
          status: 'CANCELLED',
          cancelledAt: now,
          cancelledBy: c.actor.userId,
          cancelReason: reason,
          version: a.version + 1,
        })
        .where(eq(studentFeeAssignments.id, id));
      // Demands that were never issued are dropped with it; issued demands are financial facts and stay.
      const drafts = await tx
        .select()
        .from(feeDemands)
        .where(
          and(
            eq(feeDemands.tenantId, c.tenantId),
            eq(feeDemands.studentFeeAssignmentId, id),
            eq(feeDemands.status, 'DRAFT'),
          ),
        )
        .orderBy(feeDemands.id)
        .for('update');
      if (drafts.length)
        await tx
          .update(feeDemands)
          .set({
            status: 'CANCELLED',
            cancelledAt: now,
            cancelledBy: c.actor.userId,
            cancelReason: `Assignment cancelled: ${reason}`.slice(0, 500),
            version: sql`${feeDemands.version} + 1`,
          })
          .where(
            and(
              eq(feeDemands.tenantId, c.tenantId),
              inArray(
                feeDemands.id,
                drafts.map((d) => d.id),
              ),
            ),
          );
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'STUDENT_FEE_CANCELLED',
        entityType: 'student_fee_assignment',
        entityId: id,
        event: 'student_fee.cancelled',
        before: { status: 'ACTIVE' },
        after: { status: 'CANCELLED', draft_demands_cancelled: drafts.length },
        reason,
        payload: { student_id: a.studentId, fee_structure_id: a.feeStructureId },
      });
    });
    return this.get(c, id);
  }

  // ---- demand generation ------------------------------------------------------------------------

  /** What the periods of the structure's components would generate for an assignment. */
  private async plan(
    tx: Executor,
    tenantId: string,
    a: AssignmentRow,
    sel: Pick<Selection, 'component_ids' | 'period_keys'>,
    strict: boolean,
  ): Promise<{ planned: Planned[]; existing: Map<string, DemandRow>; structure: StructureRow }> {
    const structure = await loadStructure(tx, tenantId, a.feeStructureId);
    const [year] = await tx
      .select()
      .from(academicYears)
      .where(eq(academicYears.id, a.academicYearId));
    const comps = await tx
      .select()
      .from(feeComponents)
      .where(
        and(eq(feeComponents.tenantId, tenantId), eq(feeComponents.feeStructureId, structure.id)),
      )
      .orderBy(asc(feeComponents.displayOrder), asc(feeComponents.name), asc(feeComponents.id));
    if (strict && sel.component_ids) {
      const known = new Set(comps.map((k) => k.id));
      const bad = sel.component_ids.filter((x) => !known.has(x));
      if (bad.length)
        throw validationIssue(
          'component_ids',
          `Not components of this fee structure: ${bad.join(', ')}`,
        );
    }
    const chosen = comps.filter((k) => !sel.component_ids || sel.component_ids.includes(k.id));
    const planned: Planned[] = [];
    for (const component of chosen)
      for (const period of periodsFor(component, year!))
        if (!sel.period_keys || sel.period_keys.includes(period.key))
          planned.push({ component, period });
    if (strict && sel.period_keys) {
      const have = new Set(planned.map((p) => p.period.key));
      const bad = sel.period_keys.filter((k) => !have.has(k));
      if (bad.length)
        throw validationIssue(
          'period_keys',
          `No such period for the chosen components: ${bad.join(', ')}`,
        );
    }
    const existingRows = await tx
      .select()
      .from(feeDemands)
      .where(and(eq(feeDemands.tenantId, tenantId), eq(feeDemands.studentFeeAssignmentId, a.id)));
    return {
      planned,
      existing: new Map(existingRows.map((d) => [`${d.feeComponentId}|${d.periodKey}`, d])),
      structure,
    };
  }

  async preview(c: Caller, id: string) {
    const a = await loadAssignment(this.db, c.tenantId, id, c.principal, 'fees.read');
    const { planned, existing, structure } = await this.plan(this.db, c.tenantId, a, {}, false);
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const bp = percentToBp(a.discountPercent);
    return {
      assignment_id: a.id,
      fee_structure_id: structure.id,
      currency: structure.currency,
      periods: planned.map(({ component, period }) => {
        const original = toMinor(component.amount);
        const discount = applyBp(original, bp);
        const have = existing.get(`${component.id}|${period.key}`);
        return {
          fee_component_id: component.id,
          component_name: component.name,
          period_key: period.key,
          period_label: period.label,
          due_date: period.dueDate,
          original_amount: fromMinor(original),
          discount_amount: fromMinor(discount),
          final_amount: fromMinor(original - discount),
          generated: !!have,
          demand: have ? presentDemand(have, today) : null,
        };
      }),
    };
  }

  /**
   * Generate the missing demands of one locked assignment. Idempotent per assignment + component +
   * period: what exists (in any status, cancelled included) is never generated again.
   */
  async generateInTx(
    tx: Executor,
    c: Pick<Caller, 'tenantId' | 'actor'>,
    a: AssignmentRow,
    sel: Selection,
    strict: boolean,
    today: string,
  ) {
    const { planned, existing, structure } = await this.plan(tx, c.tenantId, a, sel, strict);
    const todo = planned.filter((p) => !existing.has(`${p.component.id}|${p.period.key}`));
    const now = this.deps.clock.now();
    const bp = percentToBp(a.discountPercent);
    const created: DemandRow[] = [];
    if (todo.length) {
      const numbers: string[] = [];
      for (let i = 0; i < todo.length; i++)
        numbers.push(await nextNumber(tx, c.tenantId, 'FEE', now));
      const rows = todo.map(({ component, period }, i) => {
        const original = toMinor(component.amount);
        const discount = applyBp(original, bp);
        const money = {
          original,
          discount,
          concession: 0n,
          waiver: 0n,
          late: 0n,
          paid: 0n,
          writtenOff: 0n,
        };
        const status = sel.issue
          ? statusAfter({ status: 'ISSUED', dueDate: period.dueDate }, money, today)
          : ('DRAFT' as const);
        return {
          id: uuidv7(),
          tenantId: c.tenantId,
          demandNumber: numbers[i]!,
          studentId: a.studentId,
          enrollmentId: a.enrollmentId,
          academicYearId: a.academicYearId,
          studentFeeAssignmentId: a.id,
          feeComponentId: component.id,
          feeCategoryId: component.feeCategoryId,
          periodKey: period.key,
          periodLabel: period.label,
          description: component.name,
          currency: structure.currency,
          originalAmount: fromMinor(original),
          discountAmount: fromMinor(discount),
          finalAmount: fromMinor(original - discount),
          dueDate: period.dueDate,
          status,
          issuedAt: sel.issue ? now : null,
          issuedBy: sel.issue ? c.actor.userId : null,
          settledAt: sel.issue && original - discount <= 0n ? now : null,
          createdBy: c.actor.userId,
        };
      });
      for (let i = 0; i < rows.length; i += 100)
        await tx.insert(feeDemands).values(rows.slice(i, i + 100));
      const ids = rows.map((r) => r.id);
      const fresh = await tx
        .select()
        .from(feeDemands)
        .where(and(eq(feeDemands.tenantId, c.tenantId), inArray(feeDemands.id, ids)))
        .orderBy(asc(feeDemands.dueDate), asc(feeDemands.demandNumber));
      created.push(...fresh);
      await recordChange(tx, c.actor, c.tenantId, {
        action: sel.issue ? 'FEE_DEMANDS_GENERATED_AND_ISSUED' : 'FEE_DEMANDS_GENERATED',
        entityType: 'student_fee_assignment',
        entityId: a.id,
        event: 'fee_demand.generated',
        after: { created: created.length, issued: sel.issue },
        payload: {
          student_id: a.studentId,
          demand_ids: ids,
          count: created.length,
          issued: sel.issue,
        },
      });
      if (sel.issue)
        for (const d of created)
          await publishEvent(tx, c.actor, {
            tenantId: c.tenantId,
            eventType: 'fee_demand.issued',
            aggregateType: 'fee_demand',
            aggregateId: d.id,
            payload: {
              fee_demand_id: d.id,
              student_id: d.studentId,
              demand_number: d.demandNumber,
              final_amount: d.finalAmount,
              currency: d.currency,
              due_date: d.dueDate,
            },
          });
    }
    return {
      assignment_id: a.id,
      created,
      skipped_existing: planned.length - todo.length,
      total_planned: planned.length,
    };
  }

  async generate(c: Caller, id: string, sel: z.infer<typeof GenerateDemandsBody>) {
    await ensureSettings(this.db, c.tenantId);
    const result = await this.db.transaction(async (tx) => {
      const a = await loadAssignment(tx, c.tenantId, id, c.principal, 'fees.manage', 'update');
      if (a.status !== 'ACTIVE')
        throw businessRule(
          'ASSIGNMENT_NOT_ACTIVE',
          'Demands can only be generated for an active assignment',
          {},
          'OPERATION_NOT_ALLOWED',
        );
      const today = await schoolToday(tx, c.tenantId, this.deps.clock);
      return this.generateInTx(tx, c, a, sel, true, today);
    });
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const minis = await studentMinis(this.db, c.tenantId, [
      ...new Set(result.created.map((d) => d.studentId)),
    ]);
    return {
      assignment_id: result.assignment_id,
      created: result.created.map((d) =>
        presentDemand(d, today, { student: minis.get(d.studentId) }),
      ),
      created_count: result.created.length,
      skipped_existing: result.skipped_existing,
      total_planned: result.total_planned,
    };
  }

  /** Generate for many assignments in one transaction (all of a structure, section or class, or a list). */
  async bulkGenerate(c: Caller, input: z.infer<typeof BulkGenerateBody>) {
    await ensureSettings(this.db, c.tenantId);
    const sel: Selection = {
      component_ids: input.component_ids,
      period_keys: input.period_keys,
      issue: input.issue,
    };
    const results = await this.db.transaction(async (tx) => {
      const a = studentFeeAssignments;
      const conds: (SQL | undefined)[] = [
        eq(a.tenantId, c.tenantId),
        eq(a.status, 'ACTIVE'),
        feeScope(c.principal, 'fees.manage', a),
        input.assignment_ids ? inArray(a.id, input.assignment_ids) : undefined,
        input.fee_structure_id ? eq(a.feeStructureId, input.fee_structure_id) : undefined,
      ];
      if (input.section_id || input.class_id)
        conds.push(
          sql`exists (select 1 from ${enrollments} where ${enrollments.tenantId} = ${a.tenantId} and ${enrollments.id} = ${a.enrollmentId} ${
            input.section_id ? sql`and ${enrollments.sectionId} = ${input.section_id}` : sql``
          } ${input.class_id ? sql`and ${enrollments.classId} = ${input.class_id}` : sql``})`,
        );
      const locked = await tx
        .select()
        .from(a)
        .where(and(...conds))
        .orderBy(asc(a.id))
        .limit(BULK_LIMIT + 1)
        .for('update');
      if (locked.length > BULK_LIMIT)
        throw businessRule(
          'BULK_LIMIT',
          `A bulk generation covers at most ${BULK_LIMIT} assignments. Narrow it by section.`,
          { limit: BULK_LIMIT },
          'OPERATION_NOT_ALLOWED',
        );
      const today = await schoolToday(tx, c.tenantId, this.deps.clock);
      const out = [];
      for (const row of locked) out.push(await this.generateInTx(tx, c, row, sel, false, today));
      return out;
    });
    const createdCount = results.reduce((n, r) => n + r.created.length, 0);
    return {
      assignments: results.length,
      created_count: createdCount,
      skipped_existing: results.reduce((n, r) => n + r.skipped_existing, 0),
      results: results.map((r) => ({
        assignment_id: r.assignment_id,
        created_count: r.created.length,
        skipped_existing: r.skipped_existing,
      })),
    };
  }
}
