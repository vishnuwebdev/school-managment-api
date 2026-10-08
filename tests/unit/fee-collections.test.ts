import { describe, expect, it } from 'vitest';
import {
  parseBankAmount,
  parseBankDate,
  parseBankStatement,
  readCsv,
} from '../../src/modules/fees/bank-csv.js';
import { nextStep, planProgress } from '../../src/modules/fees/arrears.service.js';

describe('bank statement CSV', () => {
  it('reads quoted cells and both separators', () => {
    expect(readCsv('a,b\n"x, y","say ""hi"""\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
    expect(readCsv('a;b\n1;2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('parses day-first dates and rejects impossible ones', () => {
    expect(parseBankDate('17/09/2026')).toBe('2026-09-17');
    expect(parseBankDate('2026-09-17')).toBe('2026-09-17');
    expect(parseBankDate('17 Sep 2026')).toBe('2026-09-17');
    expect(parseBankDate('20260917')).toBe('2026-09-17');
    expect(parseBankDate('31/02/2026')).toBeNull();
    expect(parseBankDate('hello')).toBeNull();
  });

  it('parses South African and international amounts', () => {
    expect(parseBankAmount('R 1 234,50')).toBe(123450n);
    expect(parseBankAmount('1,234.50')).toBe(123450n);
    expect(parseBankAmount('-300.00')).toBe(-30000n);
    expect(parseBankAmount('(300.00)')).toBe(-30000n);
    expect(parseBankAmount('abc')).toBeNull();
  });

  it('keeps credits, counts debits and reports bad rows', () => {
    const r = parseBankStatement(
      [
        'Date,Description,Reference,Amount',
        '17/09/2026,EFT J SMITH,STU-0001,1500.00',
        '18/09/2026,Rent,,-4000.00',
        'nope,x,,10.00',
      ].join('\n'),
    );
    expect(r.rows).toEqual([
      { date: '2026-09-17', description: 'EFT J SMITH', reference: 'STU-0001', amount: '1500.00' },
    ]);
    expect(r.skippedDebits).toBe(1);
    expect(r.rejected).toEqual([{ row: 4, reason: 'Date not recognised' }]);
  });

  it('reads separate credit and debit columns', () => {
    const r = parseBankStatement(
      'Date,Details,Credit,Debit\n2026-09-01,Fees,200.00,\n2026-09-02,Bank charge,,12.50',
    );
    expect(r.rows.map((x) => x.amount)).toEqual(['200.00']);
    expect(r.skippedDebits).toBe(1);
  });

  it('refuses a file without recognisable columns', () => {
    expect(() => parseBankStatement('foo,bar\n1,2')).toThrow();
  });
});

describe('arrears ladder', () => {
  it('moves through the steps in order', () => {
    expect(nextStep(5, null, false)).toBe('NONE');
    expect(nextStep(14, null, false)).toBe('DUE_FIRST');
    expect(nextStep(30, 'FIRST_REMINDER', false)).toBe('NONE');
    expect(nextStep(45, 'FIRST_REMINDER', false)).toBe('DUE_SECOND');
    expect(nextStep(60, 'SECOND_REMINDER', false)).toBe('LETTER');
    expect(nextStep(90, 'LETTER_OF_DEMAND', false)).toBe('HANDOVER');
    expect(nextStep(200, 'COLLECTIONS_HANDOVER', false)).toBe('NONE');
  });

  it('pauses the ladder while a plan is active', () => {
    expect(nextStep(90, 'SECOND_REMINDER', true)).toBe('PLAN');
  });
});

describe('payment plan progress', () => {
  const inst = (seq: number, dueDate: string, amount: string) =>
    ({ id: String(seq), tenantId: 't', planId: 'p', seq, dueDate, amount }) as never;
  const plan = [inst(1, '2026-10-01', '500.00'), inst(2, '2026-11-01', '500.00')];

  it('marks upcoming, paid and missed instalments from the cumulative amount', () => {
    expect(planProgress(plan, 0n, '2026-09-20').instalments.map((i) => i.status)).toEqual([
      'UPCOMING',
      'UPCOMING',
    ]);
    expect(planProgress(plan, 50000n, '2026-10-05').instalments.map((i) => i.status)).toEqual([
      'PAID',
      'UPCOMING',
    ]);
    const missed = planProgress(plan, 20000n, '2026-10-05');
    expect(missed.instalments.map((i) => i.status)).toEqual(['MISSED', 'UPCOMING']);
    expect(missed.any_missed).toBe(true);
  });

  it('completes when everything is covered and lets a late catch-up count', () => {
    const done = planProgress(plan, 100000n, '2026-12-01');
    expect(done.all_paid).toBe(true);
    expect(done.any_missed).toBe(false);
  });
});
