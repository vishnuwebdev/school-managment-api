import type { Redis } from 'ioredis';
import type { Logger } from '../shared/logger.js';

/**
 * Tenant-aware cache. Keys are always namespaced (`tenant:{id}:...`) so a
 * cached value can never cross a tenant boundary. The cache is an optimisation:
 * if Redis is unavailable we fall through to the source of truth.
 */
export interface Cache {
  remember<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T>;
  delete(...keys: string[]): Promise<void>;
  /** Increment a namespace version, invalidating every key built from it. */
  bump(namespace: string): Promise<void>;
  version(namespace: string): Promise<string>;
}

export const cacheKeys = {
  tenantEntitlementsNamespace: (tenantId: string) => `tenant:${tenantId}:entitlements`,
  tenantEntitlements: (tenantId: string, version: string) =>
    `tenant:${tenantId}:entitlements:${version}`,
  tenantAuthzNamespace: (tenantId: string | null) =>
    tenantId ? `tenant:${tenantId}:authz` : 'platform:authz',
  membershipPrincipal: (membershipId: string, authzVersion: string, systemVersion: string) =>
    `membership:${membershipId}:principal:${authzVersion}:${systemVersion}`,
  systemRolesNamespace: 'system:roles',
};

export class RedisCache implements Cache {
  constructor(
    private readonly redis: Redis,
    private readonly log: Logger,
  ) {}

  async remember<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    if (ttlSeconds <= 0) return load();
    try {
      const hit = await this.redis.get(key);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch (err) {
      this.log.warn({ err, key }, 'cache read failed; using source of truth');
      return load();
    }
    const value = await load();
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.log.warn({ err, key }, 'cache write failed');
    }
    return value;
  }

  async delete(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.redis.del(...keys);
    } catch (err) {
      this.log.warn({ err, keys }, 'cache delete failed');
    }
  }

  async bump(namespace: string): Promise<void> {
    try {
      await this.redis.incr(`ver:${namespace}`);
    } catch (err) {
      this.log.warn({ err, namespace }, 'cache version bump failed');
    }
  }

  async version(namespace: string): Promise<string> {
    try {
      return (await this.redis.get(`ver:${namespace}`)) ?? '0';
    } catch {
      // Unique value = guaranteed cache miss while Redis is unhealthy.
      return `nocache-${Date.now()}-${Math.random()}`;
    }
  }
}

/** No-op cache (always loads). Useful for scripts. */
export const noCache: Cache = {
  remember: (_k, _t, load) => load(),
  delete: async () => {},
  bump: async () => {},
  version: async () => `nocache-${Date.now()}`,
};
