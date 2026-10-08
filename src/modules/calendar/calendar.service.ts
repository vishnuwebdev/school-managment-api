import { and, asc, eq, gte, inArray, lte, ne } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import { academicClasses, schoolCalendarSettings, schoolHolidays } from '../../db/schema/index.js';
import type { Actor } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors.js';
import {
  countDays,
  dayOff,
  DEFAULT_CALENDAR,
  type CalendarSettings,
  type CalendarSubject,
  type HolidayLike,
} from './calendar.rules.js';
import type {
  CreateHolidayBody,
  HolidayListQuery,
  UpdateCalendarSettingsBody,
  UpdateHolidayBody,
} from './calendar.schemas.js';

type HolidayRow = typeof schoolHolidays.$inferSelect;

/** Called after the calendar changes, inside the same transaction, so leave can be recounted. */
export type CalendarChangeListener = (
  tx: Executor,
  tenantId: string,
  range: { from: string; to: string } | 'all',
  note: string,
  actor: Actor,
) => Promise<number>;

const presentHoliday = (h: HolidayRow) => ({
  id: h.id,
  name: h.name,
  start_date: h.startDate,
  end_date: h.endDate,
  audience: h.audience,
  class_ids: h.classIds ?? [],
  description: h.description,
  status: h.status,
  version: h.version,
  created_at: h.createdAt.toISOString(),
  updated_at: h.updatedAt.toISOString(),
});

const asLike = (h: HolidayRow): HolidayLike => ({
  id: h.id,
  name: h.name,
  startDate: h.startDate,
  endDate: h.endDate,
  audience: h.audience,
  classIds: h.classIds ?? null,
});

/**
 * The school calendar: weekly off days and holidays. The single place that
 * decides whether a day is a working day for staff or a school day for a
 * class. Leave, attendance and the timetable read it; when it changes, open
 * leave is recounted through the registered listener.
 */
export class CalendarService {
  private listeners: CalendarChangeListener[] = [];
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  onChange(l: CalendarChangeListener) {
    this.listeners.push(l);
  }

  private async notify(tx: Executor, tenantId: string, range: { from: string; to: string } | 'all', note: string, actor: Actor) {
    let n = 0;
    for (const l of this.listeners) n += await l(tx, tenantId, range, note, actor);
    return n;
  }

  // ---- settings -------------------------------------------------------------------------------

  async settings(tenantId: string, ex: Executor = this.db): Promise<CalendarSettings & { version: number }> {
    const [row] = await ex.select().from(schoolCalendarSettings).where(eq(schoolCalendarSettings.tenantId, tenantId));
    return row
      ? { weeklyOffDays: row.weeklyOffDays, offSaturdays: row.offSaturdays, version: row.version }
      : { ...DEFAULT_CALENDAR, version: 0 };
  }

  async getSettings(tenantId: string) {
    const s = await this.settings(tenantId);
    return { weekly_off_days: s.weeklyOffDays, off_saturdays: s.offSaturdays, version: s.version };
  }

  async updateSettings(tenantId: string, input: z.infer<typeof UpdateCalendarSettingsBody>, actor: Actor) {
    const weekly = [...new Set(input.weekly_off_days)].sort();
    const sats = [...new Set(input.off_saturdays)].sort();
    if (weekly.length >= 7)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'At least one day of the week must be a working day', {
        field: 'weekly_off_days',
      });
    const recounted = await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(schoolCalendarSettings)
        .where(eq(schoolCalendarSettings.tenantId, tenantId))
        .for('update');
      const current = before?.version ?? 0;
      if (input.version !== current) throw new ConflictError('CONFLICT', undefined, { current_version: current });
      if (before)
        await tx
          .update(schoolCalendarSettings)
          .set({ weeklyOffDays: weekly, offSaturdays: sats, version: current + 1, updatedBy: actor.userId })
          .where(eq(schoolCalendarSettings.tenantId, tenantId));
      else
        await tx.insert(schoolCalendarSettings).values({
          tenantId,
          weeklyOffDays: weekly,
          offSaturdays: sats,
          version: 1,
          updatedBy: actor.userId,
        });
      await recordChange(tx, actor, tenantId, {
        action: 'CALENDAR_SETTINGS_UPDATED',
        entityType: 'school_calendar',
        entityId: tenantId,
        event: 'school_calendar.updated',
        before: before ? { weekly_off_days: before.weeklyOffDays, off_saturdays: before.offSaturdays } : DEFAULT_CALENDAR,
        after: { weekly_off_days: weekly, off_saturdays: sats },
      });
      return this.notify(tx, tenantId, 'all', 'Weekly off days changed', actor);
    });
    return { ...(await this.getSettings(tenantId)), leave_recounted: recounted };
  }

  // ---- holidays -------------------------------------------------------------------------------

  /** Active holidays overlapping [from, to]. */
  async activeHolidays(tenantId: string, from: string, to: string, ex: Executor = this.db): Promise<HolidayLike[]> {
    const rows = await ex
      .select()
      .from(schoolHolidays)
      .where(
        and(
          eq(schoolHolidays.tenantId, tenantId),
          eq(schoolHolidays.status, 'ACTIVE'),
          lte(schoolHolidays.startDate, to),
          gte(schoolHolidays.endDate, from),
        ),
      );
    return rows.map(asLike);
  }

  async listHolidays(tenantId: string, q: z.infer<typeof HolidayListQuery>) {
    const conds = [eq(schoolHolidays.tenantId, tenantId)];
    if (!q.include_cancelled) conds.push(eq(schoolHolidays.status, 'ACTIVE'));
    if (q.from) conds.push(gte(schoolHolidays.endDate, q.from));
    if (q.to) conds.push(lte(schoolHolidays.startDate, q.to));
    const rows = await this.db
      .select()
      .from(schoolHolidays)
      .where(and(...conds))
      .orderBy(asc(schoolHolidays.startDate));
    return rows.map(presentHoliday);
  }

  private async load(ex: Executor, tenantId: string, id: string, lock = false) {
    const q = ex
      .select()
      .from(schoolHolidays)
      .where(and(eq(schoolHolidays.tenantId, tenantId), eq(schoolHolidays.id, id)));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw new NotFoundError('Holiday');
    return row;
  }

  private async validate(
    ex: Executor,
    tenantId: string,
    h: { start: string; end: string; audience: string; classIds: string[] | null; exceptId?: string },
  ) {
    if (h.end < h.start)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'The end date cannot be before the start date', {
        field: 'end_date',
      });
    const span = (Date.parse(h.end) - Date.parse(h.start)) / 86_400_000 + 1;
    if (span > 120)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'A holiday cannot be longer than 120 days', {
        field: 'end_date',
      });
    if (h.audience === 'CLASSES') {
      const ids = h.classIds ?? [];
      if (!ids.length)
        throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'Choose at least one class', { field: 'class_ids' });
      const found = await ex
        .select({ id: academicClasses.id })
        .from(academicClasses)
        .where(and(eq(academicClasses.tenantId, tenantId), inArray(academicClasses.id, ids)));
      if (found.length !== new Set(ids).size) throw new NotFoundError('Class');
    }
    // A second whole-school holiday on the same days is almost always a mistake.
    if (h.audience === 'ALL') {
      const conds = [
        eq(schoolHolidays.tenantId, tenantId),
        eq(schoolHolidays.status, 'ACTIVE'),
        eq(schoolHolidays.audience, 'ALL'),
        lte(schoolHolidays.startDate, h.end),
        gte(schoolHolidays.endDate, h.start),
      ];
      if (h.exceptId) conds.push(ne(schoolHolidays.id, h.exceptId));
      const [clash] = await ex.select().from(schoolHolidays).where(and(...conds)).limit(1);
      if (clash)
        throw new ConflictError(
          'CONFLICT',
          `These dates overlap the holiday "${clash.name}" (${clash.startDate} – ${clash.endDate})`,
          { field: 'start_date', holiday_id: clash.id },
        );
    }
  }

  async createHoliday(tenantId: string, input: z.infer<typeof CreateHolidayBody>, actor: Actor) {
    const classIds = input.audience === 'CLASSES' ? input.class_ids ?? [] : null;
    const r = await this.db.transaction(async (tx) => {
      await this.validate(tx, tenantId, { start: input.start_date, end: input.end_date, audience: input.audience, classIds });
      const [ins] = await tx
        .insert(schoolHolidays)
        .values({
          tenantId,
          name: input.name,
          startDate: input.start_date,
          endDate: input.end_date,
          audience: input.audience,
          classIds,
          description: input.description ?? null,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .$returningId();
      const row = await this.load(tx, tenantId, ins!.id);
      await recordChange(tx, actor, tenantId, {
        action: 'HOLIDAY_CREATED',
        entityType: 'school_holiday',
        entityId: row.id,
        event: 'school_holiday.created',
        after: presentHoliday(row),
      });
      const recounted = await this.notify(tx, tenantId, { from: row.startDate, to: row.endDate }, `Holiday added: ${row.name}`, actor);
      return { row, recounted };
    });
    return { ...presentHoliday(r.row), leave_recounted: r.recounted };
  }

  async updateHoliday(tenantId: string, id: string, input: z.infer<typeof UpdateHolidayBody>, actor: Actor) {
    const r = await this.db.transaction(async (tx) => {
      const before = await this.load(tx, tenantId, id, true);
      if (before.status !== 'ACTIVE')
        throw new BusinessRuleError('INVALID_STATE', 'A cancelled holiday cannot be edited');
      if (before.version !== input.version)
        throw new ConflictError('CONFLICT', undefined, { current_version: before.version });
      const audience = input.audience ?? before.audience;
      const classIds = audience === 'CLASSES' ? input.class_ids ?? before.classIds ?? [] : null;
      const start = input.start_date ?? before.startDate;
      const end = input.end_date ?? before.endDate;
      await this.validate(tx, tenantId, { start, end, audience, classIds, exceptId: id });
      await tx
        .update(schoolHolidays)
        .set({
          name: input.name ?? before.name,
          startDate: start,
          endDate: end,
          audience,
          classIds,
          description: input.description === undefined ? before.description : input.description,
          version: before.version + 1,
          updatedBy: actor.userId,
        })
        .where(and(eq(schoolHolidays.tenantId, tenantId), eq(schoolHolidays.id, id)));
      const after = await this.load(tx, tenantId, id);
      await recordChange(tx, actor, tenantId, {
        action: 'HOLIDAY_UPDATED',
        entityType: 'school_holiday',
        entityId: id,
        event: 'school_holiday.updated',
        before: presentHoliday(before),
        after: presentHoliday(after),
      });
      const from = before.startDate < start ? before.startDate : start;
      const to = before.endDate > end ? before.endDate : end;
      const recounted = await this.notify(tx, tenantId, { from, to }, `Holiday changed: ${after.name}`, actor);
      return { after, recounted };
    });
    return { ...presentHoliday(r.after), leave_recounted: r.recounted };
  }

  async cancelHoliday(tenantId: string, id: string, version: number, reason: string | undefined, actor: Actor) {
    const r = await this.db.transaction(async (tx) => {
      const before = await this.load(tx, tenantId, id, true);
      if (before.status !== 'ACTIVE') throw new BusinessRuleError('INVALID_STATE', 'The holiday is already cancelled');
      if (before.version !== version) throw new ConflictError('CONFLICT', undefined, { current_version: before.version });
      await tx
        .update(schoolHolidays)
        .set({ status: 'CANCELLED', version: before.version + 1, updatedBy: actor.userId })
        .where(and(eq(schoolHolidays.tenantId, tenantId), eq(schoolHolidays.id, id)));
      const after = await this.load(tx, tenantId, id);
      await recordChange(tx, actor, tenantId, {
        action: 'HOLIDAY_CANCELLED',
        entityType: 'school_holiday',
        entityId: id,
        event: 'school_holiday.cancelled',
        before: presentHoliday(before),
        after: presentHoliday(after),
        reason: reason ?? null,
      });
      const recounted = await this.notify(
        tx,
        tenantId,
        { from: before.startDate, to: before.endDate },
        `Holiday cancelled: ${before.name}`,
        actor,
      );
      return { after, recounted };
    });
    return { ...presentHoliday(r.after), leave_recounted: r.recounted };
  }

  // ---- day questions --------------------------------------------------------------------------

  /** Working days for [who] in [from, to] (inclusive) and the days left out, with reasons. */
  async workingDays(tenantId: string, from: string, to: string, who: CalendarSubject, ex: Executor = this.db) {
    const [s, hs] = await Promise.all([this.settings(tenantId, ex), this.activeHolidays(tenantId, from, to, ex)]);
    return { from, to, ...countDays(s, hs, from, to, who) };
  }

  /** Why [date] is off for [who], or null on a working / school day. */
  async dayOff(tenantId: string, date: string, who: CalendarSubject, ex: Executor = this.db) {
    const [s, hs] = await Promise.all([this.settings(tenantId, ex), this.activeHolidays(tenantId, date, date, ex)]);
    return dayOff(s, hs, date, who);
  }

  /** Everything a month/period view needs: settings, holidays and every off day for [who]. */
  async calendarView(tenantId: string, from: string, to: string, who: CalendarSubject) {
    const [s, hs] = await Promise.all([this.settings(tenantId), this.activeHolidays(tenantId, from, to)]);
    return {
      weekly_off_days: s.weeklyOffDays,
      off_saturdays: s.offSaturdays,
      ...countDays(s, hs, from, to, who),
    };
  }
}
