import { db } from '../db/index.js';

// Tier one of the two-tier RBAC model: does this SCHOOL have a feature at
// all, independent of any user's role/permissions within it. Feature-level
// granularity only (not per-page) -- see the RBAC plan doc. Missing a
// row for a given tenant+feature means "no entitlement decision has been
// made yet", and this defaults that to ENABLED rather than disabled --
// a deliberate choice so introducing entitlements for a feature nobody
// has explicitly toggled yet (e.g. every school that existed before this
// table did) never silently locks a school out of something it already
// had. Super Admin can still explicitly disable it per school; only the
// *absence* of any decision defaults open. This is a real, disclosed
// judgment call, not an oversight.
export async function isFeatureEnabled(tenantId, featureKey) {
  if (!tenantId) return true; // platform-level requests (no tenant) are never entitlement-gated.
  const rows = await db.schoolEntitlements.list(tenantId);
  const row = rows.find((r) => r.featureKey === featureKey);
  return row ? row.enabled : true;
}
