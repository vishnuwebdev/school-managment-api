import {
  PDFDocument,
  rgb,
  StandardFonts,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';

export interface PdfBranding {
  school_name: string;
  address: string;
  contact: string;
  footer_text: string | null;
  primary_color: string | null;
  logo: { bytes: Buffer; mime: string } | null;
}

/** Every `{{name}}` a template may use. Anything else is rejected when the wording is saved. */
export const PLACEHOLDERS = [
  'school_name',
  'school_address',
  'school_phone',
  'school_email',
  'student_name',
  'student_number',
  'admission_number',
  'date_of_birth',
  'gender',
  'parent_name',
  'father_name',
  'mother_name',
  'class',
  'section',
  'academic_year',
  'admission_date',
  'exit_date',
  'exit_reason',
  'destination_school',
  'issue_date',
  'serial_number',
] as const;

const TOKEN = /\{\{\s*([a-z_]+)\s*\}\}/g;

export function unknownPlaceholders(body: string): string[] {
  const known = new Set<string>(PLACEHOLDERS);
  const bad = new Set<string>();
  for (const m of body.matchAll(TOKEN)) if (!known.has(m[1]!)) bad.add(m[1]!);
  return [...bad];
}

export function fillTemplate(body: string, values: Record<string, string>): string {
  return body.replace(TOKEN, (_, k: string) => values[k] ?? '');
}

export function colorOf(hex: string | null) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return rgb(0.1, 0.25, 0.55);
  const n = parseInt(m[1]!, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Standard PDF fonts only cover Latin text; characters outside that set become "?". */
export function safe(font: PDFFont, text: string): string {
  const ok = new Set(font.getCharacterSet());
  return [...text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')]
    .map((ch) => (ch === '\n' || ok.has(ch.codePointAt(0)!) ? ch : '?'))
    .join('');
}

export function wrap(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of safe(font, text).split('\n')) {
    if (!para.trim()) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= maxWidth || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

export async function embed(pdf: PDFDocument, img: { bytes: Buffer; mime: string } | null) {
  if (!img) return null;
  try {
    if (img.mime === 'image/png') return await pdf.embedPng(img.bytes);
    if (img.mime === 'image/jpeg') return await pdf.embedJpg(img.bytes);
  } catch {
    /* an unreadable logo must never block a certificate */
  }
  return null; // WebP and SVG cannot be embedded
}

export function drawCentered(
  page: PDFPage,
  font: PDFFont,
  text: string,
  y: number,
  size: number,
  color = rgb(0, 0, 0),
) {
  const t = safe(font, text);
  const w = font.widthOfTextAtSize(t, size);
  page.drawText(t, { x: (page.getWidth() - w) / 2, y, size, font, color });
}

export async function renderCertificate(o: {
  title: string;
  text: string;
  branding: PdfBranding;
  serial: string;
  issueDate: string;
  duplicate: boolean;
}): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const regular = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const brand = colorOf(o.branding.primary_color);
  const { width, height } = page.getSize();

  page.drawRectangle({
    x: 28,
    y: 28,
    width: width - 56,
    height: height - 56,
    borderColor: brand,
    borderWidth: 2,
  });
  page.drawRectangle({
    x: 34,
    y: 34,
    width: width - 68,
    height: height - 68,
    borderColor: brand,
    borderWidth: 0.5,
  });

  let top = height - 70;
  const logo: PDFImage | null = await embed(pdf, o.branding.logo);
  if (logo) {
    const s = Math.min(70 / logo.width, 70 / logo.height);
    page.drawImage(logo, {
      x: 60,
      y: top - logo.height * s + 10,
      width: logo.width * s,
      height: logo.height * s,
    });
  }
  drawCentered(page, bold, o.branding.school_name, top, 22, brand);
  top -= 18;
  for (const line of wrap(sans, o.branding.address, 9, 380)) {
    drawCentered(page, sans, line, top, 9, rgb(0.3, 0.3, 0.3));
    top -= 12;
  }
  if (o.branding.contact) {
    drawCentered(page, sans, o.branding.contact, top, 9, rgb(0.3, 0.3, 0.3));
    top -= 12;
  }
  page.drawLine({
    start: { x: 60, y: top - 10 },
    end: { x: width - 60, y: top - 10 },
    thickness: 1,
    color: brand,
  });

  let y = top - 60;
  drawCentered(page, bold, o.title.toUpperCase(), y, 18);
  const tw = bold.widthOfTextAtSize(safe(bold, o.title.toUpperCase()), 18);
  page.drawLine({
    start: { x: (width - tw) / 2, y: y - 4 },
    end: { x: (width + tw) / 2, y: y - 4 },
    thickness: 1,
  });
  if (o.duplicate) {
    y -= 22;
    drawCentered(page, sans, 'DUPLICATE COPY', y, 10, rgb(0.75, 0.1, 0.1));
  }

  y -= 40;
  page.drawText(safe(sans, `Serial no.: ${o.serial}`), { x: 70, y, size: 10, font: sans });
  const dateText = safe(sans, `Date: ${o.issueDate}`);
  page.drawText(dateText, {
    x: width - 70 - sans.widthOfTextAtSize(dateText, 10),
    y,
    size: 10,
    font: sans,
  });

  y -= 40;
  for (const line of wrap(regular, o.text, 13, width - 140)) {
    if (y < 150) break; // the page is full; the wording is meant to be short
    if (line) page.drawText(line, { x: 70, y, size: 13, font: regular });
    y -= 22;
  }

  const sigY = 110;
  page.drawLine({ start: { x: 70, y: sigY }, end: { x: 210, y: sigY }, thickness: 0.7 });
  page.drawText('Class teacher', { x: 70, y: sigY - 14, size: 10, font: sans });
  page.drawLine({
    start: { x: width - 210, y: sigY },
    end: { x: width - 70, y: sigY },
    thickness: 0.7,
  });
  page.drawText('Principal', { x: width - 210, y: sigY - 14, size: 10, font: sans });
  if (o.branding.footer_text) {
    const lines = wrap(sans, o.branding.footer_text, 8, width - 140).slice(0, 2);
    lines.forEach((l, i) => drawCentered(page, sans, l, 56 - i * 10, 8, rgb(0.4, 0.4, 0.4)));
  }
  return Buffer.from(await pdf.save());
}

/** Credit-card size (85.6 × 54 mm), landscape. Page 1 is the front, page 2 the back. */
export async function renderIdCard(o: {
  branding: PdfBranding;
  name: string;
  lines: [string, string][];
  photo: { bytes: Buffer; mime: string } | null;
  back: string;
  serial: string;
  validUntil: string | null;
}): Promise<Buffer> {
  const W = 243;
  const H = 153;
  const pdf = await PDFDocument.create();
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const brand = colorOf(o.branding.primary_color);

  const front = pdf.addPage([W, H]);
  front.drawRectangle({ x: 0, y: H - 34, width: W, height: 34, color: brand });
  const logo = await embed(pdf, o.branding.logo);
  let textX = 8;
  if (logo) {
    const s = Math.min(24 / logo.width, 24 / logo.height);
    front.drawRectangle({ x: 6, y: H - 31, width: 28, height: 28, color: rgb(1, 1, 1) });
    front.drawImage(logo, { x: 8, y: H - 29, width: logo.width * s, height: logo.height * s });
    textX = 40;
  }
  const school = wrap(bold, o.branding.school_name, 9, W - textX - 6).slice(0, 2);
  school.forEach((l, i) =>
    front.drawText(l, { x: textX, y: H - 15 - i * 11, size: 9, font: bold, color: rgb(1, 1, 1) }),
  );

  const photo = await embed(pdf, o.photo);
  front.drawRectangle({
    x: 8,
    y: 40,
    width: 58,
    height: 72,
    borderColor: rgb(0.7, 0.7, 0.7),
    borderWidth: 0.7,
  });
  if (photo) {
    const s = Math.min(58 / photo.width, 72 / photo.height);
    const w = photo.width * s;
    const h = photo.height * s;
    front.drawImage(photo, { x: 8 + (58 - w) / 2, y: 40 + (72 - h) / 2, width: w, height: h });
  } else {
    front.drawText('PHOTO', { x: 22, y: 72, size: 8, font: sans, color: rgb(0.6, 0.6, 0.6) });
  }
  let y = H - 50;
  wrap(bold, o.name, 10, W - 78)
    .slice(0, 2)
    .forEach((l) => {
      front.drawText(l, { x: 74, y, size: 10, font: bold });
      y -= 12;
    });
  y -= 2;
  for (const [k, v] of o.lines) {
    if (!v) continue;
    front.drawText(safe(sans, `${k}: ${v}`).slice(0, 34), { x: 74, y, size: 7.5, font: sans });
    y -= 10.5;
  }
  front.drawText(safe(sans, `ID ${o.serial}`), {
    x: 8,
    y: 10,
    size: 6.5,
    font: sans,
    color: rgb(0.4, 0.4, 0.4),
  });
  if (o.validUntil)
    front.drawText(safe(sans, `Valid until ${o.validUntil}`), {
      x: W - 90,
      y: 10,
      size: 6.5,
      font: sans,
      color: rgb(0.4, 0.4, 0.4),
    });
  front.drawRectangle({ x: 0, y: 0, width: W, height: 4, color: brand });

  const back = pdf.addPage([W, H]);
  back.drawRectangle({ x: 0, y: H - 14, width: W, height: 14, color: brand });
  let by = H - 32;
  for (const l of wrap(sans, o.back, 7.5, W - 20)) {
    if (by < 38) break;
    back.drawText(l, { x: 10, y: by, size: 7.5, font: sans });
    by -= 10;
  }
  const addr = wrap(sans, `${o.branding.school_name}, ${o.branding.address}`, 6.5, W - 20).slice(
    0,
    3,
  );
  addr.forEach((l, i) =>
    back.drawText(l, { x: 10, y: 28 - i * 8, size: 6.5, font: sans, color: rgb(0.35, 0.35, 0.35) }),
  );
  if (o.branding.contact)
    back.drawText(safe(sans, o.branding.contact), {
      x: 10,
      y: 4,
      size: 6.5,
      font: sans,
      color: rgb(0.35, 0.35, 0.35),
    });
  return Buffer.from(await pdf.save());
}
