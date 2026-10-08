import type { Request } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import type { LeaveService } from './leave.service.js';
import type { StaffAttendanceService } from './staff-attendance.service.js';
import {
  AttendanceDayQuery,
  AttendanceMonthQuery,
  CancelLeaveBody,
  CreateLeaveBody,
  CreateLeaveTypeBody,
  DecideLeaveBody,
  LeaveBalanceQuery,
  LeaveListQuery,
  LeaveParams,
  LeaveTypeParams,
  MarkAttendanceBody,
  RejectLeaveBody,
  UpdateLeaveTypeBody,
} from './leave.schemas.js';

const TAG = ['School · Leave'];
const TAG_A = ['School · Staff attendance'];
const tid = (req: Request) => req.ctx.tenant!.tenantId;
const me = (req: Request) => req.ctx.principal!;

export function leaveRoutes(leave: LeaveService, attendance: StaffAttendanceService) {
  return [
    // ---- Leave types
    defineRoute({
      method: 'get',
      path: '/leave-types',
      summary: 'Leave types the school grants. ?all=true includes switched-off ones.',
      tags: TAG,
      access: 'tenant',
      permissions: ['leave.read'],
      query: z.object({ all: z.stringbool().optional() }),
      handler: async ({ query, req }) => ({ data: await leave.listTypes(tid(req), query.all) }),
    }),
    defineRoute({
      method: 'post',
      path: '/leave-types',
      summary: 'Add a leave type',
      tags: TAG,
      access: 'tenant',
      permissions: ['leave.types.manage'],
      body: CreateLeaveTypeBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await leave.createType(tid(req), body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/leave-types/:id',
      summary: 'Edit or switch off a leave type',
      tags: TAG,
      access: 'tenant',
      permissions: ['leave.types.manage'],
      params: LeaveTypeParams,
      body: UpdateLeaveTypeBody,
      handler: async ({ params, body, req }) => ({
        data: await leave.updateType(tid(req), params.id, body, actorFrom(req.ctx)),
      }),
    }),

    // ---- Leave requests
    defineRoute({
      method: 'get',
      path: '/leave-requests',
      summary: 'Leave requests. Approvers see everyone; staff see only their own.',
      tags: TAG,
      access: 'tenant',
      permissions: ['leave.read'],
      query: LeaveListQuery,
      handler: async ({ query, req }) => leave.list(tid(req), query, me(req)),
    }),
    defineRoute({
      method: 'get',
      path: '/leave-balance',
      summary:
        'Quota, approved and pending days per leave type (own, or any staff member for approvers)',
      tags: TAG,
      access: 'tenant',
      permissions: ['leave.read'],
      query: LeaveBalanceQuery,
      handler: async ({ query, req }) => ({ data: await leave.balance(tid(req), query, me(req)) }),
    }),
    defineRoute({
      method: 'post',
      path: '/leave-requests',
      summary:
        'Request leave for yourself (or, with leave.approve, for another staff member). ' +
        '409 on overlapping dates; 422 when the yearly balance is not enough.',
      tags: TAG,
      access: 'tenant',
      permissions: ['leave.request'],
      body: CreateLeaveBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await leave.create(tid(req), body, me(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/leave-requests/:id',
      summary: 'One leave request',
      tags: TAG,
      access: 'tenant',
      permissions: ['leave.read'],
      params: LeaveParams,
      handler: async ({ params, req }) => ({ data: await leave.get(tid(req), params.id, me(req)) }),
    }),
    defineRoute({
      method: 'post',
      path: '/leave-requests/:id/approve',
      summary: 'Approve a pending request (not your own)',
      tags: TAG,
      access: 'tenant',
      permissions: ['leave.approve'],
      params: LeaveParams,
      body: DecideLeaveBody,
      handler: async ({ params, body, req }) => ({
        data: await leave.approve(tid(req), params.id, body.note, me(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/leave-requests/:id/reject',
      summary: 'Reject a pending request (a note is required)',
      tags: TAG,
      access: 'tenant',
      permissions: ['leave.approve'],
      params: LeaveParams,
      body: RejectLeaveBody,
      handler: async ({ params, body, req }) => ({
        data: await leave.reject(tid(req), params.id, body.note, me(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/leave-requests/:id/cancel',
      summary: 'Cancel a pending or not-yet-started approved request',
      tags: TAG,
      access: 'tenant',
      permissions: ['leave.read'],
      params: LeaveParams,
      body: CancelLeaveBody,
      handler: async ({ params, body, req }) => ({
        data: await leave.cancel(tid(req), params.id, body.reason, me(req), actorFrom(req.ctx)),
      }),
    }),

    // ---- Staff attendance
    defineRoute({
      method: 'get',
      path: '/staff-attendance',
      summary:
        'Daily roster of active staff with their mark and whether approved leave covers them',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['teachers.attendance.read'],
      query: AttendanceDayQuery,
      handler: async ({ query, req }) => ({
        data: await attendance.roster(tid(req), query.date, me(req)),
      }),
    }),
    defineRoute({
      method: 'put',
      path: '/staff-attendance',
      summary: 'Mark (or correct) attendance for a day. Future dates are refused.',
      tags: TAG_A,
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
      path: '/staff-attendance/monthly',
      summary: 'Per-person counts for a month',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['teachers.attendance.read'],
      query: AttendanceMonthQuery,
      handler: async ({ query, req }) => ({
        data: await attendance.monthly(tid(req), query.month, me(req)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/staff-attendance/export',
      summary: 'Monthly summary as CSV (audited)',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['teachers.attendance.read'],
      query: AttendanceMonthQuery,
      handler: async ({ query, req, res }) => {
        const csv = await attendance.exportCsv(tid(req), query.month, me(req), actorFrom(req.ctx));
        res
          .status(200)
          .type('text/csv')
          .set('Content-Disposition', `attachment; filename="staff-attendance-${query.month}.csv"`)
          .send(csv);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/staff-attendance/mine',
      summary: "The signed-in staff member's own marks for a month",
      tags: TAG_A,
      access: 'tenant',
      permissions: ['teachers.read'],
      query: AttendanceMonthQuery,
      handler: async ({ query, req }) => ({
        data: await attendance.mine(tid(req), query.month, me(req)),
      }),
    }),
  ];
}
