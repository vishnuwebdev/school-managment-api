import { asc, eq } from 'drizzle-orm';
import { scopeSupportOf } from '../access/scope-policy.js';
import type { Deps } from '../../container.js';
import { features, permissions } from '../../db/schema/index.js';
import { FEATURES } from '../../catalog/features.js';
import { defineRoute } from '../../http/route.js';
import type { EntitlementService } from '../entitlements/entitlements.service.js';

const capabilityCodes = new Set<string>(
  (FEATURES as readonly { code: string; kind?: string }[])
    .filter((f) => f.kind === 'capability')
    .map((f) => f.code),
);

export function catalogRoutes(deps: Deps, entitlements: EntitlementService) {
  const featureList = async () => {
    const [rows, graph] = await Promise.all([
      deps.db.select().from(features).orderBy(asc(features.sortOrder)),
      entitlements.catalog(),
    ]);
    return rows.map((f) => ({
      code: f.code,
      name: f.name,
      description: f.description,
      parent_code: f.parentCode,
      is_core: f.isCore,
      kind: capabilityCodes.has(f.code) ? 'capability' : 'feature',
      status: f.status,
      depends_on: graph.find((g) => g.code === f.code)?.dependsOn ?? [],
    }));
  };

  return [
    defineRoute({
      method: 'get',
      path: '/permissions',
      summary: 'Permission catalog for building roles, grouped by feature (with entitlement flags)',
      tags: ['School · Roles'],
      access: 'tenant',
      permissions: ['roles.read'],
      handler: async ({ req }) => {
        const enabled = new Set(req.ctx.tenant!.entitlements.features);
        const [rows, feats] = await Promise.all([
          deps.db
            .select()
            .from(permissions)
            .where(eq(permissions.scope, 'TENANT'))
            .orderBy(asc(permissions.sortOrder)),
          deps.db.select().from(features).orderBy(asc(features.sortOrder)),
        ]);
        return {
          data: feats
            .map((f) => ({
              feature: f.code,
              name: f.name,
              entitled: enabled.has(f.code),
              permissions: rows
                .filter((p) => p.featureCode === f.code && p.status === 'ACTIVE')
                .map((p) => ({
                  code: p.code,
                  name: p.name,
                  sensitive: p.isSensitive,
                  grantable: req.ctx.principal!.permissions.has(p.code),
                  // How a role limited to part of the school applies this permission (D55).
                  scope_support: scopeSupportOf(p.code),
                })),
            }))
            .filter((g) => g.permissions.length > 0),
        };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/platform/features',
      summary: 'Feature catalog and dependency graph',
      tags: ['Platform · Catalog'],
      access: 'platform',
      permissions: ['platform.catalog.read'],
      handler: async () => ({ data: await featureList() }),
    }),
    defineRoute({
      method: 'get',
      path: '/platform/permissions',
      summary: 'Full permission catalog',
      tags: ['Platform · Catalog'],
      access: 'platform',
      permissions: ['platform.catalog.read'],
      handler: async () => {
        const rows = await deps.db.select().from(permissions).orderBy(asc(permissions.sortOrder));
        return {
          data: rows.map((p) => ({
            code: p.code,
            name: p.name,
            feature: p.featureCode,
            scope: p.scope,
            sensitive: p.isSensitive,
            status: p.status,
          })),
        };
      },
    }),
  ];
}
