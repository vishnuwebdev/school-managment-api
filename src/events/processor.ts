import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { Deps } from '../container.js';
import { eventConsumptions, outboxEvents } from '../db/schema/index.js';
import { isDuplicateKeyError } from '../shared/errors.js';
import { addSeconds } from '../shared/time.js';
import { HANDLERS, type OutboxRow } from './handlers.js';

const MAX_RELAY_ATTEMPTS = 10;

/**
 * Run every handler for one event exactly once per (event, handler).
 * Delivery is at-least-once; the consumption ledger makes handlers idempotent.
 */
export async function processEvent(deps: Deps, eventId: string): Promise<void> {
  const [event] = await deps.db.select().from(outboxEvents).where(eq(outboxEvents.id, eventId));
  if (!event) return;
  for (const handler of HANDLERS[event.eventType] ?? []) {
    const [done] = await deps.db
      .select()
      .from(eventConsumptions)
      .where(
        and(eq(eventConsumptions.eventId, event.id), eq(eventConsumptions.handler, handler.name)),
      );
    if (done) continue;
    await handler.handle(event, deps);
    try {
      await deps.db.insert(eventConsumptions).values({ eventId: event.id, handler: handler.name });
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
  }
}

export type Publish = (event: OutboxRow) => Promise<void>;

/**
 * Relay pending outbox rows to the queue. Rows are claimed with
 * FOR UPDATE SKIP LOCKED so several workers can run safely.
 */
export async function relayOutbox(deps: Deps, publish: Publish, batchSize = 50): Promise<number> {
  const now = deps.clock.now();
  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.status, 'PENDING'), lte(outboxEvents.availableAt, now)))
      .orderBy(asc(outboxEvents.occurredAt), asc(outboxEvents.id))
      .limit(batchSize)
      .for('update', { skipLocked: true });
    for (const row of rows) {
      try {
        await publish(row);
        await tx
          .update(outboxEvents)
          .set({ status: 'PUBLISHED', publishedAt: now, lastError: null })
          .where(eq(outboxEvents.id, row.id));
      } catch (err) {
        const attempts = row.retryCount + 1;
        const message = err instanceof Error ? err.message : String(err);
        deps.log.warn(
          { err, eventId: row.id, eventType: row.eventType, attempts },
          'outbox publish failed',
        );
        await tx
          .update(outboxEvents)
          .set({
            retryCount: sql`${outboxEvents.retryCount} + 1`,
            lastError: message.slice(0, 2000),
            status: attempts >= MAX_RELAY_ATTEMPTS ? 'FAILED' : 'PENDING',
            availableAt: addSeconds(now, Math.min(300, 2 ** attempts)),
          })
          .where(eq(outboxEvents.id, row.id));
      }
    }
    return rows.length;
  });
}
