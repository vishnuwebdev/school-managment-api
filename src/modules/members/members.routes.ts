import type { Request } from 'express';
import { z } from 'zod';
import { MEMBERSHIP_STATUS, SCOPE_TYPE } from '../../db/schema/index.js';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import { PaginationQuery } from '../../shared/pagination.js';
import type { MemberService } from './members.service.js';

const Assignment = z.object({
  role_id: z.string().uuid(),
  scope_type: z.enum(SCOPE_TYPE).exclude(['ALL_TENANTS', 'SELECTED_TENANTS']).default('ALL_TENANT'),
  /** e.g. { "section_ids": ["…"] } when scope_type is ASSIGNED_SECTION. */
  scope_ref: z
    .record(z.string(), z.array(z.string().max(64)).max(200))
    .nullable()
    .optional(),
});
const toAssignments = (list: z.infer<typeof Assignment>[]) =>
  list.map((a) => ({ roleId: a.role_id, scopeType: a.scope_type, scopeRef: a.scope_ref ?? null }));

const InviteBody = z.object({
  email: z.email().max(254),
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().max(100).optional(),
  roles: z.array(Assignment).min(1).max(20),
});
const IdParams = z.object({ id: z.string().uuid() });
const Reason = z.object({ reason: z.string().trim().min(3).max(500) });
const ListQuery = PaginationQuery.extend({
  status: z.enum(MEMBERSHIP_STATUS).optional(),
  role_id: z.string().uuid().optional(),
});

/**
 * Users of the current school. The same service backs platform users
 * (tenantId = null) with platform permissions.
 */
export function memberRoutes(members: MemberService) {
  const tid = (req: Request) => req.ctx.tenant!.tenantId;
  return [
    defineRoute({
      method: 'get',
      path: '/members',
      summary: 'List school users',
      tags: ['School · Users'],
      access: 'tenant',
      permissions: ['members.read'],
      query: ListQuery,
      handler: async ({ query, req }) => members.list(tid(req), query),
    }),
    defineRoute({
      method: 'get',
      path: '/members/:id',
      summary: 'School user detail',
      tags: ['School · Users'],
      access: 'tenant',
      permissions: ['members.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await members.get(tid(req), params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/members/invitations',
      summary: 'Invite a user to the school with roles',
      tags: ['School · Users'],
      access: 'tenant',
      permissions: ['members.invite', 'roles.assign'],
      body: InviteBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await members.invite(
          tid(req),
          {
            email: body.email,
            firstName: body.first_name,
            lastName: body.last_name,
            assignments: toAssignments(body.roles),
          },
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/members/:id/invitations/resend',
      summary: 'Resend a pending invitation',
      tags: ['School · Users'],
      access: 'tenant',
      permissions: ['members.invite'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await members.resendInvitation(
          tid(req),
          params.id,
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/members/:id/suspend',
      summary: 'Suspend a user (signs them out)',
      tags: ['School · Users'],
      access: 'tenant',
      permissions: ['members.update'],
      params: IdParams,
      body: Reason,
      handler: async ({ params, body, req }) => ({
        data: await members.setStatus(
          tid(req),
          params.id,
          'SUSPENDED',
          body.reason,
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/members/:id/reactivate',
      summary: 'Reactivate a suspended user',
      tags: ['School · Users'],
      access: 'tenant',
      permissions: ['members.update'],
      params: IdParams,
      body: Reason,
      handler: async ({ params, body, req }) => ({
        data: await members.setStatus(
          tid(req),
          params.id,
          'ACTIVE',
          body.reason,
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'delete',
      path: '/members/:id',
      summary: 'Remove a user from the school (account and history are kept)',
      tags: ['School · Users'],
      access: 'tenant',
      permissions: ['members.revoke'],
      params: IdParams,
      body: Reason,
      status: 204,
      handler: async ({ params, body, req }) => {
        await members.revoke(
          tid(req),
          params.id,
          body.reason,
          req.ctx.principal!,
          actorFrom(req.ctx),
        );
      },
    }),
    defineRoute({
      method: 'put',
      path: '/members/:id/roles',
      summary: "Replace a user's roles",
      tags: ['School · Users'],
      access: 'tenant',
      permissions: ['roles.assign'],
      params: IdParams,
      body: z.object({ roles: z.array(Assignment).max(20) }),
      handler: async ({ params, body, req }) => ({
        data: await members.setRoles(
          tid(req),
          params.id,
          toAssignments(body.roles),
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),
  ];
}

/** Platform staff (memberships with kind PLATFORM). */
export function platformUserRoutes(members: MemberService) {
  /** Platform roles apply to every school, or only to selected schools. */
  const PlatformAssignment = z
    .object({
      role_id: z.string().uuid(),
      scope_type: z.enum(['ALL_TENANTS', 'SELECTED_TENANTS']).default('ALL_TENANTS'),
      tenant_ids: z.array(z.string().uuid()).min(1).max(500).optional(),
    })
    .refine((a) => a.scope_type === 'ALL_TENANTS' || a.tenant_ids, {
      message: 'tenant_ids is required for SELECTED_TENANTS',
      path: ['tenant_ids'],
    });
  const toPlatformAssignments = (list: z.infer<typeof PlatformAssignment>[]) =>
    list.map((a) => ({
      roleId: a.role_id,
      scopeType: a.scope_type,
      scopeRef: a.scope_type === 'SELECTED_TENANTS' ? { tenant_ids: a.tenant_ids! } : null,
    }));
  return [
    defineRoute({
      method: 'get',
      path: '/platform/users',
      summary: 'List platform users',
      tags: ['Platform · Users'],
      access: 'platform',
      permissions: ['platform.users.read'],
      query: ListQuery,
      handler: async ({ query }) => members.list(null, query),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/users/invitations',
      summary: 'Invite a platform user',
      tags: ['Platform · Users'],
      access: 'platform',
      permissions: ['platform.users.manage'],
      status: 201,
      body: InviteBody.extend({ roles: z.array(PlatformAssignment).min(1).max(10) }),
      handler: async ({ body, req }) => ({
        data: await members.invite(
          null,
          {
            email: body.email,
            firstName: body.first_name,
            lastName: body.last_name,
            assignments: toPlatformAssignments(body.roles),
          },
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'put',
      path: '/platform/users/:id/roles',
      summary: "Replace a platform user's roles",
      tags: ['Platform · Users'],
      access: 'platform',
      permissions: ['platform.users.manage'],
      params: IdParams,
      body: z.object({ roles: z.array(PlatformAssignment).max(10) }),
      handler: async ({ params, body, req }) => ({
        data: await members.setRoles(
          null,
          params.id,
          toPlatformAssignments(body.roles),
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'delete',
      path: '/platform/users/:id',
      summary: 'Remove a platform user',
      tags: ['Platform · Users'],
      access: 'platform',
      permissions: ['platform.users.manage'],
      params: IdParams,
      body: Reason,
      status: 204,
      handler: async ({ params, body, req }) => {
        await members.revoke(null, params.id, body.reason, req.ctx.principal!, actorFrom(req.ctx));
      },
    }),
  ];
}
