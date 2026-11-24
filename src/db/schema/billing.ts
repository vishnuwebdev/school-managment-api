import {
  bigint,
  char,
  date,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt } from './_columns.js';
import {
  BILLING_PAYMENT_METHOD,
  BILLING_PAYMENT_STATUS,
  INVOICE_KIND,
  INVOICE_STATUS,
} from './enums.js';
import { subscriptions } from './commercial.js';
import { tenants } from './tenancy.js';

/** Platform-wide running counters for invoice and receipt numbers. */
export const billingSequences = mysqlTable('billing_sequences', {
  sequenceKey: varchar('sequence_key', { length: 64 }).primaryKey(),
  lastValue: bigint('last_value', { mode: 'number' }).notNull().default(0),
  updatedAt: updatedAt(),
});

/**
 * What the platform bills a school for its subscription. Amounts are minor
 * units. `paidMinor` is kept equal to the sum of RECEIVED payments.
 */
export const subscriptionInvoices = mysqlTable(
  'subscription_invoices',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    subscriptionId: ref('subscription_id').references(() => subscriptions.id),
    invoiceNumber: varchar('invoice_number', { length: 32 }).notNull(),
    kind: mysqlEnum('kind', INVOICE_KIND).notNull().default('SUBSCRIPTION'),
    /** SESSION_FEE only: the Indian financial year billed, e.g. `2026-27` (1 Apr – 31 Mar). */
    session: varchar('session', { length: 7 }),
    status: mysqlEnum('status', INVOICE_STATUS).notNull().default('OPEN'),
    currency: char('currency', { length: 3 }).notNull(),
    description: varchar('description', { length: 300 }).notNull(),
    /** Plan name at the time of sale, so history survives later renames. */
    planName: varchar('plan_name', { length: 120 }),
    periodStart: dt('period_start'),
    periodEnd: dt('period_end'),
    issuedAt: dt('issued_at').notNull(),
    dueAt: dt('due_at').notNull(),
    subtotalMinor: bigint('subtotal_minor', { mode: 'number' }).notNull(),
    discountMinor: bigint('discount_minor', { mode: 'number' }).notNull().default(0),
    discountReason: varchar('discount_reason', { length: 300 }),
    totalMinor: bigint('total_minor', { mode: 'number' }).notNull(),
    paidMinor: bigint('paid_minor', { mode: 'number' }).notNull().default(0),
    paidAt: dt('paid_at'),
    voidedAt: dt('voided_at'),
    voidReason: varchar('void_reason', { length: 500 }),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('subscription_invoices_number_uq').on(t.invoiceNumber),
    index('subscription_invoices_tenant_idx').on(t.tenantId, t.issuedAt),
    index('subscription_invoices_subscription_idx').on(t.subscriptionId),
    index('subscription_invoices_session_idx').on(t.kind, t.session),
  ],
);

/** Money received outside the platform (cash, bank transfer, cheque) and recorded by the super admin. */
export const subscriptionPayments = mysqlTable(
  'subscription_payments',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    invoiceId: ref('invoice_id')
      .notNull()
      .references(() => subscriptionInvoices.id),
    receiptNumber: varchar('receipt_number', { length: 32 }).notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    method: mysqlEnum('method', BILLING_PAYMENT_METHOD).notNull(),
    reference: varchar('reference', { length: 100 }),
    receivedAt: dt('received_at').notNull(),
    status: mysqlEnum('status', BILLING_PAYMENT_STATUS).notNull().default('RECEIVED'),
    notes: varchar('notes', { length: 500 }),
    reversedAt: dt('reversed_at'),
    reverseReason: varchar('reverse_reason', { length: 500 }),
    recordedBy: ref('recorded_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('subscription_payments_receipt_uq').on(t.receiptNumber),
    index('subscription_payments_invoice_idx').on(t.invoiceId),
    index('subscription_payments_tenant_idx').on(t.tenantId, t.receivedAt),
  ],
);

/**
 * The agreed instalments of a SESSION_FEE invoice (they add up to its total). What has been
 * paid towards each one is worked out from the payments, oldest first, so it is never stored.
 */
export const billingInstalments = mysqlTable(
  'billing_instalments',
  {
    id: id(),
    invoiceId: ref('invoice_id')
      .notNull()
      .references(() => subscriptionInvoices.id),
    seq: int('seq').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('billing_instalments_invoice_seq_uq').on(t.invoiceId, t.seq)],
);

/** Platform-wide settings the Super Admin can change (e.g. the default yearly school fee). */
export const platformSettings = mysqlTable('platform_settings', {
  settingKey: varchar('setting_key', { length: 100 }).primaryKey(),
  value: json('value').notNull(),
  updatedBy: ref('updated_by'),
  updatedAt: updatedAt(),
});
