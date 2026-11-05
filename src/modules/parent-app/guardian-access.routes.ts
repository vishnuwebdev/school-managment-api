import type { Request } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import {
  AppPasswordBody,
  DisableAppAccessBody,
  EnableAppAccessBody,
  type GuardianAccessService,
} from './guardian-access.service.js';

const IdParams = z.object({ id: z.uuid() });
const TAG = ['School · Guardians'];
const tid = (req: Request) => req.ctx.tenant!.tenantId;

/** Admin panel → Guardians: turn the parent app on or off and set the parent's password. */
export function guardianAccessRoutes(svc: GuardianAccessService) {
  return [
    defineRoute({
      method: 'get',
      path: '/guardians/:id/app-access',
      summary: 'Parent app login of a guardian: on/off, sign-in mobile number, last sign-in',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await svc.status(tid(req), params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/guardians/:id/app-access',
      summary:
        'Turn on the parent app. The parent signs in with the mobile number (default: the guardian phone) and the password set here. ' +
        'A guardian who already signs in at this school as staff keeps that login and gains the Parent role (no password needed).',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.guardians.manage'],
      params: IdParams,
      body: EnableAppAccessBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await svc.enable(tid(req), params.id, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'put',
      path: '/guardians/:id/app-access/password',
      summary:
        'Set a new parent app password (forgotten password). Signs the parent out everywhere.',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.guardians.manage'],
      params: IdParams,
      body: AppPasswordBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.setPassword(tid(req), params.id, body.password, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'delete',
      path: '/guardians/:id/app-access',
      summary: 'Turn off the parent app (removes a parent-only login; staff keep their login)',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.guardians.manage'],
      params: IdParams,
      body: DisableAppAccessBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.disable(tid(req), params.id, body.reason, actorFrom(req.ctx)),
      }),
    }),
  ];
}
