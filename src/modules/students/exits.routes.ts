import type { Request } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import { fileHeaders } from '../files/files.service.js';
import type { StudentExitService } from './exits.service.js';
import { PhotoUploadQuery } from './documents.schemas.js';
import { IdParams } from './students.schemas.js';

const TAG = ['School · Student exits'];
const tid = (req: Request) => req.ctx.tenant!.tenantId;
const me = (req: Request) => req.ctx.principal!;

export function studentExitRoutes(svc: StudentExitService) {
  return [
    defineRoute({
      method: 'get',
      path: '/students/:id/exit',
      summary: 'Withdrawal or transfer details (current and earlier), readable after archiving',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await svc.get(tid(req), params.id, me(req)) }),
    }),
    defineRoute({
      method: 'put',
      path: '/students/:id/exit-document',
      summary:
        'Attach a supporting document (PNG, JPEG, WebP or PDF, up to 5 MB) to the current withdrawal or transfer. Raw body plus ?filename=.',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.archive'],
      params: IdParams,
      query: PhotoUploadQuery,
      body: z.any(),
      handler: async ({ params, query, body, req }) => ({
        data: await svc.attachDocument(tid(req), params.id, me(req), actorFrom(req.ctx), {
          data: body,
          filename: query.filename,
        }),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/students/:id/exit/document',
      summary: 'Download the supporting document of the latest exit',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.read'],
      params: IdParams,
      handler: async ({ params, req, res }) => {
        const f = await svc.readDocument(tid(req), params.id, me(req));
        res.status(200).set(fileHeaders(f)).end(f.data);
        return undefined;
      },
    }),
  ];
}
