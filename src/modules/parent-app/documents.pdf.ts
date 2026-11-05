import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import {
  colorOf,
  drawCentered,
  embed,
  safe,
  wrap,
  type PdfBranding,
} from '../students/certificates.pdf.js';

const W = 595; // A4 portrait
const H = 842;
const LEFT = 48;
const RIGHT = W - 48;
const INK = rgb(0.1, 0.12, 0.18);
const MUTED = rgb(0.4, 0.44, 0.5);
const LINE = rgb(0.82, 0.84, 0.88);

interface Ctx {
  pdf: PDFDocument;
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
  brand: ReturnType<typeof colorOf>;
  y: number;
}

async function start(b: PdfBranding, title: string): Promise<Ctx> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([W, H]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const brand = colorOf(b.primary_color);
  let y = H - 40;
  const logo = await embed(pdf, b.logo);
  if (logo) {
    const h = 44;
    const w = (logo.width / logo.height) * h;
    page.drawImage(logo, { x: (W - w) / 2, y: y - h, width: w, height: h });
    y -= h + 8;
  }
  drawCentered(page, bold, b.school_name, y - 16, 17, brand);
  y -= 34;
  for (const line of wrap(regular, b.address, 9, 420)) {
    drawCentered(page, regular, line, y, 9, MUTED);
    y -= 12;
  }
  if (b.contact) {
    drawCentered(page, regular, b.contact, y, 9, MUTED);
    y -= 12;
  }
  y -= 8;
  page.drawLine({ start: { x: LEFT, y }, end: { x: RIGHT, y }, thickness: 1.2, color: brand });
  y -= 30;
  drawCentered(page, bold, title, y, 16, INK);
  y -= 30;
  return { pdf, page, regular, bold, brand, y };
}

function facts(c: Ctx, rows: [string, string][]) {
  const colW = (RIGHT - LEFT) / 2;
  rows.forEach(([label, value], i) => {
    const x = LEFT + (i % 2) * colW;
    if (i % 2 === 0 && i > 0) c.y -= 30;
    c.page.drawText(safe(c.regular, label), {
      x,
      y: c.y,
      size: 8.5,
      font: c.regular,
      color: MUTED,
    });
    c.page.drawText(wrap(c.bold, value || '-', 10.5, colW - 12)[0] ?? '-', {
      x,
      y: c.y - 13,
      size: 10.5,
      font: c.bold,
      color: INK,
    });
  });
  c.y -= 42;
}

/** A table with a header row; numeric columns are right-aligned. */
function table(
  c: Ctx,
  cols: { label: string; width: number; align?: 'left' | 'right' }[],
  rows: string[][],
  opts: { boldLast?: boolean } = {},
) {
  const rowH = 20;
  const xs: number[] = [];
  let x = LEFT;
  for (const col of cols) {
    xs.push(x);
    x += col.width;
  }
  c.page.drawRectangle({
    x: LEFT,
    y: c.y - 6,
    width: RIGHT - LEFT,
    height: rowH,
    color: rgb(0.95, 0.96, 0.98),
  });
  const put = (text: string, i: number, font: PDFFont, size: number, color = INK) => {
    const col = cols[i]!;
    const t = wrap(font, text, size, col.width - 10)[0] ?? '';
    const tx =
      col.align === 'right' ? xs[i]! + col.width - 6 - font.widthOfTextAtSize(t, size) : xs[i]! + 6;
    c.page.drawText(t, { x: tx, y: c.y, size, font, color });
  };
  cols.forEach((col, i) => put(col.label, i, c.bold, 8.5, MUTED));
  c.y -= rowH;
  rows.forEach((r, ri) => {
    const last = opts.boldLast && ri === rows.length - 1;
    if (last) {
      c.page.drawLine({
        start: { x: LEFT, y: c.y + 14 },
        end: { x: RIGHT, y: c.y + 14 },
        thickness: 0.8,
        color: INK,
      });
    }
    r.forEach((cell, i) => put(cell, i, last ? c.bold : c.regular, 10));
    c.y -= rowH;
    if (!last)
      c.page.drawLine({
        start: { x: LEFT, y: c.y + 14 },
        end: { x: RIGHT, y: c.y + 14 },
        thickness: 0.4,
        color: LINE,
      });
  });
  c.y -= 10;
}

function footer(c: Ctx, b: PdfBranding, note: string) {
  c.page.drawText(safe(c.regular, note), {
    x: LEFT,
    y: 54,
    size: 8,
    font: c.regular,
    color: MUTED,
  });
  if (b.footer_text)
    wrap(c.regular, b.footer_text, 8, RIGHT - LEFT)
      .slice(0, 2)
      .forEach((l, i) => drawCentered(c.page, c.regular, l, 36 - i * 10, 8, MUTED));
}

const fmt = (n: number | null) =>
  n === null ? '-' : Number.isInteger(n) ? String(n) : n.toFixed(2);

export interface ReportCardInput {
  branding: PdfBranding;
  exam_name: string;
  academic_year: string | null;
  published_on: string | null;
  student_name: string;
  admission_number: string;
  class_label: string;
  roll_number: string | null;
  subjects: {
    subject_name: string;
    marks: number | null;
    absent: boolean;
    max_marks: number;
    grade: string | null;
    passed: boolean | null;
  }[];
  total: number;
  max_total: number;
  percentage: number;
  grade: string | null;
  result: string;
  rank: number | null;
  class_size: number;
  class_average: number | null;
  remark: { text: string; by: string | null } | null;
  generated_on: string;
}

/** A4 report card: student, subject marks with grades, totals, rank and the teacher's remark. */
export async function renderReportCard(o: ReportCardInput): Promise<Buffer> {
  const c = await start(o.branding, 'REPORT CARD');
  drawCentered(
    c.page,
    c.regular,
    `${o.exam_name}${o.academic_year ? ` · ${o.academic_year}` : ''}`,
    c.y + 12,
    10.5,
    MUTED,
  );
  c.y -= 14;
  facts(c, [
    ['Student', o.student_name],
    ['Admission no.', o.admission_number],
    ['Class', o.class_label],
    ['Roll no.', o.roll_number ?? '-'],
  ]);
  table(
    c,
    [
      { label: 'Subject', width: 200 },
      { label: 'Marks', width: 80, align: 'right' },
      { label: 'Out of', width: 70, align: 'right' },
      { label: 'Grade', width: 60, align: 'right' },
      { label: 'Result', width: 89, align: 'right' },
    ],
    [
      ...o.subjects.map((s) => [
        s.subject_name,
        s.absent ? 'Absent' : fmt(s.marks),
        fmt(s.max_marks),
        s.grade ?? '-',
        s.passed === null ? '-' : s.passed ? 'Pass' : 'Fail',
      ]),
      [
        'Total',
        fmt(o.total),
        fmt(o.max_total),
        o.grade ?? '-',
        o.result === 'PASS' ? 'Pass' : o.result === 'FAIL' ? 'Fail' : '-',
      ],
    ],
    { boldLast: true },
  );
  facts(c, [
    ['Percentage', `${o.percentage.toFixed(1)}%`],
    ['Class rank', o.rank ? `${o.rank} of ${o.class_size}` : '-'],
    ['Class average', o.class_average === null ? '-' : `${o.class_average.toFixed(1)}%`],
    ['Published', o.published_on ?? '-'],
  ]);
  if (o.remark) {
    c.page.drawText("Class teacher's remark", {
      x: LEFT,
      y: c.y,
      size: 10,
      font: c.bold,
      color: c.brand,
    });
    c.y -= 16;
    for (const l of wrap(c.regular, o.remark.text, 10, RIGHT - LEFT).slice(0, 8)) {
      c.page.drawText(l, { x: LEFT, y: c.y, size: 10, font: c.regular, color: INK });
      c.y -= 14;
    }
    if (o.remark.by)
      c.page.drawText(safe(c.regular, `- ${o.remark.by}`), {
        x: LEFT,
        y: c.y,
        size: 9,
        font: c.regular,
        color: MUTED,
      });
  }
  footer(c, o.branding, `Generated on ${o.generated_on}. Marks are as published by the school.`);
  return Buffer.from(await c.pdf.save());
}

export interface FeeInvoiceInput {
  branding: PdfBranding;
  demand_number: string;
  label: string;
  description: string;
  academic_year: string | null;
  issued_on: string | null;
  due_date: string;
  status: string;
  currency: string;
  student_name: string;
  admission_number: string;
  class_label: string | null;
  original_amount: string;
  discount_amount: string;
  concession_amount: string;
  waiver_amount: string;
  late_fee_amount: string;
  final_amount: string;
  paid_amount: string;
  written_off_amount: string;
  outstanding_amount: string;
  payments: { date: string; receipt_number: string | null; method: string; amount: string }[];
  generated_on: string;
}

const STATUS: Record<string, string> = {
  ISSUED: 'Due',
  PARTIALLY_PAID: 'Part paid',
  PAID: 'Paid',
  OVERDUE: 'Overdue',
  WAIVED: 'Waived',
  WRITTEN_OFF: 'Written off',
  UPCOMING: 'Upcoming',
  DUE: 'Due',
};

/** A4 fee invoice for one instalment / charge: what is billed, what was paid, what is left. */
export async function renderFeeInvoice(o: FeeInvoiceInput): Promise<Buffer> {
  const c = await start(o.branding, 'FEE INVOICE');
  facts(c, [
    ['Invoice no.', o.demand_number],
    ['Status', STATUS[o.status] ?? o.status],
    ['Student', o.student_name],
    ['Admission no.', o.admission_number],
    ['Class', o.class_label ?? '-'],
    ['Academic year', o.academic_year ?? '-'],
    ['Issued on', o.issued_on ?? '-'],
    ['Due date', o.due_date],
  ]);
  const money = (v: string) => `${o.currency} ${v}`;
  const nonZero = (v: string) => Number(v) !== 0;
  const lines: string[][] = [[`${o.label} · ${o.description}`, money(o.original_amount)]];
  if (nonZero(o.discount_amount)) lines.push(['Less: discount', `- ${money(o.discount_amount)}`]);
  if (nonZero(o.concession_amount))
    lines.push(['Less: concession', `- ${money(o.concession_amount)}`]);
  if (nonZero(o.waiver_amount)) lines.push(['Less: waiver', `- ${money(o.waiver_amount)}`]);
  if (nonZero(o.late_fee_amount)) lines.push(['Add: late fee', money(o.late_fee_amount)]);
  lines.push(['Amount payable', money(o.final_amount)]);
  table(
    c,
    [
      { label: 'Description', width: 359 },
      { label: 'Amount', width: 140, align: 'right' },
    ],
    lines,
    { boldLast: true },
  );
  if (o.payments.length) {
    c.page.drawText('Payments received', {
      x: LEFT,
      y: c.y,
      size: 10,
      font: c.bold,
      color: c.brand,
    });
    c.y -= 18;
    table(
      c,
      [
        { label: 'Date', width: 110 },
        { label: 'Receipt no.', width: 150 },
        { label: 'Method', width: 109 },
        { label: 'Amount', width: 130, align: 'right' },
      ],
      o.payments
        .slice(0, 12)
        .map((p) => [p.date, p.receipt_number ?? '-', p.method, money(p.amount)]),
    );
  }
  const summary: string[][] = [['Paid', money(o.paid_amount)]];
  if (nonZero(o.written_off_amount)) summary.push(['Written off', money(o.written_off_amount)]);
  summary.push(['Balance due', money(o.outstanding_amount)]);
  table(
    c,
    [
      { label: 'Summary', width: 359 },
      { label: '', width: 140, align: 'right' },
    ],
    summary,
    { boldLast: true },
  );
  footer(
    c,
    o.branding,
    `Generated on ${o.generated_on}. Pay at the school office or by bank transfer, quoting ${o.demand_number}.`,
  );
  return Buffer.from(await c.pdf.save());
}
