import { and, asc, count, eq, isNull, like, ne, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  timetableEntries,
  timetablePeriods,
  timetableSettings,
  timetableVenues,
} from '../../db/schema/index.js';
import type { Actor } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import {
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
} from '../../shared/errors.js';
import { offsetOf, orderFrom, pageOf } from '../../shared/pagination.js';
import { likeOf } from '../students/support.js';
import type {
  CreatePeriodBody,
  CreateVenueBody,
  PeriodListQuery,
  UpdatePeriodBody,
  UpdateSettingsBody,
  UpdateVenueBody,
  VenueListQuery,
} from './timetable.schemas.js';
import {
  DEFAULT_WORKING_DAYS,
  hhmmss,
  periodPresent,
  periodsForSection,
  readSettings,
  settingsPresent,
  validationIssue,
  venuePresent,
  type PeriodRow,
  type VenueRow,
} from './support.js';

const isDeadlock = (err: unknown) => {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    if (typeof cur === 'object' && cur !== null && 'code' in cur) {
      const c = (cur as { code: unknown }).code;
      if (c === 'ER_LOCK_DEADLOCK' || c === 'ER_LOCK_WAIT_TIMEOUT') return true;
    }
    cur = typeof cur === 'object' && cur !== null ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
};

/**
 * Timetable configuration: the school's teaching days, the bell schedule
 * (periods) and the venues. Editable while timetables exist, but a change that
 * would leave a DRAFT or PUBLISHED timetable pointing at something that no
 * longer works (an inactive period, a closed venue, a non-teaching day) is refused.
 */
export class TimetableConfigService {
  private readonly ready = new Set<string>();

  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  /**
   * Idempotent, concurrency-safe creation of the school's settings row (Mon–Fri).
   * Runs on every timetable path, BEFORE the caller opens its transaction.
   */
  async ensureSettings(tenantId: string): Promise<void> {
    if (this.ready.has(tenantId)) return;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.db
          .insert(timetableSettings)
          .values({ tenantId, workingDays: DEFAULT_WORKING_DAYS })
          .onDuplicateKeyUpdate({ set: { tenantId: sql`${timetableSettings.tenantId}` } });
        this.ready.add(tenantId);
        return;
      } catch (err) {
        if (attempt < 3 && isDeadlock(err)) continue;
        throw err;
      }
    }
  }

  /** Entries of DRAFT / PUBLISHED timetables matching `where` (locking read; capped). */
  private async liveUsage(tx: Executor, tenantId: string, where: SQL) {
    // The timetables subquery is deliberately NOT locked: only entry rows are, so a period or venue
    // change never waits on (or deadlocks with) an editor holding a timetable lock.
    const rows = await tx
      .select({ id: timetableEntries.id, timetableId: timetableEntries.timetableId })
      .from(timetableEntries)
      .where(
        and(
          eq(timetableEntries.tenantId, tenantId),
          sql`${timetableEntries.timetableId} in (select t.id from timetables t where t.tenant_id = ${tenantId} and t.status in ('DRAFT', 'PUBLISHED'))`,
          where,
        ),
      )
      .limit(500)
      .for('share');
    return { in_use: rows.length > 0, timetable_ids: [...new Set(rows.map((r) => r.timetableId))] };
  }

  // ---- settings ------------------------------------------------------------------

  async getSettings(tenantId: string) {
    await this.ensureSettings(tenantId);
    return settingsPresent(await readSettings(this.db, tenantId));
  }

  async updateSettings(tenantId: string, input: z.infer<typeof UpdateSettingsBody>, actor: Actor) {
    await this.ensureSettings(tenantId);
    await this.db.transaction(async (tx) => {
      const before = await readSettings(tx, tenantId, 'update');
      if (before.version !== input.version)
        throw new ConflictError('CONFLICT', undefined, { reason: 'STALE_VERSION' });
      const nextDays = input.working_days ?? before.workingDays;
      const removed = before.workingDays.filter((d) => !nextDays.includes(d));
      if (removed.length) {
        const use = await this.liveUsage(
          tx,
          tenantId,
          sql`${timetableEntries.dayOfWeek} in (${sql.join(
            removed.map((d) => sql`${d}`),
            sql`, `,
          )})`,
        );
        if (use.in_use)
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            'A draft or published timetable still schedules lessons on a day you are removing',
            { reason: 'DAY_IN_USE', removed_days: removed, ...use },
          );
      }
      await tx
        .update(timetableSettings)
        .set({
          workingDays: [...nextDays].sort((a, b) => a - b),
          ...(input.school_day_start ? { dayStart: `${input.school_day_start}:00` } : {}),
          ...(input.school_day_end ? { dayEnd: `${input.school_day_end}:00` } : {}),
          version: before.version + 1,
          updatedBy: actor.userId,
        })
        .where(eq(timetableSettings.tenantId, tenantId));
      const after = await readSettings(tx, tenantId);
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_SETTINGS_UPDATED',
        entityType: 'timetable_settings',
        entityId: tenantId,
        event: 'timetable.settings_updated',
        before: settingsPresent(before),
        after: settingsPresent(after),
        payload: { working_days: after.workingDays, school_day_start: input.school_day_start, school_day_end: input.school_day_end },
      });
    });
    return settingsPresent(await readSettings(this.db, tenantId));
  }

  // ---- periods ---------------------------------------------------------------------

  async listPeriods(tenantId: string, q: z.infer<typeof PeriodListQuery>) {
    const conds = [eq(timetablePeriods.tenantId, tenantId)];
    if (q.status) conds.push(eq(timetablePeriods.status, q.status));
    if (q.kind) conds.push(eq(timetablePeriods.kind, q.kind));
    const rows = await this.db
      .select()
      .from(timetablePeriods)
      .where(and(...conds))
      .orderBy(
        asc(timetablePeriods.startTime),
        asc(timetablePeriods.displayOrder),
        asc(timetablePeriods.code),
      );
    if (!q.section_id && !q.class_id) {
      // The default school day.
      return rows.filter((p) => !p.academicClassId && !p.academicSectionId).map(periodPresent);
    }
    const scope = await this.resolveScope(this.db, tenantId, q);
    const everything = await this.db
      .select()
      .from(timetablePeriods)
      .where(and(eq(timetablePeriods.tenantId, tenantId), eq(timetablePeriods.status, 'ACTIVE')));
    // Which set of periods applies: found from the active ones, then every status of that set is listed.
    const applies = periodsForSection(everything, {
      id: scope.sectionId ?? '00000000-0000-0000-0000-000000000000',
      classId: scope.classId ?? '00000000-0000-0000-0000-000000000000',
    });
    const first = applies[0];
    const target = first
      ? { classId: first.academicClassId, sectionId: first.academicSectionId }
      : { classId: null, sectionId: null };
    return rows
      .filter(
        (p) => p.academicClassId === target.classId && p.academicSectionId === target.sectionId,
      )
      .map(periodPresent);
  }

  /** Validates a class / section and returns the scope a period is saved under (section implies its class). */
  private async resolveScope(
    ex: Executor,
    tenantId: string,
    input: { class_id?: string; section_id?: string },
  ): Promise<{ classId: string | null; sectionId: string | null }> {
    if (input.section_id) {
      const [sec] = await ex
        .select({ id: academicSections.id, classId: academicSections.classId })
        .from(academicSections)
        .where(
          and(eq(academicSections.id, input.section_id), eq(academicSections.tenantId, tenantId)),
        );
      if (!sec) throw new NotFoundError('Section');
      if (input.class_id && input.class_id !== sec.classId)
        throw validationIssue('section_id', 'This section does not belong to that class');
      return { classId: sec.classId, sectionId: sec.id };
    }
    if (input.class_id) {
      const [cls] = await ex
        .select({ id: academicClasses.id })
        .from(academicClasses)
        .where(and(eq(academicClasses.id, input.class_id), eq(academicClasses.tenantId, tenantId)));
      if (!cls) throw new NotFoundError('Class');
      return { classId: cls.id, sectionId: null };
    }
    return { classId: null, sectionId: null };
  }

  private async loadPeriod(ex: Executor, tenantId: string, id: string, lock?: 'update') {
    const q = ex
      .select()
      .from(timetablePeriods)
      .where(and(eq(timetablePeriods.id, id), eq(timetablePeriods.tenantId, tenantId)));
    const [row] = await (lock ? q.for(lock) : q);
    if (!row) throw new NotFoundError('Period');
    return row;
  }

  async getPeriod(tenantId: string, id: string) {
    return periodPresent(await this.loadPeriod(this.db, tenantId, id));
  }

  /** ACTIVE periods must not overlap. The settings row is the mutex (locking read). */
  private async assertNoOverlap(
    tx: Executor,
    tenantId: string,
    start: string,
    end: string,
    scope: { classId: string | null; sectionId: string | null },
    exceptId?: string,
  ) {
    const clash = await tx
      .select()
      .from(timetablePeriods)
      .where(
        and(
          eq(timetablePeriods.tenantId, tenantId),
          eq(timetablePeriods.status, 'ACTIVE'),
          scope.classId
            ? eq(timetablePeriods.academicClassId, scope.classId)
            : isNull(timetablePeriods.academicClassId),
          scope.sectionId
            ? eq(timetablePeriods.academicSectionId, scope.sectionId)
            : isNull(timetablePeriods.academicSectionId),
          exceptId ? ne(timetablePeriods.id, exceptId) : undefined,
          sql`${timetablePeriods.startTime} < ${hhmmss(end)} and ${timetablePeriods.endTime} > ${hhmmss(start)}`,
        ),
      )
      .for('update');
    if (clash.length)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'The period overlaps another active period of this school day',
        { reason: 'PERIOD_OVERLAP', overlapping: clash.map(periodPresent) },
      );
  }

  async createPeriod(tenantId: string, input: z.infer<typeof CreatePeriodBody>, actor: Actor) {
    await this.ensureSettings(tenantId);
    let id!: string;
    await this.db.transaction(async (tx) => {
      await readSettings(tx, tenantId, 'update');
      const scope = await this.resolveScope(tx, tenantId, input);
      await this.assertNoOverlap(tx, tenantId, input.start_time, input.end_time, scope);
      // Codes are unique across the whole school (every class/section set and every
      // status), so only the server can pick a free one reliably. The settings row
      // lock taken above serialises concurrent creates.
      const code = input.code ?? (await nextPeriodCode(tx, tenantId, input.kind));
      try {
        const [ins] = await tx
          .insert(timetablePeriods)
          .values({
            tenantId,
            code,
            name: input.name,
            startTime: hhmmss(input.start_time),
            endTime: hhmmss(input.end_time),
            kind: input.kind,
            displayOrder: input.display_order,
            academicClassId: scope.classId,
            academicSectionId: scope.sectionId,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          })
          .$returningId();
        id = ins!.id;
      } catch (err) {
        if (isDuplicateKeyError(err))
          throw new ConflictError('DUPLICATE_RESOURCE', 'A period with this code already exists');
        throw err;
      }
      const row = await this.loadPeriod(tx, tenantId, id);
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_PERIOD_CREATED',
        entityType: 'timetable_period',
        entityId: id,
        event: 'timetable_period.created',
        after: periodPresent(row),
        payload: { code: row.code, kind: row.kind },
      });
    });
    return this.getPeriod(tenantId, id);
  }

  async updatePeriod(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdatePeriodBody>,
    actor: Actor,
  ) {
    await this.ensureSettings(tenantId);
    await this.db.transaction(async (tx) => {
      await readSettings(tx, tenantId, 'update');
      const before = await this.loadPeriod(tx, tenantId, id, 'update');
      if (before.version !== input.version)
        throw new ConflictError('CONFLICT', undefined, { reason: 'STALE_VERSION' });
      const start = input.start_time ?? before.startTime.slice(0, 5);
      const end = input.end_time ?? before.endTime.slice(0, 5);
      if (start >= end)
        throw validationIssue('end_time', 'The end time must be after the start time');
      const kind = input.kind ?? before.kind;
      if (before.kind === 'LESSON' && kind !== 'LESSON') {
        const use = await this.liveUsage(tx, tenantId, eq(timetableEntries.periodId, id));
        if (use.in_use)
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            'Lessons are scheduled in this period, so it must stay a lesson period',
            { reason: 'PERIOD_IN_USE', ...use },
          );
      }
      if (before.status === 'ACTIVE')
        await this.assertNoOverlap(
          tx,
          tenantId,
          start,
          end,
          { classId: before.academicClassId, sectionId: before.academicSectionId },
          id,
        );
      const set: Partial<typeof timetablePeriods.$inferInsert> = {
        startTime: hhmmss(start),
        endTime: hhmmss(end),
        kind,
      };
      if (input.name !== undefined) set.name = input.name;
      if (input.display_order !== undefined) set.displayOrder = input.display_order;
      await tx
        .update(timetablePeriods)
        .set({ ...set, version: before.version + 1, updatedBy: actor.userId })
        .where(eq(timetablePeriods.id, id));
      const after = await this.loadPeriod(tx, tenantId, id);
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_PERIOD_UPDATED',
        entityType: 'timetable_period',
        entityId: id,
        event: 'timetable_period.updated',
        before: periodPresent(before),
        after: periodPresent(after),
        payload: { changed: Object.keys(input).filter((k) => k !== 'version') },
      });
    });
    return this.getPeriod(tenantId, id);
  }

  async setPeriodState(tenantId: string, id: string, to: 'ACTIVE' | 'INACTIVE', actor: Actor) {
    await this.ensureSettings(tenantId);
    await this.db.transaction(async (tx) => {
      await readSettings(tx, tenantId, 'update');
      const before = await this.loadPeriod(tx, tenantId, id, 'update');
      if (before.status === to) return;
      if (to === 'ACTIVE')
        await this.assertNoOverlap(
          tx,
          tenantId,
          before.startTime.slice(0, 5),
          before.endTime.slice(0, 5),
          { classId: before.academicClassId, sectionId: before.academicSectionId },
          id,
        );
      else {
        const use = await this.liveUsage(tx, tenantId, eq(timetableEntries.periodId, id));
        if (use.in_use)
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            'Lessons are scheduled in this period in a draft or published timetable',
            { reason: 'PERIOD_IN_USE', ...use },
          );
      }
      await tx
        .update(timetablePeriods)
        .set({ status: to, version: before.version + 1, updatedBy: actor.userId })
        .where(eq(timetablePeriods.id, id));
      await recordChange(tx, actor, tenantId, {
        action: to === 'ACTIVE' ? 'TIMETABLE_PERIOD_ACTIVATED' : 'TIMETABLE_PERIOD_DEACTIVATED',
        entityType: 'timetable_period',
        entityId: id,
        event: `timetable_period.${to === 'ACTIVE' ? 'activated' : 'deactivated'}`,
        before: { status: before.status },
        after: { status: to },
      });
    });
    return this.getPeriod(tenantId, id);
  }

  /** Delete a period no timetable (of any status) has ever used. Otherwise deactivate it. */
  async deletePeriod(tenantId: string, id: string, actor: Actor) {
    await this.ensureSettings(tenantId);
    await this.db.transaction(async (tx) => {
      await readSettings(tx, tenantId, 'update');
      const before = await this.loadPeriod(tx, tenantId, id, 'update');
      await this.assertUnused(tx, tenantId, eq(timetableEntries.periodId, id), 'PERIOD_IN_USE');
      await tx.delete(timetablePeriods).where(eq(timetablePeriods.id, id));
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_PERIOD_DELETED',
        entityType: 'timetable_period',
        entityId: id,
        event: 'timetable_period.deleted',
        before: periodPresent(before),
      });
    });
  }

  private async assertUnused(tx: Executor, tenantId: string, where: SQL, reason: string) {
    const [used] = await tx
      .select({ id: timetableEntries.id })
      .from(timetableEntries)
      .where(and(eq(timetableEntries.tenantId, tenantId), where))
      .limit(1)
      .for('share');
    if (used)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'It is used by timetable entries (including archived versions). Deactivate it instead.',
        { reason },
      );
  }

  // ---- venues ----------------------------------------------------------------------

  async listVenues(tenantId: string, q: z.infer<typeof VenueListQuery>) {
    const conds: (SQL | undefined)[] = [eq(timetableVenues.tenantId, tenantId)];
    if (q.status) conds.push(eq(timetableVenues.status, q.status));
    if (q.venue_type) conds.push(eq(timetableVenues.venueType, q.venue_type));
    if (q.search) {
      const s = likeOf(q.search);
      conds.push(or(like(timetableVenues.name, s), like(timetableVenues.code, s)));
    }
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(timetableVenues)
        .where(where)
        .orderBy(
          orderFrom(
            { ...q, order: q.sort ? q.order : 'asc' },
            {
              name: timetableVenues.name,
              code: timetableVenues.code,
              capacity: timetableVenues.capacity,
              venue_type: timetableVenues.venueType,
            },
            'name',
          ),
          asc(timetableVenues.id),
        )
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(timetableVenues).where(where),
    ]);
    return pageOf(rows.map(venuePresent), total?.n ?? 0, q);
  }

  private async loadVenue(ex: Executor, tenantId: string, id: string, lock?: 'update') {
    const q = ex
      .select()
      .from(timetableVenues)
      .where(and(eq(timetableVenues.id, id), eq(timetableVenues.tenantId, tenantId)));
    const [row] = await (lock ? q.for(lock) : q);
    if (!row) throw new NotFoundError('Venue');
    return row;
  }

  async getVenue(tenantId: string, id: string) {
    return venuePresent(await this.loadVenue(this.db, tenantId, id));
  }

  async createVenue(tenantId: string, input: z.infer<typeof CreateVenueBody>, actor: Actor) {
    let id!: string;
    await this.db.transaction(async (tx) => {
      try {
        const [ins] = await tx
          .insert(timetableVenues)
          .values({
            tenantId,
            code: input.code,
            name: input.name,
            venueType: input.venue_type,
            capacity: input.capacity ?? null,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          })
          .$returningId();
        id = ins!.id;
      } catch (err) {
        if (isDuplicateKeyError(err))
          throw new ConflictError('DUPLICATE_RESOURCE', 'A venue with this code already exists');
        throw err;
      }
      const row = await this.loadVenue(tx, tenantId, id);
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_VENUE_CREATED',
        entityType: 'timetable_venue',
        entityId: id,
        event: 'timetable_venue.created',
        after: venuePresent(row),
        payload: { code: row.code, venue_type: row.venueType },
      });
    });
    return this.getVenue(tenantId, id);
  }

  async updateVenue(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateVenueBody>,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const before = await this.loadVenue(tx, tenantId, id, 'update');
      if (before.version !== input.version)
        throw new ConflictError('CONFLICT', undefined, { reason: 'STALE_VERSION' });
      const set: Partial<VenueRow> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.venue_type !== undefined) set.venueType = input.venue_type;
      if (input.capacity !== undefined) set.capacity = input.capacity;
      await tx
        .update(timetableVenues)
        .set({ ...set, version: before.version + 1, updatedBy: actor.userId })
        .where(eq(timetableVenues.id, id));
      const after = await this.loadVenue(tx, tenantId, id);
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_VENUE_UPDATED',
        entityType: 'timetable_venue',
        entityId: id,
        event: 'timetable_venue.updated',
        before: venuePresent(before),
        after: venuePresent(after),
        payload: { changed: Object.keys(input).filter((k) => k !== 'version') },
      });
    });
    return this.getVenue(tenantId, id);
  }

  async setVenueState(tenantId: string, id: string, to: 'ACTIVE' | 'INACTIVE', actor: Actor) {
    await this.db.transaction(async (tx) => {
      const before = await this.loadVenue(tx, tenantId, id, 'update');
      if (before.status === to) return;
      if (to === 'INACTIVE') {
        const use = await this.liveUsage(tx, tenantId, eq(timetableEntries.venueId, id));
        if (use.in_use)
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            'Lessons use this venue in a draft or published timetable',
            { reason: 'VENUE_IN_USE', ...use },
          );
      }
      await tx
        .update(timetableVenues)
        .set({ status: to, version: before.version + 1, updatedBy: actor.userId })
        .where(eq(timetableVenues.id, id));
      await recordChange(tx, actor, tenantId, {
        action: to === 'ACTIVE' ? 'TIMETABLE_VENUE_ACTIVATED' : 'TIMETABLE_VENUE_DEACTIVATED',
        entityType: 'timetable_venue',
        entityId: id,
        event: `timetable_venue.${to === 'ACTIVE' ? 'activated' : 'deactivated'}`,
        before: { status: before.status },
        after: { status: to },
      });
    });
    return this.getVenue(tenantId, id);
  }

  async deleteVenue(tenantId: string, id: string, actor: Actor) {
    await this.db.transaction(async (tx) => {
      const before = await this.loadVenue(tx, tenantId, id, 'update');
      await this.assertUnused(tx, tenantId, eq(timetableEntries.venueId, id), 'VENUE_IN_USE');
      await tx.delete(timetableVenues).where(eq(timetableVenues.id, id));
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_VENUE_DELETED',
        entityType: 'timetable_venue',
        entityId: id,
        event: 'timetable_venue.deleted',
        before: venuePresent(before),
      });
    });
  }
}

export type { PeriodRow };

const PERIOD_CODE_PREFIX: Record<string, string> = {
  LESSON: 'P',
  BREAK: 'BRK',
  LUNCH: 'LUNCH',
  ASSEMBLY: 'ASM',
  CUSTOM: 'CUS',
};

/** The lowest free `<PREFIX><n>` code for [kind] across all of the school's periods. */
async function nextPeriodCode(tx: Executor, tenantId: string, kind: string): Promise<string> {
  const prefix = PERIOD_CODE_PREFIX[kind] ?? 'PER';
  const rows = await tx
    .select({ code: timetablePeriods.code })
    .from(timetablePeriods)
    .where(and(eq(timetablePeriods.tenantId, tenantId), like(timetablePeriods.code, `${prefix}%`)));
  const taken = new Set(rows.map((r) => r.code.toUpperCase()));
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}
