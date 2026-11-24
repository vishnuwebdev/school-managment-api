import { and, eq, inArray, sql } from 'drizzle-orm';
import { academicClasses, academicSections, academicYears, timetablePeriods, timetableSettings, } from '../../db/schema/index.js';
import { AuthorizationError, BusinessRuleError, NotFoundError } from '../../shared/errors.js';
import { hasTenantWideScope } from '../access/authorization.service.js';
import { sectionInScope } from '../attendance/support.js';
export { placementScope, rows, schoolToday, sectionInScope, validationIssue, } from '../attendance/support.js';
export const DAY_NAMES = [
    '',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
];
export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];
/** MySQL TIME 'HH:MM:SS' → 'HH:MM'. */
export const hhmm = (t) => t.slice(0, 5);
/** 'HH:MM' → 'HH:MM:SS' for storage. */
export const hhmmss = (t) => (t.length === 5 ? `${t}:00` : t);
/** ISO weekday (1 = Monday … 7 = Sunday) of a calendar date. */
export const isoWeekday = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
    return d === 0 ? 7 : d;
};
export const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Whether a period runs on ISO weekday [day] (NULL days = every working day). */
export const runsOn = (p, day) => !p.daysOfWeek || p.daysOfWeek.length === 0 || p.daysOfWeek.includes(day);
/** Whether two periods share at least one weekday (NULL = every day). */
export const daysOverlap = (a, b) => !a || !b || a.length === 0 || b.length === 0 || a.some((d) => b.includes(d));
/** Sorted unique weekdays, or null for "every working day". */
export const normalizeDays = (days) => days && days.length ? [...new Set(days)].sort((x, y) => x - y) : null;
export const venuePresent = (v) => ({
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
export const settingsPresent = (s) => ({
    working_days: [...s.workingDays].sort((a, b) => a - b),
    working_day_names: [...s.workingDays].sort((a, b) => a - b).map((d) => DAY_NAMES[d]),
    school_day_start: s.dayStart ? s.dayStart.slice(0, 5) : null,
    school_day_end: s.dayEnd ? s.dayEnd.slice(0, 5) : null,
    version: s.version,
    updated_at: s.updatedAt.toISOString(),
});
/**
 * Read of the school's timetable settings. With `update` it is also THE lock
 * that serialises every timetable write of the school, so clash checks (which
 * look at the whole year) never race each other.
 */
export async function readSettings(ex, tenantId, lock = false) {
    const q = ex.select().from(timetableSettings).where(eq(timetableSettings.tenantId, tenantId));
    const [row] = await (lock ? q.for(lock) : q);
    if (!row)
        throw new Error('Timetable settings missing: ensureSettings must run first');
    return row;
}
/**
 * School-wide operations (the School default day, copying a year, workload)
 * need a tenant-wide grant; a section/class grant is refused rather than widened.
 */
export function requireWide(principal, permission) {
    if (!hasTenantWideScope(principal, permission))
        throw new AuthorizationError('PERMISSION_DENIED', 'This operation needs school-wide access to the timetable');
}
export async function loadYear(ex, tenantId, id, lock) {
    const q = ex
        .select()
        .from(academicYears)
        .where(and(eq(academicYears.id, id), eq(academicYears.tenantId, tenantId)));
    const [row] = await (lock ? q.for(lock) : q);
    if (!row)
        throw new NotFoundError('Academic year');
    return row;
}
/** The school's current academic year, or null. */
export async function currentYearId(ex, tenantId) {
    const [y] = await ex
        .select({ id: academicYears.id })
        .from(academicYears)
        .where(and(eq(academicYears.tenantId, tenantId), eq(academicYears.isCurrent, true)));
    return y?.id ?? null;
}
/** Occupancy / grouping key of an owner: the section id, or `C<class id>:<year id>`. */
export const ownerKey = (o) => o.sectionId ?? `C${o.classId}:${o.yearId}`;
/** Whether the class is split into (active or draft) sections in the year. */
export async function classHasSections(ex, tenantId, classId, academicYearId) {
    const [s] = await ex
        .select({ id: academicSections.id })
        .from(academicSections)
        .where(and(eq(academicSections.tenantId, tenantId), eq(academicSections.classId, classId), eq(academicSections.academicYearId, academicYearId), inArray(academicSections.status, ['ACTIVE', 'DRAFT'])))
        .limit(1);
    return !!s;
}
/** A section the principal may access for `permission`, or 404 (other schools' ids and out-of-scope sections alike). */
export async function loadSection(ex, tenantId, sectionId, principal, permission, lock) {
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
    if (!row || !sectionInScope(principal, permission, row))
        throw new NotFoundError('Section');
    return row;
}
/**
 * A class that has no (open) sections in [academicYearId]. 404 when missing or
 * out of scope; 422 CLASS_HAS_SECTIONS when the class is split into sections
 * (its school day then belongs to each section).
 */
export async function loadClassOwner(ex, tenantId, classId, academicYearId, principal, permission, lock) {
    const q = ex
        .select({
        id: academicClasses.id,
        code: academicClasses.code,
        name: academicClasses.name,
        status: academicClasses.status,
    })
        .from(academicClasses)
        .where(and(eq(academicClasses.id, classId), eq(academicClasses.tenantId, tenantId)));
    const [row] = await (lock ? q.for(lock) : q);
    if (!row || !sectionInScope(principal, permission, { id: '', classId: row.id }))
        throw new NotFoundError('Class');
    if (await classHasSections(ex, tenantId, classId, academicYearId))
        throw new BusinessRuleError('OPERATION_NOT_ALLOWED', `${row.name} has sections: set up the timetable of each section instead`, { reason: 'CLASS_HAS_SECTIONS', class_id: classId });
    return row;
}
/**
 * Resolve `{section_id}` or `{class_id, academic_year_id}` to an owner the
 * principal may use for `permission`. A section's year is its own; a class
 * defaults to the current academic year.
 */
export async function resolveOwner(ex, tenantId, input, principal, permission, lock) {
    if (input.section_id) {
        const s = await loadSection(ex, tenantId, input.section_id, principal, permission, lock);
        return {
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
    }
    if (!input.class_id)
        throw new NotFoundError('Section');
    const yearId = input.academic_year_id ?? (await currentYearId(ex, tenantId));
    if (!yearId)
        throw new NotFoundError('Academic year');
    await loadYear(ex, tenantId, yearId);
    const c = await loadClassOwner(ex, tenantId, input.class_id, yearId, principal, permission, lock);
    return {
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
}
/** SQL filter for the periods of an owner (or the School default day when null). */
export const ownerFilter = (owner) => owner === null
    ? sql `${timetablePeriods.academicClassId} is null and ${timetablePeriods.academicSectionId} is null`
    : owner.sectionId
        ? sql `${timetablePeriods.academicSectionId} = ${owner.sectionId}`
        : sql `${timetablePeriods.academicSectionId} is null and ${timetablePeriods.academicClassId} = ${owner.classId} and ${timetablePeriods.academicYearId} = ${owner.yearId}`;
export const inList = (col, ids) => sql `${col} in (${sql.join(ids.map((i) => sql `${i}`), sql `, `)})`;
