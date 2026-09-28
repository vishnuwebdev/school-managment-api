import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { forbidden, unauthorized, badRequest } from './errors.js';
import { db } from '../db/index.js';
import { isV2Permission, featureOf, OLD_TO_NEW, NEW_TO_OLD } from './permissionsV2.js';
import { isFeatureEnabled } from './entitlements.js';

// Verifies the bearer token and attaches the session it encodes. The token
// payload is the ONLY source of truth for who the caller is (sub/role/
// roles/tenantId) -- nothing here ever trusts a role/tenant the client
// sends in the request body. As of the RBAC live-enforcement rewrite the
// token no longer carries a permissions snapshot at all -- see permit()
// below and auth/service.js's issueSession.
export const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return next(unauthorized());
  try {
    req.auth = jwt.verify(token, env.jwtSecret);
    next();
  } catch {
    next(unauthorized('Invalid or expired session'));
  }
};

// Resolves everything the caller's role(s) grant RIGHT NOW, hitting the
// database fresh on every call rather than trusting anything baked into
// the JWT (RBAC plan doc, "live enforcement"). A role edit -- or
// deactivating a user -- takes effect on the very next request, not the
// user's next login.
async function resolveLivePermissions(req) {
  const tenantId = req.tenantId ?? req.auth.tenantId;
  return db.roles.permissionsForKeys(tenantId, req.auth.roles || [req.auth.role]);
}

// True if `granted` (a role's raw, live-resolved permission list) covers
// `required`, treating an old flat key and its new feature:page:action
// equivalent(s) as the same permission wherever one has been migrated
// (see core/permissionsV2.js's OLD_TO_NEW/NEW_TO_OLD maps -- both are
// old-key -> array-of-new-keys shaped, since a single old key can have
// split into more than one new one, e.g. 'students.archive'). This is
// the compatibility bridge the RBAC plan doc calls for: it lets a role
// stored with either format satisfy a check written in either format,
// so migrating one module's routes never requires migrating its seeded
// roles in the same breath. Matching ANY equivalent is correct here --
// e.g. a role holding old 'students.archive' must satisfy a check for
// EITHER of the two new keys it split into.
export function grants(granted, required) {
  if (granted.includes(required)) return true;
  const equivalents = [...(OLD_TO_NEW[required] || []), ...(NEW_TO_OLD[required] || [])];
  return equivalents.some((key) => granted.includes(key));
}

// Requires a specific permission on the verified session. Accepts either a
// single permission key or a function of (req) => permission key, so a
// route can choose e.g. attendance.create vs attendance.update at runtime.
// For a new-format (feature:page:action) key, also enforces the school's
// tier-one feature entitlement -- a role can hold a permission the
// school itself isn't entitled to, and that must still be denied.
export const permit = (permission) => async (req, res, next) => {
  try {
    const required = typeof permission === 'function' ? permission(req) : permission;
    const granted = await resolveLivePermissions(req);
    if (!grants(granted, required)) return next(forbidden());
    if (isV2Permission(required)) {
      const tenantId = req.tenantId ?? req.auth.tenantId;
      const enabled = await isFeatureEnabled(tenantId, featureOf(required));
      if (!enabled) return next(forbidden('This feature is not enabled for your school'));
    }
    next();
  } catch (err) {
    next(err);
  }
};

// Resolves the tenant/school context for the request. A normal user is
// always scoped to the school in their own session. A Super Admin may act
// across schools ONLY with an explicit platform permission AND an explicit
// selected-tenant header — they can never "fall into" another school by
// omission (spec section 8: no implicit cross-school access). The
// permission check here is now also live, for the same reason permit()'s
// is -- see resolveLivePermissions above.
export const tenantScope = async (req, res, next) => {
  try {
    const requestedTenant = req.headers['x-tenant-id'];
    if (requestedTenant && req.auth.role !== 'super_admin') {
      return next(forbidden('Only a platform Super Admin may select a tenant context'));
    }
    if (requestedTenant) {
      const granted = await db.roles.permissionsForKeys(req.auth.tenantId, req.auth.roles || [req.auth.role]);
      if (!granted.includes('platform.schools.manage')) return next(forbidden());
    }
    req.tenantId = requestedTenant || req.auth.tenantId;
    if (!req.tenantId) return next(badRequest('Tenant context required'));
    next();
  } catch (err) {
    next(err);
  }
};

export const validDate = (value) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
