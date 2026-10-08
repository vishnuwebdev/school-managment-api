import type { Request } from 'express';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import {
  StudentReportParams,
  StudentReportQuery,
  type StudentReportService,
} from './reports.service.js';

const tid = (req: Request) => req.ctx.tenant!.tenantId;

/** Registered before the :id routes. Results follow the caller's student scope. */
export function studentReportRoutes(svc: StudentReportService) {
  return [
    defineRoute({
      method: 'get',
      path: '/students/reports/:report',
      summary:
        'Student report: class-strength, gender-strength, admissions, withdrawals, transfers or student-list. ?format=csv downloads it.',
      tags: ['School · Student reports'],
      access: 'tenant',
      permissions: ['students.read'],
      params: StudentReportParams,
      query: StudentReportQuery,
      handler: async ({ params, query, req, res }) => {
        const out = await svc.run(
          tid(req),
          params.report,
          query,
          req.ctx.principal!,
          actorFrom(req.ctx),
        );
        if (typeof out === 'string') {
          res
            .status(200)
            .type('text/csv')
            .set('Content-Disposition', `attachment; filename="students-${params.report}.csv"`)
            .send(out);
          return;
        }
        res.status(200).json({ data: out });
      },
    }),
  ];
}
