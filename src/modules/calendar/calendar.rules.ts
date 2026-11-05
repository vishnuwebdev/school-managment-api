/**
 * Pure school-calendar rules: which days are off for staff or for a class.
 * No database access, so it is cheap to unit-test. CalendarService loads the
 * settings and holidays and calls these.
 */

export type CalendarSettings = {
  /** ISO weekdays always off: 1 = Monday … 7 = Sunday. */
  weeklyOffDays: number[];
  /** Saturdays of the month that are off, e.g. [2, 4]. */
  offSaturdays: number[];
};

export const DEFAULT_CALENDAR: CalendarSettings = { weeklyOffDays: [7], offSaturdays: [] };

export type HolidayLike = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  /** STAFF = only staff are off; SECTIONS = only the chosen sections are off. */
  audience: 'ALL' | 'STAFF' | 'STUDENTS' | 'CLASSES' | 'SECTIONS';
  classIds: string[] | null;
  sectionIds?: string[] | null;
};

/**
 * Who the day is being checked for. `students` = the day is off for every
 * student; `class` = one class, optionally one section of it.
 */
export type CalendarSubject =
  | { kind: 'staff' }
  | { kind: 'class'; classId: string; sectionId?: string }
  | { kind: 'students' };

export type DayOff = {
  date: string;
  reason: 'WEEKLY_OFF' | 'HOLIDAY';
  /** "Sunday", "2nd Saturday" or the holiday name. */
  name: string;
  holiday_id?: string;
};

const WEEKDAY = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th'];

const DAY_MS = 86_400_000;
const toMs = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** ISO weekday (1 = Monday … 7 = Sunday) of an ISO date. */
export function isoWeekday(iso: string): number {
  const d = new Date(toMs(iso)).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The weekly-off reason for a date, if any (staff and students alike). */
export function weeklyOff(settings: CalendarSettings, iso: string): string | null {
  const wd = isoWeekday(iso);
  if (settings.weeklyOffDays.includes(wd)) return WEEKDAY[wd]!;
  if (wd === 6) {
    const nth = Math.ceil(+iso.slice(8, 10) / 7);
    if (settings.offSaturdays.includes(nth)) return `${ORDINAL[nth]} Saturday`;
  }
  return null;
}

/**
 * Whether closing entry [h] makes the day off for [who]. Staff are off for
 * whole-school and staff-only closures; students for whole-school and
 * students closures, plus class / section closures that include them.
 */
export function holidayApplies(h: HolidayLike, who: CalendarSubject): boolean {
  if (h.audience === 'ALL') return true;
  if (who.kind === 'staff') return h.audience === 'STAFF';
  if (h.audience === 'STAFF') return false;
  if (h.audience === 'STUDENTS') return true;
  // CLASSES / SECTIONS: off only for those, not for the school's students as a whole.
  if (who.kind === 'students') return false;
  if (h.audience === 'CLASSES') return (h.classIds ?? []).includes(who.classId);
  return who.sectionId !== undefined && (h.sectionIds ?? []).includes(who.sectionId);
}

/** The reason [iso] is off for [who], or null when it is a working / school day. */
export function dayOff(
  settings: CalendarSettings,
  holidays: HolidayLike[],
  iso: string,
  who: CalendarSubject,
): DayOff | null {
  const h = holidays.find((x) => x.startDate <= iso && x.endDate >= iso && holidayApplies(x, who));
  if (h) return { date: iso, reason: 'HOLIDAY', name: h.name, holiday_id: h.id };
  const w = weeklyOff(settings, iso);
  return w ? { date: iso, reason: 'WEEKLY_OFF', name: w } : null;
}

/** Working days between two ISO dates (both included) and the days that were left out. */
export function countDays(
  settings: CalendarSettings,
  holidays: HolidayLike[],
  from: string,
  to: string,
  who: CalendarSubject,
): { working_days: number; total_days: number; off_days: DayOff[] } {
  const off: DayOff[] = [];
  let working = 0;
  let total = 0;
  for (let t = toMs(from); t <= toMs(to); t += DAY_MS) {
    total++;
    const d = dayOff(settings, holidays, toIso(t), who);
    if (d) off.push(d);
    else working++;
  }
  return { working_days: working, total_days: total, off_days: off };
}
