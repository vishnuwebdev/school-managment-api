import { and, asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import { teacherQualifications } from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors.js';
import type { QualificationBody, UpdateQualificationBody } from './teachers.schemas.js';
import { addTeacherHistory, loadTeacher } from './support.js';

type QualificationRow = typeof teacherQualifications.$inferSelect;

export const presentQualification = (q: QualificationRow) => ({
  id: q.id,
  teacher_id: q.teacherId,
  type: q.qualificationType,
  title: q.title,
  institution: q.institution,
  field_of_study: q.fieldOfStudy,
  completion_year: q.completionYear,
  status: q.status,
  version: q.version,
  created_at: q.createdAt.toISOString(),
  updated_at: q.updatedAt.toISOString(),
});

export class QualificationService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  /** Active (not removed) qualifications of a teacher. Caller has already authorised the teacher. */
  async forTeacher(tenantId: string, teacherId: string, ex: Executor = this.db) {
    const rows = await ex
      .select()
      .from(teacherQualifications)
      .where(
        and(
          eq(teacherQualifications.tenantId, tenantId),
          eq(teacherQualifications.teacherId, teacherId),
          eq(teacherQualifications.status, 'ACTIVE'),
        ),
      )
      .orderBy(asc(teacherQualifications.completionYear), asc(teacherQualifications.createdAt));
    return rows.map(presentQualification);
  }

  async list(tenantId: string, teacherId: string, principal: Principal) {
    await loadTeacher(this.db, tenantId, teacherId, principal, 'teachers.read');
    return this.forTeacher(tenantId, teacherId);
  }

  /** Insert qualifications for a teacher inside the caller's transaction (audited per row). */
  async insertInTx(
    tx: Executor,
    tenantId: string,
    teacherId: string,
    items: z.infer<typeof QualificationBody>[],
    actor: Actor,
  ): Promise<QualificationRow[]> {
    const out: QualificationRow[] = [];
    for (const q of items) {
      const [ins] = await tx
        .insert(teacherQualifications)
        .values({
          tenantId,
          teacherId,
          qualificationType: q.type,
          title: q.title,
          institution: q.institution ?? null,
          fieldOfStudy: q.field_of_study ?? null,
          completionYear: q.completion_year ?? null,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .$returningId();
      const [row] = await tx
        .select()
        .from(teacherQualifications)
        .where(eq(teacherQualifications.id, ins!.id));
      await addTeacherHistory(tx, actor, tenantId, teacherId, {
        eventType: 'QUALIFICATION_ADDED',
        details: { qualification_id: row!.id, type: row!.qualificationType, title: row!.title },
      });
      await recordChange(tx, actor, tenantId, {
        action: 'TEACHER_QUALIFICATION_ADDED',
        entityType: 'teacher_qualification',
        entityId: row!.id,
        event: 'teacher.qualification_added',
        after: presentQualification(row!),
        payload: { teacher_id: teacherId },
      });
      out.push(row!);
    }
    return out;
  }

  async add(
    tenantId: string,
    teacherId: string,
    input: z.infer<typeof QualificationBody>,
    principal: Principal,
    actor: Actor,
  ) {
    const id = await this.db.transaction(async (tx) => {
      const teacher = await loadTeacher(tx, tenantId, teacherId, principal, 'teachers.update', {
        lock: true,
      });
      if (teacher.status === 'ARCHIVED')
        throw new BusinessRuleError('INVALID_STATE', 'Archived teachers cannot be edited');
      const [row] = await this.insertInTx(tx, tenantId, teacherId, [input], actor);
      return row!.id;
    });
    return this.get(tenantId, teacherId, id);
  }

  private async get(tenantId: string, teacherId: string, id: string, ex: Executor = this.db) {
    const [row] = await ex
      .select()
      .from(teacherQualifications)
      .where(
        and(
          eq(teacherQualifications.id, id),
          eq(teacherQualifications.tenantId, tenantId),
          eq(teacherQualifications.teacherId, teacherId),
        ),
      );
    if (!row) throw new NotFoundError('Qualification');
    return presentQualification(row);
  }

  /** Lock the teacher, then the qualification (404 if it belongs to another teacher or school). */
  private async lockPair(
    tx: Executor,
    tenantId: string,
    teacherId: string,
    id: string,
    principal: Principal,
  ) {
    const teacher = await loadTeacher(tx, tenantId, teacherId, principal, 'teachers.update', {
      lock: true,
    });
    const [row] = await tx
      .select()
      .from(teacherQualifications)
      .where(
        and(
          eq(teacherQualifications.id, id),
          eq(teacherQualifications.tenantId, tenantId),
          eq(teacherQualifications.teacherId, teacherId),
          eq(teacherQualifications.status, 'ACTIVE'),
        ),
      )
      .for('update');
    if (!row) throw new NotFoundError('Qualification');
    if (teacher.status === 'ARCHIVED')
      throw new BusinessRuleError('INVALID_STATE', 'Archived teachers cannot be edited');
    return row;
  }

  async update(
    tenantId: string,
    teacherId: string,
    id: string,
    input: z.infer<typeof UpdateQualificationBody>,
    principal: Principal,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const before = await this.lockPair(tx, tenantId, teacherId, id, principal);
      const pick = <T>(v: T | undefined, cur: T) => (v === undefined ? cur : v);
      const [res] = await tx
        .update(teacherQualifications)
        .set({
          qualificationType: input.type ?? before.qualificationType,
          title: input.title ?? before.title,
          institution: pick(input.institution, before.institution),
          fieldOfStudy: pick(input.field_of_study, before.fieldOfStudy),
          completionYear: pick(input.completion_year, before.completionYear),
          version: before.version + 1,
          updatedBy: actor.userId,
        })
        .where(
          and(eq(teacherQualifications.id, id), eq(teacherQualifications.version, input.version)),
        );
      if (res.affectedRows !== 1)
        throw new ConflictError('CONFLICT', undefined, { current_version: before.version });
      const [after] = await tx
        .select()
        .from(teacherQualifications)
        .where(eq(teacherQualifications.id, id));
      await addTeacherHistory(tx, actor, tenantId, teacherId, {
        eventType: 'QUALIFICATION_UPDATED',
        details: { qualification_id: id },
      });
      await recordChange(tx, actor, tenantId, {
        action: 'TEACHER_QUALIFICATION_UPDATED',
        entityType: 'teacher_qualification',
        entityId: id,
        event: 'teacher.qualification_updated',
        before: presentQualification(before),
        after: presentQualification(after!),
        payload: { teacher_id: teacherId },
      });
    });
    return this.get(tenantId, teacherId, id);
  }

  /** Removal keeps the row (status REMOVED) so the audit trail stays complete. */
  async remove(
    tenantId: string,
    teacherId: string,
    id: string,
    principal: Principal,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const before = await this.lockPair(tx, tenantId, teacherId, id, principal);
      await tx
        .update(teacherQualifications)
        .set({ status: 'REMOVED', version: before.version + 1, updatedBy: actor.userId })
        .where(eq(teacherQualifications.id, id));
      await addTeacherHistory(tx, actor, tenantId, teacherId, {
        eventType: 'QUALIFICATION_REMOVED',
        details: { qualification_id: id, title: before.title },
      });
      await recordChange(tx, actor, tenantId, {
        action: 'TEACHER_QUALIFICATION_REMOVED',
        entityType: 'teacher_qualification',
        entityId: id,
        event: 'teacher.qualification_removed',
        before: presentQualification(before),
        after: { status: 'REMOVED' },
        payload: { teacher_id: teacherId },
      });
    });
  }
}
