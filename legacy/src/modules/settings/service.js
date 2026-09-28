import { badRequest } from '../../core/errors.js';
import { db } from '../../db/index.js';

// Settings module (edusphere-settings-module-plan-2026-09-23.md) --
// business rules shared by users/routes.js (My Account) and this
// module's own routes.js (Regional Format, Security Policy).
//
// Security Policy is one row per tenant, same "get/upsert, defaults when
// no row" shape as attendanceSettings/feeSettings/classStructureSettings
// elsewhere in this codebase. The defaults below deliberately reproduce
// EXACTLY what this codebase already does today (8-char minimum, no
// complexity rules, no expiry, the same 8-hour session env.jwtExpiresIn
// default, 5 attempts / 15-minute lockout) so building this table and
// screen never silently changes a tenant's behaviour until an admin
// actually opens Security Policy and changes something.
export const SECURITY_POLICY_DEFAULTS = {
  minPasswordLength: 8,
  requireUppercase: false,
  requireNumber: false,
  requireSymbol: false,
  passwordExpiryDays: 0, // 0 = never expires
  sessionTimeoutMinutes: 480, // matches env.jwtExpiresIn's default of 8h
  maxFailedLoginAttempts: 5,
  lockoutDurationMinutes: 15,
};

// Regional Format's own defaults -- unchanged from what
// school_setup/routes.js's old `preferences` section already defaulted
// new tenants to, minus the 3 dead delivery-medium toggles AND the
// language field (dropped -- there is no i18n string system anywhere in
// this app, so a language picker had nothing real to control; see
// edusphere-settings-module-build-summary-2026-09-23.md).
export const REGIONAL_DEFAULTS = {
  dateFormat: 'DD/MM/YYYY',
  timeFormat: '12 Hour',
  currency: 'INR',
};

// Every tenant should have a security_policies row after seeding, but a
// tenant created before this module existed (or a fresh mysql/mongo
// database someone forgot to re-seed) won't -- so every caller reads
// through this helper rather than db.securityPolicies.get() directly,
// the same "missing row = sensible default" precedent
// core/entitlements.js's isFeatureEnabled() already set for this codebase.
export async function getSecurityPolicy(tenantId) {
  if (!tenantId) return { tenantId: null, ...SECURITY_POLICY_DEFAULTS };
  const row = await db.securityPolicies.get(tenantId);
  return row ? { ...SECURITY_POLICY_DEFAULTS, ...row } : { tenantId, ...SECURITY_POLICY_DEFAULTS };
}

const isBool = (v) => typeof v === 'boolean';

export function sanitizeSecurityPolicyPayload(body) {
  body = body || {};
  const errors = [];
  const out = {};

  const wantInt = (key, { min = 0, max = Infinity } = {}) => {
    if (body[key] === undefined) return;
    const value = Number(body[key]);
    if (!Number.isInteger(value) || value < min || value > max) {
      errors.push(`${key} must be a whole number between ${min} and ${max === Infinity ? 'no limit' : max}`);
      return;
    }
    out[key] = value;
  };

  wantInt('minPasswordLength', { min: 4, max: 64 });
  wantInt('passwordExpiryDays', { min: 0, max: 3650 });
  wantInt('sessionTimeoutMinutes', { min: 5, max: 43200 }); // 5 minutes .. 30 days
  wantInt('maxFailedLoginAttempts', { min: 3, max: 20 });
  wantInt('lockoutDurationMinutes', { min: 1, max: 1440 });

  for (const key of ['requireUppercase', 'requireNumber', 'requireSymbol']) {
    if (body[key] === undefined) continue;
    if (!isBool(body[key])) { errors.push(`${key} must be true or false`); continue; }
    out[key] = body[key];
  }

  if (errors.length) throw badRequest(errors.join('; '));
  return out;
}

export function sanitizeRegionalPayload(body) {
  body = body || {};
  const out = {};
  const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];
  const TIME_FORMATS = ['12 Hour', '24 Hour'];

  if (body.dateFormat !== undefined) {
    if (!DATE_FORMATS.includes(body.dateFormat)) throw badRequest(`dateFormat must be one of ${DATE_FORMATS.join(', ')}`);
    out.dateFormat = body.dateFormat;
  }
  if (body.timeFormat !== undefined) {
    if (!TIME_FORMATS.includes(body.timeFormat)) throw badRequest(`timeFormat must be one of ${TIME_FORMATS.join(', ')}`);
    out.timeFormat = body.timeFormat;
  }
  if (body.currency !== undefined) {
    if (typeof body.currency !== 'string' || !body.currency.trim()) throw badRequest('currency is required');
    out.currency = body.currency.trim().toUpperCase().slice(0, 10);
  }
  return out;
}

// My Account's editable profile fields -- deliberately just fullName and
// phone. Email is the login identity (account-recovery-sensitive, left
// out of v1 per the plan doc) and roleKeys/status are managed exclusively
// through User Management, never through self-service.
export function sanitizeProfilePayload(body) {
  body = body || {};
  const out = {};
  if (body.fullName !== undefined) {
    if (typeof body.fullName !== 'string' || !body.fullName.trim()) throw badRequest('fullName cannot be empty');
    out.fullName = body.fullName.trim();
  }
  if (body.phone !== undefined) {
    if (body.phone !== null && typeof body.phone !== 'string') throw badRequest('phone must be a string');
    out.phone = body.phone ? body.phone.trim() : null;
  }
  return out;
}

// Enforced at both invite time (users/routes.js) and self-service change-
// password time (users/routes.js's POST /me/password) so a policy the
// admin sets on the Security Policy screen actually means something
// rather than only being enforced in one of the two places a password is
// ever set.
export function validatePasswordAgainstPolicy(password, policy) {
  if (typeof password !== 'string' || password.length < policy.minPasswordLength) {
    throw badRequest(`Password must be at least ${policy.minPasswordLength} characters`);
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    throw badRequest('Password must include at least one uppercase letter');
  }
  if (policy.requireNumber && !/[0-9]/.test(password)) {
    throw badRequest('Password must include at least one number');
  }
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    throw badRequest('Password must include at least one symbol');
  }
}
