import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { teacherHistory, teachers } from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { NotFoundError } from '../../shared/errors.js';
import type { Deps } from '../../container.js';
import { cacheKeys } from '../../infrastructure/cache.js';
import { hasTenantWideScope, scopesFor } from '../access/authorization.service.js';

export type TeacherRow = typeof teachers.$inferSelect;

export const fullName = (s: { firstName: string; middleName: string | null; lastName: string }) =>
  [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');

/**
 * Row-level scope for a teacher permission. Tenant-wide grants see everyone.
 * A teacher (any narrower grant, e.g. ASSIGNED_SECTION or OWN_RECORD) holding
 * `teachers.read` sees only their own record. Every other permission with a
 * narrower grant is denied (behaves as 404) rather than silently widened.
 */
export function teacherScope(principal: Principal, permission: string): SQL | undefined {
  if (hasTenantWideScope(principal, permission)) return undefined;
  if (permission === 'teachers.read' && scopesFor(principal, permission).length > 0)
    return eq(teachers.membershipId, principal.membershipId);
  return sql`1 = 0`;
}

/**
 * A teacher's reachable sections come from their assignments, so any change to
 * an assignment, class teacher, status or login must drop cached permissions.
 */
export async function refreshTeacherAccess(deps: Deps, tenantId: string): Promise<void> {
  await deps.cache.bump(cacheKeys.tenantAuthzNamespace(tenantId));
}

/**
 * Load a teacher the principal may access, or 404. Another school's id is
 * indistinguishable from a missing one.
 */
export async function loadTeacher(
  ex: Executor,
  tenantId: string,
  teacherId: string,
  principal: Principal,
  permission: string,
  opts: { lock?: boolean } = {},
): Promise<TeacherRow> {
  const q = ex
    .select()
    .from(teachers)
    .where(
      and(
        eq(teachers.id, teacherId),
        eq(teachers.tenantId, tenantId),
        teacherScope(principal, permission),
      ),
    );
  const [row] = await (opts.lock ? q.for('update') : q);
  if (!row) throw new NotFoundError('Teacher');
  return row;
}

export interface HistoryEntry {
  eventType: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  effectiveDate?: string | null;
  reason?: string | null;
  details?: Record<string, unknown> | null;
}

/** Domain history row (readable timeline). The audit log remains the security record. */
export async function addTeacherHistory(
  tx: Executor,
  actor: Actor,
  tenantId: string,
  teacherId: string,
  e: HistoryEntry,
) {
  await tx.insert(teacherHistory).values({
    tenantId,
    teacherId,
    eventType: e.eventType,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    effectiveDate: e.effectiveDate ?? null,
    reason: e.reason ?? null,
    details: e.details ?? null,
    actorUserId: actor.userId,
  });
}

export const presentTeacher = (t: TeacherRow) => ({
  id: t.id,
  teacher_number: t.teacherNumber,
  staff_type: t.staffType,
  status: t.status,
  first_name: t.firstName,
  middle_name: t.middleName,
  last_name: t.lastName,
  preferred_name: t.preferredName,
  full_name: fullName(t),
  date_of_birth: t.dateOfBirth,
  gender: t.gender,
  email: t.email,
  phone: t.phone,
  address: t.address,
  joining_date: t.joiningDate,
  employment_type: t.employmentType,
  department: t.department,
  designation: t.designation,
  photo_file_id: t.photoFileId,
  emergency_contact_name: t.emergencyContactName,
  emergency_contact_phone: t.emergencyContactPhone,
  emergency_contact_relation: t.emergencyContactRelation,
  has_id_number: t.idNumberEnc !== null,
  id_number_masked: t.idNumberLast4 ? `••••${t.idNumberLast4}` : null,
  reporting_manager_id: t.reportingManagerId,
  exit_date: t.exitDate,
  exit_reason: t.exitReason,
  notes: t.notes,
  has_login: t.membershipId !== null,
  status_changed_at: t.statusChangedAt?.toISOString() ?? null,
  version: t.version,
  created_at: t.createdAt.toISOString(),
  updated_at: t.updatedAt.toISOString(),
});

/**
 * The single place a teacher's lifecycle status changes. Writes the new
 * status (and exit information), the history row, the audit row and the outbox
 * event together, using the caller's transaction. Callers have already
 * validated the transition.
 */
export async function setTeacherStatus(
  tx: Executor,
  actor: Actor,
  teacher: TeacherRow,
  to: TeacherRow['status'],
  o: {
    command: string;
    reason?: string | null;
    effectiveDate: string;
    now: Date;
    exit?: { date: string; reason: string } | 'clear';
    assignmentsEnded?: number;
    /** Extra history details, e.g. the leave range for start-leave. */
    details?: Record<string, unknown> | null;
  },
): Promise<void> {
  const exit =
    o.exit === 'clear'
      ? { exitDate: null, exitReason: null }
      : o.exit
        ? { exitDate: o.exit.date, exitReason: o.exit.reason }
        : {};
  await tx
    .update(teachers)
    .set({
      status: to,
      statusChangedAt: o.now,
      version: teacher.version + 1,
      updatedBy: actor.userId,
      ...exit,
    })
    .where(and(eq(teachers.id, teacher.id), eq(teachers.tenantId, teacher.tenantId)));
  const key = o.command.toUpperCase().replace(/-/g, '_');
  await addTeacherHistory(tx, actor, teacher.tenantId, teacher.id, {
    eventType: `TEACHER_${key}`,
    fromStatus: teacher.status,
    toStatus: to,
    effectiveDate: o.effectiveDate,
    reason: o.reason ?? null,
    details:
      o.assignmentsEnded || o.details
        ? { ...(o.details ?? {}), ...(o.assignmentsEnded ? { assignments_ended: o.assignmentsEnded } : {}) }
        : null,
  });
  await recordChange(tx, actor, teacher.tenantId, {
    action: `TEACHER_${key}`,
    entityType: 'teacher',
    entityId: teacher.id,
    event: 'teacher.status_changed',
    before: { status: teacher.status },
    after: { status: to, ...exit },
    reason: o.reason ?? null,
    payload: {
      from_status: teacher.status,
      to_status: to,
      command: o.command,
      effective_date: o.effectiveDate,
      assignments_ended: o.assignmentsEnded ?? 0,
      ...(o.details ?? {}),
    },
  });
  teacher.status = to;
  teacher.version += 1;
}
