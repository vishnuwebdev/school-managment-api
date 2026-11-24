import { auditLogs } from '../db/schema/index.js';
/**
 * Append-only audit trail. Always written through the caller's executor so the
 * audit row commits (or rolls back) with the business change it describes.
 */
export async function recordAudit(executor, actor, entry) {
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
function sanitize(value) {
    if (value === null || value === undefined)
        return null;
    if (value instanceof Date)
        return value.toISOString();
    if (Array.isArray(value))
        return value.map(sanitize);
    if (typeof value === 'bigint')
        return value.toString();
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (!SECRET_KEYS.has(k))
                out[k] = sanitize(v);
        }
        return out;
    }
    return value;
}
