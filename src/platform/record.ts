import type { Executor } from '../db/client.js';
import { recordAudit } from './audit.js';
import type { Actor } from './context.js';
import { publishEvent } from './outbox.js';

export interface Change {
  /** Audit action, e.g. STUDENT_CREATED. */
  action: string;
  /** Aggregate type, e.g. `student`. Used for the audit entity and the event aggregate. */
  entityType: string;
  entityId: string;
  /** Outbox event type, e.g. `student.created`. Omit for audit-only changes. */
  event?: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  /** Extra event payload. Never put secrets or full personal data here — ids and changes only. */
  payload?: Record<string, unknown>;
}

/**
 * The rule every business change follows: the audit row and the outbox event
 * are written with the SAME executor (transaction) as the change itself.
 */
export async function recordChange(
  executor: Executor,
  actor: Actor,
  tenantId: string,
  c: Change,
): Promise<void> {
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
