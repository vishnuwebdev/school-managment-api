import type { Request } from 'express';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import type { TeacherAttendanceService } from './teacher-attendance.service.js';
import type { TeacherRegisterService } from './teacher-register.service.js';
import {
  AttendanceDayQuery,
  AttendanceMonthQuery,
  MarkAttendanceBody,
  RegisterQuery,
  SetDayBody,
  TeacherDayParams,
  TeacherParams,
  TeacherYearQuery,
} from './teacher-attendance.schemas.js';

const TAG = ['School · Teacher attendance'];
const tid = (req: Request) => req.ctx.tenant!.tenantId;
const me = (req: Request) => req.ctx.principal!;

/** Teacher attendance, marked by the school office (Teachers → Teacher attendance). */
export function teacherAttendanceRoutes(
  attendance: TeacherAttendanceService,
  register: TeacherRegisterService,
) {
  return [
    defineRoute({
      method: 'get',
      path: '/teacher-attendance',
      summary: 'Daily roster of active teachers with their mark',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.attendance.read'],
      query: AttendanceDayQuery,
      handler: async ({ query, req }) => ({
        data: await attendance.roster(tid(req), query.date, me(req)),
      }),
    }),
    defineRoute({
      method: 'put',
      path: '/teacher-attendance',
      summary: 'Mark (or correct) attendance for a day. Future dates are refused.',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.attendance.mark'],
      query: AttendanceDayQuery,
      body: MarkAttendanceBody,
      handler: async ({ query, body, req }) => ({
        data: await attendance.mark(tid(req), query.date, body, me(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher-attendance/monthly',
      summary: 'Per-person counts for a month',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.attendance.read'],
      query: AttendanceMonthQuery,
      handler: async ({ query, req }) => ({
        data: await attendance.monthly(tid(req), query.month, me(req)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher-attendance/export',
      summary:
        'The month register as CSV (audited): totals, loss-of-pay and payable days per person; ?with_days=true adds a column per day',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.attendance.read'],
      query: RegisterQuery,
      handler: async ({ query, req, res }) => {
        const csv = await register.exportCsv(tid(req), query, me(req), actorFrom(req.ctx));
        res
          .status(200)
          .type('text/csv')
          .set(
            'Content-Disposition',
            `attachment; filename="teacher-attendance-${query.month}.csv"`,
          )
          .send(csv);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teacher-attendance/register',
      summary:
        'The month register: every teacher × every day (marks, holidays, weekly offs, gaps) with salary-ready totals',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.attendance.read'],
      query: RegisterQuery,
      handler: async ({ query, req }) => ({
        data: await register.register(tid(req), query, me(req)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher-attendance/teachers/:id',
      summary: "One teacher's month: every day and the totals",
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.attendance.read'],
      params: TeacherParams,
      query: AttendanceMonthQuery,
      handler: async ({ params, query, req }) => ({
        data: await register.teacherMonth(tid(req), params.id, query.month, me(req)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher-attendance/teachers/:id/year',
      summary: "One teacher's calendar year: totals per month (with absent dates) and for the year",
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.attendance.read'],
      params: TeacherParams,
      query: TeacherYearQuery,
      handler: async ({ params, query, req }) => ({
        data: await register.teacherYear(tid(req), params.id, query.year, me(req)),
      }),
    }),
    defineRoute({
      method: 'put',
      path: '/teacher-attendance/teachers/:id/days/:date',
      summary:
        'Set or correct one day for one teacher (status null clears it). Returns their month',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.attendance.mark'],
      params: TeacherDayParams,
      body: SetDayBody,
      handler: async ({ params, body, req }) => ({
        data: await register.setDay(
          tid(req),
          params.id,
          params.date,
          body,
          me(req),
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher-attendance/mine',
      summary: "The signed-in teacher's own marks for a month",
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.read'],
      query: AttendanceMonthQuery,
      handler: async ({ query, req }) => ({
        data: await attendance.mine(tid(req), query.month, me(req)),
      }),
    }),
  ];
}
