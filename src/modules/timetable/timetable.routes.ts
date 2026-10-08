import type { Request, Response } from 'express';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import type { TimetableConfigService } from './config.service.js';
import type { EntryService } from './entries.service.js';
import type { TimetableService } from './timetables.service.js';
import {
  ArchiveBody,
  CheckQuery,
  CreateEntryBody,
  CreatePeriodBody,
  CreateTimetableBody,
  CreateVenueBody,
  DayViewQuery,
  DeleteEntryQuery,
  DuplicateTimetableBody,
  EntryListQuery,
  ExportQuery,
  IdParams,
  MyDayQuery,
  PeriodListQuery,
  PublishBody,
  SaveGridBody,
  SectionParams,
  TimetableListQuery,
  UpdateEntryBody,
  UpdatePeriodBody,
  UpdateSettingsBody,
  UpdateTimetableBody,
  UpdateVenueBody,
  VenueListQuery,
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
const TAG_T = ['School · Timetables'];
const TAG_E = ['School · Timetable entries'];
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
  timetables: TimetableService,
  entries: EntryService,
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
        'Change the teaching days (send the version you read). Refused while a draft or published timetable has lessons on a day being removed',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.manage'],
      body: UpdateSettingsBody,
      handler: async ({ body, req }) => {
        const c = ctx(req);
        return { data: await config.updateSettings(c.tenantId, body, c.actor) };
      },
    }),

    // ---- Configuration: periods (bell schedule) --------------------------------------------
    defineRoute({
      method: 'get',
      path: '/timetable/periods',
      summary: 'The school day: periods ordered by start time. Filters: status, kind',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.read'],
      query: PeriodListQuery,
      handler: async ({ query, req }) => ({
        data: await config.listPeriods(ctx(req).tenantId, query),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/periods',
      summary: 'Create a period (LESSON, BREAK, LUNCH, ASSEMBLY or CUSTOM). Active periods cannot overlap',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.manage'],
      body: CreatePeriodBody,
      status: 201,
      handler: async ({ body, req }) => {
        const c = ctx(req);
        return { data: await config.createPeriod(c.tenantId, body, c.actor) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/timetable/periods/:id',
      summary: 'One period',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await config.getPeriod(ctx(req).tenantId, params.id),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/timetable/periods/:id',
      summary: 'Edit a period (send the version you read). The code is fixed',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      body: UpdatePeriodBody,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return { data: await config.updatePeriod(c.tenantId, params.id, body, c.actor) };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/periods/:id/deactivate',
      summary:
        'Deactivate a period. Refused while a draft or published timetable has lessons in it',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        return { data: await config.setPeriodState(c.tenantId, params.id, 'INACTIVE', c.actor) };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/periods/:id/activate',
      summary: 'Reactivate a period (must not overlap another active period)',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        return { data: await config.setPeriodState(c.tenantId, params.id, 'ACTIVE', c.actor) };
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/timetable/periods/:id',
      summary: 'Delete a period that no timetable version has ever used',
      tags: TAG_CFG,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      status: 204,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        await config.deletePeriod(c.tenantId, params.id, c.actor);
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
        "The signed-in teacher's weekly grid (login linked to a teacher record). Defaults to the published timetable of the active year",
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
        "A day's schedule, period by period, from the version that was effective on that date. Optional filters: section_id, teacher_id, venue_id",
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
        'Weekly grid of one section (days × periods). Query: timetable_id, academic_year_id. Out-of-scope sections are 404',
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

    // ---- Timetable versions ------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/timetable/timetables',
      summary:
        'List timetable versions (newest year first). Drafts are only listed for holders of timetable.manage / timetable.publish. Filters: academic_year_id, status',
      tags: TAG_T,
      access: 'tenant',
      permissions: ['timetable.read'],
      query: TimetableListQuery,
      handler: async ({ query, req }) => {
        const c = ctx(req);
        return timetables.list(c.tenantId, query, c.principal);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/timetables',
      summary:
        'Create a DRAFT version for an upcoming or active academic year, optionally copying the entries of another version of the same year (copy_from_id)',
      tags: TAG_T,
      access: 'tenant',
      permissions: ['timetable.manage'],
      body: CreateTimetableBody,
      status: 201,
      handler: async ({ body, req }) => {
        const c = ctx(req);
        return { data: await timetables.create(c.tenantId, body, c.principal, c.actor) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/timetable/timetables/:id',
      summary: 'One timetable version with its entry count',
      tags: TAG_T,
      access: 'tenant',
      permissions: ['timetable.read'],
      params: IdParams,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        return { data: await timetables.get(c.tenantId, params.id, c.principal) };
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/timetable/timetables/:id',
      summary: 'Edit name, dates or notes of a DRAFT (send the version you read)',
      tags: TAG_T,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      body: UpdateTimetableBody,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return { data: await timetables.update(c.tenantId, params.id, body, c.principal, c.actor) };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/timetables/:id/duplicate',
      summary: 'Create a new DRAFT version that starts as a copy of this one (any status)',
      tags: TAG_T,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      body: DuplicateTimetableBody,
      status: 201,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return {
          data: await timetables.duplicate(c.tenantId, params.id, body, c.principal, c.actor),
        };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/timetables/:id/publish',
      summary:
        'Publish a DRAFT: validates clashes and references (422 PUBLISH_BLOCKED lists the blocking issues) and archives the version published before. `meta.warnings` lists non-blocking findings',
      tags: TAG_T,
      access: 'tenant',
      permissions: ['timetable.publish'],
      params: IdParams,
      body: PublishBody,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        const res = await timetables.publish(c.tenantId, params.id, body, c.principal, c.actor);
        return { data: res.timetable, meta: { warnings: res.warnings } };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/timetables/:id/archive',
      summary: 'Archive a DRAFT or PUBLISHED version. Archived versions are read-only history',
      tags: TAG_T,
      access: 'tenant',
      permissions: ['timetable.publish'],
      params: IdParams,
      body: ArchiveBody,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return {
          data: await timetables.archive(c.tenantId, params.id, body, c.principal, c.actor),
        };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/timetable/timetables/:id/check',
      summary:
        'Clash and validity report: blocking issues (teacher / section / venue clashes, broken references) and warnings (unscheduled sections, empty slots, venue capacity). Needs school-wide read access',
      tags: TAG_T,
      access: 'tenant',
      permissions: ['timetable.read'],
      params: IdParams,
      query: CheckQuery,
      handler: async ({ params, query, req }) => {
        const c = ctx(req);
        return {
          data: await timetables.check(c.tenantId, params.id, c.principal, query.strict ?? false),
        };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/timetable/timetables/:id/export',
      summary:
        'Download the timetable as CSV (formula-injection safe). Optional filters: section_id, teacher_id, venue_id',
      tags: TAG_T,
      access: 'tenant',
      permissions: ['timetable.export'],
      params: IdParams,
      query: ExportQuery,
      handler: async ({ params, query, req, res }) => {
        const c = ctx(req);
        const out = await views.exportCsv(c.tenantId, params.id, query, c.principal, c.actor);
        csv(res, out.filename, out.body);
      },
    }),

    // ---- Entries -------------------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/timetable/timetables/:id/entries',
      summary:
        'List entries of a version (paginated, page_size up to 500). Filters: section_id, class_id, teacher_id, venue_id, period_id, day_of_week',
      tags: TAG_E,
      access: 'tenant',
      permissions: ['timetable.read'],
      params: IdParams,
      query: EntryListQuery,
      handler: async ({ params, query, req }) => {
        const c = ctx(req);
        return entries.list(c.tenantId, params.id, query, c.principal);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/timetable/timetables/:id/entries',
      summary:
        'Schedule one lesson in a DRAFT. Send subject_offering_id (+ teacher_id when several teachers share the offering) or teaching_assignment_id. 409 CONFLICT with details.clashes when the section, teacher or venue is already booked',
      tags: TAG_E,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      body: CreateEntryBody,
      status: 201,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return { data: await entries.create(c.tenantId, params.id, body, c.principal, c.actor) };
      },
    }),
    defineRoute({
      method: 'put',
      path: '/timetable/timetables/:id/sections/:section_id/grid',
      summary:
        "Save cells of one section's grid in ONE transaction (all cells or none). A cell with subject_offering_id null clears the slot; replace=true removes entries not listed. Rejected cells are listed in details.cells",
      tags: TAG_E,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: SectionParams,
      body: SaveGridBody,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return {
          data: await entries.saveGrid(
            c.tenantId,
            params.id,
            params.section_id,
            body,
            c.principal,
            c.actor,
          ),
        };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/timetable/entries/:id',
      summary: 'One entry',
      tags: TAG_E,
      access: 'tenant',
      permissions: ['timetable.read'],
      params: IdParams,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        return { data: await entries.get(c.tenantId, params.id, c.principal) };
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/timetable/entries/:id',
      summary: 'Move or change a lesson of a DRAFT (send the version you read)',
      tags: TAG_E,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      body: UpdateEntryBody,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return { data: await entries.update(c.tenantId, params.id, body, c.principal, c.actor) };
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/timetable/entries/:id',
      summary: 'Remove a lesson from a DRAFT (optional ?version= check)',
      tags: TAG_E,
      access: 'tenant',
      permissions: ['timetable.manage'],
      params: IdParams,
      query: DeleteEntryQuery,
      status: 204,
      handler: async ({ params, query, req }) => {
        const c = ctx(req);
        await entries.remove(c.tenantId, params.id, query.version, c.principal, c.actor);
      },
    }),
  ];
}
