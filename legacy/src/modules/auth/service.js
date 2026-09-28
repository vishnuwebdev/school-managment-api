import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from '../../db/index.js';
import { env } from '../../config/env.js';
import { unauthorized, forbidden } from '../../core/errors.js';
import { getSecurityPolicy } from '../settings/service.js';

// Builds the JWT for a user. RBAC live-enforcement rewrite: the token
// payload now carries identity only (sub/role/roles/tenantId) -- never a
// permissions snapshot. core/middleware.js's permit() re-resolves current
// permissions from the database on every request instead, so a role or
// entitlement change takes effect on the user's very next request rather
// than their next login (see the RBAC plan doc).
//
// `permissions` is still computed here and returned in this login
// response's `user` object, but only as a client-side UI convenience --
// Flutter's SessionState.can()/canAny() use it purely to show/hide
// buttons; it is never trusted as an authorization decision, which the
// server makes fresh on every call regardless of what the client
// believes. That UI hint itself still only refreshes at login (making
// every screen live-refresh it is out of scope for this pass) -- a real,
// disclosed limitation: immediately after a revoke, a user could briefly
// see a button whose click the server correctly rejects. That's a strict
// improvement over the prior behaviour, where the stale permissions were
// also the enforcement source of truth.
async function issueSession(user) {
  const permissions = await db.roles.permissionsForKeys(user.tenantId, user.roleKeys);
  const primaryRole = user.roleKeys[0];
  const payload = { sub: user.id, role: primaryRole, roles: user.roleKeys, tenantId: user.tenantId };
  // Security Policy's sessionTimeoutMinutes (edusphere-settings-module-
  // plan-2026-09-23.md) -- falls back to env.jwtExpiresIn for a platform
  // Super Admin (no tenantId) or a tenant with no policy row yet, so this
  // is a strict opt-in: nothing changes for anyone until an admin opens
  // Security Policy and sets a value.
  const policy = await getSecurityPolicy(user.tenantId);
  const expiresIn = user.tenantId ? `${policy.sessionTimeoutMinutes}m` : env.jwtExpiresIn;
  const token = jwt.sign(payload, env.jwtSecret, { expiresIn });
  return { token, user: { id: user.id, email: user.email, fullName: user.fullName, tenantId: user.tenantId, roles: user.roleKeys, permissions } };
}

export async function login({ email, password }) {
  const user = email && (await db.users.findByEmail(email));
  if (!user || user.status !== 'active') throw unauthorized('Invalid email or password');

  // Account lockout (Security Policy) -- checked before the password
  // compare so a locked account can't be brute-forced during its own
  // lockout window even with the correct password.
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    const minutesLeft = Math.max(1, Math.ceil((new Date(user.lockedUntil) - new Date()) / 60000));
    throw unauthorized(`Too many failed attempts. Try again in ${minutesLeft} minute(s).`);
  }

  const valid = await bcrypt.compare(password || '', user.passwordHash);
  if (!valid) {
    const policy = await getSecurityPolicy(user.tenantId);
    const failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
    const lockedUntil = failedLoginAttempts >= policy.maxFailedLoginAttempts
      ? new Date(Date.now() + policy.lockoutDurationMinutes * 60000).toISOString()
      : null;
    await db.users.updateSecurity(user.id, { failedLoginAttempts, lockedUntil });
    throw unauthorized('Invalid email or password');
  }

  await db.users.recordLogin(user.id);
  await db.audit.record({ event: 'auth.login', actorId: user.id, target: user.id, tenantId: user.tenantId || 'platform' });
  return issueSession(user);
}

// Convenience shortcut for local development only — mints a session for a
// seeded demo account without a password, so the app is explorable before
// real user management screens exist. Disabled entirely unless
// ALLOW_DEV_LOGIN=true, and never available for a role it can't find in
// the database (so it can't be used to fabricate an arbitrary tenant).
export async function devLogin({ role = 'school_admin' }) {
  if (!env.allowDevLogin) throw forbidden('Dev login is disabled. Set ALLOW_DEV_LOGIN=true for local development only.');
  const emailByRole = {
    super_admin: 'superadmin@edusphere.app',
    school_admin: 'admin@brightfuture.edu',
    sub_admin: 'subadmin@brightfuture.edu',
  };
  const email = emailByRole[role];
  if (!email) throw unauthorized(`No seeded dev account for role "${role}"`);
  const user = await db.users.findByEmail(email);
  if (!user) throw unauthorized('Seed data has not been created yet — run the API once to auto-seed, or `npm run seed`.');
  return issueSession(user);
}
