import { and, eq, inArray, or } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import { academicYears, teachers, timetableVenues } from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { csvLine } from '../../shared/csv.js';
import { NotFoundError } from '../../shared/errors.js';
import { fullName } from '../teachers/support.js';
import type { TimetableConfigService } from './config.service.js';
import {
  cellOf,
  lessonPresent,
  lessonsOf,
  loadPeriods,
  periodBrief,
  specPresent,
  type Lesson,
  type LessonView,
  type LoadedPeriod,
} from './lessons.js';
import type { DayViewQuery, ExportQuery, ViewQuery, WorkloadQuery } from './timetable.schemas.js';
import {
  currentYearId,
  DAY_NAMES,
  hhmm,
  isoWeekday,
  loadClassOwner,
  loadSection,
  ownerFilter,
  readSettings,
  requireWide,
  schoolToday,
  sectionInScope,
  type Owner,
  type SettingsRow,
} from './support.js';

/** The live timetable needs no version: views say so with `timetable: null` (kept for older clients). */
const LIVE = null;

/** A row of a teacher / venue / school grid: one time slot (periods differ per section). */
const slotRow = (start: string, end: string) => ({
  id: `slot-${start}-${end}`,
  code: '',
  name: `${start}–${end}`,
  start_time: start,
  end_time: end,
  kind: 'LESSON' as const,
  is_teaching: true,
  status: 'ACTIVE' as const,
});

/** Read models of the live timetable: section / class / teacher / venue weeks, a day, workload, CSV. */
export class ViewService {
  constructor(
    private readonly deps: Deps,
    private readonly config: TimetableConfigService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  private async yearOf(ex: Executor, tenantId: string, q: { academic_year_id?: string }) {
    return q.academic_year_id ?? (await currentYearId(ex, tenantId));
  }

  private async settings(tenantId: string) {
    await this.config.ensureSettings(tenantId);
    return readSettings(this.db, tenantId);
  }

  private days(settings: SettingsRow) {
    return [...settings.workingDays]
      .sort((a, b) => a - b)
      .map((d) => ({ day_of_week: d, name: DAY_NAMES[d]! }));
  }

  /** Lessons the principal may read (section / class scope). */
  private visible(lessons: Lesson[], principal: Principal | null) {
    if (!principal) return lessons;
    return lessons.filter((l) =>
      sectionInScope(principal, 'timetable.read', {
        id: l.owner.sectionId ?? '',
        classId: l.owner.classId,
      }),
    );
  }

  /** An owner's week: its own periods as rows, with what happens each working day. */
  private ownerGrid(periods: LoadedPeriod[], settings: SettingsRow) {
    const days = this.days(settings);
    const active = periods.filter((lp) => lp.p.status === 'ACTIVE');
    const lessons = lessonsOf(active, settings.workingDays);
    const bySubject = new Map<
      string,
      { subject: LessonView['subject']; teacher: LessonView['teacher']; lessons: number }
    >();
    for (const l of lessons.map(lessonPresent)) {
      const k = `${l.subject_offering_id}:${l.teacher.id}`;
      const cur = bySubject.get(k) ?? { subject: l.subject, teacher: l.teacher, lessons: 0 };
      cur.lessons++;
      bySubject.set(k, cur);
    }
    return {
      days,
      periods: active.map((lp) => ({
        ...periodBrief(lp.p),
        version: lp.p.version,
        lesson: lp.p.kind === 'LESSON' && lp.owner ? specPresent(lp.lesson) : null,
        needs_subject: lp.p.kind === 'LESSON' && !lp.lesson.offering,
        cells: days.map((d) => {
          const c = cellOf(lp, d.day_of_week);
          return {
            day_of_week: d.day_of_week,
            state: c.state,
            overridden: lp.overrides.has(d.day_of_week),
            entry: c.lesson ? lessonPresent(c.lesson) : null,
          };
        }),
      })),
      summary: {
        lessons_per_week: lessons.length,
        empty_lesson_slots: active
          .filter((lp) => lp.p.kind === 'LESSON')
          .reduce(
            (n, lp) => n + days.filter((d) => cellOf(lp, d.day_of_week).state === 'NOT_SET').length,
            0,
          ),
        subjects: [...bySubject.values()]
          .sort((a, b) => a.subject.name.localeCompare(b.subject.name))
          .map((s) => ({ subject: s.subject, teacher: s.teacher, lessons_per_week: s.lessons })),
      },
    };
  }

  /** Rows = distinct time slots of [lessons] (teacher / venue / school views). */
  private slotGrid(lessons: Lesson[], settings: SettingsRow) {
    const days = this.days(settings);
    const slots = new Map<string, { start: string; end: string }>();
    for (const l of lessons) {
      const start = hhmm(l.period.p.startTime);
      const end = hhmm(l.period.p.endTime);
      slots.set(`${start}-${end}`, { start, end });
    }
    const rows = [...slots.values()].sort(
      (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end),
    );
    const views = lessons.map((l) => ({ l, v: lessonPresent(l) }));
    return {
      days,
      periods: rows.map((r) => ({
        ...slotRow(r.start, r.end),
        cells: days.map((d) => {
          const here = views.filter(
            (x) =>
              x.l.day === d.day_of_week &&
              x.v.period.start_time === r.start &&
              x.v.period.end_time === r.end,
          );
          return {
            day_of_week: d.day_of_week,
            state: here.length ? 'LESSON' : 'FREE',
            entry: here[0]?.v ?? null,
            /** More than one lesson in the same slot = a clash (shown, never saved on purpose). */
            entries: here.map((x) => x.v),
          };
        }),
      })),
    };
  }

  // ---- section / class ------------------------------------------------------------------

  async section(
    tenantId: string,
    sectionId: string,
    _q: z.infer<typeof ViewQuery>,
    principal: Principal,
  ) {
    const s = await loadSection(this.db, tenantId, sectionId, principal, 'timetable.read');
    const settings = await this.settings(tenantId);
    const owner: Owner = {
      kind: 'SECTION',
      sectionId: s.id,
      classId: s.classId,
      yearId: s.academicYearId,
      title: `${s.className} ${s.name}`.trim(),
      className: s.className,
      classCode: s.classCode,
      sectionName: s.name,
      sectionCode: s.code,
    };
    const periods = await loadPeriods(this.db, tenantId, { extra: ownerFilter(owner) });
    return {
      timetable: LIVE,
      academic_year_id: s.academicYearId,
      section: {
        id: s.id,
        code: s.code,
        name: s.name,
        class: { id: s.classId, code: s.classCode, name: s.className },
      },
      ...this.ownerGrid(periods, settings),
    };
  }

  async classView(
    tenantId: string,
    classId: string,
    q: z.infer<typeof ViewQuery>,
    principal: Principal,
  ) {
    const yearId = await this.yearOf(this.db, tenantId, q);
    if (!yearId) throw new NotFoundError('Academic year');
    const c = await loadClassOwner(this.db, tenantId, classId, yearId, principal, 'timetable.read');
    const settings = await this.settings(tenantId);
    const owner: Owner = {
      kind: 'CLASS',
      sectionId: null,
      classId: c.id,
      yearId,
      title: c.name,
      className: c.name,
      classCode: c.code,
      sectionName: null,
      sectionCode: null,
    };
    const periods = await loadPeriods(this.db, tenantId, { extra: ownerFilter(owner) });
    return {
      timetable: LIVE,
      academic_year_id: yearId,
      class: { id: c.id, code: c.code, name: c.name },
      ...this.ownerGrid(periods, settings),
    };
  }

  // ---- teacher / venue ----------------------------------------------------------------------

  private async yearLessons(tenantId: string, yearId: string | null, settings: SettingsRow) {
    if (!yearId) return [];
    return lessonsOf(await loadPeriods(this.db, tenantId, { yearId }), settings.workingDays);
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
    const settings = await this.settings(tenantId);
    const yearId = await this.yearOf(this.db, tenantId, q);
    const lessons = this.visible(
      (await this.yearLessons(tenantId, yearId, settings)).filter(
        (l) => l.spec.teacher?.id === teacherId,
      ),
      narrow ? principal : null,
    );
    const byDay = new Map<number, number>();
    for (const l of lessons) byDay.set(l.day, (byDay.get(l.day) ?? 0) + 1);
    return {
      timetable: LIVE,
      academic_year_id: yearId,
      teacher: {
        id: teacher.id,
        teacher_number: teacher.teacherNumber,
        full_name: fullName(teacher),
      },
      ...this.slotGrid(lessons, settings),
      summary: {
        lessons_per_week: lessons.length,
        sections: new Set(lessons.map((l) => l.owner.sectionId ?? `C${l.owner.classId}`)).size,
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
    const settings = await this.settings(tenantId);
    const yearId = await this.yearOf(this.db, tenantId, q);
    const lessons = this.visible(
      (await this.yearLessons(tenantId, yearId, settings)).filter(
        (l) => l.spec.venue?.id === venueId,
      ),
      principal,
    );
    const grid = this.slotGrid(lessons, settings);
    return {
      timetable: LIVE,
      academic_year_id: yearId,
      venue: {
        id: v.id,
        code: v.code,
        name: v.name,
        venue_type: v.venueType,
        capacity: v.capacity,
      },
      ...grid,
      summary: {
        lessons_per_week: lessons.length,
        lesson_slots_per_week: grid.periods.length * settings.workingDays.length,
      },
    };
  }

  // ---- a day ----------------------------------------------------------------------------------

  /** A day's schedule, period by period, for the school or narrowed to a section, teacher or venue. */
  async day(
    tenantId: string,
    q: z.infer<typeof DayViewQuery>,
    principal: Principal,
    mine?: { teacherId: string },
  ) {
    const date = q.date ?? (await schoolToday(this.db, tenantId, this.deps.clock));
    const dow = isoWeekday(date);
    const settings = await this.settings(tenantId);
    const [year] = await this.db
      .select({ id: academicYears.id })
      .from(academicYears)
      .where(and(eq(academicYears.tenantId, tenantId), eq(academicYears.isCurrent, true)));
    const base = {
      date,
      day_of_week: dow,
      day_name: DAY_NAMES[dow],
      is_working_day: settings.workingDays.includes(dow),
      timetable: LIVE,
    };
    if (q.section_id) {
      const s = await loadSection(this.db, tenantId, q.section_id, principal, 'timetable.read');
      const periods = (
        await loadPeriods(this.db, tenantId, {
          extra: ownerFilter({
            kind: 'SECTION',
            sectionId: s.id,
            classId: s.classId,
            yearId: s.academicYearId,
            title: '',
            className: '',
            classCode: '',
            sectionName: null,
            sectionCode: null,
          }),
        })
      ).filter((lp) => lp.p.status === 'ACTIVE');
      return {
        ...base,
        periods: periods.map((lp) => {
          const c = base.is_working_day ? cellOf(lp, dow) : { lesson: null };
          return { ...periodBrief(lp.p), entries: c.lesson ? [lessonPresent(c.lesson)] : [] };
        }),
      };
    }
    if (q.teacher_id) await this.teacherRow(this.db, tenantId, q.teacher_id);
    if (q.venue_id) {
      const [v] = await this.db
        .select({ id: timetableVenues.id })
        .from(timetableVenues)
        .where(and(eq(timetableVenues.id, q.venue_id), eq(timetableVenues.tenantId, tenantId)));
      if (!v) throw new NotFoundError('Venue');
    }
    let lessons = base.is_working_day
      ? (await this.yearLessons(tenantId, year?.id ?? null, settings)).filter((l) => l.day === dow)
      : [];
    if (mine) lessons = lessons.filter((l) => l.spec.teacher?.id === mine.teacherId);
    else lessons = this.visible(lessons, principal);
    if (q.teacher_id) lessons = lessons.filter((l) => l.spec.teacher?.id === q.teacher_id);
    if (q.venue_id) lessons = lessons.filter((l) => l.spec.venue?.id === q.venue_id);
    const views = lessons.map(lessonPresent);
    const slots = [
      ...new Set(views.map((v) => `${v.period.start_time}-${v.period.end_time}`)),
    ].sort();
    return {
      ...base,
      periods: slots.map((k) => {
        const [start, end] = k.split('-') as [string, string];
        return {
          ...slotRow(start, end),
          entries: views.filter((v) => v.period.start_time === start && v.period.end_time === end),
        };
      }),
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

  /** Lessons per week for every teaching staff member (calculated from the live timetable). */
  async workload(tenantId: string, q: z.infer<typeof WorkloadQuery>, principal: Principal) {
    requireWide(principal, 'timetable.read');
    const settings = await this.settings(tenantId);
    const yearId = await this.yearOf(this.db, tenantId, q);
    const lessons = await this.yearLessons(tenantId, yearId, settings);
    const used = new Map<string, Lesson[]>();
    for (const l of lessons) {
      const id = l.spec.teacher!.id;
      used.set(id, [...(used.get(id) ?? []), l]);
    }
    const people = await this.db
      .select()
      .from(teachers)
      .where(
        and(
          eq(teachers.tenantId, tenantId),
          or(
            inArray(teachers.status, ['ACTIVE', 'ON_LEAVE']),
            used.size ? inArray(teachers.id, [...used.keys()]) : undefined,
          ),
        ),
      );
    const data = people
      .map((t) => {
        const mine = used.get(t.id) ?? [];
        return {
          teacher: {
            id: t.id,
            teacher_number: t.teacherNumber,
            full_name: fullName(t),
            status: t.status,
          },
          lessons_per_week: mine.length,
          sections: new Set(mine.map((l) => l.owner.sectionId ?? `C${l.owner.classId}`)).size,
          subject_offerings: new Set(mine.map((l) => l.spec.offering!.id)).size,
          by_day: [1, 2, 3, 4, 5, 6, 7]
            .map((d) => ({ day_of_week: d, lessons: mine.filter((l) => l.day === d).length }))
            .filter((d) => d.lessons > 0),
        };
      })
      .sort(
        (a, b) =>
          b.lessons_per_week - a.lessons_per_week ||
          a.teacher.full_name.localeCompare(b.teacher.full_name),
      );
    return { timetable: LIVE, academic_year_id: yearId, teachers: data };
  }

  // ---- export -------------------------------------------------------------------------------

  async exportCsv(
    tenantId: string,
    q: z.infer<typeof ExportQuery>,
    principal: Principal,
    actor: Actor,
  ) {
    if (q.section_id)
      await loadSection(this.db, tenantId, q.section_id, principal, 'timetable.export');
    const settings = await this.settings(tenantId);
    const yearId = await this.yearOf(this.db, tenantId, q);
    let lessons = (await this.yearLessons(tenantId, yearId, settings)).filter((l) =>
      sectionInScope(principal, 'timetable.export', {
        id: l.owner.sectionId ?? '',
        classId: l.owner.classId,
      }),
    );
    if (q.section_id) lessons = lessons.filter((l) => l.owner.sectionId === q.section_id);
    if (q.teacher_id) lessons = lessons.filter((l) => l.spec.teacher?.id === q.teacher_id);
    if (q.venue_id) lessons = lessons.filter((l) => l.spec.venue?.id === q.venue_id);
    const views = lessons
      .map(lessonPresent)
      .sort(
        (a, b) =>
          a.day_of_week - b.day_of_week ||
          a.period.start_time.localeCompare(b.period.start_time) ||
          a.owner.title.localeCompare(b.owner.title),
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
      ...views.map((e) =>
        csvLine([
          e.day_name,
          e.period.name,
          e.period.start_time,
          e.period.end_time,
          e.class.name,
          e.section?.name ?? '',
          e.subject.code,
          e.subject.name,
          e.teacher.teacher_number,
          e.teacher.full_name,
          e.venue?.name ?? '',
        ]),
      ),
    ];
    await this.db.transaction((tx) =>
      recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_EXPORTED',
        entityType: 'timetable',
        entityId: yearId ?? tenantId,
        event: 'timetable.exported',
        after: { rows: views.length, ...q },
        payload: { rows: views.length },
      }),
    );
    return { filename: 'timetable.csv', body: `${lines.join('\r\n')}\r\n` };
  }
}
