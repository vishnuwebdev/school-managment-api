import { loadEnv, type Env } from './config/env.js';
import type { Deps } from './container.js';
import { createDatabase } from './db/client.js';
import { RedisCache, noCache } from './infrastructure/cache.js';
import { ConsoleMailer, MemoryMailer, type Mailer } from './infrastructure/mail/mailer.js';
import type { FileStorage } from './infrastructure/storage/storage.js';
import { createStorage } from './infrastructure/storage/storage.js';
import { createRedis } from './infrastructure/redis.js';
import { createLogger } from './shared/logger.js';
import { systemClock, type Clock } from './shared/time.js';

export function createDeps(
  overrides: { env?: Env; mailer?: Mailer; clock?: Clock; storage?: FileStorage } = {},
): Deps {
  const env = overrides.env ?? loadEnv();
  const log = createLogger(env.LOG_LEVEL, env.NODE_ENV === 'development');
  const { db, pool } = createDatabase(env.DATABASE_URL, {
    connectionLimit: env.DATABASE_POOL_SIZE,
  });
  // Redis is optional: without REDIS_URL there is no cache and no queue.
  const redis = env.REDIS_URL ? createRedis(env.REDIS_URL) : null;
  redis?.on('error', (err) => log.warn({ err }, 'redis error'));
  if (!redis) log.info('REDIS_URL not set: running without cache; outbox events are processed in-process');
  const mailer =
    overrides.mailer ??
    (env.MAIL_DRIVER === 'memory'
      ? new MemoryMailer()
      : new ConsoleMailer(log, env.MAIL_FROM, env.NODE_ENV === 'development'));
  return {
    env,
    db,
    pool,
    redis,
    cache: redis && env.CACHE_TTL_SECONDS > 0 ? new RedisCache(redis, log) : noCache,
    mailer,
    storage: overrides.storage ?? createStorage(env),
    log,
    clock: overrides.clock ?? systemClock,
  };
}

export async function closeDeps(deps: Deps) {
  await Promise.allSettled([deps.pool.end(), deps.redis?.quit()]);
}
