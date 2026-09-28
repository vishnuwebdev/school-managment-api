import { presentSnapshot } from '../entitlements/entitlement-resolver.js';
import type { Request } from 'express';
import { z } from 'zod';
import { TENANT_STATUS } from '../../db/schema/index.js';
import { defineRoute } from '../../http/route.js';
import { actorFrom, type Actor } from '../../platform/context.js';
import { PaginationQuery } from '../../shared/pagination.js';
import type { EntitlementService } from '../entitlements/entitlements.service.js';
import {
  ChangeSubscriptionBody,
  CreateTenantBody,
  ProvisionBody,
  ReasonBody,
  SettingsBody,
  UpdateTenantBody,
} from './schemas.js';
import type { TenantService } from './tenants.service.js';

const IdParams = z.object({ id: z.string().uuid() });

/** Platform administration of schools (tenant lifecycle, provisioning, subscriptions, entitlements). */
export function platformTenantRoutes(tenantsSvc: TenantService, entitlements: EntitlementService) {
  const platformActor = (req: Request, tenantId: string | null = null): Actor => ({
    ...actorFrom(req.ctx),
    tenantId,
  });

  return [
    defineRoute({
      method: 'get',
      path: '/platform/tenants',
      summary: 'List schools',
      tags: ['Platform · Schools'],
      access: 'platform',
      permissions: ['platform.tenants.read'],
      query: PaginationQuery.extend({ status: z.enum(TENANT_STATUS).optional() }),
      handler: async ({ query }) => tenantsSvc.list(query),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/tenants',
      summary: 'Create a school (status APPROVED, ready to provision)',
      tags: ['Platform · Schools'],
      access: 'platform',
      permissions: ['platform.tenants.create'],
      body: CreateTenantBody,
      status: 201,
      handler: async ({ body, req }) => {
        const id = await tenantsSvc.create(body, platformActor(req));
        return { data: await tenantsSvc.detail(id) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/platform/tenants/:id',
      summary: 'School detail with settings and effective entitlements',
      tags: ['Platform · Schools'],
      access: 'platform',
      permissions: ['platform.tenants.read'],
      params: IdParams,
      handler: async ({ params }) => ({ data: await tenantsSvc.detail(params.id) }),
    }),
    defineRoute({
      method: 'patch',
      path: '/platform/tenants/:id',
      summary: 'Edit a school profile',
      tags: ['Platform · Schools'],
      access: 'platform',
      permissions: ['platform.tenants.update'],
      params: IdParams,
      body: UpdateTenantBody,
      handler: async ({ params, body, req }) => ({
        data: await tenantsSvc.updateProfile(params.id, body, platformActor(req, params.id)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/platform/tenants/:id/status-history',
      summary: 'Lifecycle history of a school',
      tags: ['Platform · Schools'],
      access: 'platform',
      permissions: ['platform.tenants.read'],
      params: IdParams,
      handler: async ({ params }) => ({ data: await tenantsSvc.statusHistory(params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/tenants/:id/provision',
      summary:
        'Provision a school: settings, subscription, entitlements and first admin invitation',
      tags: ['Platform · Schools'],
      access: 'platform',
      permissions: ['platform.tenants.provision'],
      params: IdParams,
      body: ProvisionBody,
      handler: async ({ params, body, req }) => ({
        data: await tenantsSvc.provision(params.id, body, platformActor(req, params.id)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/tenants/:id/suspend',
      summary: 'Suspend a school (members lose access; data is kept)',
      tags: ['Platform · Schools'],
      access: 'platform',
      permissions: ['platform.tenants.suspend'],
      params: IdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await tenantsSvc.transition(
          params.id,
          'SUSPENDED',
          body.reason,
          platformActor(req, params.id),
        ),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/tenants/:id/reactivate',
      summary: 'Reactivate a suspended school',
      tags: ['Platform · Schools'],
      access: 'platform',
      permissions: ['platform.tenants.suspend'],
      params: IdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await tenantsSvc.transition(
          params.id,
          'ACTIVE',
          body.reason,
          platformActor(req, params.id),
        ),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/tenants/:id/archive',
      summary: 'Archive a school (terminal; no physical deletion)',
      tags: ['Platform · Schools'],
      access: 'platform',
      permissions: ['platform.tenants.archive'],
      params: IdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await tenantsSvc.transition(
          params.id,
          'ARCHIVED',
          body.reason,
          platformActor(req, params.id),
        ),
      }),
    }),

    defineRoute({
      method: 'post',
      path: '/platform/tenants/:id/restore',
      summary: 'Restore an archived school (it returns as SUSPENDED; reactivate it afterwards)',
      tags: ['Platform · Schools'],
      access: 'platform',
      permissions: ['platform.tenants.archive'],
      params: IdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await tenantsSvc.transition(
          params.id,
          'SUSPENDED',
          body.reason,
          platformActor(req, params.id),
          { restore: true },
        ),
      }),
    }),

    // ---- Subscriptions -------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/platform/tenants/:id/subscriptions',
      summary: 'Subscription history of a school',
      tags: ['Platform · Subscriptions'],
      access: 'platform',
      permissions: ['platform.subscriptions.read'],
      params: IdParams,
      handler: async ({ params }) => ({ data: await tenantsSvc.subscriptions(params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/tenants/:id/subscriptions',
      summary: 'Start a new subscription (plan change / renewal). The previous one is cancelled.',
      tags: ['Platform · Subscriptions'],
      access: 'platform',
      permissions: ['platform.subscriptions.manage'],
      params: IdParams,
      body: ChangeSubscriptionBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await tenantsSvc.changeSubscription(params.id, body, platformActor(req, params.id)),
      }),
    }),

    defineRoute({
      method: 'post',
      path: '/platform/tenants/:id/subscriptions/cancel',
      summary: 'Cancel the subscription (at period end, or immediately)',
      tags: ['Platform · Subscriptions'],
      access: 'platform',
      permissions: ['platform.subscriptions.manage'],
      params: IdParams,
      body: ReasonBody.extend({ immediately: z.boolean().default(false) }),
      handler: async ({ params, body, req }) => ({
        data: await tenantsSvc.cancelSubscription(
          params.id,
          { reason: body.reason, immediately: body.immediately },
          platformActor(req, params.id),
        ),
      }),
    }),

    // ---- Entitlements --------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/platform/tenants/:id/entitlements',
      summary: 'Effective entitlements and active overrides',
      tags: ['Platform · Entitlements'],
      access: 'platform',
      permissions: ['platform.entitlements.read'],
      params: IdParams,
      handler: async ({ params }) => {
        await tenantsSvc.getRow(params.id);
        const [snapshot, overrides] = await Promise.all([
          entitlements.compute(params.id),
          entitlements.listOverrides(params.id),
        ]);
        return {
          data: {
            ...presentSnapshot(snapshot),
            overrides: overrides.map((o) => ({
              id: o.id,
              feature: o.feature,
              effect: o.effect,
              starts_at: o.startsAt.toISOString(),
              ends_at: o.endsAt?.toISOString() ?? null,
              reason: o.reason,
              granted_by: o.grantedBy,
            })),
          },
        };
      },
    }),
    defineRoute({
      method: 'put',
      path: '/platform/tenants/:id/entitlements/overrides/:feature',
      summary: 'Grant or deny a feature for a school (admin override)',
      tags: ['Platform · Entitlements'],
      access: 'platform',
      permissions: ['platform.entitlements.override'],
      params: z.object({ id: z.string().uuid(), feature: z.string().min(1).max(64) }),
      body: z.object({
        effect: z.enum(['GRANT', 'DENY']),
        reason: z.string().trim().min(3).max(500),
        ends_at: z.coerce.date().nullable().optional(),
        /** Required when denying a feature that other enabled features depend on. */
        confirm: z.boolean().optional(),
      }),
      handler: async ({ params, body, req }) => {
        await tenantsSvc.getRow(params.id);
        const res = await entitlements.setOverride(
          params.id,
          {
            featureCode: params.feature,
            effect: body.effect,
            reason: body.reason,
            endsAt: body.ends_at,
            confirm: body.confirm,
          },
          platformActor(req, params.id),
        );
        return { data: presentSnapshot(res.snapshot) };
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/platform/tenants/:id/entitlements/overrides/:feature',
      summary: 'Remove an admin override',
      tags: ['Platform · Entitlements'],
      access: 'platform',
      permissions: ['platform.entitlements.override'],
      params: z.object({ id: z.string().uuid(), feature: z.string().min(1).max(64) }),
      body: ReasonBody.extend({ confirm: z.boolean().optional() }),
      handler: async ({ params, body, req }) => ({
        data: presentSnapshot(
          await entitlements.removeOverride(
            params.id,
            params.feature,
            { reason: body.reason, confirm: body.confirm },
            platformActor(req, params.id),
          ),
        ),
      }),
    }),

    // ---- School requests -------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/platform/school-requests',
      summary: 'List school onboarding requests',
      tags: ['Platform · Schools'],
      access: 'platform',
      permissions: ['platform.tenants.review'],
      query: PaginationQuery.extend({
        status: z.enum(['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED']).optional(),
      }),
      handler: async ({ query }) => tenantsSvc.listRequests(query),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/school-requests/:id/approve',
      summary: 'Approve a request and create the school',
      tags: ['Platform · Schools'],
      access: 'platform',
      permissions: ['platform.tenants.review', 'platform.tenants.create'],
      params: IdParams,
      body: CreateTenantBody,
      handler: async ({ params, body, req }) => ({
        data: await tenantsSvc.reviewRequest(
          params.id,
          { approve: true, tenant: body },
          platformActor(req),
        ),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/school-requests/:id/reject',
      summary: 'Reject a school request',
      tags: ['Platform · Schools'],
      access: 'platform',
      permissions: ['platform.tenants.review'],
      params: IdParams,
      body: z.object({ note: z.string().trim().min(3).max(500) }),
      handler: async ({ params, body, req }) => ({
        data: await tenantsSvc.reviewRequest(
          params.id,
          { approve: false, note: body.note },
          platformActor(req),
        ),
      }),
    }),
  ];
}

/** The signed-in user's own school. */
export function currentTenantRoutes(tenantsSvc: TenantService) {
  return [
    defineRoute({
      method: 'get',
      path: '/tenants/current',
      summary: 'Current school profile',
      tags: ['School'],
      access: 'tenant',
      permissions: ['tenant.profile.read'],
      handler: async ({ req }) => ({ data: await tenantsSvc.detail(req.ctx.tenant!.tenantId) }),
    }),
    defineRoute({
      method: 'patch',
      path: '/tenants/current',
      summary: 'Edit the school profile',
      tags: ['School'],
      access: 'tenant',
      permissions: ['tenant.profile.update'],
      body: UpdateTenantBody,
      handler: async ({ body, req }) => ({
        data: await tenantsSvc.updateProfile(req.ctx.tenant!.tenantId, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/tenants/current/settings',
      summary: 'School settings',
      tags: ['School'],
      access: 'tenant',
      permissions: ['tenant.settings.read'],
      handler: async ({ req }) => ({
        data: await tenantsSvc.getSettings(req.ctx.tenant!.tenantId),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/tenants/current/settings',
      summary: 'Edit school settings',
      tags: ['School'],
      access: 'tenant',
      permissions: ['tenant.settings.update'],
      body: SettingsBody,
      handler: async ({ body, req }) => ({
        data: await tenantsSvc.updateSettings(req.ctx.tenant!.tenantId, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/tenants/current/subscription',
      summary: 'Plan, subscription state and enabled features',
      tags: ['School'],
      access: 'tenant',
      permissions: ['tenant.subscription.read'],
      handler: async ({ req }) => {
        const tenantId = req.ctx.tenant!.tenantId;
        return {
          data: {
            entitlements: presentSnapshot(req.ctx.tenant!.entitlements),
            subscriptions: await tenantsSvc.subscriptions(tenantId),
          },
        };
      },
    }),
  ];
}

/** Unauthenticated onboarding form. */
export function publicTenantRoutes(tenantsSvc: TenantService) {
  return [
    defineRoute({
      method: 'post',
      path: '/public/school-requests',
      summary: 'Request a new school account',
      tags: ['Public'],
      access: 'public',
      rateLimit: 'auth',
      body: z.object({
        school_name: z.string().trim().min(2).max(200),
        contact_name: z.string().trim().min(2).max(200),
        contact_email: z.email().max(254),
        contact_phone: z.string().trim().max(32).optional(),
        city: z.string().trim().max(100).optional(),
        country: z.string().length(2).toUpperCase().optional(),
        message: z.string().trim().max(2000).optional(),
      }),
      status: 201,
      handler: async ({ body, req }) => ({
        data: await tenantsSvc.submitRequest(body, actorFrom(req.ctx)),
      }),
    }),
  ];
}
