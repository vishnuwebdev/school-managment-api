import { and, eq, sql } from 'drizzle-orm';
import { attendanceSettings, attendanceStatuses, tenantSettings, } from '../../db/schema/index.js';
import { AuthorizationError, BusinessRuleError, ValidationError } from '../../shared/errors.js';
import { hasTenantWideScope, scopesFor } from '../access/authorization.service.js';
export const SUBJECT_FEATURE = 'attendance.subject';
/** Raw SQL rows. Reports use aliased raw SQL: drizzle renders correlated subqueries unqualified. */
export async function rows(ex, q) {
    const res = (await ex.execute(q));
    return res[0];
}
export const num = (v) => (v === null || v === undefined ? 0 : Number(v));
/** Two-decimal rounding that survives float noise (12.345 → 12.35). */
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const weight = (n) => n.toFixed(2);
/** `present units / marked units × 100`, rounded to two decimals; null when nothing was marked. */
export const percentage = (presentUnits, markedUnits) => markedUnits > 0 ? round2((presentUnits / markedUnits) * 100) : null;
/** Calendar date "today" in the school's own time zone (falls back to UTC). */
export async function schoolToday(ex, tenantId, clock) {
    const [s] = await ex
        .select({ tz: tenantSettings.timezone })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tenantId));
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: s?.tz ?? 'UTC',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(clock.now());
    }
    catch {
        return clock.now().toISOString().slice(0, 10);
    }
}
const DAY_MS = 86_400_000;
export const dayNumber = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
export const daysBetween = (from, to) => dayNumber(to) - dayNumber(from);
export const addDaysIso = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const eachDate = (from, to) => {
    const out = [];
    for (let d = from; d <= to; d = addDaysIso(d, 1))
        out.push(d);
    return out;
};
/** First and last day of a `YYYY-MM` month. */
export function monthRange(month) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
export function validationIssue(path, message, code = 'custom') {
    return new ValidationError('The request is invalid', {
        location: 'body',
        issues: [{ path, code, message }],
    });
}
/** SUBJECT attendance is a separate product feature; the permission alone only covers `attendance`. */
export function requireSubjectFeature(features) {
    if (!features.includes(SUBJECT_FEATURE))
        throw new AuthorizationError('FEATURE_NOT_ENABLED', 'Subject attendance is not enabled for your school', { feature: SUBJECT_FEATURE });
}
export const canUseType = (features, type) => type === 'DAILY' || features.includes(SUBJECT_FEATURE);
const inList = (col, ids) => sql `${col} in (${sql.join(ids.map((i) => sql `${i}`), sql `, `)})`;
/**
 * Row-level scope for an attendance permission, expressed on a section / class
 * column pair. Tenant-wide grants return `undefined` (no narrowing); a grant we
 * cannot resolve denies. Derived from the signed-in principal — never client input.
 */
export function placementScope(principal, permission, cols) {
    if (hasTenantWideScope(principal, permission))
        return undefined;
    const grants = scopesFor(principal, permission);
    const sectionIds = grants.flatMap((g) => g.type === 'ASSIGNED_SECTION' ? (g.ref?.section_ids ?? []) : []);
    const classIds = grants.flatMap((g) => g.type === 'ASSIGNED_CLASS' ? (g.ref?.class_ids ?? []) : []);
    const parts = [];
    if (sectionIds.length)
        parts.push(inList(cols.section, sectionIds));
    if (classIds.length)
        parts.push(inList(cols.klass, classIds));
    if (parts.length === 0)
        return sql `1 = 0`;
    return sql `(${sql.join(parts, sql ` or `)})`;
}
/** Same rule for a section already loaded in memory. */
export function sectionInScope(principal, permission, s) {
    if (hasTenantWideScope(principal, permission))
        return true;
    return scopesFor(principal, permission).some((g) => (g.type === 'ASSIGNED_SECTION' && (g.ref?.section_ids ?? []).includes(s.id)) ||
        (g.type === 'ASSIGNED_CLASS' && (g.ref?.class_ids ?? []).includes(s.classId)));
}
/** Statuses and settings a request works with. */
export const statusPresent = (s) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    category: s.category,
    counts_as_present: Number(s.countsAsPresent),
    counts_as_absent: Number(s.countsAsAbsent),
    requires_reason: s.requiresReason,
    sort_order: s.sortOrder,
    status: s.status,
    is_system: s.isSystem,
    version: s.version,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
});
export const settingsPresent = (s) => ({
    approval_required: s.approvalRequired,
    correction_requires_approval: s.correctionRequiresApproval,
    edit_window_days: s.editWindowDays,
    defaulter_threshold_percent: Number(s.defaulterThresholdPercent),
    late_counts_as_present: s.lateCountsAsPresent,
    version: s.version,
    updated_at: s.updatedAt.toISOString(),
});
/** Locking read of the school's settings (they gate submit / edit / correction decisions). */
export async function readSettings(ex, tenantId, lock = false) {
    const q = ex.select().from(attendanceSettings).where(eq(attendanceSettings.tenantId, tenantId));
    const [row] = await (lock ? q.for(lock) : q);
    if (!row)
        throw new Error('Attendance settings missing: ensureDefaults must run first');
    return row;
}
export async function loadStatuses(ex, tenantId, ids, lock = false) {
    const out = new Map();
    if (!ids.length)
        return out;
    const q = ex
        .select()
        .from(attendanceStatuses)
        .where(and(eq(attendanceStatuses.tenantId, tenantId), inList(attendanceStatuses.id, ids)));
    for (const r of await (lock ? q.for(lock) : q))
        out.set(r.id, r);
    return out;
}
/**
 * Sessions older than `edit_window_days` cannot be opened or edited — unless an
 * approver (holder of `attendance.approve`) does it, or an approver reopened
 * the session on purpose.
 */
export function assertEditWindow(principal, settings, session, today) {
    if (session.reopenedAt)
        return;
    if (principal.permissions.has('attendance.approve'))
        return;
    if (daysBetween(session.sessionDate, today) > settings.editWindowDays)
        throw new BusinessRuleError('OPERATION_NOT_ALLOWED', `Attendance can only be edited within ${settings.editWindowDays} days of the session date`, { reason: 'EDIT_WINDOW_CLOSED', edit_window_days: settings.editWindowDays });
}
