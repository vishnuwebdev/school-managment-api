import { and, asc, count, desc, eq, inArray, like, ne, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  enrollments,
  OPEN_ENROLLMENT_STATUSES,
  subjectOfferings,
  subjects,
} from '../../db/schema/index.js';
import type { Actor } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { todayIso } from '../../shared/dates.js';
import {
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
} from '../../shared/errors.js';
import { offsetOf, orderFrom, pageOf, type PaginationQuery } from '../../shared/pagination.js';
import type {
  ClassListQuery,
  CreateClassBody,
  CreateOfferingBody,
  CreateSectionBody,
  CreateSubjectBody,
  CreateYearBody,
  OfferingListQuery,
  SectionListQuery,
  SubjectListQuery,
  UpdateClassBody,
  UpdateSectionBody,
  UpdateSubjectBody,
  UpdateYearBody,
  YearListQuery,
  ReorderClassesBody,
} from './academic.schemas.js';

export type YearRow = typeof academicYears.$inferSelect;
export type ClassRow = typeof academicClasses.$inferSelect;
export type SectionRow = typeof academicSections.$inferSelect;
export type SubjectRow = typeof subjects.$inferSelect;
export type OfferingRow = typeof subjectOfferings.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const presentYear = (r: YearRow) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  start_date: r.startDate,
  end_date: r.endDate,
  status: r.status,
  is_current: r.isCurrent,
  activated_at: iso(r.activatedAt),
  completed_at: iso(r.completedAt),
  archived_at: iso(r.archivedAt),
  version: r.version,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
});

export const presentClass = (r: ClassRow) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  display_name: r.displayName,
  sequence: r.sequence,
  phase: r.phase,
  language_of_instruction: r.languageOfInstruction,
  promotes_to_class_id: r.promotesToClassId,
  status: r.status,
  version: r.version,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
});

export const presentSubject = (r: SubjectRow) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  subject_type: r.subjectType,
  status: r.status,
  version: r.version,
  created_at: r.createdAt.toISOString(),
  updated_at: r.updatedAt.toISOString(),
});

const dup = (what: string) =>
  new ConflictError('DUPLICATE_RESOURCE', `${what} already exists`, { resource: what });

function versionConflict(current: number) {
  return new ConflictError('CONFLICT', undefined, { current_version: current });
}

const OPEN = [...OPEN_ENROLLMENT_STATUSES];

/**
 * Academic structure: years, classes, sections, subjects, subject offerings.
 * Every read and write is filtered by tenant, so another school's ids are 404.
 * Other domains use the `get*Row` contract methods, never these tables directly.
 */
/** Natural position of a class by name: Nursery < LKG < UKG < Class 1..12. Null = unknown. */
export function classNaturalRank(name: string): number | null {
  const n = name.trim().toLowerCase();
  if (/^(pre-?nursery|playgroup|pre-?school|pp ?1?)$/.test(n)) return 0;
  if (n === 'nursery') return 1;
  if (n === 'lkg' || n === 'kg1' || n === 'kg 1') return 2;
  if (n === 'ukg' || n === 'kg2' || n === 'kg 2') return 3;
  const m = /(\d{1,2})\D*$/.exec(n);
  return m ? 10 + Number(m[1]) : null;
}

export class AcademicService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  // ===========================================================================
  // Contract used by other modules (Students, later Attendance/Exams/Timetable)
  // ===========================================================================

  async getYearRow(tenantId: string, id: string, ex: Executor = this.db, lock = false) {
    const q = ex
      .select()
      .from(academicYears)
      .where(and(eq(academicYears.id, id), eq(academicYears.tenantId, tenantId)));
    const [row] = await (lock ? q.for('update') : q);
    if (!row) throw new NotFoundError('Academic year');
    return row;
  }

  async getClassRow(tenantId: string, id: string, ex: Executor = this.db) {
    const [row] = await ex
      .select()
      .from(academicClasses)
      .where(and(eq(academicClasses.id, id), eq(academicClasses.tenantId, tenantId)));
    if (!row) throw new NotFoundError('Class');
    return row;
  }

  async getSectionRow(tenantId: string, id: string, ex: Executor = this.db, lock = false) {
    const q = ex
      .select()
      .from(academicSections)
      .where(and(eq(academicSections.id, id), eq(academicSections.tenantId, tenantId)));
    const [row] = await (lock ? q.for('update') : q);
    if (!row) throw new NotFoundError('Section');
    return row;
  }

  async getActiveYear(tenantId: string, ex: Executor = this.db) {
    const [row] = await ex
      .select()
      .from(academicYears)
      .where(and(eq(academicYears.tenantId, tenantId), eq(academicYears.isCurrent, true)));
    return row ?? null;
  }

  /** Open (pending/active) enrollments occupying a section. */
  async seatsTaken(tenantId: string, sectionId: string, ex: Executor = this.db, fresh = false) {
    // Under REPEATABLE READ a plain SELECT reads the transaction's snapshot, which was
    // taken before the section lock was won. A locking read sees the latest committed rows.
    const q = ex
      .select({ n: count() })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.sectionId, sectionId),
          inArray(enrollments.status, OPEN),
        ),
      );
    const [r] = await (fresh ? q.for('share') : q);
    return r?.n ?? 0;
  }

  // ===========================================================================
  // Academic years
  // ===========================================================================

  async listYears(tenantId: string, q: z.infer<typeof YearListQuery>) {
    const conds: (SQL | undefined)[] = [eq(academicYears.tenantId, tenantId)];
    if (q.status) conds.push(eq(academicYears.status, q.status));
    if (q.search) {
      const s = `%${q.search}%`;
      conds.push(or(like(academicYears.name, s), like(academicYears.code, s)));
    }
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(academicYears)
        .where(where)
        .orderBy(
          orderFrom(
            q,
            {
              start_date: academicYears.startDate,
              code: academicYears.code,
              status: academicYears.status,
              created_at: academicYears.createdAt,
            },
            'start_date',
          ),
        )
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(academicYears).where(where),
    ]);
    const counts = rows.length
      ? await this.db
          .select({ yearId: academicSections.academicYearId, n: count() })
          .from(academicSections)
          .where(
            and(
              eq(academicSections.tenantId, tenantId),
              inArray(
                academicSections.academicYearId,
                rows.map((r) => r.id),
              ),
              ne(academicSections.status, 'ARCHIVED'),
            ),
          )
          .groupBy(academicSections.academicYearId)
      : [];
    const byYear = new Map(counts.map((c) => [c.yearId, c.n]));
    return pageOf(
      rows.map((r) => ({ ...presentYear(r), section_count: byYear.get(r.id) ?? 0 })),
      total?.n ?? 0,
      q,
    );
  }

  async getYear(tenantId: string, id: string) {
    return presentYear(await this.getYearRow(tenantId, id));
  }

  private assertYearDates(start: string, end: string) {
    if (start >= end)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'The start date must be before the end date',
      );
  }

  async createYear(tenantId: string, input: z.infer<typeof CreateYearBody>, actor: Actor) {
    this.assertYearDates(input.start_date, input.end_date);
    try {
      return await this.db.transaction(async (tx) => {
        const [res] = await tx.insert(academicYears).values({
          tenantId,
          code: input.code,
          name: input.name,
          startDate: input.start_date,
          endDate: input.end_date,
          createdBy: actor.userId,
        });
        void res;
        const [row] = await tx
          .select()
          .from(academicYears)
          .where(and(eq(academicYears.tenantId, tenantId), eq(academicYears.code, input.code)));
        await recordChange(tx, actor, tenantId, {
          action: 'ACADEMIC_YEAR_CREATED',
          entityType: 'academic_year',
          entityId: row!.id,
          event: 'academic_year.created',
          after: presentYear(row!),
        });
        return presentYear(row!);
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) throw dup('Academic year code');
      throw err;
    }
  }

  async updateYear(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateYearBody>,
    actor: Actor,
  ) {
    try {
      return await this.db.transaction(async (tx) => {
        const before = await this.getYearRow(tenantId, id, tx, true);
        if (before.status === 'ARCHIVED')
          throw new BusinessRuleError('INVALID_STATE', 'Archived academic years cannot be changed');
        if (before.status === 'COMPLETED' && (input.code || input.start_date || input.end_date))
          throw new BusinessRuleError(
            'INVALID_STATE',
            'A completed academic year keeps its code and dates; only the name can change',
          );
        const start = input.start_date ?? before.startDate;
        const end = input.end_date ?? before.endDate;
        this.assertYearDates(start, end);
        const [res] = await tx
          .update(academicYears)
          .set({
            code: input.code ?? before.code,
            name: input.name ?? before.name,
            startDate: start,
            endDate: end,
            version: before.version + 1,
          })
          .where(and(eq(academicYears.id, id), eq(academicYears.version, input.version)));
        if (res.affectedRows !== 1) throw versionConflict(before.version);
        const after = await this.getYearRow(tenantId, id, tx);
        await recordChange(tx, actor, tenantId, {
          action: 'ACADEMIC_YEAR_UPDATED',
          entityType: 'academic_year',
          entityId: id,
          event: 'academic_year.updated',
          before: presentYear(before),
          after: presentYear(after),
        });
        return presentYear(after);
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) throw dup('Academic year code');
      throw err;
    }
  }

  /** DRAFT → UPCOMING. */
  async openYear(tenantId: string, id: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const before = await this.getYearRow(tenantId, id, tx, true);
      if (before.status !== 'DRAFT')
        throw new BusinessRuleError('INVALID_STATE', 'Only a draft academic year can be opened');
      if (before.endDate < todayIso(this.deps.clock))
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'This academic year has already ended and cannot be opened',
        );
      return this.moveYear(
        tx,
        before,
        { status: 'UPCOMING' },
        'ACADEMIC_YEAR_OPENED',
        'academic_year.opened',
        actor,
      );
    });
  }

  /**
   * → ACTIVE. Only one year can be current: if another is active the caller must
   * confirm completing it (`complete_current`), and both changes commit together.
   */
  async activateYear(tenantId: string, id: string, complete_current: boolean, actor: Actor) {
    return this.db.transaction(async (tx) => {
      // Lock every year of the school so two admins cannot both activate.
      await tx
        .select({ id: academicYears.id })
        .from(academicYears)
        .where(eq(academicYears.tenantId, tenantId))
        .for('update');
      const before = await this.getYearRow(tenantId, id, tx);
      if (before.status !== 'DRAFT' && before.status !== 'UPCOMING')
        throw new BusinessRuleError(
          'INVALID_STATE',
          'Only a draft or upcoming academic year can be activated',
        );
      const current = await this.getActiveYear(tenantId, tx);
      if (current) {
        if (!complete_current)
          throw new ConflictError(
            'CONFIRMATION_REQUIRED',
            `${current.name} is currently active. Confirm to complete it and activate this year.`,
            { current_year: { id: current.id, name: current.name } },
          );
        await this.completeInternal(tx, current, actor);
      }
      return this.moveYear(
        tx,
        before,
        { status: 'ACTIVE', isCurrent: true, activatedAt: this.deps.clock.now() },
        'ACADEMIC_YEAR_ACTIVATED',
        'academic_year.activated',
        actor,
      );
    });
  }

  /** ACTIVE → COMPLETED. Open enrollments of the year are completed; students stay active. */
  async completeYear(tenantId: string, id: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const before = await this.getYearRow(tenantId, id, tx, true);
      if (before.status !== 'ACTIVE')
        throw new BusinessRuleError(
          'INVALID_STATE',
          'Only the active academic year can be completed',
        );
      return presentYear(await this.completeInternal(tx, before, actor));
    });
  }

  private async completeInternal(tx: Executor, year: YearRow, actor: Actor) {
    const [ended] = await tx
      .update(enrollments)
      .set({ status: 'COMPLETED', endDate: year.endDate })
      .where(
        and(
          eq(enrollments.tenantId, year.tenantId),
          eq(enrollments.academicYearId, year.id),
          inArray(enrollments.status, OPEN),
        ),
      );
    const done = await this.moveYear(
      tx,
      year,
      { status: 'COMPLETED', isCurrent: false, completedAt: this.deps.clock.now() },
      'ACADEMIC_YEAR_COMPLETED',
      'academic_year.completed',
      actor,
      { enrollments_completed: ended.affectedRows },
    );
    return this.getYearRow(year.tenantId, done.id, tx);
  }

  /** COMPLETED → ARCHIVED. */
  async archiveYear(tenantId: string, id: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const before = await this.getYearRow(tenantId, id, tx, true);
      if (before.status !== 'COMPLETED' && before.status !== 'DRAFT')
        throw new BusinessRuleError(
          'INVALID_STATE',
          'Only a completed (or never-used draft) academic year can be archived',
        );
      return this.moveYear(
        tx,
        before,
        { status: 'ARCHIVED', archivedAt: this.deps.clock.now() },
        'ACADEMIC_YEAR_ARCHIVED',
        'academic_year.archived',
        actor,
      );
    });
  }

  private async moveYear(
    tx: Executor,
    before: YearRow,
    set: Partial<typeof academicYears.$inferInsert>,
    action: string,
    event: string,
    actor: Actor,
    payload: Record<string, unknown> = {},
  ) {
    const [res] = await tx
      .update(academicYears)
      .set({ ...set, version: before.version + 1 })
      .where(and(eq(academicYears.id, before.id), eq(academicYears.version, before.version)));
    if (res.affectedRows !== 1) throw versionConflict(before.version);
    const after = await this.getYearRow(before.tenantId, before.id, tx);
    await recordChange(tx, actor, before.tenantId, {
      action,
      entityType: 'academic_year',
      entityId: before.id,
      event,
      before: presentYear(before),
      after: presentYear(after),
      payload: { from_status: before.status, to_status: after.status, ...payload },
    });
    return presentYear(after);
  }

  // ===========================================================================
  // Classes
  // ===========================================================================

  async listClasses(tenantId: string, q: z.infer<typeof ClassListQuery>) {
    const conds: (SQL | undefined)[] = [eq(academicClasses.tenantId, tenantId)];
    if (q.status) conds.push(eq(academicClasses.status, q.status));
    if (q.search) {
      const s = `%${q.search}%`;
      conds.push(or(like(academicClasses.name, s), like(academicClasses.code, s)));
    }
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(academicClasses)
        .where(where)
        .orderBy(
          orderFrom(
            { ...q, order: q.sort ? q.order : 'asc' },
            {
              sequence: academicClasses.sequence,
              name: academicClasses.name,
              code: academicClasses.code,
              created_at: academicClasses.createdAt,
            },
            'sequence',
          ),
          asc(academicClasses.name),
        )
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(academicClasses).where(where),
    ]);
    return pageOf(rows.map(presentClass), total?.n ?? 0, q);
  }

  /**
   * Picks the sequence for a new class. An explicit number wins. Otherwise the
   * class goes in its natural place by name and later classes shift down by one.
   */
  private async placeNewClass(
    tx: Executor,
    tenantId: string,
    name: string,
    explicit: number | undefined,
  ): Promise<number> {
    if (explicit !== undefined) return explicit;
    const rows = await tx
      .select({ id: academicClasses.id, name: academicClasses.name, sequence: academicClasses.sequence })
      .from(academicClasses)
      .where(and(eq(academicClasses.tenantId, tenantId), ne(academicClasses.status, 'ARCHIVED')))
      .orderBy(asc(academicClasses.sequence), asc(academicClasses.name));
    const rank = classNaturalRank(name);
    const at =
      rank === null
        ? rows.length
        : rows.findIndex((r) => {
            const o = classNaturalRank(r.name);
            return o !== null && o > rank;
          });
    const pos = at === -1 ? rows.length : at;
    for (const [i, r] of rows.entries()) {
      const want = i < pos ? i + 1 : i + 2;
      if (r.sequence !== want)
        await tx.update(academicClasses).set({ sequence: want }).where(eq(academicClasses.id, r.id));
    }
    return pos + 1;
  }

  /** Saves a drag-and-drop order: the first id becomes 1, the next 2, and so on. */
  async reorderClasses(
    tenantId: string,
    input: z.infer<typeof ReorderClassesBody>,
    actor: Actor,
  ) {
    const ids = [...new Set(input.ids)];
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: academicClasses.id })
        .from(academicClasses)
        .where(and(eq(academicClasses.tenantId, tenantId), inArray(academicClasses.id, ids)));
      if (rows.length !== ids.length) throw new NotFoundError('Class');
      for (const [i, id] of ids.entries())
        await tx
          .update(academicClasses)
          .set({ sequence: i + 1 })
          .where(and(eq(academicClasses.tenantId, tenantId), eq(academicClasses.id, id)));
      await recordChange(tx, actor, tenantId, {
        action: 'CLASSES_REORDERED',
        entityType: 'class',
        entityId: ids[0]!,
        event: 'class.reordered',
        after: { ids },
      });
      return { ordered: ids.length };
    });
  }

  async getClass(tenantId: string, id: string) {
    return presentClass(await this.getClassRow(tenantId, id));
  }

  async createClass(tenantId: string, input: z.infer<typeof CreateClassBody>, actor: Actor) {
    try {
      return await this.db.transaction(async (tx) => {
        if (input.promotes_to_class_id)
          await this.assertPromotionTarget(tx, tenantId, null, input.promotes_to_class_id);
        const sequence = await this.placeNewClass(tx, tenantId, input.name, input.sequence);
        await tx.insert(academicClasses).values({
          tenantId,
          code: input.code,
          name: input.name,
          displayName: input.display_name ?? null,
          sequence,
          phase: input.phase ?? null,
          languageOfInstruction: input.language_of_instruction ?? null,
          promotesToClassId: input.promotes_to_class_id ?? null,
          createdBy: actor.userId,
        });
        const [row] = await tx
          .select()
          .from(academicClasses)
          .where(and(eq(academicClasses.tenantId, tenantId), eq(academicClasses.code, input.code)));
        await recordChange(tx, actor, tenantId, {
          action: 'CLASS_CREATED',
          entityType: 'class',
          entityId: row!.id,
          event: 'class.created',
          after: presentClass(row!),
        });
        return presentClass(row!);
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) throw dup('Class code');
      throw err;
    }
  }

  async updateClass(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateClassBody>,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const before = await this.getClassRow(tenantId, id, tx);
      if (before.status === 'ARCHIVED')
        throw new BusinessRuleError('INVALID_STATE', 'Archived classes cannot be changed');
      if (input.promotes_to_class_id)
        await this.assertPromotionTarget(tx, tenantId, id, input.promotes_to_class_id);
      const [res] = await tx
        .update(academicClasses)
        .set({
          name: input.name ?? before.name,
          displayName: input.display_name === undefined ? before.displayName : input.display_name,
          sequence: input.sequence ?? before.sequence,
          phase: input.phase === undefined ? before.phase : input.phase,
          languageOfInstruction:
            input.language_of_instruction === undefined
              ? before.languageOfInstruction
              : input.language_of_instruction,
          promotesToClassId:
            input.promotes_to_class_id === undefined
              ? before.promotesToClassId
              : input.promotes_to_class_id,
          status: input.status ?? before.status,
          version: before.version + 1,
        })
        .where(and(eq(academicClasses.id, id), eq(academicClasses.version, input.version)));
      if (res.affectedRows !== 1) throw versionConflict(before.version);
      const after = await this.getClassRow(tenantId, id, tx);
      await recordChange(tx, actor, tenantId, {
        action: 'CLASS_UPDATED',
        entityType: 'class',
        entityId: id,
        event: 'class.updated',
        before: presentClass(before),
        after: presentClass(after),
      });
      return presentClass(after);
    });
  }

  /** A class promotes into another class of the same school, never itself or a chain that loops back. */
  private async assertPromotionTarget(
    tx: Executor,
    tenantId: string,
    selfId: string | null,
    targetId: string,
  ) {
    if (selfId && targetId === selfId)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'A class cannot promote into itself');
    let cursor: string | null = targetId;
    for (let hops = 0; cursor && hops < 50; hops++) {
      const target: ClassRow = await this.getClassRow(tenantId, cursor, tx);
      if (hops === 0 && target.status === 'ARCHIVED')
        throw new BusinessRuleError('INVALID_STATE', 'The promotion target class is archived');
      if (selfId && target.promotesToClassId === selfId)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'That would make the promotion order loop back on itself',
        );
      cursor = target.promotesToClassId;
    }
  }

  async archiveClass(tenantId: string, id: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const before = await this.getClassRow(tenantId, id, tx);
      if (before.status === 'ARCHIVED')
        throw new BusinessRuleError('INVALID_STATE', 'The class is already archived');
      const [inUse] = await tx
        .select({ n: count() })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.tenantId, tenantId),
            eq(enrollments.classId, id),
            inArray(enrollments.status, OPEN),
          ),
        );
      if ((inUse?.n ?? 0) > 0)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'This class still has enrolled students. Move or complete their enrollments first.',
          { enrolled_students: inUse!.n },
        );
      await tx
        .update(academicClasses)
        .set({ status: 'ARCHIVED', version: before.version + 1 })
        .where(and(eq(academicClasses.id, id), eq(academicClasses.version, before.version)));
      const after = await this.getClassRow(tenantId, id, tx);
      await recordChange(tx, actor, tenantId, {
        action: 'CLASS_ARCHIVED',
        entityType: 'class',
        entityId: id,
        event: 'class.archived',
        before: presentClass(before),
        after: presentClass(after),
      });
      return presentClass(after);
    });
  }

  // ===========================================================================
  // Sections (a class grouping inside one academic year)
  // ===========================================================================

  private sectionSelect() {
    return this.db
      .select({
        s: academicSections,
        className: academicClasses.name,
        classCode: academicClasses.code,
        yearCode: academicYears.code,
        yearName: academicYears.name,
        enrolled: sql<number>`(select count(*) from ${enrollments} e where e.section_id = ${academicSections.id} and e.status in ('PENDING','ACTIVE'))`,
      })
      .from(academicSections)
      .innerJoin(academicClasses, eq(academicClasses.id, academicSections.classId))
      .innerJoin(academicYears, eq(academicYears.id, academicSections.academicYearId));
  }

  private presentSection(r: {
    s: SectionRow;
    className: string;
    classCode: string;
    yearCode: string;
    yearName: string;
    enrolled: number;
  }) {
    const enrolled = Number(r.enrolled);
    return {
      id: r.s.id,
      academic_year: { id: r.s.academicYearId, code: r.yearCode, name: r.yearName },
      class: { id: r.s.classId, code: r.classCode, name: r.className },
      code: r.s.code,
      name: r.s.name,
      capacity: r.s.capacity,
      room: r.s.room,
      enrolled_count: enrolled,
      seats_available: r.s.capacity === null ? null : Math.max(0, r.s.capacity - enrolled),
      status: r.s.status,
      version: r.s.version,
      created_at: r.s.createdAt.toISOString(),
      updated_at: r.s.updatedAt.toISOString(),
    };
  }

  async listSections(tenantId: string, q: z.infer<typeof SectionListQuery>) {
    const conds: (SQL | undefined)[] = [eq(academicSections.tenantId, tenantId)];
    if (q.academic_year_id) conds.push(eq(academicSections.academicYearId, q.academic_year_id));
    if (q.class_id) conds.push(eq(academicSections.classId, q.class_id));
    if (q.status) conds.push(eq(academicSections.status, q.status));
    if (q.search) {
      const s = `%${q.search}%`;
      conds.push(or(like(academicSections.name, s), like(academicSections.code, s)));
    }
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.sectionSelect()
        .where(where)
        .orderBy(
          asc(academicClasses.sequence),
          asc(academicClasses.name),
          asc(academicSections.code),
        )
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(academicSections).where(where),
    ]);
    return pageOf(
      rows.map((r) => this.presentSection(r)),
      total?.n ?? 0,
      q,
    );
  }

  async getSection(tenantId: string, id: string, ex?: Executor) {
    void ex;
    const [row] = await this.sectionSelect().where(
      and(eq(academicSections.id, id), eq(academicSections.tenantId, tenantId)),
    );
    if (!row) throw new NotFoundError('Section');
    return this.presentSection(row);
  }

  async createSection(
    tenantId: string,
    yearId: string,
    input: z.infer<typeof CreateSectionBody>,
    actor: Actor,
  ) {
    try {
      const id = await this.db.transaction(async (tx) => {
        const year = await this.getYearRow(tenantId, yearId, tx);
        if (year.status === 'COMPLETED' || year.status === 'ARCHIVED')
          throw new BusinessRuleError(
            'INVALID_STATE',
            'Sections cannot be added to a completed or archived academic year',
          );
        const klass = await this.getClassRow(tenantId, input.class_id, tx);
        if (klass.status !== 'ACTIVE')
          throw new BusinessRuleError('INVALID_STATE', 'The class is not active');
        await tx.insert(academicSections).values({
          tenantId,
          academicYearId: yearId,
          classId: input.class_id,
          code: input.code,
          name: input.name,
          capacity: input.capacity ?? null,
          room: input.room ?? null,
          status: input.status,
          createdBy: actor.userId,
        });
        const [row] = await tx
          .select()
          .from(academicSections)
          .where(
            and(
              eq(academicSections.tenantId, tenantId),
              eq(academicSections.academicYearId, yearId),
              eq(academicSections.classId, input.class_id),
              eq(academicSections.code, input.code),
            ),
          );
        await recordChange(tx, actor, tenantId, {
          action: 'SECTION_CREATED',
          entityType: 'section',
          entityId: row!.id,
          event: 'section.created',
          after: { ...row, tenantId: undefined },
          payload: { academic_year_id: yearId, class_id: input.class_id },
        });
        return row!.id;
      });
      return this.getSection(tenantId, id);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw dup('Section code in this class and year');
      throw err;
    }
  }

  async updateSection(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateSectionBody>,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const before = await this.getSectionRow(tenantId, id, tx, true);
      if (before.status === 'ARCHIVED')
        throw new BusinessRuleError('INVALID_STATE', 'Archived sections cannot be changed');
      const capacity = input.capacity === undefined ? before.capacity : input.capacity;
      if (capacity !== null) {
        const taken = await this.seatsTaken(tenantId, id, tx, true);
        if (capacity < taken)
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            `Capacity cannot be lower than the ${taken} students already enrolled`,
            { enrolled_count: taken },
          );
      }
      const [res] = await tx
        .update(academicSections)
        .set({
          name: input.name ?? before.name,
          capacity,
          room: input.room === undefined ? before.room : input.room,
          version: before.version + 1,
        })
        .where(and(eq(academicSections.id, id), eq(academicSections.version, input.version)));
      if (res.affectedRows !== 1) throw versionConflict(before.version);
      const after = await this.getSectionRow(tenantId, id, tx);
      await recordChange(tx, actor, tenantId, {
        action: 'SECTION_UPDATED',
        entityType: 'section',
        entityId: id,
        event: 'section.updated',
        before: { name: before.name, capacity: before.capacity },
        after: { name: after.name, capacity: after.capacity },
      });
    });
    return this.getSection(tenantId, id);
  }

  /** activate: DRAFT|CLOSED → ACTIVE, close: ACTIVE → CLOSED, archive: DRAFT|CLOSED → ARCHIVED. */
  async transitionSection(
    tenantId: string,
    id: string,
    command: 'activate' | 'close' | 'archive',
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const before = await this.getSectionRow(tenantId, id, tx, true);
      const rules = {
        activate: { from: ['DRAFT', 'CLOSED'], to: 'ACTIVE', event: 'section.activated' },
        close: { from: ['ACTIVE'], to: 'CLOSED', event: 'section.closed' },
        archive: { from: ['DRAFT', 'CLOSED'], to: 'ARCHIVED', event: 'section.archived' },
      } as const;
      const rule = rules[command];
      if (!(rule.from as readonly string[]).includes(before.status))
        throw new BusinessRuleError(
          'INVALID_STATE',
          `A ${before.status.toLowerCase()} section cannot be ${command === 'close' ? 'closed' : command + 'd'}`,
        );
      if (command === 'activate') {
        const year = await this.getYearRow(tenantId, before.academicYearId, tx);
        if (year.status === 'COMPLETED' || year.status === 'ARCHIVED')
          throw new BusinessRuleError('INVALID_STATE', 'The academic year is no longer open');
      }
      if (command === 'archive') {
        const taken = await this.seatsTaken(tenantId, id, tx, true);
        if (taken > 0)
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            'This section still has enrolled students',
            { enrolled_count: taken },
          );
      }
      await tx
        .update(academicSections)
        .set({ status: rule.to, version: before.version + 1 })
        .where(and(eq(academicSections.id, id), eq(academicSections.version, before.version)));
      await recordChange(tx, actor, tenantId, {
        action: `SECTION_${rule.to}`,
        entityType: 'section',
        entityId: id,
        event: rule.event,
        before: { status: before.status },
        after: { status: rule.to },
      });
    });
    return this.getSection(tenantId, id);
  }

  // ===========================================================================
  // Subjects
  // ===========================================================================

  async listSubjects(tenantId: string, q: z.infer<typeof SubjectListQuery>) {
    const conds: (SQL | undefined)[] = [eq(subjects.tenantId, tenantId)];
    if (q.status) conds.push(eq(subjects.status, q.status));
    if (q.subject_type) conds.push(eq(subjects.subjectType, q.subject_type));
    if (q.search) {
      const s = `%${q.search}%`;
      conds.push(or(like(subjects.name, s), like(subjects.code, s)));
    }
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(subjects)
        .where(where)
        .orderBy(
          orderFrom(
            { ...q, order: q.sort ? q.order : 'asc' },
            { name: subjects.name, code: subjects.code, created_at: subjects.createdAt },
            'name',
          ),
        )
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(subjects).where(where),
    ]);
    return pageOf(rows.map(presentSubject), total?.n ?? 0, q);
  }

  private async getSubjectRow(tenantId: string, id: string, ex: Executor = this.db) {
    const [row] = await ex
      .select()
      .from(subjects)
      .where(and(eq(subjects.id, id), eq(subjects.tenantId, tenantId)));
    if (!row) throw new NotFoundError('Subject');
    return row;
  }

  async getSubject(tenantId: string, id: string) {
    return presentSubject(await this.getSubjectRow(tenantId, id));
  }

  async createSubject(tenantId: string, input: z.infer<typeof CreateSubjectBody>, actor: Actor) {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.insert(subjects).values({
          tenantId,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          subjectType: input.subject_type,
          createdBy: actor.userId,
        });
        const [row] = await tx
          .select()
          .from(subjects)
          .where(and(eq(subjects.tenantId, tenantId), eq(subjects.code, input.code)));
        await recordChange(tx, actor, tenantId, {
          action: 'SUBJECT_CREATED',
          entityType: 'subject',
          entityId: row!.id,
          event: 'subject.created',
          after: presentSubject(row!),
        });
        return presentSubject(row!);
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) throw dup('Subject code');
      throw err;
    }
  }

  async updateSubject(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateSubjectBody>,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const before = await this.getSubjectRow(tenantId, id, tx);
      if (before.status === 'ARCHIVED')
        throw new BusinessRuleError('INVALID_STATE', 'Archived subjects cannot be changed');
      const [res] = await tx
        .update(subjects)
        .set({
          name: input.name ?? before.name,
          description: input.description === undefined ? before.description : input.description,
          subjectType: input.subject_type ?? before.subjectType,
          version: before.version + 1,
        })
        .where(and(eq(subjects.id, id), eq(subjects.version, input.version)));
      if (res.affectedRows !== 1) throw versionConflict(before.version);
      const after = await this.getSubjectRow(tenantId, id, tx);
      await recordChange(tx, actor, tenantId, {
        action: 'SUBJECT_UPDATED',
        entityType: 'subject',
        entityId: id,
        event: 'subject.updated',
        before: presentSubject(before),
        after: presentSubject(after),
      });
      return presentSubject(after);
    });
  }

  /** Archiving a subject also deactivates its offerings (nothing new can be built on it). */
  async archiveSubject(tenantId: string, id: string, actor: Actor) {
    return this.db.transaction(async (tx) => {
      const before = await this.getSubjectRow(tenantId, id, tx);
      if (before.status === 'ARCHIVED')
        throw new BusinessRuleError('INVALID_STATE', 'The subject is already archived');
      const [off] = await tx
        .update(subjectOfferings)
        .set({ status: 'INACTIVE' })
        .where(
          and(
            eq(subjectOfferings.tenantId, tenantId),
            eq(subjectOfferings.subjectId, id),
            eq(subjectOfferings.status, 'ACTIVE'),
          ),
        );
      await tx
        .update(subjects)
        .set({ status: 'ARCHIVED', version: before.version + 1 })
        .where(and(eq(subjects.id, id), eq(subjects.version, before.version)));
      const after = await this.getSubjectRow(tenantId, id, tx);
      await recordChange(tx, actor, tenantId, {
        action: 'SUBJECT_ARCHIVED',
        entityType: 'subject',
        entityId: id,
        event: 'subject.archived',
        before: presentSubject(before),
        after: presentSubject(after),
        payload: { offerings_deactivated: off.affectedRows },
      });
      return presentSubject(after);
    });
  }

  // ===========================================================================
  // Subject offerings
  // ===========================================================================

  private offeringSelect() {
    return this.db
      .select({
        o: subjectOfferings,
        subjectName: subjects.name,
        subjectCode: subjects.code,
        className: academicClasses.name,
        classCode: academicClasses.code,
        yearCode: academicYears.code,
        sectionName: academicSections.name,
        sectionCode: academicSections.code,
      })
      .from(subjectOfferings)
      .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
      .innerJoin(academicClasses, eq(academicClasses.id, subjectOfferings.classId))
      .innerJoin(academicYears, eq(academicYears.id, subjectOfferings.academicYearId))
      .leftJoin(academicSections, eq(academicSections.id, subjectOfferings.sectionId));
  }

  private presentOffering(r: Awaited<ReturnType<AcademicService['offeringSelect']>>[number]) {
    return {
      id: r.o.id,
      academic_year: { id: r.o.academicYearId, code: r.yearCode },
      subject: { id: r.o.subjectId, code: r.subjectCode, name: r.subjectName },
      class: { id: r.o.classId, code: r.classCode, name: r.className },
      section: r.o.sectionId
        ? { id: r.o.sectionId, code: r.sectionCode, name: r.sectionName }
        : null,
      scope: r.o.sectionId ? 'SECTION' : 'CLASS',
      status: r.o.status,
      version: r.o.version,
      created_at: r.o.createdAt.toISOString(),
    };
  }

  async listOfferings(tenantId: string, q: z.infer<typeof OfferingListQuery>) {
    const conds: (SQL | undefined)[] = [eq(subjectOfferings.tenantId, tenantId)];
    if (q.academic_year_id) conds.push(eq(subjectOfferings.academicYearId, q.academic_year_id));
    if (q.class_id) conds.push(eq(subjectOfferings.classId, q.class_id));
    if (q.section_id) conds.push(eq(subjectOfferings.sectionId, q.section_id));
    if (q.subject_id) conds.push(eq(subjectOfferings.subjectId, q.subject_id));
    if (q.status) conds.push(eq(subjectOfferings.status, q.status));
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.offeringSelect()
        .where(where)
        .orderBy(
          asc(academicClasses.sequence),
          asc(subjects.name),
          desc(subjectOfferings.createdAt),
        )
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(subjectOfferings).where(where),
    ]);
    return pageOf(
      rows.map((r) => this.presentOffering(r)),
      total?.n ?? 0,
      q,
    );
  }

  async getOffering(tenantId: string, id: string) {
    const [row] = await this.offeringSelect().where(
      and(eq(subjectOfferings.id, id), eq(subjectOfferings.tenantId, tenantId)),
    );
    if (!row) throw new NotFoundError('Subject offering');
    return this.presentOffering(row);
  }

  async createOffering(tenantId: string, input: z.infer<typeof CreateOfferingBody>, actor: Actor) {
    try {
      const id = await this.db.transaction(async (tx) => {
        const year = await this.getYearRow(tenantId, input.academic_year_id, tx);
        if (year.status === 'COMPLETED' || year.status === 'ARCHIVED')
          throw new BusinessRuleError('INVALID_STATE', 'The academic year is no longer open');
        const subject = await this.getSubjectRow(tenantId, input.subject_id, tx);
        if (subject.status !== 'ACTIVE')
          throw new BusinessRuleError('INVALID_STATE', 'The subject is archived');
        const klass = await this.getClassRow(tenantId, input.class_id, tx);
        if (klass.status !== 'ACTIVE')
          throw new BusinessRuleError('INVALID_STATE', 'The class is not active');
        if (input.section_id) {
          const section = await this.getSectionRow(tenantId, input.section_id, tx);
          if (section.academicYearId !== year.id || section.classId !== klass.id)
            throw new BusinessRuleError(
              'OPERATION_NOT_ALLOWED',
              'The section does not belong to that class and academic year',
            );
        }
        await tx.insert(subjectOfferings).values({
          tenantId,
          academicYearId: year.id,
          subjectId: subject.id,
          classId: klass.id,
          sectionId: input.section_id ?? null,
          createdBy: actor.userId,
        });
        const [row] = await tx
          .select()
          .from(subjectOfferings)
          .where(
            and(
              eq(subjectOfferings.tenantId, tenantId),
              eq(subjectOfferings.academicYearId, year.id),
              eq(subjectOfferings.subjectId, subject.id),
              eq(subjectOfferings.classId, klass.id),
              input.section_id
                ? eq(subjectOfferings.sectionId, input.section_id)
                : sql`${subjectOfferings.sectionId} is null`,
            ),
          );
        await recordChange(tx, actor, tenantId, {
          action: 'SUBJECT_OFFERING_CREATED',
          entityType: 'subject_offering',
          entityId: row!.id,
          event: 'subject_offering.created',
          payload: {
            academic_year_id: year.id,
            subject_id: subject.id,
            class_id: klass.id,
            section_id: input.section_id ?? null,
          },
        });
        return row!.id;
      });
      return this.getOffering(tenantId, id);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw dup('Subject offering');
      throw err;
    }
  }

  async setOfferingStatus(
    tenantId: string,
    id: string,
    status: 'ACTIVE' | 'INACTIVE',
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(subjectOfferings)
        .where(and(eq(subjectOfferings.id, id), eq(subjectOfferings.tenantId, tenantId)))
        .for('update');
      if (!before) throw new NotFoundError('Subject offering');
      if (before.status === status)
        throw new BusinessRuleError(
          'INVALID_STATE',
          `The offering is already ${status.toLowerCase()}`,
        );
      if (status === 'ACTIVE') {
        const subject = await this.getSubjectRow(tenantId, before.subjectId, tx);
        const year = await this.getYearRow(tenantId, before.academicYearId, tx);
        if (
          subject.status !== 'ACTIVE' ||
          year.status === 'COMPLETED' ||
          year.status === 'ARCHIVED'
        )
          throw new BusinessRuleError(
            'INVALID_STATE',
            'The subject is archived or the academic year is no longer open',
          );
      }
      await tx
        .update(subjectOfferings)
        .set({ status, version: before.version + 1 })
        .where(eq(subjectOfferings.id, id));
      await recordChange(tx, actor, tenantId, {
        action: status === 'ACTIVE' ? 'SUBJECT_OFFERING_ACTIVATED' : 'SUBJECT_OFFERING_DEACTIVATED',
        entityType: 'subject_offering',
        entityId: id,
        event: status === 'ACTIVE' ? 'subject_offering.activated' : 'subject_offering.deactivated',
        before: { status: before.status },
        after: { status },
      });
    });
    return this.getOffering(tenantId, id);
  }
}

// Re-exported so routes and tests share one definition.
export type { PaginationQuery };
