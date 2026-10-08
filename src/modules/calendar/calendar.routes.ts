import type { Request } from 'express';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import type { CalendarSubject } from './calendar.rules.js';
import type { CalendarService } from './calendar.service.js';
import {
  CancelHolidayBody,
  CreateHolidayBody,
  HolidayListQuery,
  HolidayParams,
  UpdateCalendarSettingsBody,
  UpdateHolidayBody,
  WorkingDaysQuery,
} from './calendar.schemas.js';

const TAG = ['School · Calendar & holidays'];
const tid = (req: Request) => req.ctx.tenant!.tenantId;
const READ = ['academics.read'];
const MANAGE = ['academics.manage'];

const subjectOf = (q: { for: 'staff' | 'students'; class_id?: string }): CalendarSubject =>
  q.class_id ? { kind: 'class', classId: q.class_id } : q.for === 'students' ? { kind: 'students' } : { kind: 'staff' };

/** School calendar: weekly off days, holidays and working-day counts. */
export function calendarRoutes(svc: CalendarService) {
  return [
    defineRoute({
      method: 'get',
      path: '/calendar/settings',
      summary: 'Weekly off days (defaults: Sunday off)',
      tags: TAG,
      access: 'tenant',
      permissions: READ,
      handler: async ({ req }) => ({ data: await svc.getSettings(tid(req)) }),
    }),
    defineRoute({
      method: 'put',
      path: '/calendar/settings',
      summary: 'Set the weekly off days. Open leave is recounted.',
      tags: TAG,
      access: 'tenant',
      permissions: MANAGE,
      body: UpdateCalendarSettingsBody,
      handler: async ({ body, req }) => ({ data: await svc.updateSettings(tid(req), body, actorFrom(req.ctx)) }),
    }),
    defineRoute({
      method: 'get',
      path: '/calendar/holidays',
      summary: 'Holidays, optionally overlapping from–to',
      tags: TAG,
      access: 'tenant',
      permissions: READ,
      query: HolidayListQuery,
      handler: async ({ query, req }) => ({ data: await svc.listHolidays(tid(req), query) }),
    }),
    defineRoute({
      method: 'post',
      path: '/calendar/holidays',
      summary: 'Add a holiday (one day or a range). Overlapping leave is recounted.',
      tags: TAG,
      access: 'tenant',
      permissions: MANAGE,
      body: CreateHolidayBody,
      status: 201,
      handler: async ({ body, req }) => ({ data: await svc.createHoliday(tid(req), body, actorFrom(req.ctx)) }),
    }),
    defineRoute({
      method: 'patch',
      path: '/calendar/holidays/:id',
      summary: 'Edit a holiday. Leave over the old and new dates is recounted.',
      tags: TAG,
      access: 'tenant',
      permissions: MANAGE,
      params: HolidayParams,
      body: UpdateHolidayBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.updateHoliday(tid(req), params.id, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/calendar/holidays/:id/cancel',
      summary: 'Cancel a holiday (kept for history). Leave over its dates is recounted.',
      tags: TAG,
      access: 'tenant',
      permissions: MANAGE,
      params: HolidayParams,
      body: CancelHolidayBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.cancelHoliday(tid(req), params.id, body.version, body.reason, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/calendar/working-days',
      summary:
        'Working days between two dates and the days left out (weekly off / holiday). for=staff (default), students, or class_id.',
      tags: TAG,
      access: 'tenant',
      permissions: READ,
      query: WorkingDaysQuery,
      handler: async ({ query, req }) => ({
        data: await svc.calendarView(tid(req), query.from, query.to, subjectOf(query)),
      }),
    }),
  ];
}
