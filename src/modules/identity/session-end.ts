import { AuthenticationError } from '../../shared/errors.js';

/**
 * Why a session can no longer be used, as the 401 code clients show to the
 * person (the teacher app's Session ended screen):
 *
 * - SESSION_EXPIRED      – too long without use, or past its absolute expiry.
 * - SIGNED_OUT_ELSEWHERE – signed out from another device, a password change
 *                          or reset, or refresh-token reuse.
 * - SESSION_REVOKED      – the school removed or suspended access.
 * - INVALID_TOKEN        – anything else (rotation, logout, school switch); a
 *                          client simply refreshes or signs in again.
 */
export type SessionEndCode =
  'SESSION_EXPIRED' | 'SIGNED_OUT_ELSEWHERE' | 'SESSION_REVOKED' | 'INVALID_TOKEN';

const ELSEWHERE = new Set(['USER_REVOKED', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'REFRESH_REUSE']);
const REVOKED = new Set(['ACCESS_REVOKED', 'MEMBERSHIP_SUSPENDED', 'MEMBERSHIP_REVOKED']);

export function sessionEndCode(revokedReason: string | null, expired: boolean): SessionEndCode {
  if (revokedReason === null) return expired ? 'SESSION_EXPIRED' : 'INVALID_TOKEN';
  if (revokedReason === 'IDLE_TIMEOUT') return 'SESSION_EXPIRED';
  if (ELSEWHERE.has(revokedReason)) return 'SIGNED_OUT_ELSEWHERE';
  if (REVOKED.has(revokedReason)) return 'SESSION_REVOKED';
  return 'INVALID_TOKEN';
}

const MESSAGES: Record<SessionEndCode, string> = {
  SESSION_EXPIRED: 'Your session has expired. Sign in again.',
  SIGNED_OUT_ELSEWHERE: 'You were signed out from another device. Sign in again.',
  SESSION_REVOKED: 'Your access to this school was removed. Contact the school office.',
  INVALID_TOKEN: 'The session has ended. Sign in again.',
};

export function sessionEnded(revokedReason: string | null, expired: boolean): AuthenticationError {
  const code = sessionEndCode(revokedReason, expired);
  return new AuthenticationError(code, MESSAGES[code]);
}
