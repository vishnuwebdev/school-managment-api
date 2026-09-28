import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { authenticate, tenantScope, permit, grants } from '../../core/middleware.js';
import { asyncRoute, badRequest, conflict, notFound, forbidden, unauthorized } from '../../core/errors.js';
import { db } from '../../db/index.js';
import { env } from '../../config/env.js';
import { isKnownPermission, PERMISSION_SET } from '../../core/permissions.js';
import { isKnownPermissionV2 } from '../../core/permissionsV2.js';
import { getSecurityPolicy, sanitizeProfilePayload, validatePasswordAgainstPolicy } from '../settings/service.js';

export const usersRouter = Router();

// My Account (edusphere-settings-module-plan-2026-09-23.md) -- self-
// service on the caller's own record, so these are gated on `authenticate`
// alone, never `tenantScope`/`permit`. A platform Super Admin has no
// tenant (tenantId is null), and tenantScope would reject that -- these
// three routes are the one place in this file that must work identically
// for all three roles, so they read/write by req.auth.sub directly
// instead. Mounted before the tenant-scoped routes below so '/me' can
// never be shadowed by an unrelated ':id' param route.
usersRouter.get('/me', authenticate, asyncRoute(async (req, res) => {
  const user = await db.users.findById(req.auth.sub);
  if (!user) throw notFound('User not found');
  res.json({ data: { id: user.id, email: user.email, fullName: user.fullName, phone: user.phone || '', tenantId: user.tenantId, roles: user.roleKeys, lastLoginAt: user.lastLoginAt } });
}));

usersRouter.patch('/me', authenticate, asyncRoute(async (req, res) => {
  const clean = sanitizeProfilePayload(req.body);
  const user = await db.users.updateProfile(req.auth.tenantId, req.auth.sub, clean);
  if (!user) throw notFound('User not found');
  await db.audit.record({ event: 'user.profile_updated', actorId: user.id, target: user.id, tenantId: req.auth.tenantId || 'platform' });
  res.json({ data: { id: user.id, email: user.email, fullName: user.fullName, phone: user.phone || '' } });
}));

usersRouter.post('/me/password', authenticate, asyncRoute(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) throw badRequest('currentPassword and newPassword are required');
  const user = await db.users.findById(req.auth.sub);
  if (!user) throw notFound('User not found');
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) throw unauthorized('Current password is incorrect');
  const policy = await getSecurityPolicy(user.tenantId);
  validatePasswordAgainstPolicy(newPassword, policy);
  const passwordHash = await bcrypt.hash(newPassword, env.bcryptRounds);
  await db.users.updateSecurity(user.id, { passwordHash, failedLoginAttempts: 0, lockedUntil: null });
  await db.audit.record({ event: 'user.password_changed', actorId: user.id, target: user.id, tenantId: user.tenantId || 'platform' });
  res.status(204).send();
}));

usersRouter.get('/', authenticate, tenantScope, permit('users.view'), asyncRoute(async (req, res) => {
  const users = await db.users.listByTenant(req.tenantId);
  // Adapter-agnostic safety net: the mysql adapter already returns a safe
  // subset, but the memory and mongo adapters return the raw stored user
  // record (memory: unmodified; mongo's `strip()` only drops `_id`), which
  // includes `passwordHash`. Map to a known-safe shape here so this route
  // never leaks a credential regardless of which adapter answered it.
  res.json({
    data: users.map((u) => ({
      id: u.id,
      tenantId: u.tenantId,
      email: u.email,
      fullName: u.fullName,
      phone: u.phone || '',
      roleKeys: u.roleKeys,
      status: u.status,
      lastLoginAt: u.lastLoginAt,
    })),
  });
}));

usersRouter.post('/', authenticate, tenantScope, permit('users.create'), asyncRoute(async (req, res) => {
  const { email, fullName, roleKey, temporaryPassword } = req.body || {};
  if (![email, fullName, roleKey, temporaryPassword].every(Boolean)) {
    throw badRequest('email, fullName, roleKey and temporaryPassword are required');
  }
  if (await db.users.findByEmail(email)) throw conflict('A user with this email already exists');
  if (roleKey === 'super_admin') throw forbidden('The Super Admin role cannot be assigned from here');
  const role = await db.roles.findByKey(req.tenantId, roleKey);
  if (!role) throw badRequest(`Unknown role "${roleKey}" for this school`);
  validatePasswordAgainstPolicy(temporaryPassword, await getSecurityPolicy(req.tenantId));
  const passwordHash = await bcrypt.hash(temporaryPassword, env.bcryptRounds);
  const user = await db.users.create({ tenantId: req.tenantId, email, fullName, passwordHash, roleKeys: [roleKey] });
  await db.audit.record({ event: 'user.created', actorId: req.auth.sub, target: user.id, tenantId: req.tenantId });
  res.status(201).json({ data: { id: user.id, email: user.email, fullName: user.fullName, roleKeys: user.roleKeys, status: user.status } });
}));

usersRouter.patch('/:id/status', authenticate, tenantScope, permit('users.deactivate'), asyncRoute(async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'inactive'].includes(status)) throw badRequest('status must be "active" or "inactive"');
  const user = await db.users.setStatus(req.tenantId, req.params.id, status);
  if (!user) throw notFound('User not found');
  await db.audit.record({ event: 'user.status_changed', actorId: req.auth.sub, target: user.id, tenantId: req.tenantId, summary: { status } });
  res.json({ data: user });
}));

usersRouter.get('/roles', authenticate, tenantScope, permit('roles.view'), asyncRoute(async (req, res) => {
  res.json({ data: await db.roles.list(req.tenantId) });
}));

// Turns a free-text role name into a stable, storage-safe key --
// 'Fee Collector' -> 'fee_collector'. Kept intentionally simple (no
// transliteration, no uniqueness retry loop): a collision just asks the
// admin to pick a different name via the 409 below, which is simpler
// and more predictable than silently appending a suffix.
function slugifyRoleKey(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const RESERVED_ROLE_KEYS = new Set(['super_admin', 'school_admin', 'sub_admin']);

// Role creation (RBAC plan doc's "New UI this requires" -- Roles &
// Permissions is rebuilt to create roles, not only edit the single
// pre-seeded Sub Admin one). Every check the existing PUT .../permissions
// endpoint below already enforces is repeated here for the same reason:
// a brand-new role is exactly as capable of exceeding the grantor's own
// ceiling as an edited one.
usersRouter.post('/roles', authenticate, tenantScope, permit('users:roles:write'), asyncRoute(async (req, res) => {
  const { name, permissions } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) throw badRequest('A role name is required');
  if (!Array.isArray(permissions)) throw badRequest('permissions must be an array of permission keys');

  const key = slugifyRoleKey(name);
  if (!key) throw badRequest('That name does not produce a usable role key -- try adding a letter or number');
  if (RESERVED_ROLE_KEYS.has(key)) throw conflict(`"${name}" is reserved for a built-in role`);
  if (await db.roles.findByKey(req.tenantId, key)) throw conflict(`A role named "${name}" already exists for this school`);

  const unknown = permissions.filter((p) => !isKnownPermission(p) && !isKnownPermissionV2(p, PERMISSION_SET));
  if (unknown.length) throw badRequest(`Unknown permission key(s): ${unknown.join(', ')}`);

  const grantorPermissions = await db.roles.permissionsForKeys(req.tenantId, req.auth.roles || [req.auth.role]);
  const beyondCeiling = permissions.filter((p) => !grants(grantorPermissions, p));
  if (beyondCeiling.length) {
    throw forbidden(`You cannot grant permission(s) you do not hold yourself: ${beyondCeiling.join(', ')}`);
  }

  const role = await db.roles.create({ tenantId: req.tenantId, key, name: name.trim(), permissions, isSystem: false });
  await db.audit.record({ event: 'role.created', actorId: req.auth.sub, target: role.key, tenantId: req.tenantId, summary: { name: role.name, permissions } });
  res.status(201).json({ data: role });
}));

// Change an existing user's role(s) -- the one capability the old flat
// model defined a key for ('users.update') but no route ever checked;
// see the FEATURE_CATALOG comment in core/permissionsV2.js. Same
// super_admin guard as invite, for the same reason.
usersRouter.patch('/:id/roles', authenticate, tenantScope, permit('users:role-assignment:update'), asyncRoute(async (req, res) => {
  const { roleKeys } = req.body || {};
  if (!Array.isArray(roleKeys) || roleKeys.length === 0) throw badRequest('roleKeys must be a non-empty array');
  if (roleKeys.includes('super_admin')) throw forbidden('The Super Admin role cannot be assigned from here');

  for (const key of roleKeys) {
    if (!(await db.roles.findByKey(req.tenantId, key))) throw badRequest(`Unknown role "${key}" for this school`);
  }

  const user = await db.users.setRoles(req.tenantId, req.params.id, roleKeys);
  if (!user) throw notFound('User not found');
  await db.audit.record({ event: 'user.roles_changed', actorId: req.auth.sub, target: user.id, tenantId: req.tenantId, summary: { roleKeys } });
  res.json({ data: user });
}));

// A school admin can reshape what its own "Sub Admin" (or any non-system
// role) grants, per context.md: "Sub admin access with feature and feature
// particular operation access." System roles (super_admin, school_admin)
// are protected so a tenant can't accidentally lock itself out.
//
// RBAC rewrite -- two checks added that the original endpoint never had:
// every submitted key must be a real, known permission (old or new
// format), and the grantor can never hand out a permission they do not
// themselves hold. That second check is the "delegation ceiling" the
// RBAC plan doc calls for -- previously any user with roles.manage could
// set a role's permissions to literally anything, including permissions
// the grantor lacked, which was a real, exploitable gap.
usersRouter.put('/roles/:key/permissions', authenticate, tenantScope, permit('roles.manage'), asyncRoute(async (req, res) => {
  const { permissions } = req.body || {};
  if (!Array.isArray(permissions)) throw badRequest('permissions must be an array of permission keys');
  const role = await db.roles.findByKey(req.tenantId, req.params.key);
  if (!role) throw notFound('Role not found');
  if (role.isSystem) throw badRequest('System roles cannot be modified');

  const unknown = permissions.filter((p) => !isKnownPermission(p) && !isKnownPermissionV2(p, PERMISSION_SET));
  if (unknown.length) throw badRequest(`Unknown permission key(s): ${unknown.join(', ')}`);

  const grantorPermissions = await db.roles.permissionsForKeys(req.tenantId, req.auth.roles || [req.auth.role]);
  const beyondCeiling = permissions.filter((p) => !grants(grantorPermissions, p));
  if (beyondCeiling.length) {
    throw forbidden(`You cannot grant permission(s) you do not hold yourself: ${beyondCeiling.join(', ')}`);
  }

  const updated = await db.roles.updatePermissions(req.tenantId, req.params.key, permissions);
  await db.audit.record({ event: 'role.permissions_updated', actorId: req.auth.sub, target: role.key, tenantId: req.tenantId, summary: { permissions } });
  res.json({ data: updated });
}));
