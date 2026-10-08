import {
  char,
  date,
  foreignKey,
  index,
  mysqlEnum,
  mysqlTable,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt } from './_columns.js';
import { students } from './students.js';
import { tenants } from './tenancy.js';

export const STUDENT_EXIT_KIND = ['WITHDRAWN', 'TRANSFERRED'] as const;

/**
 * Why, when and where a student left. One row per withdrawal or transfer; never
 * deleted, so the details stay readable after the student is archived.
 * `reinstatedAt` is set when the student comes back, closing that exit.
 */
export const studentExits = mysqlTable(
  'student_exits',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    studentId: ref('student_id').notNull(),
    kind: mysqlEnum('kind', STUDENT_EXIT_KIND).notNull(),
    exitDate: date('exit_date', { mode: 'string' }).notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    remarks: varchar('remarks', { length: 1000 }),
    /** Transfers: the school the student is moving to. */
    destinationSchool: varchar('destination_school', { length: 200 }),
    /** Supporting document (a stored file), attached after the exit is recorded. */
    documentFileId: char('document_file_id', { length: 36 }),
    documentName: varchar('document_name', { length: 255 }),
    reinstatedAt: dt('reinstated_at'),
    recordedBy: ref('recorded_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('student_exits_student_idx').on(t.tenantId, t.studentId, t.createdAt),
    index('student_exits_date_idx').on(t.tenantId, t.kind, t.exitDate),
    foreignKey({
      name: 'student_exits_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
  ],
);
