import { describe, expect, it } from 'vitest';
import { countDays, DEFAULT_CALENDAR } from '../../src/modules/calendar/calendar.rules.js';

const staff = { kind: 'staff' } as const;
const days = (from: string, to: string) => countDays(DEFAULT_CALENDAR, [], from, to, staff).working_days;

describe('leave days with the default calendar (Sundays off)', () => {
  it('counts a single weekday as one day', () => expect(days('2026-10-06', '2026-10-06')).toBe(1));
  it('counts a single Sunday as zero', () => expect(days('2026-10-11', '2026-10-11')).toBe(0));
  it('skips the Sunday in a Mon–Mon range', () => expect(days('2026-10-05', '2026-10-12')).toBe(7));
  it('counts Mon–Sat as six', () => expect(days('2026-10-05', '2026-10-10')).toBe(6));
});
