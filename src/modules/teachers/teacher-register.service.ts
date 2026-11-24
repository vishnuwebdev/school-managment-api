import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import { teacherAttendance, teachers } from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { csvLine } from '../../shared/csv.js';
import { todayIso } from '../../shared/dates.js';
import { BusinessRuleError, NotFoundError } from '../../shared/errors.js';
import { hasTenantWideScope } from '../access/authorization.service.js';
import type { CalendarService } from '../calendar/calendar.service.js';
import type { RegisterQuery, SetDayBody } from './teacher-attendance.schemas.js';
import { fullName } from './support.js';

/**
 * The teacher attendance register: what happened for every teacher on every day
 * of a period, and the totals a salary run needs.
 *
 * A day is, in this order:
 *   NOT_EMPLOYED  before the joining date or after the exit date;
 *   HOLIDAY / OFF a school holiday or weekly off day for staff (paid, never marked);
 *   the mark      PRESENT, LATE, HALF_DAY, ABSENT or LEAVE as recorded;
 *   UPCOMING      a future day with nothing planned;
 *   NOT_MARKED    a past working day nobody marked (a gap to fix, not counted as absent).
 *
 * There is no leave module (removed 20 Oct 2026; it returns with the Staff section),
 * so a LEAVE mark counts as paid leave. Mark ABSENT for unpaid days.
 *
 * Salary-ready totals (only days up to today count):
 *   loss_of_pay_days = absent + unpaid leave + ½ × half days
 *   payable_days     = days employed in the period − loss_of_pay_days
 * (weekly offs, holidays and LEAVE marks are paid). `complete` is false while any
 * working day is still NOT_MARKED.
 */

export type DayState =
  | 'PRESENT'
  | 'LATE'
  | 'HALF_DAY'
  | 'ABSENT'
  | 'LEAVE'
  | 'HOLIDAY'
  | 'OFF'
  | 'NOT_MARKED'
  | 'UPCOMING'
  | 'NOT_EMPLOYED';

export interface DayCell {
  date: string;
  state: DayState;
  note: string | null;
  /** For LEAVE: the leave type (none without a leave module), whether it is paid, and whether approved leave covers it. */
  leave: { type: string | null; paid: boolean; approved: boolean } | null;
  /** HOLIDAY / OFF: the holiday or weekday name. */
  off_name: string | null;
  /** The day has a recorded mark (so it can be cleared). */
  marked: boolean;
}

export interface Summary {
  employed_days: number;
  working_days: number;
  present: number;
  late: number;
  half_day: number;
  absent: number;
  leave_paid: number;
  leave_unpaid: number;
  not_marked: number;
  /** present + late + ½ × half days. */
  attended: number;
  /** attended ÷ (attended + absent + ½ × half days), over marked working days, leave left out. */
  attendance_percent: number | null;
  loss_of_pay_days: number;
  payable_days: number;
  /** Every past working day is marked. */
  complete: boolean;
}

const DAY_MS = 86_400_000;
const toMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const weekday = (iso: string) => WEEKDAY[(new Date(toMs(iso)).getUTCDay() + 6) % 7]!;
const round1 = (n: number) => Math.round(n * 10) / 10;

export const monthRange = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
};

/** Short codes for the CSV day columns. */
const CODE: Record<DayState, string> = {
  PRESENT: 'P',
  LATE: 'L',
  HALF_DAY: 'H',
  ABSENT: 'A',
  LEAVE: 'LV',
  HOLIDAY: 'HOL',
  OFF: 'OFF',
  NOT_MARKED: '?',
  UPCOMING: '',
  NOT_EMPLOYED: '-',
};

type TeacherRow = typeof teachers.$inferSelect;

export function summarise(days: DayCell[], today: string): Summary {
  const s = {
    employed_days: 0,
    working_days: 0,
    present: 0,
    late: 0,
    half_day: 0,
    absent: 0,
    leave_paid: 0,
    leave_unpaid: 0,
    not_marked: 0,
  };
  for (const d of days) {
    if (d.state === 'NOT_EMPLOYED' || d.date > today) continue;
    s.employed_days++;
    if (d.state === 'HOLIDAY' || d.state === 'OFF') continue;
    s.working_days++;
    if (d.state === 'PRESENT') s.present++;
    else if (d.state === 'LATE') s.late++;
    else if (d.state === 'HALF_DAY') s.half_day++;
    else if (d.state === 'ABSENT') s.absent++;
    else if (d.state === 'LEAVE') {
      if (d.leave?.paid) s.leave_paid++;
      else s.leave_unpaid++;
    } else if (d.state === 'NOT_MARKED') s.not_marked++;
  }
  const attended = s.present + s.late + s.half_day / 2;
  const base = s.present + s.late + s.half_day + s.absent;
  const lop = s.absent + s.leave_unpaid + s.half_day / 2;
  return {
    ...s,
    attended: round1(attended),
    attendance_percent: base ? round1((attended / base) * 100) : null,
    loss_of_pay_days: round1(lop),
    payable_days: round1(s.employed_days - lop),
    complete: s.not_marked === 0,
  };
}

function addSummaries(list: Summary[]): Summary {
  const keys = [
    'employed_days',
    'working_days',
    'present',
    'late',
    'half_day',
    'absent',
    'leave_paid',
    'leave_unpaid',
    'not_marked',
  ] as const;
  const s = Object.fromEntries(keys.map((k) => [k, list.reduce((a, x) => a + x[k], 0)])) as Record<
    (typeof keys)[number],
    number
  >;
  const attended = s.present + s.late + s.half_day / 2;
  const base = s.present + s.late + s.half_day + s.absent;
  const lop = s.absent + s.leave_unpaid + s.half_day / 2;
  return {
    ...s,
    attended: round1(attended),
    attendance_percent: base ? round1((attended / base) * 100) : null,
    loss_of_pay_days: round1(lop),
    payable_days: round1(s.employed_days - lop),
    complete: s.not_marked === 0,
  };
}

export class TeacherRegisterService {
  constructor(
    private readonly deps: Deps,
    private readonly calendar: CalendarService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  private today() {
    return todayIso(this.deps.clock);
  }

  private presentTeacher(t: TeacherRow) {
    return {
      teacher_id: t.id,
      teacher_number: t.teacherNumber,
      full_name: fullName(t),
      department: t.department,
      designation: t.designation,
      status: t.status,
      joining_date: t.joiningDate,
      exit_date: t.exitDate,
    };
  }

  /** Every day of [from, to] for each matching teacher, worked out as described above. */
  private async compute(
    tenantId: string,
    from: string,
    to: string,
    filter: { teacherIds?: string[]; department?: string; q?: string },
  ) {
    const today = this.today();
    const conds: SQL[] = [
      eq(teachers.tenantId, tenantId),
      // Never employed yet: nothing to register.
      notInArray(teachers.status, ['PROSPECTIVE', 'ONBOARDING']),
      or(isNull(teachers.joiningDate), lte(teachers.joiningDate, to))!,
      or(isNull(teachers.exitDate), gte(teachers.exitDate, from))!,
    ];
    if (filter.teacherIds) conds.push(inArray(teachers.id, filter.teacherIds));
    if (filter.department) conds.push(eq(teachers.department, filter.department));
    if (filter.q) {
      const q = `%${filter.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      conds.push(
        or(
          like(teachers.firstName, q),
          like(teachers.lastName, q),
          like(teachers.teacherNumber, q),
          like(sql`CONCAT(${teachers.firstName}, ' ', ${teachers.lastName})`, q),
        )!,
      );
    }
    const staff = await this.db
      .select()
      .from(teachers)
      .where(and(...conds))
      .orderBy(asc(teachers.firstName), asc(teachers.lastName));
    // Archived teachers only appear when they were still employed in the period.
    const list = staff.filter((t) => t.status !== 'ARCHIVED' || !!t.exitDate);
    const ids = list.map((t) => t.id);
    const [marks, cal] = await Promise.all([
      ids.length
        ? this.db
            .select()
            .from(teacherAttendance)
            .where(
              and(
                eq(teacherAttendance.tenantId, tenantId),
                inArray(teacherAttendance.teacherId, ids),
                gte(teacherAttendance.attendanceDate, from),
                lte(teacherAttendance.attendanceDate, to),
              ),
            )
        : [],
      this.calendar.workingDays(tenantId, from, to, { kind: 'staff' }),
    ]);
    const offOn = new Map(cal.off_days.map((d) => [d.date, d]));
    const markOf = new Map(marks.map((m) => [`${m.teacherId}:${m.attendanceDate}`, m]));
    const dates: string[] = [];
    for (let t = toMs(from); t <= toMs(to); t += DAY_MS) dates.push(toIso(t));

    const rows = list.map((t) => {
      const days: DayCell[] = dates.map((date) => {
        const cell: DayCell = {
          date,
          state: 'NOT_MARKED',
          note: null,
          leave: null,
          off_name: null,
          marked: false,
        };
        if ((t.joiningDate && date < t.joiningDate) || (t.exitDate && date > t.exitDate)) {
          cell.state = 'NOT_EMPLOYED';
          return cell;
        }
        const off = offOn.get(date);
        if (off) {
          cell.state = off.reason === 'HOLIDAY' ? 'HOLIDAY' : 'OFF';
          cell.off_name = off.name;
          return cell;
        }
        const m = markOf.get(`${t.id}:${date}`);
        if (m) {
          cell.state = m.status;
          cell.note = m.note;
          cell.marked = true;
          if (m.status === 'LEAVE') cell.leave = { type: null, paid: true, approved: false };
          return cell;
        }
        cell.state = date > today ? 'UPCOMING' : 'NOT_MARKED';
        return cell;
      });
      return { teacher: t, days, summary: summarise(days, today) };
    });
    return {
      today,
      dates: dates.map((date) => {
        const off = offOn.get(date);
        return {
          date,
          weekday: weekday(date),
          off: off ? { reason: off.reason, name: off.name } : null,
          future: date > today,
        };
      }),
      rows,
    };
  }

  private assertRead(principal: Principal) {
    if (!hasTenantWideScope(principal, 'teachers.attendance.read'))
      throw new NotFoundError('Teacher attendance');
  }

  /** The month as a grid: every teacher × every day, with their totals. */
  async register(tenantId: string, q: z.infer<typeof RegisterQuery>, principal: Principal) {
    this.assertRead(principal);
    const { from, to } = monthRange(q.month);
    const r = await this.compute(tenantId, from, to, {
      department: q.department,
      q: q.q,
    });
    return {
      month: q.month,
      from,
      to,
      today: r.today,
      partial: to > r.today,
      days: r.dates,
      rows: r.rows.map((x) => ({
        ...this.presentTeacher(x.teacher),
        days: x.days,
        summary: x.summary,
      })),
      totals: addSummaries(r.rows.map((x) => x.summary)),
    };
  }

  private async loadTeacher(tenantId: string, teacherId: string) {
    const [t] = await this.db
      .select()
      .from(teachers)
      .where(and(eq(teachers.tenantId, tenantId), eq(teachers.id, teacherId)));
    if (!t) throw new NotFoundError('Teacher');
    return t;
  }

  /** One teacher's month: every day and the totals. */
  async teacherMonth(tenantId: string, teacherId: string, month: string, principal: Principal) {
    this.assertRead(principal);
    const t = await this.loadTeacher(tenantId, teacherId);
    const { from, to } = monthRange(month);
    const r = await this.compute(tenantId, from, to, { teacherIds: [teacherId] });
    const row = r.rows[0];
    const days =
      row?.days ??
      r.dates.map((d) => ({
        date: d.date,
        state: 'NOT_EMPLOYED' as DayState,
        note: null,
        leave: null,
        off_name: null,
        marked: false,
      }));
    return {
      teacher: this.presentTeacher(t),
      month,
      from,
      to,
      today: r.today,
      partial: to > r.today,
      days,
      summary: row?.summary ?? summarise(days, r.today),
    };
  }

  /** One teacher's year (calendar year): totals per month and for the year. */
  async teacherYear(tenantId: string, teacherId: string, year: number, principal: Principal) {
    this.assertRead(principal);
    const t = await this.loadTeacher(tenantId, teacherId);
    const r = await this.compute(tenantId, `${year}-01-01`, `${year}-12-31`, {
      teacherIds: [teacherId],
    });
    const days = r.rows[0]?.days ?? [];
    const months = Array.from({ length: 12 }, (_, i) => {
      const month = `${year}-${String(i + 1).padStart(2, '0')}`;
      const inMonth = days.filter((d) => d.date.startsWith(month));
      return {
        month,
        summary: summarise(inMonth, r.today),
        absent_dates: inMonth.filter((d) => d.state === 'ABSENT').map((d) => d.date),
      };
    });
    return {
      teacher: this.presentTeacher(t),
      year,
      today: r.today,
      months,
      summary: summarise(days, r.today),
    };
  }

  /** Set (or clear, with status null) one teacher's mark for one day. */
  async setDay(
    tenantId: string,
    teacherId: string,
    date: string,
    input: z.infer<typeof SetDayBody>,
    principal: Principal,
    actor: Actor,
  ) {
    if (!hasTenantWideScope(principal, 'teachers.attendance.mark'))
      throw new NotFoundError('Teacher');
    const t = await this.loadTeacher(tenantId, teacherId);
    if (date > this.today())
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'Attendance cannot be marked for a future date',
        {
          field: 'date',
        },
      );
    if ((t.joiningDate && date < t.joiningDate) || (t.exitDate && date > t.exitDate))
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        `${fullName(t)} was not employed on ${date}`,
        { field: 'date', reason: 'NOT_EMPLOYED' },
      );
    if (['PROSPECTIVE', 'ONBOARDING'].includes(t.status))
      throw new BusinessRuleError('INVALID_STATE', 'This person has not started working yet', {
        teacher_status: t.status,
      });
    const off = await this.calendar.dayOff(tenantId, date, { kind: 'staff' });
    if (off)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        `Attendance cannot be marked on a ${off.reason === 'HOLIDAY' ? 'school holiday' : 'weekly off day'} (${off.name})`,
        { field: 'date', day_off: off },
      );
    await this.db.transaction(async (tx) => {
      const at = and(
        eq(teacherAttendance.tenantId, tenantId),
        eq(teacherAttendance.teacherId, teacherId),
        eq(teacherAttendance.attendanceDate, date),
      );
      const [before] = await tx.select().from(teacherAttendance).where(at);
      if (input.status === null) {
        await tx.delete(teacherAttendance).where(at);
      } else {
        await tx
          .insert(teacherAttendance)
          .values({
            tenantId,
            teacherId,
            attendanceDate: date,
            status: input.status,
            note: input.note ?? null,
            markedBy: actor.userId,
          })
          .onDuplicateKeyUpdate({
            set: {
              status: input.status,
              note: input.note ?? null,
              markedBy: actor.userId,
              version: sql`${teacherAttendance.version} + 1`,
            },
          });
      }
      await recordChange(tx, actor, tenantId, {
        action:
          input.status === null ? 'TEACHER_ATTENDANCE_CLEARED' : 'TEACHER_ATTENDANCE_CORRECTED',
        entityType: 'teacher_attendance',
        entityId: teacherId,
        before: before ? { date, status: before.status, note: before.note } : null,
        after: { date, status: input.status, note: input.note ?? null },
      });
    });
    return this.teacherMonth(tenantId, teacherId, date.slice(0, 7), principal);
  }

  /** The month register as CSV: totals per person, and (with_days) one column per day. */
  async exportCsv(
    tenantId: string,
    q: z.infer<typeof RegisterQuery>,
    principal: Principal,
    actor: Actor,
  ) {
    const reg = await this.register(tenantId, q, principal);
    const head = [
      'Teacher no.',
      'Name',
      'Department',
      'Days employed',
      'Working days',
      'Present',
      'Late',
      'Half days',
      'Absent',
      'Leave (paid)',
      'Not marked',
      'Attendance %',
      'Loss-of-pay days',
      'Payable days',
    ];
    const dayHead = q.with_days ? reg.days.map((d) => `${d.date.slice(8)} ${d.weekday}`) : [];
    const lines = [
      csvLine([...head, ...dayHead]),
      ...reg.rows.map((r) =>
        csvLine([
          r.teacher_number,
          r.full_name,
          r.department ?? '',
          r.summary.employed_days,
          r.summary.working_days,
          r.summary.present,
          r.summary.late,
          r.summary.half_day,
          r.summary.absent,
          r.summary.leave_paid,
          r.summary.not_marked,
          r.summary.attendance_percent ?? '',
          r.summary.loss_of_pay_days,
          r.summary.payable_days,
          ...(q.with_days ? r.days.map((d) => CODE[d.state]) : []),
        ]),
      ),
    ];
    await this.db.transaction(async (tx) => {
      await recordChange(tx, actor, tenantId, {
        action: 'TEACHER_ATTENDANCE_EXPORTED',
        entityType: 'teacher_attendance',
        entityId: tenantId,
        payload: { month: q.month, rows: reg.rows.length, with_days: !!q.with_days },
      });
    });
    return lines.join('\n') + '\n';
  }
}
