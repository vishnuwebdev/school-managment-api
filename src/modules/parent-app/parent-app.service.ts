import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Deps } from '../../container.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  attendanceRecords,
  attendanceSessions,
  attendanceStatuses,
  classClassTeachers,
  enrollments,
  examPapers,
  exams,
  feeDemands,
  feeReceipts,
  guardians,
  parentMessages,
  paymentAllocations,
  schoolPayments,
  sectionClassTeachers,
  students,
  studentGuardians,
  subjects,
  teachers,
  users,
} from '../../db/schema/index.js';
import type { Principal } from '../../platform/context.js';
import { AuthorizationError, NotFoundError } from '../../shared/errors.js';
import { fromMinor, toMinor } from '../fees/money.js';
import type { Caller } from '../attendance/support.js';
import { schoolToday } from '../attendance/support.js';
import type { ReportService } from '../attendance/reports.service.js';
import type { CalendarService } from '../calendar/calendar.service.js';
import { GRADE_SCALE, type ExamService } from '../exams/exams.service.js';
import type { ExamRemarkService } from '../exams/remarks.service.js';
import type { FeeDocumentService } from '../fees/documents.service.js';
import type { LearnerFeesService } from '../fees/learner-fees.service.js';
import type { FileService } from '../files/files.service.js';
import type { ChildPlacement, NoticeService } from '../notices/notices.service.js';
import type { PdfBranding } from '../students/certificates.pdf.js';
import type { SchoolSetupService } from '../tenants/school-setup.service.js';
import { fullName } from '../teachers/support.js';
import { renderFeeInvoice, renderReportCard } from './documents.pdf.js';

export const RangeQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
export const YearQuery = z.object({ academic_year_id: z.uuid().optional() });

/** The signed-in parent: their guardian record at this school. */
export interface Me {
  guardianId: string;
  guardian: typeof guardians.$inferSelect;
}

/** One child as the parent app needs it everywhere. */
export interface Child {
  id: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  preferredName: string | null;
  studentNumber: string;
  admissionNumber: string | null;
  dateOfBirth: string | null;
  admissionDate: string | null;
  gender: string;
  status: string;
  photoFileId: string | null;
  relationship: string;
  relationshipLabel: string | null;
  isPrimary: boolean;
  enrollment: {
    id: string;
    status: string;
    rollNumber: string | null;
    yearId: string;
    yearName: string;
    yearStatus: string;
    yearStart: string;
    yearEnd: string;
    classId: string;
    className: string;
    sectionId: string | null;
    sectionName: string | null;
  } | null;
}

const READS = ['students.read', 'attendance.read', 'exams.read', 'fees.read', 'academics.read'];

/**
 * Lets an existing admin service run for a parent. Every parent route first proves the
 * student is one of the parent's own linked children, then calls the service with the read
 * permissions it needs at school-wide scope, for that one student only.
 */
function asSchool(c: Caller): Caller {
  const scopes = { ...c.principal.scopes };
  for (const p of READS) scopes[p] = [{ type: 'ALL_TENANT', ref: null }];
  return {
    ...c,
    principal: {
      ...c.principal,
      permissions: new Set([...c.principal.permissions, ...READS]),
      scopes,
    },
  };
}

const RELATION_LABEL: Record<string, string> = {
  FATHER: 'Father',
  MOTHER: 'Mother',
  GUARDIAN: 'Guardian',
  PARENT: 'Parent',
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const minIso = (a: string, b: string) => (a < b ? a : b);
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return iso(t);
};

/**
 * Screen-shaped reads for the parent app (/api/v1/parent/*). A parent sees only the children
 * they are linked to with app access allowed; everything else composes the services the admin
 * panel and the teacher app already use, so business rules live in one place.
 */
export class ParentAppService {
  constructor(
    private readonly deps: Deps,
    private readonly s: {
      attendanceReports: ReportService;
      calendar: CalendarService;
      exams: ExamService;
      remarks: ExamRemarkService;
      learnerFees: LearnerFeesService;
      feeDocuments: FeeDocumentService;
      schoolSetup: SchoolSetupService;
      files: FileService;
      notices: NoticeService;
    },
  ) {}

  private get db() {
    return this.deps.db;
  }

  // ---- who and which children -------------------------------------------------------------

  async me(tenantId: string, principal: Principal): Promise<Me> {
    const [g] = await this.db
      .select()
      .from(guardians)
      .where(
        and(
          eq(guardians.tenantId, tenantId),
          eq(guardians.userId, principal.userId),
          eq(guardians.status, 'ACTIVE'),
        ),
      );
    if (!g)
      throw new AuthorizationError(
        'NOT_A_PARENT',
        'The parent app is only for parents. Your account isn’t linked to a guardian at this school.',
      );
    return { guardianId: g.id, guardian: g };
  }

  async children(tenantId: string, guardianId: string): Promise<Child[]> {
    const today = await schoolToday(this.db, tenantId, this.deps.clock);
    const links = await this.db
      .select({ l: studentGuardians, s: students })
      .from(studentGuardians)
      .innerJoin(
        students,
        and(
          eq(students.tenantId, studentGuardians.tenantId),
          eq(students.id, studentGuardians.studentId),
        ),
      )
      .where(
        and(
          eq(studentGuardians.tenantId, tenantId),
          eq(studentGuardians.guardianId, guardianId),
          eq(studentGuardians.status, 'ACTIVE'),
          eq(studentGuardians.portalAccessAllowed, true),
          or(isNull(studentGuardians.effectiveUntil), gte(studentGuardians.effectiveUntil, today)),
          ne(students.status, 'ARCHIVED'),
        ),
      )
      .orderBy(asc(students.dateOfBirth), asc(students.firstName));
    if (!links.length) return [];
    const ids = links.map((x) => x.s.id);
    const ens = await this.db
      .select({
        e: enrollments,
        y: academicYears,
        className: academicClasses.name,
        sectionName: academicSections.name,
      })
      .from(enrollments)
      .innerJoin(academicYears, eq(academicYears.id, enrollments.academicYearId))
      .innerJoin(academicClasses, eq(academicClasses.id, enrollments.classId))
      .leftJoin(academicSections, eq(academicSections.id, enrollments.sectionId))
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          inArray(enrollments.studentId, ids),
          ne(enrollments.status, 'CANCELLED'),
        ),
      )
      .orderBy(desc(enrollments.startDate));
    // The open enrollment of the current year first, then the latest one.
    const rank = (r: (typeof ens)[number]) =>
      (['PENDING', 'ACTIVE'].includes(r.e.status) ? 0 : 2) + (r.y.status === 'ACTIVE' ? 0 : 1);
    const best = new Map<string, (typeof ens)[number]>();
    for (const r of ens) {
      const cur = best.get(r.e.studentId);
      if (!cur || rank(r) < rank(cur)) best.set(r.e.studentId, r);
    }
    return links.map(({ l, s }) => {
      const r = best.get(s.id);
      return {
        id: s.id,
        firstName: s.firstName,
        middleName: s.middleName,
        lastName: s.lastName,
        preferredName: s.preferredName,
        studentNumber: s.studentNumber,
        admissionNumber: s.admissionNumber,
        dateOfBirth: s.dateOfBirth,
        admissionDate: s.admissionDate,
        gender: s.gender,
        status: s.status,
        photoFileId: s.photoFileId,
        relationship: l.relationshipType,
        relationshipLabel: l.relationshipLabel,
        isPrimary: l.isPrimary,
        enrollment: r
          ? {
              id: r.e.id,
              status: r.e.status,
              rollNumber: r.e.rollNumber,
              yearId: r.y.id,
              yearName: r.y.name,
              yearStatus: r.y.status,
              yearStart: r.y.startDate,
              yearEnd: r.y.endDate,
              classId: r.e.classId,
              className: r.className,
              sectionId: r.e.sectionId,
              sectionName: r.sectionName,
            }
          : null,
      };
    });
  }

  /** One of my children, or 404 (another family's child looks like a missing one). */
  async child(tenantId: string, me: Me, studentId: string): Promise<Child> {
    const c = (await this.children(tenantId, me.guardianId)).find((x) => x.id === studentId);
    if (!c) throw new NotFoundError('Student');
    return c;
  }

  placements(children: Child[]): ChildPlacement[] {
    return children.map((c) => ({
      studentId: c.id,
      firstName: c.preferredName ?? c.firstName,
      classId: c.enrollment?.classId ?? null,
      sectionId: c.enrollment?.sectionId ?? null,
    }));
  }

  private presentChild(c: Child) {
    const e = c.enrollment;
    return {
      id: c.id,
      first_name: c.firstName,
      middle_name: c.middleName,
      last_name: c.lastName,
      preferred_name: c.preferredName,
      full_name: fullName(c),
      admission_number: c.admissionNumber ?? c.studentNumber,
      student_number: c.studentNumber,
      roll_number: e?.rollNumber ?? null,
      class: e ? { id: e.classId, name: e.className } : null,
      section: e?.sectionId ? { id: e.sectionId, name: e.sectionName } : null,
      academic_year: e
        ? { id: e.yearId, name: e.yearName, start_date: e.yearStart, end_date: e.yearEnd }
        : null,
      enrollment_status: e?.status ?? null,
      relationship: c.relationshipLabel ?? RELATION_LABEL[c.relationship] ?? c.relationship,
      is_primary_guardian: c.isPrimary,
      has_photo: !!c.photoFileId,
    };
  }

  private async branding(
    tenantId: string,
  ): Promise<PdfBranding & { raw: Awaited<ReturnType<SchoolSetupService['documentBranding']>> }> {
    const b = await this.s.schoolSetup.documentBranding(tenantId);
    let logo: { bytes: Buffer; mime: string } | null = null;
    if (b.logo_file_id) {
      const f = await this.s.files.read(tenantId, b.logo_file_id).catch(() => null);
      if (f) logo = { bytes: f.data, mime: f.mime };
    }
    return {
      raw: b,
      school_name: b.school_name,
      address: [b.address.line1, b.address.line2, b.address.city, b.address.postal_code]
        .filter(Boolean)
        .join(', '),
      contact: [b.phone, b.email].filter(Boolean).join('  ·  '),
      footer_text: b.footer_text,
      primary_color: b.primary_color,
      logo,
    };
  }

  // ---- account ------------------------------------------------------------------------------

  async account(tenantId: string, principal: Principal) {
    const me = await this.me(tenantId, principal);
    const [kids, b, [u]] = await Promise.all([
      this.children(tenantId, me.guardianId),
      this.s.schoolSetup.documentBranding(tenantId),
      this.db
        .select({ email: users.email, loginPhone: users.loginPhone })
        .from(users)
        .where(eq(users.id, principal.userId)),
    ]);
    const g = me.guardian;
    const name = b.school_name;
    return {
      parent: {
        guardian_id: g.id,
        first_name: g.firstName,
        last_name: g.lastName,
        full_name: [g.firstName, g.middleName, g.lastName].filter(Boolean).join(' '),
        email: u && !u.email.endsWith('@parents.invalid') ? u.email : g.email,
        mobile: g.phone ?? (u?.loginPhone ? `+${u.loginPhone}` : null),
        preferred_language: g.preferredLanguage,
      },
      school: {
        name,
        short_name: b.short_name,
        initials: name
          .split(/\s+/)
          .filter((w) => /^[A-Za-z]/.test(w))
          .slice(0, 2)
          .map((w) => w[0]!.toUpperCase())
          .join(''),
        office_phone: b.phone,
        email: b.email,
        primary_color: b.primary_color,
        has_logo: !!b.logo_file_id,
      },
      children: kids.map((c) => this.presentChild(c)),
    };
  }

  async schoolLogo(tenantId: string, principal: Principal) {
    await this.me(tenantId, principal);
    const b = await this.s.schoolSetup.documentBranding(tenantId);
    if (!b.logo_file_id) throw new NotFoundError('Logo');
    return this.s.files.read(tenantId, b.logo_file_id);
  }

  async photo(tenantId: string, principal: Principal, studentId: string) {
    const c = await this.child(tenantId, await this.me(tenantId, principal), studentId);
    if (!c.photoFileId) throw new NotFoundError('Photo');
    return this.s.files.read(tenantId, c.photoFileId);
  }

  async profile(tenantId: string, principal: Principal, studentId: string) {
    const me = await this.me(tenantId, principal);
    const c = await this.child(tenantId, me, studentId);
    const e = c.enrollment;
    let classTeacher: string | null = null;
    if (e) {
      const [st] = e.sectionId
        ? await this.db
            .select({ t: teachers })
            .from(sectionClassTeachers)
            .innerJoin(teachers, eq(teachers.id, sectionClassTeachers.teacherId))
            .where(
              and(
                eq(sectionClassTeachers.tenantId, tenantId),
                eq(sectionClassTeachers.sectionId, e.sectionId),
                eq(sectionClassTeachers.status, 'ACTIVE'),
              ),
            )
        : [];
      const [ct] = st
        ? [st]
        : await this.db
            .select({ t: teachers })
            .from(classClassTeachers)
            .innerJoin(teachers, eq(teachers.id, classClassTeachers.teacherId))
            .where(
              and(
                eq(classClassTeachers.tenantId, tenantId),
                eq(classClassTeachers.classId, e.classId),
                eq(classClassTeachers.academicYearId, e.yearId),
                eq(classClassTeachers.status, 'ACTIVE'),
              ),
            );
      classTeacher = ct ? fullName(ct.t) : null;
    }
    const gs = await this.db
      .select({ l: studentGuardians, g: guardians })
      .from(studentGuardians)
      .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
      .where(
        and(
          eq(studentGuardians.tenantId, tenantId),
          eq(studentGuardians.studentId, c.id),
          eq(studentGuardians.status, 'ACTIVE'),
        ),
      )
      .orderBy(desc(studentGuardians.isPrimary));
    return {
      ...this.presentChild(c),
      date_of_birth: c.dateOfBirth,
      admitted_on: c.admissionDate,
      gender: c.gender,
      status: c.status,
      class_teacher: classTeacher,
      guardians: gs.map(({ l, g }) => ({
        name: [g.firstName, g.middleName, g.lastName].filter(Boolean).join(' '),
        relationship:
          l.relationshipLabel ?? RELATION_LABEL[l.relationshipType] ?? l.relationshipType,
        is_primary: l.isPrimary,
        is_you: g.id === me.guardianId,
      })),
    };
  }

  // ---- attendance and calendar --------------------------------------------------------------

  /** Today's daily register for the child, once the teacher has submitted it. */
  private async today(tenantId: string, c: Child, today: string) {
    if (!c.enrollment) return { date: today, status: null, marked_at: null, marked_by: null };
    const [r] = await this.db
      .select({
        code: attendanceStatuses.code,
        name: attendanceStatuses.name,
        category: attendanceStatuses.category,
        markedAt: attendanceRecords.markedAt,
        remarks: attendanceRecords.remarks,
        first: users.firstName,
        last: users.lastName,
        sessionStatus: attendanceSessions.status,
      })
      .from(attendanceRecords)
      .innerJoin(
        attendanceSessions,
        and(
          eq(attendanceSessions.tenantId, attendanceRecords.tenantId),
          eq(attendanceSessions.id, attendanceRecords.sessionId),
        ),
      )
      .innerJoin(
        attendanceStatuses,
        and(
          eq(attendanceStatuses.tenantId, attendanceRecords.tenantId),
          eq(attendanceStatuses.id, attendanceRecords.statusId),
        ),
      )
      .leftJoin(users, eq(users.id, attendanceRecords.markedBy))
      .where(
        and(
          eq(attendanceRecords.tenantId, tenantId),
          eq(attendanceRecords.studentId, c.id),
          eq(attendanceSessions.attendanceType, 'DAILY'),
          eq(attendanceSessions.sessionDate, today),
          inArray(attendanceSessions.status, ['SUBMITTED', 'FINAL']),
        ),
      )
      .limit(1);
    return {
      date: today,
      status: r ? { code: r.code, name: r.name, category: r.category } : null,
      remarks: r?.remarks ?? null,
      marked_at: r?.markedAt.toISOString() ?? null,
      marked_by: r?.first ? `${r.first} ${r.last}`.trim() : null,
      register_final: r ? r.sessionStatus === 'FINAL' : false,
    };
  }

  /**
   * Attendance for a date range (default: the school year so far): day-by-day statuses,
   * totals, today's mark and the child's off days (weekends, holidays) for the calendar.
   */
  async attendance(c0: Caller, studentId: string, q: z.infer<typeof RangeQuery>) {
    const me = await this.me(c0.tenantId, c0.principal);
    const c = await this.child(c0.tenantId, me, studentId);
    const today = await schoolToday(this.db, c0.tenantId, this.deps.clock);
    const e = c.enrollment;
    const from = q.from ?? (e ? e.yearStart : addDays(today, -30));
    const to = q.to ?? (e ? minIso(today, e.yearEnd) : today);
    const [history, todayMark, cal] = await Promise.all([
      this.s.attendanceReports.studentHistory(asSchool(c0), c.id, { from, to }),
      this.today(c0.tenantId, c, today),
      e
        ? this.s.calendar.calendarView(c0.tenantId, from, to, {
            kind: 'class',
            classId: e.classId,
            sectionId: e.sectionId ?? undefined,
          })
        : null,
    ]);
    return {
      student_id: c.id,
      period: { from, to },
      today: todayMark,
      summary: history.summary,
      days: history.records.map((r) => ({
        date: r.session_date,
        status: r.status,
        present_weight: r.present_weight,
        remarks: r.remarks,
      })),
      off_days: cal?.off_days ?? [],
      weekly_off_days: cal?.weekly_off_days ?? [],
      off_saturdays: cal?.off_saturdays ?? [],
    };
  }

  /** School calendar for the child: off days plus events for everyone, all students or their class. */
  async calendar(c0: Caller, studentId: string, q: z.infer<typeof RangeQuery>) {
    const me = await this.me(c0.tenantId, c0.principal);
    const c = await this.child(c0.tenantId, me, studentId);
    const today = await schoolToday(this.db, c0.tenantId, this.deps.clock);
    const from = q.from ?? today;
    const to = q.to ?? addDays(from, 60);
    const e = c.enrollment;
    const [view, events] = await Promise.all([
      this.s.calendar.calendarView(
        c0.tenantId,
        from,
        to,
        e
          ? { kind: 'class', classId: e.classId, sectionId: e.sectionId ?? undefined }
          : { kind: 'students' },
      ),
      this.s.calendar.listEvents(c0.tenantId, { from, to, include_cancelled: false }),
    ]);
    const mine = events.filter(
      (ev) =>
        !ev.category.closes_school &&
        (ev.audience === 'ALL' ||
          ev.audience === 'STUDENTS' ||
          (ev.audience === 'CLASSES' && !!e && ev.class_ids.includes(e.classId)) ||
          (ev.audience === 'SECTIONS' && !!e?.sectionId && ev.section_ids.includes(e.sectionId))),
    );
    return {
      period: { from, to },
      weekly_off_days: view.weekly_off_days,
      off_saturdays: view.off_saturdays,
      off_days: view.off_days,
      events: mine.map((ev) => ({
        id: ev.id,
        title: ev.title,
        category: ev.category.name,
        color: ev.category.color,
        start_date: ev.start_date,
        end_date: ev.end_date,
        start_time: ev.start_time,
        end_time: ev.end_time,
        description: ev.description,
      })),
    };
  }

  // ---- results --------------------------------------------------------------------------------

  private async results(tenantId: string, c: Child) {
    const list = await this.s.exams.forStudent(tenantId, c.id);
    const remarks = await this.s.remarks.sharedForStudent(
      tenantId,
      c.id,
      list.map((x) => x.exam_id),
    );
    const now = this.deps.clock.now().getTime();
    return list.map((x) => ({
      ...x,
      is_new: !!x.published_at && now - new Date(x.published_at).getTime() < 14 * 86400000,
      remark: remarks.get(x.exam_id)?.remark ?? null,
      remark_by: remarks.get(x.exam_id)?.by ?? null,
    }));
  }

  async exams(c0: Caller, studentId: string) {
    const me = await this.me(c0.tenantId, c0.principal);
    const c = await this.child(c0.tenantId, me, studentId);
    return {
      student_id: c.id,
      grading_scale: GRADE_SCALE,
      exams: await this.results(c0.tenantId, c),
      upcoming: await this.upcomingFor(c0.tenantId, c),
    };
  }

  async reportCard(c0: Caller, studentId: string, examId: string) {
    const me = await this.me(c0.tenantId, c0.principal);
    const c = await this.child(c0.tenantId, me, studentId);
    const r = (await this.results(c0.tenantId, c)).find((x) => x.exam_id === examId);
    if (!r) throw new NotFoundError('Exam');
    return { student: this.presentChild(c), grading_scale: GRADE_SCALE, ...r };
  }

  async reportCardPdf(c0: Caller, studentId: string, examId: string) {
    const card = await this.reportCard(c0, studentId, examId);
    const b = await this.branding(c0.tenantId);
    const [y] = await this.db
      .select({ name: academicYears.name })
      .from(exams)
      .innerJoin(academicYears, eq(academicYears.id, exams.academicYearId))
      .where(and(eq(exams.tenantId, c0.tenantId), eq(exams.id, examId)));
    const st = card.student;
    const data = await renderReportCard({
      branding: b,
      exam_name: card.exam_name,
      academic_year: y?.name ?? null,
      published_on: card.published_at?.slice(0, 10) ?? null,
      student_name: st.full_name,
      admission_number: st.admission_number,
      class_label: [st.class?.name, st.section?.name].filter(Boolean).join(' · ') || '-',
      roll_number: st.roll_number,
      subjects: card.subjects,
      total: card.total,
      max_total: card.max_total,
      percentage: card.percentage,
      grade: card.grade,
      result: card.result,
      rank: card.rank,
      class_size: card.class_size,
      class_average: card.class_average,
      remark: card.remark ? { text: card.remark, by: card.remark_by } : null,
      generated_on: iso(this.deps.clock.now()),
    });
    const safeName = `${st.full_name}-${card.exam_name}`
      .replace(/[^\w\- ]+/g, '')
      .replace(/\s+/g, '-');
    return { data, filename: `Report-card-${safeName}.pdf` };
  }

  /**
   * Exams coming up for the child: not yet published, set for the child's class (and section,
   * for a teacher's own test), with at least one paper dated today or later. Dated papers are
   * the datesheet; an exam without dates is not shown yet.
   */
  private async upcomingFor(tenantId: string, c: Child) {
    const e = c.enrollment;
    if (!e) return [];
    const today = await schoolToday(this.db, tenantId, this.deps.clock);
    const rows = await this.db
      .select({
        exam: exams,
        paperId: examPapers.id,
        subject: subjects.name,
        date: examPapers.examDate,
        start: examPapers.startTime,
        end: examPapers.endTime,
        max: examPapers.maxMarks,
      })
      .from(examPapers)
      .innerJoin(
        exams,
        and(eq(exams.tenantId, examPapers.tenantId), eq(exams.id, examPapers.examId)),
      )
      .innerJoin(subjects, eq(subjects.id, examPapers.subjectId))
      .where(
        and(
          eq(examPapers.tenantId, tenantId),
          eq(examPapers.classId, e.classId),
          eq(exams.academicYearId, e.yearId),
          eq(exams.status, 'DRAFT'),
          e.sectionId
            ? or(isNull(exams.sectionId), eq(exams.sectionId, e.sectionId))
            : isNull(exams.sectionId),
        ),
      )
      .orderBy(asc(examPapers.examDate), asc(examPapers.startTime));
    const byExam = new Map<
      string,
      { exam: (typeof rows)[number]['exam']; papers: (typeof rows)[number][] }
    >();
    for (const r of rows) {
      const g = byExam.get(r.exam.id) ?? { exam: r.exam, papers: [] };
      g.papers.push(r);
      byExam.set(r.exam.id, g);
    }
    const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);
    return [...byExam.values()]
      .filter((g) => g.papers.some((p) => p.date && p.date >= today))
      .map((g) => {
        const dated = g.papers.filter((p) => p.date).map((p) => p.date!);
        return {
          exam_id: g.exam.id,
          name: g.exam.name,
          exam_type: g.exam.examType,
          start_date: dated[0] ?? g.exam.startDate,
          end_date: dated[dated.length - 1] ?? g.exam.endDate,
          papers_count: g.papers.length,
          datesheet: g.papers.map((p) => ({
            subject_name: p.subject,
            date: p.date,
            start_time: hhmm(p.start),
            end_time: hhmm(p.end),
            max_marks: Number(p.max),
          })),
        };
      })
      .sort((a, b) => String(a.start_date ?? '').localeCompare(String(b.start_date ?? '')));
  }

  // ---- fees ------------------------------------------------------------------------------------

  /** The learner fee account (same as the admin panel), without the plan-change options. */
  async fees(c0: Caller, studentId: string, q: z.infer<typeof YearQuery>) {
    const me = await this.me(c0.tenantId, c0.principal);
    const c = await this.child(c0.tenantId, me, studentId);
    const acc = await this.s.learnerFees.account(asSchool(c0), c.id, q.academic_year_id);
    const { plan_options, ...rest } = acc;
    void plan_options;
    const withPdf = <T extends { id: string }>(l: T) => ({
      ...l,
      invoice_pdf: `/api/v1/parent/children/${c.id}/fees/invoices/${l.id}/pdf`,
    });
    return {
      ...rest,
      instalments: rest.instalments.map(withPdf),
      charges: rest.charges.map(withPdf),
      payments: rest.payments
        .filter((p) => p.status !== 'CANCELLED' && p.status !== 'FAILED')
        .map((p) => ({
          ...p,
          receipt_pdf: p.receipt_id ? `/api/v1/parent/receipts/${p.receipt_id}/pdf` : null,
        })),
    };
  }

  async receiptPdf(c0: Caller, receiptId: string) {
    const me = await this.me(c0.tenantId, c0.principal);
    const [r] = await this.db
      .select({ studentId: feeReceipts.studentId })
      .from(feeReceipts)
      .where(and(eq(feeReceipts.tenantId, c0.tenantId), eq(feeReceipts.id, receiptId)));
    if (!r) throw new NotFoundError('Receipt');
    await this.child(c0.tenantId, me, r.studentId);
    return this.s.feeDocuments.receiptPdf(asSchool(c0), receiptId);
  }

  /** Invoice PDF for one instalment or charge: billed, discounts, payments, balance. */
  async invoicePdf(c0: Caller, studentId: string, demandId: string) {
    const me = await this.me(c0.tenantId, c0.principal);
    const c = await this.child(c0.tenantId, me, studentId);
    const [d] = await this.db
      .select({ d: feeDemands, yearName: academicYears.name })
      .from(feeDemands)
      .leftJoin(academicYears, eq(academicYears.id, feeDemands.academicYearId))
      .where(
        and(
          eq(feeDemands.tenantId, c0.tenantId),
          eq(feeDemands.id, demandId),
          eq(feeDemands.studentId, c.id),
          sql`${feeDemands.status} not in ('DRAFT','CANCELLED')`,
        ),
      );
    if (!d) throw new NotFoundError('Invoice');
    const allocs = await this.db
      .select({
        a: paymentAllocations,
        p: schoolPayments,
        receiptNumber: feeReceipts.receiptNumber,
      })
      .from(paymentAllocations)
      .innerJoin(
        schoolPayments,
        and(
          eq(schoolPayments.tenantId, paymentAllocations.tenantId),
          eq(schoolPayments.id, paymentAllocations.paymentId),
        ),
      )
      .leftJoin(
        feeReceipts,
        and(
          eq(feeReceipts.tenantId, schoolPayments.tenantId),
          eq(feeReceipts.paymentId, schoolPayments.id),
          eq(feeReceipts.status, 'ISSUED'),
        ),
      )
      .where(
        and(
          eq(paymentAllocations.tenantId, c0.tenantId),
          eq(paymentAllocations.feeDemandId, d.d.id),
        ),
      )
      .orderBy(asc(schoolPayments.receivedOn));
    const today = await schoolToday(this.db, c0.tenantId, this.deps.clock);
    const m = (v: string) => toMinor(v);
    const outstanding = m(d.d.finalAmount) - m(d.d.paidAmount) - m(d.d.writtenOffAmount);
    const status =
      d.d.status === 'WAIVED' || d.d.status === 'WRITTEN_OFF' || d.d.status === 'PAID'
        ? d.d.status
        : outstanding <= 0n
          ? 'PAID'
          : d.d.dueDate < today
            ? 'OVERDUE'
            : m(d.d.paidAmount) > 0n
              ? 'PARTIALLY_PAID'
              : 'ISSUED';
    const METHOD: Record<string, string> = {
      CASH: 'Cash',
      BANK_TRANSFER: 'Bank transfer',
      CHEQUE: 'Cheque',
      CARD: 'Card',
      OTHER: 'Other',
    };
    const e = c.enrollment;
    const data = await renderFeeInvoice({
      branding: await this.branding(c0.tenantId),
      demand_number: d.d.demandNumber,
      label: d.d.periodLabel,
      description: d.d.description,
      academic_year: d.yearName ?? null,
      issued_on: d.d.issuedAt ? iso(d.d.issuedAt) : null,
      due_date: d.d.dueDate,
      status,
      currency: d.d.currency,
      student_name: fullName(c),
      admission_number: c.admissionNumber ?? c.studentNumber,
      class_label: e ? [e.className, e.sectionName].filter(Boolean).join(' · ') : null,
      original_amount: d.d.originalAmount,
      discount_amount: d.d.discountAmount,
      concession_amount: d.d.concessionAmount,
      waiver_amount: d.d.waiverAmount,
      late_fee_amount: d.d.lateFeeAmount,
      final_amount: d.d.finalAmount,
      paid_amount: d.d.paidAmount,
      written_off_amount: d.d.writtenOffAmount,
      outstanding_amount: fromMinor(outstanding > 0n ? outstanding : 0n),
      payments: allocs
        .map(({ a, p, receiptNumber }) => ({
          net: m(a.allocatedAmount) - m(a.reversedAmount),
          date: p.receivedOn,
          receipt_number: receiptNumber,
          method: METHOD[p.method] ?? p.method,
        }))
        .filter((x) => x.net > 0n)
        .map(({ net, ...x }) => ({ ...x, amount: fromMinor(net) })),
      generated_on: iso(this.deps.clock.now()),
    });
    return { data, filename: `${d.d.demandNumber}.pdf` };
  }

  // ---- notices and home ------------------------------------------------------------------------

  async noticeScope(tenantId: string, principal: Principal) {
    const me = await this.me(tenantId, principal);
    const kids = await this.children(tenantId, me.guardianId);
    return { me, children: this.placements(kids) };
  }

  /**
   * Everything the Home screen shows, per child: today's attendance, attendance so far this
   * year, the latest result, the next exam, the next fee due; plus unread notices and what is
   * coming up (dated notices, school events and exams).
   */
  async home(c0: Caller) {
    const me = await this.me(c0.tenantId, c0.principal);
    const kids = await this.children(c0.tenantId, me.guardianId);
    const today = await schoolToday(this.db, c0.tenantId, this.deps.clock);
    const features = new Set(c0.features);
    const placements = this.placements(kids);
    const perChild = await Promise.all(
      kids.map(async (c) => {
        const e = c.enrollment;
        const [todayMark, history, results, upcoming, fees] = await Promise.all([
          features.has('attendance') ? this.today(c0.tenantId, c, today) : null,
          features.has('attendance') && e
            ? this.s.attendanceReports
                .studentHistory(asSchool(c0), c.id, {
                  from: e.yearStart,
                  to: minIso(today, e.yearEnd),
                })
                .catch(() => null)
            : null,
          features.has('examinations') ? this.results(c0.tenantId, c) : [],
          features.has('examinations') ? this.upcomingFor(c0.tenantId, c) : [],
          features.has('fees')
            ? this.s.learnerFees.account(asSchool(c0), c.id).catch(() => null)
            : null,
        ]);
        const latest = results[0];
        return {
          child: this.presentChild(c),
          attendance: features.has('attendance')
            ? {
                today: todayMark,
                session_percentage: history?.summary.percentage ?? null,
                session_marked_days: history?.summary.marked_count ?? 0,
              }
            : null,
          last_exam: latest
            ? {
                exam_id: latest.exam_id,
                name: latest.exam_name,
                percentage: latest.percentage,
                grade: latest.grade,
                rank: latest.rank,
                class_size: latest.class_size,
                is_new: latest.is_new,
              }
            : null,
          next_exam: upcoming[0]
            ? {
                exam_id: upcoming[0].exam_id,
                name: upcoming[0].name,
                start_date: upcoming[0].start_date,
                papers_count: upcoming[0].papers_count,
              }
            : null,
          fees: fees
            ? {
                currency: fees.currency,
                owing_now: fees.totals.owing_now,
                paid_percent: fees.totals.paid_percent,
                next_instalment: fees.next_instalment,
                status: fees.status,
              }
            : null,
        };
      }),
    );
    const noticesOn = features.has('communication');
    const [unread, noticeEvents, calendars] = await Promise.all([
      noticesOn
        ? this.s.notices
            .parentList(c0.tenantId, me.guardianId, placements, {
              page: 1,
              page_size: 1,
              order: 'desc',
              unread: true,
            })
            .then((r) => r.meta.unread)
        : 0,
      noticesOn ? this.s.notices.upcomingEvents(c0.tenantId, placements, today) : [],
      Promise.all(
        kids.map((c) =>
          this.calendar(c0, c.id, { from: today, to: addDays(today, 30) })
            .then((cal) =>
              cal.events.map((ev) => ({ ...ev, child: { id: c.id, first_name: c.firstName } })),
            )
            .catch(() => []),
        ),
      ),
    ]);
    const events = new Map<
      string,
      { date: string; title: string; subtitle: string; event_id: string }
    >();
    for (const ev of calendars.flat())
      if (!events.has(ev.id))
        events.set(ev.id, {
          date: ev.start_date,
          title: ev.title,
          subtitle: ev.category ?? '',
          event_id: ev.id,
        });
    const comingUp = [
      ...noticeEvents.map((n) => ({ kind: 'NOTICE' as const, ...n })),
      ...[...events.values()].map((ev) => ({ kind: 'EVENT' as const, ...ev })),
      ...perChild
        .filter((p) => p.next_exam?.start_date && p.next_exam.start_date >= today)
        .map((p) => ({
          kind: 'EXAM' as const,
          date: p.next_exam!.start_date!,
          title: `${p.next_exam!.name} begins`,
          subtitle: `${p.next_exam!.papers_count} papers · datesheet available`,
          exam_id: p.next_exam!.exam_id,
          children: [{ id: p.child.id, first_name: p.child.first_name }],
        })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    // Complaints / feedback the school answered since the parent last looked.
    const [{ n: unreadMessages } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(parentMessages)
      .where(
        and(
          eq(parentMessages.tenantId, c0.tenantId),
          eq(parentMessages.guardianId, me.guardianId),
          eq(parentMessages.unreadByParent, true),
        ),
      );
    return {
      today,
      unread_notices: unread,
      unread_messages: Number(unreadMessages),
      children: perChild,
      coming_up: comingUp.slice(0, 15),
    };
  }
}
