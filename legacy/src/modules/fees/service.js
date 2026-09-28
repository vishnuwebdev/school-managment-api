import { db } from '../../db/index.js';

// Fees & Payments (designs/Teacher feature UI mockup/Fees and Payments.dc.html,
// 9 screens). This module is a RECORD of an offline collection process --
// no money moves through the portal. See schema.sql's Fees & Payments
// header and the project doc (edusphere-fees-payments-module-plan-2026-09-18.md)
// for the full design rationale and the scope cuts agreed with Vishnu
// before writing this:
//  - Fee structure is a new, richer, versioned model that belongs to this
//    module. School Setup's existing fee_types/"Fee Configuration" tab is
//    UNTOUCHED and unrelated -- two fee-configuration surfaces exist side
//    by side, deliberately, documented here rather than migrated.
//  - Payment plans are real, tracked records (see fee_payment_plans).
//  - A bursary/concession is a manual discount line on an invoice
//    (kind: 'bursary') -- there is no separate award-tracking entity,
//    approval workflow, or funder/budget figures.
//  - Bank reconciliation lines are entered by hand -- no statement-file
//    upload/parsing this pass.
//  - Guardian communication (invoice emails, receipts, reminders,
//    statements) is honestly NOT wired -- no Notices & Communication
//    backend exists anywhere in this codebase, same as every prior module.

export const todayStr = () => new Date().toISOString().slice(0, 10);

export const daysBetween = (fromStr, toStr) => {
  const from = new Date(`${fromStr}T00:00:00Z`);
  const to = new Date(`${toStr}T00:00:00Z`);
  return Math.round((to - from) / 86400000);
};

export const R = (n) => `R ${Math.round(n).toLocaleString('en-ZA').replace(/,/g, ' ')}`;

const DEFAULT_RULES = () => ({
  siblingDiscountPercent: 10,
  earlySettlementDiscountPercent: 5,
  latePaymentInterestPercent: 2,
  proRataEnabled: false,
});

export async function getStructureRules(tenantId) {
  const row = await db.feeStructureRules.get(tenantId);
  return { tenantId, ...DEFAULT_RULES(), ...row };
}

const DEFAULT_FEE_SETTINGS = () => ({
  acceptedChannels: [
    { name: 'EFT / bank transfer', note: 'Standard reference: SURNAME + class', state: 'Preferred' },
    { name: 'Debit order', note: 'Collected on the 1st, mandate on file', state: 'Preferred' },
    { name: 'Card at reception', note: 'Speedpoint, slip number captured', state: 'Accepted' },
    { name: 'Cash at reception', note: 'Two-staff count, receipt printed on the spot', state: 'Discouraged' },
    { name: 'In-portal card payment', note: 'Not offered -- no gateway is connected', state: 'Not enabled' },
  ],
  referenceFormat: 'SURNAME + class, e.g. BOTHA9A',
  notifyRules: [
    { key: 'invoiceIssued', label: 'Invoice issued -- email and SMS', note: 'Carries the banking details and the learner reference', on: true },
    { key: 'receiptIssued', label: 'Receipt on every recorded payment', note: 'Confirms what the school received and when', on: true },
    { key: 'reminders', label: 'Reminder at 14 and 45 days past due', note: 'Repeats the banking details', on: true },
    { key: 'monthlyStatement', label: 'Monthly statement to guardians', note: 'Full account, not just the open invoice', on: false },
    { key: 'unmatchedAlert', label: 'Alert finance when a bank line will not match', note: 'So an unidentified deposit is chased, not left', on: true },
  ],
});

export async function getFeeSettings(tenantId) {
  const row = await db.feeSettings.get(tenantId);
  return { tenantId, ...DEFAULT_FEE_SETTINGS(), ...row };
}

// --- Fee structure -----------------------------------------------------

export async function getStructureBundle(tenantId) {
  const [published, allVersions] = await Promise.all([
    db.feeStructures.findPublished(tenantId),
    db.feeStructures.list(tenantId),
  ]);
  const draft = allVersions.find((s) => s.status === 'draft') || null;
  const [publishedHeads, draftHeads] = await Promise.all([
    published ? db.feeStructureHeads.list(tenantId, { structureId: published.id }) : [],
    draft ? db.feeStructureHeads.list(tenantId, { structureId: draft.id }) : [],
  ]);
  const sortHeads = (heads) => [...heads].sort((a, b) => a.orderIndex - b.orderIndex);
  return {
    published: published && { ...published, heads: sortHeads(publishedHeads) },
    draft: draft && { ...draft, heads: sortHeads(draftHeads) },
  };
}

// Editing always targets a draft. If no draft exists yet, one is created --
// seeded from the published version's heads when there is one, so editing
// starts from "what's live today" rather than a blank grid.
export async function ensureDraftStructure(tenantId, actorId) {
  const bundle = await getStructureBundle(tenantId);
  if (bundle.draft) return bundle.draft;
  const created = await db.feeStructures.createDraft(tenantId, { createdBy: actorId });
  if (bundle.published?.heads?.length) {
    const copied = bundle.published.heads.map((h) => ({
      name: h.name, type: h.type, cycle: h.cycle,
      amountEarlyYears: h.amountEarlyYears, amountPrimary: h.amountPrimary, amountSecondary: h.amountSecondary,
      appliesTo: h.appliesTo,
    }));
    await db.feeStructureHeads.replaceForStructure(tenantId, created.id, copied);
  }
  return created;
}

export function computeAnnualTotals(heads) {
  const sum = (key) => heads.reduce((acc, h) => acc + (h[key] || 0), 0);
  return { earlyYears: sum('amountEarlyYears'), primary: sum('amountPrimary'), secondary: sum('amountSecondary') };
}

// --- Class phase lookup --------------------------------------------------

export async function phaseForClass(tenantId, className) {
  const level = await db.classLevels.findByName(tenantId, className);
  return level?.phase || null;
}

const PHASE_FIELD = { 'Early years': 'amountEarlyYears', Primary: 'amountPrimary', Secondary: 'amountSecondary' };

// --- Invoice totals / status (derived, never stored redundantly) --------

export function computeInvoiceTotals(lines) {
  const invoiced = lines.filter((l) => l.kind === 'head').reduce((a, l) => a + l.amount, 0);
  const discounts = lines.filter((l) => l.kind === 'discount' || l.kind === 'bursary').reduce((a, l) => a + l.amount, 0); // negative
  const interest = lines.filter((l) => l.kind === 'interest').reduce((a, l) => a + l.amount, 0); // positive
  const totalDue = invoiced + discounts + interest;
  return { invoiced, discounts, interest, totalDue };
}

export async function paidAllocatedFor(tenantId, invoiceId) {
  const allocations = await db.feePaymentAllocations.list(tenantId, { invoiceId });
  return allocations.reduce((a, x) => a + x.amount, 0);
}

export function deriveInvoiceStatus({ totalDue, paidAllocated, ageingDays }) {
  const balance = Number((totalDue - paidAllocated).toFixed(2));
  if (balance <= 0) return { status: 'Paid', balance: 0, ageingDays: 0 };
  if (ageingDays > 0) return { status: paidAllocated > 0 ? 'Overdue · part' : 'Overdue', balance, ageingDays };
  if (paidAllocated > 0) return { status: 'Part-paid', balance, ageingDays: 0 };
  return { status: 'Unpaid', balance, ageingDays: 0 };
}

// Full, computed view of one invoice: lines, totals, status, ageing.
export async function getInvoiceView(tenantId, invoice) {
  const lines = await db.feeInvoiceLines.list(tenantId, { invoiceId: invoice.id });
  const totals = computeInvoiceTotals(lines);
  const paidAllocated = await paidAllocatedFor(tenantId, invoice.id);
  const today = todayStr();
  const ageingDays = today > invoice.dueDate ? daysBetween(invoice.dueDate, today) : 0;
  const derived = deriveInvoiceStatus({ totalDue: totals.totalDue, paidAllocated, ageingDays });
  return { ...invoice, lines: lines.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)), ...totals, paidAllocated, ...derived };
}

// --- Sibling discount (real, computed at invoice-raise time) ------------
// A "sibling" is another active student sharing at least one non-empty
// guardian phone or email with this one. Among a sibling group, everyone
// except the eldest (earliest date of birth; missing DOB sorts as eldest,
// so an incomplete record is never randomly discounted) gets the tuition
// discount -- matches the rule note "on the younger learner".

function guardianFingerprints(student) {
  const contacts = [student.guardians?.father, student.guardians?.mother, student.guardians?.guardian].filter(Boolean);
  const prints = [];
  for (const c of contacts) {
    if (c.phone) prints.push(`p:${c.phone.replace(/\s+/g, '')}`);
    if (c.email) prints.push(`e:${c.email.toLowerCase()}`);
  }
  return prints;
}

export async function isYoungerSibling(tenantId, student) {
  const myPrints = new Set(guardianFingerprints(student));
  if (!myPrints.size) return false;
  const activeStudents = await db.students.list(tenantId, { status: 'active' });
  const siblings = activeStudents.filter((s) => guardianFingerprints(s).some((p) => myPrints.has(p)));
  if (siblings.length < 2) return false;
  const sorted = [...siblings].sort((a, b) => {
    if (!a.dateOfBirth && !b.dateOfBirth) return 0;
    if (!a.dateOfBirth) return -1; // missing DOB sorts as eldest
    if (!b.dateOfBirth) return 1;
    return a.dateOfBirth.localeCompare(b.dateOfBirth); // earlier DOB = eldest = index 0
  });
  return sorted.slice(1).some((s) => s.id === student.id);
}

// --- Invoice number / disbursement reference generators ------------------

async function nextSequence(tenantId, prefix, listFn) {
  const year = new Date().getUTCFullYear();
  const all = await listFn(tenantId);
  const pattern = new RegExp(`^${prefix}-${year}-(\\d+)$`);
  const max = all.reduce((m, row) => {
    const match = pattern.exec(row.invoiceNo || row.reference || '');
    return match ? Math.max(m, Number(match[1])) : m;
  }, 4000);
  return `${prefix}-${year}-${max + 1}`;
}

// --- Raising invoices (screen 3's "Raise invoices") ----------------------
// Manual, admin-triggered batch action -- matches this codebase's existing
// pattern everywhere else (Timetable's auto-generate, Classes & Sections'
// promotion run). Also true-ups interest on already-open invoices from
// earlier terms (see accrueInterest below) since this is the one point an
// admin reliably visits periodically -- there is no background scheduler
// anywhere in this codebase to do it silently in between.
export async function raiseInvoicesForTerm(tenantId, termLabel, actorId) {
  const [structure, students, rules] = await Promise.all([
    (async () => (await getStructureBundle(tenantId)).published)(),
    db.students.list(tenantId, { status: 'active' }),
    getStructureRules(tenantId),
  ]);
  if (!structure) throw new Error('No published fee structure -- publish one before raising invoices');
  const schedule = (await db.feeBillingSchedule.list(tenantId)).find((s) => s.termLabel === termLabel);
  if (!schedule) throw new Error(`No billing-schedule row for term "${termLabel}"`);

  let raised = 0;
  let skipped = 0;
  for (const student of students) {
    if (await db.feeInvoices.existsForStudentTerm(tenantId, student.id, termLabel)) { skipped += 1; continue; }
    const phase = await phaseForClass(tenantId, student.className);
    const field = PHASE_FIELD[phase];
    if (!field) { skipped += 1; continue; } // unknown phase -- nothing to price against

    const applicableHeads = structure.heads.filter((h) => h[field] != null && h[field] > 0);
    if (!applicableHeads.length) { skipped += 1; continue; }

    const invoiceNo = await nextSequence(tenantId, 'INV', (t) => db.feeInvoices.list(t, {}));
    const invoice = await db.feeInvoices.create({
      tenantId, invoiceNo, studentId: student.id, className: student.className, section: student.section,
      termLabel, dueDate: schedule.dueDate, structureVersion: structure.version, raisedBy: actorId,
    });

    const lines = applicableHeads.map((h) => ({ kind: 'head', label: h.name, note: `${termLabel} · ${student.className}`, qty: 1, rate: h[field], amount: h[field] }));

    if (rules.siblingDiscountPercent > 0 && await isYoungerSibling(tenantId, student)) {
      const tuition = applicableHeads.find((h) => h.name.trim().toLowerCase() === 'tuition');
      if (tuition) {
        const discount = Number((tuition[field] * rules.siblingDiscountPercent / 100).toFixed(2));
        lines.push({ kind: 'discount', label: `Sibling discount -- ${rules.siblingDiscountPercent}% of tuition`, note: '', qty: 1, rate: null, amount: -discount });
      }
    }

    await db.feeInvoiceLines.createMany(tenantId, invoice.id, lines);
    await db.audit.record({ event: 'fees.invoiceRaised', actorId, target: invoice.id, tenantId, summary: { studentId: student.id, termLabel } });
    raised += 1;
  }

  const interestCharged = await accrueInterest(tenantId, actorId);
  return { raised, skipped, interestCharged };
}

// A simple, honest monthly-interest true-up: for every OPEN invoice
// (balance > 0) more than 30 days overdue, charge one interest line for
// each whole month overdue that hasn't already been charged (counted by
// how many interest lines already exist on that invoice), on the balance
// at the time of charging. This runs when invoices are raised (the one
// point an admin reliably visits periodically) and can also be re-run on
// demand -- there is no background scheduler in this codebase to do it
// silently in between, so it is never silent: every charge is a real
// audited fee_invoice_lines row.
//
// Each month charged gets its OWN line (rather than one lump line worth
// N months) so "how many months already charged" can keep being counted
// simply as "how many interest lines already exist" -- lumping months
// into a single line would under-count on the next run (e.g. one line
// covering 4 months reads back as only 1 "already charged", so a second
// run miscounts monthsToCharge as 3 more and double-charges 3 of those
// same 4 months). One line per month keeps that count exact no matter
// how many times, or how unevenly spaced, this is re-run.
export async function accrueInterest(tenantId, actorId) {
  const rules = await getStructureRules(tenantId);
  if (rules.latePaymentInterestPercent <= 0) return 0;
  const today = todayStr();
  const invoices = await db.feeInvoices.list(tenantId, {});
  let charged = 0;
  for (const invoice of invoices) {
    if (today <= invoice.dueDate) continue;
    const lines = await db.feeInvoiceLines.list(tenantId, { invoiceId: invoice.id });
    const totals = computeInvoiceTotals(lines);
    const paidAllocated = await paidAllocatedFor(tenantId, invoice.id);
    const balance = totals.totalDue - paidAllocated;
    if (balance <= 0) continue;
    const monthsOverdue = Math.floor(daysBetween(invoice.dueDate, today) / 30);
    const alreadyCharged = lines.filter((l) => l.kind === 'interest').length;
    const monthsToCharge = monthsOverdue - alreadyCharged;
    if (monthsToCharge <= 0) continue;
    const monthlyAmount = Number((balance * (rules.latePaymentInterestPercent / 100)).toFixed(2));
    if (monthlyAmount <= 0) continue;
    const newLines = [];
    for (let m = 0; m < monthsToCharge; m += 1) {
      const monthNumber = alreadyCharged + m + 1;
      newLines.push({ kind: 'interest', label: `Late payment interest -- month ${monthNumber}`, note: `${rules.latePaymentInterestPercent}% a month on ${R(balance)}`, qty: 1, rate: null, amount: monthlyAmount });
    }
    await db.feeInvoiceLines.createMany(tenantId, invoice.id, newLines);
    await db.audit.record({ event: 'fees.interestCharged', actorId, target: invoice.id, tenantId, summary: { amount: monthlyAmount * monthsToCharge, monthsToCharge } });
    charged += 1;
  }
  return charged;
}

// --- Payments (screen 5) --------------------------------------------------

export async function recordPayment(tenantId, actorId, { studentId, amountReceived, dateReceived, method, bankReference, proofDocumentId, allocations }) {
  const payment = await db.feePayments.create({
    tenantId, studentId, amountReceived, dateReceived, method,
    bankReference: bankReference || '', proofDocumentId: proofDocumentId || null, confirmed: false, recordedBy: actorId,
  });

  let toAllocate = allocations;
  if (!toAllocate || !toAllocate.length) {
    // Default: oldest-first across this student's open invoices.
    const invoices = await db.feeInvoices.list(tenantId, { studentId });
    const views = await Promise.all(invoices.map((i) => getInvoiceView(tenantId, i)));
    const open = views.filter((v) => v.balance > 0).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    let remaining = amountReceived;
    toAllocate = [];
    for (const inv of open) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, inv.balance);
      toAllocate.push({ invoiceId: inv.id, amount: Number(take.toFixed(2)) });
      remaining -= take;
    }
  }
  const savedAllocations = await db.feePaymentAllocations.createMany(tenantId, payment.id, toAllocate);
  await db.audit.record({ event: 'fees.paymentRecorded', actorId, target: payment.id, tenantId, summary: { studentId, amountReceived, invoicesCleared: savedAllocations.length } });
  return { payment, allocations: savedAllocations };
}

// --- Bank reconciliation (screen 6) -- manual entry, real matching -------
// Matching runs reference-then-amount: an EXACT match on both the bank
// reference (against fee_payments.bankReference) and the amount is
// auto-confirmed. A same-amount-only match is "Likely" and stays for
// human review. Nothing is ever allocated twice -- a payment already
// confirmed, or already the target of a matched line, is excluded.
export async function matchBankLine(tenantId, line) {
  const payments = await db.feePayments.list(tenantId, {});
  const unconfirmed = payments.filter((p) => !p.confirmed);
  const refNorm = (line.reference || '').replace(/\s+/g, '').toLowerCase();

  const exact = unconfirmed.find((p) => p.bankReference && p.bankReference.replace(/\s+/g, '').toLowerCase() === refNorm && Number(p.amountReceived) === Number(line.amount));
  if (exact) {
    await db.feePayments.markConfirmed(tenantId, exact.id);
    return db.bankStatementLines.setMatch(tenantId, line.id, { paymentId: exact.id, confidence: 'Exact', reviewedBy: null });
  }
  const likely = unconfirmed.find((p) => Number(p.amountReceived) === Number(line.amount));
  if (likely) {
    return db.bankStatementLines.setMatch(tenantId, line.id, { paymentId: null, confidence: 'Likely', reviewedBy: null });
  }
  return db.bankStatementLines.setMatch(tenantId, line.id, { paymentId: null, confidence: 'None', reviewedBy: null });
}

// --- Arrears & payment plans (screen 7) -----------------------------------

export async function getStudentBalance(tenantId, studentId) {
  const invoices = await db.feeInvoices.list(tenantId, { studentId });
  const views = await Promise.all(invoices.map((i) => getInvoiceView(tenantId, i)));
  const open = views.filter((v) => v.balance > 0);
  const owed = open.reduce((a, v) => a + v.balance, 0);
  const oldest = open.length ? open.reduce((a, v) => (v.dueDate < a ? v.dueDate : a), open[0].dueDate) : null;
  return { owed: Number(owed.toFixed(2)), oldestDueDate: oldest, openInvoices: open };
}

export function derivePlanState(plan) {
  if (plan.status !== 'active') return plan.status === 'completed' ? 'Completing' : 'In arrears';
  const today = todayStr();
  return today > plan.nextDueDate ? 'In arrears' : 'On track';
}

export async function setupPaymentPlan(tenantId, actorId, studentId, { instalmentCount, startDate }) {
  if (!Number.isInteger(instalmentCount) || instalmentCount < 1 || instalmentCount > 6) {
    throw new Error('instalmentCount must be a whole number from 1 to 6');
  }
  const { owed, openInvoices } = await getStudentBalance(tenantId, studentId);
  if (owed <= 0) throw new Error('This learner has no outstanding balance to plan');
  const instalmentAmount = Number((owed / instalmentCount).toFixed(2));
  const plan = await db.feePaymentPlans.create({
    tenantId, studentId, totalAmount: owed, instalmentAmount, instalmentCount,
    startDate, nextDueDate: startDate, invoiceIds: openInvoices.map((i) => i.id), status: 'active', createdBy: actorId,
  });
  await db.audit.record({ event: 'fees.planCreated', actorId, target: plan.id, tenantId, summary: { studentId, instalmentCount, instalmentAmount } });
  return plan;
}
