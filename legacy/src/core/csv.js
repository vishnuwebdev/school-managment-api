// Minimal, dependency-free CSV parser/writer. Student import/export
// (designs/Student managment system.png panels 9-12) originally showed
// .xlsx support too, but the only Node xlsx library available from the
// npm registry (SheetJS `xlsx`) has an unpatched high-severity prototype
// pollution / ReDoS advisory with "no fix available", and the newer,
// patched SheetJS release isn't published to npm (only to their own CDN,
// which this environment's egress policy blocks) -- not something to
// install just to parse untrusted uploaded files. CSV needs no library,
// covers the same "bulk edit in Excel, re-upload" workflow (Excel opens
// and saves .csv natively), and is what's implemented here.

// Handles quoted fields, escaped quotes (""), and \r\n line endings.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();

  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((cell) => cell.trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

function csvCell(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(','));
  return lines.join('\r\n');
}
