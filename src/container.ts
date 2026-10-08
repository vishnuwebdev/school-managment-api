import type { Pool } from 'mysql2/promise';
import type { Redis } from 'ioredis';
import type { Env } from './config/env.js';
import type { Database } from './db/client.js';
import type { Cache } from './infrastructure/cache.js';
import type { FileStorage } from './infrastructure/storage/storage.js';
import type { Mailer } from './infrastructure/mail/mailer.js';
import type { Logger } from './shared/logger.js';
import type { Clock } from './shared/time.js';

/**
 * Explicit dependency container. Services receive what they need through this
 * object instead of importing singletons, which keeps them testable.
 */
export interface Deps {
  env: Env;
  db: Database;
  pool: Pool;
  redis: Redis | null;
  cache: Cache;
  mailer: Mailer;
  storage: FileStorage;
  log: Logger;
  clock: Clock;
}
