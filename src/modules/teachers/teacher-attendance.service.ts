import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import { teacherAttendance, teachers } from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { todayIso } from '../../shared/dates.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { hasTenantWideScope } from '../access/authorization.service.js';
import type { CalendarService } from '../calendar/calendar.service.js';
import type { MarkAttendanceBody } from './teacher-attendance.schemas.js';
import { fullName } from './support.js';

const inMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
};

/**
 * Daily teacher attendance: Present, Late, Half day, Absent or Leave, one mark per
 * teacher per day, set by the office. The month register and salary-ready totals live
 * in TeacherRegisterService.
 */
export class TeacherAttendanceService {
  constructor(
    private readonly deps: Deps,
    private readonly calendar: CalendarService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  /** Every teacher expected on `date` with their mark (or none yet) and whether they are on leave (status). */
  async roster(tenantId: string, date: string, principal: Principal) {
    // A weekly off day or a whole-school holiday: nobody is expected, nothing to mark.
    const dayOff = await this.calendar.dayOff(tenantId, date, { kind: 'staff' });
    if (!hasTenantWideScope(principal, 'teachers.attendance.read'))
      return { date, day_off: dayOff, entries: [], summary: this.summarise([]) };
    const rows = await this.db
      .select({ t: teachers, a: teacherAttendance })
      .from(teachers)
      .leftJoin(
        teacherAttendance,
        and(
          eq(teacherAttendance.tenantId, teachers.tenantId),
          eq(teacherAttendance.teacherId, teachers.id),
          eq(teacherAttendance.attendanceDate, date),
        ),
      )
      .where(
        and(
          eq(teachers.tenantId, tenantId),
          inArray(teachers.status, ['ACTIVE', 'ON_LEAVE']),
          or(isNull(teachers.joiningDate), lte(teachers.joiningDate, date)),
        ),
      )
      .orderBy(asc(teachers.lastName), asc(teachers.firstName));
    const entries = rows.map((r) => ({
      teacher_id: r.t.id,
      teacher_number: r.t.teacherNumber,
      full_name: fullName(r.t),
      department: r.t.department,
      status: r.a?.status ?? null,
      note: r.a?.note ?? null,
      /** The teacher's status is ON_LEAVE (put on leave from the profile). */
      on_leave: r.t.status === 'ON_LEAVE',
    }));
    return {
      date,
      day_off: dayOff,
      entries,
      summary: this.summarise(entries.map((e) => e.status)),
    };
  }

  private summarise(statuses: (string | null)[]) {
    const n = (s: string) => statuses.filter((x) => x === s).length;
    return {
      total: statuses.length,
      present: n('PRESENT'),
      absent: n('ABSENT'),
      leave: n('LEAVE'),
      late: n('LATE'),
      half_day: n('HALF_DAY'),
      unmarked: statuses.filter((x) => x === null).length,
    };
  }

  async mark(
    tenantId: string,
    date: string,
    input: z.infer<typeof MarkAttendanceBody>,
    principal: Principal,
    actor: Actor,
  ) {
    if (!hasTenantWideScope(principal, 'teachers.attendance.mark'))
      throw new NotFoundError('Teacher');
    if (date > todayIso(this.deps.clock))
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'Attendance cannot be marked for a future date',
        { field: 'date' },
      );
    const off = await this.calendar.dayOff(tenantId, date, { kind: 'staff' });
    if (off)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        `Attendance cannot be marked on a ${off.reason === 'HOLIDAY' ? 'school holiday' : 'weekly off day'} (${off.name})`,
        { field: 'date', day_off: off },
      );
    const ids = input.entries.map((e) => e.teacher_id);
    if (new Set(ids).size !== ids.length)
      throw new ValidationError('The request is invalid', {
        location: 'body',
        issues: [{ path: 'entries', code: 'duplicate', message: 'A teacher appears twice' }],
      });
    const result = await this.db.transaction(async (tx) => {
      const found = await tx
        .select({ id: teachers.id, status: teachers.status })
        .from(teachers)
        .where(and(eq(teachers.tenantId, tenantId), inArray(teachers.id, ids)));
      if (found.length !== ids.length) throw new NotFoundError('Teacher');
      const bad = found.find((f) => f.status !== 'ACTIVE' && f.status !== 'ON_LEAVE');
      if (bad)
        throw new BusinessRuleError(
          'INVALID_STATE',
          'Attendance can only be marked for active teachers',
          { teacher_id: bad.id, teacher_status: bad.status },
        );
      await tx
        .insert(teacherAttendance)
        .values(
          input.entries.map((e) => ({
            tenantId,
            teacherId: e.teacher_id,
            attendanceDate: date,
            status: e.status,
            note: e.note ?? null,
            markedBy: actor.userId,
          })),
        )
        .onDuplicateKeyUpdate({
          set: {
            status: sql`VALUES(status)`,
            note: sql`VALUES(note)`,
            markedBy: sql`VALUES(marked_by)`,
            version: sql`${teacherAttendance.version} + 1`,
          },
        });
      const summary = this.summarise(input.entries.map((e) => e.status));
      await recordChange(tx, actor, tenantId, {
        action: 'TEACHER_ATTENDANCE_MARKED',
        entityType: 'teacher_attendance',
        entityId: tenantId,
        event: 'teacher_attendance.marked',
        after: { date, ...summary },
        payload: { date, marked: input.entries.length },
      });
      return summary;
    });
    return { date, marked: input.entries.length, summary: result };
  }

  /** Per-person counts for a month (everyone, or only the caller for non-approvers). */
  async monthly(tenantId: string, month: string, principal: Principal) {
    const { from, to } = inMonth(month);
    // Working days of the month for staff (weekly offs and whole-school holidays left out).
    const cal = await this.calendar.workingDays(tenantId, from, to, { kind: 'staff' });
    const calendar = { working_days: cal.working_days, off_days: cal.off_days };
    if (!hasTenantWideScope(principal, 'teachers.attendance.read'))
      return { month, ...calendar, rows: [] };
    const rows = await this.db
      .select({
        t: teachers,
        status: teacherAttendance.status,
        n: sql<number>`COUNT(${teacherAttendance.id})`,
      })
      .from(teachers)
      .leftJoin(
        teacherAttendance,
        and(
          eq(teacherAttendance.tenantId, teachers.tenantId),
          eq(teacherAttendance.teacherId, teachers.id),
          sql`${teacherAttendance.attendanceDate} BETWEEN ${from} AND ${to}`,
        ),
      )
      .where(
        and(
          eq(teachers.tenantId, tenantId),
          inArray(teachers.status, ['ACTIVE', 'ON_LEAVE', 'RESIGNED', 'RETIRED', 'INACTIVE']),
        ),
      )
      .groupBy(teachers.id, teacherAttendance.status)
      .orderBy(asc(teachers.lastName), asc(teachers.firstName));
    const by = new Map<
      string,
      { teacher: (typeof rows)[number]['t']; c: Record<string, number> }
    >();
    for (const r of rows) {
      const e = by.get(r.t.id) ?? { teacher: r.t, c: {} };
      if (r.status) e.c[r.status] = Number(r.n);
      by.set(r.t.id, e);
    }
    return {
      month,
      ...calendar,
      rows: [...by.values()].map((e) => {
        const c = e.c;
        return {
          teacher_id: e.teacher.id,
          teacher_number: e.teacher.teacherNumber,
          full_name: fullName(e.teacher),
          present: c.PRESENT ?? 0,
          absent: c.ABSENT ?? 0,
          leave: c.LEAVE ?? 0,
          late: c.LATE ?? 0,
          half_day: c.HALF_DAY ?? 0,
          marked_days:
            (c.PRESENT ?? 0) + (c.ABSENT ?? 0) + (c.LEAVE ?? 0) + (c.LATE ?? 0) + (c.HALF_DAY ?? 0),
        };
      }),
    };
  }

  /** The signed-in teacher's own marks for a month. */
  async mine(tenantId: string, month: string, principal: Principal) {
    const [t] = await this.db
      .select()
      .from(teachers)
      .where(
        and(eq(teachers.tenantId, tenantId), eq(teachers.membershipId, principal.membershipId)),
      );
    if (!t) throw new NotFoundError('Teacher');
    const { from, to } = inMonth(month);
    const rows = await this.db
      .select()
      .from(teacherAttendance)
      .where(
        and(
          eq(teacherAttendance.tenantId, tenantId),
          eq(teacherAttendance.teacherId, t.id),
          sql`${teacherAttendance.attendanceDate} BETWEEN ${from} AND ${to}`,
        ),
      )
      .orderBy(asc(teacherAttendance.attendanceDate));
    return {
      month,
      days: rows.map((r) => ({ date: r.attendanceDate, status: r.status, note: r.note })),
      summary: this.summarise(rows.map((r) => r.status)),
    };
  }
}
