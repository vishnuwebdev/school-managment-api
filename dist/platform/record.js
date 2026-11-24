import { recordAudit } from './audit.js';
import { publishEvent } from './outbox.js';
/**
 * The rule every business change follows: the audit row and the outbox event
 * are written with the SAME executor (transaction) as the change itself.
 */
export async function recordChange(executor, actor, tenantId, c) {
    await recordAudit(executor, actor, {
        tenantId,
        action: c.action,
        entityType: c.entityType,
        entityId: c.entityId,
        before: c.before,
        after: c.after,
        reason: c.reason,
    });
    if (c.event) {
        await publishEvent(executor, actor, {
            tenantId,
            eventType: c.event,
            aggregateType: c.entityType,
            aggregateId: c.entityId,
            payload: { [`${c.entityType}_id`]: c.entityId, ...c.payload },
        });
    }
}
