import 'dotenv/config';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { createDatabase } from './client.js';

/** Applies pending SQL migrations from ./drizzle. Safe to run repeatedly. */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const { db, pool } = createDatabase(url);
  await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
  await pool.end();
  console.log('Migrations applied');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
