import type { Request } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import { PaginationQuery } from '../../shared/pagination.js';
import {
  MarkAllBody,
  SaveRecordsBody,
  SessionCommandBody,
  StudentHistoryQuery,
} from '../attendance/attendance.schemas.js';
import type { AttendanceConfigService } from '../attendance/config.service.js';
import type { ReportService } from '../attendance/reports.service.js';
import type { SessionService } from '../attendance/sessions.service.js';
import { schoolToday, type Caller } from '../attendance/support.js';
import { HolidayListQuery } from '../calendar/calendar.schemas.js';
import type { CalendarService } from '../calendar/calendar.service.js';
import type { ExamService } from '../exams/exams.service.js';
import type { EnrollmentService } from '../students/enrollments.service.js';
import type { GuardianService } from '../students/guardians.service.js';
import type { StudentService } from '../students/students.service.js';
import type { AssignmentService } from '../teachers/assignments.service.js';
import {
  AttendanceMonthQuery,
  CancelLeaveBody,
  CreateLeaveBody,
  LeaveListQuery,
} from '../teachers/leave.schemas.js';
import type { LeaveService } from '../teachers/leave.service.js';
import type { QualificationService } from '../teachers/qualifications.service.js';
import type { StaffAttendanceService } from '../teachers/staff-attendance.service.js';
import type { TeacherService } from '../teachers/teachers.service.js';
import type { ViewService } from '../timetable/views.service.js';
import type { TeacherAppService } from './teacher-app.service.js';

/**
 * The teacher app's API (`/api/v1/teacher/*`). Every route:
 * - needs `teacher_app.use` (TEACHER role; feature `teachers.mobile_app`, a paid
 *   add-on, so schools without it get 403 FEATURE_NOT_ENABLED), and
 * - the same permission as the admin route it wraps, so the teacher's section
 *   scope applies unchanged.
 * Handlers call the existing services; no business rule is duplicated here.
 */
const APP = 'teacher_app.use';
const TAG = ['Teacher app'];

const IsoDate = z.iso.date();
const IdParams = z.object({ id: z.uuid() });
const SectionParams = z.object({ sectionId: z.uuid() });
const SessionParams = z.object({ sessionId: z.uuid() });
const DateQuery = z.object({ date: IsoDate.optional() });
const OpenRegisterBody = z.object({ date: IsoDate.optional() });
const RosterQuery = PaginationQuery.extend({
  page_size: z.coerce.number().int().min(1).max(100).default(100),
});
const MyLeaveQuery = LeaveListQuery.omit({ teacher_id: true });
const MyLeaveBody = CreateLeaveBody.omit({ teacher_id: true });
const MyBalanceQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});
const MyAssignmentsQuery = PaginationQuery.extend({
  status: z.enum(['ACTIVE', 'ENDED', 'CANCELLED']).optional(),
});

export interface TeacherAppDeps {
  app: TeacherAppService;
  teachers: TeacherService;
  qualifications: QualificationService;
  assignments: AssignmentService;
  attendanceConfig: AttendanceConfigService;
  attendanceSessions: SessionService;
  attendanceReports: ReportService;
  timetableViews: ViewService;
  calendar: CalendarService;
  students: StudentService;
  guardians: GuardianService;
  enrollments: EnrollmentService;
  exams: ExamService;
  leave: LeaveService;
  staffAttendance: StaffAttendanceService;
  db: Parameters<typeof schoolToday>[0];
  clock: Parameters<typeof schoolToday>[2];
}

const tid = (req: Request) => req.ctx.tenant!.tenantId;
const me = (req: Request) => req.ctx.principal!;
const caller = (req: Request): Caller => ({
  tenantId: tid(req),
  principal: me(req),
  actor: actorFrom(req.ctx),
  features: req.ctx.tenant!.entitlements.features,
});

export function teacherAppRoutes(d: TeacherAppDeps) {
  const myId = async (req: Request) => (await d.app.myTeacher(tid(req), me(req))).id;

  return [
    // ---- Me & Today ----------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/teacher/me',
      summary: 'My teacher profile (qualifications, open assignments) for the Me screen',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'teachers.read'],
      handler: async ({ req }) => ({
        data: await d.teachers.get(tid(req), await myId(req), me(req)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/today',
      summary: 'Today: my lessons and the daily register state of each of my classes',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'timetable.read', 'attendance.read'],
      query: DateQuery,
      handler: async ({ query, req }) => ({ data: await d.app.today(caller(req), query.date) }),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/timetable',
      summary: 'My weekly timetable (published version of the current academic year)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'timetable.read'],
      handler: async ({ req }) => {
        await myId(req);
        return { data: await d.timetableViews.mine(tid(req), {}, me(req)) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/calendar',
      summary: 'School calendar for a date range (holidays; events follow in phase C)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'academics.read'],
      query: HolidayListQuery,
      handler: async ({ query, req }) => {
        await myId(req);
        return { data: { holidays: await d.calendar.listHolidays(tid(req), query) } };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/my-attendance',
      summary: 'My own attendance for a month, as marked by the office',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'teachers.read'],
      query: AttendanceMonthQuery,
      handler: async ({ query, req }) => {
        await myId(req);
        return { data: await d.staffAttendance.mine(tid(req), query.month, me(req)) };
      },
    }),

    // ---- Classes, roster & register -----------------------------------------------
    defineRoute({
      method: 'get',
      path: '/teacher/classes',
      summary: 'My classes: sections I teach or am class teacher of, with today’s register state',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'teachers.read', 'attendance.read'],
      handler: async ({ req }) => ({ data: await d.app.classes(caller(req)) }),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/classes/:sectionId/students',
      summary: 'Class roster (current enrollments of one of my sections)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'students.read', 'academics.read'],
      params: SectionParams,
      query: RosterQuery,
      handler: async ({ params, query, req }) => {
        await myId(req);
        return d.enrollments.list(
          tid(req),
          { ...query, section_id: params.sectionId, status: 'ACTIVE' },
          me(req),
        );
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/attendance-statuses',
      summary: 'The school’s attendance statuses (present, absent, late, half day …)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'attendance.read'],
      handler: async ({ req }) => {
        await myId(req);
        return { data: await d.attendanceConfig.listStatuses(tid(req), { status: 'ACTIVE' }) };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/teacher/classes/:sectionId/register',
      summary:
        'Open (or get) the daily register of one of my sections for a date (default: today). Returns the session with its roster.',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'attendance.mark'],
      params: SectionParams,
      body: OpenRegisterBody,
      handler: async ({ params, body, req }) => {
        await myId(req);
        const c = caller(req);
        const date = body.date ?? (await schoolToday(d.db, c.tenantId, d.clock));
        const r = await d.attendanceSessions.open(c, {
          attendance_type: 'DAILY',
          section_id: params.sectionId,
          session_date: date,
        });
        return {
          data: await d.attendanceSessions.get(c, String(r.session.id)),
          meta: { created: r.created },
        };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/registers/:sessionId',
      summary: 'One register with its roster and current marks',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'attendance.read'],
      params: SessionParams,
      handler: async ({ params, req }) => {
        await myId(req);
        return { data: await d.attendanceSessions.get(caller(req), params.sessionId) };
      },
    }),
    defineRoute({
      method: 'put',
      path: '/teacher/registers/:sessionId/records',
      summary: 'Save marks (status and remarks per student) on a DRAFT register',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'attendance.mark'],
      params: SessionParams,
      body: SaveRecordsBody,
      handler: async ({ params, body, req }) => {
        await myId(req);
        const r = await d.attendanceSessions.saveRecords(caller(req), params.sessionId, body);
        return { data: r.session, meta: { saved: r.saved } };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/teacher/registers/:sessionId/mark-all',
      summary: 'All present: give every unmarked student one status (default PRESENT)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'attendance.mark'],
      params: SessionParams,
      body: MarkAllBody,
      handler: async ({ params, body, req }) => {
        await myId(req);
        const r = await d.attendanceSessions.markAll(caller(req), params.sessionId, body);
        return { data: r.session, meta: { saved: r.saved } };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/teacher/registers/:sessionId/submit',
      summary: 'Submit the register. Every student must be marked.',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'attendance.mark'],
      params: SessionParams,
      body: SessionCommandBody,
      handler: async ({ params, body, req }) => {
        await myId(req);
        return {
          data: await d.attendanceSessions.submit(caller(req), params.sessionId, body.version),
        };
      },
    }),

    // ---- Students -------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/teacher/students/:id',
      summary: 'Student profile with guardians (only students in my sections)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'students.read'],
      params: IdParams,
      handler: async ({ params, req }) => {
        await myId(req);
        const [student, guardians] = await Promise.all([
          d.students.get(tid(req), params.id, me(req)),
          d.guardians.forStudent(tid(req), params.id, me(req)),
        ]);
        return { data: { student, guardians } };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/students/:id/attendance',
      summary: 'A student’s attendance history',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'students.read', 'attendance.read'],
      params: IdParams,
      query: StudentHistoryQuery,
      handler: async ({ params, query, req }) => {
        await myId(req);
        return { data: await d.attendanceReports.studentHistory(caller(req), params.id, query) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/students/:id/marks',
      summary: 'A student’s published exam results (only students in my sections)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'students.read', 'exams.read'],
      params: IdParams,
      handler: async ({ params, req }) => {
        await myId(req);
        // The exams service does not scope by section; the student load does (404 outside my sections).
        await d.students.get(tid(req), params.id, me(req));
        return { data: await d.exams.forStudent(tid(req), params.id) };
      },
    }),

    // ---- Leave ------------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/teacher/leave/types',
      summary: 'Leave types I can request',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'leave.read'],
      handler: async ({ req }) => {
        await myId(req);
        return { data: await d.leave.listTypes(tid(req), false) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/leave/balance',
      summary: 'My leave balance per type (quota, approved, pending, left)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'leave.read'],
      query: MyBalanceQuery,
      handler: async ({ query, req }) => ({
        data: await d.leave.balance(tid(req), { ...query, teacher_id: await myId(req) }, me(req)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/leave/requests',
      summary: 'My leave requests (filter by status and dates)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'leave.read'],
      query: MyLeaveQuery,
      handler: async ({ query, req }) =>
        d.leave.list(tid(req), { ...query, teacher_id: await myId(req) }, me(req)),
    }),
    defineRoute({
      method: 'post',
      path: '/teacher/leave/requests',
      summary: 'Request leave for myself',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'leave.request'],
      body: MyLeaveBody,
      status: 201,
      handler: async ({ body, req }) => {
        await myId(req);
        return { data: await d.leave.create(tid(req), body, me(req), actorFrom(req.ctx)) };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/teacher/leave/requests/:id/cancel',
      summary: 'Cancel one of my pending (or not-yet-started approved) requests',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'leave.read'],
      params: IdParams,
      body: CancelLeaveBody,
      handler: async ({ params, body, req }) => {
        await myId(req);
        return {
          data: await d.leave.cancel(tid(req), params.id, body.reason, me(req), actorFrom(req.ctx)),
        };
      },
    }),

    // ---- My records -------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/teacher/assignments',
      summary: 'My teaching assignments',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'teachers.read'],
      query: MyAssignmentsQuery,
      handler: async ({ query, req }) =>
        d.assignments.list(tid(req), { ...query, teacher_id: await myId(req) }, me(req)),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/qualifications',
      summary: 'My qualifications',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'teachers.read'],
      handler: async ({ req }) => ({
        data: await d.qualifications.list(tid(req), await myId(req), me(req)),
      }),
    }),
  ];
}
