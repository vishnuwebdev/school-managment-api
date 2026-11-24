import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { roleAssignments, roles } from '../../db/schema/index.js';
import { ADMIN_PANEL_ROLES, APP_FEATURES, isSimpleMode, } from '../../catalog/product-mode.js';
import { AuthorizationError } from '../../shared/errors.js';
/**
 * Who may sign in where (simple product mode; in full mode everyone with an active
 * membership may sign in, as before):
 *
 * - admin panel: the Super Admin (platform) and a school's School Admin;
 * - teacher app: a teacher of a school whose Teacher app is switched on;
 * - parent app: a guardian of a school whose Parent app is switched on;
 * - a disabled (suspended) school: nobody.
 *
 * Without `app` (an older client) any one of these uses is enough.
 */
export class SignInPolicy {
    deps;
    authz;
    entitlements;
    constructor(deps, authz, entitlements) {
        this.deps = deps;
        this.authz = authz;
        this.entitlements = entitlements;
    }
    /** The options this sign-in may use, or the clearest reason why none is allowed. */
    async filter(options, app) {
        if (!isSimpleMode(this.deps.env))
            return options;
        const allowed = [];
        let refusal = null;
        for (const o of options) {
            const why = await this.refusal(o, app);
            if (!why)
                allowed.push(o);
            else if (!refusal || why.rank > refusal.rank)
                refusal = why;
        }
        if (allowed.length === 0 && refusal)
            throw new AuthorizationError(refusal.code, refusal.message);
        return allowed;
    }
    /** Throws when this one membership may not be used (refresh, switch school, PIN). */
    async assert(option, app) {
        await this.filter([option], app);
    }
    async refusal(o, app) {
        const roleCodes = await this.roleCodes(o.membership_id);
        if (o.kind === 'PLATFORM') {
            if (app === 'teacher' || app === 'parent')
                return wrongApp(app);
            if (roleCodes.has(ADMIN_PANEL_ROLES.platform))
                return null;
            return {
                code: 'ADMIN_PANEL_NOT_ALLOWED',
                message: 'Only the Super Admin can sign in to platform administration.',
                rank: 2,
            };
        }
        const tenant = o.tenant;
        if (tenant.status !== 'ACTIVE')
            return {
                code: 'SCHOOL_SUSPENDED',
                message: 'This school is disabled. Contact the platform team.',
                rank: 5,
            };
        const isAdmin = roleCodes.has(ADMIN_PANEL_ROLES.school);
        if (app === 'admin' || (!app && isAdmin)) {
            if (isAdmin)
                return null;
            return {
                code: 'ADMIN_PANEL_NOT_ALLOWED',
                message: 'Only the School Admin can sign in to the admin panel.',
                rank: 3,
            };
        }
        const { permissions } = await this.authz.grantsFor(o.membership_id, tenant.id);
        const features = (await this.entitlements.snapshot(tenant.id)).features;
        const uses = [
            {
                app: 'teacher',
                holds: permissions.includes('teacher_app.use'),
                on: features.includes(APP_FEATURES.teacher_app),
                code: 'TEACHER_APP_DISABLED',
                message: 'The Teacher app is not switched on for your school. Contact the school office.',
            },
            {
                app: 'parent',
                holds: permissions.includes('portal.access'),
                on: features.includes(APP_FEATURES.parent_app),
                code: 'PARENT_APP_DISABLED',
                message: 'The Parent app is not switched on for your school. Contact the school office.',
            },
        ];
        const relevant = uses.filter((u) => u.holds && (!app || u.app === app));
        if (relevant.some((u) => u.on))
            return null;
        const off = relevant[0];
        if (off)
            return { code: off.code, message: off.message, rank: 4 };
        if (app === 'teacher' || app === 'parent')
            return wrongApp(app);
        return {
            code: 'ADMIN_PANEL_NOT_ALLOWED',
            message: 'Only the School Admin can sign in to the admin panel.',
            rank: 1,
        };
    }
    async roleCodes(membershipId) {
        const now = this.deps.clock.now();
        const rows = await this.deps.db
            .select({ code: roles.code })
            .from(roleAssignments)
            .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
            .where(and(eq(roleAssignments.membershipId, membershipId), eq(roleAssignments.status, 'ACTIVE'), eq(roles.status, 'ACTIVE'), eq(roles.tenantKey, 'SYSTEM'), or(isNull(roleAssignments.startsAt), lte(roleAssignments.startsAt, now)), or(isNull(roleAssignments.endsAt), gt(roleAssignments.endsAt, now))));
        return new Set(rows.map((r) => r.code));
    }
}
function wrongApp(app) {
    return app === 'teacher'
        ? { code: 'NOT_A_TEACHER', message: 'This login is not a teacher login.', rank: 1 }
        : { code: 'NOT_A_PARENT', message: 'This login is not a parent login.', rank: 1 };
}
