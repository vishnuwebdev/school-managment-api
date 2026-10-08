import type { Request } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import { IMPORT_CONTENT_TYPES, type StaffImportService } from './import.service.js';

const TAG = ['School · Staff import'];
const tid = (req: Request) => req.ctx.tenant!.tenantId;

/** Registered before the :id routes, so /teachers/import is never read as an id. */
export function staffImportRoutes(svc: StaffImportService) {
  return [
    defineRoute({
      method: 'get',
      path: '/teachers/import/template',
      summary: 'Download the staff import template (.xlsx)',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.create'],
      handler: async ({ res }) => {
        const buf = await svc.template();
        res
          .status(200)
          .type(IMPORT_CONTENT_TYPES[0]!)
          .set('Content-Disposition', 'attachment; filename="staff-import-template.xlsx"')
          .send(buf);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/teachers/import',
      summary:
        'Check (default) or import a staff file. Send the .xlsx or .csv as the raw body. With ?commit=true every row is created in one transaction, or none are.',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.create'],
      query: z.object({
        commit: z.stringbool().default(false),
        allow_duplicates: z.stringbool().default(false),
      }),
      body: z.any(),
      handler: async ({ query, body, req }) => ({
        data: await svc.run(
          tid(req),
          { data: body, contentType: req.headers['content-type'] ?? '' },
          { commit: query.commit, allowDuplicates: query.allow_duplicates },
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),
  ];
}
