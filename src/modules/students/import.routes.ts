import type { Request } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import { STUDENT_IMPORT_XLSX, type StudentImportService } from './import.service.js';

const TAG = ['School · Student import'];
const tid = (req: Request) => req.ctx.tenant!.tenantId;

/** Registered before the :id routes, so /students/import is never read as an id. */
export function studentImportRoutes(svc: StudentImportService) {
  return [
    defineRoute({
      method: 'get',
      path: '/students/import/template',
      summary: 'Download the student import template (.xlsx) with this school’s classes and houses',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.import'],
      handler: async ({ req, res }) => {
        const buf = await svc.template(tid(req));
        res
          .status(200)
          .type(STUDENT_IMPORT_XLSX)
          .set('Content-Disposition', 'attachment; filename="student-import-template.xlsx"')
          .send(buf);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/students/import',
      summary:
        'Check (default) or import a student file. Send the .xlsx as the raw body. With ?commit=true every row is created in one transaction, or none are.',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.import'],
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
