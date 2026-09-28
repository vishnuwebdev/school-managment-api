import { Router } from 'express';
import { authenticate, tenantScope, permit, validDate } from '../../core/middleware.js';
import { asyncRoute, badRequest, notFound } from '../../core/errors.js';
import { db } from '../../db/index.js';

// Leave & Attendance (real half of designs/Teacher feature UI mockup's
// screen 6 -- see staff_leave schema.sql comment for why the fabricated
// daily attendance-calendar heatmap is cut).
//
// RBAC rewrite: migrated to the new feature:page:action permission model
// -- this whole router now maps onto ONE 'staff:leave:*' page in
// core/permissionsV2.js's 'staff' entry (list + balance as read, record
// leave as write, approve/decline as update) rather than getting its own
// top-level feature, since it's tightly coupled to the staff module and
// was already sharing staff.view/staff.update with it. The old
// staff.view/staff.update keys still work here via the OLD_TO_NEW compat
// bridge. Still no self-service teacher portal, so every call here
// remains an admin acting on someone else's record.
export const staffLeaveRouter = Router();

// South African BCEA-style categories, matching the design's leave labels.
// Entitlements are annual caps used only to compute the balance bars on a
// staff profile -- null means "no cap tracked" (unpaid leave).
export const LEAVE_TYPES = ['Annual leave', 'Sick leave', 'Family responsibility', 'Study leave', 'Unpaid leave'];
export const LEAVE_ENTITLEMENTS = { 'Annual leave': 22, 'Sick leave': 10, 'Family responsibility': 3, 'Study leave': 5, 'Unpaid leave': null };

function daysBetweenInclusive(start, end) {
  const ms = new Date(end) - new Date(start);
  return Math.round(ms / 86400000) + 1;
}

function sanitizeLeavePayload(body) {
  body = body || {};
  const { staffId, leaveType, startDate, endDate, reason = '' } = body;
  if (!staffId || typeof staffId !== 'string') throw badRequest('staffId is required');
  if (!LEAVE_TYPES.includes(leaveType)) throw badRequest(`leaveType must be one of ${LEAVE_TYPES.join(', ')}`);
  if (!validDate(startDate)) throw badRequest('startDate must be a valid YYYY-MM-DD date');
  if (!validDate(endDate)) throw badRequest('endDate must be a valid YYYY-MM-DD date');
  if (endDate < startDate) throw badRequest('endDate cannot be before startDate');
  if (typeof reason !== 'string') throw badRequest('reason must be a string');
  return { staffId, leaveType, startDate, endDate, daysCount: daysBetweenInclusive(startDate, endDate), reason: reason.trim() || null };
}

staffLeaveRouter.get('/', authenticate, tenantScope, permit('staff:leave:read'), asyncRoute(async (req, res) => {
  const { staffId, status } = req.query;
  const leave = await db.staffLeave.list(req.tenantId, { staffId, status });
  const staff = await db.staff.list(req.tenantId, {});
  const byId = Object.fromEntries(staff.map((s) => [s.id, s]));
  const data = leave.map((l) => ({ ...l, staffName: byId[l.staffId] ? `${byId[l.staffId].firstName} ${byId[l.staffId].lastName}` : null }));
  res.json({ data, meta: { total: data.length } });
}));

staffLeaveRouter.post('/', authenticate, tenantScope, permit('staff:leave:write'), asyncRoute(async (req, res) => {
  const clean = sanitizeLeavePayload(req.body);
  const staffMember = await db.staff.findById(req.tenantId, clean.staffId);
  if (!staffMember) throw notFound('Staff member not found');
  const leave = await db.staffLeave.create({ tenantId: req.tenantId, ...clean });
  await db.audit.record({ event: 'staff.leaveRequested', actorId: req.auth.sub, target: leave.id, tenantId: req.tenantId, summary: { staffId: clean.staffId, leaveType: clean.leaveType } });
  res.status(201).json({ data: leave });
}));

staffLeaveRouter.patch('/:id/decide', authenticate, tenantScope, permit('staff:leave:update'), asyncRoute(async (req, res) => {
  const { status } = req.body || {};
  if (!['approved', 'declined'].includes(status)) throw badRequest('status must be "approved" or "declined"');
  const leave = await db.staffLeave.findById(req.tenantId, req.params.id);
  if (!leave) throw notFound('Leave request not found');
  const updated = await db.staffLeave.decide(req.tenantId, req.params.id, { status, decidedBy: req.auth.sub });
  await db.audit.record({ event: `staff.leave${status === 'approved' ? 'Approved' : 'Declined'}`, actorId: req.auth.sub, target: leave.id, tenantId: req.tenantId });
  res.json({ data: updated });
}));

// Per-type balance for a staff member's Profile > Leave tab -- entitlement
// minus approved days used within the current calendar year.
staffLeaveRouter.get('/balance/:staffId', authenticate, tenantScope, permit('staff:leave:read'), asyncRoute(async (req, res) => {
  const staffMember = await db.staff.findById(req.tenantId, req.params.staffId);
  if (!staffMember) throw notFound('Staff member not found');
  const leave = await db.staffLeave.list(req.tenantId, { staffId: req.params.staffId, status: 'approved' });
  const year = new Date().getFullYear();
  const data = LEAVE_TYPES.map((type) => {
    const used = leave.filter((l) => l.leaveType === type && l.startDate.startsWith(String(year))).reduce((sum, l) => sum + l.daysCount, 0);
    return { leaveType: type, entitlement: LEAVE_ENTITLEMENTS[type], used, remaining: LEAVE_ENTITLEMENTS[type] === null ? null : Math.max(0, LEAVE_ENTITLEMENTS[type] - used) };
  });
  res.json({ data });
}));
