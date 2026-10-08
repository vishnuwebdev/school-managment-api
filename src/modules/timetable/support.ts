import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  subjectOfferings,
  subjects,
  teachers,
  teachingAssignments,
  timetableEntries,
  timetablePeriods,
  timetables,
  timetableSettings,
  timetableVenues,
} from '../../db/schema/index.js';
import type { Principal } from '../../platform/context.js';
import { AuthorizationError, NotFoundError } from '../../shared/errors.js';
import { fullName } from '../teachers/support.js';
import { hasTenantWideScope } from '../access/authorization.service.js';
import { placementScope, sectionInScope } from '../attendance/support.js';

export {
  placementScope,
  rows,
  schoolToday,
  sectionInScope,
  validationIssue,
} from '../attendance/support.js';
export type { Caller } from '../attendance/support.js';

export const DAY_NAMES = [
  '',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;
export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];

/** MySQL TIME 'HH:MM:SS' → 'HH:MM'. */
export const hhmm = (t: string) => t.slice(0, 5);
/** 'HH:MM' → 'HH:MM:SS' for storage. */
export const hhmmss = (t: string) => (t.length === 5 ? `${t}:00` : t);

/** ISO weekday (1 = Monday … 7 = Sunday) of a calendar date. */
export const isoWeekday = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

export const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export type PeriodRow = typeof timetablePeriods.$inferSelect;
export type VenueRow = typeof timetableVenues.$inferSelect;
export type TimetableRow = typeof timetables.$inferSelect;
export type EntryRow = typeof timetableEntries.$inferSelect;
export type SettingsRow = typeof timetableSettings.$inferSelect;

export const periodPresent = (p: PeriodRow) => ({
  id: p.id,
  code: p.code,
  name: p.name,
  start_time: hhmm(p.startTime),
  end_time: hhmm(p.endTime),
  kind: p.kind,
  is_teaching: p.kind === 'LESSON',
  display_order: p.displayOrder,
  class_id: p.academicClassId,
  section_id: p.academicSectionId,
  scope: p.academicSectionId ? 'SECTION' : p.academicClassId ? 'CLASS' : 'SCHOOL',
  status: p.status,
  version: p.version,
  created_at: p.createdAt.toISOString(),
  updated_at: p.updatedAt.toISOString(),
});

/**
 * The periods that apply to a section: its own if it has any active ones, else its
 * class's, else the whole school's. A class that has its own periods does not also
 * use the school's, so the days never mix.
 */
export function periodsForSection(
  all: PeriodRow[],
  section: { id: string; classId: string },
): PeriodRow[] {
  const active = all.filter((p) => p.status === 'ACTIVE');
  const own = active.filter((p) => p.academicSectionId === section.id);
  if (own.length) return own;
  const ofClass = active.filter(
    (p) => !p.academicSectionId && p.academicClassId === section.classId,
  );
  if (ofClass.length) return ofClass;
  return active.filter((p) => !p.academicSectionId && !p.academicClassId);
}

export const venuePresent = (v: VenueRow) => ({
  id: v.id,
  code: v.code,
  name: v.name,
  venue_type: v.venueType,
  capacity: v.capacity,
  status: v.status,
  version: v.version,
  created_at: v.createdAt.toISOString(),
  updated_at: v.updatedAt.toISOString(),
});

export const settingsPresent = (s: SettingsRow) => ({
  working_days: [...s.workingDays].sort((a, b) => a - b),
  working_day_names: [...s.workingDays].sort((a, b) => a - b).map((d) => DAY_NAMES[d]),
  school_day_start: s.dayStart ? s.dayStart.slice(0, 5) : null,
  school_day_end: s.dayEnd ? s.dayEnd.slice(0, 5) : null,
  version: s.version,
  updated_at: s.updatedAt.toISOString(),
});

/** Locking read of the school's timetable settings; also the lock that serialises period changes. */
export async function readSettings(
  ex: Executor,
  tenantId: string,
  lock: 'share' | 'update' | false = false,
): Promise<SettingsRow> {
  const q = ex.select().from(timetableSettings).where(eq(timetableSettings.tenantId, tenantId));
  const [row] = await (lock ? q.for(lock) : q);
  if (!row) throw new Error('Timetable settings missing: ensureSettings must run first');
  return row;
}

/**
 * Whole-timetable operations (create, publish, archive, clash report, workload)
 * need a tenant-wide grant of the permission; a narrower (section/class) grant
 * cannot be applied to them and is refused rather than silently widened.
 */
export function requireWide(principal: Principal, permission: string) {
  if (!hasTenantWideScope(principal, permission))
    throw new AuthorizationError(
      'PERMISSION_DENIED',
      'This operation needs school-wide access to the timetable',
    );
}

/**
 * Load a timetable of this school, or 404. Drafts are work in progress: only
 * holders of `timetable.manage` or `timetable.publish` can see them; for everyone else they do not exist.
 */
export async function loadTimetable(
  ex: Executor,
  tenantId: string,
  id: string,
  principal: Principal,
  opts: { lock?: 'update' | 'share'; hideDraft?: boolean } = {},
): Promise<TimetableRow> {
  const q = ex
    .select()
    .from(timetables)
    .where(and(eq(timetables.id, id), eq(timetables.tenantId, tenantId)));
  const [row] = await (opts.lock ? q.for(opts.lock) : q);
  if (!row) throw new NotFoundError('Timetable');
  if (
    opts.hideDraft !== false &&
    row.status === 'DRAFT' &&
    !principal.permissions.has('timetable.manage') &&
    !principal.permissions.has('timetable.publish')
  )
    throw new NotFoundError('Timetable');
  return row;
}

/** A section the principal may access for `permission`, or 404 (other schools' ids and out-of-scope sections alike). */
export async function loadSection(
  ex: Executor,
  tenantId: string,
  sectionId: string,
  principal: Principal,
  permission: string,
  lock?: 'share',
) {
  const q = ex
    .select({
      id: academicSections.id,
      code: academicSections.code,
      name: academicSections.name,
      status: academicSections.status,
      classId: academicSections.classId,
      academicYearId: academicSections.academicYearId,
      className: academicClasses.name,
      classCode: academicClasses.code,
    })
    .from(academicSections)
    .innerJoin(academicClasses, eq(academicClasses.id, academicSections.classId))
    .where(and(eq(academicSections.id, sectionId), eq(academicSections.tenantId, tenantId)));
  const [row] = await (lock ? q.for(lock) : q);
  if (!row || !sectionInScope(principal, permission, row)) throw new NotFoundError('Section');
  return row;
}

// ---- entry views ---------------------------------------------------------------------

const entrySelection = {
  e: timetableEntries,
  p: timetablePeriods,
  s: {
    id: academicSections.id,
    code: academicSections.code,
    name: academicSections.name,
    status: academicSections.status,
    classId: academicSections.classId,
  },
  c: { id: academicClasses.id, code: academicClasses.code, name: academicClasses.name },
  o: {
    status: subjectOfferings.status,
    classId: subjectOfferings.classId,
    sectionId: subjectOfferings.sectionId,
    academicYearId: subjectOfferings.academicYearId,
  },
  sub: { id: subjects.id, code: subjects.code, name: subjects.name },
  a: {
    status: teachingAssignments.status,
    teacherId: teachingAssignments.teacherId,
    subjectOfferingId: teachingAssignments.subjectOfferingId,
  },
  t: {
    id: teachers.id,
    teacherNumber: teachers.teacherNumber,
    firstName: teachers.firstName,
    middleName: teachers.middleName,
    lastName: teachers.lastName,
    status: teachers.status,
  },
  v: {
    id: timetableVenues.id,
    code: timetableVenues.code,
    name: timetableVenues.name,
    status: timetableVenues.status,
    capacity: timetableVenues.capacity,
  },
};

export interface EntryJoined {
  e: EntryRow;
  p: PeriodRow;
  s: { id: string; code: string; name: string; status: string; classId: string };
  c: { id: string; code: string; name: string };
  o: { status: string; classId: string; sectionId: string | null; academicYearId: string };
  sub: { id: string; code: string; name: string };
  a: { status: string; teacherId: string; subjectOfferingId: string };
  t: {
    id: string;
    teacherNumber: string;
    firstName: string;
    middleName: string | null;
    lastName: string;
    status: string;
  };
  /** Drizzle returns null for the whole group when the LEFT JOIN finds no venue. */
  v: { id: string; code: string; name: string; status: string; capacity: number | null } | null;
}

/** entry ⋈ period ⋈ section ⋈ class ⋈ offering ⋈ subject ⋈ assignment ⋈ teacher ⟕ venue, ready for `.where()`. */
export function entryQuery(ex: Executor) {
  const t = timetableEntries;
  return ex
    .select(entrySelection)
    .from(t)
    .innerJoin(
      timetablePeriods,
      and(eq(timetablePeriods.tenantId, t.tenantId), eq(timetablePeriods.id, t.periodId)),
    )
    .innerJoin(
      academicSections,
      and(eq(academicSections.tenantId, t.tenantId), eq(academicSections.id, t.sectionId)),
    )
    .innerJoin(academicClasses, eq(academicClasses.id, academicSections.classId))
    .innerJoin(
      subjectOfferings,
      and(eq(subjectOfferings.tenantId, t.tenantId), eq(subjectOfferings.id, t.subjectOfferingId)),
    )
    .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
    .innerJoin(
      teachingAssignments,
      and(
        eq(teachingAssignments.tenantId, t.tenantId),
        eq(teachingAssignments.id, t.teachingAssignmentId),
      ),
    )
    .innerJoin(teachers, and(eq(teachers.tenantId, t.tenantId), eq(teachers.id, t.teacherId)))
    .leftJoin(
      timetableVenues,
      and(eq(timetableVenues.tenantId, t.tenantId), eq(timetableVenues.id, t.venueId)),
    );
}

export const ENTRY_ORDER = [
  sql`${timetableEntries.dayOfWeek}`,
  sql`${timetablePeriods.startTime}`,
  sql`${academicClasses.code}`,
  sql`${academicSections.code}`,
  sql`${timetableEntries.id}`,
];

export async function fetchEntries(
  ex: Executor,
  where: SQL | undefined,
  lock?: 'share' | 'update',
): Promise<EntryJoined[]> {
  const q = entryQuery(ex)
    .where(where)
    .orderBy(...ENTRY_ORDER);
  return (await (lock ? q.for(lock) : q)) as EntryJoined[];
}

export function presentEntry(r: EntryJoined) {
  return {
    id: r.e.id,
    timetable_id: r.e.timetableId,
    day_of_week: r.e.dayOfWeek,
    day_name: DAY_NAMES[r.e.dayOfWeek],
    period: {
      id: r.p.id,
      code: r.p.code,
      name: r.p.name,
      start_time: hhmm(r.p.startTime),
      end_time: hhmm(r.p.endTime),
    },
    section: {
      id: r.s.id,
      code: r.s.code,
      name: r.s.name,
      class: { id: r.c.id, code: r.c.code, name: r.c.name },
    },
    subject: r.sub,
    subject_offering_id: r.e.subjectOfferingId,
    teaching_assignment_id: r.e.teachingAssignmentId,
    teacher: {
      id: r.t.id,
      teacher_number: r.t.teacherNumber,
      full_name: fullName(r.t),
    },
    venue: r.v ? { id: r.v.id, code: r.v.code, name: r.v.name } : null,
    status: r.e.status,
    version: r.e.version,
    created_at: r.e.createdAt.toISOString(),
    updated_at: r.e.updatedAt.toISOString(),
  };
}
export type EntryView = ReturnType<typeof presentEntry>;

/** Row-level read/export scope on the joined entry query. */
export const entryScope = (principal: Principal, permission: string) =>
  placementScope(principal, permission, {
    section: timetableEntries.sectionId,
    klass: academicSections.classId,
  });

export async function loadYear(ex: Executor, tenantId: string, id: string, lock?: 'update') {
  const q = ex
    .select()
    .from(academicYears)
    .where(and(eq(academicYears.id, id), eq(academicYears.tenantId, tenantId)));
  const [row] = await (lock ? q.for(lock) : q);
  if (!row) throw new NotFoundError('Academic year');
  return row;
}

/** Number of entries per timetable, for list and detail pages. */
export async function entryCounts(ex: Executor, tenantId: string, ids: string[]) {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const res = await ex
    .select({ id: timetableEntries.timetableId, n: sql<number>`count(*)` })
    .from(timetableEntries)
    .where(
      and(
        eq(timetableEntries.tenantId, tenantId),
        sql`${timetableEntries.timetableId} in (${sql.join(
          ids.map((i) => sql`${i}`),
          sql`, `,
        )})`,
      ),
    )
    .groupBy(timetableEntries.timetableId);
  for (const r of res) out.set(r.id, Number(r.n));
  return out;
}

export const presentTimetable = (
  t: TimetableRow,
  year: { id: string; code: string; name: string },
  entryCount: number,
) => ({
  id: t.id,
  academic_year: { id: year.id, code: year.code, name: year.name },
  name: t.name,
  status: t.status,
  version_no: t.versionNo,
  effective_from: t.effectiveFrom,
  effective_to: t.effectiveTo,
  notes: t.notes,
  copied_from_id: t.copiedFromId,
  superseded_by_id: t.supersededById,
  published_at: t.publishedAt?.toISOString() ?? null,
  archived_at: t.archivedAt?.toISOString() ?? null,
  entry_count: entryCount,
  version: t.version,
  created_at: t.createdAt.toISOString(),
  updated_at: t.updatedAt.toISOString(),
});
export type TimetableView = ReturnType<typeof presentTimetable>;

export const inList = (col: SQL | Parameters<typeof eq>[0], ids: string[]) =>
  sql`${col} in (${sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  )})`;
