import { and, asc, count, desc, eq, like, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  subjectOfferings,
  subjects,
  teachers,
  teachingAssignments,
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
import { offsetOf, orderFrom, pageOf } from '../../shared/pagination.js';
import { likeOf } from '../students/support.js';
import type {
  AssignmentListQuery,
  CreateAssignmentBody,
  EndAssignmentBody,
} from './teachers.schemas.js';
import {
  addTeacherHistory,
  fullName,
  loadTeacher,
  refreshTeacherAccess,
  teacherScope,
  type TeacherRow,
} from './support.js';

type AssignmentRow = typeof teachingAssignments.$inferSelect;

/** Everything the response needs, in one row: the assignment plus its offering context and teacher. */
const selection = {
  a: teachingAssignments,
  t: {
    id: teachers.id,
    teacherNumber: teachers.teacherNumber,
    firstName: teachers.firstName,
    middleName: teachers.middleName,
    lastName: teachers.lastName,
  },
  year: { id: academicYears.id, code: academicYears.code },
  klass: { id: academicClasses.id, code: academicClasses.code, name: academicClasses.name },
  section: { id: academicSections.id, code: academicSections.code, name: academicSections.name },
  subject: { id: subjects.id, code: subjects.code, name: subjects.name },
};

type Joined = {
  a: AssignmentRow;
  t: {
    id: string;
    teacherNumber: string;
    firstName: string;
    middleName: string | null;
    lastName: string;
  };
  year: { id: string; code: string };
  klass: { id: string; code: string; name: string };
  /** Drizzle returns null for the whole group when the LEFT JOIN finds no section. */
  section: { id: string; code: string; name: string } | null;
  subject: { id: string; code: string; name: string };
};

function present(r: Joined) {
  return {
    id: r.a.id,
    teacher: {
      id: r.t.id,
      teacher_number: r.t.teacherNumber,
      full_name: fullName(r.t),
    },
    subject_offering_id: r.a.subjectOfferingId,
    academic_year: r.year,
    class: r.klass,
    section: r.section ? { id: r.section.id, code: r.section.code, name: r.section.name } : null,
    subject: r.subject,
    role: r.a.role,
    status: r.a.status,
    start_date: r.a.startDate,
    end_date: r.a.endDate,
    reason: r.a.reason,
    version: r.a.version,
    created_at: r.a.createdAt.toISOString(),
    updated_at: r.a.updatedAt.toISOString(),
  };
}
export type AssignmentView = ReturnType<typeof present>;

export class AssignmentService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  /** assignment ⋈ teacher ⋈ offering ⋈ year/class/subject ⟕ section, ready for `.where()`. */
  private joined(ex: Executor) {
    return ex
      .select(selection)
      .from(teachingAssignments)
      .innerJoin(
        teachers,
        and(
          eq(teachers.tenantId, teachingAssignments.tenantId),
          eq(teachers.id, teachingAssignments.teacherId),
        ),
      )
      .innerJoin(
        subjectOfferings,
        and(
          eq(subjectOfferings.tenantId, teachingAssignments.tenantId),
          eq(subjectOfferings.id, teachingAssignments.subjectOfferingId),
        ),
      )
      .innerJoin(academicYears, eq(academicYears.id, subjectOfferings.academicYearId))
      .innerJoin(academicClasses, eq(academicClasses.id, subjectOfferings.classId))
      .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
      .leftJoin(academicSections, eq(academicSections.id, subjectOfferings.sectionId));
  }

  private async fetch(ex: Executor, where: SQL | undefined): Promise<Joined[]> {
    return (await this.joined(ex)
      .where(where)
      .orderBy(
        desc(teachingAssignments.startDate),
        asc(subjects.name),
        desc(teachingAssignments.id),
      )) as Joined[];
  }

  // ---- reads ---------------------------------------------------------------------

  async list(tenantId: string, q: z.infer<typeof AssignmentListQuery>, principal: Principal) {
    const conds: (SQL | undefined)[] = [
      eq(teachingAssignments.tenantId, tenantId),
      teacherScope(principal, 'teachers.read'),
    ];
    if (q.teacher_id) conds.push(eq(teachingAssignments.teacherId, q.teacher_id));
    if (q.subject_offering_id)
      conds.push(eq(teachingAssignments.subjectOfferingId, q.subject_offering_id));
    if (q.academic_year_id) conds.push(eq(subjectOfferings.academicYearId, q.academic_year_id));
    if (q.class_id) conds.push(eq(subjectOfferings.classId, q.class_id));
    if (q.section_id) conds.push(eq(subjectOfferings.sectionId, q.section_id));
    if (q.status) conds.push(eq(teachingAssignments.status, q.status));
    if (q.search) {
      const s = likeOf(q.search);
      conds.push(
        or(
          like(teachers.teacherNumber, s),
          like(teachers.firstName, s),
          like(teachers.lastName, s),
          sql`concat(${teachers.firstName}, ' ', ${teachers.lastName}) like ${s}`,
          like(subjects.name, s),
          like(subjects.code, s),
        ),
      );
    }
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.joined(this.db)
        .where(where)
        .orderBy(
          orderFrom(
            { ...q, order: q.sort ? q.order : 'desc' },
            {
              start_date: teachingAssignments.startDate,
              end_date: teachingAssignments.endDate,
              status: teachingAssignments.status,
              created_at: teachingAssignments.createdAt,
              teacher: teachers.lastName,
              subject: subjects.name,
            },
            'start_date',
          ),
          desc(teachingAssignments.id),
        )
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db
        .select({ n: count() })
        .from(teachingAssignments)
        .innerJoin(
          teachers,
          and(
            eq(teachers.tenantId, teachingAssignments.tenantId),
            eq(teachers.id, teachingAssignments.teacherId),
          ),
        )
        .innerJoin(
          subjectOfferings,
          and(
            eq(subjectOfferings.tenantId, teachingAssignments.tenantId),
            eq(subjectOfferings.id, teachingAssignments.subjectOfferingId),
          ),
        )
        .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
        .where(where),
    ]);
    return pageOf((rows as Joined[]).map(present), total?.n ?? 0, q);
  }

  /** Assignments of one teacher (404 if the teacher is not in this school). */
  async listForTeacher(
    tenantId: string,
    teacherId: string,
    q: z.infer<typeof AssignmentListQuery>,
    principal: Principal,
  ) {
    await loadTeacher(this.db, tenantId, teacherId, principal, 'teachers.read');
    return this.list(tenantId, { ...q, teacher_id: teacherId }, principal);
  }

  async get(tenantId: string, id: string, principal: Principal, ex: Executor = this.db) {
    const [row] = await this.fetch(
      ex,
      and(
        eq(teachingAssignments.id, id),
        eq(teachingAssignments.tenantId, tenantId),
        teacherScope(principal, 'teachers.read'),
      ),
    );
    if (!row) throw new NotFoundError('Teaching assignment');
    return present(row);
  }

  /** Open (ACTIVE) assignments of a teacher for the profile page. */
  async activeForTeacher(tenantId: string, teacherId: string, ex: Executor = this.db) {
    const rows = await this.fetch(
      ex,
      and(
        eq(teachingAssignments.tenantId, tenantId),
        eq(teachingAssignments.teacherId, teacherId),
        eq(teachingAssignments.status, 'ACTIVE'),
      ),
    );
    return rows.map(present);
  }

  /** Number of open assignments per teacher, for list pages. */
  async activeCounts(tenantId: string, teacherIds: string[], ex: Executor = this.db) {
    const out = new Map<string, number>();
    if (!teacherIds.length) return out;
    const rows = await ex
      .select({ teacherId: teachingAssignments.teacherId, n: count() })
      .from(teachingAssignments)
      .where(
        and(
          eq(teachingAssignments.tenantId, tenantId),
          sql`${teachingAssignments.teacherId} in (${sql.join(
            teacherIds.map((i) => sql`${i}`),
            sql`, `,
          )})`,
          eq(teachingAssignments.status, 'ACTIVE'),
        ),
      )
      .groupBy(teachingAssignments.teacherId);
    for (const r of rows) out.set(r.teacherId, r.n);
    return out;
  }

  // ---- create ----------------------------------------------------------------------

  async create(
    tenantId: string,
    teacherId: string,
    input: z.infer<typeof CreateAssignmentBody>,
    principal: Principal,
    actor: Actor,
  ) {
    const id = await this.db.transaction(async (tx) => {
      // Lock order: teacher → offering (share) → new row. Serialises with lifecycle commands.
      const teacher = await loadTeacher(
        tx,
        tenantId,
        teacherId,
        principal,
        'teachers.assignments.manage',
        { lock: true },
      );
      if (teacher.status !== 'ACTIVE')
        throw new BusinessRuleError(
          'INVALID_STATE',
          'Only active teachers can receive new teaching assignments',
          { teacher_status: teacher.status },
        );
      const [offering] = await tx
        .select({
          o: subjectOfferings,
          yearStatus: academicYears.status,
          yearCode: academicYears.code,
        })
        .from(subjectOfferings)
        .innerJoin(academicYears, eq(academicYears.id, subjectOfferings.academicYearId))
        .where(
          and(
            eq(subjectOfferings.id, input.subject_offering_id),
            eq(subjectOfferings.tenantId, tenantId),
          ),
        )
        .for('share');
      if (!offering) throw new NotFoundError('Subject offering');
      if (offering.o.status !== 'ACTIVE')
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'The subject offering is inactive and cannot be assigned',
          { offering_status: offering.o.status },
        );
      if (offering.yearStatus !== 'UPCOMING' && offering.yearStatus !== 'ACTIVE')
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'Teachers can only be assigned to offerings of an upcoming or active academic year',
          { academic_year_status: offering.yearStatus },
        );
      const [dup] = await tx
        .select({ id: teachingAssignments.id })
        .from(teachingAssignments)
        .where(
          and(
            eq(teachingAssignments.tenantId, tenantId),
            eq(teachingAssignments.teacherId, teacherId),
            eq(teachingAssignments.subjectOfferingId, input.subject_offering_id),
            eq(teachingAssignments.status, 'ACTIVE'),
          ),
        )
        .for('update');
      if (dup) throw this.duplicate(dup.id);
      const start = input.start_date ?? todayIso(this.deps.clock);
      let newId: string;
      try {
        const [ins] = await tx
          .insert(teachingAssignments)
          .values({
            tenantId,
            teacherId,
            subjectOfferingId: input.subject_offering_id,
            role: input.role,
            status: 'ACTIVE',
            startDate: start,
            reason: input.reason ?? null,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          })
          .$returningId();
        newId = ins!.id;
      } catch (err) {
        if (isDuplicateKeyError(err)) throw this.duplicate();
        throw err;
      }
      const view = await this.get(tenantId, newId, principal, tx);
      await addTeacherHistory(tx, actor, tenantId, teacherId, {
        eventType: 'TEACHING_ASSIGNED',
        effectiveDate: start,
        reason: input.reason ?? null,
        details: this.historyDetails(view),
      });
      await recordChange(tx, actor, tenantId, {
        action: 'TEACHING_ASSIGNMENT_CREATED',
        entityType: 'teaching_assignment',
        entityId: newId,
        event: 'teaching_assignment.created',
        after: view,
        payload: this.eventPayload(view),
      });
      return newId;
    });
    await refreshTeacherAccess(this.deps, tenantId);
    return this.get(tenantId, id, principal);
  }

  private duplicate(existingId?: string) {
    return new ConflictError(
      'DUPLICATE_RESOURCE',
      'This teacher already has an open assignment for that subject offering',
      existingId ? { assignment_id: existingId } : null,
    );
  }

  private historyDetails(v: AssignmentView) {
    return {
      assignment_id: v.id,
      subject_offering_id: v.subject_offering_id,
      academic_year: v.academic_year.code,
      class: v.class.name,
      section: v.section?.name ?? null,
      subject: v.subject.name,
      role: v.role,
    };
  }

  private eventPayload(v: AssignmentView) {
    return {
      teacher_id: v.teacher.id,
      subject_offering_id: v.subject_offering_id,
      academic_year_id: v.academic_year.id,
      class_id: v.class.id,
      section_id: v.section?.id ?? null,
      subject_id: v.subject.id,
      role: v.role,
    };
  }

  // ---- end / cancel ---------------------------------------------------------------

  /** Lock the assignment and its teacher (404 across schools), same order as create. */
  private async lockOpen(
    tx: Executor,
    tenantId: string,
    id: string,
    principal: Principal,
  ): Promise<AssignmentRow> {
    const [peek] = await tx
      .select({ teacherId: teachingAssignments.teacherId })
      .from(teachingAssignments)
      .where(and(eq(teachingAssignments.id, id), eq(teachingAssignments.tenantId, tenantId)));
    if (!peek) throw new NotFoundError('Teaching assignment');
    await loadTeacher(tx, tenantId, peek.teacherId, principal, 'teachers.assignments.manage', {
      lock: true,
    });
    const [row] = await tx
      .select()
      .from(teachingAssignments)
      .where(and(eq(teachingAssignments.id, id), eq(teachingAssignments.tenantId, tenantId)))
      .for('update');
    if (!row) throw new NotFoundError('Teaching assignment');
    if (row.status !== 'ACTIVE')
      throw new BusinessRuleError('INVALID_STATE', 'The assignment is already closed', {
        assignment_status: row.status,
      });
    return row;
  }

  /** End an assignment that has started: the historical record stays. */
  async end(
    tenantId: string,
    id: string,
    input: z.infer<typeof EndAssignmentBody>,
    principal: Principal,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const row = await this.lockOpen(tx, tenantId, id, principal);
      const today = todayIso(this.deps.clock);
      const end = input.end_date ?? today;
      if (row.startDate > today)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'This assignment has not started yet. Cancel it instead.',
          { start_date: row.startDate },
        );
      if (end < row.startDate)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'The end date cannot be before the start date',
          { field: 'end_date', start_date: row.startDate },
        );
      if (end > today)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'The end date cannot be in the future',
          {
            field: 'end_date',
          },
        );
      await this.close(tx, actor, tenantId, row, 'ENDED', end, input.reason ?? null, principal);
    });
    await refreshTeacherAccess(this.deps, tenantId);
    return this.get(tenantId, id, principal);
  }

  /** Cancel an assignment entered by mistake or that never started. Reason required. */
  async cancel(tenantId: string, id: string, reason: string, principal: Principal, actor: Actor) {
    await this.db.transaction(async (tx) => {
      const row = await this.lockOpen(tx, tenantId, id, principal);
      const today = todayIso(this.deps.clock);
      await this.close(
        tx,
        actor,
        tenantId,
        row,
        'CANCELLED',
        row.startDate > today ? row.startDate : today,
        reason,
        principal,
      );
    });
    await refreshTeacherAccess(this.deps, tenantId);
    return this.get(tenantId, id, principal);
  }

  private async close(
    tx: Executor,
    actor: Actor,
    tenantId: string,
    row: AssignmentRow,
    to: 'ENDED' | 'CANCELLED',
    endDate: string,
    reason: string | null,
    principal: Principal,
  ) {
    await tx
      .update(teachingAssignments)
      .set({
        status: to,
        endDate,
        reason: reason ?? row.reason,
        version: row.version + 1,
        updatedBy: actor.userId,
      })
      .where(eq(teachingAssignments.id, row.id));
    const view = await this.get(tenantId, row.id, principal, tx);
    await this.recordClosed(tx, actor, tenantId, row, view, to, reason);
  }

  private async recordClosed(
    tx: Executor,
    actor: Actor,
    tenantId: string,
    before: AssignmentRow,
    view: AssignmentView,
    to: 'ENDED' | 'CANCELLED',
    reason: string | null,
  ) {
    await addTeacherHistory(tx, actor, tenantId, before.teacherId, {
      eventType: to === 'ENDED' ? 'TEACHING_ASSIGNMENT_ENDED' : 'TEACHING_ASSIGNMENT_CANCELLED',
      effectiveDate: view.end_date,
      reason,
      details: this.historyDetails(view),
    });
    await recordChange(tx, actor, tenantId, {
      action: `TEACHING_ASSIGNMENT_${to}`,
      entityType: 'teaching_assignment',
      entityId: before.id,
      event: `teaching_assignment.${to.toLowerCase()}`,
      before: { status: before.status },
      after: { status: to, end_date: view.end_date },
      reason,
      payload: this.eventPayload(view),
    });
  }

  /**
   * Close every open assignment of a teacher who is leaving (caller holds the
   * teacher row lock). Assignments that have not started are cancelled; the
   * others end on `endDate`. Returns how many were closed.
   */
  async closeAllForTeacher(
    tx: Executor,
    actor: Actor,
    teacher: TeacherRow,
    o: { endDate: string; today: string; reason: string | null },
  ): Promise<number> {
    const open = await tx
      .select()
      .from(teachingAssignments)
      .where(
        and(
          eq(teachingAssignments.tenantId, teacher.tenantId),
          eq(teachingAssignments.teacherId, teacher.id),
          eq(teachingAssignments.status, 'ACTIVE'),
        ),
      )
      .for('update');
    for (const row of open) {
      const notStarted = row.startDate > o.today;
      const to = notStarted ? 'CANCELLED' : 'ENDED';
      const end = notStarted
        ? row.startDate
        : o.endDate < row.startDate
          ? row.startDate
          : o.endDate;
      const reason = o.reason ?? 'Teacher left the school';
      await tx
        .update(teachingAssignments)
        .set({
          status: to,
          endDate: end,
          reason,
          version: row.version + 1,
          updatedBy: actor.userId,
        })
        .where(eq(teachingAssignments.id, row.id));
      const [view] = await this.fetch(tx, eq(teachingAssignments.id, row.id));
      await this.recordClosed(tx, actor, teacher.tenantId, row, present(view!), to, reason);
    }
    return open.length;
  }
}
