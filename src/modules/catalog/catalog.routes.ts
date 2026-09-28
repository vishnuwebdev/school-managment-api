import { asc, eq } from 'drizzle-orm';
import type { Deps } from '../../container.js';
import { features, permissions, planFeatures, plans, planVersions } from '../../db/schema/index.js';
import { defineRoute } from '../../http/route.js';
import type { EntitlementService } from '../entitlements/entitlements.service.js';

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
      path: '/platform/plans',
      summary: 'Plans with their current version, price and features',
      tags: ['Platform · Catalog'],
      access: 'platform',
      permissions: ['platform.catalog.read'],
      handler: async () => {
        const rows = await deps.db
          .select({ plan: plans, version: planVersions })
          .from(plans)
          .innerJoin(planVersions, eq(planVersions.planId, plans.id))
          .where(eq(planVersions.status, 'ACTIVE'))
          .orderBy(asc(planVersions.priceMonthlyMinor));
        const pf = await deps.db
          .select({ versionId: planFeatures.planVersionId, code: features.code })
          .from(planFeatures)
          .innerJoin(features, eq(features.id, planFeatures.featureId));
        return {
          data: rows.map(({ plan, version }) => ({
            code: plan.code,
            name: plan.name,
            description: plan.description,
            status: plan.status,
            version: version.version,
            currency: version.currency,
            price_monthly_minor: version.priceMonthlyMinor,
            price_annual_minor: version.priceAnnualMinor,
            features: pf
              .filter((x) => x.versionId === version.id)
              .map((x) => x.code)
              .sort(),
          })),
        };
      },
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
