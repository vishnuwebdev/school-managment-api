import { and, desc, eq, inArray, ne, sql, count } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicYears,
  teachingAssignments,
  timetableEntries,
  timetables,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { BusinessRuleError, ConflictError, isDuplicateKeyError } from '../../shared/errors.js';
import { offsetOf, pageOf } from '../../shared/pagination.js';
import { runCheck, type CheckResult } from './check.js';
import type { TimetableConfigService } from './config.service.js';
import type {
  ArchiveBody,
  CreateTimetableBody,
  DuplicateTimetableBody,
  PublishBody,
  TimetableListQuery,
  UpdateTimetableBody,
} from './timetable.schemas.js';
import {
  addDays,
  entryCounts,
  loadTimetable,
  loadYear,
  presentTimetable,
  readSettings,
  requireWide,
  schoolToday,
  validationIssue,
  type TimetableRow,
  type TimetableView,
} from './support.js';

const OPEN_YEAR = ['UPCOMING', 'ACTIVE'];

/**
 * Timetable versions and their lifecycle: DRAFT (editable) → PUBLISHED
 * (read-only, one per academic year) → ARCHIVED. Every transition is an explicit
 * command; publishing archives the version it replaces in the same transaction.
 *
 * Lock order (always): academic year → timetable → (previously published timetable).
 * Entry edits take only their own timetable, so they never cross this order.
 */
export class TimetableService {
  constructor(
    private readonly deps: Deps,
    private readonly config: TimetableConfigService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  // ---- reads ---------------------------------------------------------------------

  private async present(
    ex: Executor,
    tenantId: string,
    rows: TimetableRow[],
  ): Promise<TimetableView[]> {
    if (!rows.length) return [];
    const years = new Map(
      (
        await ex
          .select()
          .from(academicYears)
          .where(
            and(
              eq(academicYears.tenantId, tenantId),
              inArray(academicYears.id, [...new Set(rows.map((r) => r.academicYearId))]),
            ),
          )
      ).map((y) => [y.id, y]),
    );
    const counts = await entryCounts(
      ex,
      tenantId,
      rows.map((r) => r.id),
    );
    return rows.map((r) =>
      presentTimetable(r, years.get(r.academicYearId)!, counts.get(r.id) ?? 0),
    );
  }

  async list(tenantId: string, q: z.infer<typeof TimetableListQuery>, principal: Principal) {
    const where = and(
      eq(timetables.tenantId, tenantId),
      q.academic_year_id ? eq(timetables.academicYearId, q.academic_year_id) : undefined,
      q.status ? eq(timetables.status, q.status) : undefined,
      // Drafts are work in progress: only editors see them.
      principal.permissions.has('timetable.manage') ||
        principal.permissions.has('timetable.publish')
        ? undefined
        : ne(timetables.status, 'DRAFT'),
    );
    const [rows, [total]] = await Promise.all([
      this.db
        .select({ t: timetables })
        .from(timetables)
        .innerJoin(academicYears, eq(academicYears.id, timetables.academicYearId))
        .where(where)
        .orderBy(desc(academicYears.startDate), desc(timetables.versionNo))
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(timetables).where(where),
    ]);
    return pageOf(
      await this.present(
        this.db,
        tenantId,
        rows.map((r) => r.t),
      ),
      total?.n ?? 0,
      q,
    );
  }

  async get(tenantId: string, id: string, principal: Principal, ex: Executor = this.db) {
    const tt = await loadTimetable(ex, tenantId, id, principal);
    return (await this.present(ex, tenantId, [tt]))[0]!;
  }

  /** Every rule, evaluated now: clashes, broken references, completeness. Read-only. */
  async check(
    tenantId: string,
    id: string,
    principal: Principal,
    strict = false,
  ): Promise<CheckResult> {
    requireWide(principal, 'timetable.read');
    await this.config.ensureSettings(tenantId);
    const tt = await loadTimetable(this.db, tenantId, id, principal);
    return runCheck(this.db, tenantId, tt, await readSettings(this.db, tenantId), { strict });
  }

  // ---- create / duplicate ------------------------------------------------------------

  private assertDatesInYear(
    year: { startDate: string; endDate: string },
    from?: string | null,
    to?: string | null,
  ) {
    if (from && (from < year.startDate || from > year.endDate))
      throw validationIssue('effective_from', 'The date must fall inside the academic year');
    if (to && (to < year.startDate || to > year.endDate))
      throw validationIssue('effective_to', 'The date must fall inside the academic year');
  }

  async create(
    tenantId: string,
    input: z.infer<typeof CreateTimetableBody>,
    principal: Principal,
    actor: Actor,
  ) {
    requireWide(principal, 'timetable.manage');
    let id!: string;
    await this.db.transaction(async (tx) => {
      const year = await loadYear(tx, tenantId, input.academic_year_id, 'update');
      if (!OPEN_YEAR.includes(year.status))
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'Timetables can only be created for an upcoming or active academic year',
          { reason: 'YEAR_NOT_OPEN', academic_year_status: year.status },
        );
      this.assertDatesInYear(year, input.effective_from, input.effective_to);
      let source: TimetableRow | null = null;
      if (input.copy_from_id) {
        source = await loadTimetable(tx, tenantId, input.copy_from_id, principal, {
          lock: 'share',
        });
        if (source.academicYearId !== year.id)
          throw validationIssue(
            'copy_from_id',
            'The version to copy belongs to another academic year',
          );
      }
      const [max] = await tx
        .select({ n: sql<number>`coalesce(max(${timetables.versionNo}), 0)` })
        .from(timetables)
        .where(and(eq(timetables.tenantId, tenantId), eq(timetables.academicYearId, year.id)))
        .for('update');
      const versionNo = Number(max?.n ?? 0) + 1;
      id = uuidv7();
      try {
        await tx.insert(timetables).values({
          id,
          tenantId,
          academicYearId: year.id,
          name: input.name,
          status: 'DRAFT',
          versionNo,
          effectiveFrom: input.effective_from ?? null,
          effectiveTo: input.effective_to ?? null,
          notes: input.notes ?? null,
          copiedFromId: source?.id ?? null,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        });
      } catch (err) {
        if (isDuplicateKeyError(err))
          throw new ConflictError(
            'CONFLICT',
            'Another version was created at the same time. Try again.',
            { reason: 'VERSION_RACE' },
          );
        throw err;
      }
      const copy = source
        ? await this.copyEntries(tx, tenantId, source.id, id, year.id, actor)
        : null;
      const view = (
        await this.present(tx, tenantId, [await loadTimetable(tx, tenantId, id, principal)])
      )[0]!;
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_CREATED',
        entityType: 'timetable',
        entityId: id,
        event: 'timetable.created',
        after: view,
        payload: {
          academic_year_id: year.id,
          version_no: versionNo,
          copied_from_id: source?.id ?? null,
          entries_copied: copy?.copied ?? 0,
          assignments_remapped: copy?.remapped ?? 0,
        },
      });
    });
    return this.get(tenantId, id, principal);
  }

  /** New draft version copied from an existing one of the same year. */
  async duplicate(
    tenantId: string,
    sourceId: string,
    input: z.infer<typeof DuplicateTimetableBody>,
    principal: Principal,
    actor: Actor,
  ) {
    const src = await loadTimetable(this.db, tenantId, sourceId, principal);
    return this.create(
      tenantId,
      {
        academic_year_id: src.academicYearId,
        name: input.name ?? `${src.name} (copy)`.slice(0, 120),
        copy_from_id: src.id,
        effective_from: null,
        effective_to: null,
        notes: null,
      },
      principal,
      actor,
    );
  }

  /**
   * Copy the ACTIVE entries of `sourceId`. An entry whose teaching assignment has ended is
   * re-pointed at the same teacher's current assignment for the offering when there is one;
   * otherwise it is copied as is and the check report / publish flags it.
   */
  private async copyEntries(
    tx: Executor,
    tenantId: string,
    sourceId: string,
    targetId: string,
    yearId: string,
    actor: Actor,
  ) {
    const src = await tx
      .select()
      .from(timetableEntries)
      .where(
        and(
          eq(timetableEntries.tenantId, tenantId),
          eq(timetableEntries.timetableId, sourceId),
          eq(timetableEntries.status, 'ACTIVE'),
        ),
      )
      .for('share');
    if (!src.length) return { copied: 0, remapped: 0 };
    const assignments = new Map(
      (
        await tx
          .select()
          .from(teachingAssignments)
          .where(
            and(
              eq(teachingAssignments.tenantId, tenantId),
              inArray(teachingAssignments.id, [...new Set(src.map((e) => e.teachingAssignmentId))]),
            ),
          )
          .for('share')
      ).map((a) => [a.id, a]),
    );
    const stale = src.filter((e) => assignments.get(e.teachingAssignmentId)?.status !== 'ACTIVE');
    const current = stale.length
      ? await tx
          .select()
          .from(teachingAssignments)
          .where(
            and(
              eq(teachingAssignments.tenantId, tenantId),
              eq(teachingAssignments.status, 'ACTIVE'),
              inArray(teachingAssignments.subjectOfferingId, [
                ...new Set(stale.map((e) => e.subjectOfferingId)),
              ]),
            ),
          )
          .for('share')
      : [];
    let remapped = 0;
    const rows = src.map((e) => {
      let assignmentId = e.teachingAssignmentId;
      if (assignments.get(assignmentId)?.status !== 'ACTIVE') {
        const now = current.find(
          (a) => a.teacherId === e.teacherId && a.subjectOfferingId === e.subjectOfferingId,
        );
        if (now) {
          assignmentId = now.id;
          remapped++;
        }
      }
      return {
        id: uuidv7(),
        tenantId,
        timetableId: targetId,
        academicYearId: yearId,
        dayOfWeek: e.dayOfWeek,
        periodId: e.periodId,
        sectionId: e.sectionId,
        subjectOfferingId: e.subjectOfferingId,
        teachingAssignmentId: assignmentId,
        teacherId: e.teacherId,
        venueId: e.venueId,
        status: 'ACTIVE' as const,
        createdBy: actor.userId,
        updatedBy: actor.userId,
      };
    });
    for (let i = 0; i < rows.length; i += 200)
      await tx.insert(timetableEntries).values(rows.slice(i, i + 200));
    return { copied: rows.length, remapped };
  }

  // ---- edit (draft only) ------------------------------------------------------------------

  async update(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateTimetableBody>,
    principal: Principal,
    actor: Actor,
  ) {
    requireWide(principal, 'timetable.manage');
    await this.db.transaction(async (tx) => {
      const before = await loadTimetable(tx, tenantId, id, principal, { lock: 'update' });
      this.assertDraft(before);
      if (before.version !== input.version)
        throw new ConflictError('CONFLICT', undefined, { reason: 'STALE_VERSION' });
      const year = await loadYear(tx, tenantId, before.academicYearId);
      const from = input.effective_from === undefined ? before.effectiveFrom : input.effective_from;
      const to = input.effective_to === undefined ? before.effectiveTo : input.effective_to;
      if (from && to && from > to)
        throw validationIssue('effective_to', 'effective_to cannot be before effective_from');
      this.assertDatesInYear(year, from, to);
      const beforeView = (await this.present(tx, tenantId, [before]))[0]!;
      await tx
        .update(timetables)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          effectiveFrom: from,
          effectiveTo: to,
          version: before.version + 1,
          updatedBy: actor.userId,
        })
        .where(eq(timetables.id, id));
      const after = (
        await this.present(tx, tenantId, [await loadTimetable(tx, tenantId, id, principal)])
      )[0]!;
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_UPDATED',
        entityType: 'timetable',
        entityId: id,
        event: 'timetable.updated',
        before: beforeView,
        after,
        payload: { changed: Object.keys(input).filter((k) => k !== 'version') },
      });
    });
    return this.get(tenantId, id, principal);
  }

  private assertDraft(tt: TimetableRow) {
    if (tt.status !== 'DRAFT')
      throw new BusinessRuleError(
        'INVALID_STATE',
        'Only a draft timetable can be edited. Create a new draft version to change a published one.',
        { reason: 'TIMETABLE_NOT_DRAFT', timetable_status: tt.status },
      );
  }

  // ---- publish / archive -------------------------------------------------------------------

  private async yearOf(tenantId: string, id: string, principal: Principal) {
    const tt = await loadTimetable(this.db, tenantId, id, principal);
    return tt.academicYearId;
  }

  /**
   * DRAFT → PUBLISHED. Blocking issues (clashes, broken references, an empty timetable, and in
   * `strict` mode incomplete sections) refuse the command with the full list. The version
   * published before for the same year is archived in the same transaction.
   */
  async publish(
    tenantId: string,
    id: string,
    input: z.infer<typeof PublishBody>,
    principal: Principal,
    actor: Actor,
  ) {
    requireWide(principal, 'timetable.publish');
    await this.config.ensureSettings(tenantId);
    const yearId = await this.yearOf(tenantId, id, principal);
    const warnings = await this.db.transaction(async (tx) => {
      const year = await loadYear(tx, tenantId, yearId, 'update');
      const tt = await loadTimetable(tx, tenantId, id, principal, { lock: 'update' });
      this.assertDraft(tt);
      if (input.version !== undefined && tt.version !== input.version)
        throw new ConflictError('CONFLICT', undefined, { reason: 'STALE_VERSION' });
      if (!OPEN_YEAR.includes(year.status))
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'Only a timetable of an upcoming or active academic year can be published',
          { reason: 'YEAR_NOT_OPEN', academic_year_status: year.status },
        );
      const today = await schoolToday(tx, tenantId, this.deps.clock);
      const from =
        input.effective_from ??
        tt.effectiveFrom ??
        (today > year.startDate ? today : year.startDate);
      if (tt.effectiveTo && from > tt.effectiveTo)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'The effective date is after the end date of this timetable',
          {
            reason: 'EFFECTIVE_DATES_INVALID',
          },
        );
      this.assertDatesInYear(year, from, tt.effectiveTo);
      const settings = await readSettings(tx, tenantId, 'share');
      const report = await runCheck(tx, tenantId, tt, settings, {
        strict: input.strict,
        lock: 'share',
      });
      if (!report.ok)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          `The timetable cannot be published: ${report.blocking.length} blocking issue(s)`,
          {
            reason: 'PUBLISH_BLOCKED',
            blocking: report.blocking,
            warnings: report.warnings,
            summary: report.summary,
          },
        );
      const now = this.deps.clock.now();
      const [prev] = await tx
        .select()
        .from(timetables)
        .where(
          and(
            eq(timetables.tenantId, tenantId),
            eq(timetables.academicYearId, yearId),
            eq(timetables.status, 'PUBLISHED'),
          ),
        )
        .for('update');
      if (prev) {
        const endsOn = addDays(from, -1);
        const trim =
          prev.effectiveFrom !== null &&
          endsOn >= prev.effectiveFrom &&
          (prev.effectiveTo === null || prev.effectiveTo > endsOn);
        await tx
          .update(timetables)
          .set({
            status: 'ARCHIVED',
            archivedAt: now,
            archivedBy: actor.userId,
            supersededById: tt.id,
            ...(trim ? { effectiveTo: endsOn } : {}),
            version: prev.version + 1,
            updatedBy: actor.userId,
          })
          .where(eq(timetables.id, prev.id));
        await recordChange(tx, actor, tenantId, {
          action: 'TIMETABLE_SUPERSEDED',
          entityType: 'timetable',
          entityId: prev.id,
          event: 'timetable.superseded',
          before: { status: 'PUBLISHED', effective_to: prev.effectiveTo },
          after: {
            status: 'ARCHIVED',
            effective_to: trim ? endsOn : prev.effectiveTo,
            superseded_by_id: tt.id,
          },
          payload: {
            academic_year_id: yearId,
            version_no: prev.versionNo,
            superseded_by_id: tt.id,
          },
        });
      }
      await tx
        .update(timetables)
        .set({
          status: 'PUBLISHED',
          effectiveFrom: from,
          publishedAt: now,
          publishedBy: actor.userId,
          version: tt.version + 1,
          updatedBy: actor.userId,
        })
        .where(eq(timetables.id, tt.id));
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_PUBLISHED',
        entityType: 'timetable',
        entityId: tt.id,
        event: 'timetable.published',
        before: { status: 'DRAFT' },
        after: {
          status: 'PUBLISHED',
          effective_from: from,
          entries: report.summary.entries,
          warnings: report.warnings.length,
        },
        payload: {
          academic_year_id: yearId,
          version_no: tt.versionNo,
          effective_from: from,
          effective_to: tt.effectiveTo,
          entries: report.summary.entries,
          superseded_id: prev?.id ?? null,
        },
      });
      return report.warnings;
    });
    return { timetable: await this.get(tenantId, id, principal), warnings };
  }

  /** DRAFT or PUBLISHED → ARCHIVED. An archived version can be read and duplicated, never edited or restored. */
  async archive(
    tenantId: string,
    id: string,
    input: z.infer<typeof ArchiveBody>,
    principal: Principal,
    actor: Actor,
  ) {
    requireWide(principal, 'timetable.publish');
    await this.db.transaction(async (tx) => {
      const tt = await loadTimetable(tx, tenantId, id, principal, { lock: 'update' });
      if (tt.status === 'ARCHIVED')
        throw new BusinessRuleError('INVALID_STATE', 'The timetable is already archived', {
          reason: 'ALREADY_ARCHIVED',
        });
      if (input.version !== undefined && tt.version !== input.version)
        throw new ConflictError('CONFLICT', undefined, { reason: 'STALE_VERSION' });
      const now = this.deps.clock.now();
      // A withdrawn published version stops being in force immediately (history keeps what it was).
      const today = await schoolToday(tx, tenantId, this.deps.clock);
      const yesterday = addDays(today, -1);
      const endsOn =
        tt.status === 'PUBLISHED' && (tt.effectiveTo === null || tt.effectiveTo > yesterday)
          ? yesterday
          : tt.effectiveTo;
      await tx
        .update(timetables)
        .set({
          status: 'ARCHIVED',
          archivedAt: now,
          archivedBy: actor.userId,
          effectiveTo: endsOn,
          version: tt.version + 1,
          updatedBy: actor.userId,
        })
        .where(eq(timetables.id, id));
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_ARCHIVED',
        entityType: 'timetable',
        entityId: id,
        event: 'timetable.archived',
        before: { status: tt.status },
        after: { status: 'ARCHIVED' },
        reason: input.reason ?? null,
        payload: {
          academic_year_id: tt.academicYearId,
          version_no: tt.versionNo,
          from_status: tt.status,
        },
      });
    });
    return this.get(tenantId, id, principal);
  }
}
