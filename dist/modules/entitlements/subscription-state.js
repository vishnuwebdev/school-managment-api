import { addDays } from '../../shared/time.js';
/** Pure function of the stored subscription and the clock. */
export function effectiveSubscription(sub, now, graceDays) {
    if (!sub || sub.status === 'PENDING' || sub.startsAt > now) {
        return {
            subscriptionId: sub?.id ?? null,
            effectiveStatus: 'NONE',
            accessMode: 'LOCKED',
            expiredAt: null,
            graceEndsAt: null,
        };
    }
    let expiredAt = null;
    let status = sub.status;
    switch (sub.status) {
        case 'TRIAL': {
            const end = sub.trialEndsAt ?? sub.currentPeriodEnd;
            if (now >= end) {
                status = 'EXPIRED';
                expiredAt = end;
            }
            break;
        }
        case 'ACTIVE':
        case 'PAST_DUE':
            if (now >= sub.currentPeriodEnd) {
                status = 'EXPIRED';
                expiredAt = sub.currentPeriodEnd;
            }
            break;
        case 'CANCELLED': {
            // Cancellation takes effect at the end of the paid period (or immediately if ended).
            const end = sub.endedAt ?? sub.currentPeriodEnd;
            expiredAt = now >= end ? end : null;
            break;
        }
        case 'SUPERSEDED':
        case 'EXPIRED':
            expiredAt = sub.endedAt ?? sub.currentPeriodEnd;
            break;
    }
    if (!expiredAt) {
        return {
            subscriptionId: sub.id,
            effectiveStatus: status,
            accessMode: 'FULL',
            expiredAt: null,
            graceEndsAt: null,
        };
    }
    const graceEndsAt = addDays(expiredAt, graceDays);
    return {
        subscriptionId: sub.id,
        effectiveStatus: status,
        accessMode: now < graceEndsAt ? 'GRACE' : 'LOCKED',
        expiredAt,
        graceEndsAt,
    };
}
/** The subscription that governs access: the most recently started, non-pending one. */
export function currentSubscription(subs, now) {
    const candidates = subs.filter((s) => s.status !== 'PENDING' && s.startsAt <= now);
    candidates.sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime() || b.id.localeCompare(a.id));
    return candidates[0] ?? null;
}
