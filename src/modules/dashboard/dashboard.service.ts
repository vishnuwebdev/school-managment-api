import { and, count, eq, inArray, sql } from 'drizzle-orm';
import type { Deps } from '../../container.js';
import {
  academicYears,
  admissions,
  attendanceSettings,
  studentChangeRequests,
} from '../../db/schema/index.js';
import { hasTenantWideScope } from '../access/authorization.service.js';
import type { ClassOverviewService } from '../academic/overview.service.js';
import type { ReportService } from '../attendance/reports.service.js';
import {
  addDaysIso,
  num,
  percentage,
  placementScope,
  rows,
  schoolToday,
  type Caller,
} from '../attendance/support.js';
import type { CalendarService } from '../calendar/calendar.service.js';
import type { ExamService } from '../exams/exams.service.js';
import type { LearnerFeesService } from '../fees/learner-fees.service.js';
import type { ParentRequestService } from '../parent-app/parent-requests.service.js';
import type { TeacherAttendanceService } from '../teachers/teacher-attendance.service.js';

/** How far back the attendance trend goes (calendar days; about a month of school days). */
const TREND_DAYS = 42;
/** How far ahead "coming up" looks. */
const EVENTS_DAYS = 45;

interface DashboardParts {
  attendanceReports: ReportService;
  learnerFees: LearnerFeesService;
  teacherAttendance: TeacherAttendanceService;
  exams: ExamService;
  parentRequests: ParentRequestService;
  classOverview: ClassOverviewService;
  calendar: CalendarService;
}

/**
 * The school admin's home page in one read: today's numbers, trends and what needs
 * attention. Every part is optional: it is left out (null) when the caller lacks the
 * permission or the school's plan lacks the feature, and a part that fails is logged
 * and left out instead of failing the page. Each part reuses the owning module's
 * service, so its scope rules apply unchanged.
 */
export class DashboardService {
  constructor(
    private readonly deps: Deps,
    private readonly s: DashboardParts,
  ) {}

  private get db() {
    return this.deps.db;
  }

  private can(c: Caller, permission: string, feature: string) {
    return c.principal.permissions.has(permission) && c.features.includes(feature);
  }

  private async part<T>(name: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (err) {
      this.deps.log.warn({ err, part: name }, 'dashboard part failed');
      return null;
    }
  }

  async school(c: Caller) {
    const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
    const [year] = await this.db
      .select()
      .from(academicYears)
      .where(and(eq(academicYears.tenantId, c.tenantId), eq(academicYears.isCurrent, true)));
    const wide = (p: string) => hasTenantWideScope(c.principal, p);

    const [attendance, fees, teachers, exams, parents, admissionsPart, classes, events] =
      await Promise.all([
        this.can(c, 'attendance.read', 'attendance')
          ? this.part('attendance', () => this.attendance(c, today))
          : null,
        this.can(c, 'fees.read', 'fees') && year
          ? this.part('fees', () => this.fees(c, today, year))
          : null,
        this.can(c, 'teachers.attendance.read', 'teachers.staff_attendance') &&
        wide('teachers.attendance.read')
          ? this.part('teachers', () => this.teachers(c, today))
          : null,
        this.can(c, 'exams.read', 'examinations') && wide('exams.read') && year
          ? this.part('exams', () => this.examsPart(c, today, year.id))
          : null,
        this.part('parents', () => this.parents(c)),
        this.can(c, 'students.admissions.read', 'students.admissions')
          ? this.part('admissions', () => this.admissionsWaiting(c))
          : null,
        this.can(c, 'academics.read', 'academics')
          ? this.part('classes', () => this.classes(c))
          : null,
        this.can(c, 'academics.read', 'academics')
          ? this.part('events', () => this.events(c, today))
          : null,
      ]);

    return {
      date: today,
      academic_year: year
        ? {
            id: year.id,
            code: year.code,
            name: year.name,
            start_date: year.startDate,
            end_date: year.endDate,
          }
        : null,
      attendance,
      fees,
      teachers,
      exams,
      parents,
      admissions: admissionsPart,
      classes,
      events,
    };
  }

  // ---- student attendance -----------------------------------------------------------

  private async attendance(c: Caller, today: string) {
    const [t, dayOff, settings] = await Promise.all([
      this.s.attendanceReports.today(c, {}),
      this.s.calendar.dayOff(c.tenantId, today, { kind: 'students' }),
      this.db
        .select({ threshold: attendanceSettings.defaulterThresholdPercent })
        .from(attendanceSettings)
        .where(eq(attendanceSettings.tenantId, c.tenantId)),
    ]);
    const yearId = t.academic_year?.id ?? null;
    const threshold = settings[0] ? Number(settings[0].threshold) : 75;
    const empty = {
      date: today,
      day_off: dayOff,
      threshold,
      today: t.totals,
      present_percent: null as number | null,
      not_started: [] as { section_id: string; label: string; session_id: string | null }[],
      in_progress: [] as { section_id: string; label: string; session_id: string | null }[],
      trend: [] as { date: string; percent: number | null; marked: number }[],
      by_class: [] as { class_id: string; name: string; percent: number | null; marked: number }[],
    };
    if (!yearId) return empty;

    const conds = [
      sql`r.tenant_id = ${c.tenantId}`,
      sql`s.attendance_type = 'DAILY'`,
      sql`s.academic_year_id = ${yearId}`,
      // Final registers count (the one percentage definition); today's submitted ones too, so
      // the dashboard shows the morning's picture before the office finalises.
      sql`(s.status = 'FINAL' or (s.status = 'SUBMITTED' and s.session_date = ${today}))`,
    ];
    const scope = placementScope(c.principal, 'attendance.read', {
      section: sql`s.section_id`,
      klass: sql`s.class_id`,
    });
    if (scope) conds.push(scope);
    const filter = sql.join(conds, sql` and `);

    const [trendRows, classRows] = await Promise.all([
      rows<{ d: string; marked: number; present: number }>(
        this.db,
        sql`select date_format(s.session_date, '%Y-%m-%d') as d, count(*) as marked,
          sum(r.present_weight) as present
        from attendance_records r
        join attendance_sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        where ${filter} and s.session_date between ${addDaysIso(today, -TREND_DAYS)} and ${today}
        group by s.session_date
        order by s.session_date`,
      ),
      rows<{ class_id: string; name: string; marked: number; present: number }>(
        this.db,
        sql`select cl.id as class_id, coalesce(cl.display_name, cl.name) as name,
          count(*) as marked, sum(r.present_weight) as present
        from attendance_records r
        join attendance_sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        join academic_classes cl on cl.tenant_id = s.tenant_id and cl.id = s.class_id
        where ${filter} and s.session_date = ${today}
        group by cl.id, cl.display_name, cl.name, cl.sequence
        order by cl.sequence, cl.name`,
      ),
    ]);
    const trend = trendRows.map((r) => ({
      date: r.d,
      percent: percentage(num(r.present), num(r.marked)),
      marked: num(r.marked),
    }));
    const label = (x: (typeof t.sections)[number]) =>
      x.section.name && x.section.name !== x.class.name
        ? `${x.class.name} · ${x.section.name}`
        : x.class.name;
    const pick = (state: string) =>
      t.sections
        .filter((x) => x.state === state)
        .map((x) => ({ section_id: String(x.section.id), label: label(x), session_id: x.session_id }));
    const todayPoint = trend.find((p) => p.date === today);
    return {
      ...empty,
      present_percent: todayPoint?.percent ?? null,
      not_started: pick('NOT_STARTED'),
      in_progress: pick('DRAFT'),
      trend,
      by_class: classRows.map((r) => ({
        class_id: r.class_id,
        name: r.name,
        percent: percentage(num(r.present), num(r.marked)),
        marked: num(r.marked),
      })),
    };
  }

  // ---- fees ---------------------------------------------------------------------------

  private async fees(
    c: Caller,
    today: string,
    year: { id: string; startDate: string; endDate: string },
  ) {
    const tracker = await this.s.learnerFees.tracker(c, { page: 1, page_size: 1 });
    // Month by month and pending payments are school-wide figures only.
    let monthly: { month: string; due: string; collected: string }[] | null = null;
    let pendingPayments: number | null = null;
    if (hasTenantWideScope(c.principal, 'fees.read')) {
      const to = today < year.endDate ? today : year.endDate;
      const [due, paid, pending] = await Promise.all([
        rows<{ m: string; amount: string }>(
          this.db,
          sql`select date_format(d.due_date, '%Y-%m') as m, sum(d.final_amount) as amount
          from fee_demands d
          where d.tenant_id = ${c.tenantId} and d.academic_year_id = ${year.id}
            and d.status not in ('DRAFT', 'CANCELLED') and d.due_date <= ${to}
          group by m order by m`,
        ),
        rows<{ m: string; amount: string }>(
          this.db,
          sql`select date_format(p.received_on, '%Y-%m') as m,
            sum(p.amount - p.refunded_amount) as amount
          from school_payments p
          where p.tenant_id = ${c.tenantId}
            and p.status in ('RECEIVED', 'VERIFIED', 'PARTIALLY_REFUNDED')
            and p.received_on between ${year.startDate} and ${to}
          group by m order by m`,
        ),
        rows<{ n: number }>(
          this.db,
          sql`select count(*) as n from school_payments p
          where p.tenant_id = ${c.tenantId} and p.status = 'PENDING'`,
        ),
      ]);
      const months: string[] = [];
      for (let m = year.startDate.slice(0, 7); m <= to.slice(0, 7); ) {
        months.push(m);
        const [y, mm] = m.split('-').map(Number) as [number, number];
        m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
      }
      const dueBy = new Map(due.map((r) => [r.m, String(r.amount ?? '0')]));
      const paidBy = new Map(paid.map((r) => [r.m, String(r.amount ?? '0')]));
      monthly = months.map((m) => ({
        month: m,
        due: Number(dueBy.get(m) ?? 0).toFixed(2),
        collected: Number(paidBy.get(m) ?? 0).toFixed(2),
      }));
      pendingPayments = num(pending[0]?.n);
    }
    return {
      currency: tracker.currency,
      totals: tracker.totals,
      counts: {
        overdue: tracker.counts.OVERDUE,
        part_paid: tracker.counts.PART_PAID,
        up_to_date: tracker.counts.UP_TO_DATE,
      },
      by_class: tracker.by_class,
      monthly,
      pending_payments: pendingPayments,
    };
  }

  // ---- teachers -------------------------------------------------------------------------

  private async teachers(c: Caller, today: string) {
    const r = await this.s.teacherAttendance.roster(c.tenantId, today, c.principal);
    const names = (f: (e: (typeof r.entries)[number]) => boolean) =>
      r.entries.filter(f).map((e) => e.full_name);
    return {
      date: today,
      day_off: r.day_off,
      summary: r.summary,
      absent: names((e) => e.status === 'ABSENT'),
      on_leave: names((e) => e.status === 'LEAVE' || (e.on_leave && e.status === null)),
    };
  }

  // ---- exams ---------------------------------------------------------------------------

  /** The office exam that is being marked right now (started, results not published). */
  private async examsPart(c: Caller, today: string, yearId: string) {
    const list = await this.s.exams.list(c.tenantId, { year_id: yearId });
    const marking = list
      .filter((e) => !e.by_teacher && e.stage === 'MARKING' && (!e.start_date || e.start_date <= today))
      .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''));
    const current = marking[0];
    if (!current) return { current: null, marking_count: 0 };
    const detail = await this.s.exams.get(c.tenantId, current.id);
    return {
      marking_count: marking.length,
      current: {
        id: detail.id,
        name: detail.name,
        start_date: detail.start_date,
        end_date: detail.end_date,
        papers: detail.papers,
        marks_expected: detail.marks_expected,
        marks_entered: detail.marks_entered,
        progress_percent: detail.progress_percent,
        classes: detail.class_progress.map((k) => ({
          class_id: k.class_id,
          name: k.class_name,
          marks_expected: k.marks_expected,
          marks_entered: k.marks_entered,
          progress_percent: k.progress_percent,
        })),
      },
    };
  }

  // ---- parents, admissions, classes, calendar ---------------------------------------------

  private async parents(c: Caller) {
    const messages = this.can(c, 'feedback.read', 'parent_portal')
      ? await this.s.parentRequests.summary(c.tenantId, c.principal)
      : null;
    let changeRequests: number | null = null;
    if (
      this.can(c, 'students.read', 'parent_portal') &&
      hasTenantWideScope(c.principal, 'students.read')
    ) {
      const [r] = await this.db
        .select({ n: count() })
        .from(studentChangeRequests)
        .where(
          and(
            eq(studentChangeRequests.tenantId, c.tenantId),
            eq(studentChangeRequests.status, 'PENDING'),
          ),
        );
      changeRequests = Number(r?.n ?? 0);
    }
    if (!messages && changeRequests === null) return null;
    return {
      unread_messages: messages?.unread ?? null,
      open_messages: messages?.open ?? null,
      open_complaints: messages ? (messages.by_kind.COMPLAINT?.open ?? 0) : null,
      change_requests_pending: changeRequests,
    };
  }

  private async admissionsWaiting(c: Caller) {
    const rs = await this.db
      .select({ status: admissions.status, n: count() })
      .from(admissions)
      .where(
        and(
          eq(admissions.tenantId, c.tenantId),
          inArray(admissions.status, ['SUBMITTED', 'UNDER_REVIEW']),
        ),
      )
      .groupBy(admissions.status);
    const n = (s: string) => Number(rs.find((r) => r.status === s)?.n ?? 0);
    return { submitted: n('SUBMITTED'), under_review: n('UNDER_REVIEW') };
  }

  private async classes(c: Caller) {
    const o = await this.s.classOverview.overview(c.tenantId, {});
    if (!o.totals) return null;
    return {
      totals: o.totals,
      without_class_teacher: o.attention
        .filter((a) => a.type === 'NO_CLASS_TEACHER')
        .map((a) => ({ class_id: a.class_id, section_id: a.section_id, text: a.text })),
    };
  }

  private async events(c: Caller, today: string) {
    const list = await this.s.calendar.listEvents(c.tenantId, {
      from: today,
      to: addDaysIso(today, EVENTS_DAYS),
    });
    return list
      .sort((a, b) => a.start_date.localeCompare(b.start_date))
      .slice(0, 6)
      .map((e) => ({
        id: e.id,
        title: e.title,
        start_date: e.start_date,
        end_date: e.end_date,
        category: e.category.name,
        color: e.category.color,
        closes_school: e.category.closes_school,
      }));
  }
}
