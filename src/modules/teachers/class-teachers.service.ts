import { and, asc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  sectionClassTeachers,
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
import type { AssignClassTeacherBody, ClassTeacherListQuery } from './teachers.schemas.js';
import {
  addTeacherHistory,
  fullName,
  loadTeacher,
  refreshTeacherAccess,
  teacherScope,
} from './support.js';

/**
 * The class teacher of a section (one per section, history kept). Class
 * teachers and teaching assignments together decide which sections a teacher
 * can see (see AuthorizationService.loadGrants).
 */
export class ClassTeacherService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  /** Sections of a year with their current class teacher (default: the active year). */
  async list(tenantId: string, query: z.infer<typeof ClassTeacherListQuery>, principal: Principal) {
    let yearId = query.academic_year_id;
    if (!yearId) {
      const [y] = await this.db
        .select({ id: academicYears.id })
        .from(academicYears)
        .where(and(eq(academicYears.tenantId, tenantId), eq(academicYears.status, 'ACTIVE')))
        .limit(1);
      yearId = y?.id;
    }
    if (!yearId) return { data: [], meta: { academic_year_id: null } };
    const scope = teacherScope(principal, 'teachers.read');
    const rows = await this.db
      .select({
        section: academicSections,
        klass: { id: academicClasses.id, code: academicClasses.code, name: academicClasses.name },
        seq: academicClasses.sequence,
        ct: sectionClassTeachers,
        t: {
          id: teachers.id,
          teacherNumber: teachers.teacherNumber,
          firstName: teachers.firstName,
          middleName: teachers.middleName,
          lastName: teachers.lastName,
          status: teachers.status,
        },
      })
      .from(academicSections)
      .innerJoin(
        academicClasses,
        and(
          eq(academicClasses.tenantId, academicSections.tenantId),
          eq(academicClasses.id, academicSections.classId),
        ),
      )
      .leftJoin(
        sectionClassTeachers,
        and(
          eq(sectionClassTeachers.tenantId, academicSections.tenantId),
          eq(sectionClassTeachers.sectionId, academicSections.id),
          eq(sectionClassTeachers.status, 'ACTIVE'),
        ),
      )
      .leftJoin(
        teachers,
        and(
          eq(teachers.tenantId, sectionClassTeachers.tenantId),
          eq(teachers.id, sectionClassTeachers.teacherId),
        ),
      )
      .where(
        and(
          eq(academicSections.tenantId, tenantId),
          eq(academicSections.academicYearId, yearId),
          eq(academicSections.status, 'ACTIVE'),
          scope,
        ),
      )
      .orderBy(asc(academicClasses.sequence), asc(academicSections.code));
    return {
      data: rows.map((r) => ({
        section_id: r.section.id,
        section: { id: r.section.id, code: r.section.code, name: r.section.name },
        class: r.klass,
        class_teacher: r.t
          ? {
              teacher_id: r.t.id,
              teacher_number: r.t.teacherNumber,
              full_name: fullName(r.t),
              status: r.t.status,
              since: r.ct?.startDate ?? null,
            }
          : null,
      })),
      meta: { academic_year_id: yearId },
    };
  }

  /** Make `teacher_id` the class teacher of the section, ending the previous one. */
  async assign(
    tenantId: string,
    sectionId: string,
    input: z.infer<typeof AssignClassTeacherBody>,
    principal: Principal,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const teacher = await loadTeacher(
        tx,
        tenantId,
        input.teacher_id,
        principal,
        'teachers.assignments.manage',
        { lock: true },
      );
      if (teacher.status !== 'ACTIVE')
        throw new BusinessRuleError(
          'INVALID_STATE',
          'Only active teachers can be made class teacher',
          { teacher_status: teacher.status },
        );
      if (teacher.staffType !== 'TEACHING')
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'Only teaching staff can be class teacher',
          { staff_type: teacher.staffType },
        );
      const section = await this.loadSection(tx, tenantId, sectionId);
      const today = todayIso(this.deps.clock);
      const [open] = await tx
        .select()
        .from(sectionClassTeachers)
        .where(
          and(
            eq(sectionClassTeachers.tenantId, tenantId),
            eq(sectionClassTeachers.sectionId, sectionId),
            eq(sectionClassTeachers.status, 'ACTIVE'),
          ),
        )
        .for('update');
      if (open?.teacherId === teacher.id)
        throw new ConflictError(
          'DUPLICATE_RESOURCE',
          'This teacher is already the class teacher of that section',
          { section_id: sectionId },
        );
      if (open) await this.endRow(tx, tenantId, open, today, input.reason ?? null, actor);
      try {
        const [ins] = await tx
          .insert(sectionClassTeachers)
          .values({
            tenantId,
            sectionId,
            teacherId: teacher.id,
            status: 'ACTIVE',
            startDate: input.start_date ?? today,
            reason: input.reason ?? null,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          })
          .$returningId();
        await addTeacherHistory(tx, actor, tenantId, teacher.id, {
          eventType: 'CLASS_TEACHER_ASSIGNED',
          effectiveDate: input.start_date ?? today,
          reason: input.reason ?? null,
          details: { section_id: sectionId, ...section.label },
        });
        await recordChange(tx, actor, tenantId, {
          action: 'CLASS_TEACHER_ASSIGNED',
          entityType: 'section_class_teacher',
          entityId: ins!.id,
          event: 'class_teacher.assigned',
          before: open ? { teacher_id: open.teacherId } : null,
          after: { teacher_id: teacher.id, section_id: sectionId },
          payload: { teacher_id: teacher.id, section_id: sectionId },
        });
      } catch (err) {
        if (isDuplicateKeyError(err))
          throw new ConflictError('CONFLICT', 'The class teacher was changed by someone else', {
            section_id: sectionId,
          });
        throw err;
      }
    });
    await refreshTeacherAccess(this.deps, tenantId);
    return this.currentFor(tenantId, sectionId);
  }

  /** End the section's class teacher without naming a replacement. */
  async remove(
    tenantId: string,
    sectionId: string,
    reason: string,
    principal: Principal,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      await this.loadSection(tx, tenantId, sectionId);
      const [open] = await tx
        .select()
        .from(sectionClassTeachers)
        .where(
          and(
            eq(sectionClassTeachers.tenantId, tenantId),
            eq(sectionClassTeachers.sectionId, sectionId),
            eq(sectionClassTeachers.status, 'ACTIVE'),
          ),
        )
        .for('update');
      if (!open) throw new NotFoundError('Class teacher');
      // Same authorisation as assigning: the teacher must be reachable by this principal.
      await loadTeacher(tx, tenantId, open.teacherId, principal, 'teachers.assignments.manage', {
        lock: true,
      });
      await this.endRow(tx, tenantId, open, todayIso(this.deps.clock), reason, actor);
    });
    await refreshTeacherAccess(this.deps, tenantId);
  }

  /** End every open class-teacher row of a teacher (used when they leave). */
  async endAllFor(
    tx: Parameters<Parameters<Deps['db']['transaction']>[0]>[0],
    tenantId: string,
    teacherId: string,
    reason: string,
    actor: Actor,
  ) {
    const open = await tx
      .select()
      .from(sectionClassTeachers)
      .where(
        and(
          eq(sectionClassTeachers.tenantId, tenantId),
          eq(sectionClassTeachers.teacherId, teacherId),
          eq(sectionClassTeachers.status, 'ACTIVE'),
        ),
      )
      .for('update');
    const today = todayIso(this.deps.clock);
    for (const row of open) await this.endRow(tx, tenantId, row, today, reason, actor);
    return open.length;
  }

  private async endRow(
    tx: Parameters<Parameters<Deps['db']['transaction']>[0]>[0],
    tenantId: string,
    row: typeof sectionClassTeachers.$inferSelect,
    endDate: string,
    reason: string | null,
    actor: Actor,
  ) {
    await tx
      .update(sectionClassTeachers)
      .set({
        status: 'ENDED',
        endDate: endDate < row.startDate ? row.startDate : endDate,
        reason,
        updatedBy: actor.userId,
      })
      .where(eq(sectionClassTeachers.id, row.id));
    await addTeacherHistory(tx, actor, tenantId, row.teacherId, {
      eventType: 'CLASS_TEACHER_ENDED',
      effectiveDate: endDate,
      reason,
      details: { section_id: row.sectionId },
    });
    await recordChange(tx, actor, tenantId, {
      action: 'CLASS_TEACHER_ENDED',
      entityType: 'section_class_teacher',
      entityId: row.id,
      event: 'class_teacher.ended',
      before: { teacher_id: row.teacherId, section_id: row.sectionId },
      payload: { teacher_id: row.teacherId, section_id: row.sectionId },
    });
  }

  private async loadSection(
    tx: Parameters<Parameters<Deps['db']['transaction']>[0]>[0],
    tenantId: string,
    sectionId: string,
  ) {
    const [r] = await tx
      .select({
        s: academicSections,
        yearStatus: academicYears.status,
        yearCode: academicYears.code,
        className: academicClasses.name,
      })
      .from(academicSections)
      .innerJoin(academicYears, eq(academicYears.id, academicSections.academicYearId))
      .innerJoin(academicClasses, eq(academicClasses.id, academicSections.classId))
      .where(and(eq(academicSections.id, sectionId), eq(academicSections.tenantId, tenantId)))
      .for('share');
    if (!r) throw new NotFoundError('Section');
    if (r.s.status !== 'ACTIVE')
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'The section is not active', {
        section_status: r.s.status,
      });
    if (r.yearStatus !== 'UPCOMING' && r.yearStatus !== 'ACTIVE')
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'A class teacher can only be set for an upcoming or active academic year',
        { academic_year_status: r.yearStatus },
      );
    return {
      section: r.s,
      label: { academic_year: r.yearCode, class: r.className, section_name: r.s.name },
    };
  }

  private async currentFor(tenantId: string, sectionId: string) {
    const [sec] = await this.db
      .select({ y: academicSections.academicYearId })
      .from(academicSections)
      .where(and(eq(academicSections.id, sectionId), eq(academicSections.tenantId, tenantId)));
    const all = await this.listAdmin(tenantId, sec?.y);
    return all.data.find((r) => r.section_id === sectionId) ?? null;
  }

  /** Unscoped list used to echo a just-changed row back to an admin. */
  private async listAdmin(tenantId: string, yearId: string | undefined) {
    const rows = await this.db
      .select({
        section: academicSections,
        klass: { id: academicClasses.id, code: academicClasses.code, name: academicClasses.name },
        ct: sectionClassTeachers,
        t: {
          id: teachers.id,
          teacherNumber: teachers.teacherNumber,
          firstName: teachers.firstName,
          middleName: teachers.middleName,
          lastName: teachers.lastName,
          status: teachers.status,
        },
      })
      .from(academicSections)
      .innerJoin(academicClasses, eq(academicClasses.id, academicSections.classId))
      .leftJoin(
        sectionClassTeachers,
        and(
          eq(sectionClassTeachers.sectionId, academicSections.id),
          eq(sectionClassTeachers.status, 'ACTIVE'),
        ),
      )
      .leftJoin(teachers, eq(teachers.id, sectionClassTeachers.teacherId))
      .where(
        and(
          eq(academicSections.tenantId, tenantId),
          yearId ? eq(academicSections.academicYearId, yearId) : undefined,
        ),
      );
    return {
      data: rows.map((r) => ({
        section_id: r.section.id,
        section: { id: r.section.id, code: r.section.code, name: r.section.name },
        class: r.klass,
        class_teacher: r.t
          ? {
              teacher_id: r.t.id,
              teacher_number: r.t.teacherNumber,
              full_name: fullName(r.t),
              status: r.t.status,
              since: r.ct?.startDate ?? null,
            }
          : null,
      })),
    };
  }

  /** The signed-in teacher's own classes: class-teacher sections and teaching assignments. */
  async mine(tenantId: string, principal: Principal) {
    const [t] = await this.db
      .select()
      .from(teachers)
      .where(
        and(eq(teachers.tenantId, tenantId), eq(teachers.membershipId, principal.membershipId)),
      );
    if (!t) throw new NotFoundError('Teacher');
    const classTeacherOf = await this.db
      .select({
        sectionId: academicSections.id,
        sectionName: academicSections.name,
        classId: academicClasses.id,
        className: academicClasses.name,
        yearCode: academicYears.code,
        since: sectionClassTeachers.startDate,
      })
      .from(sectionClassTeachers)
      .innerJoin(academicSections, eq(academicSections.id, sectionClassTeachers.sectionId))
      .innerJoin(academicClasses, eq(academicClasses.id, academicSections.classId))
      .innerJoin(academicYears, eq(academicYears.id, academicSections.academicYearId))
      .where(
        and(
          eq(sectionClassTeachers.tenantId, tenantId),
          eq(sectionClassTeachers.teacherId, t.id),
          eq(sectionClassTeachers.status, 'ACTIVE'),
          inArray(academicYears.status, ['ACTIVE', 'UPCOMING']),
        ),
      )
      .orderBy(asc(academicClasses.sequence), asc(academicSections.code));
    const teaching = await this.db
      .select({
        id: teachingAssignments.id,
        role: teachingAssignments.role,
        subjectName: subjects.name,
        subjectCode: subjects.code,
        sectionId: academicSections.id,
        sectionName: academicSections.name,
        classId: academicClasses.id,
        className: academicClasses.name,
        yearCode: academicYears.code,
      })
      .from(teachingAssignments)
      .innerJoin(subjectOfferings, eq(subjectOfferings.id, teachingAssignments.subjectOfferingId))
      .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
      .innerJoin(academicClasses, eq(academicClasses.id, subjectOfferings.classId))
      .innerJoin(academicYears, eq(academicYears.id, subjectOfferings.academicYearId))
      .leftJoin(academicSections, eq(academicSections.id, subjectOfferings.sectionId))
      .where(
        and(
          eq(teachingAssignments.tenantId, tenantId),
          eq(teachingAssignments.teacherId, t.id),
          eq(teachingAssignments.status, 'ACTIVE'),
          inArray(academicYears.status, ['ACTIVE', 'UPCOMING']),
        ),
      )
      .orderBy(asc(academicClasses.sequence), asc(subjects.name));
    return {
      teacher: {
        id: t.id,
        teacher_number: t.teacherNumber,
        full_name: fullName(t),
        status: t.status,
      },
      class_teacher_of: classTeacherOf.map((r) => ({
        section_id: r.sectionId,
        section: r.sectionName,
        class_id: r.classId,
        class: r.className,
        academic_year: r.yearCode,
        since: r.since,
      })),
      teaching: teaching.map((r) => ({
        assignment_id: r.id,
        role: r.role,
        subject: { code: r.subjectCode, name: r.subjectName },
        class_id: r.classId,
        class: r.className,
        section_id: r.sectionId,
        section: r.sectionName,
        academic_year: r.yearCode,
      })),
    };
  }
}
