export const cacheKeys = {
    tenantEntitlementsNamespace: (tenantId) => `tenant:${tenantId}:entitlements`,
    tenantEntitlements: (tenantId, version) => `tenant:${tenantId}:entitlements:${version}`,
    tenantAuthzNamespace: (tenantId) => tenantId ? `tenant:${tenantId}:authz` : 'platform:authz',
    membershipPrincipal: (membershipId, authzVersion, systemVersion) => 
    // `s2`: grants shape after the central scope policy (D55); bump when the policy changes.
    `membership:${membershipId}:principal:s2:${authzVersion}:${systemVersion}`,
    systemRolesNamespace: 'system:roles',
};
export class RedisCache {
    redis;
    log;
    constructor(redis, log) {
        this.redis = redis;
        this.log = log;
    }
    async remember(key, ttlSeconds, load) {
        if (ttlSeconds <= 0)
            return load();
        try {
            const hit = await this.redis.get(key);
            if (hit !== null)
                return JSON.parse(hit);
        }
        catch (err) {
            this.log.warn({ err, key }, 'cache read failed; using source of truth');
            return load();
        }
        const value = await load();
        try {
            await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
        }
        catch (err) {
            this.log.warn({ err, key }, 'cache write failed');
        }
        return value;
    }
    async delete(...keys) {
        if (keys.length === 0)
            return;
        try {
            await this.redis.del(...keys);
        }
        catch (err) {
            this.log.warn({ err, keys }, 'cache delete failed');
        }
    }
    async bump(namespace) {
        try {
            await this.redis.incr(`ver:${namespace}`);
        }
        catch (err) {
            this.log.warn({ err, namespace }, 'cache version bump failed');
        }
    }
    async version(namespace) {
        try {
            return (await this.redis.get(`ver:${namespace}`)) ?? '0';
        }
        catch {
            // Unique value = guaranteed cache miss while Redis is unhealthy.
            return `nocache-${Date.now()}-${Math.random()}`;
        }
    }
}
/** No-op cache (always loads). Useful for scripts. */
export const noCache = {
    remember: (_k, _t, load) => load(),
    delete: async () => { },
    bump: async () => { },
    version: async () => `nocache-${Date.now()}`,
};
