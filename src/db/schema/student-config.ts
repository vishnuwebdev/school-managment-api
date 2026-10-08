import { boolean, int, mysqlEnum, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { createdAt, id, ref, updatedAt } from './_columns.js';
import { ADMISSION_NUMBER_MODE } from './enums.js';
import { tenants } from './tenancy.js';

/** Houses a school groups its students into (Red, Blue, …). */
export const studentHouses = mysqlTable(
  'student_houses',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: varchar('name', { length: 64 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: int('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('student_houses_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('student_houses_tenant_name_uq').on(t.tenantId, t.name),
  ],
);

/** One row per school: how admission numbers are produced. A missing row means AUTO. */
export const studentSettings = mysqlTable('student_settings', {
  tenantId: ref('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  admissionNumberMode: mysqlEnum('admission_number_mode', ADMISSION_NUMBER_MODE)
    .notNull()
    .default('AUTO'),
  updatedAt: updatedAt(),
});
