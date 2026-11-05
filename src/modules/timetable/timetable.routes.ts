import type { Request, Response } from 'express';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import type { TimetableConfigService } from './config.service.js';
import type { PeriodService } from './periods.service.js';
import {
  CopyPeriodsBody,
  CopyYearBody,
  CreatePeriodBody,
  CreateVenueBody,
  DayParams,
  DayViewQuery,
  ExportQuery,
  IdParams,
  MyDayQuery,
  OwnerQuery,
  SetDayBody,
  StatusQuery,
  UpdatePeriodBody,
  UpdateSettingsBody,
  UpdateVenueBody,
  VenueListQuery,
  ViewClassParams,
  ViewQuery,
  ViewSectionParams,
  ViewTeacherParams,
  ViewVenueParams,
  WorkloadQuery,
} from './timetable.schemas.js';
import type { ViewService } from './views.service.js';

const ctx = (req: Request) => ({
  tenantId: req.ctx.tenant!.tenantId,
  principal: req.ctx.principal!,
  actor: actorFrom(req.ctx),
});

const TAG_CFG = ['School · Timetable configuration'];
const TAG_P = ['School · Timetable periods'];
const TAG_V = ['School · Timetable views'];

const csv = (res: Response, filename: string, body: string) => {
  res
    .status(200)
    .type('text/csv')
    .set('Content-Disposition', `attachment; filename="${filename}"`)
    .send(body);
};

export function timetableRoutes(
  config: TimetableConfigService,
  periods: PeriodService,
  views: ViewService,
) {
  return [
    // ---- Configuration: working days --------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/timetable/settings',
      summary:
        'Teaching days of the school (ISO weekdays 1 = Monday … 7 = Sunday). Created with Mon–Fri on first use',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.read'],
      handler: async ({ req }) => ({ data: await config.getSettings(ctx(req).tenantId) }),
    }),
    defineRoute({
      method: 'patch',
      path: '/timetable/settings',
      summary:
        'Change the teaching days and the school day window (send the version you read). The week is periods × teaching days',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.manage'],
      body: UpdateSettingsBody,
      handler: async ({ body, req }) => {
        const c = ctx(req);
        return { data: await config.updateSettings(c.tenantId, body, c.actor) };
      },
    }),

    // ---- Periods: each section's school day, with subjects and teachers ----------------------
    defineRoute({
      method: 'get',
      path: '/timetable/periods',
      summary:
        'The periods of a section (section_id), of a class without sections (class_id + academic_year_id), or of the School default day (neither). Each lesson period has its subject, teacher and venue, and the state of every working day',
      tags: TAG_P,
      access: 'tenant',
      permissions: ['timetable.read'],
      query: OwnerQuery,
      handler: async ({ query, req }) => {
        const c = ctx(req);
        return { data: await periods.list(c.tenantId, query, c.principal) };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/periods',
      summary:
        'Add a period to a section / class (or the School default day). A LESSON period of a section or class needs subject_offering_id (and teacher_id when several teachers teach it); it is live on every working day at once. 422 PERIOD_OVERLAP, SCHEDULE_CLASH (teacher or venue busy), NO_TEACHING_ASSIGNMENT, AMBIGUOUS_TEACHER',
      tags: TAG_P,
      access: 'tenant',
      permissions: ['timetable.manage'],
      body: CreatePeriodBody,
      status: 201,
      handler: async ({ body, req }) => {
        const c = ctx(req);
        return { data: await periods.create(c.tenantId, body, c.principal, c.actor) };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/periods/copy',
      summary:
        'Give an empty section / class a school day by copying the period times of another section / class or the School default day ({ from: { template: true } }). Subjects and teachers are then set per period',
      tags: TAG_P,
      access: 'tenant',
      permissions: ['timetable.manage'],
      body: CopyPeriodsBody,
      status: 201,
      handler: async ({ body, req }) => {
        const c = ctx(req);
        return { data: await periods.copy(c.tenantId, body, c.principal, c.actor) };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/copy-year',
      summary:
        "Copy last year's timetable into a new academic year (sections matched by class + code). Subjects and teachers are kept where still offered / assigned; empty targets only. Needs school-wide access",
      tags: TAG_P,
      access: 'tenant',
      permissions: ['timetable.manage'],
      body: CopyYearBody,
      handler: async ({ body, req }) => {
        const c = ctx(req);
        return { data: await periods.copyYear(c.tenantId, body, c.principal, c.actor) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/timetable/status',
      summary:
        'Every section (and class without sections) of the year with how complete its timetable is: periods, lesson periods without a subject, lessons with a problem, clashes',
      tags: TAG_P,
      access: 'tenant',
      permissions: ['timetable.read'],
      query: StatusQuery,
      handler: async ({ query, req }) => {
        const c = ctx(req);
        return { data: await periods.status(c.tenantId, query, c.principal) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/timetable/periods/:id',
      summary: 'One period with its lesson and the state of every working day',
      tags: TAG_P,
      access: 'tenant',
      permissions: ['timetable.read'],
      params: IdParams,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        return { data: await periods.get(c.tenantId, params.id, c.principal) };
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/timetable/periods/:id',
      summary:
        'Edit a period: times, name, kind, or its subject / teacher / venue for every day (send the version you read). Weekday exceptions stay',
      tags: TAG_P,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      body: UpdatePeriodBody,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return { data: await periods.update(c.tenantId, params.id, body, c.principal, c.actor) };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/periods/:id/deactivate',
      summary: 'Deactivate a period: it stops giving lessons until reactivated',
      tags: TAG_P,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        return {
          data: await periods.setState(c.tenantId, params.id, 'INACTIVE', c.principal, c.actor),
        };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/periods/:id/activate',
      summary: 'Reactivate a period (must not overlap another active period, nor clash)',
      tags: TAG_P,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        return {
          data: await periods.setState(c.tenantId, params.id, 'ACTIVE', c.principal, c.actor),
        };
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/timetable/periods/:id',
      summary: 'Delete a period and its weekday exceptions',
      tags: TAG_P,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      status: 204,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        await periods.remove(c.tenantId, params.id, c.principal, c.actor);
      },
    }),
    defineRoute({
      method: 'put',
      path: '/timetable/periods/:id/days/:day',
      summary:
        "A weekday exception of a lesson period: on that weekday another subject / teacher / venue, or no lesson (subject_offering_id null). Setting it back to the period's own lesson removes the exception",
      tags: TAG_P,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: DayParams,
      body: SetDayBody,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return {
          data: await periods.setDay(c.tenantId, params.id, params.day, body, c.principal, c.actor),
        };
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/timetable/periods/:id/days/:day',
      summary: "Remove a weekday exception: that day follows the period's own lesson again",
      tags: TAG_P,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: DayParams,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        return {
          data: await periods.clearDay(c.tenantId, params.id, params.day, c.principal, c.actor),
        };
      },
    }),

    // ---- Configuration: venues -------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/timetable/venues',
      summary: 'List venues. Filters: status, venue_type, search (name, code)',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.read'],
      query: VenueListQuery,
      handler: async ({ query, req }) => config.listVenues(ctx(req).tenantId, query),
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/venues',
      summary: 'Create a venue (classroom, lab, hall …)',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.manage'],
      body: CreateVenueBody,
      status: 201,
      handler: async ({ body, req }) => {
        const c = ctx(req);
        return { data: await config.createVenue(c.tenantId, body, c.actor) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/timetable/venues/:id',
      summary: 'One venue',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await config.getVenue(ctx(req).tenantId, params.id),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/timetable/venues/:id',
      summary: 'Edit a venue (send the version you read). The code is fixed',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      body: UpdateVenueBody,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return { data: await config.updateVenue(c.tenantId, params.id, body, c.actor) };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/venues/:id/deactivate',
      summary: 'Deactivate a venue. Refused while a draft or published timetable uses it',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        return { data: await config.setVenueState(c.tenantId, params.id, 'INACTIVE', c.actor) };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/venues/:id/activate',
      summary: 'Reactivate a venue',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        return { data: await config.setVenueState(c.tenantId, params.id, 'ACTIVE', c.actor) };
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/timetable/venues/:id',
      summary: 'Delete a venue no timetable version has ever used',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      status: 204,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        await config.deleteVenue(c.tenantId, params.id, c.actor);
      },
    }),

    // ---- Views and reports (static paths before parameterised ones) -------------------------
    defineRoute({
      method: 'get',
      path: '/timetable/views/me',
      summary:
        "The signed-in teacher's weekly grid (login linked to a teacher record), from the live timetable of the current year",
      tags: TAG_V,
      access: 'tenant',
      permissions: ['timetable.read'],
      query: ViewQuery,
      handler: async ({ query, req }) => {
        const c = ctx(req);
        return { data: await views.mine(c.tenantId, query, c.principal) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/timetable/views/me/today',
      summary:
        "The signed-in teacher's lessons for a day (default: today in the school's time zone)",
      tags: TAG_V,
      access: 'tenant',
      permissions: ['timetable.read'],
      query: MyDayQuery,
      handler: async ({ query, req }) => {
        const c = ctx(req);
        return { data: await views.myDay(c.tenantId, query, c.principal) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/timetable/views/today',
      summary:
        "A day's schedule from the live timetable. Optional filters: section_id, teacher_id, venue_id",
      tags: TAG_V,
      access: 'tenant',
      permissions: ['timetable.read'],
      query: DayViewQuery,
      handler: async ({ query, req }) => {
        const c = ctx(req);
        return { data: await views.day(c.tenantId, query, c.principal) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/timetable/views/section/:section_id',
      summary:
        'Weekly grid of one section (days × its periods), with the state of every cell. Out-of-scope sections are 404',
      tags: TAG_V,
      access: 'tenant',
      permissions: ['timetable.read'],
      params: ViewSectionParams,
      query: ViewQuery,
      handler: async ({ params, query, req }) => {
        const c = ctx(req);
        return { data: await views.section(c.tenantId, params.section_id, query, c.principal) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/timetable/views/class/:class_id',
      summary:
        'Weekly grid of a class that has no sections (days × its periods). Query: academic_year_id. 422 CLASS_HAS_SECTIONS when the class has sections',
      tags: TAG_V,
      access: 'tenant',
      permissions: ['timetable.read'],
      params: ViewClassParams,
      query: ViewQuery,
      handler: async ({ params, query, req }) => {
        const c = ctx(req);
        return { data: await views.classView(c.tenantId, params.class_id, query, c.principal) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/timetable/views/teacher/:teacher_id',
      summary:
        "Weekly grid of one teacher across all sections (only sections in the caller's scope)",
      tags: TAG_V,
      access: 'tenant',
      permissions: ['timetable.read'],
      params: ViewTeacherParams,
      query: ViewQuery,
      handler: async ({ params, query, req }) => {
        const c = ctx(req);
        return { data: await views.teacherView(c.tenantId, params.teacher_id, query, c.principal) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/timetable/views/venue/:venue_id',
      summary: 'Weekly grid of one venue',
      tags: TAG_V,
      access: 'tenant',
      permissions: ['timetable.read'],
      params: ViewVenueParams,
      query: ViewQuery,
      handler: async ({ params, query, req }) => {
        const c = ctx(req);
        return { data: await views.venue(c.tenantId, params.venue_id, query, c.principal) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/timetable/workload',
      summary:
        'Lessons per week per teaching staff member, derived from the timetable (needs school-wide read access)',
      tags: TAG_V,
      access: 'tenant',
      permissions: ['timetable.read'],
      query: WorkloadQuery,
      handler: async ({ query, req }) => {
        const c = ctx(req);
        return { data: await views.workload(c.tenantId, query, c.principal) };
      },
    }),

    defineRoute({
      method: 'get',
      path: '/timetable/export',
      summary:
        'The live timetable as CSV (one row per lesson). Filters: academic_year_id, section_id, teacher_id, venue_id',
      tags: TAG_V,
      access: 'tenant',
      permissions: ['timetable.export'],
      query: ExportQuery,
      handler: async ({ query, req, res }) => {
        const c = ctx(req);
        const out = await views.exportCsv(c.tenantId, query, c.principal, c.actor);
        csv(res, out.filename, out.body);
      },
    }),
  ];
}
