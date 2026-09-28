import PDFDocument from 'pdfkit';
import { badRequest } from '../../core/errors.js';
import { db } from '../../db/index.js';

// Payroll (Teachers & Staff) -- business rules, kept free of Express so
// routes stay thin and the seed can reuse the same calculation.
//
// Scope (agreed 2026-09-24): record & report. Salaries are paid OUTSIDE
// the system and marked as paid here, same trust boundary as Fees. No
// statutory tax tables: each deduction is an admin-entered fixed amount
// or a percentage of pay after unpaid leave.
//
// Calculation for one staff member for one month:
//   gross          = basic + sum(allowances)
//   leaveDeduction = basic / weekdays-in-month x approved unpaid-leave
//                    weekdays falling in that month (capped at basic)
//   pay after leave= gross - leaveDeduction
//   each deduction = fixed value, or value% of pay after leave
//   net            = pay after leave - sum(deductions)
// All money is rounded to cents at every step.

export const PAYROLL_STAFF_STATUSES = new Set(['active', 'probation']);
const MAX_AMOUNT = 100_000_000;
const MAX_ITEMS = 20;

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function validPeriod(period) {
  if (typeof period !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return false;
  const year = Number(period.slice(0, 4));
  return year >= 2000 && year <= 2100;
}

function periodBounds(period) {
  const [y, m] = period.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  return { first, last, firstStr: first.toISOString().slice(0, 10), lastStr: last.toISOString().slice(0, 10) };
}

const isWeekday = (d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;

export function weekdaysInPeriod(period) {
  const { first, last } = periodBounds(period);
  let count = 0;
  for (let d = new Date(first); d <= last; d.setUTCDate(d.getUTCDate() + 1)) if (isWeekday(d)) count += 1;
  return count;
}

/** Weekdays of [startDate, endDate] that fall inside `period`. */
export function overlappingWeekdays(startDate, endDate, period) {
  const { firstStr, lastStr } = periodBounds(period);
  const from = startDate > firstStr ? startDate : firstStr;
  const to = endDate < lastStr ? endDate : lastStr;
  if (from > to) return 0;
  let count = 0;
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) if (isWeekday(d)) count += 1;
  return count;
}

// --- Pay setup validation ---

function cleanAmount(value, label) {
  const n = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(n)) throw badRequest(`${label} must be a number`);
  if (n < 0) throw badRequest(`${label} cannot be negative`);
  if (n > MAX_AMOUNT) throw badRequest(`${label} is too large`);
  return round2(n);
}

function cleanLabel(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${label} needs a name`);
  const text = value.trim();
  if (text.length > 60) throw badRequest(`${label} name must be 60 characters or fewer`);
  return text;
}

/** Validates and normalises a PUT /profiles/:staffId body. `existing` keeps the stored account number when the client sends it blank/masked. */
export function sanitizePayProfile(body, existing) {
  body = body || {};
  const basicSalary = cleanAmount(body.basicSalary, 'Basic salary');

  const allowancesIn = Array.isArray(body.allowances) ? body.allowances : [];
  if (allowancesIn.length > MAX_ITEMS) throw badRequest(`At most ${MAX_ITEMS} allowances`);
  const allowances = allowancesIn.map((a, i) => ({
    label: cleanLabel(a?.label, `Allowance ${i + 1}`),
    amount: cleanAmount(a?.amount, `Allowance "${a?.label ?? i + 1}" amount`),
  }));

  const deductionsIn = Array.isArray(body.deductions) ? body.deductions : [];
  if (deductionsIn.length > MAX_ITEMS) throw badRequest(`At most ${MAX_ITEMS} deductions`);
  const deductions = deductionsIn.map((d, i) => {
    const label = cleanLabel(d?.label, `Deduction ${i + 1}`);
    const type = d?.type === 'percent' ? 'percent' : d?.type === 'fixed' ? 'fixed' : null;
    if (!type) throw badRequest(`Deduction "${label}" type must be fixed or percent`);
    const value = cleanAmount(d?.value, `Deduction "${label}" value`);
    if (type === 'percent' && value > 100) throw badRequest(`Deduction "${label}" percentage cannot exceed 100`);
    return { label, type, value };
  });

  const bankIn = body.bank || {};
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  let accountNumber = str(bankIn.accountNumber, 30).replace(/\s+/g, '');
  // A masked value (e.g. "••••1234") or blank means "keep what's stored".
  if (!accountNumber || accountNumber.includes('•') || accountNumber.includes('*')) accountNumber = existing?.bank?.accountNumber || '';
  if (accountNumber && !/^\d{6,20}$/.test(accountNumber)) throw badRequest('Account number must be 6-20 digits');
  const branchCode = str(bankIn.branchCode, 12);
  if (branchCode && !/^\d{4,10}$/.test(branchCode)) throw badRequest('Branch code must be 4-10 digits');
  const bank = {
    accountHolder: str(bankIn.accountHolder, 100),
    bankName: str(bankIn.bankName, 60),
    accountNumber,
    branchCode,
    verified: bankIn.verified === true && Boolean(accountNumber),
  };

  return { basicSalary, allowances, deductions, bank };
}

export const maskAccount = (n) => (n ? `••••${String(n).slice(-4)}` : '');

/** Pay setup as returned to the client: account number masked, never the full value. */
export function publicPayProfile(profile) {
  if (!profile) return null;
  const { tenantId, ...rest } = profile;
  return { ...rest, bank: { ...(profile.bank || {}), accountNumber: maskAccount(profile.bank?.accountNumber) }, hasAccountNumber: Boolean(profile.bank?.accountNumber) };
}

// --- Calculation ---

export function calculatePayslip({ staff, profile, unpaidLeaveDays, period }) {
  const basic = round2(profile.basicSalary || 0);
  const allowances = (profile.allowances || []).map((a) => ({ label: a.label, amount: round2(a.amount) }));
  const grossPay = round2(basic + allowances.reduce((sum, a) => sum + a.amount, 0));

  const workingDays = weekdaysInPeriod(period);
  const leaveDeduction = workingDays && unpaidLeaveDays > 0
    ? Math.min(basic, round2((basic / workingDays) * unpaidLeaveDays))
    : 0;
  const payAfterLeave = round2(grossPay - leaveDeduction);

  const deductions = (profile.deductions || []).map((d) => ({
    label: d.label,
    type: d.type,
    value: d.value,
    amount: d.type === 'percent' ? round2(payAfterLeave * d.value / 100) : round2(d.value),
  }));
  const deductionsSum = round2(deductions.reduce((sum, d) => sum + d.amount, 0));
  const totalDeductions = round2(leaveDeduction + deductionsSum);
  const netPay = round2(grossPay - totalDeductions);

  const bank = profile.bank || {};
  const exceptions = [];
  if (!bank.accountNumber) exceptions.push('No bank account on file');
  else if (!bank.verified) exceptions.push('Bank details not verified');
  if (netPay < 0) exceptions.push('Deductions exceed pay');
  if (grossPay === 0) exceptions.push('No pay set up');

  return {
    staffId: staff.id,
    period,
    staffName: `${staff.firstName} ${staff.lastName}`.trim(),
    employeeId: staff.employeeId,
    department: staff.department || 'Unassigned',
    designation: staff.designation || '',
    basicSalary: basic,
    allowances,
    grossPay,
    unpaidLeaveDays,
    leaveDeduction,
    deductions,
    totalDeductions,
    netPay,
    bankVerified: Boolean(bank.accountNumber && bank.verified),
    bankSummary: bank.accountNumber ? `${bank.bankName || 'Bank'} ${maskAccount(bank.accountNumber)}` : null,
    exceptions,
  };
}

async function unpaidLeaveDaysFor(tenantId, staffId, period) {
  const leave = await db.staffLeave.list(tenantId, { staffId, status: 'approved' });
  return leave
    .filter((l) => l.leaveType === 'Unpaid leave')
    .reduce((sum, l) => sum + overlappingWeekdays(l.startDate, l.endDate, period), 0);
}

/** Staff who should be paid for `period`: active/probation, joined on or before the month's last day. */
async function payableStaff(tenantId, period) {
  const { lastStr } = periodBounds(period);
  const staff = await db.staff.list(tenantId, {});
  return staff
    .filter((s) => PAYROLL_STAFF_STATUSES.has(s.status || 'active'))
    .filter((s) => !s.joiningDate || s.joiningDate <= lastStr)
    .sort((a, b) => `${a.department}${a.lastName}`.localeCompare(`${b.department}${b.lastName}`));
}

export function summarise(payslips) {
  const totals = { heads: payslips.length, gross: 0, deductions: 0, net: 0, exceptions: 0 };
  const byDept = new Map();
  for (const p of payslips) {
    totals.gross += p.grossPay; totals.deductions += p.totalDeductions; totals.net += p.netPay;
    if ((p.exceptions || []).length) totals.exceptions += 1;
    const d = byDept.get(p.department) || { department: p.department, heads: 0, gross: 0, deductions: 0, net: 0, exceptions: 0 };
    d.heads += 1; d.gross += p.grossPay; d.deductions += p.totalDeductions; d.net += p.netPay;
    if ((p.exceptions || []).length) d.exceptions += 1;
    byDept.set(p.department, d);
  }
  for (const k of ['gross', 'deductions', 'net']) totals[k] = round2(totals[k]);
  const departments = [...byDept.values()]
    .map((d) => ({ ...d, gross: round2(d.gross), deductions: round2(d.deductions), net: round2(d.net) }))
    .sort((a, b) => a.department.localeCompare(b.department));
  return { totals, departments };
}

/** (Re)builds every payslip of a draft run from current pay setups + leave. */
export async function calculateRun(tenantId, run) {
  const staff = await payableStaff(tenantId, run.period);
  const payslips = [];
  const missingProfiles = [];
  for (const member of staff) {
    const profile = await db.payProfiles.findByStaff(tenantId, member.id);
    if (!profile) {
      missingProfiles.push({ staffId: member.id, staffName: `${member.firstName} ${member.lastName}`.trim(), employeeId: member.employeeId, department: member.department });
      continue;
    }
    const unpaidLeaveDays = await unpaidLeaveDaysFor(tenantId, member.id, run.period);
    payslips.push(calculatePayslip({ staff: member, profile, unpaidLeaveDays, period: run.period }));
  }

  await db.payslips.removeByRun(tenantId, run.id);
  for (const slip of payslips) await db.payslips.create({ tenantId, runId: run.id, ...slip });
  const { totals } = summarise(payslips);
  return db.payrollRuns.update(tenantId, run.id, { totals, missingProfiles, calculatedAt: new Date().toISOString() });
}

/** Full run view for the Payroll summary screen. */
export async function runView(tenantId, run) {
  const payslips = (await db.payslips.list(tenantId, { runId: run.id }))
    .sort((a, b) => `${a.department}${a.staffName}`.localeCompare(`${b.department}${b.staffName}`));
  const { totals, departments } = summarise(payslips);
  const { tenantId: _t, ...cleanRun } = run;
  return {
    run: { ...cleanRun, totals, missingProfiles: run.missingProfiles || [] },
    departments,
    payslips: payslips.map(({ tenantId: _x, ...p }) => p),
  };
}

// --- Payslip PDF ---

export async function generatePayslipPdf({ tenant, payslip, run, formatMoney }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const money = formatMoney || ((n) => Number(n).toFixed(2));
  const [y, m] = payslip.period.split('-').map(Number);
  const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  doc.fontSize(16).fillColor('#1E2D42').text(tenant?.name || 'School');
  doc.fontSize(10).fillColor('#6366F1').text(`PAYSLIP · ${monthLabel.toUpperCase()}`);
  doc.moveDown(0.8);
  doc.fillColor('#13213B').fontSize(10);
  doc.text(`Employee: ${payslip.staffName}  (${payslip.employeeId})`);
  doc.text(`Department: ${payslip.department}${payslip.designation ? `  ·  ${payslip.designation}` : ''}`);
  doc.text(`Paid into: ${payslip.bankSummary || 'No bank account on file'}${payslip.bankVerified ? '' : '  (not verified)'}`);
  doc.text(`Run status: ${run.status}${run.paidOn ? `  ·  paid ${run.paidOn}` : ''}`);
  doc.moveDown(0.8);

  const left = 40; const right = doc.page.width - 40;
  const line = (label, value, { bold = false } = {}) => {
    const yPos = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, left, yPos, { width: 330 });
    doc.text(value, left + 330, yPos, { width: right - left - 330, align: 'right' });
    doc.moveDown(0.3);
  };
  const section = (title) => {
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fillColor('#6366F1').text(title.toUpperCase(), left);
    doc.fillColor('#13213B');
    doc.moveTo(left, doc.y + 2).lineTo(right, doc.y + 2).strokeColor('#E4EBF5').stroke();
    doc.moveDown(0.4);
  };

  section('Earnings');
  line('Basic salary', money(payslip.basicSalary));
  for (const a of payslip.allowances || []) line(a.label, money(a.amount));
  line('Gross pay', money(payslip.grossPay), { bold: true });

  section('Deductions');
  if (payslip.leaveDeduction > 0) line(`Unpaid leave (${payslip.unpaidLeaveDays} day${payslip.unpaidLeaveDays === 1 ? '' : 's'})`, money(payslip.leaveDeduction));
  for (const d of payslip.deductions || []) line(d.type === 'percent' ? `${d.label} (${d.value}%)` : d.label, money(d.amount));
  if (!payslip.leaveDeduction && !(payslip.deductions || []).length) line('None', money(0));
  line('Total deductions', money(payslip.totalDeductions), { bold: true });

  section('Net pay');
  line('Net pay', money(payslip.netPay), { bold: true });

  doc.moveDown(1.5);
  doc.font('Helvetica').fontSize(8).fillColor('#64748B').text(
    'Recorded by the school administration. Salary is paid outside this system; tax and other deductions are as captured by the school.',
    left, doc.y, { width: right - left },
  );
  doc.end();
  return done;
}
