/**
 * Spreadsheet formula-injection guard + CSV quoting. A cell that starts with
 * `= + - @` (or a tab / carriage return) is prefixed with an apostrophe so
 * Excel and Sheets read it as text.
 */
export const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const csvLine = (cells: unknown[]): string => cells.map(csvCell).join(',');
