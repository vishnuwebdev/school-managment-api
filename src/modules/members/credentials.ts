import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import { invitations, memberships, users, userSessions } from '../../db/schema/index.js';
import { recordAudit } from '../../platform/audit.js';
import type { Actor } from '../../platform/context.js';
import { publishEvent } from '../../platform/outbox.js';
import { BusinessRuleError } from '../../shared/errors.js';
import { deletePin } from '../identity/app-pin.js';

/**
 * A school may set the password only of an account that is used for that
 * school alone. Accounts are shared across schools (one user, many
 * memberships), so changing the password of someone who also works elsewhere,
 * or at the platform, would take over their other access.
 */
export async function assertAccountManagedBy(tx: Executor, userId: string, tenantId: string) {
  const elsewhere = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, userId),
        ne(memberships.status, 'REVOKED'),
        ne(memberships.tenantKey, tenantId),
      ),
    )
    .limit(1);
  if (elsewhere.length)
    throw new BusinessRuleError(
      'OPERATION_NOT_ALLOWED',
      'This email already signs in to another school. Only its owner can change the password ' +
        '(Forgot password). Send an invitation instead.',
    );
}

/**
 * Give a school login a password chosen by an admin, in the caller's
 * transaction: a pending invitation is accepted on the person's behalf (the
 * emailed link stops working), the account becomes active, every session of
 * the account ends and the app PIN is cleared. The caller has already checked
 * that the admin may manage this login.
 */
export async function setPasswordByAdmin(
  deps: Deps,
  tx: Executor,
  input: { tenantId: string; membershipId: string; passwordHash: string; reason: string },
  actor: Actor,
) {
  const [m] = await tx
    .select({ m: memberships, u: users })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.id, input.membershipId), eq(memberships.tenantId, input.tenantId)))
    .for('update');
  if (!m || m.m.status === 'REVOKED')
    throw new BusinessRuleError('INVALID_STATE', 'This login has been removed');
  if (m.u.status === 'SUSPENDED' || m.u.status === 'DEACTIVATED')
    throw new BusinessRuleError('INVALID_STATE', 'This account is disabled');
  await assertAccountManagedBy(tx, m.u.id, input.tenantId);

  const now = deps.clock.now();
  const activated = m.m.status === 'INVITED';
  if (activated) {
    await tx
      .update(memberships)
      .set({ status: 'ACTIVE', joinedAt: now })
      .where(eq(memberships.id, input.membershipId));
    await tx
      .update(invitations)
      .set({ status: 'REVOKED' })
      .where(
        and(
          eq(invitations.membershipId, input.membershipId),
          inArray(invitations.status, ['PENDING', 'SENT']),
        ),
      );
  }
  await tx
    .update(users)
    .set({
      passwordHash: input.passwordHash,
      passwordChangedAt: now,
      status: 'ACTIVE',
      failedLoginCount: 0,
      lockedUntil: null,
    })
    .where(eq(users.id, m.u.id));
  // Reported to apps as SIGNED_OUT_ELSEWHERE, like a password reset.
  await tx
    .update(userSessions)
    .set({ revokedAt: now, revokedReason: 'PASSWORD_RESET' })
    .where(and(eq(userSessions.userId, m.u.id), isNull(userSessions.revokedAt)));
  await deletePin(tx, input.tenantId, input.membershipId);

  await recordAudit(tx, actor, {
    tenantId: input.tenantId,
    action: 'MEMBER_PASSWORD_SET',
    entityType: 'membership',
    entityId: input.membershipId,
    before: { status: m.m.status, had_password: m.u.passwordHash !== null },
    after: { status: 'ACTIVE' },
    reason: input.reason,
  });
  if (activated)
    await publishEvent(tx, actor, {
      tenantId: input.tenantId,
      eventType: 'membership.activated',
      aggregateType: 'membership',
      aggregateId: input.membershipId,
      payload: { membership_id: input.membershipId, user_id: m.u.id },
    });
  return { activated };
}
