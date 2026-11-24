/**
 * Simple product mode (PRODUCT_MODE=simple, the default).
 *
 * - Every school gets every built feature: no plans, subscriptions or billing.
 * - Only two people sign in to the admin panel: the Super Admin (platform) and each school's
 *   School Admin. Platform sub-users and school sub-users (Principal, Accountant, custom
 *   roles, ...) are switched off; their accounts stay in the database.
 * - The Super Admin switches the Teacher app and the Parent app on or off per school
 *   (an ADMIN_OVERRIDE GRANT on the app's feature). Only teachers / parents of a school with
 *   the app on can sign in to that app, and the school office sees app-only features only
 *   while the app is on.
 *
 * The full model's code stays in place (PRODUCT_MODE=full) so it can be brought back later.
 */
export const isSimpleMode = (env) => env.PRODUCT_MODE !== 'full';
/** The two per-school app switches and the feature each one turns on. */
export const APP_FEATURES = {
    teacher_app: 'teachers.mobile_app',
    parent_app: 'parent_portal',
};
/**
 * Features that only make sense while an app is on, so the office does not see them otherwise:
 * - teacher app: inviting teachers to the app, setting their app password / PIN;
 * - parent app: notices (guardians read them in the app) — complaints & feedback and
 *   detail requests are already part of `parent_portal`.
 */
export const APP_LINKED_FEATURES = {
    'teachers.mobile_app': ['teachers.portal'],
    parent_portal: ['communication'],
};
/** Features that belong to the switched-off sub-user model. */
export const SIMPLE_MODE_OFF_FEATURES = ['custom_roles'];
/** The only roles that may sign in to the admin panel in simple mode. */
export const ADMIN_PANEL_ROLES = { platform: 'SUPER_ADMIN', school: 'SCHOOL_ADMIN' };
/**
 * API paths that are not served in simple mode (sub-users, roles, plans, subscriptions,
 * billing). The modules stay in the code base for later.
 */
export const SIMPLE_MODE_HIDDEN_PATHS = [
    /^\/members(\/|$)/,
    /^\/roles(\/|$)/,
    /^\/permissions$/,
    /^\/platform\/users(\/|$)/,
    /^\/platform\/roles$/,
    /^\/platform\/plans(\/|$)/,
    /^\/platform\/billing(\/|$)/,
    /^\/platform\/tenants\/:id\/billing(\/|$)/,
    /^\/platform\/tenants\/:id\/subscriptions(\/|$)/,
    /^\/platform\/tenants\/:id\/entitlements(\/|$)/,
    /^\/tenants\/current\/subscription$/,
    /^\/tenants\/current\/billing(\/|$)/,
];
