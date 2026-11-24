import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
const caller = (req) => ({
    tenantId: req.ctx.tenant.tenantId,
    principal: req.ctx.principal,
    actor: actorFrom(req.ctx),
    features: req.ctx.tenant.entitlements.features,
});
export function dashboardRoutes(svc) {
    return [
        defineRoute({
            method: 'get',
            path: '/dashboard/school',
            summary: "The school admin's home page: today's attendance, fees, teachers, exams, parent requests, admissions, classes and what's coming up, with trends. Each part is null when the caller may not see it.",
            tags: ['School · Dashboard'],
            access: 'tenant',
            // Gate only: every school role holds it. Each part is checked against its own permission in the service.
            permissions: ['tenant.profile.read'],
            handler: async ({ req }) => ({ data: await svc.school(caller(req)) }),
        }),
    ];
}
