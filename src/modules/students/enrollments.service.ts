import { and, asc, count, desc, eq, inArray, like, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  enrollments,
  OPEN_ENROLLMENT_STATUSES,
  students,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { todayIso } from '../../shared/dates.js';
import {
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
} from '../../shared/errors.js';
import { offsetOf, pageOf } from '../../shared/pagination.js';
import type { AcademicService } from '../academic/academic.service.js';
import type {
  BulkMoveBody,
  BulkPromoteBody,
  ChangeEnrollmentBody,
  CompleteEnrollmentBody,
  EnrollBody,
  EnrollmentListQuery,
} from './students.schemas.js';
import {
  addHistory,
  fullName,
  likeOf,
  loadStudent,
  setStudentStatus,
  studentScope,
  type StudentRow,
} from './support.js';

const OPEN = [...OPEN_ENROLLMENT_STATUSES];
type EnrollmentRow = typeof enrollments.$inferSelect;

export interface Placement {
  academic_year_id: string;
  class_id: string;
  section_id?: string | null;
  enrollment_type: EnrollmentRow['enrollmentType'];
  start_date?: string;
}

/**
 * Enrollment: a student's place in the academic structure for a period.
 * Rows are historical — a class or section change closes one and opens another.
 * Seats are protected by locking the section row inside the transaction.
 */
export class EnrollmentService {
  constructor(
    private readonly deps: Deps,
    private readonly academic: AcademicService,
  ) {}

  /** Runs inside the transaction of every new enrollment (set by the composition root; used for automatic fee billing). */
  private afterEnrol?: (tx: Executor, tenantId: string, enrollmentId: string, actor: Actor) => Promise<unknown>;

  setAfterEnrol(fn: (tx: Executor, tenantId: string, enrollmentId: string, actor: Actor) => Promise<unknown>) {
    this.afterEnrol = fn;
  }

  private get db() {
    return this.deps.db;
  }

  // ---- reads -------------------------------------------------------------------

  private select(ex: Executor = this.db) {
    return ex
      .select({
        e: enrollments,
        yearCode: academicYears.code,
        yearName: academicYears.name,
        className: academicClasses.name,
        classCode: academicClasses.code,
        sectionName: academicSections.name,
        sectionCode: academicSections.code,
        studentNumber: students.studentNumber,
        first: students.firstName,
        middle: students.middleName,
        last: students.lastName,
      })
      .from(enrollments)
      .innerJoin(academicYears, eq(academicYears.id, enrollments.academicYearId))
      .innerJoin(academicClasses, eq(academicClasses.id, enrollments.classId))
      .leftJoin(academicSections, eq(academicSections.id, enrollments.sectionId))
      .innerJoin(students, eq(students.id, enrollments.studentId));
  }

  present(r: Awaited<ReturnType<EnrollmentService['select']>>[number]) {
    return {
      id: r.e.id,
      student: {
        id: r.e.studentId,
        student_number: r.studentNumber,
        full_name: fullName({ firstName: r.first, middleName: r.middle, lastName: r.last }),
      },
      academic_year: { id: r.e.academicYearId, code: r.yearCode, name: r.yearName },
      class: { id: r.e.classId, code: r.classCode, name: r.className },
      section: r.e.sectionId
        ? { id: r.e.sectionId, code: r.sectionCode, name: r.sectionName }
        : null,
      status: r.e.status,
      enrollment_type: r.e.enrollmentType,
      start_date: r.e.startDate,
      end_date: r.e.endDate,
      reason: r.e.reason,
      version: r.e.version,
      created_at: r.e.createdAt.toISOString(),
    };
  }

  async get(tenantId: string, id: string, ex: Executor = this.db) {
    const [row] = await this.select(ex).where(
      and(eq(enrollments.id, id), eq(enrollments.tenantId, tenantId)),
    );
    if (!row) throw new NotFoundError('Enrollment');
    return this.present(row);
  }

  async forStudent(tenantId: string, studentId: string, principal: Principal) {
    await loadStudent(this.db, tenantId, studentId, principal, 'students.read');
    const rows = await this.select()
      .where(and(eq(enrollments.tenantId, tenantId), eq(enrollments.studentId, studentId)))
      .orderBy(desc(enrollments.startDate), desc(enrollments.createdAt));
    return rows.map((r) => this.present(r));
  }

  /** Roster / enrollment listing across students (filters: year, class, section, status). */
  async list(tenantId: string, q: z.infer<typeof EnrollmentListQuery>, principal: Principal) {
    const conds: (SQL | undefined)[] = [
      eq(enrollments.tenantId, tenantId),
      studentScope(principal, 'students.read'),
    ];
    if (q.academic_year_id) conds.push(eq(enrollments.academicYearId, q.academic_year_id));
    if (q.class_id) conds.push(eq(enrollments.classId, q.class_id));
    if (q.section_id) conds.push(eq(enrollments.sectionId, q.section_id));
    if (q.student_id) conds.push(eq(enrollments.studentId, q.student_id));
    conds.push(q.status ? eq(enrollments.status, q.status) : inArray(enrollments.status, OPEN));
    if (q.search) {
      const s = likeOf(q.search);
      conds.push(
        or(
          like(students.firstName, s),
          like(students.lastName, s),
          like(students.studentNumber, s),
          sql`concat(${students.firstName}, ' ', ${students.lastName}) like ${s}`,
        ),
      );
    }
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.select()
        .where(where)
        .orderBy(asc(students.lastName), asc(students.firstName))
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db
        .select({ n: count() })
        .from(enrollments)
        .innerJoin(students, eq(students.id, enrollments.studentId))
        .where(where),
    ]);
    return pageOf(
      rows.map((r) => this.present(r)),
      total?.n ?? 0,
      q,
    );
  }

  // ---- rules -------------------------------------------------------------------

  /**
   * Validates a target placement and (when a section is given) locks it and
   * checks capacity. `ignoreSeatOf` lets a section change count the student's
   * own current seat only once.
   */
  private async validatePlacement(
    tx: Executor,
    tenantId: string,
    p: { academicYearId: string; classId: string; sectionId: string | null },
  ) {
    const year = await this.academic.getYearRow(tenantId, p.academicYearId, tx);
    if (year.status !== 'UPCOMING' && year.status !== 'ACTIVE')
      throw new BusinessRuleError(
        'INVALID_STATE',
        'Students can only be enrolled in an upcoming or active academic year',
        { academic_year_status: year.status },
      );
    const klass = await this.academic.getClassRow(tenantId, p.classId, tx);
    if (klass.status !== 'ACTIVE')
      throw new BusinessRuleError('INVALID_STATE', 'The class is not active');
    if (p.sectionId) {
      const section = await this.academic.getSectionRow(tenantId, p.sectionId, tx, true);
      if (section.academicYearId !== year.id || section.classId !== klass.id)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'The section does not belong to that class and academic year',
        );
      if (section.status !== 'ACTIVE')
        throw new BusinessRuleError('INVALID_STATE', 'The section is not open for enrollment');
      if (section.capacity !== null) {
        const taken = await this.academic.seatsTaken(tenantId, section.id, tx, true);
        if (taken >= section.capacity)
          throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'This section is full', {
            capacity: section.capacity,
            enrolled_count: taken,
          });
      }
    }
    return year;
  }

  private async describe(tx: Executor, tenantId: string, id: string) {
    const [r] = await this.select(tx).where(
      and(eq(enrollments.id, id), eq(enrollments.tenantId, tenantId)),
    );
    return r
      ? {
          enrollment_id: id,
          academic_year: r.yearCode,
          class: r.className,
          section: r.sectionName,
        }
      : { enrollment_id: id };
  }

  // ---- commands ----------------------------------------------------------------

  /**
   * Enroll inside an existing transaction (also used when creating a student
   * with an enrollment). The caller has locked/loaded the student.
   */
  async enrollInTx(
    tx: Executor,
    tenantId: string,
    student: StudentRow,
    input: Placement & { activate_student?: boolean },
    actor: Actor,
  ): Promise<string> {
    if (student.status !== 'ADMITTED' && student.status !== 'ACTIVE')
      throw new BusinessRuleError(
        'INVALID_STATE',
        'Only admitted or active students can be enrolled',
        { student_status: student.status },
      );
    const year = await this.validatePlacement(tx, tenantId, {
      academicYearId: input.academic_year_id,
      classId: input.class_id,
      sectionId: input.section_id ?? null,
    });
    const [existing] = await tx
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.studentId, student.id),
          eq(enrollments.academicYearId, year.id),
          inArray(enrollments.status, OPEN),
        ),
      );
    if (existing)
      throw new ConflictError(
        'DUPLICATE_RESOURCE',
        `The student already has an enrollment in ${year.name}. Change it instead.`,
        { enrollment_id: existing.id },
      );
    const startDate = input.start_date ?? todayIso(this.deps.clock);
    let enrollmentId: string;
    try {
      const [ins] = await tx
        .insert(enrollments)
        .values({
          tenantId,
          studentId: student.id,
          academicYearId: year.id,
          classId: input.class_id,
          sectionId: input.section_id ?? null,
          status: 'ACTIVE',
          enrollmentType: input.enrollment_type,
          startDate,
          createdBy: actor.userId,
        })
        .$returningId();
      enrollmentId = ins!.id;
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw new ConflictError(
          'DUPLICATE_RESOURCE',
          'The student is already enrolled for this year',
        );
      throw err;
    }
    const where = await this.describe(tx, tenantId, enrollmentId);
    await addHistory(tx, actor, tenantId, student.id, {
      eventType: 'ENROLLED',
      effectiveDate: startDate,
      details: where,
    });
    await recordChange(tx, actor, tenantId, {
      action: 'ENROLLMENT_CREATED',
      entityType: 'enrollment',
      entityId: enrollmentId,
      event: 'enrollment.created',
      after: where,
      payload: {
        student_id: student.id,
        academic_year_id: year.id,
        class_id: input.class_id,
        section_id: input.section_id ?? null,
        enrollment_type: input.enrollment_type,
      },
    });
    if (student.status === 'ADMITTED' && input.activate_student !== false) {
      await setStudentStatus(tx, actor, student, 'ACTIVE', {
        command: 'activate',
        reason: 'Enrolled',
        effectiveDate: startDate,
        now: this.deps.clock.now(),
      });
    }
    await this.afterEnrol?.(tx, tenantId, enrollmentId, actor);
    return enrollmentId;
  }

  async enroll(
    tenantId: string,
    studentId: string,
    input: z.infer<typeof EnrollBody>,
    principal: Principal,
    actor: Actor,
  ) {
    const id = await this.db.transaction(async (tx) => {
      const student = await loadStudent(tx, tenantId, studentId, principal, 'students.enroll', {
        lock: true,
      });
      return this.enrollInTx(tx, tenantId, student, input, actor);
    });
    return this.get(tenantId, id);
  }

  /**
   * Move a student to another class and/or section within the same academic
   * year. The old enrollment is kept (TRANSFERRED, with an end date); a new
   * one opens on the effective date. Nothing is overwritten.
   */
  async change(
    tenantId: string,
    enrollmentId: string,
    input: z.infer<typeof ChangeEnrollmentBody>,
    principal: Principal,
    actor: Actor,
  ) {
    const newId = await this.db.transaction((tx) =>
      this.changeInTx(tx, tenantId, enrollmentId, input, principal, actor),
    );
    return this.get(tenantId, newId);
  }

  /** Move one student's open enrollment inside the caller's transaction. Returns the new enrollment id. */
  async changeInTx(
    tx: Executor,
    tenantId: string,
    enrollmentId: string,
    input: z.infer<typeof ChangeEnrollmentBody>,
    principal: Principal,
    actor: Actor,
  ): Promise<string> {
    const [peek] = await tx
      .select({ studentId: enrollments.studentId })
      .from(enrollments)
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.tenantId, tenantId)));
    if (!peek) throw new NotFoundError('Enrollment');
    const student = await loadStudent(tx, tenantId, peek.studentId, principal, 'students.enroll', {
      lock: true,
    });
    const [old] = await tx
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.tenantId, tenantId)))
      .for('update');
    if (!old) throw new NotFoundError('Enrollment');
    if (!OPEN.includes(old.status))
      throw new BusinessRuleError('INVALID_STATE', 'Only an open enrollment can be changed');
    const classId = input.class_id ?? old.classId;
    const sectionId =
      input.section_id !== undefined
        ? input.section_id
        : classId === old.classId
          ? old.sectionId
          : null;
    if (classId === old.classId && sectionId === old.sectionId)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'That is already the current class and section',
      );
    await this.validatePlacement(tx, tenantId, {
      academicYearId: old.academicYearId,
      classId,
      sectionId,
    });
    const effective = input.effective_date ?? todayIso(this.deps.clock);
    const before = await this.describe(tx, tenantId, old.id);
    // Close first so the "one open enrollment per year" rule frees up.
    await tx
      .update(enrollments)
      .set({
        status: 'TRANSFERRED',
        endDate: effective,
        reason: input.reason,
        version: old.version + 1,
      })
      .where(eq(enrollments.id, old.id));
    const [ins] = await tx
      .insert(enrollments)
      .values({
        tenantId,
        studentId: old.studentId,
        academicYearId: old.academicYearId,
        classId,
        sectionId,
        status: 'ACTIVE',
        enrollmentType: 'CHANGE',
        startDate: effective,
        reason: input.reason,
        createdBy: actor.userId,
      })
      .$returningId();
    const after = await this.describe(tx, tenantId, ins!.id);
    await addHistory(tx, actor, tenantId, student.id, {
      eventType: 'ENROLLMENT_CHANGED',
      effectiveDate: effective,
      reason: input.reason,
      details: { from: before, to: after },
    });
    await recordChange(tx, actor, tenantId, {
      action: 'ENROLLMENT_CHANGED',
      entityType: 'enrollment',
      entityId: ins!.id,
      event: 'enrollment.changed',
      before,
      after,
      reason: input.reason,
      payload: {
        student_id: old.studentId,
        previous_enrollment_id: old.id,
        class_id: classId,
        section_id: sectionId,
      },
    });
    await this.afterEnrol?.(tx, tenantId, ins!.id, actor);
    return ins!.id;
  }

  /**
   * Move many students into one section in a single transaction. If any student cannot be moved
   * (section full, not enrolled in that year, no access) nothing changes and the error names them.
   */
  async bulkMove(
    tenantId: string,
    input: z.infer<typeof BulkMoveBody>,
    principal: Principal,
    actor: Actor,
  ) {
    const ids = [...new Set(input.student_ids)];
    return this.db.transaction(async (tx) => {
      const section = await this.academic.getSectionRow(tenantId, input.to_section_id, tx);
      let moved = 0;
      for (const studentId of ids) {
        const [open] = await tx
          .select()
          .from(enrollments)
          .where(
            and(
              eq(enrollments.tenantId, tenantId),
              eq(enrollments.studentId, studentId),
              eq(enrollments.academicYearId, section.academicYearId),
              inArray(enrollments.status, OPEN),
            ),
          );
        const name = await this.nameOf(tx, tenantId, studentId);
        if (!open)
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            `${name} has no open enrollment in this academic year`,
            { student_id: studentId },
          );
        if (open.sectionId === section.id) continue; // already there
        try {
          await this.changeInTx(
            tx,
            tenantId,
            open.id,
            {
              class_id: section.classId,
              section_id: section.id,
              effective_date: input.effective_date,
              reason: input.reason,
            },
            principal,
            actor,
          );
        } catch (err) {
          if (err instanceof BusinessRuleError)
            throw new BusinessRuleError(err.code as 'INVALID_STATE', `${name}: ${err.message}`, {
              ...(err.details as object | undefined),
              student_id: studentId,
            });
          throw err;
        }
        moved++;
      }
      return { moved, skipped: ids.length - moved };
    });
  }

  /** Year-end promotion of selected students into the next year's class (all or nothing). */
  async bulkPromote(
    tenantId: string,
    input: z.infer<typeof BulkPromoteBody>,
    principal: Principal,
    actor: Actor,
  ) {
    const ids = [...new Set(input.student_ids)];
    return this.db.transaction(async (tx) => {
      let promoted = 0;
      for (const studentId of ids) {
        const name = await this.nameOf(tx, tenantId, studentId);
        const student = await loadStudent(tx, tenantId, studentId, principal, 'students.enroll', {
          lock: true,
        });
        const open = await tx
          .select()
          .from(enrollments)
          .where(
            and(
              eq(enrollments.tenantId, tenantId),
              eq(enrollments.studentId, studentId),
              inArray(enrollments.status, OPEN),
            ),
          );
        try {
          if (open.some((e) => e.academicYearId === input.to_academic_year_id))
            throw new BusinessRuleError(
              'OPERATION_NOT_ALLOWED',
              'already enrolled in the target academic year',
            );
          for (const e of open)
            await this.closeInTx(
              tx,
              tenantId,
              e.id,
              'COMPLETED',
              { endDate: input.effective_date, reason: 'Promoted' },
              principal,
              actor,
            );
          await this.enrollInTx(
            tx,
            tenantId,
            student,
            {
              academic_year_id: input.to_academic_year_id,
              class_id: input.to_class_id,
              section_id: input.to_section_id ?? null,
              enrollment_type: 'PROMOTION',
              start_date: input.effective_date,
              activate_student: true,
            },
            actor,
          );
        } catch (err) {
          if (err instanceof BusinessRuleError || err instanceof ConflictError)
            throw new BusinessRuleError(err.code as 'INVALID_STATE', `${name}: ${err.message}`, {
              student_id: studentId,
            });
          throw err;
        }
        promoted++;
      }
      return { promoted };
    });
  }

  private async nameOf(tx: Executor, tenantId: string, studentId: string) {
    const [s] = await tx
      .select({ f: students.firstName, l: students.lastName })
      .from(students)
      .where(and(eq(students.id, studentId), eq(students.tenantId, tenantId)));
    return s ? `${s.f} ${s.l}` : 'A student';
  }

  private async closeOne(
    tenantId: string,
    enrollmentId: string,
    to: 'COMPLETED' | 'CANCELLED',
    o: { endDate?: string; reason?: string },
    principal: Principal,
    actor: Actor,
  ) {
    await this.db.transaction((tx) =>
      this.closeInTx(tx, tenantId, enrollmentId, to, o, principal, actor),
    );
    return this.get(tenantId, enrollmentId);
  }

  async closeInTx(
    tx: Executor,
    tenantId: string,
    enrollmentId: string,
    to: 'COMPLETED' | 'CANCELLED',
    o: { endDate?: string; reason?: string },
    principal: Principal,
    actor: Actor,
  ): Promise<void> {
    const [peek] = await tx
      .select({ studentId: enrollments.studentId })
      .from(enrollments)
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.tenantId, tenantId)));
    if (!peek) throw new NotFoundError('Enrollment');
    const student = await loadStudent(tx, tenantId, peek.studentId, principal, 'students.enroll', {
      lock: true,
    });
    const [row] = await tx
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.id, enrollmentId), eq(enrollments.tenantId, tenantId)))
      .for('update');
    if (!row) throw new NotFoundError('Enrollment');
    if (!OPEN.includes(row.status))
      throw new BusinessRuleError('INVALID_STATE', 'The enrollment is already closed');
    const end = o.endDate ?? todayIso(this.deps.clock);
    await tx
      .update(enrollments)
      .set({
        status: to,
        endDate: end,
        reason: o.reason ?? row.reason,
        version: row.version + 1,
      })
      .where(eq(enrollments.id, row.id));
    const where = await this.describe(tx, tenantId, row.id);
    await addHistory(tx, actor, tenantId, student.id, {
      eventType: to === 'COMPLETED' ? 'ENROLLMENT_COMPLETED' : 'ENROLLMENT_CANCELLED',
      effectiveDate: end,
      reason: o.reason ?? null,
      details: where,
    });
    await recordChange(tx, actor, tenantId, {
      action: `ENROLLMENT_${to}`,
      entityType: 'enrollment',
      entityId: row.id,
      event: to === 'COMPLETED' ? 'enrollment.completed' : 'enrollment.cancelled',
      before: { status: row.status },
      after: { status: to, end_date: end },
      reason: o.reason ?? null,
      payload: { student_id: row.studentId },
    });
  }

  complete(
    tenantId: string,
    id: string,
    input: z.infer<typeof CompleteEnrollmentBody>,
    principal: Principal,
    actor: Actor,
  ) {
    return this.closeOne(tenantId, id, 'COMPLETED', { endDate: input.end_date }, principal, actor);
  }

  cancel(tenantId: string, id: string, reason: string, principal: Principal, actor: Actor) {
    return this.closeOne(tenantId, id, 'CANCELLED', { reason }, principal, actor);
  }

  /** Close every open enrollment of a student (used by transfer / withdraw / graduate). */
  async closeAllForStudent(
    tx: Executor,
    tenantId: string,
    studentId: string,
    to: 'TRANSFERRED' | 'WITHDRAWN' | 'COMPLETED',
    endDate: string,
    reason: string | null,
  ): Promise<number> {
    const [res] = await tx
      .update(enrollments)
      .set({
        status: to,
        endDate,
        reason: reason === null ? sql`${enrollments.reason}` : reason,
        version: sql`${enrollments.version} + 1`,
      })
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.studentId, studentId),
          inArray(enrollments.status, OPEN),
        ),
      );
    return res.affectedRows;
  }
}
