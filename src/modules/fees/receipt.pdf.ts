import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import {
  colorOf,
  drawCentered,
  embed,
  safe,
  wrap,
  type PdfBranding,
} from '../students/certificates.pdf.js';

export interface ReceiptPdfInput {
  branding: PdfBranding;
  receipt_number: string;
  void: boolean;
  void_reason: string | null;
  issued_on: string;
  received_on: string;
  amount: string;
  currency: string;
  method: string;
  reference: string | null;
  received_from: string;
  student_name: string;
  student_number: string;
  allocations: { label: string; amount: string }[];
  unallocated: string | null;
  recorded_by: string | null;
  notes: string | null;
}

const METHODS: Record<string, string> = {
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer (EFT)',
  CHEQUE: 'Cheque',
  CARD: 'Card at reception',
  OTHER: 'Other',
};

/** A5 receipt: school header, who paid for whom, what it was applied to, and the total. */
export async function renderReceipt(o: ReceiptPdfInput): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([420, 595]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const brand = colorOf(o.branding.primary_color);
  const ink = rgb(0.1, 0.12, 0.18);
  const muted = rgb(0.4, 0.44, 0.5);
  const left = 36;
  const right = 420 - 36;
  let y = 560;

  const logo = await embed(pdf, o.branding.logo);
  if (logo) {
    const h = 40;
    const w = (logo.width / logo.height) * h;
    page.drawImage(logo, { x: (420 - w) / 2, y: y - h, width: w, height: h });
    y -= h + 8;
  }
  drawCentered(page, bold, o.branding.school_name, y - 14, 15, brand);
  y -= 30;
  for (const line of wrap(regular, o.branding.address, 9, 340)) {
    drawCentered(page, regular, line, y, 9, muted);
    y -= 12;
  }
  if (o.branding.contact) {
    drawCentered(page, regular, o.branding.contact, y, 9, muted);
    y -= 12;
  }
  y -= 8;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: brand });
  y -= 26;
  drawCentered(
    page,
    bold,
    o.void ? 'RECEIPT (VOID)' : 'RECEIPT',
    y,
    16,
    o.void ? rgb(0.8, 0.1, 0.2) : ink,
  );
  y -= 28;

  const row = (label: string, value: string) => {
    page.drawText(safe(regular, label), { x: left, y, size: 9, font: regular, color: muted });
    const lines = wrap(bold, value, 10, right - left - 120);
    lines.forEach((l, i) =>
      page.drawText(l, { x: left + 120, y: y - i * 13, size: 10, font: bold, color: ink }),
    );
    y -= Math.max(1, lines.length) * 13 + 4;
  };
  row('Receipt no.', o.receipt_number);
  row('Date issued', o.issued_on);
  row('Date received', o.received_on);
  row('Received from', o.received_from);
  row('For ltudent', `${o.student_name} (${o.student_number})`);
  row('Method', METHODS[o.method] ?? o.method);
  if (o.reference) row('Reference', o.reference);

  y -= 8;
  page.drawText('Applied to', { x: left, y, size: 10, font: bold, color: brand });
  y -= 6;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.5, color: muted });
  y -= 14;
  const money = (v: string) => `${o.currency} ${v}`;
  const putAmount = (v: string, size = 10, font = regular) => {
    const t = safe(font, money(v));
    page.drawText(t, { x: right - font.widthOfTextAtSize(t, size), y, size, font, color: ink });
  };
  for (const a of o.allocations.slice(0, 12)) {
    const lines = wrap(regular, a.label, 9.5, 250);
    page.drawText(lines[0] ?? '', { x: left, y, size: 9.5, font: regular, color: ink });
    putAmount(a.amount, 9.5);
    y -= 14;
  }
  if (o.allocations.length > 12) {
    page.drawText(`and ${o.allocations.length - 12} more`, {
      x: left,
      y,
      size: 9,
      font: regular,
      color: muted,
    });
    y -= 14;
  }
  if (o.unallocated) {
    page.drawText('Kept as credit on the account', {
      x: left,
      y,
      size: 9.5,
      font: regular,
      color: ink,
    });
    putAmount(o.unallocated, 9.5);
    y -= 14;
  }
  y -= 4;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: ink });
  y -= 20;
  page.drawText('Total received', { x: left, y, size: 12, font: bold, color: ink });
  putAmount(o.amount, 12, bold);
  y -= 28;

  if (o.notes) {
    for (const l of wrap(regular, `Note: ${o.notes}`, 9, right - left)) {
      page.drawText(l, { x: left, y, size: 9, font: regular, color: muted });
      y -= 12;
    }
  }
  if (o.void) {
    for (const l of wrap(bold, `Voided: ${o.void_reason ?? ''}`, 9, right - left)) {
      page.drawText(l, { x: left, y, size: 9, font: bold, color: rgb(0.8, 0.1, 0.2) });
      y -= 12;
    }
  }
  if (o.recorded_by)
    page.drawText(`Recorded by ${safe(regular, o.recorded_by)}`, {
      x: left,
      y: 60,
      size: 8.5,
      font: regular,
      color: muted,
    });
  if (o.branding.footer_text) {
    wrap(regular, o.branding.footer_text, 8, right - left)
      .slice(0, 2)
      .forEach((l, i) => drawCentered(page, regular, l, 40 - i * 10, 8, muted));
  }
  return Buffer.from(await pdf.save());
}
