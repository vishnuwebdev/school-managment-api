import type { Request, Response } from 'express';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import {
  ApproveCorrectionBody,
  CorrectionListQuery,
  CreateStatusBody,
  DefaultersQuery,
  IdParams,
  MarkAllBody,
  MonthlyQuery,
  OpenSessionBody,
  RegisterQuery,
  RejectCorrectionBody,
  RequestCorrectionBody,
  SaveRecordsBody,
  SessionCommandBody,
  SessionListQuery,
  SessionReasonBody,
  StatusListQuery,
  StudentHistoryQuery,
  TodayQuery,
  UpdateSettingsBody,
  UpdateStatusBody,
} from './attendance.schemas.js';
import type { AttendanceConfigService } from './config.service.js';
import type { CorrectionService } from './corrections.service.js';
import type { ReportService } from './reports.service.js';
import type { SessionService } from './sessions.service.js';
import type { Caller } from './support.js';

const caller = (req: Request): Caller => ({
  tenantId: req.ctx.tenant!.tenantId,
  principal: req.ctx.principal!,
  actor: actorFrom(req.ctx),
  features: req.ctx.tenant!.entitlements.features,
});

const csv = (res: Response, filename: string, body: string) => {
  res
    .status(200)
    .type('text/csv')
    .set('Content-Disposition', `attachment; filename="${filename}"`)
    .send(body);
};

const TAG_S = ['School · Attendance sessions'];
const TAG_C = ['School · Attendance corrections'];
const TAG_R = ['School · Attendance reports'];
const TAG_CFG = ['School · Attendance settings'];

export function attendanceRoutes(
  config: AttendanceConfigService,
  sessions: SessionService,
  corrections: CorrectionService,
  reports: ReportService,
) {
  const command = (
    path: string,
    summary: string,
    permission: string,
    run: (c: Caller, id: string, body: never) => Promise<unknown>,
    body: typeof SessionCommandBody | typeof SessionReasonBody,
  ) =>
    defineRoute({
      method: 'post',
      path: `/attendance/sessions/:id/${path}`,
      summary,
      tags: TAG_S,
      access: 'tenant',
      permissions: [permission],
      params: IdParams,
      body,
      handler: async ({ params, body: b, req }) => ({
        data: await run(caller(req), params.id, b as never),
      }),
    });

  return [
    // ---- Configuration: statuses & settings --------------------------------------------
    defineRoute({
      method: 'get',
      path: '/attendance/statuses',
      summary:
        'List attendance statuses (creates the six built-ins for the school on first use). Filter: status',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['attendance.read'],
      query: StatusListQuery,
      handler: async ({ query, req }) => ({
        data: await config.listStatuses(caller(req).tenantId, query),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/attendance/statuses',
      summary: 'Create a custom attendance status',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['attendance.statuses.manage'],
      body: CreateStatusBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await config.createStatus(caller(req).tenantId, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/attendance/statuses/:id',
      summary: 'One attendance status',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['attendance.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await config.getStatus(caller(req).tenantId, params.id),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/attendance/statuses/:id',
      summary:
        'Edit a status (send the version you read). Built-in statuses: name and sort order only.',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['attendance.statuses.manage'],
      params: IdParams,
      body: UpdateStatusBody,
      handler: async ({ params, body, req }) => ({
        data: await config.updateStatus(caller(req).tenantId, params.id, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/attendance/statuses/:id/deactivate',
      summary:
        'Deactivate a custom status (no new marks; existing records keep it). Built-ins cannot be deactivated.',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['attendance.statuses.manage'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await config.setStatusState(
          caller(req).tenantId,
          params.id,
          'INACTIVE',
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/attendance/statuses/:id/activate',
      summary: 'Reactivate a custom status',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['attendance.statuses.manage'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await config.setStatusState(
          caller(req).tenantId,
          params.id,
          'ACTIVE',
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/attendance/settings',
      summary: 'Attendance settings (approval, corrections, edit window, defaulter threshold)',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['attendance.read'],
      handler: async ({ req }) => ({ data: await config.getSettings(caller(req).tenantId) }),
    }),
    defineRoute({
      method: 'patch',
      path: '/attendance/settings',
      summary: 'Update attendance settings (send the version you read)',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['attendance.settings.manage'],
      body: UpdateSettingsBody,
      handler: async ({ body, req }) => ({
        data: await config.updateSettings(caller(req).tenantId, body, actorFrom(req.ctx)),
      }),
    }),

    // ---- Dashboards and reports (static paths first) ---------------------------------------
    defineRoute({
      method: 'get',
      path: '/attendance/today',
      summary:
        "Per-section state of the day's DAILY register (NOT_STARTED / DRAFT / SUBMITTED / FINAL) with counts, for the active year",
      tags: TAG_R,
      access: 'tenant',
      permissions: ['attendance.read'],
      query: TodayQuery,
      handler: async ({ query, req }) => ({ data: await reports.today(caller(req), query) }),
    }),
    defineRoute({
      method: 'get',
      path: '/attendance/register',
      summary: 'Daily register: student × date matrix for one section (max 62 days)',
      tags: TAG_R,
      access: 'tenant',
      permissions: ['attendance.read'],
      query: RegisterQuery,
      handler: async ({ query, req }) => ({ data: await reports.register(caller(req), query) }),
    }),
    defineRoute({
      method: 'get',
      path: '/attendance/register/export',
      summary: 'Register as CSV (audited)',
      tags: TAG_R,
      access: 'tenant',
      permissions: ['attendance.read', 'attendance.export'],
      query: RegisterQuery,
      handler: async ({ query, req, res }) =>
        csv(res, 'attendance-register.csv', await reports.exportRegister(caller(req), query)),
    }),
    defineRoute({
      method: 'get',
      path: '/attendance/reports/monthly',
      summary: 'Monthly report for a section: per day, per student and section totals',
      tags: TAG_R,
      access: 'tenant',
      permissions: ['attendance.read'],
      query: MonthlyQuery,
      handler: async ({ query, req }) => ({ data: await reports.monthly(caller(req), query) }),
    }),
    defineRoute({
      method: 'get',
      path: '/attendance/reports/monthly/export',
      summary: 'Monthly report as CSV (audited)',
      tags: TAG_R,
      access: 'tenant',
      permissions: ['attendance.read', 'attendance.export'],
      query: MonthlyQuery,
      handler: async ({ query, req, res }) =>
        csv(res, 'attendance-monthly.csv', await reports.exportMonthly(caller(req), query)),
    }),
    defineRoute({
      method: 'get',
      path: '/attendance/reports/defaulters',
      summary:
        'Students whose attendance percentage is below the threshold (filters: academic_year_id, class_id, section_id, threshold, from, to)',
      tags: TAG_R,
      access: 'tenant',
      permissions: ['attendance.read'],
      query: DefaultersQuery,
      handler: async ({ query, req }) => reports.defaulters(caller(req), query),
    }),
    defineRoute({
      method: 'get',
      path: '/attendance/reports/defaulters/export',
      summary: 'Defaulters as CSV (audited)',
      tags: TAG_R,
      access: 'tenant',
      permissions: ['attendance.read', 'attendance.export'],
      query: DefaultersQuery,
      handler: async ({ query, req, res }) =>
        csv(res, 'attendance-defaulters.csv', await reports.exportDefaulters(caller(req), query)),
    }),
    defineRoute({
      method: 'get',
      path: '/students/:id/attendance',
      summary:
        "A student's attendance history and summary (needs students.read for the student and attendance.read for the sessions)",
      tags: TAG_R,
      access: 'tenant',
      permissions: ['students.read', 'attendance.read'],
      params: IdParams,
      query: StudentHistoryQuery,
      handler: async ({ params, query, req }) => ({
        data: await reports.studentHistory(caller(req), params.id, query),
      }),
    }),

    // ---- Sessions ----------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/attendance/sessions',
      summary:
        'List sessions with marked counts (filters: section_id, class_id, academic_year_id, attendance_type, status, date_from, date_to)',
      tags: TAG_S,
      access: 'tenant',
      permissions: ['attendance.read'],
      query: SessionListQuery,
      handler: async ({ query, req }) => sessions.list(caller(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/attendance/sessions',
      summary:
        'Open (or get) the session for a section and date. 201 when created, 200 when it already existed. SUBJECT sessions need the attendance.subject feature.',
      tags: TAG_S,
      access: 'tenant',
      permissions: ['attendance.mark'],
      body: OpenSessionBody,
      handler: async ({ body, req, res }) => {
        const r = await sessions.open(caller(req), body);
        res.status(r.created ? 201 : 200).json({ data: r.session, meta: { created: r.created } });
      },
    }),
    defineRoute({
      method: 'get',
      path: '/attendance/sessions/:id',
      summary: 'Session with summary and the full roster (each student with the current mark)',
      tags: TAG_S,
      access: 'tenant',
      permissions: ['attendance.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await sessions.get(caller(req), params.id) }),
    }),
    defineRoute({
      method: 'put',
      path: '/attendance/sessions/:id/records',
      summary:
        'Bulk upsert marks in one transaction (only DRAFT sessions). Students must be on the roster; duplicates and unknown or inactive statuses are rejected.',
      tags: TAG_S,
      access: 'tenant',
      permissions: ['attendance.mark'],
      params: IdParams,
      body: SaveRecordsBody,
      handler: async ({ params, body, req }) => {
        const r = await sessions.saveRecords(caller(req), params.id, body);
        return { data: r.session, meta: { saved: r.saved } };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/attendance/sessions/:id/mark-all',
      summary:
        'Give every student on the roster one status (default PRESENT); only unmarked students unless overwrite is true',
      tags: TAG_S,
      access: 'tenant',
      permissions: ['attendance.mark'],
      params: IdParams,
      body: MarkAllBody,
      handler: async ({ params, body, req }) => {
        const r = await sessions.markAll(caller(req), params.id, body);
        return { data: r.session, meta: { saved: r.saved } };
      },
    }),
    command(
      'submit',
      'Submit the register (DRAFT → SUBMITTED, or → FINAL when approval is not required). Every student must be marked.',
      'attendance.mark',
      (c, id, b: { version?: number }) => sessions.submit(c, id, b.version),
      SessionCommandBody,
    ),
    command(
      'approve',
      'Approve a submitted register (SUBMITTED → FINAL)',
      'attendance.approve',
      (c, id, b: { version?: number }) => sessions.approve(c, id, b.version),
      SessionCommandBody,
    ),
    command(
      'reject',
      'Send a submitted register back to DRAFT with a reason',
      'attendance.approve',
      (c, id, b: { version?: number; reason: string }) =>
        sessions.reject(c, id, b.reason, b.version),
      SessionReasonBody,
    ),
    command(
      'reopen',
      'Reopen a FINAL register for editing (FINAL → DRAFT) with a reason; refused while corrections are pending',
      'attendance.approve',
      (c, id, b: { version?: number; reason: string }) =>
        sessions.reopen(c, id, b.reason, b.version),
      SessionReasonBody,
    ),

    // ---- Corrections -----------------------------------------------------------------------
    defineRoute({
      method: 'post',
      path: '/attendance/records/:id/corrections',
      summary:
        'Correct a record of a FINAL session. Applied at once (AUTO_APPLIED) or PENDING until approved, per settings.',
      tags: TAG_C,
      access: 'tenant',
      permissions: ['attendance.correct'],
      params: IdParams,
      body: RequestCorrectionBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await corrections.request(caller(req), params.id, body),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/attendance/corrections',
      summary:
        'List corrections (filters: status, section_id, student_id, session_id, record_id, date_from, date_to)',
      tags: TAG_C,
      access: 'tenant',
      permissions: ['attendance.read'],
      query: CorrectionListQuery,
      handler: async ({ query, req }) => corrections.list(caller(req), query),
    }),
    defineRoute({
      method: 'get',
      path: '/attendance/corrections/:id',
      summary: 'One correction',
      tags: TAG_C,
      access: 'tenant',
      permissions: ['attendance.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await corrections.get(caller(req), params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/attendance/corrections/:id/approve',
      summary: 'Approve a pending correction and apply it to the record',
      tags: TAG_C,
      access: 'tenant',
      permissions: ['attendance.approve'],
      params: IdParams,
      body: ApproveCorrectionBody,
      handler: async ({ params, body, req }) => ({
        data: await corrections.approve(caller(req), params.id, body),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/attendance/corrections/:id/reject',
      summary: 'Reject a pending correction (reason required)',
      tags: TAG_C,
      access: 'tenant',
      permissions: ['attendance.approve'],
      params: IdParams,
      body: RejectCorrectionBody,
      handler: async ({ params, body, req }) => ({
        data: await corrections.reject(caller(req), params.id, body),
      }),
    }),
  ];
}
