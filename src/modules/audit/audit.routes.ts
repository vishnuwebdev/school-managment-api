import { and, count, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Deps } from '../../container.js';
import { auditLogs } from '../../db/schema/index.js';
import { defineRoute } from '../../http/route.js';
import { offsetOf, pageOf, PaginationQuery } from '../../shared/pagination.js';

const Filters = PaginationQuery.omit({ search: true, sort: true }).extend({
  action: z.string().max(64).optional(),
  entity_type: z.string().max(64).optional(),
  entity_id: z.string().max(64).optional(),
  actor_user_id: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

function present(r: typeof auditLogs.$inferSelect) {
  return {
    id: r.id,
    tenant_id: r.tenantId,
    actor_user_id: r.actorUserId,
    actor_type: r.actorType,
    action: r.action,
    entity_type: r.entityType,
    entity_id: r.entityId,
    before: r.before,
    after: r.after,
    reason: r.reason,
    request_id: r.requestId,
    ip_address: r.ipAddress,
    created_at: r.createdAt.toISOString(),
  };
}

/** Read-only access to the append-only audit log. */
export function auditRoutes(deps: Deps) {
  const query = async (base: SQL | undefined, q: z.infer<typeof Filters>) => {
    const conds: (SQL | undefined)[] = [base];
    if (q.action) conds.push(eq(auditLogs.action, q.action));
    if (q.entity_type) conds.push(eq(auditLogs.entityType, q.entity_type));
    if (q.entity_id) conds.push(eq(auditLogs.entityId, q.entity_id));
    if (q.actor_user_id) conds.push(eq(auditLogs.actorUserId, q.actor_user_id));
    if (q.from) conds.push(gte(auditLogs.createdAt, q.from));
    if (q.to) conds.push(lte(auditLogs.createdAt, q.to));
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      deps.db
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(
          q.order === 'asc' ? auditLogs.createdAt : desc(auditLogs.createdAt),
          desc(auditLogs.id),
        )
        .limit(q.page_size)
        .offset(offsetOf(q)),
      deps.db.select({ n: count() }).from(auditLogs).where(where),
    ]);
    return pageOf(rows.map(present), total?.n ?? 0, q);
  };

  return [
    defineRoute({
      method: 'get',
      path: '/audit-logs',
      summary: "The school's audit log",
      tags: ['School · Audit'],
      access: 'tenant',
      permissions: ['audit.read'],
      query: Filters,
      handler: async ({ query: q, req }) =>
        query(eq(auditLogs.tenantId, req.ctx.tenant!.tenantId), q),
    }),
    defineRoute({
      method: 'get',
      path: '/platform/audit-logs',
      summary: 'Platform-wide audit log',
      tags: ['Platform · Audit'],
      access: 'platform',
      permissions: ['platform.audit.read'],
      query: Filters.extend({ tenant_id: z.string().uuid().optional() }),
      handler: async ({ query: q }) =>
        query(q.tenant_id ? eq(auditLogs.tenantId, q.tenant_id) : undefined, q),
    }),
  ];
}
