import { Router } from 'express';
import { authenticate, tenantScope, permit, validDate } from '../../core/middleware.js';
import { asyncRoute, notFound } from '../../core/errors.js';
import { db } from '../../db/index.js';
import { buildCrudRouter, badRequest } from '../../core/crudRoutes.js';

const ALLOWED_STATUSES = new Set(['upcoming', 'current', 'closed']);

// School Setup > Academic Settings > Academic Year. `status` defaults to
// 'upcoming' on create; becoming 'current' only ever happens through the
// dedicated set-current endpoint below, which also demotes whichever year
// previously held that status (see memoryAdapter.js academicYears.setCurrent
// and the matching mysql/mongo methods) -- a plain PUT can still edit the
// dates/label of a year but not hand it "current" for free.
export const academicYearsRouter = buildCrudRouter({
  collection: 'academicYears',
  viewPermission: 'academicYears.view',
  managePermission: 'academicYears.manage',
  event: 'academicYear',
  validate(body, req) {
    const { label, startDate, endDate, status } = body;
    if (!label || typeof label !== 'string') throw badRequest('label is required');
    if (!validDate(startDate) || !validDate(endDate)) throw badRequest('startDate and endDate must be valid YYYY-MM-DD dates');
    if (startDate > endDate) throw badRequest('startDate must not be after endDate');
    const payload = { label: label.trim(), startDate, endDate };
    // Allow explicit non-"current" status changes (e.g. marking a year
    // closed) through the normal PUT; "current" itself is only granted via
    // POST /:id/set-current so exactly one year can ever hold it.
    if (status !== undefined) {
      if (!ALLOWED_STATUSES.has(status) || status === 'current') throw badRequest("status must be 'upcoming' or 'closed' here -- use /:id/set-current to make a year current");
      payload.status = status;
    } else if (req.method === 'POST') {
      payload.status = 'upcoming';
    }
    return payload;
  },
});

academicYearsRouter.post('/:id/set-current', authenticate, tenantScope, permit('academicYears.manage'), asyncRoute(async (req, res) => {
  const year = await db.academicYears.setCurrent(req.tenantId, req.params.id);
  if (!year) throw notFound('Academic year not found');
  await db.audit.record({ event: 'academicYear.setCurrent', actorId: req.auth.sub, target: year.id, tenantId: req.tenantId });
  res.json({ data: year });
}));

// School Setup > Academic Settings > Terms & Periods. Nested under a year
// via ?academicYearId=... on GET and a required field on POST -- kept as
// its own top-level route (/api/academic-terms) rather than truly nested
// (/api/academic-years/:id/terms) to reuse buildCrudRouter as-is.
export const academicTermsRouter = buildCrudRouter({
  collection: 'academicTerms',
  viewPermission: 'academicYears.view',
  managePermission: 'academicYears.manage',
  event: 'academicTerm',
  extraListFilter: (req) => ({ academicYearId: req.query.academicYearId }),
  async validate(body, req) {
    const { academicYearId, name, startDate, endDate } = body;
    if (!academicYearId || typeof academicYearId !== 'string') throw badRequest('academicYearId is required');
    if (!name || typeof name !== 'string') throw badRequest('name is required');
    if (!validDate(startDate) || !validDate(endDate)) throw badRequest('startDate and endDate must be valid YYYY-MM-DD dates');
    if (startDate > endDate) throw badRequest('startDate must not be after endDate');
    const year = await db.academicYears.findById(req.tenantId, academicYearId);
    if (!year) throw badRequest('academicYearId does not refer to an academic year in this school');
    return { academicYearId, name: name.trim(), startDate, endDate };
  },
});
