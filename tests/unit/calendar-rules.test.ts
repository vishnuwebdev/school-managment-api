import { describe, expect, it } from 'vitest';
import { countDays, dayOff, DEFAULT_CALENDAR, type HolidayLike } from '../../src/modules/calendar/calendar.rules.js';

const diwali: HolidayLike = { id: 'h1', name: 'Diwali', startDate: '2026-11-09', endDate: '2026-11-10', audience: 'ALL', classIds: null };
const training: HolidayLike = { id: 'h2', name: 'Teacher training', startDate: '2026-11-12', endDate: '2026-11-12', audience: 'STUDENTS', classIds: null };
const c7Trip: HolidayLike = { id: 'h3', name: 'Class 7 trip', startDate: '2026-11-13', endDate: '2026-11-13', audience: 'CLASSES', classIds: ['c7'] };
const hs = [diwali, training, c7Trip];

describe('calendar rules', () => {
  it('Sunday is off by default', () =>
    expect(dayOff(DEFAULT_CALENDAR, [], '2026-10-11', { kind: 'staff' })?.name).toBe('Sunday'));
  it('2nd and 4th Saturdays when configured', () => {
    const s = { weeklyOffDays: [7], offSaturdays: [2, 4] };
    expect(dayOff(s, [], '2026-10-10', { kind: 'staff' })?.name).toBe('2nd Saturday');
    expect(dayOff(s, [], '2026-10-03', { kind: 'staff' })).toBeNull();
    expect(dayOff(s, [], '2026-10-24', { kind: 'staff' })?.name).toBe('4th Saturday');
  });
  it('whole-school holiday is off for staff and classes', () => {
    expect(dayOff(DEFAULT_CALENDAR, hs, '2026-11-10', { kind: 'staff' })?.name).toBe('Diwali');
    expect(dayOff(DEFAULT_CALENDAR, hs, '2026-11-10', { kind: 'class', classId: 'c1' })?.name).toBe('Diwali');
  });
  it('students-only holiday is a working day for staff', () => {
    expect(dayOff(DEFAULT_CALENDAR, hs, '2026-11-12', { kind: 'staff' })).toBeNull();
    expect(dayOff(DEFAULT_CALENDAR, hs, '2026-11-12', { kind: 'class', classId: 'c1' })?.name).toBe('Teacher training');
  });
  it('class holiday only for the chosen classes', () => {
    expect(dayOff(DEFAULT_CALENDAR, hs, '2026-11-13', { kind: 'class', classId: 'c7' })?.name).toBe('Class 7 trip');
    expect(dayOff(DEFAULT_CALENDAR, hs, '2026-11-13', { kind: 'class', classId: 'c8' })).toBeNull();
    expect(dayOff(DEFAULT_CALENDAR, hs, '2026-11-13', { kind: 'staff' })).toBeNull();
    // Not a day off for the school's students as a whole.
    expect(dayOff(DEFAULT_CALENDAR, hs, '2026-11-13', { kind: 'students' })).toBeNull();
    expect(dayOff(DEFAULT_CALENDAR, hs, '2026-11-12', { kind: 'students' })?.name).toBe('Teacher training');
  });
  it('staff leave Mon 9 Nov – Mon 16 Nov skips Diwali (2) and Sunday', () => {
    const r = countDays(DEFAULT_CALENDAR, hs, '2026-11-09', '2026-11-16', { kind: 'staff' });
    expect(r.total_days).toBe(8);
    expect(r.working_days).toBe(5);
    expect(r.off_days.map((d) => d.name)).toEqual(['Diwali', 'Diwali', 'Sunday']);
  });
});
