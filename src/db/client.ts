import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema/index.js';

export type Database = MySql2Database<typeof schema>;
/** A transaction handle has the same query API as the database. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything that can run queries: the pool-backed db or an open transaction. */
export type Executor = Database | Tx;

export function createDatabase(url: string, opts: { connectionLimit?: number } = {}) {
  const pool = mysql.createPool({
    uri: url,
    connectionLimit: opts.connectionLimit ?? 10,
    timezone: 'Z', // store and read all DATETIMEs as UTC
    dateStrings: false,
    supportBigNumbers: true,
  });
  const db = drizzle(pool, { schema, mode: 'default' });
  return { db, pool };
}

export { schema };
