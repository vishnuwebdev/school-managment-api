import { defineRoute } from '../../http/route.js';
import { ClassOverviewQuery } from './overview.service.js';
/** Registered before the academic routes so /academic-classes/overview is never read as an id. */
export function classOverviewRoutes(svc) {
    return [
        defineRoute({
            method: 'get',
            path: '/academic-classes/overview',
            summary: 'Every class with its sections, seats, class teachers and subject count for one academic year (default: the active one), plus what needs attention.',
            tags: ['School · Classes'],
            access: 'tenant',
            permissions: ['academics.read'],
            query: ClassOverviewQuery,
            handler: async ({ query, req }) => ({
                data: await svc.overview(req.ctx.tenant.tenantId, query),
            }),
        }),
    ];
}
