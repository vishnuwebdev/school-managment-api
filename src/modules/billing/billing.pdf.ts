import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { drawCentered, safe, wrap } from '../students/certificates.pdf.js';

export const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer (EFT)',
  CHEQUE: 'Cheque',
  CARD: 'Card',
  MOBILE_MONEY: 'Mobile money',
  OTHER: 'Other',
};

/** 1234500 minor units → "12,345.00". */
export function formatMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');
const ink = rgb(0.1, 0.12, 0.18);
const muted = rgb(0.4, 0.44, 0.5);
const brand = rgb(0.1, 0.25, 0.6);
const red = rgb(0.8, 0.1, 0.2);
const green = rgb(0.05, 0.5, 0.25);

export interface Issuer {
  name: string;
  details: string;
}

export interface InvoicePdfInput {
  issuer: Issuer;
  invoice_number: string;
  status: 'OPEN' | 'PAID' | 'VOID';
  void_reason: string | null;
  currency: string;
  description: string;
  plan_name: string | null;
  issued_at: Date;
  due_at: Date;
  period_start: Date | null;
  period_end: Date | null;
  subtotal_minor: number;
  discount_minor: number;
  total_minor: number;
  paid_minor: number;
  bill_to: { name: string; address: string; email: string | null };
  payments: {
    receipt_number: string;
    received_at: Date;
    method: string;
    reference: string | null;
    amount_minor: number;
    reversed: boolean;
  }[];
}

/** A4 invoice for a school's subscription. */
export async function renderInvoice(o: InvoicePdfInput): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const left = 44;
  const right = 595 - 44;
  let y = 790;
  const money = (n: number) => `${o.currency} ${formatMinor(n)}`;
  const putRight = (text: string, yy: number, size = 10, font = regular, color = ink) => {
    const t = safe(font, text);
    page.drawText(t, { x: right - font.widthOfTextAtSize(t, size), y: yy, size, font, color });
  };

  page.drawText(safe(bold, o.issuer.name), { x: left, y, size: 16, font: bold, color: brand });
  putRight('INVOICE', y, 22, bold, ink);
  y -= 16;
  for (const line of o.issuer.details.split('\n').filter(Boolean).slice(0, 4)) {
    page.drawText(safe(regular, line), { x: left, y, size: 9, font: regular, color: muted });
    y -= 12;
  }
  y = Math.min(y, 760) - 10;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: brand });
  y -= 24;

  // Bill-to (left) and invoice facts (right)
  const top = y;
  page.drawText('Billed to', { x: left, y, size: 9, font: regular, color: muted });
  y -= 14;
  page.drawText(safe(bold, o.bill_to.name), { x: left, y, size: 11, font: bold, color: ink });
  y -= 14;
  for (const l of wrap(regular, o.bill_to.address, 9.5, 260)) {
    page.drawText(l, { x: left, y, size: 9.5, font: regular, color: ink });
    y -= 12;
  }
  if (o.bill_to.email) {
    page.drawText(safe(regular, o.bill_to.email), {
      x: left,
      y,
      size: 9.5,
      font: regular,
      color: ink,
    });
    y -= 12;
  }
  const facts: [string, string][] = [
    ['Invoice no.', o.invoice_number],
    ['Date issued', day(o.issued_at)],
    ['Due date', day(o.due_at)],
  ];
  let fy = top;
  for (const [k, v] of facts) {
    page.drawText(k, { x: 360, y: fy, size: 9, font: regular, color: muted });
    putRight(v, fy, 10, bold);
    fy -= 15;
  }
  y = Math.min(y, fy) - 22;

  // Line item
  page.drawRectangle({
    x: left,
    y: y - 6,
    width: right - left,
    height: 22,
    color: rgb(0.94, 0.95, 0.98),
  });
  page.drawText('Description', { x: left + 8, y, size: 9.5, font: bold, color: ink });
  putRight('Amount', y, 9.5, bold);
  y -= 24;
  const lines = wrap(regular, o.description, 10, 360);
  lines.forEach((l, i) =>
    page.drawText(l, { x: left + 8, y: y - i * 13, size: 10, font: regular, color: ink }),
  );
  putRight(money(o.subtotal_minor), y);
  y -= Math.max(1, lines.length) * 13;
  if (o.period_start && o.period_end) {
    page.drawText(`Service period: ${day(o.period_start)} to ${day(o.period_end)}`, {
      x: left + 8,
      y,
      size: 9,
      font: regular,
      color: muted,
    });
    y -= 13;
  }
  y -= 10;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.5, color: muted });
  y -= 18;
  const total = (label: string, value: string, f = regular, size = 10, color = ink) => {
    page.drawText(label, { x: 360, y, size, font: f, color });
    putRight(value, y, size, f, color);
    y -= 17;
  };
  total('Subtotal', money(o.subtotal_minor));
  if (o.discount_minor > 0) total('Discount', `- ${money(o.discount_minor)}`);
  total('Total', money(o.total_minor), bold, 11);
  total('Paid', money(o.paid_minor));
  total(
    'Balance due',
    money(Math.max(0, o.total_minor - o.paid_minor)),
    bold,
    12,
    o.status === 'OPEN' ? red : green,
  );

  // Payments
  y -= 12;
  page.drawText('Payments received', { x: left, y, size: 10.5, font: bold, color: brand });
  y -= 8;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.5, color: muted });
  y -= 14;
  if (o.payments.length === 0) {
    page.drawText('No payment has been received yet.', {
      x: left,
      y,
      size: 9.5,
      font: regular,
      color: muted,
    });
    y -= 14;
  }
  for (const p of o.payments.slice(0, 14)) {
    const label = `${p.receipt_number}   ${day(p.received_at)}   ${METHOD_LABEL[p.method] ?? p.method}${p.reference ? `   Ref ${p.reference}` : ''}${p.reversed ? '   (reversed)' : ''}`;
    page.drawText(safe(regular, label).slice(0, 95), {
      x: left,
      y,
      size: 9.5,
      font: regular,
      color: p.reversed ? muted : ink,
    });
    putRight(money(p.amount_minor), y, 9.5, regular, p.reversed ? muted : ink);
    y -= 14;
  }

  if (o.status === 'PAID') drawCentered(page, bold, 'PAID', 150, 40, green);
  if (o.status === 'VOID') {
    drawCentered(page, bold, 'VOID', 150, 40, red);
    for (const [i, l] of wrap(regular, `Voided: ${o.void_reason ?? ''}`, 9, right - left).entries())
      drawCentered(page, regular, l, 128 - i * 12, 9, red);
  }
  drawCentered(
    page,
    regular,
    'Payment for this invoice is made offline. Please quote the invoice number as your reference.',
    50,
    8.5,
    muted,
  );
  return Buffer.from(await pdf.save());
}

export interface ReceiptPdfInput {
  issuer: Issuer;
  receipt_number: string;
  reversed: boolean;
  reverse_reason: string | null;
  currency: string;
  amount_minor: number;
  method: string;
  reference: string | null;
  received_at: Date;
  invoice_number: string;
  invoice_total_minor: number;
  invoice_paid_minor: number;
  received_from: string;
  notes: string | null;
}

/** A5 acknowledgement of one payment received for a subscription invoice. */
export async function renderPaymentReceipt(o: ReceiptPdfInput): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([420, 595]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const left = 36;
  const right = 420 - 36;
  let y = 555;
  drawCentered(page, bold, o.issuer.name, y, 15, brand);
  y -= 16;
  for (const l of o.issuer.details.split('\n').filter(Boolean).slice(0, 3)) {
    drawCentered(page, regular, l, y, 9, muted);
    y -= 12;
  }
  y -= 6;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: brand });
  y -= 30;
  drawCentered(
    page,
    bold,
    o.reversed ? 'RECEIPT (REVERSED)' : 'RECEIPT',
    y,
    16,
    o.reversed ? red : ink,
  );
  y -= 30;
  const row = (label: string, value: string) => {
    page.drawText(label, { x: left, y, size: 9, font: regular, color: muted });
    wrap(bold, value, 10, right - left - 120).forEach((l, i) =>
      page.drawText(l, { x: left + 120, y: y - i * 13, size: 10, font: bold, color: ink }),
    );
    y -= 20;
  };
  row('Receipt no.', o.receipt_number);
  row('Date received', day(o.received_at));
  row('Received from', o.received_from);
  row('Method', METHOD_LABEL[o.method] ?? o.method);
  if (o.reference) row('Reference', o.reference);
  row('For invoice', o.invoice_number);
  y -= 6;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: ink });
  y -= 22;
  const amt = safe(bold, `${o.currency} ${formatMinor(o.amount_minor)}`);
  page.drawText('Amount received', { x: left, y, size: 12, font: bold, color: ink });
  page.drawText(amt, {
    x: right - bold.widthOfTextAtSize(amt, 12),
    y,
    size: 12,
    font: bold,
    color: ink,
  });
  y -= 24;
  const bal = Math.max(0, o.invoice_total_minor - o.invoice_paid_minor);
  const balText = safe(regular, `${o.currency} ${formatMinor(bal)}`);
  page.drawText('Invoice balance after this payment', {
    x: left,
    y,
    size: 9.5,
    font: regular,
    color: muted,
  });
  page.drawText(balText, {
    x: right - regular.widthOfTextAtSize(balText, 9.5),
    y,
    size: 9.5,
    font: regular,
    color: muted,
  });
  y -= 24;
  for (const l of wrap(regular, o.notes ? `Note: ${o.notes}` : '', 9, right - left)) {
    page.drawText(l, { x: left, y, size: 9, font: regular, color: muted });
    y -= 12;
  }
  if (o.reversed)
    for (const l of wrap(bold, `Reversed: ${o.reverse_reason ?? ''}`, 9, right - left)) {
      page.drawText(l, { x: left, y, size: 9, font: bold, color: red });
      y -= 12;
    }
  return Buffer.from(await pdf.save());
}
