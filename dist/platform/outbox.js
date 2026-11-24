import { outboxEvents } from '../db/schema/index.js';
/**
 * Transactional outbox: the event row commits atomically with the business
 * change. The worker relays it afterwards (at-least-once), so handlers must be
 * idempotent. Payloads must never contain secrets.
 */
export async function publishEvent(executor, actor, event) {
    const now = new Date();
    const [row] = await executor
        .insert(outboxEvents)
        .values({
        tenantId: event.tenantId !== undefined ? event.tenantId : actor.tenantId,
        eventType: event.eventType,
        schemaVersion: event.schemaVersion ?? 1,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: event.payload,
        actorUserId: actor.userId,
        correlationId: actor.meta?.requestId ?? null,
        availableAt: now,
        occurredAt: now,
    })
        .$returningId();
    return row.id;
}
