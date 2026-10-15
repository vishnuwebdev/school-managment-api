import { describe, expect, it } from 'vitest';
import { sessionEndCode } from '../../src/modules/identity/session-end.js';

describe('sessionEndCode', () => {
  it('reports expiry and inactivity as SESSION_EXPIRED', () => {
    expect(sessionEndCode(null, true)).toBe('SESSION_EXPIRED');
    expect(sessionEndCode('IDLE_TIMEOUT', true)).toBe('SESSION_EXPIRED');
  });

  it('reports sign-outs from elsewhere', () => {
    for (const r of ['USER_REVOKED', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'REFRESH_REUSE'])
      expect(sessionEndCode(r, false)).toBe('SIGNED_OUT_ELSEWHERE');
  });

  it('reports removed access as SESSION_REVOKED', () => {
    for (const r of ['ACCESS_REVOKED', 'MEMBERSHIP_SUSPENDED', 'MEMBERSHIP_REVOKED'])
      expect(sessionEndCode(r, false)).toBe('SESSION_REVOKED');
  });

  it('keeps INVALID_TOKEN for rotation, logout and school switch', () => {
    for (const r of ['ROTATED', 'LOGOUT', 'CONTEXT_SWITCH'])
      expect(sessionEndCode(r, false)).toBe('INVALID_TOKEN');
    expect(sessionEndCode(null, false)).toBe('INVALID_TOKEN');
  });
});
