import { and, asc, count, eq, like, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  timetableDayOverrides,
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
  CreateVenueBody,
  UpdateSettingsBody,
  UpdateVenueBody,
  VenueListQuery,
} from './timetable.schemas.js';
import {
  DEFAULT_WORKING_DAYS,
  readSettings,
  settingsPresent,
  venuePresent,
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
 * Timetable configuration: the school's teaching days and the venues. A venue
 * that lessons use cannot be closed or deleted. Periods (each section's school
 * day, with its subjects and teachers) live in PeriodService.
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

  /** Whether any period or weekday exception uses the venue. */
  private async venueInUse(tx: Executor, tenantId: string, venueId: string) {
    const [p] = await tx
      .select({ id: timetablePeriods.id })
      .from(timetablePeriods)
      .where(and(eq(timetablePeriods.tenantId, tenantId), eq(timetablePeriods.venueId, venueId)))
      .limit(1)
      .for('share');
    if (p) return true;
    const [o] = await tx
      .select({ id: timetableDayOverrides.id })
      .from(timetableDayOverrides)
      .where(
        and(
          eq(timetableDayOverrides.tenantId, tenantId),
          eq(timetableDayOverrides.venueId, venueId),
        ),
      )
      .limit(1)
      .for('share');
    return !!o;
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
      // The week is periods x working days: removing a day simply removes its lessons.
      const nextDays = input.working_days ?? before.workingDays;
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
        payload: {
          working_days: after.workingDays,
          school_day_start: input.school_day_start,
          school_day_end: input.school_day_end,
        },
      });
    });
    return settingsPresent(await readSettings(this.db, tenantId));
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
      if (to === 'INACTIVE' && (await this.venueInUse(tx, tenantId, id)))
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'Lessons use this venue. Move them to another venue first.',
          { reason: 'VENUE_IN_USE' },
        );
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
      if (await this.venueInUse(tx, tenantId, id))
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'Lessons use this venue. Move them to another venue first.',
          { reason: 'VENUE_IN_USE' },
        );
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
