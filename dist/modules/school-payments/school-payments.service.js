import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { billingInstalments, platformSettings, subscriptionInvoices, subscriptionPayments, tenants, } from '../../db/schema/index.js';
import { recordAudit } from '../../platform/audit.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { formatMinor, renderInvoice, renderPaymentReceipt } from '../billing/billing.pdf.js';
/**
 * School payments: the yearly platform fee each school pays us (default ₹10,000), agreed per
 * session (Indian financial year, 1 Apr – 31 Mar) and paid offline in agreed instalments.
 *
 * Built on the subscription billing tables: one SESSION_FEE invoice per school per session,
 * its instalments, and offline payments with receipts. What is paid towards each instalment
 * is worked out from the payments, oldest first, so changing the schedule never loses money.
 */
const CURRENCY = 'INR';
const DEFAULT_FEE_KEY = 'school_payments.default_fee_minor';
const FALLBACK_FEE_MINOR = 10_000_00;
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;
/** An instalment due within this many days shows as "Due soon". */
export const DUE_SOON_DAYS = 7;
// ---- Dates -----------------------------------------------------------------------------------
/** Calendar day in India (YYYY-MM-DD). */
export const istDay = (d) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
/** The session a day falls in: 2026-11-20 → 2026-27, 2027-02-01 → 2026-27. */
export function sessionOf(day) {
    const y = Number(day.slice(0, 4));
    const start = Number(day.slice(5, 7)) >= 4 ? y : y - 1;
    return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
export function sessionRange(session) {
    const y = Number(session.slice(0, 4));
    return { start: `${y}-04-01`, end: `${y + 1}-03-31` };
}
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
const addDays = (day, n) => new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10);
const utcDate = (day) => new Date(`${day}T00:00:00.000Z`);
const isRealDate = (day) => !Number.isNaN(Date.parse(day)) && utcDate(day).toISOString().slice(0, 10) === day;
const rupees = (minor) => `₹${formatMinor(minor, CURRENCY).replace(/\.00$/, '')}`;
/**
 * Spreads the received payments over the instalments, oldest payment to earliest instalment,
 * and works out where each instalment stands on [today].
 */
export function allocate(instalments, payments, today) {
    const pool = payments
        .slice()
        .sort((a, b) => a.receivedOn.localeCompare(b.receivedOn))
        .map((p) => ({ left: p.amountMinor, on: p.receivedOn }));
    let i = 0;
    return instalments
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((inst) => {
        let need = inst.amountMinor;
        let paidOn = null;
        while (need > 0 && i < pool.length) {
            const take = Math.min(need, pool[i].left);
            pool[i].left -= take;
            need -= take;
            paidOn = pool[i].on;
            if (pool[i].left === 0)
                i++;
        }
        const paid = inst.amountMinor - need;
        let status;
        let late = 0;
        if (need === 0) {
            late = Math.max(0, daysBetween(inst.dueDate, paidOn));
            status = late > 0 ? 'PAID_LATE' : 'PAID_ON_TIME';
        }
        else if (inst.dueDate < today) {
            status = 'OVERDUE';
            late = daysBetween(inst.dueDate, today);
        }
        else
            status = inst.dueDate <= addDays(today, DUE_SOON_DAYS) ? 'DUE_SOON' : 'UPCOMING';
        return {
            seq: inst.seq,
            due_on: inst.dueDate,
            amount_minor: inst.amountMinor,
            paid_minor: paid,
            paid_on: need === 0 ? paidOn : null,
            status,
            days_late: late,
        };
    });
}
/** How reliably a school pays: instalments paid on time vs paid late or still overdue. */
export function paymentRecord(instalments) {
    let onTime = 0;
    let late = 0;
    for (const s of instalments) {
        if (s.status === 'PAID_ON_TIME')
            onTime++;
        else if (s.status === 'PAID_LATE' || s.status === 'OVERDUE')
            late++;
    }
    const total = onTime + late;
    const rating = total === 0 ? null : late === 0 ? 'GOOD' : late * 3 <= total ? 'SOMETIMES_LATE' : 'OFTEN_LATE';
    return { on_time: onTime, late, counted: total, rating };
}
const INSTALMENT_LABEL = {
    PAID_ON_TIME: 'Paid on time',
    PAID_LATE: 'Paid late',
    OVERDUE: 'Overdue',
    DUE_SOON: 'Due soon',
    UPCOMING: 'Not due yet',
};
// ---- Service ----------------------------------------------------------------------------------
export class SchoolPaymentsService {
    deps;
    billing;
    constructor(deps, billing) {
        this.deps = deps;
        this.billing = billing;
    }
    today() {
        return istDay(this.deps.clock.now());
    }
    currentSession() {
        return sessionOf(this.today());
    }
    // ---- Settings ----------------------------------------------------------------------------
    async defaultFeeMinor() {
        const [row] = await this.deps.db
            .select()
            .from(platformSettings)
            .where(eq(platformSettings.settingKey, DEFAULT_FEE_KEY));
        const v = Number(row?.value);
        return Number.isInteger(v) && v > 0 ? v : FALLBACK_FEE_MINOR;
    }
    async settings() {
        return {
            default_fee_minor: await this.defaultFeeMinor(),
            currency: CURRENCY,
            current_session: this.currentSession(),
        };
    }
    /** Applies to fees set up from now on; fees already set up keep their amount. */
    async updateSettings(defaultFeeMinor, actor) {
        const before = await this.defaultFeeMinor();
        await this.deps.db.transaction(async (tx) => {
            await tx
                .insert(platformSettings)
                .values({ settingKey: DEFAULT_FEE_KEY, value: defaultFeeMinor, updatedBy: actor.userId })
                .onDuplicateKeyUpdate({ set: { value: defaultFeeMinor, updatedBy: actor.userId } });
            await recordAudit(tx, actor, {
                tenantId: null,
                action: 'SCHOOL_FEE_DEFAULT_CHANGED',
                entityType: 'platform_setting',
                entityId: DEFAULT_FEE_KEY,
                before: { default_fee_minor: before },
                after: { default_fee_minor: defaultFeeMinor },
            });
        });
        return this.settings();
    }
    // ---- Writes ------------------------------------------------------------------------------
    /** Checks the amounts and dates; returns the instalments in due-date order. */
    checkFee(input) {
        const discount = input.discount_minor ?? 0;
        if (discount >= input.amount_minor)
            throw new ValidationError('The discount must be smaller than the fee', {
                discount_minor: 'Must be smaller than the fee',
            });
        const total = input.amount_minor - discount;
        for (const it of input.instalments)
            if (!isRealDate(it.due_on))
                throw new ValidationError(`${it.due_on} is not a real date`, { instalments: 'Check the due dates' });
        const sum = input.instalments.reduce((n, it) => n + it.amount_minor, 0);
        if (sum !== total)
            throw new ValidationError(`The instalments add up to ${rupees(sum)}, but the fee to pay is ${rupees(total)}`, { instalments: `Must add up to ${rupees(total)}` });
        const sorted = input.instalments.slice().sort((a, b) => a.due_on.localeCompare(b.due_on));
        return { discount, total, instalments: sorted };
    }
    /** Sets a school's fee for a session (one per school per session). */
    async setUpFee(tenantId, session, input, actor) {
        const fee = this.checkFee(input);
        return this.deps.db.transaction(async (tx) => {
            const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).for('update');
            if (!tenant)
                throw new NotFoundError('School');
            const [existing] = await tx
                .select({ id: subscriptionInvoices.id })
                .from(subscriptionInvoices)
                .where(and(eq(subscriptionInvoices.tenantId, tenantId), eq(subscriptionInvoices.kind, 'SESSION_FEE'), eq(subscriptionInvoices.session, session), ne(subscriptionInvoices.status, 'VOID')));
            if (existing)
                throw new BusinessRuleError('INVALID_STATE', `The ${session} fee for this school is already set up. Change it instead.`);
            const range = sessionRange(session);
            const a = { ...actor, tenantId };
            const invoice = await this.billing.createInvoice(tx, a, {
                tenantId,
                description: `Platform fee for session ${session}`,
                currency: CURRENCY,
                subtotalMinor: input.amount_minor,
                discountMinor: fee.discount,
                periodStart: utcDate(range.start),
                periodEnd: utcDate(range.end),
                dueAt: utcDate(fee.instalments[fee.instalments.length - 1].due_on),
            });
            await tx
                .update(subscriptionInvoices)
                .set({
                kind: 'SESSION_FEE',
                session,
                discountReason: fee.discount > 0 ? input.discount_reason || null : null,
            })
                .where(eq(subscriptionInvoices.id, invoice.id));
            await tx.insert(billingInstalments).values(fee.instalments.map((it, i) => ({
                invoiceId: invoice.id,
                seq: i + 1,
                amountMinor: it.amount_minor,
                dueDate: it.due_on,
            })));
            await recordAudit(tx, a, {
                tenantId,
                action: 'SCHOOL_FEE_SET_UP',
                entityType: 'subscription_invoice',
                entityId: invoice.id,
                after: { session, total_minor: fee.total, instalments: fee.instalments },
            });
            return { invoice_id: invoice.id, invoice_number: invoice.number };
        });
    }
    /** Changes the amount, discount or schedule. The new total cannot be below what is already paid. */
    async changeFee(invoiceId, input, actor) {
        const fee = this.checkFee(input);
        await this.deps.db.transaction(async (tx) => {
            const inv = await this.lockFee(tx, invoiceId);
            if (inv.status === 'VOID')
                throw new BusinessRuleError('INVALID_STATE', 'This fee was cancelled and cannot be changed');
            if (fee.total < inv.paidMinor)
                throw new BusinessRuleError('OPERATION_NOT_ALLOWED', `${rupees(inv.paidMinor)} has already been paid, so the fee cannot be less than that`);
            const before = await tx
                .select()
                .from(billingInstalments)
                .where(eq(billingInstalments.invoiceId, inv.id))
                .orderBy(asc(billingInstalments.seq));
            await tx
                .update(subscriptionInvoices)
                .set({
                subtotalMinor: input.amount_minor,
                discountMinor: fee.discount,
                discountReason: fee.discount > 0 ? input.discount_reason || null : null,
                totalMinor: fee.total,
                dueAt: utcDate(fee.instalments[fee.instalments.length - 1].due_on),
            })
                .where(eq(subscriptionInvoices.id, inv.id));
            await tx.delete(billingInstalments).where(eq(billingInstalments.invoiceId, inv.id));
            await tx.insert(billingInstalments).values(fee.instalments.map((it, i) => ({
                invoiceId: inv.id,
                seq: i + 1,
                amountMinor: it.amount_minor,
                dueDate: it.due_on,
            })));
            await this.billing.settle(tx, inv.id);
            await recordAudit(tx, { ...actor, tenantId: inv.tenantId }, {
                tenantId: inv.tenantId,
                action: 'SCHOOL_FEE_CHANGED',
                entityType: 'subscription_invoice',
                entityId: inv.id,
                before: {
                    amount_minor: inv.subtotalMinor,
                    discount_minor: inv.discountMinor,
                    instalments: before.map((b) => ({ amount_minor: b.amountMinor, due_on: b.dueDate })),
                },
                after: {
                    amount_minor: input.amount_minor,
                    discount_minor: fee.discount,
                    instalments: fee.instalments,
                },
            });
        });
    }
    async recordPayment(invoiceId, input, actor) {
        await this.findFee(invoiceId);
        return this.billing.recordPayment(invoiceId, { ...input, received_on: input.received_on ?? utcDate(this.today()) }, actor);
    }
    async reversePayment(paymentId, reason, actor) {
        const [pay] = await this.deps.db
            .select({ invoiceId: subscriptionPayments.invoiceId })
            .from(subscriptionPayments)
            .where(eq(subscriptionPayments.id, paymentId));
        if (!pay)
            throw new NotFoundError('Payment');
        await this.findFee(pay.invoiceId);
        await this.billing.reversePayment(paymentId, reason, actor);
    }
    /** For a fee set up by mistake. Payments must be reversed first. */
    async cancelFee(invoiceId, reason, actor) {
        await this.findFee(invoiceId);
        await this.billing.voidInvoice(invoiceId, reason, actor);
    }
    async findFee(invoiceId, tenantId) {
        const [inv] = await this.deps.db
            .select()
            .from(subscriptionInvoices)
            .where(and(eq(subscriptionInvoices.id, invoiceId), eq(subscriptionInvoices.kind, 'SESSION_FEE'), tenantId ? eq(subscriptionInvoices.tenantId, tenantId) : undefined));
        if (!inv)
            throw new NotFoundError('School fee');
        return inv;
    }
    async lockFee(tx, invoiceId) {
        const [inv] = await tx
            .select()
            .from(subscriptionInvoices)
            .where(and(eq(subscriptionInvoices.id, invoiceId), eq(subscriptionInvoices.kind, 'SESSION_FEE')))
            .for('update');
        if (!inv)
            throw new NotFoundError('School fee');
        return inv;
    }
    // ---- Reads -------------------------------------------------------------------------------
    /** Session fees (with instalments and payments) for some schools, or all. */
    async loadFees(tenantIds) {
        if (tenantIds && tenantIds.length === 0)
            return [];
        const invoices = await this.deps.db
            .select()
            .from(subscriptionInvoices)
            .where(and(eq(subscriptionInvoices.kind, 'SESSION_FEE'), tenantIds ? inArray(subscriptionInvoices.tenantId, tenantIds) : undefined))
            .orderBy(desc(subscriptionInvoices.session), desc(subscriptionInvoices.issuedAt));
        if (invoices.length === 0)
            return [];
        const ids = invoices.map((i) => i.id);
        const [insts, pays] = await Promise.all([
            this.deps.db
                .select()
                .from(billingInstalments)
                .where(inArray(billingInstalments.invoiceId, ids))
                .orderBy(asc(billingInstalments.seq)),
            this.deps.db
                .select()
                .from(subscriptionPayments)
                .where(inArray(subscriptionPayments.invoiceId, ids))
                .orderBy(asc(subscriptionPayments.receivedAt), asc(subscriptionPayments.createdAt)),
        ]);
        const today = this.today();
        return invoices.map((inv) => this.present(inv, insts.filter((x) => x.invoiceId === inv.id), pays.filter((p) => p.invoiceId === inv.id), today));
    }
    /** Shapes one fee for the API (used by the reads below). */
    present(inv, insts, pays, today) {
        const received = pays.filter((p) => p.status === 'RECEIVED');
        const instalments = allocate(insts, received.map((p) => ({ amountMinor: p.amountMinor, receivedOn: day(p.receivedAt) })), today);
        const cancelled = inv.status === 'VOID';
        const pending = cancelled ? 0 : Math.max(0, inv.totalMinor - inv.paidMinor);
        const unpaid = instalments.filter((s) => s.paid_minor < s.amount_minor);
        const overdue = unpaid.filter((s) => s.status === 'OVERDUE');
        const next = unpaid[0] ?? null;
        let status;
        if (cancelled)
            status = 'CANCELLED';
        else if (inv.status === 'PAID')
            status = 'PAID';
        else if (overdue.length > 0)
            status = 'OVERDUE';
        else if (unpaid.some((s) => s.status === 'DUE_SOON'))
            status = 'DUE_SOON';
        else if (inv.paidMinor > 0)
            status = 'PART_PAID';
        else
            status = 'NOT_DUE';
        return {
            id: inv.id,
            tenant_id: inv.tenantId,
            invoice_number: inv.invoiceNumber,
            session: inv.session,
            status,
            issued_on: day(inv.issuedAt),
            amount_minor: inv.subtotalMinor,
            discount_minor: inv.discountMinor,
            discount_reason: inv.discountReason,
            total_minor: cancelled ? 0 : inv.totalMinor,
            paid_minor: inv.paidMinor,
            pending_minor: pending,
            overdue_minor: cancelled
                ? 0
                : overdue.reduce((n, s) => n + s.amount_minor - s.paid_minor, 0),
            overdue_days: cancelled ? 0 : Math.max(0, ...overdue.map((s) => s.days_late)),
            next_due: cancelled || !next ? null : { due_on: next.due_on, amount_minor: next.amount_minor - next.paid_minor },
            paid_on: inv.paidAt ? day(inv.paidAt) : null,
            cancelled_reason: cancelled ? inv.voidReason : null,
            instalments,
            payments: pays
                .slice()
                .reverse()
                .map((p) => ({
                id: p.id,
                receipt_number: p.receiptNumber,
                amount_minor: p.amountMinor,
                method: p.method,
                reference: p.reference,
                received_on: day(p.receivedAt),
                status: p.status,
                notes: p.notes,
                reverse_reason: p.reverseReason,
            })),
        };
    }
    recordOf(fees) {
        return paymentRecord(fees.filter((f) => f.status !== 'CANCELLED').flatMap((f) => f.instalments));
    }
    /** One school: every session's fee, schedule and payments, and how reliably it pays. */
    async forSchool(tenantId) {
        const [t] = await this.deps.db.select().from(tenants).where(eq(tenants.id, tenantId));
        if (!t)
            throw new NotFoundError('School');
        const fees = await this.loadFees([tenantId]);
        const live = fees.filter((f) => f.status !== 'CANCELLED');
        const current = this.currentSession();
        return {
            school: { id: t.id, name: t.name, code: t.code, status: t.status },
            currency: CURRENCY,
            current_session: current,
            default_fee_minor: await this.defaultFeeMinor(),
            current_set_up: live.some((f) => f.session === current),
            totals: {
                billed_minor: live.reduce((n, f) => n + f.total_minor, 0),
                paid_minor: live.reduce((n, f) => n + f.paid_minor, 0),
                pending_minor: live.reduce((n, f) => n + f.pending_minor, 0),
                overdue_minor: live.reduce((n, f) => n + f.overdue_minor, 0),
            },
            record: this.recordOf(fees),
            fees,
        };
    }
    /** All schools for one session: billed, received, pending, overdue, and who pays on time. */
    async overview(session) {
        const current = this.currentSession();
        const s = session ?? current;
        const schools = await this.deps.db
            .select({ id: tenants.id, name: tenants.name, code: tenants.code, status: tenants.status })
            .from(tenants)
            .where(inArray(tenants.status, ['ACTIVE', 'SUSPENDED', 'ARCHIVED']))
            .orderBy(asc(tenants.name));
        const fees = await this.loadFees(schools.map((x) => x.id));
        const byTenant = new Map();
        for (const f of fees)
            byTenant.set(f.tenant_id, [...(byTenant.get(f.tenant_id) ?? []), f]);
        const rows = schools
            .map((school) => {
            const mine = byTenant.get(school.id) ?? [];
            const fee = mine.find((f) => f.session === s && f.status !== 'CANCELLED') ?? null;
            const lastPayment = mine
                .flatMap((f) => f.payments)
                .filter((p) => p.status === 'RECEIVED')
                .map((p) => p.received_on)
                .sort()
                .pop();
            return {
                school,
                fee: fee && {
                    id: fee.id,
                    invoice_number: fee.invoice_number,
                    status: fee.status,
                    total_minor: fee.total_minor,
                    paid_minor: fee.paid_minor,
                    pending_minor: fee.pending_minor,
                    overdue_minor: fee.overdue_minor,
                    overdue_days: fee.overdue_days,
                    next_due: fee.next_due,
                    instalment_count: fee.instalments.length,
                },
                status: (fee?.status ?? 'NOT_SET_UP'),
                record: this.recordOf(mine),
                last_payment_on: lastPayment ?? null,
            };
        })
            // Archived schools only matter if they were billed for this session.
            .filter((r) => r.school.status !== 'ARCHIVED' || r.fee);
        const sessions = new Set([current, ...fees.map((f) => f.session)]);
        const count = (st) => rows.filter((r) => r.status === st).length;
        return {
            session: s,
            current_session: current,
            sessions: [...sessions].sort().reverse(),
            currency: CURRENCY,
            default_fee_minor: await this.defaultFeeMinor(),
            totals: {
                billed_minor: rows.reduce((n, r) => n + (r.fee?.total_minor ?? 0), 0),
                received_minor: rows.reduce((n, r) => n + (r.fee?.paid_minor ?? 0), 0),
                pending_minor: rows.reduce((n, r) => n + (r.fee?.pending_minor ?? 0), 0),
                overdue_minor: rows.reduce((n, r) => n + (r.fee?.overdue_minor ?? 0), 0),
                schools: rows.length,
                paid: count('PAID'),
                overdue: count('OVERDUE'),
                due_soon: count('DUE_SOON'),
                not_set_up: count('NOT_SET_UP'),
            },
            schools: rows,
        };
    }
    /** Every payment received for school fees, newest first. */
    async ledger(opts) {
        const rows = await this.deps.db
            .select({ p: subscriptionPayments, session: subscriptionInvoices.session, invoiceNumber: subscriptionInvoices.invoiceNumber, schoolName: tenants.name, schoolId: tenants.id })
            .from(subscriptionPayments)
            .innerJoin(subscriptionInvoices, eq(subscriptionInvoices.id, subscriptionPayments.invoiceId))
            .innerJoin(tenants, eq(tenants.id, subscriptionPayments.tenantId))
            .where(and(eq(subscriptionInvoices.kind, 'SESSION_FEE'), opts.session ? eq(subscriptionInvoices.session, opts.session) : undefined))
            .orderBy(desc(subscriptionPayments.receivedAt), desc(subscriptionPayments.createdAt))
            .limit(opts.limit);
        return rows.map((r) => ({
            id: r.p.id,
            receipt_number: r.p.receiptNumber,
            school: { id: r.schoolId, name: r.schoolName },
            session: r.session,
            invoice_id: r.p.invoiceId,
            invoice_number: r.invoiceNumber,
            amount_minor: r.p.amountMinor,
            method: r.p.method,
            reference: r.p.reference,
            received_on: day(r.p.receivedAt),
            status: r.p.status,
        }));
    }
    // ---- PDFs. `tenantId` limits the lookup to one school (school-side routes). ----------------
    async invoicePdf(invoiceId, tenantId) {
        const inv = await this.findFee(invoiceId, tenantId);
        const [fee] = (await this.loadFees([inv.tenantId])).filter((f) => f.id === inv.id);
        const [t] = await this.deps.db.select().from(tenants).where(eq(tenants.id, inv.tenantId));
        const data = await renderInvoice({
            issuer: this.billing.issuer(),
            invoice_number: inv.invoiceNumber,
            status: inv.status,
            void_reason: inv.voidReason,
            currency: inv.currency,
            description: inv.description,
            plan_name: null,
            issued_at: inv.issuedAt,
            due_at: inv.dueAt,
            period_start: inv.periodStart,
            period_end: inv.periodEnd,
            period_label: `Session ${inv.session} (1 April ${inv.session.slice(0, 4)} to 31 March ${Number(inv.session.slice(0, 4)) + 1})`,
            subtotal_minor: inv.subtotalMinor,
            discount_minor: inv.discountMinor,
            discount_reason: inv.discountReason,
            total_minor: inv.totalMinor,
            paid_minor: inv.paidMinor,
            bill_to: {
                name: t?.name ?? 'School',
                address: [t?.addressLine1, t?.addressLine2, t?.city, t?.state, t?.postalCode]
                    .filter(Boolean)
                    .join(', '),
                email: t?.contactEmail ?? null,
            },
            instalments: fee.instalments.map((s) => ({
                due_on: s.due_on,
                amount_minor: s.amount_minor,
                status: s.status === 'PAID_LATE'
                    ? `Paid late (${s.paid_on})`
                    : s.status === 'PAID_ON_TIME'
                        ? `Paid (${s.paid_on})`
                        : s.paid_minor > 0
                            ? `${INSTALMENT_LABEL[s.status]}, ${CURRENCY} ${formatMinor(s.paid_minor, CURRENCY)} paid`
                            : INSTALMENT_LABEL[s.status],
            })),
            payments: fee.payments
                .slice()
                .reverse()
                .map((p) => ({
                receipt_number: p.receipt_number,
                received_at: utcDate(p.received_on),
                method: p.method,
                reference: p.reference,
                amount_minor: p.amount_minor,
                reversed: p.status === 'REVERSED',
            })),
        });
        return { data, filename: `${inv.invoiceNumber}.pdf` };
    }
    async receiptPdf(paymentId, tenantId) {
        const [pay] = await this.deps.db
            .select()
            .from(subscriptionPayments)
            .where(and(eq(subscriptionPayments.id, paymentId), tenantId ? eq(subscriptionPayments.tenantId, tenantId) : undefined));
        if (!pay)
            throw new NotFoundError('Payment');
        const inv = await this.findFee(pay.invoiceId, tenantId);
        // Balance as it stood right after this payment, not today's.
        const upTo = await this.deps.db
            .select()
            .from(subscriptionPayments)
            .where(and(eq(subscriptionPayments.invoiceId, inv.id), eq(subscriptionPayments.status, 'RECEIVED')));
        const paidThen = upTo
            .filter((p) => p.createdAt.getTime() <= pay.createdAt.getTime())
            .reduce((n, p) => n + p.amountMinor, 0);
        const [t] = await this.deps.db.select().from(tenants).where(eq(tenants.id, pay.tenantId));
        const data = await renderPaymentReceipt({
            issuer: this.billing.issuer(),
            receipt_number: pay.receiptNumber,
            reversed: pay.status === 'REVERSED',
            reverse_reason: pay.reverseReason,
            currency: pay.currency,
            amount_minor: pay.amountMinor,
            method: pay.method,
            reference: pay.reference,
            received_at: pay.receivedAt,
            invoice_number: inv.invoiceNumber,
            invoice_total_minor: inv.totalMinor,
            invoice_paid_minor: pay.status === 'REVERSED' ? inv.paidMinor : paidThen,
            received_from: t?.name ?? 'School',
            for_label: `Platform fee, session ${inv.session}`,
            notes: pay.notes,
        });
        return { data, filename: `${pay.receiptNumber}.pdf` };
    }
}
const day = (d) => d.toISOString().slice(0, 10);
