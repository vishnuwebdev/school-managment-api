import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicSections,
  subjectOfferings,
  teachers,
  teachingAssignments,
  timetableEntries,
  timetablePeriods,
  timetables,
  timetableVenues,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import {
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
} from '../../shared/errors.js';
import { fullName } from '../teachers/support.js';
import type { TimetableConfigService } from './config.service.js';
import type {
  CreateEntryBody,
  EntryListQuery,
  SaveGridBody,
  UpdateEntryBody,
} from './timetable.schemas.js';
import {
  DAY_NAMES,
  ENTRY_ORDER,
  entryQuery,
  entryScope,
  fetchEntries,
  loadSection,
  loadTimetable,
  periodsForSection,
  presentEntry,
  readSettings,
  sectionInScope,
  type EntryJoined,
  type EntryRow,
  type EntryView,
  type PeriodRow,
  type SettingsRow,
  type TimetableRow,
  type VenueRow,
} from './support.js';

type AssignmentRow = typeof teachingAssignments.$inferSelect;
type SectionRow = typeof academicSections.$inferSelect;
type OfferingRow = typeof subjectOfferings.$inferSelect;

/** What one cell / entry should look like after the change. */
interface Want {
  /** Index in the request, for error reporting. */
  key: number;
  day: number;
  periodId: string;
  sectionId: string;
  offeringId: string;
  /** Explicit teacher, assignment; else resolved from the offering. */
  teacherId?: string;
  assignmentId?: string;
  /** undefined = keep the existing venue (update) / none (create). */
  venueId?: string | null;
  /** The entry this rewrites (PATCH). Grid cells find theirs by day + period. */
  existing?: EntryRow;
  expectedVersion?: number;
}
interface Removal {
  key: number;
  entry: EntryRow;
  expectedVersion?: number;
}

export interface ClashItem {
  type: 'TEACHER' | 'SECTION' | 'VENUE';
  day_of_week: number;
  period_id: string;
  /** The entry in the way; null when the other side is another cell of the same request. */
  entry: EntryView | null;
  cell_index: number | null;
}
interface CellError {
  key: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  clashes?: ClashItem[];
}

interface Refs {
  sections: Map<string, SectionRow>;
  periods: Map<string, PeriodRow>;
  venues: Map<string, VenueRow>;
  offerings: Map<string, OfferingRow>;
  assignments: Map<string, AssignmentRow>;
  /** ACTIVE assignments of the offerings involved. */
  activeByOffering: Map<string, AssignmentRow[]>;
}

const slotKey = (d: number, p: string) => `${d}:${p}`;

async function lockedById<T extends { id: string }>(
  label: string,
  ids: string[],
  run: (list: string[]) => Promise<T[]>,
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  if (!ids.length) return out;
  for (const r of await run(ids)) out.set(r.id, r);
  if (out.size !== ids.length) throw new NotFoundError(label);
  return out;
}

const uniq = <T>(xs: (T | null | undefined)[]): T[] => [
  ...new Set(xs.filter((x): x is T => x !== null && x !== undefined)),
];

/**
 * Timetable entries: single-entry commands, the section grid save and the
 * clash engine both use. Every mutation follows one recipe:
 *
 *   1. lock the timetable row (FOR UPDATE) — the mutex of all clash rules, which live
 *      inside one timetable — and require it to be a DRAFT;
 *   2. share-lock everything the entries point at (settings, sections, periods, venues,
 *      offerings, assignments) so nothing is deactivated or ended underneath us;
 *   3. lock the entries in the touched slots FOR UPDATE and check every rule against
 *      the state the request would leave behind (earlier cells of the same request count);
 *   4. write (updates are delete + re-insert of the same id, so swaps never trip the
 *      UNIQUE keys in between), then audit + outbox in the same transaction.
 *
 * The UNIQUE keys on the generated slot columns are the backstop, never the plan.
 */
export class EntryService {
  constructor(
    private readonly deps: Deps,
    private readonly config: TimetableConfigService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  // ---- reads -------------------------------------------------------------------------

  async get(tenantId: string, id: string, principal: Principal, ex: Executor = this.db) {
    const [row] = await fetchEntries(
      ex,
      and(
        eq(timetableEntries.id, id),
        eq(timetableEntries.tenantId, tenantId),
        entryScope(principal, 'timetable.read'),
      ),
    );
    if (!row) throw new NotFoundError('Timetable entry');
    // A draft's entries are as invisible as the draft itself.
    await loadTimetable(ex, tenantId, row.e.timetableId, principal);
    return presentEntry(row);
  }

  async list(
    tenantId: string,
    timetableId: string,
    q: z.infer<typeof EntryListQuery>,
    principal: Principal,
  ) {
    await loadTimetable(this.db, tenantId, timetableId, principal);
    const where = and(
      eq(timetableEntries.tenantId, tenantId),
      eq(timetableEntries.timetableId, timetableId),
      entryScope(principal, 'timetable.read'),
      q.section_id ? eq(timetableEntries.sectionId, q.section_id) : undefined,
      q.class_id ? eq(academicSections.classId, q.class_id) : undefined,
      q.teacher_id ? eq(timetableEntries.teacherId, q.teacher_id) : undefined,
      q.venue_id ? eq(timetableEntries.venueId, q.venue_id) : undefined,
      q.period_id ? eq(timetableEntries.periodId, q.period_id) : undefined,
      q.day_of_week ? eq(timetableEntries.dayOfWeek, q.day_of_week) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      entryQuery(this.db)
        .where(where)
        .orderBy(...ENTRY_ORDER)
        .limit(q.page_size)
        .offset((q.page - 1) * q.page_size),
      this.db
        .select({ n: count() })
        .from(timetableEntries)
        .innerJoin(
          academicSections,
          and(
            eq(academicSections.tenantId, timetableEntries.tenantId),
            eq(academicSections.id, timetableEntries.sectionId),
          ),
        )
        .where(where),
    ]);
    return {
      data: (rows as EntryJoined[]).map(presentEntry),
      meta: { page: q.page, page_size: q.page_size, total: total?.n ?? 0 },
    };
  }

  // ---- single-entry commands ---------------------------------------------------------

  async create(
    tenantId: string,
    timetableId: string,
    input: z.infer<typeof CreateEntryBody>,
    principal: Principal,
    actor: Actor,
  ) {
    await this.config.ensureSettings(tenantId);
    let assignmentOffering: string | undefined = input.subject_offering_id;
    if (!assignmentOffering && input.teaching_assignment_id) {
      // Only the offering id is read outside the lock; the assignment itself is re-read under lock.
      const [a] = await this.db
        .select({ o: teachingAssignments.subjectOfferingId })
        .from(teachingAssignments)
        .where(
          and(
            eq(teachingAssignments.id, input.teaching_assignment_id),
            eq(teachingAssignments.tenantId, tenantId),
          ),
        );
      if (!a) throw new NotFoundError('Teaching assignment');
      assignmentOffering = a.o;
    }
    return this.db.transaction(async (tx) => {
      const tt = await this.lockDraft(tx, tenantId, timetableId, principal);
      const settings = await readSettings(tx, tenantId, 'share');
      const want: Want = {
        key: 0,
        day: input.day_of_week,
        periodId: input.period_id,
        sectionId: input.section_id,
        offeringId: assignmentOffering!,
        ...(input.teacher_id ? { teacherId: input.teacher_id } : {}),
        ...(input.teaching_assignment_id ? { assignmentId: input.teaching_assignment_id } : {}),
        venueId: input.venue_id ?? null,
      };
      const res = await this.apply(tx, tenantId, tt, settings, principal, actor, {
        wants: [want],
        removals: [],
        mode: 'create',
      });
      this.throwSingle(res.errors);
      const [id] = res.createdIds;
      const view = await this.view(tx, tenantId, id!);
      await this.touch(tx, actor, tt);
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_ENTRY_CREATED',
        entityType: 'timetable_entry',
        entityId: id!,
        event: 'timetable_entry.created',
        after: view,
        payload: this.entryPayload(view),
      });
      return view;
    });
  }

  async update(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateEntryBody>,
    principal: Principal,
    actor: Actor,
  ) {
    await this.config.ensureSettings(tenantId);
    const timetableId = await this.timetableOfEntry(tenantId, id);
    return this.db.transaction(async (tx) => {
      const tt = await this.lockDraft(tx, tenantId, timetableId, principal);
      const settings = await readSettings(tx, tenantId, 'share');
      const [existing] = await tx
        .select()
        .from(timetableEntries)
        .where(and(eq(timetableEntries.id, id), eq(timetableEntries.tenantId, tenantId)));
      if (!existing) throw new NotFoundError('Timetable entry');
      const want: Want = {
        key: 0,
        day: input.day_of_week ?? existing.dayOfWeek,
        periodId: input.period_id ?? existing.periodId,
        sectionId: existing.sectionId,
        offeringId: input.subject_offering_id ?? existing.subjectOfferingId,
        ...(input.teacher_id ? { teacherId: input.teacher_id } : {}),
        ...(input.teaching_assignment_id ? { assignmentId: input.teaching_assignment_id } : {}),
        venueId: input.venue_id === undefined ? existing.venueId : input.venue_id,
        existing,
        expectedVersion: input.version,
      };
      const before = await this.view(tx, tenantId, id);
      const res = await this.apply(tx, tenantId, tt, settings, principal, actor, {
        wants: [want],
        removals: [],
        mode: 'create',
      });
      this.throwSingle(res.errors);
      const view = await this.view(tx, tenantId, id);
      if (res.unchanged === 0) await this.touch(tx, actor, tt);
      if (res.unchanged === 0)
        await recordChange(tx, actor, tenantId, {
          action: 'TIMETABLE_ENTRY_UPDATED',
          entityType: 'timetable_entry',
          entityId: id,
          event: 'timetable_entry.updated',
          before,
          after: view,
          payload: this.entryPayload(view),
        });
      return view;
    });
  }

  async remove(
    tenantId: string,
    id: string,
    version: number | undefined,
    principal: Principal,
    actor: Actor,
  ) {
    await this.config.ensureSettings(tenantId);
    const timetableId = await this.timetableOfEntry(tenantId, id);
    await this.db.transaction(async (tx) => {
      const tt = await this.lockDraft(tx, tenantId, timetableId, principal);
      const settings = await readSettings(tx, tenantId, 'share');
      const [existing] = await tx
        .select()
        .from(timetableEntries)
        .where(and(eq(timetableEntries.id, id), eq(timetableEntries.tenantId, tenantId)));
      if (!existing) throw new NotFoundError('Timetable entry');
      const before = await this.view(tx, tenantId, id);
      const res = await this.apply(tx, tenantId, tt, settings, principal, actor, {
        wants: [],
        removals: [{ key: 0, entry: existing, expectedVersion: version }],
        mode: 'create',
      });
      this.throwSingle(res.errors);
      await this.touch(tx, actor, tt);
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_ENTRY_DELETED',
        entityType: 'timetable_entry',
        entityId: id,
        event: 'timetable_entry.deleted',
        before,
        payload: this.entryPayload(before),
      });
    });
  }

  // ---- section grid --------------------------------------------------------------------

  /**
   * Save cells of one section's grid in ONE transaction: everything is validated first
   * and either the whole request is applied or nothing is. A cell with a null offering
   * clears the slot. `replace` makes the request the whole truth for the section.
   */
  async saveGrid(
    tenantId: string,
    timetableId: string,
    sectionId: string,
    input: z.infer<typeof SaveGridBody>,
    principal: Principal,
    actor: Actor,
  ) {
    await this.config.ensureSettings(tenantId);
    return this.db.transaction(async (tx) => {
      const tt = await this.lockDraft(tx, tenantId, timetableId, principal);
      const settings = await readSettings(tx, tenantId, 'share');
      const section = await loadSection(
        tx,
        tenantId,
        sectionId,
        principal,
        'timetable.manage',
        'share',
      );
      const wants: Want[] = [];
      const clears: { key: number; day: number; periodId: string; version?: number }[] = [];
      input.cells.forEach((c, key) => {
        if (c.subject_offering_id === null)
          clears.push({ key, day: c.day_of_week, periodId: c.period_id, version: c.version });
        else
          wants.push({
            key,
            day: c.day_of_week,
            periodId: c.period_id,
            sectionId,
            offeringId: c.subject_offering_id,
            ...(c.teacher_id ? { teacherId: c.teacher_id } : {}),
            ...(c.teaching_assignment_id ? { assignmentId: c.teaching_assignment_id } : {}),
            venueId: c.venue_id === undefined ? undefined : c.venue_id,
            expectedVersion: c.version,
          });
      });
      const res = await this.apply(tx, tenantId, tt, settings, principal, actor, {
        wants,
        removals: [],
        mode: 'upsert',
        gridSectionId: sectionId,
        clears,
        replace: input.replace,
        periodIdsForClears: uniq(clears.map((c) => c.periodId)),
      });
      if (res.errors.length) this.throwGrid(res.errors, input);
      const changed = [...res.createdIds, ...res.updatedIds];
      const after = changed.length
        ? await fetchEntries(tx, and(inArray(timetableEntries.id, changed)))
        : [];
      const summary = {
        section_id: sectionId,
        created: res.createdIds.length,
        updated: res.updatedIds.length,
        deleted: res.deletedIds.length,
        unchanged: res.unchanged,
      };
      if (summary.created + summary.updated + summary.deleted > 0) {
        await this.touch(tx, actor, tt);
        await recordChange(tx, actor, tenantId, {
          action: 'TIMETABLE_GRID_SAVED',
          entityType: 'timetable',
          entityId: tt.id,
          event: 'timetable.grid_saved',
          before: {
            entries: res.beforeViews.slice(0, 200).map((v) => ({
              day_of_week: v.day_of_week,
              period: v.period.code,
              subject: v.subject.code,
              teacher: v.teacher.teacher_number,
              venue: v.venue?.code ?? null,
            })),
          },
          after: {
            ...summary,
            section: `${section.className} ${section.code}`,
            entries: after.slice(0, 200).map((r) => ({
              day_of_week: r.e.dayOfWeek,
              period: r.p.code,
              subject: r.sub.code,
              teacher: r.t.teacherNumber,
              venue: r.v?.code ?? null,
            })),
          },
          payload: { ...summary, replace: input.replace },
        });
      }
      return { ...summary, section_id: sectionId };
    });
  }

  // ---- shared ------------------------------------------------------------------------

  /** Present one entry inside the writer's transaction (no read-scope narrowing: the writer just changed it). */
  private async view(tx: Executor, tenantId: string, id: string): Promise<EntryView> {
    const [row] = await fetchEntries(
      tx,
      and(eq(timetableEntries.id, id), eq(timetableEntries.tenantId, tenantId)),
    );
    if (!row) throw new NotFoundError('Timetable entry');
    return presentEntry(row);
  }

  private entryPayload(v: EntryView) {
    return {
      timetable_id: v.timetable_id,
      section_id: v.section.id,
      subject_offering_id: v.subject_offering_id,
      teacher_id: v.teacher.id,
      venue_id: v.venue?.id ?? null,
      period_id: v.period.id,
      day_of_week: v.day_of_week,
    };
  }

  /** Autocommit read of the entry's timetable id (the id every transaction must lock first). */
  private async timetableOfEntry(tenantId: string, id: string): Promise<string> {
    const [row] = await this.db
      .select({ t: timetableEntries.timetableId })
      .from(timetableEntries)
      .where(and(eq(timetableEntries.id, id), eq(timetableEntries.tenantId, tenantId)));
    if (!row) throw new NotFoundError('Timetable entry');
    return row.t;
  }

  private async lockDraft(tx: Executor, tenantId: string, id: string, principal: Principal) {
    const tt = await loadTimetable(tx, tenantId, id, principal, { lock: 'update' });
    if (tt.status !== 'DRAFT')
      throw new BusinessRuleError(
        'INVALID_STATE',
        'Only a draft timetable can be edited. Create a new draft version to change a published one.',
        { reason: 'TIMETABLE_NOT_DRAFT', timetable_status: tt.status },
      );
    return tt;
  }

  /** Edited-at marker for lists; entries have their own versions, the timetable's `version` is not bumped. */
  private async touch(tx: Executor, actor: Actor, tt: TimetableRow) {
    await tx
      .update(timetables)
      .set({ updatedBy: actor.userId, updatedAt: this.deps.clock.now() })
      .where(eq(timetables.id, tt.id));
  }

  private throwSingle(errors: CellError[]) {
    if (!errors.length) return;
    const business = errors.find((e) => e.code !== 'SCHEDULE_CLASH' && e.code !== 'STALE_VERSION');
    if (business)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', business.message, {
        reason: business.code,
        ...business.details,
      });
    const clash = errors.find((e) => e.code === 'SCHEDULE_CLASH');
    if (clash)
      throw new ConflictError('CONFLICT', clash.message, {
        reason: 'SCHEDULE_CLASH',
        clashes: clash.clashes,
      });
    throw new ConflictError('CONFLICT', undefined, { reason: 'STALE_VERSION' });
  }

  private throwGrid(errors: CellError[], input: z.infer<typeof SaveGridBody>): never {
    const cells = errors.map((e) => ({
      index: e.key,
      day_of_week: input.cells[e.key]?.day_of_week ?? null,
      period_id: input.cells[e.key]?.period_id ?? null,
      code: e.code,
      message: e.message,
      ...(e.details ? { details: e.details } : {}),
      ...(e.clashes ? { clashes: e.clashes } : {}),
    }));
    const business = errors.some((e) => e.code !== 'SCHEDULE_CLASH' && e.code !== 'STALE_VERSION');
    const message = `The grid was not saved: ${errors.length} cell(s) were rejected and nothing was changed`;
    if (business)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', message, {
        reason: 'GRID_REJECTED',
        cells,
      });
    throw new ConflictError('CONFLICT', message, { reason: 'GRID_REJECTED', cells });
  }

  // ---- the engine ------------------------------------------------------------------------

  private async loadRefs(
    tx: Executor,
    tenantId: string,
    wants: Want[],
    extra: { periodIds: string[] },
  ) {
    const sectionIds = uniq(wants.map((w) => w.sectionId));
    const periodIds = uniq([...wants.map((w) => w.periodId), ...extra.periodIds]);
    const venueIds = uniq(wants.map((w) => w.venueId));
    const offeringIds = uniq(wants.map((w) => w.offeringId));
    const assignmentIds = uniq(wants.map((w) => w.assignmentId));
    const teacherIds = uniq(wants.map((w) => w.teacherId));
    const refs: Refs = {
      sections: await lockedById('Section', sectionIds, (l) =>
        tx
          .select()
          .from(academicSections)
          .where(and(eq(academicSections.tenantId, tenantId), inArray(academicSections.id, l)))
          .for('share'),
      ),
      periods: await lockedById('Period', periodIds, (l) =>
        tx
          .select()
          .from(timetablePeriods)
          .where(and(eq(timetablePeriods.tenantId, tenantId), inArray(timetablePeriods.id, l)))
          .for('share'),
      ),
      venues: await lockedById('Venue', venueIds, (l) =>
        tx
          .select()
          .from(timetableVenues)
          .where(and(eq(timetableVenues.tenantId, tenantId), inArray(timetableVenues.id, l)))
          .for('share'),
      ),
      offerings: await lockedById('Subject offering', offeringIds, (l) =>
        tx
          .select()
          .from(subjectOfferings)
          .where(and(eq(subjectOfferings.tenantId, tenantId), inArray(subjectOfferings.id, l)))
          .for('share'),
      ),
      assignments: await lockedById('Teaching assignment', assignmentIds, (l) =>
        tx
          .select()
          .from(teachingAssignments)
          .where(
            and(eq(teachingAssignments.tenantId, tenantId), inArray(teachingAssignments.id, l)),
          )
          .for('share'),
      ),
      activeByOffering: new Map(),
    };
    if (teacherIds.length) {
      const found = await tx
        .select({ id: teachers.id })
        .from(teachers)
        .where(and(eq(teachers.tenantId, tenantId), inArray(teachers.id, teacherIds)));
      if (found.length !== teacherIds.length) throw new NotFoundError('Teacher');
    }
    await this.addActive(tx, tenantId, refs, offeringIds);
    return refs;
  }

  private async addActive(tx: Executor, tenantId: string, refs: Refs, offeringIds: string[]) {
    if (!offeringIds.length) return;
    const active = await tx
      .select()
      .from(teachingAssignments)
      .where(
        and(
          eq(teachingAssignments.tenantId, tenantId),
          inArray(teachingAssignments.subjectOfferingId, offeringIds),
          eq(teachingAssignments.status, 'ACTIVE'),
        ),
      )
      .for('share');
    for (const a of active) {
      const list = refs.activeByOffering.get(a.subjectOfferingId) ?? [];
      list.push(a);
      refs.activeByOffering.set(a.subjectOfferingId, list);
      refs.assignments.set(a.id, a);
    }
  }

  private async apply(
    tx: Executor,
    tenantId: string,
    tt: TimetableRow,
    settings: SettingsRow,
    principal: Principal,
    actor: Actor,
    o: {
      wants: Want[];
      removals: Removal[];
      mode: 'create' | 'upsert';
      gridSectionId?: string;
      clears?: { key: number; day: number; periodId: string; version?: number }[];
      replace?: boolean;
      periodIdsForClears?: string[];
    },
  ) {
    const errors: CellError[] = [];
    const err = (key: number, code: string, message: string, extra: Partial<CellError> = {}) =>
      errors.push({ key, code, message, ...extra });

    // Rows that will be changed or removed must be in scope for the caller (out of scope = 404).
    const scopedSection = new Map<string, boolean>();
    const inScope = async (sectionId: string) => {
      let ok = scopedSection.get(sectionId);
      if (ok === undefined) {
        const [s] = await tx
          .select({ id: academicSections.id, classId: academicSections.classId })
          .from(academicSections)
          .where(and(eq(academicSections.id, sectionId), eq(academicSections.tenantId, tenantId)));
        ok = !!s && sectionInScope(principal, 'timetable.manage', s);
        scopedSection.set(sectionId, ok);
      }
      return ok;
    };

    // 2. share-lock the references (404 for anything that is not this school's)
    const refs = await this.loadRefs(tx, tenantId, o.wants, {
      periodIds: o.periodIdsForClears ?? [],
    });
    for (const w of o.wants) if (!(await inScope(w.sectionId))) throw new NotFoundError('Section');
    for (const r of o.removals)
      if (!(await inScope(r.entry.sectionId))) throw new NotFoundError('Timetable entry');

    // 3. lock the entries in the touched slots
    const slots = uniq([
      ...o.wants.map((w) => slotKey(w.day, w.periodId)),
      ...(o.clears ?? []).map((c) => slotKey(c.day, c.periodId)),
    ]).map((k) => {
      const [d, p] = k.split(':') as [string, string];
      return { d: Number(d), p };
    });
    const atSlots: EntryRow[] = slots.length
      ? await tx
          .select()
          .from(timetableEntries)
          .where(
            and(
              eq(timetableEntries.tenantId, tenantId),
              eq(timetableEntries.timetableId, tt.id),
              eq(timetableEntries.status, 'ACTIVE'),
              sql`(${timetableEntries.dayOfWeek}, ${timetableEntries.periodId}) in (${sql.join(
                slots.map((s) => sql`(${s.d}, ${s.p})`),
                sql`, `,
              )})`,
            ),
          )
          .for('update')
      : [];
    const sectionEntries: EntryRow[] =
      o.replace && o.gridSectionId
        ? await tx
            .select()
            .from(timetableEntries)
            .where(
              and(
                eq(timetableEntries.tenantId, tenantId),
                eq(timetableEntries.timetableId, tt.id),
                eq(timetableEntries.sectionId, o.gridSectionId),
                eq(timetableEntries.status, 'ACTIVE'),
              ),
            )
            .for('update')
        : [];

    const deleteIds = new Set<string>();
    const beforeIds = new Set<string>();

    // grid: match cells to the entries already in the section by day + period
    const bySectionSlot = new Map<string, EntryRow>();
    if (o.mode === 'upsert')
      for (const e of atSlots)
        if (e.sectionId === o.gridSectionId) bySectionSlot.set(slotKey(e.dayOfWeek, e.periodId), e);
    for (const w of o.wants)
      if (o.mode === 'upsert') w.existing = bySectionSlot.get(slotKey(w.day, w.periodId));

    // explicit removals + clears
    const removals: Removal[] = [...o.removals];
    for (const c of o.clears ?? []) {
      const e = bySectionSlot.get(slotKey(c.day, c.periodId));
      if (e) removals.push({ key: c.key, entry: e, expectedVersion: c.version });
    }
    for (const r of removals) {
      if (r.expectedVersion !== undefined && r.entry.version !== r.expectedVersion)
        err(
          r.key,
          'STALE_VERSION',
          'The entry was changed by someone else. Reload and try again.',
          {
            details: { entry_id: r.entry.id, current_version: r.entry.version },
          },
        );
      deleteIds.add(r.entry.id);
      beforeIds.add(r.entry.id);
    }

    // 4. resolve teacher assignment, check unchanged, validate
    const pendingWants: { w: Want; a: AssignmentRow }[] = [];
    let unchanged = 0;
    const preferIds = uniq(
      o.wants
        .map((w) => (w.existing ? w.existing.teachingAssignmentId : undefined))
        .filter((id) => id && !refs.assignments.has(id)),
    );
    if (preferIds.length)
      for (const a of await tx
        .select()
        .from(teachingAssignments)
        .where(
          and(
            eq(teachingAssignments.tenantId, tenantId),
            inArray(teachingAssignments.id, preferIds),
          ),
        )
        .for('share'))
        refs.assignments.set(a.id, a);

    const candidateNames = async (list: AssignmentRow[]) => {
      const rows = await tx
        .select({
          id: teachers.id,
          firstName: teachers.firstName,
          middleName: teachers.middleName,
          lastName: teachers.lastName,
        })
        .from(teachers)
        .where(
          and(
            eq(teachers.tenantId, tenantId),
            inArray(teachers.id, uniq(list.map((a) => a.teacherId))),
          ),
        );
      return rows.map((t) => ({ id: t.id, full_name: fullName(t) }));
    };

    // Each section has its own school day: its periods, else its class's, else the school's.
    const allPeriods = o.wants.length
      ? await tx.select().from(timetablePeriods).where(eq(timetablePeriods.tenantId, tenantId))
      : [];
    const dayOf = new Map<string, Set<string>>();
    const sectionDay = (sec: { id: string; classId: string }) => {
      let d = dayOf.get(sec.id);
      if (!d) {
        d = new Set(periodsForSection(allPeriods, sec).map((p) => p.id));
        dayOf.set(sec.id, d);
      }
      return d;
    };

    for (const w of o.wants) {
      const ex = w.existing;
      if (ex && w.expectedVersion !== undefined && ex.version !== w.expectedVersion)
        err(
          w.key,
          'STALE_VERSION',
          'The entry was changed by someone else. Reload and try again.',
          {
            details: { entry_id: ex.id, current_version: ex.version },
          },
        );
      const section = refs.sections.get(w.sectionId)!;
      const period = refs.periods.get(w.periodId)!;
      const offering = refs.offerings.get(w.offeringId)!;
      const venue = w.venueId ? refs.venues.get(w.venueId)! : null;
      const before = errors.length;

      // teacher assignment
      let a: AssignmentRow | undefined;
      if (w.assignmentId) {
        a = refs.assignments.get(w.assignmentId)!;
        if (a.subjectOfferingId !== w.offeringId)
          err(
            w.key,
            'ASSIGNMENT_OFFERING_MISMATCH',
            'The teaching assignment belongs to a different subject offering',
          );
        else if (a.status !== 'ACTIVE')
          err(
            w.key,
            'TEACHING_ASSIGNMENT_NOT_ACTIVE',
            'The teaching assignment is no longer active',
            {
              details: { teaching_assignment_id: a.id, assignment_status: a.status },
            },
          );
        if (w.teacherId && w.teacherId !== a.teacherId)
          err(
            w.key,
            'TEACHER_NOT_ASSIGNED',
            'The teaching assignment belongs to a different teacher',
          );
      } else if (w.teacherId) {
        a = (refs.activeByOffering.get(w.offeringId) ?? []).find(
          (x) => x.teacherId === w.teacherId,
        );
        if (!a)
          err(
            w.key,
            'TEACHER_NOT_ASSIGNED',
            'The teacher has no active teaching assignment for this subject offering',
            { details: { teacher_id: w.teacherId, subject_offering_id: w.offeringId } },
          );
      } else {
        const kept =
          ex && ex.subjectOfferingId === w.offeringId
            ? refs.assignments.get(ex.teachingAssignmentId)
            : undefined;
        if (kept && kept.status === 'ACTIVE') a = kept;
        else {
          const active = refs.activeByOffering.get(w.offeringId) ?? [];
          if (active.length === 0)
            err(
              w.key,
              'NO_TEACHING_ASSIGNMENT',
              'No teacher has an active assignment for this subject offering',
              {
                details: { subject_offering_id: w.offeringId },
              },
            );
          else if (active.length > 1)
            err(
              w.key,
              'AMBIGUOUS_TEACHER',
              'Several teachers teach this subject offering: choose one with teacher_id',
              {
                details: {
                  subject_offering_id: w.offeringId,
                  teachers: await candidateNames(active),
                },
              },
            );
          else a = active[0];
        }
      }

      if (a && ex) {
        const venueSame = (w.venueId === undefined ? ex.venueId : w.venueId) === ex.venueId;
        if (
          errors.length === before &&
          ex.dayOfWeek === w.day &&
          ex.periodId === w.periodId &&
          ex.subjectOfferingId === w.offeringId &&
          ex.teachingAssignmentId === a.id &&
          venueSame
        ) {
          unchanged++;
          continue;
        }
      }

      // static rules
      if (section.academicYearId !== tt.academicYearId)
        err(
          w.key,
          'SECTION_WRONG_YEAR',
          'The section belongs to a different academic year than this timetable',
        );
      else if (section.status !== 'ACTIVE' && section.status !== 'DRAFT')
        err(w.key, 'SECTION_NOT_SCHEDULABLE', 'Closed or archived sections cannot be scheduled', {
          details: { section_status: section.status },
        });
      if (period.status !== 'ACTIVE')
        err(w.key, 'PERIOD_INACTIVE', 'The period is inactive', {
          details: { period_id: period.id },
        });
      else if (!sectionDay(section).has(period.id))
        err(
          w.key,
          'PERIOD_NOT_IN_SCHEDULE',
          `${period.name} is not one of the periods of ${section.name}'s school day`,
          { details: { period_id: period.id, section_id: section.id } },
        );
      else if (period.kind !== 'LESSON')
        err(
          w.key,
          'PERIOD_NOT_LESSON',
          `${period.name} is a ${period.kind.toLowerCase()} period: no lessons can be scheduled in it`,
          {
            details: { period_id: period.id, kind: period.kind },
          },
        );
      if (!settings.workingDays.includes(w.day))
        err(w.key, 'DAY_NOT_WORKING', `${DAY_NAMES[w.day]} is not a teaching day of the school`, {
          details: { day_of_week: w.day },
        });
      if (offering.status !== 'ACTIVE')
        err(w.key, 'OFFERING_INACTIVE', 'The subject offering is inactive');
      else if (offering.academicYearId !== tt.academicYearId)
        err(
          w.key,
          'OFFERING_WRONG_YEAR',
          'The subject offering belongs to a different academic year',
        );
      else if (
        offering.classId !== section.classId ||
        (offering.sectionId !== null && offering.sectionId !== section.id)
      )
        err(
          w.key,
          'OFFERING_NOT_FOR_SECTION',
          'The subject offering is not offered to this section',
          {
            details: { subject_offering_id: offering.id, section_id: section.id },
          },
        );
      if (venue && venue.status !== 'ACTIVE')
        err(w.key, 'VENUE_INACTIVE', 'The venue is inactive', { details: { venue_id: venue.id } });

      if (a) pendingWants.push({ w, a });
    }

    // 5. clash rules against the state the request leaves behind
    for (const p of pendingWants) if (p.w.existing) deleteIds.add(p.w.existing.id);
    for (const e of sectionEntries) {
      const listed = o.wants.some((w) => w.existing?.id === e.id);
      const cleared = removals.some((r) => r.entry.id === e.id);
      if (!listed && !cleared) {
        deleteIds.add(e.id);
        beforeIds.add(e.id);
      }
    }
    // entries the request rewrites (changed wants) and unchanged ones stay out of the way accordingly
    const freed = new Set<string>(deleteIds);
    const occSection = new Map<string, EntryRow | number>();
    const occTeacher = new Map<string, EntryRow | number>();
    const occVenue = new Map<string, EntryRow | number>();
    for (const e of atSlots) {
      if (freed.has(e.id)) continue;
      occSection.set(`${e.sectionId}:${slotKey(e.dayOfWeek, e.periodId)}`, e);
      occTeacher.set(`${e.teacherId}:${slotKey(e.dayOfWeek, e.periodId)}`, e);
      if (e.venueId) occVenue.set(`${e.venueId}:${slotKey(e.dayOfWeek, e.periodId)}`, e);
    }
    const clashRaw: { key: number; type: ClashItem['type']; w: Want; other: EntryRow | number }[] =
      [];
    const placed: { w: Want; a: AssignmentRow; venueId: string | null }[] = [];
    const erroredKeys = new Set(errors.map((e) => e.key));
    for (const { w, a } of pendingWants) {
      const venueId = w.venueId === undefined ? (w.existing?.venueId ?? null) : w.venueId;
      const s = slotKey(w.day, w.periodId);
      const hit = (m: Map<string, EntryRow | number>, id: string, type: ClashItem['type']) => {
        const other = m.get(`${id}:${s}`);
        if (other !== undefined) clashRaw.push({ key: w.key, type, w, other });
      };
      hit(occSection, w.sectionId, 'SECTION');
      hit(occTeacher, a.teacherId, 'TEACHER');
      if (venueId) hit(occVenue, venueId, 'VENUE');
      if (!erroredKeys.has(w.key) && !clashRaw.some((c) => c.key === w.key)) {
        occSection.set(`${w.sectionId}:${s}`, w.key);
        occTeacher.set(`${a.teacherId}:${s}`, w.key);
        if (venueId) occVenue.set(`${venueId}:${s}`, w.key);
        placed.push({ w, a, venueId });
      }
    }
    if (clashRaw.length) {
      const ids = uniq(clashRaw.map((c) => (typeof c.other === 'number' ? null : c.other.id)));
      const views = new Map<string, EntryView>();
      if (ids.length)
        for (const r of await fetchEntries(tx, inArray(timetableEntries.id, ids)))
          views.set(r.e.id, presentEntry(r));
      const byKey = new Map<number, CellError>();
      for (const c of clashRaw) {
        let ce = byKey.get(c.key);
        if (!ce) {
          ce = { key: c.key, code: 'SCHEDULE_CLASH', message: '', clashes: [] };
          byKey.set(c.key, ce);
          errors.push(ce);
        }
        ce.clashes!.push({
          type: c.type,
          day_of_week: c.w.day,
          period_id: c.w.periodId,
          entry: typeof c.other === 'number' ? null : (views.get(c.other.id) ?? null),
          cell_index: typeof c.other === 'number' ? c.other : null,
        });
      }
      for (const ce of byKey.values()) {
        const types = uniq(ce.clashes!.map((c) => c.type)).map((t) => t.toLowerCase());
        ce.message = `The lesson clashes with an existing lesson (${types.join(', ')})`;
      }
    }
    errors.sort((x, y) => x.key - y.key);
    if (errors.length)
      return {
        errors,
        createdIds: [],
        updatedIds: [],
        deletedIds: [],
        unchanged,
        beforeViews: [] as EntryView[],
      };

    // 6. write
    const changedExisting = placed.filter((p) => p.w.existing);
    for (const p of changedExisting) beforeIds.add(p.w.existing!.id);
    const beforeViews = beforeIds.size
      ? (await fetchEntries(tx, inArray(timetableEntries.id, [...beforeIds]))).map(presentEntry)
      : [];
    const now = this.deps.clock.now();
    const rows = placed.map(({ w, a, venueId }) => ({
      id: w.existing?.id ?? uuidv7(),
      tenantId,
      timetableId: tt.id,
      academicYearId: tt.academicYearId,
      dayOfWeek: w.day,
      periodId: w.periodId,
      sectionId: w.sectionId,
      subjectOfferingId: w.offeringId,
      teachingAssignmentId: a.id,
      teacherId: a.teacherId,
      venueId,
      status: 'ACTIVE' as const,
      version: w.existing ? w.existing.version + 1 : 1,
      createdBy: w.existing ? w.existing.createdBy : actor.userId,
      createdAt: w.existing ? w.existing.createdAt : now,
      updatedBy: actor.userId,
      updatedAt: now,
    }));
    try {
      const del = [...deleteIds];
      if (del.length)
        await tx
          .delete(timetableEntries)
          .where(and(eq(timetableEntries.tenantId, tenantId), inArray(timetableEntries.id, del)));
      for (let i = 0; i < rows.length; i += 200)
        await tx.insert(timetableEntries).values(rows.slice(i, i + 200));
    } catch (e) {
      if (isDuplicateKeyError(e))
        throw new ConflictError('CONFLICT', 'The lesson clashes with another lesson', {
          reason: 'SCHEDULE_CLASH',
          clashes: [],
        });
      throw e;
    }
    const removedIds = [...deleteIds].filter(
      (id) => !changedExisting.some((p) => p.w.existing!.id === id),
    );
    return {
      errors,
      createdIds: rows
        .filter((r) => !changedExisting.some((p) => p.w.existing!.id === r.id))
        .map((r) => r.id),
      updatedIds: changedExisting.map((p) => p.w.existing!.id),
      deletedIds: removedIds,
      unchanged,
      beforeViews,
    };
  }
}
