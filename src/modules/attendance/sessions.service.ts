import { and, asc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { CalendarService } from '../calendar/calendar.service.js';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  attendanceCorrections,
  attendanceRecords,
  attendanceSessions,
  attendanceStatuses,
  enrollments,
  subjectOfferings,
  subjects,
  students,
  teachers,
} from '../../db/schema/index.js';
import { recordChange } from '../../platform/record.js';
import {
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import { offsetOf, pageOf } from '../../shared/pagination.js';
import { fullName } from '../students/support.js';
import type {
  MarkAllBody,
  OpenSessionBody,
  SaveRecordsBody,
  SessionListQuery,
} from './attendance.schemas.js';
import type { AttendanceConfigService } from './config.service.js';
import {
  assertEditWindow,
  canUseType,
  loadStatuses,
  num,
  placementScope,
  readSettings,
  requireSubjectFeature,
  rows,
  schoolToday,
  sectionInScope,
  validationIssue,
  type Caller,
} from './support.js';

export type SessionRow = typeof attendanceSessions.$inferSelect;

/** Enrollment states that can put a student on a register for a past or current date. */
export const ROSTER_ENROLLMENT_STATUSES = [
  'ACTIVE',
  'COMPLETED',
  'TRANSFERRED',
  'WITHDRAWN',
] as const;

export type CategoryCounts = Record<
  'present' | 'absent' | 'late' | 'half_day' | 'excused' | 'leave' | 'other',
  number
>;
export const emptyCounts = (): CategoryCounts => ({
  present: 0,
  absent: 0,
  late: 0,
  half_day: 0,
  excused: 0,
  leave: 0,
  other: 0,
});

export interface Eligible {
  enrollmentId: string;
  studentId: string;
  studentNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
}

const studentView = (s: {
  studentId: string;
  studentNumber: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
}) => ({
  id: s.studentId,
  student_number: s.studentNumber,
  first_name: s.firstName,
  last_name: s.lastName,
  full_name: fullName(s),
});

/**
 * Attendance sessions: one register for one section and date (DAILY) or one
 * subject period (SUBJECT), its bulk marking, and its DRAFT → SUBMITTED → FINAL
 * lifecycle. Every state change writes audit + outbox in the same transaction.
 */
export class SessionService {
  constructor(
    private readonly deps: Deps,
    private readonly config: AttendanceConfigService,
    private readonly calendar: CalendarService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  // ---- loading -----------------------------------------------------------------

  /**
   * Load a session the caller may use with `permission`, or 404 (another school's
   * id, or a section outside the caller's scope, look identical to a missing one).
   * SUBJECT sessions additionally need the `attendance.subject` feature.
   */
  async loadSession(
    ex: Executor,
    c: Caller,
    id: string,
    permission: string,
    lock: 'share' | 'update' | false = false,
  ): Promise<SessionRow> {
    const scope = placementScope(c.principal, permission, {
      section: attendanceSessions.sectionId,
      klass: attendanceSessions.classId,
    });
    const q = ex
      .select()
      .from(attendanceSessions)
      .where(
        and(eq(attendanceSessions.id, id), eq(attendanceSessions.tenantId, c.tenantId), scope),
      );
    const [row] = await (lock ? q.for(lock) : q);
    if (!row) throw new NotFoundError('Attendance session');
    if (!canUseType(c.features, row.attendanceType)) requireSubjectFeature(c.features);
    return row;
  }

  private viewSelect(ex: Executor) {
    return ex
      .select({
        s: attendanceSessions,
        yearCode: academicYears.code,
        className: academicClasses.name,
        classCode: academicClasses.code,
        sectionName: academicSections.name,
        sectionCode: academicSections.code,
        subjectId: subjects.id,
        subjectCode: subjects.code,
        subjectName: subjects.name,
        teacherNumber: teachers.teacherNumber,
        tFirst: teachers.firstName,
        tMiddle: teachers.middleName,
        tLast: teachers.lastName,
      })
      .from(attendanceSessions)
      .innerJoin(
        academicYears,
        and(
          eq(academicYears.tenantId, attendanceSessions.tenantId),
          eq(academicYears.id, attendanceSessions.academicYearId),
        ),
      )
      .innerJoin(
        academicClasses,
        and(
          eq(academicClasses.tenantId, attendanceSessions.tenantId),
          eq(academicClasses.id, attendanceSessions.classId),
        ),
      )
      .innerJoin(
        academicSections,
        and(
          eq(academicSections.tenantId, attendanceSessions.tenantId),
          eq(academicSections.id, attendanceSessions.sectionId),
        ),
      )
      .leftJoin(
        subjectOfferings,
        and(
          eq(subjectOfferings.tenantId, attendanceSessions.tenantId),
          eq(subjectOfferings.id, attendanceSessions.subjectOfferingId),
        ),
      )
      .leftJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
      .leftJoin(
        teachers,
        and(
          eq(teachers.tenantId, attendanceSessions.tenantId),
          eq(teachers.id, attendanceSessions.teacherId),
        ),
      );
  }

  private presentHeader(r: Awaited<ReturnType<SessionService['viewSelect']>>[number]) {
    const s = r.s;
    return {
      id: s.id,
      attendance_type: s.attendanceType,
      academic_year: { id: s.academicYearId, code: r.yearCode },
      class: { id: s.classId, code: r.classCode, name: r.className },
      section: { id: s.sectionId, code: r.sectionCode, name: r.sectionName },
      session_date: s.sessionDate,
      subject_offering: s.subjectOfferingId
        ? {
            id: s.subjectOfferingId,
            subject: r.subjectId
              ? { id: r.subjectId, code: r.subjectCode, name: r.subjectName }
              : null,
          }
        : null,
      period_label: s.periodLabel,
      teacher: s.teacherId
        ? {
            id: s.teacherId,
            teacher_number: r.teacherNumber,
            full_name: fullName({
              firstName: r.tFirst ?? '',
              middleName: r.tMiddle,
              lastName: r.tLast ?? '',
            }),
          }
        : null,
      status: s.status,
      rejection_reason: s.status === 'DRAFT' ? s.rejectionReason : null,
      reopen_reason: s.reopenReason,
      started_at: s.startedAt.toISOString(),
      started_by: s.startedBy,
      submitted_at: s.submittedAt?.toISOString() ?? null,
      submitted_by: s.submittedBy,
      approved_at: s.approvedAt?.toISOString() ?? null,
      approved_by: s.approvedBy,
      finalized_at: s.finalizedAt?.toISOString() ?? null,
      rejected_at: s.rejectedAt?.toISOString() ?? null,
      reopened_at: s.reopenedAt?.toISOString() ?? null,
      version: s.version,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
  }

  // ---- roster ------------------------------------------------------------------

  /**
   * Students who belong on the register: an enrollment in this section and year that
   * covers the session date (start_date ≤ date < end_date; end_date is exclusive
   * because a class change starts the new enrollment on the same day the old one
   * ends). PENDING and CANCELLED enrollments never count.
   * `lock` uses a locking read so concurrent enrollment changes are seen (REPEATABLE READ).
   */
  async eligible(
    ex: Executor,
    s: Pick<SessionRow, 'tenantId' | 'sectionId' | 'academicYearId' | 'sessionDate'>,
    lock: boolean,
  ): Promise<Eligible[]> {
    const q = ex
      .select({
        enrollmentId: enrollments.id,
        studentId: students.id,
        studentNumber: students.studentNumber,
        firstName: students.firstName,
        middleName: students.middleName,
        lastName: students.lastName,
        startDate: enrollments.startDate,
      })
      .from(enrollments)
      .innerJoin(
        students,
        and(eq(students.tenantId, enrollments.tenantId), eq(students.id, enrollments.studentId)),
      )
      .where(
        and(
          eq(enrollments.tenantId, s.tenantId),
          eq(enrollments.sectionId, s.sectionId),
          eq(enrollments.academicYearId, s.academicYearId),
          inArray(enrollments.status, [...ROSTER_ENROLLMENT_STATUSES]),
          lte(enrollments.startDate, s.sessionDate),
          or(isNull(enrollments.endDate), gt(enrollments.endDate, s.sessionDate)),
        ),
      )
      .orderBy(asc(students.lastName), asc(students.firstName), asc(students.id));
    const found = await (lock ? q.for('share') : q);
    const byStudent = new Map<string, (typeof found)[number]>();
    for (const r of found) {
      const cur = byStudent.get(r.studentId);
      if (!cur || r.startDate > cur.startDate) byStudent.set(r.studentId, r);
    }
    return found.filter((r) => byStudent.get(r.studentId) === r);
  }

  private async buildRoster(ex: Executor, s: SessionRow) {
    const recs = await ex
      .select({
        r: attendanceRecords,
        code: attendanceStatuses.code,
        name: attendanceStatuses.name,
        category: attendanceStatuses.category,
        studentNumber: students.studentNumber,
        firstName: students.firstName,
        middleName: students.middleName,
        lastName: students.lastName,
      })
      .from(attendanceRecords)
      .innerJoin(
        attendanceStatuses,
        and(
          eq(attendanceStatuses.tenantId, attendanceRecords.tenantId),
          eq(attendanceStatuses.id, attendanceRecords.statusId),
        ),
      )
      .innerJoin(
        students,
        and(
          eq(students.tenantId, attendanceRecords.tenantId),
          eq(students.id, attendanceRecords.studentId),
        ),
      )
      .where(
        and(eq(attendanceRecords.tenantId, s.tenantId), eq(attendanceRecords.sessionId, s.id)),
      );
    // A DRAFT register follows enrollment live. Once submitted it is a snapshot: only
    // students who were marked (submit requires everyone to be marked).
    const live = s.status === 'DRAFT' ? await this.eligible(ex, s, false) : [];
    const eligibleIds = new Set(live.map((e) => e.studentId));
    type Item = {
      student: ReturnType<typeof studentView>;
      enrollment_id: string | null;
      on_roster: boolean;
      record: null | {
        id: string;
        status_id: string;
        status_code: string;
        status_name: string;
        category: string;
        remarks: string | null;
        marked_at: string;
        marked_by: string | null;
        version: number;
      };
    };
    const byStudent = new Map<string, Item>();
    for (const e of live)
      byStudent.set(e.studentId, {
        student: studentView(e),
        enrollment_id: e.enrollmentId,
        on_roster: true,
        record: null,
      });
    for (const x of recs) {
      byStudent.set(x.r.studentId, {
        student: studentView({ ...x, studentId: x.r.studentId }),
        enrollment_id: x.r.enrollmentId,
        on_roster: s.status === 'DRAFT' ? eligibleIds.has(x.r.studentId) : true,
        record: {
          id: x.r.id,
          status_id: x.r.statusId,
          status_code: x.code,
          status_name: x.name,
          category: x.category,
          remarks: x.r.remarks,
          marked_at: x.r.markedAt.toISOString(),
          marked_by: x.r.markedBy,
          version: x.r.version,
        },
      });
    }
    const roster = [...byStudent.values()].sort(
      (a, b) =>
        a.student.last_name.localeCompare(b.student.last_name) ||
        a.student.first_name.localeCompare(b.student.first_name) ||
        a.student.id.localeCompare(b.student.id),
    );
    const counts = emptyCounts();
    const byStatus: Record<string, number> = {};
    let presentUnits = 0;
    let absentUnits = 0;
    for (const x of recs) {
      counts[x.category.toLowerCase() as keyof CategoryCounts]++;
      byStatus[x.code] = (byStatus[x.code] ?? 0) + 1;
      presentUnits += Number(x.r.presentWeight);
      absentUnits += Number(x.r.absentWeight);
    }
    const marked = roster.filter((i) => i.record).length;
    return {
      roster,
      summary: {
        roster_size: roster.length,
        marked_count: marked,
        unmarked_count: roster.length - marked,
        counts,
        by_status: byStatus,
        present_units: Math.round(presentUnits * 100) / 100,
        absent_units: Math.round(absentUnits * 100) / 100,
      },
    };
  }

  // ---- reads -------------------------------------------------------------------

  /** Session header + summary + the full roster with each student's current mark. */
  async get(c: Caller, id: string, permission = 'attendance.read', ex: Executor = this.db) {
    await this.config.ensureDefaults(c.tenantId);
    const s = await this.loadSession(ex, c, id, permission);
    const [head] = await this.viewSelect(ex).where(eq(attendanceSessions.id, s.id));
    if (!head) throw new NotFoundError('Attendance session');
    const { roster, summary } = await this.buildRoster(ex, s);
    return { ...this.presentHeader(head), summary, roster };
  }

  async list(c: Caller, q: z.infer<typeof SessionListQuery>) {
    await this.config.ensureDefaults(c.tenantId);
    const conds: SQL[] = [sql`s.tenant_id = ${c.tenantId}`];
    const scope = placementScope(c.principal, 'attendance.read', {
      section: sql`s.section_id`,
      klass: sql`s.class_id`,
    });
    if (scope) conds.push(scope);
    if (!c.features.includes('attendance.subject')) conds.push(sql`s.attendance_type = 'DAILY'`);
    if (q.section_id) conds.push(sql`s.section_id = ${q.section_id}`);
    if (q.class_id) conds.push(sql`s.class_id = ${q.class_id}`);
    if (q.academic_year_id) conds.push(sql`s.academic_year_id = ${q.academic_year_id}`);
    if (q.attendance_type) conds.push(sql`s.attendance_type = ${q.attendance_type}`);
    if (q.status) conds.push(sql`s.status = ${q.status}`);
    if (q.date_from) conds.push(sql`s.session_date >= ${q.date_from}`);
    if (q.date_to) conds.push(sql`s.session_date <= ${q.date_to}`);
    const where = sql.join(conds, sql` and `);
    const [total] = await rows<{ n: number }>(
      this.db,
      sql`select count(*) as n from attendance_sessions s where ${where}`,
    );
    type Row = {
      id: string;
      attendance_type: string;
      academic_year_id: string;
      class_id: string;
      cl_code: string;
      cl_name: string;
      section_id: string;
      sec_code: string;
      sec_name: string;
      session_date: string;
      subject_offering_id: string | null;
      subject_name: string | null;
      period_label: string | null;
      status: string;
      version: number;
      started_at: Date;
      submitted_at: Date | null;
      finalized_at: Date | null;
      marked: number;
      c_present: string;
      c_absent: string;
      c_late: string;
      c_half_day: string;
      c_excused: string;
      c_leave: string;
      c_other: string;
      present_units: string | null;
    };
    const data = await rows<Row>(
      this.db,
      sql`select s.id, s.attendance_type, s.academic_year_id, s.class_id, cl.code as cl_code, cl.name as cl_name,
        s.section_id, sec.code as sec_code, sec.name as sec_name,
        date_format(s.session_date, '%Y-%m-%d') as session_date,
        s.subject_offering_id, sub.name as subject_name, s.period_label, s.status, s.version,
        s.started_at, s.submitted_at, s.finalized_at,
        count(r.id) as marked,
        coalesce(sum(st.category = 'PRESENT'), 0) as c_present,
        coalesce(sum(st.category = 'ABSENT'), 0) as c_absent,
        coalesce(sum(st.category = 'LATE'), 0) as c_late,
        coalesce(sum(st.category = 'HALF_DAY'), 0) as c_half_day,
        coalesce(sum(st.category = 'EXCUSED'), 0) as c_excused,
        coalesce(sum(st.category = 'LEAVE'), 0) as c_leave,
        coalesce(sum(st.category = 'OTHER'), 0) as c_other,
        sum(r.present_weight) as present_units
      from attendance_sessions s
      join academic_classes cl on cl.tenant_id = s.tenant_id and cl.id = s.class_id
      join academic_sections sec on sec.tenant_id = s.tenant_id and sec.id = s.section_id
      left join subject_offerings so on so.tenant_id = s.tenant_id and so.id = s.subject_offering_id
      left join subjects sub on sub.id = so.subject_id
      left join attendance_records r on r.tenant_id = s.tenant_id and r.session_id = s.id
      left join attendance_statuses st on st.tenant_id = r.tenant_id and st.id = r.status_id
      where ${where}
      group by s.id, cl.code, cl.name, sec.code, sec.name, sub.name
      order by s.session_date desc, sec.name asc, s.id desc
      limit ${q.page_size} offset ${offsetOf(q)}`,
    );
    return pageOf(
      data.map((r) => ({
        id: r.id,
        attendance_type: r.attendance_type,
        academic_year_id: r.academic_year_id,
        class: { id: r.class_id, code: r.cl_code, name: r.cl_name },
        section: { id: r.section_id, code: r.sec_code, name: r.sec_name },
        session_date: r.session_date,
        subject_offering_id: r.subject_offering_id,
        subject_name: r.subject_name,
        period_label: r.period_label,
        status: r.status,
        version: r.version,
        started_at: new Date(r.started_at).toISOString(),
        submitted_at: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
        finalized_at: r.finalized_at ? new Date(r.finalized_at).toISOString() : null,
        marked_count: num(r.marked),
        counts: {
          present: num(r.c_present),
          absent: num(r.c_absent),
          late: num(r.c_late),
          half_day: num(r.c_half_day),
          excused: num(r.c_excused),
          leave: num(r.c_leave),
          other: num(r.c_other),
        },
        present_units: num(r.present_units),
      })),
      num(total?.n),
      q,
    );
  }

  // ---- open --------------------------------------------------------------------

  /**
   * Open-or-get the session for a section and date. Idempotent and safe under
   * concurrent calls: the generated `session_key` UNIQUE means exactly one row wins,
   * and the loser reads the winner's row.
   */
  async open(c: Caller, input: z.infer<typeof OpenSessionBody>) {
    await this.config.ensureDefaults(c.tenantId);
    if (input.attendance_type === 'SUBJECT') requireSubjectFeature(c.features);
    else if (input.subject_offering_id || input.period_label)
      throw validationIssue(
        input.subject_offering_id ? 'subject_offering_id' : 'period_label',
        'Only SUBJECT sessions take a subject offering or a period label',
      );
    if (input.attendance_type === 'SUBJECT' && !input.subject_offering_id)
      throw validationIssue(
        'subject_offering_id',
        'A subject offering is required for SUBJECT attendance',
      );

    const out = await this.db.transaction(async (tx) => {
      const [section] = await tx
        .select()
        .from(academicSections)
        .where(
          and(eq(academicSections.id, input.section_id), eq(academicSections.tenantId, c.tenantId)),
        )
        .for('share');
      if (!section || !sectionInScope(c.principal, 'attendance.mark', section))
        throw new NotFoundError('Section');
      const [year] = await tx
        .select()
        .from(academicYears)
        .where(
          and(eq(academicYears.id, section.academicYearId), eq(academicYears.tenantId, c.tenantId)),
        )
        .for('share');
      if (!year) throw new NotFoundError('Academic year');
      if (year.status !== 'ACTIVE')
        throw new BusinessRuleError(
          'INVALID_STATE',
          'Attendance can only be recorded in the active academic year',
          { academic_year_status: year.status },
        );
      if (section.status !== 'ACTIVE')
        throw new BusinessRuleError('INVALID_STATE', 'The section is not active', {
          section_status: section.status,
        });
      const today = await schoolToday(tx, c.tenantId, this.deps.clock);
      if (input.session_date > today)
        throw validationIssue('session_date', 'Attendance cannot be recorded for a future date');
      if (input.session_date < year.startDate || input.session_date > year.endDate)
        throw validationIssue(
          'session_date',
          `The date is outside the academic year (${year.startDate} to ${year.endDate})`,
        );
      // No attendance on a weekly off day or a holiday that applies to this class.
      const off = await this.calendar.dayOff(
        c.tenantId,
        input.session_date,
        { kind: 'class', classId: section.classId },
        tx,
      );
      if (off)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          `No school on this day: ${off.reason === 'HOLIDAY' ? `holiday (${off.name})` : `weekly off (${off.name})`}`,
          { field: 'session_date', day_off: off },
        );
      const settings = await readSettings(tx, c.tenantId, 'share');
      assertEditWindow(
        c.principal,
        settings,
        { sessionDate: input.session_date, reopenedAt: null },
        today,
      );

      let offeringId: string | null = null;
      if (input.attendance_type === 'SUBJECT') {
        const [o] = await tx
          .select()
          .from(subjectOfferings)
          .where(
            and(
              eq(subjectOfferings.id, input.subject_offering_id!),
              eq(subjectOfferings.tenantId, c.tenantId),
            ),
          )
          .for('share');
        if (!o) throw new NotFoundError('Subject offering');
        if (
          o.status !== 'ACTIVE' ||
          o.academicYearId !== section.academicYearId ||
          o.classId !== section.classId ||
          (o.sectionId !== null && o.sectionId !== section.id)
        )
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            'The subject offering is not active for this section',
          );
        offeringId = o.id;
      }
      const periodLabel = input.attendance_type === 'SUBJECT' ? (input.period_label ?? null) : null;

      const sameSession = and(
        eq(attendanceSessions.tenantId, c.tenantId),
        eq(attendanceSessions.attendanceType, input.attendance_type),
        eq(attendanceSessions.academicYearId, section.academicYearId),
        eq(attendanceSessions.sectionId, section.id),
        eq(attendanceSessions.sessionDate, input.session_date),
        offeringId
          ? eq(attendanceSessions.subjectOfferingId, offeringId)
          : isNull(attendanceSessions.subjectOfferingId),
        periodLabel
          ? eq(attendanceSessions.periodLabel, periodLabel)
          : isNull(attendanceSessions.periodLabel),
      );
      const [existing] = await tx
        .select({ id: attendanceSessions.id })
        .from(attendanceSessions)
        .where(sameSession);
      if (existing) return { id: existing.id, created: false };

      const [teacher] = await tx
        .select({ id: teachers.id })
        .from(teachers)
        .where(
          and(
            eq(teachers.tenantId, c.tenantId),
            eq(teachers.membershipId, c.principal.membershipId),
          ),
        );
      try {
        const [ins] = await tx
          .insert(attendanceSessions)
          .values({
            tenantId: c.tenantId,
            attendanceType: input.attendance_type,
            academicYearId: section.academicYearId,
            classId: section.classId,
            sectionId: section.id,
            sessionDate: input.session_date,
            subjectOfferingId: offeringId,
            teacherId: teacher?.id ?? null,
            periodLabel,
            status: 'DRAFT',
            startedAt: this.deps.clock.now(),
            startedBy: c.actor.userId,
          })
          .$returningId();
        await recordChange(tx, c.actor, c.tenantId, {
          action: 'ATTENDANCE_SESSION_OPENED',
          entityType: 'attendance_session',
          entityId: ins!.id,
          event: 'attendance.session_opened',
          after: {
            attendance_type: input.attendance_type,
            section_id: section.id,
            session_date: input.session_date,
            subject_offering_id: offeringId,
            period_label: periodLabel,
          },
          payload: {
            attendance_type: input.attendance_type,
            academic_year_id: section.academicYearId,
            class_id: section.classId,
            section_id: section.id,
            session_date: input.session_date,
            subject_offering_id: offeringId,
            period_label: periodLabel,
          },
        });
        return { id: ins!.id, created: true };
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        // A concurrent call won the unique key. A locking read sees its committed row.
        const [winner] = await tx
          .select({ id: attendanceSessions.id })
          .from(attendanceSessions)
          .where(sameSession)
          .for('share');
        if (!winner) throw err;
        return { id: winner.id, created: false };
      }
    });
    return { created: out.created, session: await this.get(c, out.id, 'attendance.mark') };
  }

  // ---- marking -----------------------------------------------------------------

  /** Bulk upsert of marks, one transaction, one audit row and one event. */
  saveRecords(c: Caller, id: string, body: z.infer<typeof SaveRecordsBody>) {
    return this.applyEntries(c, id, { mode: 'bulk', version: body.version, entries: body.records });
  }

  /** Convenience: one status for everyone on the roster (only the unmarked, unless `overwrite`). */
  markAll(c: Caller, id: string, body: z.infer<typeof MarkAllBody>) {
    return this.applyEntries(c, id, {
      mode: 'mark_all',
      version: body.version,
      markAll: {
        statusId: body.status_id,
        remarks: body.remarks ?? null,
        overwrite: body.overwrite,
      },
    });
  }

  private async applyEntries(
    c: Caller,
    sessionId: string,
    o: {
      mode: 'bulk' | 'mark_all';
      version?: number;
      entries?: { student_id: string; status_id: string; remarks?: string | null }[];
      markAll?: { statusId?: string; remarks: string | null; overwrite: boolean };
    },
  ) {
    await this.config.ensureDefaults(c.tenantId);
    const saved = await this.db.transaction(async (tx) => {
      // Lock order: session (FOR UPDATE) → settings → statuses → enrollments → records.
      // The session lock serialises concurrent saves; everything read afterwards is
      // read with a locking read so it reflects concurrent commits (REPEATABLE READ).
      const s = await this.loadSession(tx, c, sessionId, 'attendance.mark', 'update');
      if (o.version !== undefined && o.version !== s.version) throw new ConflictError('CONFLICT');
      if (s.status !== 'DRAFT')
        throw new BusinessRuleError(
          'INVALID_STATE',
          s.status === 'SUBMITTED'
            ? 'The session is awaiting approval and cannot be edited'
            : 'The session is final. Request a correction instead, or ask an approver to reopen it.',
          { session_status: s.status },
        );
      const settings = await readSettings(tx, c.tenantId, 'share');
      assertEditWindow(
        c.principal,
        settings,
        s,
        await schoolToday(tx, c.tenantId, this.deps.clock),
      );
      const eligible = await this.eligible(tx, s, true);
      const eligibleBy = new Map(eligible.map((e) => [e.studentId, e]));
      const existingRows = await tx
        .select()
        .from(attendanceRecords)
        .where(
          and(eq(attendanceRecords.tenantId, c.tenantId), eq(attendanceRecords.sessionId, s.id)),
        )
        .for('update');
      const existing = new Map(existingRows.map((r) => [r.studentId, r]));

      let entries = o.entries ?? [];
      if (o.markAll) {
        let statusId = o.markAll.statusId;
        if (!statusId) {
          const [p] = await tx
            .select({ id: attendanceStatuses.id })
            .from(attendanceStatuses)
            .where(
              and(
                eq(attendanceStatuses.tenantId, c.tenantId),
                eq(attendanceStatuses.code, 'PRESENT'),
              ),
            );
          statusId = p!.id;
        }
        const sid = statusId;
        entries = eligible
          .filter((e) => o.markAll!.overwrite || !existing.has(e.studentId))
          .map((e) => ({ student_id: e.studentId, status_id: sid, remarks: o.markAll!.remarks }));
        if (!entries.length && o.markAll.statusId) {
          // still validate the status the caller named
          const st = await loadStatuses(tx, c.tenantId, [o.markAll.statusId], 'share');
          if (!st.has(o.markAll.statusId))
            throw validationIssue('status_id', 'Unknown attendance status');
        }
      }

      const ids = new Set<string>();
      for (const e of entries) ids.add(e.status_id);
      for (const e of entries) {
        const ex = existing.get(e.student_id);
        if (ex) ids.add(ex.statusId);
      }
      const statuses = await loadStatuses(tx, c.tenantId, [...ids], 'share');

      const issues: { path: string; code: string; message: string }[] = [];
      const at = (i: number, f: string) => (o.mode === 'bulk' ? `records.${i}.${f}` : f);
      entries.forEach((e, i) => {
        const st = statuses.get(e.status_id);
        if (!st)
          issues.push({
            path: at(i, 'status_id'),
            code: 'custom',
            message: 'Unknown attendance status',
          });
        else {
          if (st.status !== 'ACTIVE')
            issues.push({
              path: at(i, 'status_id'),
              code: 'custom',
              message: `The status ${st.code} is inactive`,
            });
          if (st.requiresReason && !(e.remarks ?? '').trim())
            issues.push({
              path: at(i, 'remarks'),
              code: 'custom',
              message: `A reason is required for ${st.code}`,
            });
        }
        if (!existing.has(e.student_id) && !eligibleBy.has(e.student_id))
          issues.push({
            path: at(i, 'student_id'),
            code: 'not_on_roster',
            message: 'The student is not on this session roster',
          });
      });
      if (issues.length)
        throw new ValidationError('The request is invalid', { location: 'body', issues });

      const now = this.deps.clock.now();
      const fresh: (typeof attendanceRecords.$inferInsert)[] = [];
      const changes: { student_id: string; from: string; to: string }[] = [];
      let unchanged = 0;
      const byCategory = emptyCounts();
      for (const e of entries) {
        const st = statuses.get(e.status_id)!;
        byCategory[st.category.toLowerCase() as keyof CategoryCounts]++;
        const remarks = e.remarks?.trim() ? e.remarks.trim() : null;
        const ex = existing.get(e.student_id);
        if (ex) {
          if (ex.statusId === st.id && (ex.remarks ?? null) === remarks) {
            unchanged++;
            continue;
          }
          await tx
            .update(attendanceRecords)
            .set({
              statusId: st.id,
              presentWeight: st.countsAsPresent,
              absentWeight: st.countsAsAbsent,
              remarks,
              markedAt: now,
              markedBy: c.actor.userId,
              version: ex.version + 1,
            })
            .where(
              and(eq(attendanceRecords.id, ex.id), eq(attendanceRecords.tenantId, c.tenantId)),
            );
          changes.push({
            student_id: e.student_id,
            from: statuses.get(ex.statusId)?.code ?? ex.statusId,
            to: st.code,
          });
        } else {
          fresh.push({
            tenantId: c.tenantId,
            sessionId: s.id,
            studentId: e.student_id,
            enrollmentId: eligibleBy.get(e.student_id)!.enrollmentId,
            statusId: st.id,
            presentWeight: st.countsAsPresent,
            absentWeight: st.countsAsAbsent,
            remarks,
            markedAt: now,
            markedBy: c.actor.userId,
          });
        }
      }
      if (fresh.length) await tx.insert(attendanceRecords).values(fresh);
      const result = { created: fresh.length, updated: changes.length, unchanged };
      if (fresh.length || changes.length) {
        await tx
          .update(attendanceSessions)
          .set({ version: s.version + 1 })
          .where(and(eq(attendanceSessions.id, s.id), eq(attendanceSessions.tenantId, c.tenantId)));
        await recordChange(tx, c.actor, c.tenantId, {
          action: 'ATTENDANCE_RECORDED',
          entityType: 'attendance_session',
          entityId: s.id,
          event: 'attendance.recorded',
          after: { ...result, mode: o.mode, changes: changes.slice(0, 200) },
          payload: {
            mode: o.mode,
            section_id: s.sectionId,
            session_date: s.sessionDate,
            attendance_type: s.attendanceType,
            ...result,
            by_category: byCategory,
          },
        });
      }
      return result;
    });
    return { saved, session: await this.get(c, sessionId, 'attendance.mark') };
  }

  // ---- lifecycle ---------------------------------------------------------------

  /**
   * DRAFT → SUBMITTED (approval required) or DRAFT → FINAL (not required). Every
   * student on the roster must be marked. Needs `attendance.mark`.
   */
  async submit(c: Caller, id: string, version?: number) {
    await this.config.ensureDefaults(c.tenantId);
    await this.db.transaction(async (tx) => {
      const s = await this.loadSession(tx, c, id, 'attendance.mark', 'update');
      if (version !== undefined && version !== s.version) throw new ConflictError('CONFLICT');
      if (s.status !== 'DRAFT')
        throw new BusinessRuleError('INVALID_STATE', 'Only a draft session can be submitted', {
          session_status: s.status,
        });
      const settings = await readSettings(tx, c.tenantId, 'share');
      assertEditWindow(
        c.principal,
        settings,
        s,
        await schoolToday(tx, c.tenantId, this.deps.clock),
      );
      const eligible = await this.eligible(tx, s, true);
      if (!eligible.length)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'There are no students on this register, so it cannot be submitted',
          { reason: 'EMPTY_ROSTER' },
        );
      const marked = await tx
        .select({ studentId: attendanceRecords.studentId })
        .from(attendanceRecords)
        .where(
          and(eq(attendanceRecords.tenantId, c.tenantId), eq(attendanceRecords.sessionId, s.id)),
        )
        .for('update');
      const markedIds = new Set(marked.map((m) => m.studentId));
      const unmarked = eligible.filter((e) => !markedIds.has(e.studentId));
      if (unmarked.length)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          `${unmarked.length} student(s) have not been marked`,
          {
            reason: 'UNMARKED_STUDENTS',
            unmarked_count: unmarked.length,
            unmarked_student_ids: unmarked.slice(0, 100).map((u) => u.studentId),
          },
        );
      const now = this.deps.clock.now();
      const final = !settings.approvalRequired;
      await tx
        .update(attendanceSessions)
        .set({
          status: final ? 'FINAL' : 'SUBMITTED',
          submittedAt: now,
          submittedBy: c.actor.userId,
          finalizedAt: final ? now : null,
          rejectionReason: null,
          version: s.version + 1,
        })
        .where(and(eq(attendanceSessions.id, s.id), eq(attendanceSessions.tenantId, c.tenantId)));
      const base = this.eventBase(s, markedIds.size);
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'ATTENDANCE_SESSION_SUBMITTED',
        entityType: 'attendance_session',
        entityId: s.id,
        event: 'attendance.session_submitted',
        before: { status: s.status },
        after: { status: final ? 'FINAL' : 'SUBMITTED' },
        payload: { ...base, approval_required: settings.approvalRequired },
      });
      if (final)
        await recordChange(tx, c.actor, c.tenantId, {
          action: 'ATTENDANCE_SESSION_FINALIZED',
          entityType: 'attendance_session',
          entityId: s.id,
          event: 'attendance.session_finalized',
          before: { status: 'DRAFT' },
          after: { status: 'FINAL' },
          payload: { ...base, via: 'submit' },
        });
    });
    return this.get(c, id, 'attendance.mark');
  }

  /** SUBMITTED → FINAL. Needs `attendance.approve`. */
  async approve(c: Caller, id: string, version?: number) {
    await this.config.ensureDefaults(c.tenantId);
    await this.db.transaction(async (tx) => {
      const s = await this.loadSession(tx, c, id, 'attendance.approve', 'update');
      if (version !== undefined && version !== s.version) throw new ConflictError('CONFLICT');
      if (s.status !== 'SUBMITTED')
        throw new BusinessRuleError('INVALID_STATE', 'Only a submitted session can be approved', {
          session_status: s.status,
        });
      const now = this.deps.clock.now();
      await tx
        .update(attendanceSessions)
        .set({
          status: 'FINAL',
          approvedAt: now,
          approvedBy: c.actor.userId,
          finalizedAt: now,
          version: s.version + 1,
        })
        .where(and(eq(attendanceSessions.id, s.id), eq(attendanceSessions.tenantId, c.tenantId)));
      const base = this.eventBase(s);
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'ATTENDANCE_SESSION_APPROVED',
        entityType: 'attendance_session',
        entityId: s.id,
        event: 'attendance.session_approved',
        before: { status: 'SUBMITTED' },
        after: { status: 'FINAL' },
        payload: base,
      });
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'ATTENDANCE_SESSION_FINALIZED',
        entityType: 'attendance_session',
        entityId: s.id,
        event: 'attendance.session_finalized',
        before: { status: 'SUBMITTED' },
        after: { status: 'FINAL' },
        payload: { ...base, via: 'approve' },
      });
    });
    return this.get(c, id, 'attendance.approve');
  }

  /** SUBMITTED → DRAFT with a reason the recorder sees. Needs `attendance.approve`. */
  async reject(c: Caller, id: string, reason: string, version?: number) {
    await this.config.ensureDefaults(c.tenantId);
    await this.db.transaction(async (tx) => {
      const s = await this.loadSession(tx, c, id, 'attendance.approve', 'update');
      if (version !== undefined && version !== s.version) throw new ConflictError('CONFLICT');
      if (s.status !== 'SUBMITTED')
        throw new BusinessRuleError('INVALID_STATE', 'Only a submitted session can be rejected', {
          session_status: s.status,
        });
      await tx
        .update(attendanceSessions)
        .set({
          status: 'DRAFT',
          rejectedAt: this.deps.clock.now(),
          rejectedBy: c.actor.userId,
          rejectionReason: reason,
          version: s.version + 1,
        })
        .where(and(eq(attendanceSessions.id, s.id), eq(attendanceSessions.tenantId, c.tenantId)));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'ATTENDANCE_SESSION_REJECTED',
        entityType: 'attendance_session',
        entityId: s.id,
        event: 'attendance.session_rejected',
        before: { status: 'SUBMITTED' },
        after: { status: 'DRAFT' },
        reason,
        payload: { ...this.eventBase(s), reason },
      });
    });
    return this.get(c, id, 'attendance.approve');
  }

  /**
   * FINAL → DRAFT so the register can be edited again, with a reason. Refused while
   * corrections are pending on its records. Needs `attendance.approve`.
   */
  async reopen(c: Caller, id: string, reason: string, version?: number) {
    await this.config.ensureDefaults(c.tenantId);
    await this.db.transaction(async (tx) => {
      const s = await this.loadSession(tx, c, id, 'attendance.approve', 'update');
      if (version !== undefined && version !== s.version) throw new ConflictError('CONFLICT');
      if (s.status !== 'FINAL')
        throw new BusinessRuleError('INVALID_STATE', 'Only a final session can be reopened', {
          session_status: s.status,
        });
      const pending = await tx
        .select({ id: attendanceCorrections.id })
        .from(attendanceCorrections)
        .innerJoin(
          attendanceRecords,
          and(
            eq(attendanceRecords.tenantId, attendanceCorrections.tenantId),
            eq(attendanceRecords.id, attendanceCorrections.recordId),
          ),
        )
        .where(
          and(
            eq(attendanceCorrections.tenantId, c.tenantId),
            eq(attendanceRecords.sessionId, s.id),
            eq(attendanceCorrections.status, 'PENDING'),
          ),
        )
        .for('share');
      if (pending.length)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'Resolve the pending corrections of this session before reopening it',
          { reason: 'PENDING_CORRECTIONS', pending_count: pending.length },
        );
      await tx
        .update(attendanceSessions)
        .set({
          status: 'DRAFT',
          approvedAt: null,
          approvedBy: null,
          finalizedAt: null,
          reopenedAt: this.deps.clock.now(),
          reopenedBy: c.actor.userId,
          reopenReason: reason,
          version: s.version + 1,
        })
        .where(and(eq(attendanceSessions.id, s.id), eq(attendanceSessions.tenantId, c.tenantId)));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'ATTENDANCE_SESSION_REOPENED',
        entityType: 'attendance_session',
        entityId: s.id,
        event: 'attendance.session_reopened',
        before: { status: 'FINAL' },
        after: { status: 'DRAFT' },
        reason,
        payload: { ...this.eventBase(s), reason },
      });
    });
    return this.get(c, id, 'attendance.approve');
  }

  private eventBase(s: SessionRow, marked?: number) {
    return {
      attendance_type: s.attendanceType,
      academic_year_id: s.academicYearId,
      class_id: s.classId,
      section_id: s.sectionId,
      session_date: s.sessionDate,
      ...(marked !== undefined ? { marked_count: marked } : {}),
    };
  }
}
