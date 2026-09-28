import { db } from '../../db/index.js';
import { getConfig, cycleDayForDate, resolveVersion } from '../timetable/routes.js';
import { teachingSlots } from '../../core/timetableGenerator.js';

export const STATUSES = new Set(['present', 'absent', 'late', 'leave']);

const emptyCounts = () => ({ present: 0, absent: 0, late: 0, leave: 0 });

export const todayStr = () => new Date().toISOString().slice(0, 10);

// Whole-days-in-the-past from `date` to today (0 = today, negative = a
// future date). Used to decide whether an edit is a same-day mark, an
// in-window correction, or one that needs approval (see
// attendance_settings.backdate_window_days).
export function daysBack(date) {
  const today = new Date(`${todayStr()}T00:00:00Z`);
  const target = new Date(`${date}T00:00:00Z`);
  return Math.round((today - target) / 86400000);
}

// Settings row every tenant gets a sensible default for even before they
// ever open the Settings screen (screen 9) -- mirrors the mockup's own
// pre-filled values exactly, since those are presented as the shipped
// defaults, not just mock placeholder numbers.
const DEFAULT_SETTINGS = () => ({
  registerLockTime: '10:00',
  backdateWindowDays: 7,
  atRiskThreshold: 75,
  consecutiveAbsenceTrigger: 3,
  leaveNeedsNote: true,
  periodMarkingPhases: [],
  notifyRules: [
    { key: 'sameDayAbsenceSms', label: 'Same-day absence SMS to guardian', note: 'Sent at 10:15, after the register lock', on: true },
    { key: 'lateArrival', label: 'Late arrival notification', note: 'After the 3rd late arrival this month', on: true },
    { key: 'weeklyDigest', label: 'Weekly attendance digest to guardians', note: 'Every Friday afternoon', on: false },
    { key: 'classTeacherAlert', label: 'Alert class teacher at 3 consecutive absences', note: 'Same trigger as the at-risk threshold above', on: true },
    { key: 'unsubmittedReminder', label: 'Notify admin when a register is unsubmitted', note: 'Reminder at 10:05', on: true },
  ],
});

// Every notifyRules toggle above is saved for real, but none of them send
// anything -- there is no Notices & Communication backend anywhere in this
// codebase yet (reserved permission strings + a placeholder nav entry
// only). This mirrors how Classes & Sections' settings screen marks
// not-yet-migrated consumers rather than pretending the wiring exists.
export async function getAttendanceSettings(tenantId) {
  const row = await db.attendanceSettings.get(tenantId);
  if (!row) return { tenantId, ...DEFAULT_SETTINGS() };
  return { ...DEFAULT_SETTINGS(), ...row };
}

// Present + late count toward the rate; leave and absent don't. This is
// the same formula GET /api/students/:id/attendance has always used
// (present-like / total), just factored out so every new screen computes
// it identically instead of drifting.
export function computePercentage(records) {
  if (!records.length) return null;
  const presentLike = records.filter((r) => ['present', 'late'].includes(r.status)).length;
  return Number((presentLike * 100 / records.length).toFixed(1));
}

// Counts back from the most recent record while status stays 'absent'.
// Only counts actual attendance rows (i.e. days a register was taken),
// not calendar days -- there's no school-holiday calendar wired into
// Attendance yet, so a run across a holiday isn't distinguished from a
// run across ordinary school days. Expects `records` sorted newest-first
// (db.attendance.findByStudent's contract).
export function consecutiveAbsences(records) {
  let streak = 0;
  for (const record of records) {
    if (record.status === 'absent') streak += 1;
    else break;
  }
  return streak;
}

export async function buildRoster(tenantId, date, className, section) {
  const [students, records] = await Promise.all([
    db.students.findByClassSection(tenantId, className, section),
    db.attendance.findMatching(tenantId, date, className, section),
  ]);
  return Promise.all(students.map(async (student, index) => {
    const record = records.find((item) => item.studentId === student.id);
    const history = await db.attendance.findByStudent(tenantId, student.id);
    return {
      student: { id: student.id, admissionNumber: student.admissionNumber, name: `${student.firstName} ${student.lastName}`, rollNumber: index + 1 },
      attendance: record && { status: record.status, remark: record.remark, updatedAt: record.updatedAt },
      percentage: computePercentage(history),
    };
  }));
}

export function countByStatus(records) {
  return records.reduce((counts, record) => {
    const status = record.attendance?.status ?? record.status;
    if (status) counts[status] += 1;
    return counts;
  }, emptyCounts());
}

// Resolves "today's" (or any date's) ordered period list for a class/
// section from the live published timetable version -- the same
// day-resolution pattern GET /api/timetable/relief already uses. Returns
// [] if there's no live version yet, or if nothing is scheduled for that
// class/section on that cycle day; a slot with no entry (no teacher
// appointed) is simply absent from the list rather than an error, since
// that's a real, expected state per the mockup's own "unmarked period"
// example.
export async function resolvePeriodsForDay(tenantId, date, className, section) {
  const config = await getConfig(tenantId);
  const version = await resolveVersion(tenantId, null);
  if (!version) return [];
  const dayIndex = cycleDayForDate(date, config);
  const entries = await db.timetableEntries.listForVersion(tenantId, version.id);
  const order = teachingSlots(config.slots).map((s) => s.id);
  return entries
    .filter((e) => e.day === dayIndex && e.className === className && e.section === section && order.includes(e.slotId))
    .map((e) => ({ slotId: e.slotId, subject: e.subject, staffId: e.staffId }))
    .sort((a, b) => order.indexOf(a.slotId) - order.indexOf(b.slotId));
}
