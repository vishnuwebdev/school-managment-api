import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import { StaffReportParams, StaffReportQuery, } from './staff-reports.service.js';
const tid = (req) => req.ctx.tenant.tenantId;
export function staffReportRoutes(svc) {
    return [
        defineRoute({
            method: 'get',
            path: '/staff-reports/:report',
            summary: 'Teacher report: directory, by-department, qualifications or expiring-documents. ?format=csv downloads it.',
            tags: ['School · Staff reports'],
            access: 'tenant',
            permissions: ['teachers.reports.read'],
            params: StaffReportParams,
            query: StaffReportQuery,
            handler: async ({ params, query, req, res }) => {
                const out = await svc.run(tid(req), params.report, query, req.ctx.principal, actorFrom(req.ctx));
                if (typeof out === 'string') {
                    res
                        .status(200)
                        .type('text/csv')
                        .set('Content-Disposition', `attachment; filename="staff-${params.report}.csv"`)
                        .send(out);
                    return;
                }
                res.status(200).json({ data: out });
            },
        }),
    ];
}
