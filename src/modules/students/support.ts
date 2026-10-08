import { assertWithinPlanLimit } from '../entitlements/plan-limits.js';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import {
  enrollments,
  numberSequences,
  OPEN_ENROLLMENT_STATUSES,
  studentHistory,
  students,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { NotFoundError } from '../../shared/errors.js';
import { hasTenantWideScope, scopesFor } from '../access/authorization.service.js';

export type StudentRow = typeof students.$inferSelect;

const OPEN = [...OPEN_ENROLLMENT_STATUSES];

/** Escape LIKE wildcards so a search for "50%" is literal. */
export const likeOf = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/**
 * Next business number for a school: `PREFIX-YYYY-00001`. The counter row is
 * incremented atomically inside the caller's transaction, so concurrent
 * requests can never receive the same number.
 */
export async function nextNumber(
  tx: Executor,
  tenantId: string,
  kind: 'STU' | 'ADM' | 'TCH' | 'FEE' | 'RCT' | 'PAY' | 'RFD' | 'BON' | 'TRC' | 'CHC' | 'IDC',
  now: Date,
): Promise<string> {
  const year = now.getUTCFullYear();
  const key = `${kind}:${year}`;
  await tx
    .insert(numberSequences)
    .values({ tenantId, sequenceKey: key, lastValue: 0 })
    .onDuplicateKeyUpdate({ set: { lastValue: sql`${numberSequences.lastValue}` } });
  const [row] = await tx
    .select()
    .from(numberSequences)
    .where(and(eq(numberSequences.tenantId, tenantId), eq(numberSequences.sequenceKey, key)))
    .for('update');
  const next = (row?.lastValue ?? 0) + 1;
  await tx
    .update(numberSequences)
    .set({ lastValue: next })
    .where(and(eq(numberSequences.tenantId, tenantId), eq(numberSequences.sequenceKey, key)));
  return `${kind}-${year}-${String(next).padStart(5, '0')}`;
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
export async function addHistory(
  tx: Executor,
  actor: Actor,
  tenantId: string,
  studentId: string,
  e: HistoryEntry,
) {
  await tx.insert(studentHistory).values({
    tenantId,
    studentId,
    eventType: e.eventType,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    effectiveDate: e.effectiveDate ?? null,
    reason: e.reason ?? null,
    details: e.details ?? null,
    actorUserId: actor.userId,
  });
}

/**
 * Row-level scope for a student permission. A teacher limited to ASSIGNED_SECTION
 * / ASSIGNED_CLASS only sees students with an open enrollment there. The scope
 * comes from the signed-in principal — never from client input.
 * Returns `undefined` for tenant-wide access.
 */
export function studentScope(principal: Principal, permission: string): SQL | undefined {
  if (hasTenantWideScope(principal, permission)) return undefined;
  const grants = scopesFor(principal, permission);
  const sectionIds = grants.flatMap((g) =>
    g.type === 'ASSIGNED_SECTION' ? (g.ref?.section_ids ?? []) : [],
  );
  const classIds = grants.flatMap((g) =>
    g.type === 'ASSIGNED_CLASS' ? (g.ref?.class_ids ?? []) : [],
  );
  const placement: SQL[] = [];
  if (sectionIds.length) placement.push(inArray(enrollments.sectionId, sectionIds));
  if (classIds.length) placement.push(inArray(enrollments.classId, classIds));
  if (placement.length === 0) return sql`1 = 0`; // scope type we cannot resolve: deny
  return sql`exists (select 1 from ${enrollments} where ${enrollments.tenantId} = ${students.tenantId} and ${enrollments.studentId} = ${students.id} and ${inArray(enrollments.status, OPEN)} and (${sql.join(placement, sql` or `)}))`;
}

/**
 * Load a student the principal may access, or 404. Another school's id, or a
 * student outside the actor's scope, is indistinguishable from a missing one.
 */
export async function loadStudent(
  ex: Executor,
  tenantId: string,
  studentId: string,
  principal: Principal,
  permission: string,
  opts: { lock?: boolean } = {},
): Promise<StudentRow> {
  const scope = studentScope(principal, permission);
  const q = ex
    .select()
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.tenantId, tenantId), scope));
  const [row] = await (opts.lock ? q.for('update') : q);
  if (!row) throw new NotFoundError('Student');
  return row;
}

export const fullName = (s: { firstName: string; middleName: string | null; lastName: string }) =>
  [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');

const COUNTED = new Set<string>(['ADMITTED', 'ACTIVE']);

/**
 * The single place a student's lifecycle status changes. Writes the new
 * status, the history row, the audit row and the outbox event together, using
 * the caller's transaction. Callers have already validated the transition.
 */
export async function setStudentStatus(
  tx: Executor,
  actor: Actor,
  student: StudentRow,
  to: StudentRow['status'],
  o: {
    command: string;
    reason?: string | null;
    effectiveDate?: string | null;
    now: Date;
    details?: Record<string, unknown> | null;
  },
): Promise<void> {
  // Becoming admitted/active uses a seat of the plan's student limit.
  if (COUNTED.has(to) && !COUNTED.has(student.status))
    await assertWithinPlanLimit(tx, student.tenantId, o.now, 'STUDENTS');
  await tx
    .update(students)
    .set({ status: to, statusChangedAt: o.now, version: student.version + 1 })
    .where(and(eq(students.id, student.id), eq(students.tenantId, student.tenantId)));
  await addHistory(tx, actor, student.tenantId, student.id, {
    eventType: `STUDENT_${o.command.toUpperCase()}`,
    fromStatus: student.status,
    toStatus: to,
    effectiveDate: o.effectiveDate ?? o.now.toISOString().slice(0, 10),
    reason: o.reason ?? null,
    details: o.details ?? null,
  });
  await recordChange(tx, actor, student.tenantId, {
    action: `STUDENT_${o.command.toUpperCase()}`,
    entityType: 'student',
    entityId: student.id,
    event: 'student.status_changed',
    before: { status: student.status },
    after: { status: to },
    reason: o.reason ?? null,
    payload: { from_status: student.status, to_status: to, command: o.command },
  });
  student.status = to;
  student.version += 1;
}
