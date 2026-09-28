// Shared tabular PDF generator for the Reports module
// (edusphere-reports-module-plan-2026-09-22.md). Every report across
// Students/Staff/Attendance/Fees already produces a CSV via toCsv()
// (core/csv.js) -- this is the one new, generic piece of report
// infrastructure the plan called for, so a report's PDF isn't
// reinvented per module. Modelled directly on
// modules/exams/service.js's generateDatesheetPdf (the one PDF-table
// generator already proven in this codebase), generalised to take
// arbitrary columns/rows instead of a fixed datesheet shape, and with
// real page-break handling added (generateDatesheetPdf never needed it
// -- a datesheet is short enough to fit one page in practice; a
// school-wide report is not).
//
// "Export Excel" per the spec (requirement/rquiremnt phase 1.md, §31)
// is intentionally CSV under the hood everywhere in this codebase, not
// a real .xlsx binary -- see core/csv.js's own header comment: the only
// npm-available xlsx library has an unpatched high-severity advisory
// with no fix, and the patched SheetJS release isn't on the npm
// registry this environment's egress policy can reach. CSV opens
// natively in Excel and is what every existing report (Students, Staff)
// already ships, so this file only adds the PDF half of
// Filter -> View -> Export Excel -> Export PDF -> Print, not a second
// Excel implementation.
import PDFDocument from 'pdfkit';

const PAGE_MARGIN = 30;

/**
 * @param {object} opts
 * @param {object} [opts.tenant] - the school record (for the header line), may be null.
 * @param {string} opts.title - report title, e.g. "Fee Collection Report".
 * @param {string} [opts.subtitle] - e.g. a date range or filter description.
 * @param {{label: string, key: string, width?: number}[]} opts.columns
 * @param {object[]} opts.rows - plain objects keyed by each column's `key`.
 * @param {'portrait'|'landscape'} [opts.orientation]
 * @param {string} [opts.generatedAt] - ISO/plain date string, defaults to now.
 * @returns {Promise<Buffer>}
 */
export async function generateTabularReportPdf({ tenant, title, subtitle, columns, rows, orientation = 'landscape', generatedAt }) {
  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, layout: orientation });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const pageWidth = doc.page.width - PAGE_MARGIN * 2;
  const pageBottom = doc.page.height - PAGE_MARGIN;

  // Even column widths unless the caller specified its own -- good enough
  // for every report shape in this module (no column here needs the kind
  // of hand-tuned width generateDatesheetPdf uses for its 9 fixed columns).
  const specifiedWidth = columns.reduce((a, c) => a + (c.width || 0), 0);
  const remaining = columns.filter((c) => !c.width).length;
  const autoWidth = remaining > 0 ? Math.max(40, (pageWidth - specifiedWidth) / remaining) : 0;
  const cols = [];
  let x = PAGE_MARGIN;
  for (const c of columns) {
    const width = c.width || autoWidth;
    cols.push({ ...c, x, width });
    x += width;
  }

  const drawHeader = () => {
    doc.fontSize(15).fillColor('#1E2D42').text(tenant?.name || 'School', PAGE_MARGIN, PAGE_MARGIN);
    doc.fontSize(10).fillColor('#6366F1').text(title.toUpperCase(), PAGE_MARGIN, doc.y + 2);
    if (subtitle) doc.fontSize(9).fillColor('#64748B').text(subtitle, PAGE_MARGIN, doc.y + 2);
    doc.fontSize(8).fillColor('#94A3B8').text(`Generated ${generatedAt || new Date().toISOString().slice(0, 10)}`, PAGE_MARGIN, PAGE_MARGIN, {
      width: pageWidth,
      align: 'right',
    });
    doc.moveDown(1.2);
    drawColumnHeadings();
  };

  const drawColumnHeadings = () => {
    const y = doc.y;
    doc.fontSize(8).fillColor('#64748B');
    for (const c of cols) doc.text(c.label, c.x, y, { width: c.width });
    doc.moveDown(0.4);
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_MARGIN + pageWidth, doc.y).strokeColor('#E4EBF5').stroke();
    doc.moveDown(0.3);
  };

  drawHeader();

  if (rows.length === 0) {
    doc.fontSize(9).fillColor('#94A3B8').text('No rows match this report.', PAGE_MARGIN, doc.y);
  }

  for (const row of rows) {
    if (doc.y > pageBottom - 20) {
      doc.addPage();
      doc.y = PAGE_MARGIN;
      drawColumnHeadings();
    }
    const y = doc.y;
    doc.fontSize(8).fillColor('#13213B');
    for (const c of cols) {
      const value = row[c.key];
      doc.text(value === null || value === undefined || value === '' ? '—' : String(value), c.x, y, { width: c.width });
    }
    doc.moveDown(0.55);
  }

  doc.end();
  return done;
}
