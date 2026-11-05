import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  calendarCategories,
  calendarEvents,
  schoolCalendarSettings,
} from '../../db/schema/index.js';
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
  CreateCategoryBody,
  CreateEventBody,
  EventListQuery,
  HolidayListQuery,
  UpdateCalendarSettingsBody,
  UpdateCategoryBody,
  UpdateEventBody,
} from './calendar.schemas.js';

type CategoryRow = typeof calendarCategories.$inferSelect;
type EventRow = typeof calendarEvents.$inferSelect;

/**
 * Called after the calendar changes, inside the same transaction. No listener is registered
 * today (leave was removed with the Teachers-only change); the future Staff section's leave
 * module hooks in here to recount open leave.
 */
export type CalendarChangeListener = (
  tx: Executor,
  tenantId: string,
  range: { from: string; to: string } | 'all',
  note: string,
  actor: Actor,
) => Promise<number>;

/** Every school starts with these; admins can rename, recolour, switch off or add their own. */
const DEFAULT_CATEGORIES = [
  { code: 'HOLIDAY', name: 'Holiday', color: '#F43F5E', closesSchool: true, sortOrder: 1 },
  { code: 'VACATION', name: 'Vacation', color: '#EC4899', closesSchool: true, sortOrder: 2 },
  { code: 'EXAM', name: 'Exam / Test', color: '#F59E0B', closesSchool: false, sortOrder: 3 },
  { code: 'SPORTS', name: 'Sports', color: '#10B981', closesSchool: false, sortOrder: 4 },
  { code: 'ACTIVITY', name: 'Activity', color: '#14B8A6', closesSchool: false, sortOrder: 5 },
  { code: 'OCCASION', name: 'Occasion', color: '#8B5CF6', closesSchool: false, sortOrder: 6 },
  { code: 'MEETING', name: 'Meeting', color: '#3B82F6', closesSchool: false, sortOrder: 7 },
  { code: 'INFO', name: 'General info', color: '#64748B', closesSchool: false, sortOrder: 8 },
];

/** Pre-categories API type → category code. */
const LEGACY_TYPE_CODE: Record<string, string> = {
  EVENT: 'ACTIVITY',
  EXAM: 'EXAM',
  MEETING: 'MEETING',
  HOLIDAY: 'HOLIDAY',
};

/** The type the teacher app (built before categories) understands. */
const legacyType = (c: CategoryRow) =>
  c.closesSchool ? 'HOLIDAY' : c.code === 'EXAM' ? 'EXAM' : c.code === 'MEETING' ? 'MEETING' : 'EVENT';

/** MySQL TIME comes back as HH:MM:SS; the API speaks HH:MM. */
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);

const presentCategory = (c: CategoryRow) => ({
  id: c.id,
  code: c.code,
  name: c.name,
  color: c.color,
  closes_school: c.closesSchool,
  is_system: c.isSystem,
  is_active: c.isActive,
  sort_order: c.sortOrder,
  version: c.version,
});

const presentEvent = (e: EventRow, c: CategoryRow) => ({
  id: e.id,
  category_id: c.id,
  category: { id: c.id, code: c.code, name: c.name, color: c.color, closes_school: c.closesSchool },
  /** Legacy (teacher app): HOLIDAY / EXAM / MEETING / EVENT. */
  type: legacyType(c),
  title: e.title,
  start_date: e.startDate,
  end_date: e.endDate,
  start_time: hhmm(e.startTime),
  end_time: hhmm(e.endTime),
  audience: e.audience,
  class_ids: e.classIds ?? [],
  section_ids: e.sectionIds ?? [],
  description: e.description,
  staff_action: e.staffAction,
  action_link: e.actionLink,
  status: e.status,
  version: e.version,
  created_at: e.createdAt.toISOString(),
  updated_at: e.updatedAt.toISOString(),
});
type PresentedEvent = ReturnType<typeof presentEvent>;

/** Legacy holiday shape (teacher app) for a school-closing entry. */
const presentAsHoliday = (e: PresentedEvent) => ({
  id: e.id,
  name: e.title,
  start_date: e.start_date,
  end_date: e.end_date,
  audience: e.audience,
  class_ids: e.class_ids,
  section_ids: e.section_ids,
  description: e.description,
  status: e.status,
  version: e.version,
  category: e.category,
  created_at: e.created_at,
  updated_at: e.updated_at,
});

const slug = (name: string) =>
  name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24) || 'CATEGORY';

/**
 * The school calendar: weekly off days, categories and calendar entries
 * (holidays, vacations, exams, sports, meetings …). The single place that
 * decides whether a day is a working day for staff or a school day for a
 * class: entries in a category that closes the school are days off. Leave,
 * attendance and the timetable read it; when it changes, open leave is
 * recounted through the registered listener.
 */
export class CalendarService {
  private listeners: CalendarChangeListener[] = [];
  private readyTenants = new Set<string>();
  private legacyEventsTable: boolean | null = null;
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

  // ---- weekly off days -------------------------------------------------------------------------------

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

  // ---- first use: default categories + copy of the old holiday / event tables ---------------------

  /**
   * Gives a school its built-in categories the first time the calendar is
   * used, and copies its entries from the old school_holidays / school_events
   * tables (same ids, so it is safe to run twice).
   */
  private async ready(tenantId: string) {
    if (this.readyTenants.has(tenantId)) return;
    const [has] = await this.db
      .select({ id: calendarCategories.id })
      .from(calendarCategories)
      .where(eq(calendarCategories.tenantId, tenantId))
      .limit(1);
    if (!has) {
      await this.db
        .insert(calendarCategories)
        .values(DEFAULT_CATEGORIES.map((c) => ({ tenantId, ...c, isSystem: true })))
        .onDuplicateKeyUpdate({ set: { code: sql`${calendarCategories.code}` } });
      await this.copyLegacy(tenantId);
    }
    this.readyTenants.add(tenantId);
  }

  private async copyLegacy(tenantId: string) {
    try {
      await this.db.execute(sql`
        INSERT IGNORE INTO calendar_events
          (id, tenant_id, category_id, title, start_date, end_date, audience, class_ids, description,
           status, version, created_by, created_at, updated_by, updated_at)
        SELECT h.id, h.tenant_id, c.id, h.name, h.start_date, h.end_date, h.audience, h.class_ids,
               h.description, h.status, h.version, h.created_by, h.created_at, h.updated_by, h.updated_at
        FROM school_holidays h
        JOIN calendar_categories c ON c.tenant_id = h.tenant_id AND c.code = 'HOLIDAY'
        WHERE h.tenant_id = ${tenantId}`);
      if (this.legacyEventsTable === null) {
        const [rows] = (await this.db.execute(
          sql`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'school_events'`,
        )) as unknown as [{ n: number }[]];
        this.legacyEventsTable = Number(rows?.[0]?.n ?? 0) > 0;
      }
      if (this.legacyEventsTable)
        await this.db.execute(sql`
          INSERT IGNORE INTO calendar_events
            (id, tenant_id, category_id, title, start_date, end_date, start_time, end_time, audience,
             class_ids, description, staff_action, action_link, status, version, created_by, created_at,
             updated_by, updated_at)
          SELECT e.id, e.tenant_id, c.id, e.title, e.start_date, e.end_date, e.start_time, e.end_time,
                 e.audience, e.class_ids, e.description, e.staff_action, e.action_link, e.status,
                 e.version, e.created_by, e.created_at, e.updated_by, e.updated_at
          FROM school_events e
          JOIN calendar_categories c ON c.tenant_id = e.tenant_id
           AND c.code = CASE e.type WHEN 'EXAM' THEN 'EXAM' WHEN 'MEETING' THEN 'MEETING' ELSE 'ACTIVITY' END
          WHERE e.tenant_id = ${tenantId}`);
    } catch (err) {
      this.deps.log.warn({ err, tenantId }, 'could not copy old holidays / events into the calendar');
    }
  }

  // ---- categories -------------------------------------------------------------------------------

  async listCategories(tenantId: string) {
    await this.ready(tenantId);
    const rows = await this.db
      .select()
      .from(calendarCategories)
      .where(eq(calendarCategories.tenantId, tenantId))
      .orderBy(asc(calendarCategories.sortOrder), asc(calendarCategories.name));
    return rows.map(presentCategory);
  }

  private async loadCategory(ex: Executor, tenantId: string, id: string, lock = false) {
    const q = ex
      .select()
      .from(calendarCategories)
      .where(and(eq(calendarCategories.tenantId, tenantId), eq(calendarCategories.id, id)));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw new NotFoundError('Category');
    return row;
  }

  async createCategory(tenantId: string, input: z.infer<typeof CreateCategoryBody>, actor: Actor) {
    await this.ready(tenantId);
    const row = await this.db.transaction(async (tx) => {
      const taken = new Set(
        (await tx.select({ code: calendarCategories.code }).from(calendarCategories).where(eq(calendarCategories.tenantId, tenantId))).map(
          (r) => r.code,
        ),
      );
      if (
        (await tx.select({ n: calendarCategories.name }).from(calendarCategories).where(eq(calendarCategories.tenantId, tenantId))).some(
          (r) => r.n.toLowerCase() === input.name.toLowerCase(),
        )
      )
        throw new ConflictError('DUPLICATE_RESOURCE', 'A category with this name already exists', { field: 'name' });
      const base = slug(input.name);
      let code = base;
      for (let n = 2; taken.has(code); n++) code = `${base.slice(0, 28)}_${n}`;
      const [ins] = await tx
        .insert(calendarCategories)
        .values({ tenantId, code, name: input.name, color: input.color, closesSchool: input.closes_school, sortOrder: 100 })
        .$returningId();
      const created = await this.loadCategory(tx, tenantId, ins!.id);
      await recordChange(tx, actor, tenantId, {
        action: 'CALENDAR_CATEGORY_CREATED',
        entityType: 'calendar_category',
        entityId: created.id,
        after: presentCategory(created),
      });
      return created;
    });
    return presentCategory(row);
  }

  async updateCategory(tenantId: string, id: string, input: z.infer<typeof UpdateCategoryBody>, actor: Actor) {
    const r = await this.db.transaction(async (tx) => {
      const before = await this.loadCategory(tx, tenantId, id, true);
      if (before.version !== input.version)
        throw new ConflictError('CONFLICT', undefined, { current_version: before.version });
      if (input.name && input.name.toLowerCase() !== before.name.toLowerCase()) {
        const clash = (
          await tx.select({ n: calendarCategories.name, id: calendarCategories.id }).from(calendarCategories).where(eq(calendarCategories.tenantId, tenantId))
        ).some((r) => r.id !== id && r.n.toLowerCase() === input.name!.toLowerCase());
        if (clash) throw new ConflictError('DUPLICATE_RESOURCE', 'A category with this name already exists', { field: 'name' });
      }
      await tx
        .update(calendarCategories)
        .set({
          name: input.name ?? before.name,
          color: input.color ?? before.color,
          closesSchool: input.closes_school ?? before.closesSchool,
          isActive: input.is_active ?? before.isActive,
          sortOrder: input.sort_order ?? before.sortOrder,
          version: before.version + 1,
        })
        .where(and(eq(calendarCategories.tenantId, tenantId), eq(calendarCategories.id, id)));
      const after = await this.loadCategory(tx, tenantId, id);
      await recordChange(tx, actor, tenantId, {
        action: 'CALENDAR_CATEGORY_UPDATED',
        entityType: 'calendar_category',
        entityId: id,
        before: presentCategory(before),
        after: presentCategory(after),
      });
      // Switching "closes the school" changes which days are off: recount open leave.
      const recounted =
        after.closesSchool !== before.closesSchool
          ? await this.notify(tx, tenantId, 'all', `Category "${after.name}" ${after.closesSchool ? 'now closes' : 'no longer closes'} the school`, actor)
          : 0;
      return { after, recounted };
    });
    return { ...presentCategory(r.after), leave_recounted: r.recounted };
  }

  // ---- calendar entries -------------------------------------------------------------------------

  private async joined(ex: Executor, conds: ReturnType<typeof eq>[]) {
    return ex
      .select({ e: calendarEvents, c: calendarCategories })
      .from(calendarEvents)
      .innerJoin(
        calendarCategories,
        and(eq(calendarCategories.tenantId, calendarEvents.tenantId), eq(calendarCategories.id, calendarEvents.categoryId)),
      )
      .where(and(...conds))
      .orderBy(asc(calendarEvents.startDate), asc(calendarEvents.startTime), asc(calendarEvents.title));
  }

  /** Entries overlapping from–to (all when omitted), optionally of one category. */
  async listEvents(tenantId: string, q: z.infer<typeof EventListQuery>) {
    await this.ready(tenantId);
    const conds = [eq(calendarEvents.tenantId, tenantId)];
    if (!q.include_cancelled) conds.push(eq(calendarEvents.status, 'ACTIVE'));
    if (q.category_id) conds.push(eq(calendarEvents.categoryId, q.category_id));
    if (q.from) conds.push(gte(calendarEvents.endDate, q.from));
    if (q.to) conds.push(lte(calendarEvents.startDate, q.to));
    const rows = (await this.joined(this.db, conds)).map((r) => presentEvent(r.e, r.c));
    return q.type ? rows.filter((e) => e.type === q.type) : rows;
  }

  /** Teacher app (legacy shape): entries that close the school. */
  async listHolidays(tenantId: string, q: z.infer<typeof HolidayListQuery>) {
    const all = await this.listEvents(tenantId, q);
    return all.filter((e) => e.category.closes_school).map(presentAsHoliday);
  }

  /**
   * Teacher app: entries that don't close the school and that a teacher sees —
   * for everyone, staff or all students, plus class / section entries for any
   * of [classIds] (the classes they teach or are class teacher of).
   */
  async eventsForTeacher(tenantId: string, q: z.infer<typeof EventListQuery>, classIds: string[]) {
    const mine = new Set(classIds);
    const all = await this.listEvents(tenantId, { ...q, include_cancelled: false });
    return all.filter(
      (e) =>
        !e.category.closes_school &&
        ((e.audience !== 'CLASSES' && e.audience !== 'SECTIONS') || e.class_ids.some((id) => mine.has(id))),
    );
  }

  private async loadEvent(ex: Executor, tenantId: string, id: string, lock = false) {
    const q = ex
      .select()
      .from(calendarEvents)
      .where(and(eq(calendarEvents.tenantId, tenantId), eq(calendarEvents.id, id)));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw new NotFoundError('Calendar entry');
    return row;
  }

  /** The category for a create / edit: the id given, else the legacy type's built-in one. Must be active. */
  private async resolveCategory(ex: Executor, tenantId: string, categoryId?: string, type?: string) {
    let cat: CategoryRow | undefined;
    if (categoryId) cat = await this.loadCategory(ex, tenantId, categoryId);
    else if (type) {
      [cat] = await ex
        .select()
        .from(calendarCategories)
        .where(and(eq(calendarCategories.tenantId, tenantId), eq(calendarCategories.code, LEGACY_TYPE_CODE[type] ?? 'ACTIVITY')));
      if (!cat) throw new NotFoundError('Category');
    }
    if (!cat) throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'Choose a category', { field: 'category_id' });
    return cat;
  }

  /** Validates an entry; returns the class ids to store (for SECTIONS: the classes of those sections). */
  private async validateEvent(
    ex: Executor,
    tenantId: string,
    e: {
      start: string;
      end: string;
      startTime: string | null;
      endTime: string | null;
      audience: string;
      classIds: string[];
      sectionIds: string[];
    },
  ): Promise<{ classIds: string[] | null; sectionIds: string[] | null }> {
    if (e.end < e.start)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'The end date cannot be before the start date', { field: 'end_date' });
    const span = (Date.parse(e.end) - Date.parse(e.start)) / 86_400_000 + 1;
    if (span > 180)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'An entry cannot be longer than 180 days', { field: 'end_date' });
    if ((e.startTime === null) !== (e.endTime === null))
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'Give both a start and an end time, or neither', {
        field: e.startTime === null ? 'start_time' : 'end_time',
      });
    if (e.startTime && e.endTime && e.start === e.end && e.endTime <= e.startTime)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'The end time must be after the start time', { field: 'end_time' });
    if (e.audience === 'CLASSES') {
      const ids = [...new Set(e.classIds)];
      if (!ids.length) throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'Choose at least one class', { field: 'class_ids' });
      const found = await ex
        .select({ id: academicClasses.id })
        .from(academicClasses)
        .where(and(eq(academicClasses.tenantId, tenantId), inArray(academicClasses.id, ids)));
      if (found.length !== ids.length) throw new NotFoundError('Class');
      return { classIds: ids, sectionIds: null };
    }
    if (e.audience === 'SECTIONS') {
      const ids = [...new Set(e.sectionIds)];
      if (!ids.length) throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'Choose at least one section', { field: 'section_ids' });
      const found = await ex
        .select({ id: academicSections.id, classId: academicSections.classId })
        .from(academicSections)
        .where(and(eq(academicSections.tenantId, tenantId), inArray(academicSections.id, ids)));
      if (found.length !== ids.length) throw new NotFoundError('Section');
      return { classIds: [...new Set(found.map((s) => s.classId))], sectionIds: ids };
    }
    return { classIds: null, sectionIds: null };
  }

  async createEvent(tenantId: string, input: z.infer<typeof CreateEventBody>, actor: Actor) {
    await this.ready(tenantId);
    const startTime = input.start_time ?? null;
    const endTime = input.end_time ?? null;
    const r = await this.db.transaction(async (tx) => {
      const cat = await this.resolveCategory(tx, tenantId, input.category_id, input.type);
      if (!cat.isActive)
        throw new BusinessRuleError('OPERATION_NOT_ALLOWED', `The category "${cat.name}" is switched off`, { field: 'category_id' });
      const target = await this.validateEvent(tx, tenantId, {
        start: input.start_date,
        end: input.end_date,
        startTime,
        endTime,
        audience: input.audience,
        classIds: input.class_ids ?? [],
        sectionIds: input.section_ids ?? [],
      });
      const [ins] = await tx
        .insert(calendarEvents)
        .values({
          tenantId,
          categoryId: cat.id,
          title: input.title,
          startDate: input.start_date,
          endDate: input.end_date,
          startTime,
          endTime,
          audience: input.audience,
          classIds: target.classIds,
          sectionIds: target.sectionIds,
          description: input.description || null,
          staffAction: input.staff_action || null,
          actionLink: input.staff_action ? input.action_link ?? 'NONE' : 'NONE',
          createdBy: actor.userId,
          updatedBy: actor.userId,
        })
        .$returningId();
      const created = await this.loadEvent(tx, tenantId, ins!.id);
      await recordChange(tx, actor, tenantId, {
        action: 'CALENDAR_EVENT_CREATED',
        entityType: 'calendar_event',
        entityId: created.id,
        event: 'calendar_event.created',
        after: presentEvent(created, cat),
      });
      const recounted = cat.closesSchool
        ? await this.notify(tx, tenantId, { from: created.startDate, to: created.endDate }, `${cat.name} added: ${created.title}`, actor)
        : 0;
      return { row: created, cat, recounted };
    });
    return { ...presentEvent(r.row, r.cat), leave_recounted: r.recounted };
  }

  async updateEvent(tenantId: string, id: string, input: z.infer<typeof UpdateEventBody>, actor: Actor) {
    const r = await this.db.transaction(async (tx) => {
      const before = await this.loadEvent(tx, tenantId, id, true);
      if (before.status !== 'ACTIVE') throw new BusinessRuleError('INVALID_STATE', 'A cancelled entry cannot be edited');
      if (before.version !== input.version)
        throw new ConflictError('CONFLICT', undefined, { current_version: before.version });
      const oldCat = await this.loadCategory(tx, tenantId, before.categoryId);
      const cat =
        input.category_id || input.type ? await this.resolveCategory(tx, tenantId, input.category_id, input.type) : oldCat;
      if (cat.id !== oldCat.id && !cat.isActive)
        throw new BusinessRuleError('OPERATION_NOT_ALLOWED', `The category "${cat.name}" is switched off`, { field: 'category_id' });
      const audience = input.audience ?? before.audience;
      const start = input.start_date ?? before.startDate;
      const end = input.end_date ?? before.endDate;
      const startTime = input.start_time === undefined ? hhmm(before.startTime) : input.start_time;
      const endTime = input.end_time === undefined ? hhmm(before.endTime) : input.end_time;
      const target = await this.validateEvent(tx, tenantId, {
        start,
        end,
        startTime,
        endTime,
        audience,
        classIds: input.class_ids ?? before.classIds ?? [],
        sectionIds: input.section_ids ?? before.sectionIds ?? [],
      });
      const staffAction = input.staff_action === undefined ? before.staffAction : input.staff_action || null;
      const actionLink = staffAction ? input.action_link ?? before.actionLink : 'NONE';
      await tx
        .update(calendarEvents)
        .set({
          categoryId: cat.id,
          title: input.title ?? before.title,
          startDate: start,
          endDate: end,
          startTime,
          endTime,
          audience,
          classIds: target.classIds,
          sectionIds: target.sectionIds,
          description: input.description === undefined ? before.description : input.description || null,
          staffAction,
          actionLink,
          version: before.version + 1,
          updatedBy: actor.userId,
        })
        .where(and(eq(calendarEvents.tenantId, tenantId), eq(calendarEvents.id, id)));
      const updated = await this.loadEvent(tx, tenantId, id);
      await recordChange(tx, actor, tenantId, {
        action: 'CALENDAR_EVENT_UPDATED',
        entityType: 'calendar_event',
        entityId: id,
        event: 'calendar_event.updated',
        before: presentEvent(before, oldCat),
        after: presentEvent(updated, cat),
      });
      const recounted =
        oldCat.closesSchool || cat.closesSchool
          ? await this.notify(
              tx,
              tenantId,
              { from: before.startDate < start ? before.startDate : start, to: before.endDate > end ? before.endDate : end },
              `${cat.name} changed: ${updated.title}`,
              actor,
            )
          : 0;
      return { updated, cat, recounted };
    });
    return { ...presentEvent(r.updated, r.cat), leave_recounted: r.recounted };
  }

  async cancelEvent(tenantId: string, id: string, version: number, reason: string | undefined, actor: Actor) {
    const r = await this.db.transaction(async (tx) => {
      const before = await this.loadEvent(tx, tenantId, id, true);
      if (before.status !== 'ACTIVE') throw new BusinessRuleError('INVALID_STATE', 'The entry is already cancelled');
      if (before.version !== version) throw new ConflictError('CONFLICT', undefined, { current_version: before.version });
      const cat = await this.loadCategory(tx, tenantId, before.categoryId);
      await tx
        .update(calendarEvents)
        .set({ status: 'CANCELLED', version: before.version + 1, updatedBy: actor.userId })
        .where(and(eq(calendarEvents.tenantId, tenantId), eq(calendarEvents.id, id)));
      const cancelled = await this.loadEvent(tx, tenantId, id);
      await recordChange(tx, actor, tenantId, {
        action: 'CALENDAR_EVENT_CANCELLED',
        entityType: 'calendar_event',
        entityId: id,
        event: 'calendar_event.cancelled',
        before: presentEvent(before, cat),
        after: presentEvent(cancelled, cat),
        reason: reason ?? null,
      });
      const recounted = cat.closesSchool
        ? await this.notify(tx, tenantId, { from: before.startDate, to: before.endDate }, `${cat.name} cancelled: ${before.title}`, actor)
        : 0;
      return { cancelled, cat, recounted };
    });
    return { ...presentEvent(r.cancelled, r.cat), leave_recounted: r.recounted };
  }

  /** Active school-closing entries overlapping [from, to] — the "holidays" the day rules use. */
  async activeHolidays(tenantId: string, from: string, to: string, ex: Executor = this.db): Promise<HolidayLike[]> {
    await this.ready(tenantId);
    const rows = await this.joined(ex, [
      eq(calendarEvents.tenantId, tenantId),
      eq(calendarEvents.status, 'ACTIVE'),
      eq(calendarCategories.closesSchool, true),
      lte(calendarEvents.startDate, to),
      gte(calendarEvents.endDate, from),
    ]);
    return rows.map(({ e }) => ({
      id: e.id,
      name: e.title,
      startDate: e.startDate,
      endDate: e.endDate,
      audience: e.audience,
      classIds: e.classIds ?? null,
      sectionIds: e.sectionIds ?? null,
    }));
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
