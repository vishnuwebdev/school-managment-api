/**
 * Entitlement resolver — the only place that turns commercial state into
 * effective capabilities. Domain code asks "is feature X enabled for this
 * tenant?", never "is this tenant on plan Y?".
 *
 *   plan + add-ons + contracts + overrides + validity + subscription state
 *   + dependencies  →  effective feature set
 */
export function resolveEntitlements(input) {
    const { catalog, rows, subscription, now } = input;
    const valid = (r) => r.startsAt <= now && (r.endsAt === null || r.endsAt > now);
    const known = new Set(catalog.map((f) => f.code));
    const granted = new Set();
    if (subscription.accessMode === 'FULL') {
        for (const r of rows) {
            if (r.effect !== 'GRANT' || !valid(r) || !known.has(r.featureCode))
                continue;
            // Plan/add-on grants only count while they belong to the governing subscription.
            if ((r.sourceType === 'PLAN' || r.sourceType === 'ADD_ON') &&
                r.sourceReference !== subscription.subscriptionId)
                continue;
            granted.add(r.featureCode);
        }
    }
    const blocked = [];
    for (const r of rows) {
        if (r.effect === 'DENY' && valid(r) && granted.delete(r.featureCode)) {
            blocked.push({ feature: r.featureCode, reason: 'DENIED_BY_OVERRIDE' });
        }
    }
    // Core capabilities are always present for an accessible tenant.
    for (const f of catalog)
        if (f.isCore)
            granted.add(f.code);
    // Dependency closure: drop anything whose prerequisites are missing, until stable.
    const byCode = new Map(catalog.map((f) => [f.code, f]));
    let changed = true;
    while (changed) {
        changed = false;
        for (const code of [...granted]) {
            const missing = (byCode.get(code)?.dependsOn ?? []).filter((d) => !granted.has(d));
            if (missing.length > 0) {
                granted.delete(code);
                blocked.push({ feature: code, reason: 'DEPENDENCY_MISSING', missing });
                changed = true;
            }
        }
    }
    return {
        accessMode: subscription.accessMode,
        subscription: {
            id: subscription.subscriptionId,
            status: subscription.effectiveStatus,
            planCode: input.planCode,
            expiredAt: subscription.expiredAt?.toISOString() ?? null,
            graceEndsAt: subscription.graceEndsAt?.toISOString() ?? null,
        },
        features: [...granted].sort(),
        blocked,
        limits: input.limits ?? { maxStaffUsers: null, maxStudents: null },
        resolvedAt: now.toISOString(),
    };
}
/**
 * Simple product mode: every active catalog feature, except
 * - the switched-off sub-user features,
 * - an app feature (Teacher app, Parent app) without an active GRANT override, and what only
 *   makes sense with that app,
 * - anything denied by an override,
 * then the usual dependency closure. There is no subscription, so access is always FULL.
 */
export function resolveSimpleEntitlements(input) {
    const { catalog, rows, now } = input;
    const valid = (r) => r.startsAt <= now && (r.endsAt === null || r.endsAt > now);
    const overrides = rows.filter((r) => r.sourceType === 'ADMIN_OVERRIDE' && valid(r));
    const granted = new Set(catalog.map((f) => f.code));
    for (const code of input.off)
        granted.delete(code);
    const blocked = [];
    for (const app of input.appFeatures) {
        const on = overrides.some((r) => r.featureCode === app && r.effect === 'GRANT');
        if (on)
            continue;
        for (const code of [app, ...(input.appLinked[app] ?? [])])
            granted.delete(code);
    }
    for (const r of overrides) {
        if (r.effect === 'DENY' && granted.delete(r.featureCode))
            blocked.push({ feature: r.featureCode, reason: 'DENIED_BY_OVERRIDE' });
    }
    for (const f of catalog)
        if (f.isCore)
            granted.add(f.code);
    const byCode = new Map(catalog.map((f) => [f.code, f]));
    let changed = true;
    while (changed) {
        changed = false;
        for (const code of [...granted]) {
            const missing = (byCode.get(code)?.dependsOn ?? []).filter((d) => !granted.has(d));
            if (missing.length > 0) {
                granted.delete(code);
                blocked.push({ feature: code, reason: 'DEPENDENCY_MISSING', missing });
                changed = true;
            }
        }
    }
    return {
        accessMode: 'FULL',
        subscription: { id: null, status: 'NONE', planCode: null, expiredAt: null, graceEndsAt: null },
        features: [...granted].sort(),
        blocked,
        limits: { maxStaffUsers: null, maxStudents: null },
        resolvedAt: now.toISOString(),
    };
}
/** Features that (transitively) depend on `code` — shown before disabling it. */
export function dependentsOf(catalog, code) {
    const out = new Set();
    const visit = (c) => {
        for (const f of catalog) {
            if (f.dependsOn.includes(c) && !out.has(f.code)) {
                out.add(f.code);
                visit(f.code);
            }
        }
    };
    visit(code);
    return [...out].sort();
}
/** API representation (snake_case, like every other response). */
export function presentSnapshot(s) {
    return {
        access_mode: s.accessMode,
        subscription: {
            id: s.subscription.id,
            status: s.subscription.status,
            plan_code: s.subscription.planCode,
            expired_at: s.subscription.expiredAt,
            grace_ends_at: s.subscription.graceEndsAt,
        },
        features: s.features,
        blocked: s.blocked,
        limits: {
            max_staff_users: s.limits?.maxStaffUsers ?? null,
            max_students: s.limits?.maxStudents ?? null,
        },
        resolved_at: s.resolvedAt,
    };
}
