import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema/index.js';
export function createDatabase(url, opts = {}) {
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
