import { and, asc, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Deps } from '../../container.js';
import {
  feeReceipts,
  paymentAllocations,
  feeDemands,
  paymentProofs,
  schoolPayments,
  students,
  users,
} from '../../db/schema/index.js';
import { recordChange } from '../../platform/record.js';
import { BusinessRuleError, NotFoundError } from '../../shared/errors.js';
import { DOCUMENT_TYPES } from '../files/file-validation.js';
import type { FileService, PreparedFile } from '../files/files.service.js';
import type { SchoolSetupService } from '../tenants/school-setup.service.js';
import { fromMinor, toMinor } from './money.js';
import { renderReceipt } from './receipt.pdf.js';
import { feeScope, loadPayment, type Caller } from './support.js';

const PROOF_MAX_BYTES = 5 * 1024 * 1024;
const MAX_PROOFS = 10;

const present = (r: typeof paymentProofs.$inferSelect) => ({
  id: r.id,
  payment_id: r.paymentId,
  file_name: r.fileName,
  uploaded_at: r.createdAt.toISOString(),
});

/** Printable receipts and the proof of payment (EFT confirmation, card slip, signed cash receipt). */
export class FeeDocumentService {
  constructor(
    private readonly deps: Deps,
    private readonly fileSvc: FileService,
    private readonly school: SchoolSetupService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  // ---- proof of payment -------------------------------------------------------------------------

  async listProofs(c: Caller, paymentId: string) {
    await loadPayment(this.db, c.tenantId, paymentId, c.principal, 'fees.read');
    const rows = await this.db
      .select()
      .from(paymentProofs)
      .where(and(eq(paymentProofs.tenantId, c.tenantId), eq(paymentProofs.paymentId, paymentId)))
      .orderBy(asc(paymentProofs.createdAt), asc(paymentProofs.id));
    return rows.map(present);
  }

  async addProof(c: Caller, paymentId: string, input: { data: unknown; filename?: string }) {
    const file: PreparedFile = await this.fileSvc.prepare(c.tenantId, input.data, {
      allowed: DOCUMENT_TYPES,
      maxBytes: PROOF_MAX_BYTES,
      label: 'Proof of payment',
      filename: input.filename,
    });
    try {
      return await this.db.transaction(async (tx) => {
        const p = await loadPayment(
          tx,
          c.tenantId,
          paymentId,
          c.principal,
          'fees.payments.create',
          'update',
        );
        const have = await tx
          .select({ id: paymentProofs.id })
          .from(paymentProofs)
          .where(and(eq(paymentProofs.tenantId, c.tenantId), eq(paymentProofs.paymentId, p.id)));
        if (have.length >= MAX_PROOFS)
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            `A payment can have at most ${MAX_PROOFS} proof files.`,
          );
        await this.fileSvc.insert(tx, c.tenantId, 'PAYMENT_PROOF', file, c.actor);
        const id = uuidv7();
        await tx.insert(paymentProofs).values({
          id,
          tenantId: c.tenantId,
          paymentId: p.id,
          fileId: file.id,
          fileName: file.name,
          uploadedBy: c.actor.userId,
        });
        await recordChange(tx, c.actor, c.tenantId, {
          action: 'FEE_PAYMENT_PROOF_ADDED',
          entityType: 'payment',
          entityId: p.id,
          after: { file_id: file.id, file_name: file.name, payment_number: p.paymentNumber },
        });
        const [row] = await tx.select().from(paymentProofs).where(eq(paymentProofs.id, id));
        return present(row!);
      });
    } catch (err) {
      await this.fileSvc.discard(file);
      throw err;
    }
  }

  async readProof(c: Caller, paymentId: string, proofId: string) {
    await loadPayment(this.db, c.tenantId, paymentId, c.principal, 'fees.read');
    const [row] = await this.db
      .select()
      .from(paymentProofs)
      .where(
        and(
          eq(paymentProofs.tenantId, c.tenantId),
          eq(paymentProofs.paymentId, paymentId),
          eq(paymentProofs.id, proofId),
        ),
      );
    if (!row) throw new NotFoundError('Proof of payment');
    return this.fileSvc.read(c.tenantId, row.fileId);
  }

  // ---- receipt PDF ------------------------------------------------------------------------------

  async receiptPdf(c: Caller, receiptId: string) {
    const [r] = await this.db
      .select()
      .from(feeReceipts)
      .where(
        and(
          eq(feeReceipts.id, receiptId),
          eq(feeReceipts.tenantId, c.tenantId),
          feeScope(c.principal, 'fees.read', feeReceipts),
        ),
      );
    if (!r) throw new NotFoundError('Receipt');
    const [p] = await this.db
      .select()
      .from(schoolPayments)
      .where(and(eq(schoolPayments.tenantId, c.tenantId), eq(schoolPayments.id, r.paymentId)));
    const [s] = await this.db
      .select()
      .from(students)
      .where(and(eq(students.tenantId, c.tenantId), eq(students.id, r.studentId)));
    if (!p || !s) throw new NotFoundError('Receipt');
    const allocs = await this.db
      .select({ a: paymentAllocations, d: feeDemands })
      .from(paymentAllocations)
      .innerJoin(
        feeDemands,
        and(
          eq(feeDemands.tenantId, paymentAllocations.tenantId),
          eq(feeDemands.id, paymentAllocations.feeDemandId),
        ),
      )
      .where(
        and(eq(paymentAllocations.tenantId, c.tenantId), eq(paymentAllocations.paymentId, p.id)),
      )
      .orderBy(asc(paymentAllocations.createdAt), asc(paymentAllocations.id));
    let applied = 0n;
    const lines: { label: string; amount: string }[] = [];
    for (const x of allocs) {
      const net = toMinor(x.a.allocatedAmount) - toMinor(x.a.reversedAmount);
      if (net <= 0n) continue;
      applied += net;
      lines.push({
        label: `${x.d.demandNumber}${x.d.description ? ` · ${x.d.description}` : ''}`,
        amount: fromMinor(net),
      });
    }
    const credit = toMinor(r.amount) - applied;

    let recordedBy: string | null = null;
    if (r.issuedBy) {
      const [u] = await this.db.select().from(users).where(eq(users.id, r.issuedBy));
      recordedBy = u ? `${u.firstName} ${u.lastName}`.trim() || null : null;
    }
    const b = await this.school.documentBranding(c.tenantId);
    const address = [b.address.line1, b.address.line2, b.address.city, b.address.postal_code]
      .filter(Boolean)
      .join(', ');
    let logo: { bytes: Buffer; mime: string } | null = null;
    if (b.logo_file_id) {
      const f = await this.fileSvc.read(c.tenantId, b.logo_file_id).catch(() => null);
      if (f) logo = { bytes: f.data, mime: f.mime };
    }
    const data = await renderReceipt({
      branding: {
        school_name: b.school_name,
        address,
        contact: [b.phone, b.email].filter(Boolean).join('  ·  '),
        footer_text: b.footer_text,
        primary_color: b.primary_color,
        logo,
      },
      receipt_number: r.receiptNumber,
      void: r.status === 'VOID',
      void_reason: r.voidReason,
      issued_on: r.issuedAt.toISOString().slice(0, 10),
      received_on: p.receivedOn,
      amount: r.amount,
      currency: r.currency,
      method: p.method,
      reference: p.providerReference ?? p.payerReference,
      received_from: p.payerName ?? 'Guardian',
      student_name: [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' '),
      student_number: s.studentNumber,
      allocations: lines,
      unallocated: credit > 0n ? fromMinor(credit) : null,
      recorded_by: recordedBy,
      notes: p.notes,
    });
    return { data, filename: `${r.receiptNumber}.pdf` };
  }
}
