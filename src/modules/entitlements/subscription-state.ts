import type { SubscriptionStatus } from '../../db/schema/index.js';
import { addDays } from '../../shared/time.js';

export interface SubscriptionLike {
  id: string;
  status: SubscriptionStatus;
  startsAt: Date;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date;
  cancelledAt: Date | null;
  endedAt: Date | null;
}

/**
 * FULL    – operational features available (TRIAL / ACTIVE / PAST_DUE in period).
 * GRACE   – expired less than `graceDays` ago: admins can sign in to renew; only core features.
 * LOCKED  – no valid subscription and grace exhausted: members cannot enter the school.
 *           Data is preserved.
 */
export type AccessMode = 'FULL' | 'GRACE' | 'LOCKED';

export interface EffectiveSubscription {
  subscriptionId: string | null;
  /** Status after applying dates (e.g. a TRIAL past its end date is EXPIRED). */
  effectiveStatus: SubscriptionStatus | 'NONE';
  accessMode: AccessMode;
  expiredAt: Date | null;
  graceEndsAt: Date | null;
}

/** Pure function of the stored subscription and the clock. */
export function effectiveSubscription(
  sub: SubscriptionLike | null,
  now: Date,
  graceDays: number,
): EffectiveSubscription {
  if (!sub || sub.status === 'PENDING' || sub.startsAt > now) {
    return {
      subscriptionId: sub?.id ?? null,
      effectiveStatus: 'NONE',
      accessMode: 'LOCKED',
      expiredAt: null,
      graceEndsAt: null,
    };
  }

  let expiredAt: Date | null = null;
  let status: SubscriptionStatus = sub.status;

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
export function currentSubscription<T extends SubscriptionLike>(subs: T[], now: Date): T | null {
  const candidates = subs.filter((s) => s.status !== 'PENDING' && s.startsAt <= now);
  candidates.sort(
    (a, b) => b.startsAt.getTime() - a.startsAt.getTime() || b.id.localeCompare(a.id),
  );
  return candidates[0] ?? null;
}
