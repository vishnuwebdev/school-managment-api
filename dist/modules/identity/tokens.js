import { jwtVerify, SignJWT, errors as joseErrors } from 'jose';
import { AuthenticationError } from '../../shared/errors.js';
export class TokenService {
    env;
    key;
    constructor(env) {
        this.env = env;
        this.key = new TextEncoder().encode(env.JWT_SECRET);
    }
    async signAccess(claims) {
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
    async verifyAccess(token) {
        try {
            const { payload } = await jwtVerify(token, this.key, {
                issuer: this.env.JWT_ISSUER,
                audience: 'api',
                algorithms: ['HS256'],
            });
            if (typeof payload.sub !== 'string' ||
                typeof payload.sid !== 'string' ||
                typeof payload.mid !== 'string') {
                throw new AuthenticationError('INVALID_TOKEN', 'The access token is invalid');
            }
            return { sub: payload.sub, sid: payload.sid, mid: payload.mid };
        }
        catch (err) {
            if (err instanceof AuthenticationError)
                throw err;
            if (err instanceof joseErrors.JWTExpired)
                throw new AuthenticationError('INVALID_TOKEN', 'The access token has expired');
            throw new AuthenticationError('INVALID_TOKEN', 'The access token is invalid');
        }
    }
}
