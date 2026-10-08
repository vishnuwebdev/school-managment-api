import { sql } from 'drizzle-orm';
import {
  char,
  check,
  date,
  decimal,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  smallint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt, version } from './_columns.js';
import { schoolPayments } from './fees.js';
import { students } from './students.js';
import { tenants } from './tenancy.js';

/**
 * Bank reconciliation and arrears. Payments reach the school outside the portal, so a recorded
 * payment is only a claim until a bank statement line confirms it; and an unpaid bill has to be
 * chased in a fixed order (reminder, second reminder, letter of demand, handover).
 */

const money = (name: string) => decimal(name, { precision: 14, scale: 2 });

/** UNMATCHED: no candidate. SUGGESTED: a candidate that a person must confirm. MATCHED: tied to a payment. IGNORED: not school money. */
export const BANK_LINE_STATUS = ['UNMATCHED', 'SUGGESTED', 'MATCHED', 'IGNORED'] as const;
export type BankLineStatus = (typeof BANK_LINE_STATUS)[number];

/** How a line was tied to its payment. RECORDED: the payment was created from the line itself. */
export const BANK_MATCH_TYPE = ['REFERENCE_AMOUNT', 'AMOUNT', 'MANUAL', 'RECORDED'] as const;
export type BankMatchType = (typeof BANK_MATCH_TYPE)[number];

export const REMINDER_STAGE = [
  'FIRST_REMINDER',
  'SECOND_REMINDER',
  'LETTER_OF_DEMAND',
  'COLLECTIONS_HANDOVER',
] as const;
export type ReminderStage = (typeof REMINDER_STAGE)[number];

export const PLAN_STATUS = ['ACTIVE', 'COMPLETED', 'BROKEN', 'CANCELLED'] as const;
export type PlanStatus = (typeof PLAN_STATUS)[number];

export const bankStatements = mysqlTable(
  'bank_statements',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    statementFrom: date('statement_from', { mode: 'string' }),
    statementTo: date('statement_to', { mode: 'string' }),
    /** Credit lines read from the file (money in). Debits are skipped. */
    lineCount: int('line_count').notNull().default(0),
    /** Lines skipped because the same line was already imported earlier. */
    duplicateCount: int('duplicate_count').notNull().default(0),
    importedBy: ref('imported_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('bank_statements_tenant_id_uq').on(t.tenantId, t.id),
    index('bank_statements_created_idx').on(t.tenantId, t.createdAt),
  ],
);

export const bankStatementLines = mysqlTable(
  'bank_statement_lines',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    statementId: ref('statement_id').notNull(),
    lineDate: date('line_date', { mode: 'string' }).notNull(),
    description: varchar('description', { length: 300 }).notNull().default(''),
    reference: varchar('reference', { length: 150 }),
    amount: money('amount').notNull(),
    /** SHA-256 of date | amount | reference | description: importing the same line twice is a no-op. */
    lineHash: char('line_hash', { length: 64 }).notNull(),
    status: mysqlEnum('status', BANK_LINE_STATUS).notNull().default('UNMATCHED'),
    matchType: mysqlEnum('match_type', BANK_MATCH_TYPE),
    suggestedPaymentId: ref('suggested_payment_id'),
    paymentId: ref('payment_id'),
    note: varchar('note', { length: 500 }),
    resolvedBy: ref('resolved_by'),
    resolvedAt: dt('resolved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('bank_lines_hash_uq').on(t.tenantId, t.lineHash),
    /** A payment is confirmed by at most one bank line. */
    uniqueIndex('bank_lines_payment_uq').on(t.tenantId, t.paymentId),
    index('bank_lines_statement_idx').on(t.tenantId, t.statementId, t.status),
    index('bank_lines_status_idx').on(t.tenantId, t.status, t.lineDate),
    check('bank_lines_amount_chk', sql`${t.amount} > 0`),
    foreignKey({
      name: 'bank_lines_statement_fk',
      columns: [t.tenantId, t.statementId],
      foreignColumns: [bankStatements.tenantId, bankStatements.id],
    }),
    foreignKey({
      name: 'bank_lines_payment_fk',
      columns: [t.tenantId, t.paymentId],
      foreignColumns: [schoolPayments.tenantId, schoolPayments.id],
    }),
  ],
);

/** One step of the escalation ladder recorded against a learner. Never edited or deleted. */
export const feeReminders = mysqlTable(
  'fee_reminders',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    studentId: ref('student_id').notNull(),
    stage: mysqlEnum('stage', REMINDER_STAGE).notNull(),
    /** What was overdue, and for how long, when the step was recorded. */
    outstandingAmount: money('outstanding_amount').notNull(),
    oldestDueDate: date('oldest_due_date', { mode: 'string' }),
    daysOverdue: int('days_overdue').notNull().default(0),
    note: varchar('note', { length: 500 }),
    /** NULL for the automatic run. */
    createdBy: ref('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('fee_reminders_student_idx').on(t.tenantId, t.studentId, t.createdAt),
    index('fee_reminders_stage_idx').on(t.tenantId, t.stage, t.createdAt),
    foreignKey({
      name: 'fee_reminders_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
  ],
);

/** An agreed way to clear overdue fees in instalments. At most one ACTIVE plan per learner. */
export const feePaymentPlans = mysqlTable(
  'fee_payment_plans',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    studentId: ref('student_id').notNull(),
    status: mysqlEnum('status', PLAN_STATUS).notNull().default('ACTIVE'),
    totalAmount: money('total_amount').notNull(),
    /** The day the plan was agreed. Allocations made after the plan was created count towards the instalments. */
    startDate: date('start_date', { mode: 'string' }).notNull(),
    note: varchar('note', { length: 500 }),
    brokenOn: date('broken_on', { mode: 'string' }),
    closedReason: varchar('closed_reason', { length: 500 }),
    /** Generated: the student id while ACTIVE → one active plan per learner. */
    activeKey: char('active_key', { length: 36 }).generatedAlwaysAs(
      sql`(IF(\`status\` = 'ACTIVE', \`student_id\`, NULL))`,
      { mode: 'virtual' },
    ),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('fee_plans_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('fee_plans_active_uq').on(t.activeKey),
    index('fee_plans_student_idx').on(t.tenantId, t.studentId, t.status),
    check('fee_plans_total_chk', sql`${t.totalAmount} > 0`),
    foreignKey({
      name: 'fee_plans_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
  ],
);

export const feePlanInstalments = mysqlTable(
  'fee_plan_instalments',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    planId: ref('plan_id').notNull(),
    seq: smallint('seq').notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    amount: money('amount').notNull(),
  },
  (t) => [
    uniqueIndex('fee_plan_instalments_seq_uq').on(t.planId, t.seq),
    index('fee_plan_instalments_due_idx').on(t.tenantId, t.dueDate),
    check('fee_plan_instalments_amount_chk', sql`${t.amount} > 0`),
    foreignKey({
      name: 'fee_plan_instalments_plan_fk',
      columns: [t.tenantId, t.planId],
      foreignColumns: [feePaymentPlans.tenantId, feePaymentPlans.id],
    }),
  ],
);
