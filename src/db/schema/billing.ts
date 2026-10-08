import {
  bigint,
  char,
  index,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt } from './_columns.js';
import { BILLING_PAYMENT_METHOD, BILLING_PAYMENT_STATUS, INVOICE_STATUS } from './enums.js';
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
