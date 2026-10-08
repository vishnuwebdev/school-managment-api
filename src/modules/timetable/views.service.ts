import { and, asc, desc, eq, inArray, isNotNull, lte, or, gte, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicYears,
  teachers,
  timetableEntries,
  timetablePeriods,
  timetables,
  timetableVenues,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { csvLine } from '../../shared/csv.js';
import { NotFoundError } from '../../shared/errors.js';
import { fullName } from '../teachers/support.js';
import type { TimetableConfigService } from './config.service.js';
import type { DayViewQuery, ExportQuery, ViewQuery, WorkloadQuery } from './timetable.schemas.js';
import {
  DAY_NAMES,
  entryScope,
  fetchEntries,
  hhmm,
  isoWeekday,
  loadSection,
  loadTimetable,
  presentEntry,
  readSettings,
  requireWide,
  rows,
  schoolToday,
  type EntryView,
  periodsForSection,
  type PeriodRow,
  type SettingsRow,
  type TimetableRow,
} from './support.js';

const brief = (t: TimetableRow) => ({
  id: t.id,
  name: t.name,
  status: t.status,
  version_no: t.versionNo,
  academic_year_id: t.academicYearId,
  effective_from: t.effectiveFrom,
  effective_to: t.effectiveTo,
});

const periodBrief = (p: PeriodRow) => ({
  id: p.id,
  code: p.code,
  name: p.name,
  start_time: hhmm(p.startTime),
  end_time: hhmm(p.endTime),
  kind: p.kind,
  is_teaching: p.kind === 'LESSON',
  status: p.status,
});

/** Read models: grids per section / teacher / venue, "my timetable", a day's schedule, workload, CSV. */
export class ViewService {
  constructor(
    private readonly deps: Deps,
    private readonly config: TimetableConfigService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  // ---- which timetable ---------------------------------------------------------------

  private async currentYearId(ex: Executor, tenantId: string) {
    const [y] = await ex
      .select({ id: academicYears.id })
      .from(academicYears)
      .where(and(eq(academicYears.tenantId, tenantId), eq(academicYears.isCurrent, true)));
    return y?.id ?? null;
  }

  /** The requested timetable, else the published one of the year (active year by default); null when none. */
  private async pick(
    ex: Executor,
    tenantId: string,
    principal: Principal,
    q: z.infer<typeof ViewQuery>,
  ): Promise<TimetableRow | null> {
    if (q.timetable_id) return loadTimetable(ex, tenantId, q.timetable_id, principal);
    const yearId = q.academic_year_id ?? (await this.currentYearId(ex, tenantId));
    if (!yearId) return null;
    const [t] = await ex
      .select()
      .from(timetables)
      .where(
        and(
          eq(timetables.tenantId, tenantId),
          eq(timetables.academicYearId, yearId),
          eq(timetables.status, 'PUBLISHED'),
        ),
      );
    return t ?? null;
  }

  /** The version that was in force on `date` (published, or archived after having been published). */
  private async onDate(ex: Executor, tenantId: string, date: string): Promise<TimetableRow | null> {
    const [year] = await ex
      .select({ id: academicYears.id })
      .from(academicYears)
      .where(
        and(
          eq(academicYears.tenantId, tenantId),
          lte(academicYears.startDate, date),
          gte(academicYears.endDate, date),
        ),
      )
      .orderBy(desc(academicYears.isCurrent), desc(academicYears.startDate))
      .limit(1);
    if (!year) return null;
    const [t] = await ex
      .select()
      .from(timetables)
      .where(
        and(
          eq(timetables.tenantId, tenantId),
          eq(timetables.academicYearId, year.id),
          isNotNull(timetables.publishedAt),
          lte(timetables.effectiveFrom, date),
          or(isNull(timetables.effectiveTo), gte(timetables.effectiveTo, date)),
        ),
      )
      .orderBy(desc(timetables.effectiveFrom), desc(timetables.versionNo))
      .limit(1);
    return t ?? null;
  }

  // ---- grid ---------------------------------------------------------------------------

  private async config_(ex: Executor, tenantId: string) {
    await this.config.ensureSettings(tenantId);
    const settings = await readSettings(ex, tenantId);
    const periods = await ex
      .select()
      .from(timetablePeriods)
      .where(eq(timetablePeriods.tenantId, tenantId))
      .orderBy(
        asc(timetablePeriods.startTime),
        asc(timetablePeriods.displayOrder),
        asc(timetablePeriods.code),
      );
    return { settings, periods };
  }

  /**
   * Which periods a view shows. A section shows its own school day; the other
   * views (teacher, venue, whole school) show the school's periods plus every
   * period their lessons are in.
   */
  private viewPeriods(
    all: PeriodRow[],
    entries: EntryView[],
    section?: { id: string; classId: string },
  ): PeriodRow[] {
    const used = new Set(entries.map((e) => e.period.id));
    const mine = section
      ? new Set(periodsForSection(all, section).map((p) => p.id))
      : new Set(all.filter((p) => !p.academicClassId && !p.academicSectionId).map((p) => p.id));
    return all.filter((p) => mine.has(p.id) || used.has(p.id));
  }

  private grid(periods: PeriodRow[], settings: SettingsRow, entries: EntryView[]) {
    const usedPeriods = new Set(entries.map((e) => e.period.id));
    const days = [...new Set([...settings.workingDays, ...entries.map((e) => e.day_of_week)])]
      .sort((a, b) => a - b)
      .map((d) => ({ day_of_week: d, name: DAY_NAMES[d]! }));
    const cell = new Map<string, EntryView>();
    for (const e of entries) {
      const k = `${e.day_of_week}:${e.period.id}`;
      if (!cell.has(k)) cell.set(k, e);
    }
    return {
      days,
      periods: periods
        .filter((p) => p.status === 'ACTIVE' || usedPeriods.has(p.id))
        .map((p) => ({
          ...periodBrief(p),
          cells: days.map((d) => ({
            day_of_week: d.day_of_week,
            entry: cell.get(`${d.day_of_week}:${p.id}`) ?? null,
          })),
        })),
    };
  }

  private async entriesOf(
    ex: Executor,
    tenantId: string,
    tt: TimetableRow | null,
    principal: Principal | null,
    where: ReturnType<typeof and>,
  ): Promise<EntryView[]> {
    if (!tt) return [];
    const rowsIn = await fetchEntries(
      ex,
      and(
        eq(timetableEntries.tenantId, tenantId),
        eq(timetableEntries.timetableId, tt.id),
        eq(timetableEntries.status, 'ACTIVE'),
        principal ? entryScope(principal, 'timetable.read') : undefined,
        where,
      ),
    );
    return rowsIn.map(presentEntry);
  }

  // ---- views ------------------------------------------------------------------------------

  async section(
    tenantId: string,
    sectionId: string,
    q: z.infer<typeof ViewQuery>,
    principal: Principal,
  ) {
    const section = await loadSection(this.db, tenantId, sectionId, principal, 'timetable.read');
    const tt = await this.pick(this.db, tenantId, principal, q);
    if (tt && tt.academicYearId !== section.academicYearId) throw new NotFoundError('Section');
    const { settings, periods } = await this.config_(this.db, tenantId);
    const entries = await this.entriesOf(
      this.db,
      tenantId,
      tt,
      principal,
      eq(timetableEntries.sectionId, sectionId),
    );
    const bySubject = new Map<
      string,
      { subject: EntryView['subject']; teacher: EntryView['teacher']; lessons: number }
    >();
    for (const e of entries) {
      const k = `${e.subject_offering_id}:${e.teacher.id}`;
      const cur = bySubject.get(k) ?? { subject: e.subject, teacher: e.teacher, lessons: 0 };
      cur.lessons++;
      bySubject.set(k, cur);
    }
    return {
      timetable: tt ? brief(tt) : null,
      section: {
        id: section.id,
        code: section.code,
        name: section.name,
        class: { id: section.classId, code: section.classCode, name: section.className },
      },
      ...this.grid(this.viewPeriods(periods, entries, { id: section.id, classId: section.classId }), settings, entries),
      summary: {
        lessons_per_week: entries.length,
        subjects: [...bySubject.values()]
          .sort((a, b) => a.subject.name.localeCompare(b.subject.name))
          .map((s) => ({ subject: s.subject, teacher: s.teacher, lessons_per_week: s.lessons })),
      },
    };
  }

  private async teacherRow(ex: Executor, tenantId: string, id: string) {
    const [t] = await ex
      .select()
      .from(teachers)
      .where(and(eq(teachers.id, id), eq(teachers.tenantId, tenantId)));
    if (!t) throw new NotFoundError('Teacher');
    return t;
  }

  private async teacherGrid(
    tenantId: string,
    teacherId: string,
    q: z.infer<typeof ViewQuery>,
    principal: Principal,
    narrow: boolean,
  ) {
    const teacher = await this.teacherRow(this.db, tenantId, teacherId);
    const tt = await this.pick(this.db, tenantId, principal, q);
    const { settings, periods } = await this.config_(this.db, tenantId);
    const entries = await this.entriesOf(
      this.db,
      tenantId,
      tt,
      narrow ? principal : null,
      eq(timetableEntries.teacherId, teacherId),
    );
    const byDay = new Map<number, number>();
    for (const e of entries) byDay.set(e.day_of_week, (byDay.get(e.day_of_week) ?? 0) + 1);
    return {
      timetable: tt ? brief(tt) : null,
      teacher: {
        id: teacher.id,
        teacher_number: teacher.teacherNumber,
        full_name: fullName(teacher),
      },
      ...this.grid(this.viewPeriods(periods, entries), settings, entries),
      summary: {
        lessons_per_week: entries.length,
        sections: new Set(entries.map((e) => e.section.id)).size,
        by_day: [...byDay.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([d, n]) => ({ day_of_week: d, lessons: n })),
      },
    };
  }

  teacherView(
    tenantId: string,
    teacherId: string,
    q: z.infer<typeof ViewQuery>,
    principal: Principal,
  ) {
    return this.teacherGrid(tenantId, teacherId, q, principal, true);
  }

  /** The teacher record linked to the signed-in login (`teachers.membership_id`), or 404. */
  private async myTeacherId(tenantId: string, principal: Principal) {
    const [t] = await this.db
      .select({ id: teachers.id })
      .from(teachers)
      .where(
        and(eq(teachers.tenantId, tenantId), eq(teachers.membershipId, principal.membershipId)),
      );
    if (!t) throw new NotFoundError('Teacher profile linked to your login');
    return t.id;
  }

  async mine(tenantId: string, q: z.infer<typeof ViewQuery>, principal: Principal) {
    return this.teacherGrid(
      tenantId,
      await this.myTeacherId(tenantId, principal),
      q,
      principal,
      false,
    );
  }

  async venue(
    tenantId: string,
    venueId: string,
    q: z.infer<typeof ViewQuery>,
    principal: Principal,
  ) {
    const [v] = await this.db
      .select()
      .from(timetableVenues)
      .where(and(eq(timetableVenues.id, venueId), eq(timetableVenues.tenantId, tenantId)));
    if (!v) throw new NotFoundError('Venue');
    const tt = await this.pick(this.db, tenantId, principal, q);
    const { settings, periods } = await this.config_(this.db, tenantId);
    const entries = await this.entriesOf(
      this.db,
      tenantId,
      tt,
      principal,
      eq(timetableEntries.venueId, venueId),
    );
    return {
      timetable: tt ? brief(tt) : null,
      venue: {
        id: v.id,
        code: v.code,
        name: v.name,
        venue_type: v.venueType,
        capacity: v.capacity,
      },
      ...this.grid(this.viewPeriods(periods, entries), settings, entries),
      summary: {
        lessons_per_week: entries.length,
        lesson_slots_per_week:
          periods.filter((p) => p.status === 'ACTIVE' && p.kind === 'LESSON').length *
          settings.workingDays.length,
      },
    };
  }

  /** A day's schedule: period by period, for the school or narrowed to a section, teacher or venue. */
  async day(
    tenantId: string,
    q: z.infer<typeof DayViewQuery>,
    principal: Principal,
    mine?: { teacherId: string },
  ) {
    const date = q.date ?? (await schoolToday(this.db, tenantId, this.deps.clock));
    const dow = isoWeekday(date);
    const daySection = q.section_id
      ? await loadSection(this.db, tenantId, q.section_id, principal, 'timetable.read')
      : null;
    if (q.teacher_id) await this.teacherRow(this.db, tenantId, q.teacher_id);
    if (q.venue_id) {
      const [v] = await this.db
        .select({ id: timetableVenues.id })
        .from(timetableVenues)
        .where(and(eq(timetableVenues.id, q.venue_id), eq(timetableVenues.tenantId, tenantId)));
      if (!v) throw new NotFoundError('Venue');
    }
    const tt = await this.onDate(this.db, tenantId, date);
    const { settings, periods } = await this.config_(this.db, tenantId);
    const entries = await this.entriesOf(
      this.db,
      tenantId,
      tt,
      mine ? null : principal,
      and(
        eq(timetableEntries.dayOfWeek, dow),
        q.section_id ? eq(timetableEntries.sectionId, q.section_id) : undefined,
        mine ? eq(timetableEntries.teacherId, mine.teacherId) : undefined,
        q.teacher_id ? eq(timetableEntries.teacherId, q.teacher_id) : undefined,
        q.venue_id ? eq(timetableEntries.venueId, q.venue_id) : undefined,
      ),
    );
    return {
      date,
      day_of_week: dow,
      day_name: DAY_NAMES[dow],
      is_working_day: settings.workingDays.includes(dow),
      timetable: tt ? brief(tt) : null,
      periods: this.viewPeriods(
        periods,
        entries,
        daySection ? { id: daySection.id, classId: daySection.classId } : undefined,
      )
        .filter((p) => p.status === 'ACTIVE' || entries.some((e) => e.period.id === p.id))
        .map((p) => ({ ...periodBrief(p), entries: entries.filter((e) => e.period.id === p.id) })),
    };
  }

  async myDay(tenantId: string, q: { date?: string }, principal: Principal) {
    const teacherId = await this.myTeacherId(tenantId, principal);
    return {
      ...(await this.day(tenantId, { date: q.date }, principal, { teacherId })),
      teacher_id: teacherId,
    };
  }

  // ---- workload -----------------------------------------------------------------------------

  /** Lessons per week for every teaching staff member (derived from entries; nothing stored). */
  async workload(tenantId: string, q: z.infer<typeof WorkloadQuery>, principal: Principal) {
    requireWide(principal, 'timetable.read');
    const tt = await this.pick(this.db, tenantId, principal, q);
    const usage = tt
      ? await rows<{
          teacher_id: string;
          lessons: string | number;
          sections: string | number;
          offerings: string | number;
          d1: string | number;
          d2: string | number;
          d3: string | number;
          d4: string | number;
          d5: string | number;
          d6: string | number;
          d7: string | number;
        }>(
          this.db,
          sql`select e.teacher_id, count(*) as lessons, count(distinct e.section_id) as sections,
                     count(distinct e.subject_offering_id) as offerings,
                     sum(e.day_of_week = 1) as d1, sum(e.day_of_week = 2) as d2, sum(e.day_of_week = 3) as d3,
                     sum(e.day_of_week = 4) as d4, sum(e.day_of_week = 5) as d5, sum(e.day_of_week = 6) as d6,
                     sum(e.day_of_week = 7) as d7
              from timetable_entries e
              where e.tenant_id = ${tenantId} and e.timetable_id = ${tt.id} and e.status = 'ACTIVE'
              group by e.teacher_id`,
        )
      : [];
    const used = new Map(usage.map((u) => [u.teacher_id, u]));
    const people = await this.db
      .select()
      .from(teachers)
      .where(
        and(
          eq(teachers.tenantId, tenantId),
          or(
            and(
              eq(teachers.staffType, 'TEACHING'),
              inArray(teachers.status, ['ACTIVE', 'ON_LEAVE']),
            ),
            used.size ? inArray(teachers.id, [...used.keys()]) : undefined,
          ),
        ),
      );
    const data = people
      .map((t) => {
        const u = used.get(t.id);
        const n = (x: unknown) => Number(x ?? 0);
        return {
          teacher: {
            id: t.id,
            teacher_number: t.teacherNumber,
            full_name: fullName(t),
            status: t.status,
          },
          lessons_per_week: n(u?.lessons),
          sections: n(u?.sections),
          subject_offerings: n(u?.offerings),
          by_day: [1, 2, 3, 4, 5, 6, 7]
            .map((d) => ({ day_of_week: d, lessons: n(u?.[`d${d}` as 'd1']) }))
            .filter((d) => d.lessons > 0),
        };
      })
      .sort(
        (a, b) =>
          b.lessons_per_week - a.lessons_per_week ||
          a.teacher.full_name.localeCompare(b.teacher.full_name),
      );
    return { timetable: tt ? brief(tt) : null, teachers: data };
  }

  // ---- export -------------------------------------------------------------------------------

  async exportCsv(
    tenantId: string,
    timetableId: string,
    q: z.infer<typeof ExportQuery>,
    principal: Principal,
    actor: Actor,
  ) {
    const tt = await loadTimetable(this.db, tenantId, timetableId, principal);
    if (q.section_id)
      await loadSection(this.db, tenantId, q.section_id, principal, 'timetable.export');
    const found = await fetchEntries(
      this.db,
      and(
        eq(timetableEntries.tenantId, tenantId),
        eq(timetableEntries.timetableId, tt.id),
        eq(timetableEntries.status, 'ACTIVE'),
        entryScope(principal, 'timetable.export'),
        q.section_id ? eq(timetableEntries.sectionId, q.section_id) : undefined,
        q.teacher_id ? eq(timetableEntries.teacherId, q.teacher_id) : undefined,
        q.venue_id ? eq(timetableEntries.venueId, q.venue_id) : undefined,
      ),
    );
    const lines = [
      csvLine([
        'Day',
        'Period',
        'Start',
        'End',
        'Class',
        'Section',
        'Subject code',
        'Subject',
        'Teacher number',
        'Teacher',
        'Venue',
      ]),
      ...found.map((r) => {
        const e = presentEntry(r);
        return csvLine([
          e.day_name,
          e.period.name,
          e.period.start_time,
          e.period.end_time,
          e.section.class.name,
          e.section.name,
          e.subject.code,
          e.subject.name,
          e.teacher.teacher_number,
          e.teacher.full_name,
          e.venue?.name ?? '',
        ]);
      }),
    ];
    await this.db.transaction((tx) =>
      recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_EXPORTED',
        entityType: 'timetable',
        entityId: tt.id,
        event: 'timetable.exported',
        after: { rows: found.length, ...q },
        payload: { rows: found.length, version_no: tt.versionNo },
      }),
    );
    return {
      filename: `timetable-v${tt.versionNo}.csv`,
      body: `${lines.join('\r\n')}\r\n`,
    };
  }
}
