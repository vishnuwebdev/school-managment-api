import type { Request } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import { PaginationQuery } from '../../shared/pagination.js';
import {
  MarkAllBody,
  RequestCorrectionBody,
  SaveRecordsBody,
  SessionCommandBody,
  StudentHistoryQuery,
} from '../attendance/attendance.schemas.js';
import type { AttendanceConfigService } from '../attendance/config.service.js';
import type { CorrectionService } from '../attendance/corrections.service.js';
import type { ReportService } from '../attendance/reports.service.js';
import type { SessionService } from '../attendance/sessions.service.js';
import { schoolToday, type Caller } from '../attendance/support.js';
import { HolidayListQuery } from '../calendar/calendar.schemas.js';
import type { CalendarService } from '../calendar/calendar.service.js';
import { PinSchema, type AppPinService } from '../identity/app-pin.js';
import type { ExamService } from '../exams/exams.service.js';
import type { EnrollmentService } from '../students/enrollments.service.js';
import type { GuardianService } from '../students/guardians.service.js';
import type { StudentService } from '../students/students.service.js';
import type { AssignmentService } from '../teachers/assignments.service.js';
import type { QualificationService } from '../teachers/qualifications.service.js';
import type { StaffDocumentService } from '../teachers/documents.service.js';
import { fileHeaders } from '../files/files.service.js';
import { AttendanceMonthQuery } from '../teachers/teacher-attendance.schemas.js';
import type { TeacherAttendanceService } from '../teachers/teacher-attendance.service.js';
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
const DocParams = z.object({ docId: z.uuid() });
const ReportQuery = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM'),
});
const SectionParams = z.object({ sectionId: z.uuid() });
const SessionParams = z.object({ sessionId: z.uuid() });
const DateQuery = z.object({ date: IsoDate.optional() });
const OpenRegisterBody = z.object({ date: IsoDate.optional() });
const RosterQuery = PaginationQuery.extend({
  page_size: z.coerce.number().int().min(1).max(100).default(100),
});
const MyAssignmentsQuery = PaginationQuery.extend({
  status: z.enum(['ACTIVE', 'ENDED', 'CANCELLED']).optional(),
});

const VerifyPinBody = z.object({
  pin_token: z.string().min(20).max(200),
  pin: z.string().regex(/^\d{4}$/),
});
const VerifyPasswordBody = z.object({ password: z.string().min(1).max(200) });

const SetPinBody = z.object({
  pin: PinSchema,
  device: z
    .object({
      device_name: z.string().max(100).optional(),
      device_type: z.enum(['android', 'ios', 'other']).optional(),
    })
    .optional(),
});

export interface TeacherAppDeps {
  app: TeacherAppService;
  pins: AppPinService;
  teachers: TeacherService;
  qualifications: QualificationService;
  assignments: AssignmentService;
  attendanceConfig: AttendanceConfigService;
  attendanceSessions: SessionService;
  attendanceReports: ReportService;
  attendanceCorrections: CorrectionService;
  staffDocuments: StaffDocumentService;
  timetableViews: ViewService;
  calendar: CalendarService;
  students: StudentService;
  guardians: GuardianService;
  enrollments: EnrollmentService;
  exams: ExamService;
  teacherAttendance: TeacherAttendanceService;
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
    // ---- Sign-in PIN ----------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/teacher/pin',
      summary: 'Whether I have an app sign-in PIN (NONE, SET or LOCKED)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      handler: async ({ req }) => {
        await myId(req);
        return { data: await d.pins.status(tid(req), me(req).membershipId) };
      },
    }),
    defineRoute({
      method: 'put',
      path: '/teacher/pin',
      summary:
        'Set or replace my app sign-in PIN. Returns `pin_token`: keep it in secure storage and ' +
        'send it with the PIN to POST /auth/pin-login. A previous PIN stops working.',
      tags: TAG,
      access: 'tenant',
      rateLimit: 'auth',
      permissions: [APP],
      body: SetPinBody,
      handler: async ({ body, req }) => {
        await myId(req);
        return {
          data: await d.pins.set(
            {
              tenantId: tid(req),
              membershipId: me(req).membershipId,
              userId: me(req).userId,
              pin: body.pin,
              device: {
                deviceName: body.device?.device_name,
                deviceType: body.device?.device_type,
              },
            },
            actorFrom(req.ctx),
          ),
        };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/teacher/pin/verify',
      summary:
        'Check my current PIN (Change PIN). 401 INVALID_PIN (details.attempts_left), 401 PIN_NOT_SET, 403 PIN_LOCKED',
      tags: TAG,
      access: 'tenant',
      rateLimit: 'auth',
      permissions: [APP],
      body: VerifyPinBody,
      handler: async ({ body, req }) => {
        await myId(req);
        await d.pins.verifyMine(body.pin_token, body.pin, me(req).membershipId);
        return { data: { ok: true } };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/teacher/verify-password',
      summary:
        'Confirm it is me with my account password (Forgot PIN while signed in). 422 when wrong',
      tags: TAG,
      access: 'tenant',
      rateLimit: 'auth',
      permissions: [APP],
      body: VerifyPasswordBody,
      handler: async ({ body, req }) => {
        await myId(req);
        await d.app.checkPassword(me(req).userId, body.password);
        return { data: { ok: true } };
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/teacher/pin',
      summary: 'Turn PIN sign-in off (deletes my PIN)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      status: 204,
      handler: async ({ req }) => {
        await myId(req);
        await d.pins.remove(tid(req), me(req).membershipId, actorFrom(req.ctx));
      },
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
      summary:
        'School calendar for a date range: holidays, weekly off days, and the events, exams and ' +
        'meetings I can see (everyone, staff, all students, or a class I teach)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'academics.read'],
      query: HolidayListQuery,
      handler: async ({ query, req }) => {
        await myId(req);
        const [holidays, settings, classIds] = await Promise.all([
          d.calendar.listHolidays(tid(req), query),
          d.calendar.getSettings(tid(req)),
          d.app.myClassIds(tid(req), me(req)),
        ]);
        return {
          data: {
            holidays,
            weekly_off_days: settings.weekly_off_days,
            off_saturdays: settings.off_saturdays,
            events: await d.calendar.eventsForTeacher(
              tid(req),
              { from: query.from, to: query.to },
              classIds,
            ),
          },
        };
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

    defineRoute({
      method: 'post',
      path: '/teacher/records/:id/corrections',
      summary:
        'Correct one student’s mark on a finalised register (applied at once or sent to the office, per school settings)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'attendance.correct'],
      params: IdParams,
      body: RequestCorrectionBody,
      status: 201,
      handler: async ({ params, body, req }) => {
        await myId(req);
        return { data: await d.attendanceCorrections.request(caller(req), params.id, body) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/classes/:sectionId/report',
      summary: 'Monthly attendance report of one of my classes: per day, per student and totals',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'attendance.read'],
      params: SectionParams,
      query: ReportQuery,
      handler: async ({ params, query, req }) => {
        await myId(req);
        return {
          data: await d.attendanceReports.monthly(caller(req), {
            section_id: params.sectionId,
            month: query.month,
          }),
        };
      },
    }),

    // ---- My records -------------------------------------------------------------------
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
        return { data: await d.teacherAttendance.mine(tid(req), query.month, me(req)) };
      },
    }),
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
      path: '/teacher/documents',
      summary: 'My documents on file with the office (required and optional, what is missing)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'teachers.read'],
      handler: async ({ req }) => ({
        data: await d.staffDocuments.list(tid(req), await myId(req), me(req), 'teachers.read'),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/documents/:docId/file',
      summary: 'Download one of my documents',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'teachers.read'],
      params: DocParams,
      handler: async ({ params, req, res }) => {
        const f = await d.staffDocuments.download(
          tid(req),
          await myId(req),
          params.docId,
          me(req),
          'teachers.read',
        );
        res.status(200).set(fileHeaders(f)).end(f.data);
        return undefined;
      },
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
