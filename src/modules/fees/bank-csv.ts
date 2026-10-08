import { ValidationError } from '../../shared/errors.js';

export interface BankRow {
  date: string; // YYYY-MM-DD
  description: string;
  reference: string | null;
  amount: string; // positive, 2 decimals (money in)
}

export interface BankParse {
  rows: BankRow[];
  rejected: { row: number; reason: string }[];
  skippedDebits: number;
}

const MAX_ROWS = 5000;

/** RFC 4180 reader: quoted cells, doubled quotes, and either `,` or `;` as the separator. */
export function readCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) out.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) out.push(row);
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** 2026-09-17, 17/09/2026, 17-09-2026, 2026/09/17, 17 Sep 2026, 20260917. Day first, as in South Africa. */
export function parseBankDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) [y, m, d] = [+r[1]!, +r[2]!, +r[3]!];
  else if ((r = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) [y, m, d] = [+r[1]!, +r[2]!, +r[3]!];
  else if ((r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s)))
    [d, m, y] = [+r[1]!, +r[2]!, +r[3]!];
  else if ((r = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -,]*(\d{4})/.exec(s))) {
    d = +r[1]!;
    m = MONTHS.indexOf(r[2]!.toLowerCase()) + 1;
    y = +r[3]!;
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)
    return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "R 1 234,50", "1,234.50", "-300.00", "(300.00)" → signed minor units, or null. */
export function parseBankAmount(raw: string): bigint | null {
  let s = raw.replace(/[\s\u00A0]/g, '').replace(/^R(?=[-\d(])/i, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  }
  if (/CR$/i.test(s)) s = s.slice(0, -2);
  else if (/DR$/i.test(s)) {
    neg = !neg;
    s = s.slice(0, -2);
  }
  if (/,\d{1,2}$/.test(s) && !/\.\d/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  const minor = BigInt(w!) * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -minor : minor;
}

const fmt = (m: bigint) => `${m / 100n}.${String(m % 100n).padStart(2, '0')}`;

const find = (headers: string[], ...tests: RegExp[]) => {
  for (const t of tests) {
    const i = headers.findIndex((h) => t.test(h));
    if (i >= 0) return i;
  }
  return -1;
};

/** Reads a bank statement export. Only money in is kept; debits are counted and skipped. */
export function parseBankStatement(text: string): BankParse {
  const grid = readCsv(text);
  if (grid.length < 2)
    throw new ValidationError('The statement has no lines', {
      location: 'body',
      issues: [
        {
          path: 'file',
          code: 'custom',
          message: 'The file needs a header row and at least one line.',
        },
      ],
    });
  const headers = grid[0]!.map((h) => h.trim().toLowerCase());
  const iDate = find(headers, /^date$/, /date|posted/);
  const iDesc = find(headers, /^description$/, /desc|detail|narrat|particulars|memo/);
  const iRef = find(headers, /^reference$/, /ref/);
  const iCredit = find(headers, /^credit/, /money in|deposit/);
  const iDebit = find(headers, /^debit/, /money out|withdraw/);
  const iAmount = find(headers, /^amount$/, /amount/);
  if (iDate < 0 || (iAmount < 0 && iCredit < 0))
    throw new ValidationError('The statement columns were not recognised', {
      location: 'body',
      issues: [
        {
          path: 'file',
          code: 'custom',
          message: `Need a Date column and an Amount (or Credit) column. Found: ${headers.join(', ')}`,
        },
      ],
    });
  const out: BankParse = { rows: [], rejected: [], skippedDebits: 0 };
  for (let n = 1; n < grid.length; n++) {
    if (out.rows.length >= MAX_ROWS)
      throw new ValidationError('The statement is too long', {
        location: 'body',
        issues: [
          { path: 'file', code: 'custom', message: `At most ${MAX_ROWS} lines per import.` },
        ],
      });
    const r = grid[n]!;
    const date = parseBankDate(r[iDate] ?? '');
    if (!date) {
      out.rejected.push({ row: n + 1, reason: 'Date not recognised' });
      continue;
    }
    let minor: bigint | null;
    if (iCredit >= 0) {
      const credit = (r[iCredit] ?? '').trim() ? parseBankAmount(r[iCredit]!) : 0n;
      const debit = iDebit >= 0 && (r[iDebit] ?? '').trim() ? parseBankAmount(r[iDebit]!) : 0n;
      if (credit === null || debit === null) minor = null;
      else
        minor = credit > 0n ? credit : debit && debit !== 0n ? -(debit < 0n ? -debit : debit) : 0n;
    } else minor = parseBankAmount(r[iAmount] ?? '');
    if (minor === null) {
      out.rejected.push({ row: n + 1, reason: 'Amount not recognised' });
      continue;
    }
    if (minor <= 0n) {
      out.skippedDebits++;
      continue;
    }
    out.rows.push({
      date,
      description: (iDesc >= 0 ? (r[iDesc] ?? '') : '').trim().slice(0, 300),
      reference: ((iRef >= 0 ? (r[iRef] ?? '') : '').trim() || null)?.slice(0, 150) ?? null,
      amount: fmt(minor),
    });
  }
  return out;
}
