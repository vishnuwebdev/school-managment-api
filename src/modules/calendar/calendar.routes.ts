import type { Request } from 'express';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import type { CalendarSubject } from './calendar.rules.js';
import type { CalendarService } from './calendar.service.js';
import {
  CancelEventBody,
  CreateCategoryBody,
  CreateEventBody,
  EventListQuery,
  HolidayListQuery,
  IdParams,
  UpdateCalendarSettingsBody,
  UpdateCategoryBody,
  UpdateEventBody,
  WorkingDaysQuery,
} from './calendar.schemas.js';

const TAG = ['School · Calendar'];
const tid = (req: Request) => req.ctx.tenant!.tenantId;
const READ = ['academics.read'];
const MANAGE = ['academics.manage'];

const subjectOf = (q: { for: 'staff' | 'students'; class_id?: string; section_id?: string }): CalendarSubject =>
  q.class_id
    ? { kind: 'class', classId: q.class_id, ...(q.section_id ? { sectionId: q.section_id } : {}) }
    : q.for === 'students'
      ? { kind: 'students' }
      : { kind: 'staff' };

/** School calendar: weekly off days, categories, entries and working-day counts. */
export function calendarRoutes(svc: CalendarService) {
  return [
    // ---- weekly off days
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

    // ---- categories
    defineRoute({
      method: 'get',
      path: '/calendar/categories',
      summary: 'Calendar categories (built-in and the school’s own), with colours and whether they close the school',
      tags: TAG,
      access: 'tenant',
      permissions: READ,
      handler: async ({ req }) => ({ data: await svc.listCategories(tid(req)) }),
    }),
    defineRoute({
      method: 'post',
      path: '/calendar/categories',
      summary: 'Add a category',
      tags: TAG,
      access: 'tenant',
      permissions: MANAGE,
      body: CreateCategoryBody,
      status: 201,
      handler: async ({ body, req }) => ({ data: await svc.createCategory(tid(req), body, actorFrom(req.ctx)) }),
    }),
    defineRoute({
      method: 'patch',
      path: '/calendar/categories/:id',
      summary: 'Rename, recolour, switch off a category or change whether it closes the school (open leave is recounted)',
      tags: TAG,
      access: 'tenant',
      permissions: MANAGE,
      params: IdParams,
      body: UpdateCategoryBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.updateCategory(tid(req), params.id, body, actorFrom(req.ctx)),
      }),
    }),

    // ---- entries
    defineRoute({
      method: 'get',
      path: '/calendar/events',
      summary: 'Calendar entries overlapping from–to, optionally of one category',
      tags: TAG,
      access: 'tenant',
      permissions: READ,
      query: EventListQuery,
      handler: async ({ query, req }) => ({ data: await svc.listEvents(tid(req), query) }),
    }),
    defineRoute({
      method: 'post',
      path: '/calendar/events',
      summary: 'Add a calendar entry. In a school-closing category, overlapping leave is recounted.',
      tags: TAG,
      access: 'tenant',
      permissions: MANAGE,
      body: CreateEventBody,
      status: 201,
      handler: async ({ body, req }) => ({ data: await svc.createEvent(tid(req), body, actorFrom(req.ctx)) }),
    }),
    defineRoute({
      method: 'patch',
      path: '/calendar/events/:id',
      summary: 'Edit a calendar entry',
      tags: TAG,
      access: 'tenant',
      permissions: MANAGE,
      params: IdParams,
      body: UpdateEventBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.updateEvent(tid(req), params.id, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/calendar/events/:id/cancel',
      summary: 'Cancel a calendar entry (kept for history)',
      tags: TAG,
      access: 'tenant',
      permissions: MANAGE,
      params: IdParams,
      body: CancelEventBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.cancelEvent(tid(req), params.id, body.version, body.reason, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/calendar/holidays',
      summary: 'Legacy: entries in school-closing categories (holidays, vacations …)',
      tags: TAG,
      access: 'tenant',
      permissions: READ,
      query: HolidayListQuery,
      handler: async ({ query, req }) => ({ data: await svc.listHolidays(tid(req), query) }),
    }),

    // ---- day counts
    defineRoute({
      method: 'get',
      path: '/calendar/working-days',
      summary:
        'Working days between two dates and the days left out (weekly off / school closed). for=staff (default), students, or class_id (+ section_id).',
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
