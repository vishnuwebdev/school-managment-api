import { and, eq, sql } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { academicSections, timetableEntries, timetablePeriods } from '../../db/schema/index.js';
import { periodsForSection } from './support.js';
import {
  DAY_NAMES,
  fetchEntries,
  presentEntry,
  rows,
  type EntryJoined,
  type EntryView,
  type SettingsRow,
  type TimetableRow,
} from './support.js';

export type IssueType =
  | 'TEACHER_CLASH'
  | 'SECTION_CLASH'
  | 'VENUE_CLASH'
  | 'NO_ENTRIES'
  | 'INVALID_ASSIGNMENT'
  | 'OFFERING_INACTIVE'
  | 'OFFERING_NOT_FOR_SECTION'
  | 'PERIOD_INACTIVE'
  | 'PERIOD_NOT_LESSON'
  | 'DAY_NOT_WORKING'
  | 'VENUE_INACTIVE'
  | 'SECTION_NOT_SCHEDULABLE'
  | 'SECTION_WITHOUT_ENTRIES'
  | 'EMPTY_SLOTS'
  | 'VENUE_CAPACITY';

export interface Issue {
  type: IssueType;
  severity: 'BLOCKING' | 'WARNING';
  message: string;
  day_of_week?: number;
  period_id?: string;
  entries?: EntryView[];
  details?: Record<string, unknown>;
}

export interface CheckResult {
  timetable_id: string;
  /** No blocking issue: the timetable can be published. */
  ok: boolean;
  blocking: Issue[];
  warnings: Issue[];
  summary: {
    entries: number;
    sections_scheduled: number;
    sections_unscheduled: number;
    teachers: number;
    blocking_count: number;
    warning_count: number;
  };
}

/**
 * Every rule a timetable must satisfy, evaluated over the stored entries.
 * Clashes are grouped by kind (teacher, section, venue) so the UI can say what
 * is wrong rather than "invalid". `strict` turns the completeness warnings
 * (sections without lessons, empty lesson slots) into blocking issues.
 * With `lock`, the rows it read stay locked until the caller's transaction ends.
 */
export async function runCheck(
  ex: Executor,
  tenantId: string,
  tt: TimetableRow,
  settings: SettingsRow,
  o: { strict?: boolean; lock?: 'share' } = {},
): Promise<CheckResult> {
  const all: EntryJoined[] = await fetchEntries(
    ex,
    and(
      eq(timetableEntries.tenantId, tenantId),
      eq(timetableEntries.timetableId, tt.id),
      eq(timetableEntries.status, 'ACTIVE'),
    ),
    o.lock,
  );
  const blocking: Issue[] = [];
  const warnings: Issue[] = [];
  const view = new Map<string, EntryView>();
  const v = (r: EntryJoined) => {
    let x = view.get(r.e.id);
    if (!x) view.set(r.e.id, (x = presentEntry(r)));
    return x;
  };
  const block = (i: Omit<Issue, 'severity'>) => blocking.push({ ...i, severity: 'BLOCKING' });
  const warn = (i: Omit<Issue, 'severity'>) => warnings.push({ ...i, severity: 'WARNING' });

  if (all.length === 0) block({ type: 'NO_ENTRIES', message: 'The timetable has no lessons yet' });

  // ---- clashes
  const groups = (key: (r: EntryJoined) => string | null) => {
    const m = new Map<string, EntryJoined[]>();
    for (const r of all) {
      const k = key(r);
      if (k === null) continue;
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.values()].filter((g) => g.length > 1);
  };
  const clashes: [IssueType, string, (r: EntryJoined) => string | null][] = [
    [
      'TEACHER_CLASH',
      'is teaching two lessons at once',
      (r) => `${r.e.teacherId}:${r.e.dayOfWeek}:${r.e.periodId}`,
    ],
    [
      'SECTION_CLASH',
      'has two lessons at once',
      (r) => `${r.e.sectionId}:${r.e.dayOfWeek}:${r.e.periodId}`,
    ],
    [
      'VENUE_CLASH',
      'is booked twice at once',
      (r) => (r.e.venueId ? `${r.e.venueId}:${r.e.dayOfWeek}:${r.e.periodId}` : null),
    ],
  ];
  for (const [type, what, key] of clashes)
    for (const g of groups(key)) {
      const first = g[0]!;
      const who =
        type === 'TEACHER_CLASH'
          ? `${first.t.firstName} ${first.t.lastName}`
          : type === 'SECTION_CLASH'
            ? `${first.c.name} ${first.s.name}`
            : (first.v?.name ?? 'Venue');
      block({
        type,
        message: `${who} ${what} on ${DAY_NAMES[first.e.dayOfWeek]}, ${first.p.name}`,
        day_of_week: first.e.dayOfWeek,
        period_id: first.e.periodId,
        entries: g.map(v),
      });
    }

  // ---- references that no longer work
  const roster = new Map<string, number>();
  for (const r of await rows<{ section_id: string; n: string | number }>(
    ex,
    sql`select en.section_id, count(*) as n from enrollments en
        where en.tenant_id = ${tenantId} and en.academic_year_id = ${tt.academicYearId}
          and en.status in ('PENDING', 'ACTIVE') and en.section_id is not null
        group by en.section_id`,
  ))
    roster.set(r.section_id, Number(r.n));
  for (const r of all) {
    const at = { day_of_week: r.e.dayOfWeek, period_id: r.e.periodId, entries: [v(r)] };
    if (r.a.status !== 'ACTIVE')
      block({
        type: 'INVALID_ASSIGNMENT',
        message: `The teaching assignment of ${r.t.firstName} ${r.t.lastName} for ${r.sub.name} is ${r.a.status.toLowerCase()}`,
        ...at,
        details: {
          teaching_assignment_id: r.e.teachingAssignmentId,
          assignment_status: r.a.status,
        },
      });
    else if (r.a.teacherId !== r.e.teacherId || r.a.subjectOfferingId !== r.e.subjectOfferingId)
      block({
        type: 'INVALID_ASSIGNMENT',
        message: 'The lesson no longer matches its teaching assignment',
        ...at,
      });
    if (r.o.status !== 'ACTIVE')
      block({ type: 'OFFERING_INACTIVE', message: `${r.sub.name} is no longer offered`, ...at });
    if (r.o.classId !== r.s.classId || (r.o.sectionId !== null && r.o.sectionId !== r.s.id))
      block({
        type: 'OFFERING_NOT_FOR_SECTION',
        message: `${r.sub.name} is not offered to ${r.c.name} ${r.s.name}`,
        ...at,
      });
    if (r.p.status !== 'ACTIVE')
      block({ type: 'PERIOD_INACTIVE', message: `${r.p.name} is inactive`, ...at });
    if (r.p.kind !== 'LESSON')
      block({ type: 'PERIOD_NOT_LESSON', message: `${r.p.name} is not a lesson period`, ...at });
    if (!settings.workingDays.includes(r.e.dayOfWeek))
      block({
        type: 'DAY_NOT_WORKING',
        message: `${DAY_NAMES[r.e.dayOfWeek]} is not a teaching day`,
        ...at,
      });
    if (r.v && r.v.status !== 'ACTIVE')
      block({ type: 'VENUE_INACTIVE', message: `${r.v.name} is inactive`, ...at });
    if (r.s.status !== 'ACTIVE' && r.s.status !== 'DRAFT')
      block({
        type: 'SECTION_NOT_SCHEDULABLE',
        message: `${r.c.name} ${r.s.name} is ${r.s.status.toLowerCase()}`,
        ...at,
      });
    if (r.v?.capacity != null) {
      const n = roster.get(r.e.sectionId) ?? 0;
      if (n > r.v.capacity)
        warn({
          type: 'VENUE_CAPACITY',
          message: `${r.v.name} seats ${r.v.capacity} but ${r.c.name} ${r.s.name} has ${n} students`,
          ...at,
          details: { capacity: r.v.capacity, students: n },
        });
    }
  }

  // ---- completeness
  const activePeriods = await ex
    .select()
    .from(timetablePeriods)
    .where(and(eq(timetablePeriods.tenantId, tenantId), eq(timetablePeriods.status, 'ACTIVE')));
  const perSection = new Map<string, number>();
  for (const r of all) perSection.set(r.e.sectionId, (perSection.get(r.e.sectionId) ?? 0) + 1);
  const sections = await ex
    .select({
      id: academicSections.id,
      code: academicSections.code,
      name: academicSections.name,
      classId: academicSections.classId,
    })
    .from(academicSections)
    .where(
      and(
        eq(academicSections.tenantId, tenantId),
        eq(academicSections.academicYearId, tt.academicYearId),
        eq(academicSections.status, 'ACTIVE'),
      ),
    );
  const completeness = o.strict ? block : warn;
  let unscheduled = 0;
  for (const s of sections) {
    // Each section has its own school day, so its number of lesson slots differs.
    const capacity =
      periodsForSection(activePeriods, { id: s.id, classId: s.classId }).filter(
        (p) => p.kind === 'LESSON',
      ).length * settings.workingDays.length;
    const n = perSection.get(s.id) ?? 0;
    if (n === 0) {
      unscheduled++;
      completeness({
        type: 'SECTION_WITHOUT_ENTRIES',
        message: `Section ${s.name} has no lessons`,
        details: { section_id: s.id },
      });
    } else if (n < capacity)
      completeness({
        type: 'EMPTY_SLOTS',
        message: `Section ${s.name} has ${capacity - n} empty lesson slot(s)`,
        details: { section_id: s.id, empty_slots: capacity - n, lesson_slots: capacity },
      });
  }
  return {
    timetable_id: tt.id,
    ok: blocking.length === 0,
    blocking,
    warnings,
    summary: {
      entries: all.length,
      sections_scheduled: perSection.size,
      sections_unscheduled: unscheduled,
      teachers: new Set(all.map((r) => r.e.teacherId)).size,
      blocking_count: blocking.length,
      warning_count: warnings.length,
    },
  };
}
