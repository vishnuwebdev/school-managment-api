import { sql } from 'drizzle-orm';
import { char, datetime, int } from 'drizzle-orm/mysql-core';
import { uuidv7 } from 'uuidv7';

/** UUIDv7 primary key, CHAR(36), generated in the application. */
export const id = () =>
  char('id', { length: 36 })
    .primaryKey()
    .$defaultFn(() => uuidv7());

/** Foreign-key style reference to another UUID column. */
export const ref = (name: string) => char(name, { length: 36 });

/** UTC DATETIME(3). */
export const dt = (name: string) => datetime(name, { mode: 'date', fsp: 3 });

export const createdAt = () =>
  dt('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`);

export const updatedAt = () =>
  dt('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`)
    .$onUpdateFn(() => new Date());

/** Optimistic-concurrency counter for admin-editable records. */
export const version = () => int('version').notNull().default(1);
