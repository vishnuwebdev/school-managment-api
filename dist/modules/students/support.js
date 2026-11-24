import { assertWithinPlanLimit } from '../entitlements/plan-limits.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { enrollments, numberSequences, OPEN_ENROLLMENT_STATUSES, studentHistory, students, } from '../../db/schema/index.js';
import { recordChange } from '../../platform/record.js';
import { NotFoundError } from '../../shared/errors.js';
import { hasTenantWideScope, scopesFor } from '../access/authorization.service.js';
const OPEN = [...OPEN_ENROLLMENT_STATUSES];
/** Escape LIKE wildcards so a search for "50%" is literal. */
export const likeOf = (s) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
/**
 * Next business number for a school: `PREFIX-YYYY-00001`. The counter row is
 * incremented atomically inside the caller's transaction, so concurrent
 * requests can never receive the same number.
 */
export async function nextNumber(tx, tenantId, kind, now) {
    const year = now.getUTCFullYear();
    const key = `${kind}:${year}`;
    await tx
        .insert(numberSequences)
        .values({ tenantId, sequenceKey: key, lastValue: 0 })
        .onDuplicateKeyUpdate({ set: { lastValue: sql `${numberSequences.lastValue}` } });
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
/** Domain history row (readable timeline). The audit log remains the security record. */
export async function addHistory(tx, actor, tenantId, studentId, e) {
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
export function studentScope(principal, permission) {
    if (hasTenantWideScope(principal, permission))
        return undefined;
    const grants = scopesFor(principal, permission);
    const sectionIds = grants.flatMap((g) => g.type === 'ASSIGNED_SECTION' ? (g.ref?.section_ids ?? []) : []);
    const classIds = grants.flatMap((g) => g.type === 'ASSIGNED_CLASS' ? (g.ref?.class_ids ?? []) : []);
    const placement = [];
    if (sectionIds.length)
        placement.push(inArray(enrollments.sectionId, sectionIds));
    if (classIds.length)
        placement.push(inArray(enrollments.classId, classIds));
    if (placement.length === 0)
        return sql `1 = 0`; // scope type we cannot resolve: deny
    return sql `exists (select 1 from ${enrollments} where ${enrollments.tenantId} = ${students.tenantId} and ${enrollments.studentId} = ${students.id} and ${inArray(enrollments.status, OPEN)} and (${sql.join(placement, sql ` or `)}))`;
}
/**
 * Load a student the principal may access, or 404. Another school's id, or a
 * student outside the actor's scope, is indistinguishable from a missing one.
 */
export async function loadStudent(ex, tenantId, studentId, principal, permission, opts = {}) {
    const scope = studentScope(principal, permission);
    const q = ex
        .select()
        .from(students)
        .where(and(eq(students.id, studentId), eq(students.tenantId, tenantId), scope));
    const [row] = await (opts.lock ? q.for('update') : q);
    if (!row)
        throw new NotFoundError('Student');
    return row;
}
export const fullName = (s) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');
const COUNTED = new Set(['ADMITTED', 'ACTIVE']);
/**
 * The single place a student's lifecycle status changes. Writes the new
 * status, the history row, the audit row and the outbox event together, using
 * the caller's transaction. Callers have already validated the transition.
 */
export async function setStudentStatus(tx, actor, student, to, o) {
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
