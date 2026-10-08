import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { Redis } from 'ioredis';
import mysql from 'mysql2/promise';
import { createDatabase } from '../src/db/client.js';
import { seedCatalog } from '../src/db/seed.js';

/** Fresh schema for every test run: drop, migrate, seed reference data. */
export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'mysql://sms:sms@localhost:3306/sms_test');
  const dbName = url.pathname.slice(1);
  const admin = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await admin.query(
    `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  );
  await admin.end();

  const { db, pool } = createDatabase(url.toString());
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  await seedCatalog(db);
  await pool.end();

  const redis = new Redis(process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15');
  await redis.flushdb();
  await redis.quit();
}
