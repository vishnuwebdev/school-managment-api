import { jwtVerify, SignJWT, errors as joseErrors } from 'jose';
import type { Env } from '../../config/env.js';
import { AuthenticationError } from '../../shared/errors.js';

/**
 * Access tokens are short-lived and carry identity only (user, session,
 * membership). Permissions and entitlements are resolved server-side per
 * request, so revocations and plan changes take effect immediately.
 */
export interface AccessClaims {
  sub: string; // user id
  sid: string; // session id
  mid: string; // membership id (tenant or platform context)
}

export class TokenService {
  private readonly key: Uint8Array;

  constructor(private readonly env: Env) {
    this.key = new TextEncoder().encode(env.JWT_SECRET);
  }

  async signAccess(claims: AccessClaims): Promise<{ token: string; expiresIn: number }> {
    const token = await new SignJWT({ sid: claims.sid, mid: claims.mid })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(this.env.JWT_ISSUER)
      .setAudience('api')
      .setIssuedAt()
      .setExpirationTime(`${this.env.JWT_ACCESS_TTL_SECONDS}s`)
      .sign(this.key);
    return { token, expiresIn: this.env.JWT_ACCESS_TTL_SECONDS };
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.env.JWT_ISSUER,
        audience: 'api',
        algorithms: ['HS256'],
      });
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' ||
        typeof payload.mid !== 'string'
      ) {
        throw new AuthenticationError('INVALID_TOKEN', 'The access token is invalid');
      }
      return { sub: payload.sub, sid: payload.sid, mid: payload.mid };
    } catch (err) {
      if (err instanceof AuthenticationError) throw err;
      if (err instanceof joseErrors.JWTExpired)
        throw new AuthenticationError('INVALID_TOKEN', 'The access token has expired');
      throw new AuthenticationError('INVALID_TOKEN', 'The access token is invalid');
    }
  }
}
