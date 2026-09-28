import { env } from '../config/env.js';
import { createMemoryAdapter } from './adapters/memoryAdapter.js';
import { createMysqlAdapter } from './adapters/mysqlAdapter.js';
import { createMongoAdapter } from './adapters/mongoAdapter.js';

// Single seam between the whole app and "which database are we using".
// Every module imports `db` from here and never imports an adapter file
// directly, so DATABASE_DRIVER is the only thing that changes behavior.
function build() {
  switch (env.databaseDriver) {
    case 'mysql':
      if (!env.databaseUrl) throw new Error('DATABASE_URL is required when DATABASE_DRIVER=mysql');
      return createMysqlAdapter(env.databaseUrl);
    case 'mongo':
      if (!env.databaseUrl) throw new Error('DATABASE_URL is required when DATABASE_DRIVER=mongo');
      return createMongoAdapter(env.databaseUrl);
    case 'memory':
      return createMemoryAdapter();
    default:
      throw new Error(`Unknown DATABASE_DRIVER "${env.databaseDriver}" — expected memory, mysql or mongo`);
  }
}

export const db = build();
