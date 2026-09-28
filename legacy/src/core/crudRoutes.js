import { Router } from 'express';
import { authenticate, tenantScope, permit } from './middleware.js';
import { asyncRoute, badRequest, notFound } from './errors.js';
import { db } from '../db/index.js';

/**
 * Builds a standard list/create/update/delete router for one of the simple
 * tenant-scoped list collections added for School Setup (subjects,
 * holidays, grades, feeTypes, academicYears, academicTerms) -- see
 * db/adapters/memoryAdapter.js's `simpleCollection` and the matching
 * methods in mysqlAdapter.js/mongoAdapter.js, all of which expose the same
 * { list, findById, create, update, remove } contract. Keeping one place
 * that wires permission checks + audit logging + 404 handling means each
 * of those six resources is a handful of lines instead of a near-duplicate
 * route file.
 *
 * @param collection    key on `db` (e.g. 'subjects')
 * @param viewPermission   permission required to GET
 * @param managePermission permission required to POST/PUT/DELETE
 * @param event         audit event prefix, e.g. 'subject' -> subject.created
 * @param validate      (body, req) => sanitized payload, or throws badRequest()
 * @param extraListFilter  optional (req) => filter object passed to list()
 */
export function buildCrudRouter({ collection, viewPermission, managePermission, event, validate, extraListFilter }) {
  const router = Router();

  router.get('/', authenticate, tenantScope, permit(viewPermission), asyncRoute(async (req, res) => {
    const filter = extraListFilter ? extraListFilter(req) : {};
    const data = await db[collection].list(req.tenantId, filter);
    res.json({ data });
  }));

  router.get('/:id', authenticate, tenantScope, permit(viewPermission), asyncRoute(async (req, res) => {
    const record = await db[collection].findById(req.tenantId, req.params.id);
    if (!record) throw notFound();
    res.json({ data: record });
  }));

  router.post('/', authenticate, tenantScope, permit(managePermission), asyncRoute(async (req, res) => {
    const payload = await validate(req.body || {}, req);
    const record = await db[collection].create({ tenantId: req.tenantId, ...payload });
    await db.audit.record({ event: `${event}.created`, actorId: req.auth.sub, target: record.id, tenantId: req.tenantId });
    res.status(201).json({ data: record });
  }));

  router.put('/:id', authenticate, tenantScope, permit(managePermission), asyncRoute(async (req, res) => {
    const existing = await db[collection].findById(req.tenantId, req.params.id);
    if (!existing) throw notFound();
    const payload = await validate(req.body || {}, req);
    const record = await db[collection].update(req.tenantId, req.params.id, payload);
    await db.audit.record({ event: `${event}.updated`, actorId: req.auth.sub, target: record.id, tenantId: req.tenantId });
    res.json({ data: record });
  }));

  router.delete('/:id', authenticate, tenantScope, permit(managePermission), asyncRoute(async (req, res) => {
    const existing = await db[collection].findById(req.tenantId, req.params.id);
    if (!existing) throw notFound();
    await db[collection].remove(req.tenantId, req.params.id);
    await db.audit.record({ event: `${event}.deleted`, actorId: req.auth.sub, target: req.params.id, tenantId: req.tenantId });
    res.status(204).end();
  }));

  return router;
}

export { badRequest };
