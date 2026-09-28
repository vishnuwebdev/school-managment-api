import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import type { RoleService } from './roles.service.js';

const IdParams = z.object({ id: z.string().uuid() });
const PermissionList = z.array(z.string().min(3).max(100)).max(300);

export function roleRoutes(rolesSvc: RoleService) {
  return [
    defineRoute({
      method: 'get',
      path: '/roles',
      summary: 'System and custom roles available in this school',
      tags: ['School · Roles'],
      access: 'tenant',
      permissions: ['roles.read'],
      query: z.object({ include_archived: z.stringbool().optional() }),
      handler: async ({ query, req }) => ({
        data: await rolesSvc.list(req.ctx.tenant!.tenantId, {
          includeArchived: query.include_archived,
        }),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/roles/:id',
      summary: 'Role detail',
      tags: ['School · Roles'],
      access: 'tenant',
      permissions: ['roles.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await rolesSvc.get(req.ctx.tenant!.tenantId, params.id),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/roles',
      summary: 'Create a custom role (e.g. a Sub Admin)',
      tags: ['School · Roles'],
      access: 'tenant',
      permissions: ['roles.create'],
      status: 201,
      body: z.object({
        code: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
          .optional(),
        name: z.string().trim().min(2).max(100),
        description: z.string().trim().max(500).nullable().optional(),
        permissions: PermissionList,
      }),
      handler: async ({ body, req }) => ({
        data: await rolesSvc.create(
          req.ctx.tenant!.tenantId,
          body,
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/roles/:id',
      summary: 'Edit a custom role',
      tags: ['School · Roles'],
      access: 'tenant',
      permissions: ['roles.update'],
      params: IdParams,
      body: z.object({
        version: z.number().int().positive(),
        name: z.string().trim().min(2).max(100).optional(),
        description: z.string().trim().max(500).nullable().optional(),
        permissions: PermissionList.optional(),
      }),
      handler: async ({ params, body, req }) => ({
        data: await rolesSvc.update(
          req.ctx.tenant!.tenantId,
          params.id,
          body,
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/roles/:id/archive',
      summary: 'Archive a custom role (its users lose those permissions)',
      tags: ['School · Roles'],
      access: 'tenant',
      permissions: ['roles.archive'],
      params: IdParams,
      body: z.object({ reason: z.string().trim().min(3).max(500) }),
      handler: async ({ params, body, req }) => ({
        data: await rolesSvc.archive(
          req.ctx.tenant!.tenantId,
          params.id,
          body.reason,
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/platform/roles',
      summary: 'Platform roles',
      tags: ['Platform · Users'],
      access: 'platform',
      permissions: ['platform.users.read'],
      handler: async () => ({ data: await rolesSvc.list(null) }),
    }),
  ];
}
