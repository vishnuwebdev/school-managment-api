import { Router } from 'express';
import { authenticate, tenantScope, permit } from '../../core/middleware.js';
import { asyncRoute } from '../../core/errors.js';
import { db } from '../../db/index.js';
import {
  REGIONAL_DEFAULTS, getSecurityPolicy,
  sanitizeRegionalPayload, sanitizeSecurityPolicyPayload,
} from './service.js';

// Settings module (edusphere-settings-module-plan-2026-09-23.md). Only the
// two tenant-wide pillars live here -- Regional Format and Security
// Policy. My Account (profile/password/login info) lives on the `users`
// resource instead (modules/users/routes.js's /me routes), since it's
// self-service on the caller's own record rather than a tenant-wide
// setting -- see core/permissionsV2.js's `settings` feature comment.
export const settingsRouter = Router();

// Regional Format -- reuses the school_setup module's existing
// `schoolProfile` "preferences" section for storage (no new table) so a
// tenant's existing saved language/date/time/currency values carry over
// unchanged; this module just gives that same data its own dedicated
// route and its own settings:regional:* permission instead of sharing
// school-setup:profile:*, since a role that can manage regional format
// should not thereby also gain the ability to edit the school's branding/
// bank/registration details.
settingsRouter.get('/regional', authenticate, tenantScope, permit('settings:regional:read'), asyncRoute(async (req, res) => {
  const profile = await db.schoolProfile.get(req.tenantId);
  const preferences = profile.preferences && Object.keys(profile.preferences).length ? profile.preferences : REGIONAL_DEFAULTS;
  res.json({ data: { ...REGIONAL_DEFAULTS, ...preferences } });
}));

settingsRouter.put('/regional', authenticate, tenantScope, permit('settings:regional:write'), asyncRoute(async (req, res) => {
  const existing = await db.schoolProfile.get(req.tenantId);
  const clean = sanitizeRegionalPayload(req.body);
  const merged = { ...REGIONAL_DEFAULTS, ...existing.preferences, ...clean };
  const profile = await db.schoolProfile.updateSection(req.tenantId, 'preferences', merged);
  await db.audit.record({ event: 'settings.regional_updated', actorId: req.auth.sub, target: req.tenantId, tenantId: req.tenantId, summary: clean });
  res.json({ data: profile.preferences });
}));

// Security Policy -- brand-new table (security_policies), one row per
// tenant. Reading falls back to SECURITY_POLICY_DEFAULTS (which mirror
// this codebase's actual current behaviour) when a tenant has no row yet,
// so a school that never opens this screen keeps behaving exactly as it
// does today.
settingsRouter.get('/security', authenticate, tenantScope, permit('settings:security:read'), asyncRoute(async (req, res) => {
  res.json({ data: await getSecurityPolicy(req.tenantId) });
}));

settingsRouter.put('/security', authenticate, tenantScope, permit('settings:security:write'), asyncRoute(async (req, res) => {
  const clean = sanitizeSecurityPolicyPayload(req.body);
  const updated = await db.securityPolicies.upsert(req.tenantId, clean);
  await db.audit.record({ event: 'settings.security_updated', actorId: req.auth.sub, target: req.tenantId, tenantId: req.tenantId, summary: clean });
  res.json({ data: { ...(await getSecurityPolicy(req.tenantId)), ...updated } });
}));
