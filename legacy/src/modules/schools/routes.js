import { Router } from 'express';
import { authenticate, permit } from '../../core/middleware.js';
import { asyncRoute, badRequest, conflict, notFound } from '../../core/errors.js';
import { db } from '../../db/index.js';

// Platform-level module: only a Super Admin with platform.schools.manage
// may see or create schools. There is deliberately no tenantScope here —
// this is the one place in the API that is NOT tenant-scoped, because it
// manages tenants themselves.
export const schoolsRouter = Router();

schoolsRouter.get('/', authenticate, permit('platform.schools.manage'), asyncRoute(async (_req, res) => {
  res.json({ data: await db.schools.list() });
}));

schoolsRouter.post('/', authenticate, permit('platform.schools.manage'), asyncRoute(async (req, res) => {
  const { name, slug } = req.body || {};
  if (!name || !slug) throw badRequest('name and slug are required');
  if (await db.schools.findBySlug(slug)) throw conflict('A school with this slug already exists');
  const school = await db.schools.create({ name, slug });
  await db.audit.record({ event: 'school.created', actorId: req.auth.sub, target: school.id, tenantId: 'platform' });
  res.status(201).json({ data: school });
}));

// Tier one of the two-tier RBAC model (RBAC plan doc): which features a
// school is entitled to at all, set here by Super Admin, independent of
// any role/permission a user within that school holds. Cross-school by
// design (like the rest of this router) -- Super Admin needs to see and
// set every school's entitlements from one screen, not one tenant at a
// time via the usual x-tenant-id + tenantScope path.
schoolsRouter.get('/entitlements', authenticate, permit('platform.schools.manage'), asyncRoute(async (_req, res) => {
  res.json({ data: await db.schoolEntitlements.listAll() });
}));

schoolsRouter.put('/:schoolId/entitlements/:featureKey', authenticate, permit('platform.schools.manage'), asyncRoute(async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') throw badRequest('enabled must be true or false');
  const school = await db.schools.findById(req.params.schoolId);
  if (!school) throw notFound('School not found');
  const row = await db.schoolEntitlements.upsert({
    tenantId: req.params.schoolId,
    featureKey: req.params.featureKey,
    enabled,
    updatedBy: req.auth.sub,
  });
  await db.audit.record({ event: 'school.entitlement_updated', actorId: req.auth.sub, target: req.params.schoolId, tenantId: 'platform', summary: { featureKey: req.params.featureKey, enabled } });
  res.json({ data: row });
}));
