import { Router } from 'express';
import { authenticate, tenantScope, permit, validDate } from '../../core/middleware.js';
import { asyncRoute, badRequest, conflict, notFound } from '../../core/errors.js';
import { db } from '../../db/index.js';
import { REGIONAL_DEFAULTS } from '../settings/service.js';
import {
  validPeriod, sanitizePayProfile, publicPayProfile, calculateRun, runView, generatePayslipPdf, PAYROLL_STAFF_STATUSES,
} from './service.js';

// Payroll (Teachers & Staff > Payroll summary, /staff/payroll, and the
// Payroll tab on every staff profile). See service.js for the calculation
// and scope. Permissions: core/permissionsV2.js's 'staff' entry, page
// 'payroll' -- read (view runs, payslips, pay setups), write (create a
// month's run), update (edit pay setup, recalculate, finalise, mark paid),
// delete (discard a DRAFT run). Deliberately NOT bridged to the old
// staff.view/update keys: salary data is more sensitive than the staff
// directory, so a role must be granted payroll explicitly.
//
// Lifecycle: draft (freely recalculated) -> finalised (locked, payslips are
// a snapshot) -> paid (records the offline payment date/reference).
export const payrollRouter = Router();

async function requireRun(tenantId, runId) {
  const run = await db.payrollRuns.findById(tenantId, runId);
  if (!run) throw notFound('Payroll run not found');
  return run;
}

async function requireStaff(tenantId, staffId) {
  const staff = await db.staff.findById(tenantId, staffId);
  if (!staff) throw notFound('Staff member not found');
  return staff;
}

async function moneyFormatter(tenantId) {
  const profile = await db.schoolProfile.get(tenantId);
  const currency = profile?.preferences?.currency || REGIONAL_DEFAULTS.currency;
  const nf = new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n) => `${currency} ${nf.format(Number(n) || 0)}`;
}

const audit = (req, event, target, summary = {}) =>
  db.audit.record({ event, actorId: req.auth.sub, target, tenantId: req.tenantId, summary });

// --- Pay setup ---

// Every payable staff member with their pay setup (or null) -- feeds the
// "missing pay setup" list and the staff profile tab.
payrollRouter.get('/profiles', authenticate, tenantScope, permit('staff:payroll:read'), asyncRoute(async (req, res) => {
  const [staff, profiles] = await Promise.all([db.staff.list(req.tenantId, {}), db.payProfiles.list(req.tenantId)]);
  const byStaff = new Map(profiles.map((p) => [p.staffId, p]));
  const data = staff
    .filter((s) => PAYROLL_STAFF_STATUSES.has(s.status || 'active'))
    .map((s) => ({
      staffId: s.id, staffName: `${s.firstName} ${s.lastName}`.trim(), employeeId: s.employeeId, department: s.department,
      profile: publicPayProfile(byStaff.get(s.id) || null),
    }));
  res.json({ data, meta: { total: data.length, missing: data.filter((d) => !d.profile).length } });
}));

payrollRouter.get('/staff/:staffId', authenticate, tenantScope, permit('staff:payroll:read'), asyncRoute(async (req, res) => {
  await requireStaff(req.tenantId, req.params.staffId);
  const [profile, payslips] = await Promise.all([
    db.payProfiles.findByStaff(req.tenantId, req.params.staffId),
    db.payslips.listByStaff(req.tenantId, req.params.staffId),
  ]);
  const runs = new Map();
  for (const slip of payslips) if (!runs.has(slip.runId)) runs.set(slip.runId, await db.payrollRuns.findById(req.tenantId, slip.runId));
  res.json({
    data: {
      profile: publicPayProfile(profile),
      payslips: payslips.map(({ tenantId: _t, ...p }) => ({ ...p, runStatus: runs.get(p.runId)?.status || null, paidOn: runs.get(p.runId)?.paidOn || null })),
    },
  });
}));

payrollRouter.put('/profiles/:staffId', authenticate, tenantScope, permit('staff:payroll:update'), asyncRoute(async (req, res) => {
  const staff = await requireStaff(req.tenantId, req.params.staffId);
  const existing = await db.payProfiles.findByStaff(req.tenantId, staff.id);
  const clean = sanitizePayProfile(req.body, existing);
  const saved = await db.payProfiles.upsert(req.tenantId, staff.id, { ...clean, updatedBy: req.auth.sub, updatedAt: new Date().toISOString() });
  // Never log the account number itself.
  await audit(req, 'payroll.payProfileUpdated', staff.id, { basicSalary: clean.basicSalary, allowances: clean.allowances.length, deductions: clean.deductions.length, bankVerified: clean.bank.verified });
  res.json({ data: publicPayProfile(saved) });
}));

// --- Runs ---

payrollRouter.get('/runs', authenticate, tenantScope, permit('staff:payroll:read'), asyncRoute(async (req, res) => {
  const runs = (await db.payrollRuns.list(req.tenantId)).sort((a, b) => b.period.localeCompare(a.period));
  res.json({ data: runs.map(({ tenantId: _t, ...r }) => r) });
}));

payrollRouter.get('/runs/:id', authenticate, tenantScope, permit('staff:payroll:read'), asyncRoute(async (req, res) => {
  const run = await requireRun(req.tenantId, req.params.id);
  res.json({ data: await runView(req.tenantId, run) });
}));

payrollRouter.post('/runs', authenticate, tenantScope, permit('staff:payroll:write'), asyncRoute(async (req, res) => {
  const { period } = req.body || {};
  if (!validPeriod(period)) throw badRequest('period must be a month in YYYY-MM format');
  if (await db.payrollRuns.findByPeriod(req.tenantId, period)) throw conflict(`A payroll run for ${period} already exists`);
  const run = await db.payrollRuns.create({ tenantId: req.tenantId, period, status: 'draft', totals: null, missingProfiles: [], createdBy: req.auth.sub });
  const calculated = await calculateRun(req.tenantId, run);
  await audit(req, 'payroll.runCreated', run.id, { period });
  res.status(201).json({ data: await runView(req.tenantId, calculated) });
}));

payrollRouter.post('/runs/:id/recalculate', authenticate, tenantScope, permit('staff:payroll:update'), asyncRoute(async (req, res) => {
  const run = await requireRun(req.tenantId, req.params.id);
  if (run.status !== 'draft') throw conflict('Only a draft run can be recalculated -- this run is already locked');
  const calculated = await calculateRun(req.tenantId, run);
  await audit(req, 'payroll.runRecalculated', run.id, { period: run.period });
  res.json({ data: await runView(req.tenantId, calculated) });
}));

payrollRouter.post('/runs/:id/finalise', authenticate, tenantScope, permit('staff:payroll:update'), asyncRoute(async (req, res) => {
  const run = await requireRun(req.tenantId, req.params.id);
  if (run.status !== 'draft') throw conflict('This run is already finalised');
  const payslips = await db.payslips.list(req.tenantId, { runId: run.id });
  if (!payslips.length) throw badRequest('There are no payslips to finalise -- set up pay for at least one staff member and recalculate');
  const negative = payslips.filter((p) => p.netPay < 0);
  if (negative.length) throw badRequest(`Fix the deductions first: ${negative.map((p) => p.staffName).join(', ')} would be paid a negative amount`);
  const updated = await db.payrollRuns.update(req.tenantId, run.id, { status: 'finalised', finalisedBy: req.auth.sub, finalisedAt: new Date().toISOString() });
  await audit(req, 'payroll.runFinalised', run.id, { period: run.period });
  res.json({ data: await runView(req.tenantId, updated) });
}));

payrollRouter.post('/runs/:id/mark-paid', authenticate, tenantScope, permit('staff:payroll:update'), asyncRoute(async (req, res) => {
  const run = await requireRun(req.tenantId, req.params.id);
  if (run.status === 'draft') throw conflict('Finalise the run before marking it as paid');
  if (run.status === 'paid') throw conflict('This run is already marked as paid');
  const { paidOn, reference = '' } = req.body || {};
  if (!validDate(paidOn)) throw badRequest('paidOn must be a valid YYYY-MM-DD date');
  if (typeof reference !== 'string' || reference.length > 100) throw badRequest('reference must be text of 100 characters or fewer');
  const updated = await db.payrollRuns.update(req.tenantId, run.id, {
    status: 'paid', paidOn, paidReference: reference.trim() || null, paidBy: req.auth.sub, paidAt: new Date().toISOString(),
  });
  await audit(req, 'payroll.runMarkedPaid', run.id, { period: run.period, paidOn });
  res.json({ data: await runView(req.tenantId, updated) });
}));

payrollRouter.delete('/runs/:id', authenticate, tenantScope, permit('staff:payroll:delete'), asyncRoute(async (req, res) => {
  const run = await requireRun(req.tenantId, req.params.id);
  if (run.status !== 'draft') throw conflict('Only a draft run can be discarded -- finalised and paid runs are kept as a record');
  await db.payslips.removeByRun(req.tenantId, run.id);
  await db.payrollRuns.remove(req.tenantId, run.id);
  await audit(req, 'payroll.runDiscarded', run.id, { period: run.period });
  res.status(204).send();
}));

// --- Payslip PDF ---

payrollRouter.get('/payslips/:id/pdf', authenticate, tenantScope, permit('staff:payroll:read'), asyncRoute(async (req, res) => {
  const payslip = await db.payslips.findById(req.tenantId, req.params.id);
  if (!payslip) throw notFound('Payslip not found');
  const [run, tenant, formatMoney] = await Promise.all([
    requireRun(req.tenantId, payslip.runId), db.schools.findById(req.tenantId), moneyFormatter(req.tenantId),
  ]);
  const pdf = await generatePayslipPdf({ tenant, payslip, run, formatMoney });
  const safeName = `${payslip.employeeId}-${payslip.period}`.replace(/[^A-Za-z0-9-]/g, '');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="payslip-${safeName}.pdf"`);
  res.send(pdf);
}));
