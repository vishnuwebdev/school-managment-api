import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import type { Executor } from '../../db/client.js';
import {
  attendanceSettings,
  attendanceStatuses,
  tenantSettings,
  type AttendanceType,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { AuthorizationError, BusinessRuleError, ValidationError } from '../../shared/errors.js';
import type { Clock } from '../../shared/time.js';
import { hasTenantWideScope, scopesFor } from '../access/authorization.service.js';

/** Everything a service call needs from the request. The tenant comes from the session, never input. */
export interface Caller {
  tenantId: string;
  principal: Principal;
  actor: Actor;
  /** Entitled feature codes of the school. */
  features: readonly string[];
}

export type StatusRow = typeof attendanceStatuses.$inferSelect;
export type SettingsRow = typeof attendanceSettings.$inferSelect;

export const SUBJECT_FEATURE = 'attendance.subject';

/** Raw SQL rows. Reports use aliased raw SQL: drizzle renders correlated subqueries unqualified. */
export async function rows<T>(ex: Executor, q: SQL): Promise<T[]> {
  const res = (await ex.execute(q)) as unknown as [T[], unknown];
  return res[0];
}

export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
/** Two-decimal rounding that survives float noise (12.345 → 12.35). */
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
export const weight = (n: number): string => n.toFixed(2);

/** `present units / marked units × 100`, rounded to two decimals; null when nothing was marked. */
export const percentage = (presentUnits: number, markedUnits: number): number | null =>
  markedUnits > 0 ? round2((presentUnits / markedUnits) * 100) : null;

/** Calendar date "today" in the school's own time zone (falls back to UTC). */
export async function schoolToday(ex: Executor, tenantId: string, clock: Clock): Promise<string> {
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
  } catch {
    return clock.now().toISOString().slice(0, 10);
  }
}

const DAY_MS = 86_400_000;
export const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from);
export const addDaysIso = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const eachDate = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) out.push(d);
  return out;
};
/** First and last day of a `YYYY-MM` month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

export function validationIssue(path: string, message: string, code = 'custom'): ValidationError {
  return new ValidationError('The request is invalid', {
    location: 'body',
    issues: [{ path, code, message }],
  });
}

/** SUBJECT attendance is a separate product feature; the permission alone only covers `attendance`. */
export function requireSubjectFeature(features: readonly string[]) {
  if (!features.includes(SUBJECT_FEATURE))
    throw new AuthorizationError(
      'FEATURE_NOT_ENABLED',
      'Subject attendance is not enabled for your school',
      { feature: SUBJECT_FEATURE },
    );
}
export const canUseType = (features: readonly string[], type: AttendanceType) =>
  type === 'DAILY' || features.includes(SUBJECT_FEATURE);

type Col = AnyMySqlColumn | SQL;
const inList = (col: Col, ids: string[]) =>
  sql`${col} in (${sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  )})`;

/**
 * Row-level scope for an attendance permission, expressed on a section / class
 * column pair. Tenant-wide grants return `undefined` (no narrowing); a grant we
 * cannot resolve denies. Derived from the signed-in principal — never client input.
 */
export function placementScope(
  principal: Principal,
  permission: string,
  cols: { section: Col; klass: Col },
): SQL | undefined {
  if (hasTenantWideScope(principal, permission)) return undefined;
  const grants = scopesFor(principal, permission);
  const sectionIds = grants.flatMap((g) =>
    g.type === 'ASSIGNED_SECTION' ? (g.ref?.section_ids ?? []) : [],
  );
  const classIds = grants.flatMap((g) =>
    g.type === 'ASSIGNED_CLASS' ? (g.ref?.class_ids ?? []) : [],
  );
  const parts: SQL[] = [];
  if (sectionIds.length) parts.push(inList(cols.section, sectionIds));
  if (classIds.length) parts.push(inList(cols.klass, classIds));
  if (parts.length === 0) return sql`1 = 0`;
  return sql`(${sql.join(parts, sql` or `)})`;
}

/** Same rule for a section already loaded in memory. */
export function sectionInScope(
  principal: Principal,
  permission: string,
  s: { id: string; classId: string },
): boolean {
  if (hasTenantWideScope(principal, permission)) return true;
  return scopesFor(principal, permission).some(
    (g) =>
      (g.type === 'ASSIGNED_SECTION' && (g.ref?.section_ids ?? []).includes(s.id)) ||
      (g.type === 'ASSIGNED_CLASS' && (g.ref?.class_ids ?? []).includes(s.classId)),
  );
}

/** Statuses and settings a request works with. */
export const statusPresent = (s: StatusRow) => ({
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

export const settingsPresent = (s: SettingsRow) => ({
  approval_required: s.approvalRequired,
  correction_requires_approval: s.correctionRequiresApproval,
  edit_window_days: s.editWindowDays,
  defaulter_threshold_percent: Number(s.defaulterThresholdPercent),
  late_counts_as_present: s.lateCountsAsPresent,
  version: s.version,
  updated_at: s.updatedAt.toISOString(),
});

/** Locking read of the school's settings (they gate submit / edit / correction decisions). */
export async function readSettings(
  ex: Executor,
  tenantId: string,
  lock: 'share' | 'update' | false = false,
): Promise<SettingsRow> {
  const q = ex.select().from(attendanceSettings).where(eq(attendanceSettings.tenantId, tenantId));
  const [row] = await (lock ? q.for(lock) : q);
  if (!row) throw new Error('Attendance settings missing: ensureDefaults must run first');
  return row;
}

export async function loadStatuses(
  ex: Executor,
  tenantId: string,
  ids: string[],
  lock: 'share' | false = false,
): Promise<Map<string, StatusRow>> {
  const out = new Map<string, StatusRow>();
  if (!ids.length) return out;
  const q = ex
    .select()
    .from(attendanceStatuses)
    .where(and(eq(attendanceStatuses.tenantId, tenantId), inList(attendanceStatuses.id, ids)));
  for (const r of await (lock ? q.for(lock) : q)) out.set(r.id, r);
  return out;
}

/**
 * Sessions older than `edit_window_days` cannot be opened or edited — unless an
 * approver (holder of `attendance.approve`) does it, or an approver reopened
 * the session on purpose.
 */
export function assertEditWindow(
  principal: Principal,
  settings: SettingsRow,
  session: { sessionDate: string; reopenedAt: Date | null },
  today: string,
) {
  if (session.reopenedAt) return;
  if (principal.permissions.has('attendance.approve')) return;
  if (daysBetween(session.sessionDate, today) > settings.editWindowDays)
    throw new BusinessRuleError(
      'OPERATION_NOT_ALLOWED',
      `Attendance can only be edited within ${settings.editWindowDays} days of the session date`,
      { reason: 'EDIT_WINDOW_CLOSED', edit_window_days: settings.editWindowDays },
    );
}
