import { z } from 'zod';
import type { Request } from 'express';
import { defineRoute } from '../../http/route.js';
import { actorFrom, type Actor } from '../../platform/context.js';
import type { PlanService } from './plans.service.js';

const Code = z.object({ code: z.string().min(2).max(64) });
const Reason = z.string().trim().min(3).max(500);
const FeatureList = z.array(z.string().min(1).max(64)).max(100);
const Price = z.number().int().min(0).max(1_000_000_000);
/** A limit is a whole number of at least 1, or null for unlimited. */
const Limit = z.number().int().min(1).max(10_000_000).nullable();

/** Plans: what the super admin sells, and what each plan lets a school use. */
export function planRoutes(svc: PlanService) {
  const platformActor = (req: Request): Actor => ({ ...actorFrom(req.ctx), tenantId: null });
  return [
    defineRoute({
      method: 'get',
      path: '/platform/plans',
      summary: 'Plans with price, limits, features and how many schools are on each',
      tags: ['Platform · Plans'],
      access: 'platform',
      permissions: ['platform.catalog.read'],
      handler: async () => ({ data: await svc.list() }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/plans',
      summary: 'Create a plan',
      tags: ['Platform · Plans'],
      access: 'platform',
      permissions: ['platform.plans.manage'],
      body: z.object({
        code: z
          .string()
          .trim()
          .regex(/^[A-Z][A-Z0-9_]{1,31}$/, 'Use capital letters, digits and underscores'),
        name: z.string().trim().min(2).max(100),
        description: z.string().trim().max(500).nullable().optional(),
        currency: z.string().length(3).optional(),
        price_monthly_minor: Price,
        price_annual_minor: Price,
        max_staff_users: Limit.optional(),
        max_students: Limit.optional(),
        features: FeatureList,
        reason: Reason,
      }),
      status: 201,
      handler: async ({ body, req }) => ({ data: await svc.create(body, platformActor(req)) }),
    }),
    defineRoute({
      method: 'get',
      path: '/platform/plans/:code',
      summary: 'One plan',
      tags: ['Platform · Plans'],
      access: 'platform',
      permissions: ['platform.catalog.read'],
      params: Code,
      handler: async ({ params }) => ({ data: await svc.get(params.code) }),
    }),
    defineRoute({
      method: 'patch',
      path: '/platform/plans/:code',
      summary:
        'Edit name, description, prices and limits. Limits apply at once; a price applies to subscriptions started or renewed afterwards.',
      tags: ['Platform · Plans'],
      access: 'platform',
      permissions: ['platform.plans.manage'],
      params: Code,
      body: z.object({
        name: z.string().trim().min(2).max(100).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        price_monthly_minor: Price.optional(),
        price_annual_minor: Price.optional(),
        max_staff_users: Limit.optional(),
        max_students: Limit.optional(),
        reason: Reason,
      }),
      handler: async ({ params, body, req }) => ({
        data: await svc.update(params.code, body, platformActor(req)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/plans/:code/features/preview',
      summary: 'What a feature change would do to the plan and the schools on it (changes nothing)',
      tags: ['Platform · Plans'],
      access: 'platform',
      permissions: ['platform.catalog.read'],
      params: Code,
      body: z.object({ features: FeatureList }),
      handler: async ({ params, body }) => ({
        data: await svc.preview(params.code, body.features),
      }),
    }),
    defineRoute({
      method: 'put',
      path: '/platform/plans/:code/features',
      summary:
        'Set the features of a plan. Applies to every school on the plan at once; removing features needs confirm=true.',
      tags: ['Platform · Plans'],
      access: 'platform',
      permissions: ['platform.plans.manage'],
      params: Code,
      body: z.object({ features: FeatureList, reason: Reason, confirm: z.boolean().optional() }),
      handler: async ({ params, body, req }) => ({
        data: await svc.setFeatures(params.code, body, platformActor(req)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/plans/:code/retire',
      summary:
        'Retire a plan: it can no longer be chosen for new schools; schools on it are untouched',
      tags: ['Platform · Plans'],
      access: 'platform',
      permissions: ['platform.plans.manage'],
      params: Code,
      body: z.object({ reason: Reason }),
      handler: async ({ params, body, req }) => ({
        data: await svc.setStatus(params.code, 'ARCHIVED', body.reason, platformActor(req)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/plans/:code/restore',
      summary: 'Bring a retired plan back',
      tags: ['Platform · Plans'],
      access: 'platform',
      permissions: ['platform.plans.manage'],
      params: Code,
      body: z.object({ reason: Reason }),
      handler: async ({ params, body, req }) => ({
        data: await svc.setStatus(params.code, 'ACTIVE', body.reason, platformActor(req)),
      }),
    }),
  ];
}
