import type { Executor } from '../db/client.js';
import { auditLogs } from '../db/schema/index.js';
import type { Actor } from './context.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  /** Defaults to the actor's tenant. Pass explicitly for platform actions on a tenant. */
  tenantId?: string | null;
}

/**
 * Append-only audit trail. Always written through the caller's executor so the
 * audit row commits (or rolls back) with the business change it describes.
 */
export async function recordAudit(
  executor: Executor,
  actor: Actor,
  entry: AuditEntry,
): Promise<void> {
  await executor.insert(auditLogs).values({
    tenantId: entry.tenantId !== undefined ? entry.tenantId : actor.tenantId,
    actorUserId: actor.userId,
    actorType: actor.actorType,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before === undefined ? null : sanitize(entry.before),
    after: entry.after === undefined ? null : sanitize(entry.after),
    reason: entry.reason ?? null,
    requestId: actor.meta?.requestId ?? null,
    correlationId: actor.meta?.requestId ?? null,
    ipAddress: actor.meta?.ip ?? null,
    userAgent: actor.meta?.userAgent?.slice(0, 500) ?? null,
  });
}

const SECRET_KEYS = new Set([
  'passwordHash',
  'password_hash',
  'password',
  'refreshTokenHash',
  'tokenHash',
  'token_hash',
  'token',
]);

/** Strip secrets and make the value JSON-safe (Dates → ISO strings). */
function sanitize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!SECRET_KEYS.has(k)) out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}
