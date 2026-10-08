import { and, count, eq, exists, inArray, ne } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import {
  memberships,
  planVersions,
  roleAssignments,
  roles,
  students,
  subscriptions,
} from '../../db/schema/index.js';
import { BusinessRuleError } from '../../shared/errors.js';
import { currentSubscription } from './subscription-state.js';

export type LimitKind = 'STAFF_USERS' | 'STUDENTS';

const LABEL: Record<LimitKind, string> = {
  STAFF_USERS: 'staff users',
  STUDENTS: 'students',
};

/** Limits of the plan that governs the school (null = unlimited, or no plan). */
export async function loadPlanLimits(tx: Executor, tenantId: string, now: Date) {
  const subs = await tx
    .select({
      id: subscriptions.id,
      status: subscriptions.status,
      startsAt: subscriptions.startsAt,
      trialEndsAt: subscriptions.trialEndsAt,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelledAt: subscriptions.cancelledAt,
      endedAt: subscriptions.endedAt,
      maxStaffUsers: planVersions.maxStaffUsers,
      maxStudents: planVersions.maxStudents,
    })
    .from(subscriptions)
    .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
    .where(eq(subscriptions.tenantId, tenantId));
  const current = currentSubscription(subs, now);
  return {
    maxStaffUsers: current?.maxStaffUsers ?? null,
    maxStudents: current?.maxStudents ?? null,
  };
}

/**
 * Staff users = memberships that are active or invited and hold at least one
 * role other than the parent/guardian portal role. Suspended and removed
 * members free their seat.
 */
export async function countStaffUsers(tx: Executor, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        inArray(memberships.status, ['ACTIVE', 'INVITED']),
        exists(
          tx
            .select({ one: roleAssignments.id })
            .from(roleAssignments)
            .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
            .where(
              and(
                eq(roleAssignments.membershipId, memberships.id),
                eq(roleAssignments.status, 'ACTIVE'),
                ne(roles.code, 'PARENT'),
              ),
            ),
        ),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Students that count against the plan: admitted and active (applicants and leavers do not). */
export async function countStudents(tx: Executor, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(students)
    .where(and(eq(students.tenantId, tenantId), inArray(students.status, ['ADMITTED', 'ACTIVE'])));
  return Number(row?.n ?? 0);
}

/**
 * Refuse to go past the plan's limit. Call inside the transaction that adds the
 * seat, after the usual validation, so the count matches what is being committed.
 */
export async function assertWithinPlanLimit(
  tx: Executor,
  tenantId: string,
  now: Date,
  kind: LimitKind,
  adding = 1,
): Promise<void> {
  const limits = await loadPlanLimits(tx, tenantId, now);
  const limit = kind === 'STAFF_USERS' ? limits.maxStaffUsers : limits.maxStudents;
  if (limit === null) return;
  const used =
    kind === 'STAFF_USERS'
      ? await countStaffUsers(tx, tenantId)
      : await countStudents(tx, tenantId);
  if (used + adding > limit)
    throw new BusinessRuleError(
      'PLAN_LIMIT_REACHED',
      `Your plan allows ${limit} ${LABEL[kind]} and ${used} are in use. Remove some or ask for a larger plan.`,
      { limit_type: kind, limit, used },
    );
}
