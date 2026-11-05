import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  subjectOfferings,
  subjects,
  teachers,
  teachingAssignments,
  timetableDayOverrides,
  timetablePeriods,
  timetableVenues,
} from '../../db/schema/index.js';
import { BusinessRuleError } from '../../shared/errors.js';
import { fullName } from '../teachers/support.js';
import {
  DAY_NAMES,
  hhmm,
  runsOn,
  type Owner,
  type OverrideRow,
  type PeriodRow,
} from './support.js';

/**
 * The live timetable is calculated, not stored per cell: every ACTIVE lesson
 * period of a section (or class without sections) gives a lesson on each
 * working day, unless a weekday override replaces it (another subject/teacher)
 * or frees it. This module loads a year's periods + overrides with everything a
 * lesson shows, turns them into lessons, and finds teacher / venue clashes.
 */

type SubjectRef = { id: string; code: string; name: string };
type TeacherRef = {
  id: string;
  teacherNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  status: string;
};
type VenueRef = { id: string; code: string; name: string; status: string; capacity: number | null };
type OfferingRef = {
  id: string;
  status: string;
  classId: string;
  sectionId: string | null;
  academicYearId: string;
};
type AssignmentRef = {
  id: string;
  status: string;
  teacherId: string;
  subjectOfferingId: string;
};

/** What a lesson is: subject, teacher (through an assignment) and venue. */
export interface LessonSpec {
  offering: OfferingRef | null;
  subject: SubjectRef | null;
  assignment: AssignmentRef | null;
  teacher: TeacherRef | null;
  venue: VenueRef | null;
}

export interface LoadedPeriod {
  p: PeriodRow;
  owner: Owner | null;
  lesson: LessonSpec;
  overrides: Map<number, { o: OverrideRow; lesson: LessonSpec }>;
}

/** Look up offerings, subjects, assignments, teachers and venues for a set of rows. */
async function lookups(
  ex: Executor,
  tenantId: string,
  refs: {
    offeringIds: string[];
    assignmentIds: string[];
    teacherIds: string[];
    venueIds: string[];
  },
) {
  const uniq = (xs: string[]) => [...new Set(xs)];
  const [offs, asgs, tchs, vens] = await Promise.all([
    refs.offeringIds.length
      ? ex
          .select({ o: subjectOfferings, s: subjects })
          .from(subjectOfferings)
          .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
          .where(
            and(
              eq(subjectOfferings.tenantId, tenantId),
              inArray(subjectOfferings.id, uniq(refs.offeringIds)),
            ),
          )
      : [],
    refs.assignmentIds.length
      ? ex
          .select()
          .from(teachingAssignments)
          .where(
            and(
              eq(teachingAssignments.tenantId, tenantId),
              inArray(teachingAssignments.id, uniq(refs.assignmentIds)),
            ),
          )
      : [],
    refs.teacherIds.length
      ? ex
          .select()
          .from(teachers)
          .where(and(eq(teachers.tenantId, tenantId), inArray(teachers.id, uniq(refs.teacherIds))))
      : [],
    refs.venueIds.length
      ? ex
          .select()
          .from(timetableVenues)
          .where(
            and(
              eq(timetableVenues.tenantId, tenantId),
              inArray(timetableVenues.id, uniq(refs.venueIds)),
            ),
          )
      : [],
  ]);
  return {
    offering: new Map(offs.map((r) => [r.o.id, r])),
    assignment: new Map(asgs.map((a) => [a.id, a])),
    teacher: new Map(tchs.map((t) => [t.id, t])),
    venue: new Map(vens.map((v) => [v.id, v])),
  };
}

type Lookups = Awaited<ReturnType<typeof lookups>>;

function specOf(
  L: Lookups,
  row: {
    subjectOfferingId: string | null;
    teachingAssignmentId: string | null;
    teacherId: string | null;
    venueId: string | null;
  },
): LessonSpec {
  const off = row.subjectOfferingId ? L.offering.get(row.subjectOfferingId) : undefined;
  const a = row.teachingAssignmentId ? L.assignment.get(row.teachingAssignmentId) : undefined;
  const t = row.teacherId ? L.teacher.get(row.teacherId) : undefined;
  const v = row.venueId ? L.venue.get(row.venueId) : undefined;
  return {
    offering: off
      ? {
          id: off.o.id,
          status: off.o.status,
          classId: off.o.classId,
          sectionId: off.o.sectionId,
          academicYearId: off.o.academicYearId,
        }
      : null,
    subject: off ? { id: off.s.id, code: off.s.code, name: off.s.name } : null,
    assignment: a
      ? {
          id: a.id,
          status: a.status,
          teacherId: a.teacherId,
          subjectOfferingId: a.subjectOfferingId,
        }
      : null,
    teacher: t
      ? {
          id: t.id,
          teacherNumber: t.teacherNumber,
          firstName: t.firstName,
          middleName: t.middleName,
          lastName: t.lastName,
          status: t.status,
        }
      : null,
    venue: v
      ? { id: v.id, code: v.code, name: v.name, status: v.status, capacity: v.capacity }
      : null,
  };
}

/**
 * The periods (with owners, lessons and overrides) of an academic year, or of
 * the given period ids. Ordered by start time. Inactive periods are included;
 * callers filter.
 */
export async function loadPeriods(
  ex: Executor,
  tenantId: string,
  where: { yearId?: string; periodIds?: string[]; extra?: ReturnType<typeof sql> },
): Promise<LoadedPeriod[]> {
  const rows = await ex
    .select({
      p: timetablePeriods,
      s: {
        id: academicSections.id,
        code: academicSections.code,
        name: academicSections.name,
        yearId: academicSections.academicYearId,
      },
      c: { id: academicClasses.id, code: academicClasses.code, name: academicClasses.name },
    })
    .from(timetablePeriods)
    .leftJoin(
      academicSections,
      and(
        eq(academicSections.tenantId, timetablePeriods.tenantId),
        eq(academicSections.id, timetablePeriods.academicSectionId),
      ),
    )
    .leftJoin(
      academicClasses,
      and(
        eq(academicClasses.tenantId, timetablePeriods.tenantId),
        eq(academicClasses.id, timetablePeriods.academicClassId),
      ),
    )
    .where(
      and(
        eq(timetablePeriods.tenantId, tenantId),
        where.yearId ? eq(timetablePeriods.academicYearId, where.yearId) : undefined,
        where.periodIds
          ? where.periodIds.length
            ? inArray(timetablePeriods.id, where.periodIds)
            : sql`1 = 0`
          : undefined,
        where.extra,
      ),
    )
    .orderBy(timetablePeriods.startTime, timetablePeriods.displayOrder, timetablePeriods.code);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.p.id);
  const ovs = await ex
    .select()
    .from(timetableDayOverrides)
    .where(
      and(
        eq(timetableDayOverrides.tenantId, tenantId),
        inArray(timetableDayOverrides.periodId, ids),
      ),
    );
  const all = [...rows.map((r) => r.p), ...ovs];
  const L = await lookups(ex, tenantId, {
    offeringIds: all.flatMap((x) => (x.subjectOfferingId ? [x.subjectOfferingId] : [])),
    assignmentIds: all.flatMap((x) => (x.teachingAssignmentId ? [x.teachingAssignmentId] : [])),
    teacherIds: all.flatMap((x) => (x.teacherId ? [x.teacherId] : [])),
    venueIds: all.flatMap((x) => (x.venueId ? [x.venueId] : [])),
  });
  const byPeriod = new Map<string, OverrideRow[]>();
  for (const o of ovs) byPeriod.set(o.periodId, [...(byPeriod.get(o.periodId) ?? []), o]);
  return rows.map((r) => {
    const owner: Owner | null =
      r.c && r.p.academicYearId
        ? {
            kind: r.s ? 'SECTION' : 'CLASS',
            sectionId: r.s?.id ?? null,
            classId: r.c.id,
            yearId: r.p.academicYearId,
            title: r.s ? `${r.c.name} ${r.s.name}`.trim() : r.c.name,
            className: r.c.name,
            classCode: r.c.code,
            sectionName: r.s?.name ?? null,
            sectionCode: r.s?.code ?? null,
          }
        : null;
    return {
      p: r.p,
      owner,
      lesson: specOf(L, r.p),
      overrides: new Map(
        (byPeriod.get(r.p.id) ?? []).map((o) => [o.dayOfWeek, { o, lesson: specOf(L, o) }]),
      ),
    };
  });
}

// ---- lessons ----------------------------------------------------------------------------

export interface Lesson {
  period: LoadedPeriod;
  owner: Owner;
  day: number;
  spec: LessonSpec;
  /** OVERRIDE when a weekday exception gives this lesson. */
  source: 'PERIOD' | 'OVERRIDE';
  override: OverrideRow | null;
}

/** State of one cell of a section's week. OFF = the period does not run on that weekday. */
export type CellState = 'LESSON' | 'FREE' | 'NOT_SET' | 'NO_LESSONS' | 'OFF';

/** What happens in [period] on weekday [day]. */
export function cellOf(lp: LoadedPeriod, day: number): { state: CellState; lesson: Lesson | null } {
  if (!runsOn(lp.p, day)) return { state: 'OFF', lesson: null };
  if (lp.p.kind !== 'LESSON' || !lp.owner) return { state: 'NO_LESSONS', lesson: null };
  const ov = lp.overrides.get(day);
  if (ov?.o.kind === 'FREE') return { state: 'FREE', lesson: null };
  if (ov && ov.lesson.offering)
    return {
      state: 'LESSON',
      lesson: {
        period: lp,
        owner: lp.owner,
        day,
        spec: ov.lesson,
        source: 'OVERRIDE',
        override: ov.o,
      },
    };
  if (lp.lesson.offering)
    return {
      state: 'LESSON',
      lesson: {
        period: lp,
        owner: lp.owner,
        day,
        spec: lp.lesson,
        source: 'PERIOD',
        override: null,
      },
    };
  return { state: 'NOT_SET', lesson: null };
}

/** Every lesson of the given periods on the given working days (active periods only). */
export function lessonsOf(periods: LoadedPeriod[], days: number[]): Lesson[] {
  const out: Lesson[] = [];
  for (const lp of periods) {
    if (lp.p.status !== 'ACTIVE') continue;
    for (const d of days) {
      const c = cellOf(lp, d);
      if (c.lesson) out.push(c.lesson);
    }
  }
  return out;
}

export const periodBrief = (p: PeriodRow) => ({
  id: p.id,
  code: p.code,
  name: p.name,
  start_time: hhmm(p.startTime),
  end_time: hhmm(p.endTime),
  kind: p.kind,
  is_teaching: p.kind === 'LESSON',
  /** The weekdays it runs on; null = every working day. */
  days_of_week: p.daysOfWeek ?? null,
  status: p.status,
});

const teacherBrief = (t: TeacherRef | null) =>
  t ? { id: t.id, teacher_number: t.teacherNumber, full_name: fullName(t) } : null;

export const specPresent = (s: LessonSpec) => ({
  subject: s.subject,
  subject_offering_id: s.offering?.id ?? null,
  teaching_assignment_id: s.assignment?.id ?? null,
  teacher: teacherBrief(s.teacher),
  venue: s.venue ? { id: s.venue.id, code: s.venue.code, name: s.venue.name } : null,
});

export const ownerPresent = (o: Owner) => ({
  kind: o.kind,
  id: o.sectionId ?? o.classId,
  title: o.title,
});

/** One lesson, in the shape every view uses. `id` is `<period id>:<weekday>`. */
export function lessonPresent(l: Lesson) {
  const o = l.owner;
  const klass = { id: o.classId, code: o.classCode, name: o.className };
  return {
    id: `${l.period.p.id}:${l.day}`,
    period_id: l.period.p.id,
    day_of_week: l.day,
    day_name: DAY_NAMES[l.day],
    period: {
      id: l.period.p.id,
      code: l.period.p.code,
      name: l.period.p.name,
      start_time: hhmm(l.period.p.startTime),
      end_time: hhmm(l.period.p.endTime),
    },
    section: o.sectionId
      ? { id: o.sectionId, code: o.sectionCode!, name: o.sectionName!, class: klass }
      : null,
    class: klass,
    owner: ownerPresent(o),
    ...specPresent(l.spec),
    subject: l.spec.subject!,
    teacher: teacherBrief(l.spec.teacher)!,
    source: l.source,
    override_id: l.override?.id ?? null,
    version: l.override ? l.override.version : l.period.p.version,
    status: 'ACTIVE' as const,
  };
}
export type LessonView = ReturnType<typeof lessonPresent>;

// ---- clashes ---------------------------------------------------------------------------

export interface Clash {
  type: 'TEACHER' | 'VENUE';
  day_of_week: number;
  /** The two lessons that overlap. */
  lessons: [Lesson, Lesson];
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * Teacher and venue double-bookings: two lessons on the same weekday whose
 * times overlap (periods differ per section, so it is time ranges, not slots).
 * With [touching], only clashes that involve one of those period ids.
 */
export function findClashes(lessons: Lesson[], touching?: Set<string>): Clash[] {
  const out: Clash[] = [];
  const group = (type: Clash['type'], key: (l: Lesson) => string | null) => {
    const m = new Map<string, Lesson[]>();
    for (const l of lessons) {
      const k = key(l);
      if (k) m.set(`${k}:${l.day}`, [...(m.get(`${k}:${l.day}`) ?? []), l]);
    }
    for (const list of m.values()) {
      list.sort((a, b) => toMin(a.period.p.startTime) - toMin(b.period.p.startTime));
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]!;
          const b = list[j]!;
          if (toMin(b.period.p.startTime) >= toMin(a.period.p.endTime)) break;
          if (touching && !touching.has(a.period.p.id) && !touching.has(b.period.p.id)) continue;
          out.push({ type, day_of_week: a.day, lessons: [a, b] });
        }
    }
  };
  group('TEACHER', (l) => l.spec.teacher?.id ?? null);
  group('VENUE', (l) => l.spec.venue?.id ?? null);
  return out;
}

export function clashPresent(c: Clash) {
  const [a, b] = c.lessons;
  const who = c.type === 'TEACHER' ? fullName(a.spec.teacher!) : a.spec.venue!.name;
  return {
    type: c.type,
    day_of_week: c.day_of_week,
    message:
      `${who} is ${c.type === 'TEACHER' ? 'teaching' : 'booked for'} ${a.owner.title} ` +
      `(${hhmm(a.period.p.startTime)}–${hhmm(a.period.p.endTime)}) and ${b.owner.title} ` +
      `(${hhmm(b.period.p.startTime)}–${hhmm(b.period.p.endTime)}) on ${DAY_NAMES[c.day_of_week]}`,
    lessons: [lessonPresent(a), lessonPresent(b)],
  };
}

/** Refuse the write when it creates a teacher or venue clash (call inside the writer's transaction). */
export async function assertNoClash(
  ex: Executor,
  tenantId: string,
  yearId: string,
  workingDays: number[],
  touching: string[],
) {
  if (!touching.length) return;
  const periods = await loadPeriods(ex, tenantId, { yearId });
  const clashes = findClashes(lessonsOf(periods, workingDays), new Set(touching));
  if (clashes.length) {
    const shown = clashes.slice(0, 20).map(clashPresent);
    throw new BusinessRuleError('OPERATION_NOT_ALLOWED', shown[0]!.message, {
      reason: 'SCHEDULE_CLASH',
      clashes: shown,
    });
  }
}

/** Problems of one lesson that make it invalid (an ended assignment, an inactive offering …). */
export function lessonProblems(spec: LessonSpec, owner: Owner): string[] {
  const out: string[] = [];
  if (!spec.offering) return out;
  if (spec.offering.status !== 'ACTIVE') out.push('OFFERING_INACTIVE');
  if (
    spec.offering.classId !== owner.classId ||
    (spec.offering.sectionId !== null && spec.offering.sectionId !== owner.sectionId)
  )
    out.push('OFFERING_NOT_FOR_SECTION');
  if (!spec.assignment || !spec.teacher) out.push('NO_TEACHER');
  else if (spec.assignment.status !== 'ACTIVE') out.push('TEACHING_ASSIGNMENT_NOT_ACTIVE');
  else if (
    spec.assignment.teacherId !== spec.teacher.id ||
    spec.assignment.subjectOfferingId !== spec.offering.id
  )
    out.push('INVALID_ASSIGNMENT');
  if (spec.venue && spec.venue.status !== 'ACTIVE') out.push('VENUE_INACTIVE');
  return out;
}
