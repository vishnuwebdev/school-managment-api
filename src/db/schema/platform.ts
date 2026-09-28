import { sql } from 'drizzle-orm';
import {
  char,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref } from './_columns.js';
import { ACTOR_TYPE, OUTBOX_STATUS } from './enums.js';

/** Append-only. Application code never updates or deletes audit rows. */
export const auditLogs = mysqlTable(
  'audit_logs',
  {
    id: id(),
    tenantId: ref('tenant_id'),
    actorUserId: ref('actor_user_id'),
    actorType: mysqlEnum('actor_type', ACTOR_TYPE).notNull(),
    action: varchar('action', { length: 64 }).notNull(),
    entityType: varchar('entity_type', { length: 64 }).notNull(),
    entityId: varchar('entity_id', { length: 64 }),
    before: json('before'),
    after: json('after'),
    reason: varchar('reason', { length: 500 }),
    requestId: varchar('request_id', { length: 64 }),
    correlationId: varchar('correlation_id', { length: 64 }),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: varchar('user_agent', { length: 500 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_tenant_created_idx').on(t.tenantId, t.createdAt),
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    index('audit_logs_actor_idx').on(t.actorUserId, t.createdAt),
    index('audit_logs_action_idx').on(t.action, t.createdAt),
  ],
);

/** Written in the same transaction as the business change; relayed by the worker. */
export const outboxEvents = mysqlTable(
  'outbox_events',
  {
    id: id(),
    tenantId: ref('tenant_id'),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    schemaVersion: int('schema_version').notNull().default(1),
    aggregateType: varchar('aggregate_type', { length: 64 }).notNull(),
    aggregateId: varchar('aggregate_id', { length: 64 }).notNull(),
    payload: json('payload').$type<Record<string, unknown>>().notNull(),
    actorUserId: ref('actor_user_id'),
    correlationId: varchar('correlation_id', { length: 64 }),
    status: mysqlEnum('status', OUTBOX_STATUS).notNull().default('PENDING'),
    retryCount: int('retry_count').notNull().default(0),
    lastError: text('last_error'),
    availableAt: dt('available_at').notNull(),
    occurredAt: dt('occurred_at').notNull(),
    publishedAt: dt('published_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('outbox_events_status_available_idx').on(t.status, t.availableAt),
    index('outbox_events_tenant_type_idx').on(t.tenantId, t.eventType),
  ],
);

/** Idempotency ledger for event handlers (delivery is at-least-once). */
export const eventConsumptions = mysqlTable(
  'event_consumptions',
  {
    eventId: char('event_id', { length: 36 }).notNull(),
    handler: varchar('handler', { length: 100 }).notNull(),
    processedAt: dt('processed_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [primaryKey({ name: 'event_consumptions_pk', columns: [t.eventId, t.handler] })],
);
