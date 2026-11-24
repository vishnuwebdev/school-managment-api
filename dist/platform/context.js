export const systemActor = (tenantId = null) => ({
    userId: null,
    actorType: 'SYSTEM',
    tenantId,
});
export function actorFrom(ctx) {
    return {
        userId: ctx.principal?.userId ?? null,
        actorType: ctx.principal?.actorType ?? 'ANONYMOUS',
        tenantId: ctx.tenant?.tenantId ?? null,
        meta: ctx.meta,
    };
}
