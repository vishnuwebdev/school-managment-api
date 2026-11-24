import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { invitations, memberships, users, userSessions } from '../../db/schema/index.js';
import { recordAudit } from '../../platform/audit.js';
import { publishEvent } from '../../platform/outbox.js';
import { BusinessRuleError } from '../../shared/errors.js';
import { deletePin } from '../identity/app-pin.js';
import { assertLoginPhoneFree } from '../identity/login-phone.js';
/** Memberships are keyed by school id, or 'PLATFORM' for platform staff (tenantId null). */
const keyOf = (tenantId) => tenantId ?? 'PLATFORM';
/**
 * A school (or the platform team, tenantId null) may set the password or sign-in mobile only of
 * an account that is used there alone. Accounts are shared (one user, many memberships), so
 * changing the credentials of someone who also works at another school, or at the platform,
 * would take over their other access.
 */
export async function assertAccountManagedBy(tx, userId, tenantId) {
    const elsewhere = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), ne(memberships.status, 'REVOKED'), ne(memberships.tenantKey, keyOf(tenantId))))
        .limit(1);
    if (elsewhere.length)
        throw new BusinessRuleError('OPERATION_NOT_ALLOWED', tenantId
            ? 'This email or mobile number already signs in to another school. Only its owner can ' +
                'change the password. Send an invitation by email instead.'
            : 'This email or mobile number also signs in to a school. Only its owner can change the ' +
                'password. Send an invitation by email instead.');
}
/**
 * Give a school login (or a platform login, tenantId null) a password chosen by an admin, in the caller's
 * transaction: a pending invitation is accepted on the person's behalf (the
 * emailed link stops working), the account becomes active, every session of
 * the account ends and the app PIN is cleared. The caller has already checked
 * that the admin may manage this login.
 */
export async function setPasswordByAdmin(deps, tx, input, actor) {
    const [m] = await tx
        .select({ m: memberships, u: users })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.id, input.membershipId), eq(memberships.tenantKey, keyOf(input.tenantId))))
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
            .where(and(eq(invitations.membershipId, input.membershipId), inArray(invitations.status, ['PENDING', 'SENT'])));
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
    // App PINs exist only for school logins.
    if (input.tenantId)
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
/**
 * Change (or remove, with null) the mobile number a school (or platform) login signs in with, in the caller's
 * transaction. The number must be free; a login keeps at least one of email and mobile.
 */
export async function setLoginPhoneByAdmin(tx, input, actor) {
    const [m] = await tx
        .select({ m: memberships, u: users })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.id, input.membershipId), eq(memberships.tenantKey, keyOf(input.tenantId))))
        .for('update');
    if (!m || m.m.status === 'REVOKED')
        throw new BusinessRuleError('INVALID_STATE', 'This login has been removed');
    await assertAccountManagedBy(tx, m.u.id, input.tenantId);
    if (!input.loginPhone && !m.u.email)
        throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'This login has no email, so it needs a mobile number to sign in');
    if (input.loginPhone)
        await assertLoginPhoneFree(tx, input.loginPhone, m.u.id);
    await tx.update(users).set({ loginPhone: input.loginPhone }).where(eq(users.id, m.u.id));
    await recordAudit(tx, actor, {
        tenantId: input.tenantId,
        action: 'MEMBER_LOGIN_PHONE_CHANGED',
        entityType: 'membership',
        entityId: input.membershipId,
        before: { login_phone: m.u.loginPhone },
        after: { login_phone: input.loginPhone },
    });
}
