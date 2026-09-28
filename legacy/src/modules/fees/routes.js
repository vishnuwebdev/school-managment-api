import { Router } from 'express';
import { authenticate, tenantScope, permit, validDate } from '../../core/middleware.js';
import { asyncRoute, badRequest, notFound, conflict, forbidden } from '../../core/errors.js';
import { db } from '../../db/index.js';
import { toCsv } from '../../core/csv.js';
import { generateTabularReportPdf } from '../../core/reportPdf.js';
import {
  todayStr, daysBetween, R, getStructureRules, getFeeSettings, getStructureBundle, ensureDraftStructure,
  computeAnnualTotals, phaseForClass, getInvoiceView, raiseInvoicesForTerm, accrueInterest,
  recordPayment, matchBankLine, getStudentBalance, derivePlanState, setupPaymentPlan,
} from './service.js';

// Fees & Payments (designs/Teacher feature UI mockup/Fees and Payments.dc.html,
// 9 screens, /fees). No money moves through the portal -- this is a
// RECORD of an offline collection process: invoices out, payments
// recorded in, balances kept true, a bank statement reconciled against
// it. See service.js's header and the project doc
// (edusphere-fees-payments-module-plan-2026-09-18.md) for the full
// design rationale and every scope decision made with Vishnu before
// writing this:
//  - Fee structure (this module) is a new, richer, versioned model,
//    separate from and NOT touching School Setup's existing fee_types.
//  - Payment plans are real, tracked records.
//  - A bursary is a manual discount line on an invoice -- no separate
//    award-tracking entity.
//  - Bank reconciliation lines are entered by hand -- no statement-file
//    upload this pass.
//  - Guardian communication (invoice emails, receipts, reminders,
//    statements) is honestly not wired -- no Notices & Communication
//    backend exists in this codebase.
//
// Permissions here use the new-format fees:<page>:<action> catalog
// (core/permissionsV2.js) -- see that file's FEATURE_CATALOG entry for
// the full page/action breakdown, including why 'disbursements-approval'
// stays separately grantable from ordinary disbursement create/read
// (mirroring the old fees.refund key's own distinct role -- it never
// guarded a literal refund route, only the approve/decline/mark-paid
// workflow).
export const feesRouter = Router();

const money = (v) => typeof v === 'number' && Number.isFinite(v);

const REPORT_TYPES = new Set(['collection', 'outstanding', 'overdue', 'payment-history', 'daily-collection']);

// --- 01 Collections overview ---------------------------------------------

feesRouter.get('/overview', authenticate, tenantScope, permit('fees:overview:read'), asyncRoute(async (req, res) => {
  const [levels, allInvoicesRaw, allPayments] = await Promise.all([
    db.classLevels.list(req.tenantId),
    db.feeInvoices.list(req.tenantId, {}),
    db.feePayments.list(req.tenantId, {}),
  ]);
  const invoices = await Promise.all(allInvoicesRaw.map((i) => getInvoiceView(req.tenantId, i)));

  const billed = invoices.reduce((a, i) => a + i.invoiced, 0);
  const collected = invoices.reduce((a, i) => a + i.paidAllocated, 0);
  const outstanding = invoices.reduce((a, i) => a + i.balance, 0);
  const overdue60 = invoices.filter((i) => i.ageingDays >= 60 && i.balance > 0);
  const waived = Math.abs(invoices.reduce((a, i) => a + i.lines.filter((l) => l.kind === 'bursary').reduce((s, l) => s + l.amount, 0), 0));
  const thisMonthKey = todayStr().slice(0, 7);
  const receiptsThisMonth = allPayments.filter((p) => p.dateReceived.startsWith(thisMonthKey)).reduce((a, p) => a + p.amountReceived, 0);
  const unconfirmed = allPayments.filter((p) => !p.confirmed);
  const unreconciledValue = unconfirmed.reduce((a, p) => a + p.amountReceived, 0);

  const byClass = levels.map((level) => {
    const classInvoices = invoices.filter((i) => i.className === level.name);
    const levelBilled = classInvoices.reduce((a, i) => a + i.invoiced, 0);
    const levelCollected = classInvoices.reduce((a, i) => a + i.paidAllocated, 0);
    const pct = levelBilled > 0 ? Math.round((levelCollected / levelBilled) * 100) : null;
    return {
      level: level.name, pupils: new Set(classInvoices.map((i) => i.studentId)).size,
      billed: levelBilled, collected: levelCollected, outstanding: levelBilled - levelCollected,
      percentage: pct, status: pct == null ? 'No invoices' : pct >= 95 ? 'On track' : pct >= 85 ? 'Watch' : 'Behind',
    };
  });

  const attention = [
    { key: 'overdue90', label: 'Overdue 90+ days', value: invoices.filter((i) => i.ageingDays >= 90 && i.balance > 0).length },
    { key: 'unmatchedLines', label: 'Unmatched bank lines', value: (await db.bankStatementLines.list(req.tenantId, {})).filter((l) => l.confidence !== 'Exact').length },
    { key: 'refundsAwaiting', label: 'Refunds/disbursements awaiting approval', value: (await db.feeDisbursements.list(req.tenantId, {})).filter((d) => d.state === 'Awaiting approval').length },
  ];

  const recent = [...allPayments].sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1)).slice(0, 5);
  const recentEnriched = await Promise.all(recent.map(async (p) => {
    const student = await db.students.findById(req.tenantId, p.studentId);
    return { name: student ? `${student.firstName} ${student.lastName}` : 'Unknown learner', amount: p.amountReceived, method: p.method, dateReceived: p.dateReceived, confirmed: p.confirmed };
  }));

  res.json({
    data: {
      metrics: { collected, outstanding, overdue60: overdue60.reduce((a, i) => a + i.balance, 0), receiptsThisMonth, unreconciledValue },
      progress: { billed, collected, outstanding: outstanding - overdue60.reduce((a, i) => a + i.balance, 0), overdue60: overdue60.reduce((a, i) => a + i.balance, 0), waived },
      byClass, attention, recent: recentEnriched,
    },
  });
}));

// --- 02 Fee structure ------------------------------------------------------

feesRouter.get('/structure', authenticate, tenantScope, permit('fees:structure:read'), asyncRoute(async (req, res) => {
  const [bundle, schedule, rules] = await Promise.all([
    getStructureBundle(req.tenantId), db.feeBillingSchedule.list(req.tenantId), getStructureRules(req.tenantId),
  ]);
  const annualTotals = bundle.published ? computeAnnualTotals(bundle.published.heads) : null;
  res.json({ data: { ...bundle, annualTotals, billingSchedule: schedule.sort((a, b) => a.orderIndex - b.orderIndex), rules } });
}));

feesRouter.put('/structure', authenticate, tenantScope, permit('fees:structure:update'), asyncRoute(async (req, res) => {
  const { heads } = req.body || {};
  if (!Array.isArray(heads) || !heads.length) throw badRequest('A non-empty heads array is required');
  const allowedTypes = new Set(['Core', 'Optional']);
  const allowedCycles = new Set(['Per term', 'One-off']);
  for (const h of heads) {
    if (!h.name || typeof h.name !== 'string') throw badRequest('Each head needs a name');
    if (!allowedTypes.has(h.type)) throw badRequest('type must be Core or Optional');
    if (!allowedCycles.has(h.cycle)) throw badRequest('cycle must be "Per term" or "One-off"');
  }
  const draft = await ensureDraftStructure(req.tenantId, req.auth.sub);
  const saved = await db.feeStructureHeads.replaceForStructure(req.tenantId, draft.id, heads.map((h) => ({
    name: h.name.trim(), type: h.type, cycle: h.cycle,
    amountEarlyYears: h.amountEarlyYears ?? null, amountPrimary: h.amountPrimary ?? null, amountSecondary: h.amountSecondary ?? null,
    appliesTo: h.appliesTo?.trim() || 'All learners',
  })));
  await db.audit.record({ event: 'fees.structureDraftSaved', actorId: req.auth.sub, target: draft.id, tenantId: req.tenantId, summary: { heads: saved.length } });
  res.json({ data: { ...draft, heads: saved } });
}));

feesRouter.post('/structure/publish', authenticate, tenantScope, permit('fees:structure:update'), asyncRoute(async (req, res) => {
  const bundle = await getStructureBundle(req.tenantId);
  if (!bundle.draft) throw badRequest('No draft to publish -- save the fee structure grid first');
  if (!bundle.draft.heads.length) throw badRequest('The draft has no fee heads -- add at least one before publishing');
  const published = await db.feeStructures.publish(req.tenantId, bundle.draft.id);
  await db.audit.record({ event: 'fees.structurePublished', actorId: req.auth.sub, target: published.id, tenantId: req.tenantId, summary: { version: published.version } });
  res.json({ data: await getStructureBundle(req.tenantId) });
}));

feesRouter.put('/structure/billing-schedule', authenticate, tenantScope, permit('fees:structure:update'), asyncRoute(async (req, res) => {
  const { schedule } = req.body || {};
  if (!Array.isArray(schedule) || !schedule.length) throw badRequest('A non-empty schedule array is required');
  for (const s of schedule) {
    if (!s.termLabel || !validDate(s.dueDate) || typeof s.sharePercent !== 'number') {
      throw badRequest('Each row needs termLabel, a valid dueDate and a numeric sharePercent');
    }
  }
  const existing = await db.feeBillingSchedule.list(req.tenantId);
  await Promise.all(existing.map((s) => db.feeBillingSchedule.remove(req.tenantId, s.id)));
  const created = [];
  for (let i = 0; i < schedule.length; i += 1) {
    const s = schedule[i];
    created.push(await db.feeBillingSchedule.create({ tenantId: req.tenantId, termLabel: s.termLabel, dueDate: s.dueDate, sharePercent: s.sharePercent, note: s.note || '', orderIndex: i }));
  }
  await db.audit.record({ event: 'fees.billingScheduleUpdated', actorId: req.auth.sub, target: req.tenantId, tenantId: req.tenantId, summary: { rows: created.length } });
  res.json({ data: created });
}));

feesRouter.put('/structure/rules', authenticate, tenantScope, permit('fees:structure:update'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.siblingDiscountPercent != null) patch.siblingDiscountPercent = Math.max(0, Math.min(100, Number(body.siblingDiscountPercent) || 0));
  if (body.earlySettlementDiscountPercent != null) patch.earlySettlementDiscountPercent = Math.max(0, Math.min(100, Number(body.earlySettlementDiscountPercent) || 0));
  if (body.latePaymentInterestPercent != null) patch.latePaymentInterestPercent = Math.max(0, Math.min(100, Number(body.latePaymentInterestPercent) || 0));
  if (body.proRataEnabled != null) patch.proRataEnabled = !!body.proRataEnabled;
  await db.feeStructureRules.upsert(req.tenantId, patch);
  await db.audit.record({ event: 'fees.rulesUpdated', actorId: req.auth.sub, target: req.tenantId, tenantId: req.tenantId, summary: patch });
  res.json({ data: await getStructureRules(req.tenantId) });
}));

// --- 03/04 Invoices ---------------------------------------------------------

feesRouter.get('/invoices', authenticate, tenantScope, permit('fees:invoices:read'), asyncRoute(async (req, res) => {
  const { status, className, search, page = '1', pageSize = '10' } = req.query;
  const allRaw = await db.feeInvoices.list(req.tenantId, {});
  let all = await Promise.all(allRaw.map((i) => getInvoiceView(req.tenantId, i)));
  if (className) all = all.filter((i) => i.className === className);
  if (status && status !== 'All') {
    all = all.filter((i) => (status === 'Overdue' ? i.status.startsWith('Overdue') : i.status === status));
  }
  const students = await db.students.list(req.tenantId, {});
  const studentById = new Map(students.map((s) => [s.id, s]));
  let enriched = all.map((i) => {
    const student = studentById.get(i.studentId);
    return { ...i, learnerName: student ? `${student.firstName} ${student.lastName}` : 'Unknown learner', guardianName: student?.guardians?.father?.name || student?.guardians?.mother?.name || student?.guardians?.guardian?.name || '' };
  });
  if (search) {
    const q = search.toLowerCase();
    enriched = enriched.filter((i) => i.invoiceNo.toLowerCase().includes(q) || i.learnerName.toLowerCase().includes(q));
  }
  enriched.sort((a, b) => (a.raisedAt < b.raisedAt ? 1 : -1));

  const total = enriched.length;
  const pageNum = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Math.min(100, Number(pageSize) || 10));
  const paged = enriched.slice((pageNum - 1) * size, pageNum * size);

  res.json({
    data: paged,
    meta: {
      total, page: pageNum, pageSize: size, totalPages: Math.max(1, Math.ceil(total / size)),
      invoicedTotal: all.reduce((a, i) => a + i.invoiced, 0),
      receiptedTotal: all.reduce((a, i) => a + i.paidAllocated, 0),
      openBalance: all.reduce((a, i) => a + i.balance, 0),
      overdue60Count: all.filter((i) => i.ageingDays >= 60 && i.balance > 0).length,
      overdue60Value: all.filter((i) => i.ageingDays >= 60 && i.balance > 0).reduce((a, i) => a + i.balance, 0),
      overdueCount: all.filter((i) => i.status.startsWith('Overdue')).length,
    },
  });
}));

feesRouter.get('/invoices/:id', authenticate, tenantScope, permit('fees:invoices:read'), asyncRoute(async (req, res) => {
  const invoice = await db.feeInvoices.findById(req.tenantId, req.params.id);
  if (!invoice) throw notFound('Invoice not found');
  const [view, student, profile, auditLog] = await Promise.all([
    getInvoiceView(req.tenantId, invoice),
    db.students.findById(req.tenantId, invoice.studentId),
    db.schoolProfile.get(req.tenantId),
    db.audit.list(req.tenantId),
  ]);
  const guardian = student?.guardians?.father?.name ? { role: 'father', ...student.guardians.father }
    : student?.guardians?.mother?.name ? { role: 'mother', ...student.guardians.mother }
    : student?.guardians?.guardian?.name ? { role: 'guardian', ...student.guardians.guardian } : null;
  const settings = await getFeeSettings(req.tenantId);
  const reference = student ? `${student.lastName.toUpperCase()}${student.className.replace(/\D/g, '')}${student.section}` : '';
  res.json({
    data: {
      ...view,
      learnerName: student ? `${student.firstName} ${student.lastName}` : 'Unknown learner',
      admissionNumber: student?.admissionNumber || '',
      guardian,
      banking: { bank: profile.bank?.bankName || '', account: profile.bank?.accountNumber || '', branch: profile.bank?.branchName || '', reference, referenceFormat: settings.referenceFormat },
      auditTrail: auditLog.filter((a) => a.target === invoice.id).sort((a, b) => (a.at < b.at ? 1 : -1)),
    },
  });
}));

feesRouter.post('/invoices/raise', authenticate, tenantScope, permit('fees:invoices:write'), asyncRoute(async (req, res) => {
  const { termLabel } = req.body || {};
  if (!termLabel) throw badRequest('termLabel is required');
  try {
    const result = await raiseInvoicesForTerm(req.tenantId, termLabel, req.auth.sub);
    res.status(201).json({ data: result });
  } catch (err) {
    throw badRequest(err.message);
  }
}));

feesRouter.post('/invoices/accrue-interest', authenticate, tenantScope, permit('fees:invoices:update'), asyncRoute(async (req, res) => {
  const charged = await accrueInterest(req.tenantId, req.auth.sub);
  res.json({ data: { invoicesCharged: charged } });
}));

const LINE_KINDS = new Set(['discount', 'bursary', 'other']);

feesRouter.post('/invoices/:id/lines', authenticate, tenantScope, permit('fees:invoices:update'), asyncRoute(async (req, res) => {
  const invoice = await db.feeInvoices.findById(req.tenantId, req.params.id);
  if (!invoice) throw notFound('Invoice not found');
  const { kind, label, amount, note } = req.body || {};
  if (!LINE_KINDS.has(kind)) throw badRequest('kind must be discount, bursary or other');
  if (!label || typeof label !== 'string') throw badRequest('label is required');
  if (!money(amount) || amount === 0) throw badRequest('amount must be a non-zero number (negative for a discount/bursary)');
  await db.feeInvoiceLines.createMany(req.tenantId, invoice.id, [{ kind, label: label.trim(), note: note?.trim() || '', qty: 1, rate: null, amount }]);
  await db.audit.record({ event: 'fees.invoiceLineAdded', actorId: req.auth.sub, target: invoice.id, tenantId: req.tenantId, summary: { kind, amount } });
  res.status(201).json({ data: await getInvoiceView(req.tenantId, invoice) });
}));

feesRouter.delete('/invoices/:id/lines/:lineId', authenticate, tenantScope, permit('fees:invoices:update'), asyncRoute(async (req, res) => {
  const line = await db.feeInvoiceLines.findById(req.tenantId, req.params.lineId);
  if (!line || line.invoiceId !== req.params.id) throw notFound('Line not found on this invoice');
  if (line.kind === 'head') throw badRequest('A fee-head line cannot be removed directly -- edit the fee structure instead');
  await db.feeInvoiceLines.remove(req.tenantId, line.id);
  await db.audit.record({ event: 'fees.invoiceLineRemoved', actorId: req.auth.sub, target: req.params.id, tenantId: req.tenantId, summary: { kind: line.kind, amount: line.amount } });
  res.status(204).end();
}));

// --- 05 Record a payment received ------------------------------------------

const PAYMENT_METHODS = new Set(['EFT', 'Card', 'Cash', 'Debit order']);

feesRouter.get('/payments', authenticate, tenantScope, permit('fees:payments:read'), asyncRoute(async (req, res) => {
  const { studentId } = req.query;
  res.json({ data: await db.feePayments.list(req.tenantId, { studentId }) });
}));

feesRouter.post('/payments', authenticate, tenantScope, permit('fees:payments:write'), asyncRoute(async (req, res) => {
  const { studentId, amountReceived, dateReceived, method, bankReference, proofDocumentId, allocations } = req.body || {};
  const student = studentId && await db.students.findById(req.tenantId, studentId);
  if (!student) throw badRequest('A valid studentId is required');
  if (!money(amountReceived) || amountReceived <= 0) throw badRequest('amountReceived must be a positive number');
  if (!validDate(dateReceived)) throw badRequest('A valid dateReceived is required');
  if (!PAYMENT_METHODS.has(method)) throw badRequest('method must be EFT, Card, Cash or Debit order');
  if (allocations && (!Array.isArray(allocations) || allocations.some((a) => !a.invoiceId || !money(a.amount) || a.amount <= 0))) {
    throw badRequest('allocations, if provided, must be a non-empty array of {invoiceId, amount}');
  }
  const allocatedSum = (allocations || []).reduce((a, x) => a + x.amount, 0);
  if (allocations && Math.abs(allocatedSum - amountReceived) > 0.01) throw badRequest('Allocations must add up to the amount received');

  const result = await recordPayment(req.tenantId, req.auth.sub, { studentId, amountReceived, dateReceived, method, bankReference, proofDocumentId, allocations });
  res.status(201).json({ data: result });
}));

// --- 06 Bank reconciliation -------------------------------------------------

feesRouter.get('/reconciliation', authenticate, tenantScope, permit('fees:reconciliation:read'), asyncRoute(async (req, res) => {
  const lines = await db.bankStatementLines.list(req.tenantId, {});
  const sorted = lines.sort((a, b) => (a.date < b.date ? 1 : -1));
  res.json({
    data: sorted,
    meta: {
      imported: lines.length,
      autoMatched: lines.filter((l) => l.confidence === 'Exact').length,
      needsReview: lines.filter((l) => l.confidence !== 'Exact').length,
      unallocatedValue: lines.filter((l) => l.confidence !== 'Exact').reduce((a, l) => a + l.amount, 0),
    },
  });
}));

feesRouter.post('/reconciliation/lines', authenticate, tenantScope, permit('fees:reconciliation:update'), asyncRoute(async (req, res) => {
  const { date, reference, amount } = req.body || {};
  if (!validDate(date)) throw badRequest('A valid date is required');
  if (!reference || typeof reference !== 'string') throw badRequest('reference is required');
  if (!money(amount) || amount <= 0) throw badRequest('amount must be a positive number');
  const line = await db.bankStatementLines.create({ tenantId: req.tenantId, date, reference: reference.trim(), amount, matchedPaymentId: null, confidence: 'None', reviewedBy: null, reviewedAt: null, createdBy: req.auth.sub });
  const matched = await matchBankLine(req.tenantId, line);
  await db.audit.record({ event: 'fees.bankLineAdded', actorId: req.auth.sub, target: matched.id, tenantId: req.tenantId, summary: { confidence: matched.confidence } });
  res.status(201).json({ data: matched });
}));

feesRouter.post('/reconciliation/lines/:id/allocate', authenticate, tenantScope, permit('fees:reconciliation:update'), asyncRoute(async (req, res) => {
  const line = await db.bankStatementLines.findById(req.tenantId, req.params.id);
  if (!line) throw notFound('Bank line not found');
  const { paymentId, studentId, invoiceId } = req.body || {};

  let targetPaymentId = paymentId;
  if (!targetPaymentId) {
    if (!studentId || !invoiceId) throw badRequest('Provide either an existing paymentId, or studentId + invoiceId to record a new payment for this line');
    const student = await db.students.findById(req.tenantId, studentId);
    if (!student) throw notFound('Student not found');
    const result = await recordPayment(req.tenantId, req.auth.sub, {
      studentId, amountReceived: line.amount, dateReceived: line.date, method: 'EFT', bankReference: line.reference,
      allocations: [{ invoiceId, amount: line.amount }],
    });
    targetPaymentId = result.payment.id;
  }
  await db.feePayments.markConfirmed(req.tenantId, targetPaymentId);
  const updated = await db.bankStatementLines.setMatch(req.tenantId, line.id, { paymentId: targetPaymentId, confidence: 'Exact', reviewedBy: req.auth.sub });
  await db.audit.record({ event: 'fees.bankLineAllocated', actorId: req.auth.sub, target: line.id, tenantId: req.tenantId, summary: { paymentId: targetPaymentId } });
  res.json({ data: updated });
}));

// --- 07 Arrears & escalation -------------------------------------------------

const LADDER_THRESHOLDS = { first_reminder: 14, second_reminder: 45, letter_of_demand: 90, handover: 120 };

feesRouter.get('/arrears', authenticate, tenantScope, permit('fees:arrears:read'), asyncRoute(async (req, res) => {
  const [students, allEvents, allPlans] = await Promise.all([
    db.students.list(req.tenantId, { status: 'active' }),
    db.feeEscalationEvents.list(req.tenantId, {}),
    db.feePaymentPlans.list(req.tenantId, {}),
  ]);
  const rows = [];
  for (const student of students) {
    const { owed, oldestDueDate } = await getStudentBalance(req.tenantId, student.id);
    if (owed <= 0) continue;
    const ageingDays = oldestDueDate ? daysBetween(oldestDueDate, todayStr()) : 0;
    const events = allEvents.filter((e) => e.studentId === student.id);
    const stage = events.some((e) => e.step === 'handover') ? 'Handover pending'
      : events.some((e) => e.step === 'letter_of_demand') ? 'Letter of demand'
      : events.some((e) => e.step === 'second_reminder') ? 'Second reminder'
      : events.some((e) => e.step === 'first_reminder') ? 'First reminder'
      : 'New';
    const plan = allPlans.find((p) => p.studentId === student.id && p.status === 'active');
    const guardian = student.guardians?.father?.name || student.guardians?.mother?.name || student.guardians?.guardian?.name || '';
    rows.push({
      studentId: student.id, name: `${student.firstName} ${student.lastName}`, className: student.className, section: student.section,
      guardian, owed, oldestDays: ageingDays, plan: plan ? derivePlanState(plan) : 'No plan', stage,
    });
  }
  rows.sort((a, b) => b.oldestDays - a.oldestDays);

  const ladder = Object.entries(LADDER_THRESHOLDS).map(([step, threshold]) => {
    const queued = rows.filter((r) => r.oldestDays >= threshold && !allEvents.some((e) => e.studentId === r.studentId && e.step === step));
    return { step, threshold, count: queued.length };
  });

  res.json({
    data: rows,
    meta: {
      totalOverdue: rows.reduce((a, r) => a + r.owed, 0),
      learnersAffected: rows.length,
      over90: rows.filter((r) => r.oldestDays >= 90).reduce((a, r) => a + r.owed, 0),
      onPlan: rows.filter((r) => r.plan !== 'No plan').length,
      plansInArrears: rows.filter((r) => r.plan === 'In arrears').length,
    },
    ladder,
  });
}));

feesRouter.post('/arrears/:studentId/plan', authenticate, tenantScope, permit('fees:arrears:write'), asyncRoute(async (req, res) => {
  const student = await db.students.findById(req.tenantId, req.params.studentId);
  if (!student) throw notFound('Student not found');
  const { instalmentCount, startDate } = req.body || {};
  if (!validDate(startDate)) throw badRequest('A valid startDate is required');
  try {
    const plan = await setupPaymentPlan(req.tenantId, req.auth.sub, req.params.studentId, { instalmentCount: Number(instalmentCount), startDate });
    res.status(201).json({ data: { ...plan, state: derivePlanState(plan) } });
  } catch (err) {
    throw badRequest(err.message);
  }
}));

feesRouter.post('/arrears/escalate', authenticate, tenantScope, permit('fees:arrears:update'), asyncRoute(async (req, res) => {
  // Recompute the arrears rows directly rather than re-invoking the
  // /arrears route handler internally.
  const [students, allEvents] = await Promise.all([
    db.students.list(req.tenantId, { status: 'active' }),
    db.feeEscalationEvents.list(req.tenantId, {}),
  ]);
  const requestedSteps = Array.isArray(req.body?.steps) && req.body.steps.length ? req.body.steps : Object.keys(LADDER_THRESHOLDS);
  const created = [];
  for (const step of requestedSteps) {
    const threshold = LADDER_THRESHOLDS[step];
    if (!threshold) continue;
    for (const student of students) {
      const { oldestDueDate } = await getStudentBalance(req.tenantId, student.id);
      if (!oldestDueDate) continue;
      const ageingDays = daysBetween(oldestDueDate, todayStr());
      if (ageingDays < threshold) continue;
      if (allEvents.some((e) => e.studentId === student.id && e.step === step)) continue;
      const event = await db.feeEscalationEvents.create({ tenantId: req.tenantId, studentId: student.id, invoiceId: null, step, note: '', createdBy: req.auth.sub, createdAt: new Date().toISOString() });
      created.push(event);
      allEvents.push(event);
    }
  }
  await db.audit.record({ event: 'fees.escalationRun', actorId: req.auth.sub, target: req.tenantId, tenantId: req.tenantId, summary: { steps: requestedSteps, count: created.length } });
  res.json({ data: { logged: created.length } });
}));

// --- 08 Payments made (disbursements) ---------------------------------------

const DISB_METHODS = new Set(['EFT', 'Cash', 'Cheque']);
const TWO_PERSON_THRESHOLD = 10000;

async function nextDisbursementRef(tenantId) {
  const year = new Date().getUTCFullYear();
  const all = await db.feeDisbursements.list(tenantId, {});
  const pattern = new RegExp(`^PAY-${year}-(\\d+)$`);
  const max = all.reduce((m, d) => { const match = pattern.exec(d.reference || ''); return match ? Math.max(m, Number(match[1])) : m; }, 300);
  return `PAY-${year}-${max + 1}`;
}

feesRouter.get('/disbursements', authenticate, tenantScope, permit('fees:disbursements:read'), asyncRoute(async (req, res) => {
  const rows = await db.feeDisbursements.list(req.tenantId, {});
  res.json({
    data: rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    meta: {
      recordedThisMonth: rows.filter((d) => d.createdAt.startsWith(todayStr().slice(0, 7))).reduce((a, d) => a + d.amount, 0),
      awaitingApproval: rows.filter((d) => d.state === 'Awaiting approval').reduce((a, d) => a + d.amount, 0),
      approvedNotPaid: rows.filter((d) => d.state === 'Approved').reduce((a, d) => a + d.amount, 0),
      proofMissing: rows.filter((d) => d.state === 'Paid' && !d.proofDocumentId).length,
    },
  });
}));

feesRouter.post('/disbursements', authenticate, tenantScope, permit('fees:disbursements:write'), asyncRoute(async (req, res) => {
  const { date, payeeName, reason, amount, method } = req.body || {};
  if (!validDate(date)) throw badRequest('A valid date is required');
  if (!payeeName || !reason) throw badRequest('payeeName and reason are required');
  if (!money(amount) || amount <= 0) throw badRequest('amount must be a positive number');
  if (!DISB_METHODS.has(method)) throw badRequest('method must be EFT, Cash or Cheque');
  const reference = await nextDisbursementRef(req.tenantId);
  const record = await db.feeDisbursements.create({
    tenantId: req.tenantId, reference, date, payeeName: payeeName.trim(), reason: reason.trim(), amount, method,
    state: 'Awaiting approval', proofDocumentId: null, requestedBy: req.auth.sub, approvedBy: null, decidedAt: null,
  });
  await db.audit.record({ event: 'fees.disbursementRequested', actorId: req.auth.sub, target: record.id, tenantId: req.tenantId, summary: { amount, payeeName } });
  res.status(201).json({ data: record });
}));

feesRouter.patch('/disbursements/:id/decide', authenticate, tenantScope, permit('fees:disbursements-approval:update'), asyncRoute(async (req, res) => {
  const disbursement = await db.feeDisbursements.findById(req.tenantId, req.params.id);
  if (!disbursement) throw notFound('Disbursement not found');
  if (disbursement.state !== 'Awaiting approval') throw conflict('This disbursement has already been decided');
  const { decision } = req.body || {};
  if (!['Approved', 'Declined'].includes(decision)) throw badRequest('decision must be "Approved" or "Declined"');
  // Two-person rule: above R10 000, the approver can never be the same
  // person who requested it -- enforced for real, not descriptive copy.
  if (decision === 'Approved' && disbursement.amount > TWO_PERSON_THRESHOLD && disbursement.requestedBy === req.auth.sub) {
    throw forbidden(`Disbursements above ${R(TWO_PERSON_THRESHOLD)} need a second person to approve`);
  }
  const updated = await db.feeDisbursements.decide(req.tenantId, req.params.id, { state: decision, approvedBy: req.auth.sub });
  await db.audit.record({ event: decision === 'Approved' ? 'fees.disbursementApproved' : 'fees.disbursementDeclined', actorId: req.auth.sub, target: disbursement.id, tenantId: req.tenantId, summary: { amount: disbursement.amount } });
  res.json({ data: updated });
}));

feesRouter.post('/disbursements/:id/mark-paid', authenticate, tenantScope, permit('fees:disbursements-approval:update'), asyncRoute(async (req, res) => {
  const disbursement = await db.feeDisbursements.findById(req.tenantId, req.params.id);
  if (!disbursement) throw notFound('Disbursement not found');
  if (disbursement.state !== 'Approved') throw conflict('Only an approved disbursement can be marked paid');
  const { proofDocumentId } = req.body || {};
  if (!proofDocumentId) throw badRequest('Proof of payment must be attached before marking this paid');
  const updated = await db.feeDisbursements.update(req.tenantId, req.params.id, { proofDocumentId, state: 'Paid' });
  await db.audit.record({ event: 'fees.disbursementPaid', actorId: req.auth.sub, target: disbursement.id, tenantId: req.tenantId, summary: { amount: disbursement.amount } });
  res.json({ data: updated });
}));

// --- 09 Payment channels & policy --------------------------------------------

feesRouter.get('/settings', authenticate, tenantScope, permit('fees:settings:read'), asyncRoute(async (req, res) => {
  res.json({ data: await getFeeSettings(req.tenantId) });
}));

feesRouter.put('/settings', authenticate, tenantScope, permit('fees:settings:update'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (Array.isArray(body.acceptedChannels)) patch.acceptedChannels = body.acceptedChannels;
  if (body.referenceFormat != null) patch.referenceFormat = String(body.referenceFormat);
  if (Array.isArray(body.notifyRules)) patch.notifyRules = body.notifyRules;
  await db.feeSettings.upsert(req.tenantId, patch);
  await db.audit.record({ event: 'fees.settingsUpdated', actorId: req.auth.sub, target: req.tenantId, tenantId: req.tenantId, summary: patch });
  res.json({ data: await getFeeSettings(req.tenantId) });
}));

// --- Reports (Filter -> View -> Export Excel -> Export PDF -> Print, per
// requirement/rquiremnt phase 1.md #31; edusphere-reports-module-plan-
// 2026-09-22.md). Fees had no exportable report of any kind before this --
// Overview and Arrears are operational screens, not filterable/exportable
// reports. Follows the exact Students/Staff /reports/:type shape (CSV by
// default, ?format=pdf for a real pdfkit table via the new shared
// core/reportPdf.js helper -- "Export Excel" is CSV under the hood
// everywhere in this codebase, see core/csv.js's header comment for why).
const feeReportColumns = {
  collection: [
    { label: 'DATE', key: 'dateReceived' }, { label: 'STUDENT', key: 'studentName' },
    { label: 'ADM NO', key: 'admissionNumber' }, { label: 'CLASS', key: 'className' },
    { label: 'AMOUNT', key: 'amount' }, { label: 'METHOD', key: 'method' }, { label: 'CONFIRMED', key: 'confirmed' },
  ],
  outstanding: [
    { label: 'STUDENT', key: 'studentName' }, { label: 'ADM NO', key: 'admissionNumber' }, { label: 'CLASS', key: 'className' },
    { label: 'INVOICE NO', key: 'invoiceNo' }, { label: 'INVOICED', key: 'invoiced' }, { label: 'PAID', key: 'paid' },
    { label: 'BALANCE', key: 'balance' }, { label: 'AGEING (DAYS)', key: 'ageingDays' }, { label: 'STATUS', key: 'status' },
  ],
  overdue: [
    { label: 'STUDENT', key: 'studentName' }, { label: 'ADM NO', key: 'admissionNumber' }, { label: 'CLASS', key: 'className' },
    { label: 'INVOICE NO', key: 'invoiceNo' }, { label: 'BALANCE', key: 'balance' }, { label: 'AGEING (DAYS)', key: 'ageingDays' }, { label: 'STATUS', key: 'status' },
  ],
  'payment-history': [
    { label: 'DATE', key: 'dateReceived' }, { label: 'STUDENT', key: 'studentName' }, { label: 'ADM NO', key: 'admissionNumber' },
    { label: 'CLASS', key: 'className' }, { label: 'AMOUNT', key: 'amount' }, { label: 'METHOD', key: 'method' },
    { label: 'BANK REF', key: 'bankReference' }, { label: 'CONFIRMED', key: 'confirmed' },
  ],
  'daily-collection': [
    { label: 'DATE', key: 'date' }, { label: 'PAYMENTS', key: 'count' }, { label: 'TOTAL COLLECTED', key: 'total' },
  ],
};

feesRouter.get('/reports/:type', authenticate, tenantScope, permit('fees:reports:read'), asyncRoute(async (req, res) => {
  const { type } = req.params;
  if (!REPORT_TYPES.has(type)) throw notFound(`Unknown report type "${type}"`);
  const { from, to, className, studentId, format } = req.query;

  const students = await db.students.list(req.tenantId, {});
  const studentById = new Map(students.map((s) => [s.id, s]));
  const nameFor = (id) => {
    const s = studentById.get(id);
    return s ? `${s.firstName} ${s.lastName}` : 'Unknown learner';
  };

  let rows = [];
  let title;
  let filename;
  let subtitleParts = [];
  if (from) subtitleParts.push(`From ${from}`);
  if (to) subtitleParts.push(`To ${to}`);
  if (className) subtitleParts.push(`Class ${className}`);

  if (type === 'collection' || type === 'payment-history') {
    title = type === 'collection' ? 'Fee Collection Report' : 'Payment History';
    filename = type === 'collection' ? 'fee_collection_report' : 'fee_payment_history';
    let payments = await db.feePayments.list(req.tenantId, { studentId: studentId || undefined });
    payments = payments.filter((p) => (!from || p.dateReceived >= from) && (!to || p.dateReceived <= to));
    if (className) payments = payments.filter((p) => studentById.get(p.studentId)?.className === className);
    payments.sort((a, b) => (a.dateReceived < b.dateReceived ? 1 : -1));
    rows = payments.map((p) => {
      const student = studentById.get(p.studentId);
      return {
        dateReceived: p.dateReceived, studentName: nameFor(p.studentId), admissionNumber: student?.admissionNumber || '',
        className: student?.className || '', amount: R(p.amountReceived), method: p.method,
        bankReference: p.bankReference || '', confirmed: p.confirmed ? 'Yes' : 'No',
      };
    });
  } else if (type === 'outstanding' || type === 'overdue') {
    title = type === 'outstanding' ? 'Outstanding Fees Report' : 'Overdue Fees Report';
    filename = type === 'outstanding' ? 'fee_outstanding_report' : 'fee_overdue_report';
    const invoicesRaw = await db.feeInvoices.list(req.tenantId, {});
    let invoices = await Promise.all(invoicesRaw.map((i) => getInvoiceView(req.tenantId, i)));
    invoices = invoices.filter((i) => i.balance > 0);
    if (type === 'overdue') invoices = invoices.filter((i) => i.status.startsWith('Overdue'));
    if (className) invoices = invoices.filter((i) => i.className === className);
    invoices.sort((a, b) => b.ageingDays - a.ageingDays);
    rows = invoices.map((i) => {
      const student = studentById.get(i.studentId);
      return {
        studentName: nameFor(i.studentId), admissionNumber: student?.admissionNumber || '', className: i.className,
        invoiceNo: i.invoiceNo, invoiced: R(i.invoiced), paid: R(i.paidAllocated), balance: R(i.balance),
        ageingDays: i.ageingDays, status: i.status,
      };
    });
  } else {
    // daily-collection
    title = 'Daily Collection Report';
    filename = 'fee_daily_collection_report';
    let payments = await db.feePayments.list(req.tenantId, {});
    payments = payments.filter((p) => (!from || p.dateReceived >= from) && (!to || p.dateReceived <= to));
    const byDate = new Map();
    for (const p of payments) {
      const entry = byDate.get(p.dateReceived) || { count: 0, total: 0 };
      entry.count += 1;
      entry.total += p.amountReceived;
      byDate.set(p.dateReceived, entry);
    }
    rows = [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([date, entry]) => ({ date, count: entry.count, total: R(entry.total) }));
  }

  await db.audit.record({ event: 'fees.reportGenerated', actorId: req.auth.sub, target: type, tenantId: req.tenantId });
  const columns = feeReportColumns[type];

  if (format === 'pdf') {
    const school = await db.schools.findById(req.tenantId);
    const pdf = await generateTabularReportPdf({
      tenant: school, title, subtitle: subtitleParts.join(' \u00b7 ') || undefined, columns, rows,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    res.send(pdf);
    return;
  }

  const csv = toCsv(columns.map((c) => c.key), rows);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  res.send(csv);
}));

// A student's own fee ledger -- mirrors GET /api/students/:id/attendance's
// precedent of a small per-student read mounted on the students router.
export const studentFeesRouter = Router();

studentFeesRouter.get('/:id/fees', authenticate, tenantScope, permit('fees:payments:read'), asyncRoute(async (req, res) => {
  const student = await db.students.findById(req.tenantId, req.params.id);
  if (!student) throw notFound('Student not found');
  const invoicesRaw = await db.feeInvoices.list(req.tenantId, { studentId: student.id });
  const invoices = await Promise.all(invoicesRaw.map((i) => getInvoiceView(req.tenantId, i)));
  invoices.sort((a, b) => (a.dueDate < b.dueDate ? 1 : -1));
  const { owed } = await getStudentBalance(req.tenantId, student.id);
  res.json({ data: { invoices, balance: owed } });
}));
