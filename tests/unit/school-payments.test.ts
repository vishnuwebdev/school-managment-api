import { describe, expect, it } from 'vitest';
import {
  allocate,
  istDay,
  paymentRecord,
  sessionOf,
  sessionRange,
} from '../../src/modules/school-payments/school-payments.service.js';

const inst = (seq: number, amountMinor: number, dueDate: string) => ({ seq, amountMinor, dueDate });

describe('sessions (Indian financial year)', () => {
  it('runs 1 April to 31 March', () => {
    expect(sessionOf('2026-11-20')).toBe('2026-27');
    expect(sessionOf('2027-03-31')).toBe('2026-27');
    expect(sessionOf('2027-04-01')).toBe('2027-28');
    expect(sessionOf('2099-12-01')).toBe('2099-00');
    expect(sessionRange('2026-27')).toEqual({ start: '2026-04-01', end: '2027-03-31' });
  });
  it('uses the day in India', () => {
    expect(istDay(new Date('2027-03-31T19:00:00Z'))).toBe('2027-04-01');
  });
});

describe('allocate', () => {
  const schedule = [inst(1, 5000, '2026-04-30'), inst(2, 5000, '2026-10-31')];

  it('fills instalments oldest payment first and marks on time / late', () => {
    const s = allocate(
      schedule,
      [
        { amountMinor: 3000, receivedOn: '2026-04-20' },
        { amountMinor: 4000, receivedOn: '2026-05-10' },
        { amountMinor: 3000, receivedOn: '2026-10-01' },
      ],
      '2026-11-20',
    );
    expect(s[0]).toMatchObject({ paid_minor: 5000, paid_on: '2026-05-10', status: 'PAID_LATE', days_late: 10 });
    expect(s[1]).toMatchObject({ paid_minor: 5000, paid_on: '2026-10-01', status: 'PAID_ON_TIME', days_late: 0 });
  });

  it('shows overdue, due soon and not yet due', () => {
    const s = allocate(
      [inst(1, 100, '2026-11-01'), inst(2, 100, '2026-11-25'), inst(3, 100, '2027-01-31')],
      [{ amountMinor: 40, receivedOn: '2026-11-02' }],
      '2026-11-20',
    );
    expect(s.map((x) => x.status)).toEqual(['OVERDUE', 'DUE_SOON', 'UPCOMING']);
    expect(s[0]).toMatchObject({ paid_minor: 40, days_late: 19, paid_on: null });
  });

  it('counts the payment record', () => {
    const s = allocate(
      schedule,
      [{ amountMinor: 5000, receivedOn: '2026-04-30' }],
      '2026-11-20',
    );
    expect(paymentRecord(s)).toEqual({ on_time: 1, late: 1, counted: 2, rating: 'OFTEN_LATE' });
    expect(paymentRecord(allocate(schedule, [], '2026-04-01')).rating).toBeNull();
    expect(
      paymentRecord(allocate(schedule, [{ amountMinor: 10000, receivedOn: '2026-04-01' }], '2026-11-20')).rating,
    ).toBe('GOOD');
  });
});
