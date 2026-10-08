import type { Request } from 'express';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import type { AcademicService } from './academic.service.js';
import {
  ActivateYearBody,
  ClassListQuery,
  CreateClassBody,
  ReorderClassesBody,
  CreateOfferingBody,
  CreateSectionBody,
  CreateSubjectBody,
  CreateYearBody,
  IdParams,
  OfferingListQuery,
  SectionListQuery,
  SubjectListQuery,
  UpdateClassBody,
  UpdateSectionBody,
  UpdateSubjectBody,
  UpdateYearBody,
  YearIdParams,
  YearListQuery,
} from './academic.schemas.js';

const tid = (req: Request) => req.ctx.tenant!.tenantId;
const READ = ['academics.read'];
const MANAGE = ['academics.manage'];

/** Academic years, classes, sections, subjects and subject offerings. */
export function academicRoutes(svc: AcademicService) {
  const TAG_Y = ['School · Academic years'];
  const TAG_C = ['School · Classes & sections'];
  const TAG_S = ['School · Subjects'];
  return [
    // ---- Academic years
    defineRoute({
      method: 'get',
      path: '/academic-years',
      summary: 'List academic years',
      tags: TAG_Y,
      access: 'tenant',
      permissions: READ,
      query: YearListQuery,
      handler: async ({ query, req }) => svc.listYears(tid(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/academic-years',
      summary: 'Create an academic year (starts as DRAFT)',
      tags: TAG_Y,
      access: 'tenant',
      permissions: MANAGE,
      body: CreateYearBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await svc.createYear(tid(req), body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/academic-years/:id',
      summary: 'Academic year detail',
      tags: TAG_Y,
      access: 'tenant',
      permissions: READ,
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await svc.getYear(tid(req), params.id) }),
    }),
    defineRoute({
      method: 'patch',
      path: '/academic-years/:id',
      summary: 'Edit an academic year (send the version you read)',
      tags: TAG_Y,
      access: 'tenant',
      permissions: MANAGE,
      params: IdParams,
      body: UpdateYearBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.updateYear(tid(req), params.id, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/academic-years/:id/open',
      summary: 'DRAFT → UPCOMING',
      tags: TAG_Y,
      access: 'tenant',
      permissions: MANAGE,
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await svc.openYear(tid(req), params.id, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/academic-years/:id/activate',
      summary: 'Make this the current academic year',
      tags: TAG_Y,
      access: 'tenant',
      permissions: MANAGE,
      params: IdParams,
      body: ActivateYearBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.activateYear(
          tid(req),
          params.id,
          body.complete_current,
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/academic-years/:id/complete',
      summary: 'Complete the active year (open enrollments are completed)',
      tags: TAG_Y,
      access: 'tenant',
      permissions: MANAGE,
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await svc.completeYear(tid(req), params.id, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/academic-years/:id/archive',
      summary: 'Archive a completed year',
      tags: TAG_Y,
      access: 'tenant',
      permissions: MANAGE,
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await svc.archiveYear(tid(req), params.id, actorFrom(req.ctx)),
      }),
    }),

    // ---- Classes
    defineRoute({
      method: 'get',
      path: '/academic-classes',
      summary: 'List classes / grades',
      tags: TAG_C,
      access: 'tenant',
      permissions: READ,
      query: ClassListQuery,
      handler: async ({ query, req }) => svc.listClasses(tid(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/academic-classes',
      summary: 'Create a class / grade',
      tags: TAG_C,
      access: 'tenant',
      permissions: MANAGE,
      body: CreateClassBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await svc.createClass(tid(req), body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/academic-classes/reorder',
      summary: 'Save a new class order (drag and drop)',
      tags: TAG_C,
      access: 'tenant',
      permissions: MANAGE,
      body: ReorderClassesBody,
      handler: async ({ body, req }) => ({
        data: await svc.reorderClasses(tid(req), body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/academic-classes/:id',
      summary: 'Class detail',
      tags: TAG_C,
      access: 'tenant',
      permissions: READ,
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await svc.getClass(tid(req), params.id) }),
    }),
    defineRoute({
      method: 'patch',
      path: '/academic-classes/:id',
      summary: 'Edit a class',
      tags: TAG_C,
      access: 'tenant',
      permissions: MANAGE,
      params: IdParams,
      body: UpdateClassBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.updateClass(tid(req), params.id, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/academic-classes/:id/archive',
      summary: 'Archive a class (blocked while students are enrolled)',
      tags: TAG_C,
      access: 'tenant',
      permissions: MANAGE,
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await svc.archiveClass(tid(req), params.id, actorFrom(req.ctx)),
      }),
    }),

    // ---- Sections
    defineRoute({
      method: 'get',
      path: '/sections',
      summary: 'List sections (filter by year and class); includes seats used',
      tags: TAG_C,
      access: 'tenant',
      permissions: READ,
      query: SectionListQuery,
      handler: async ({ query, req }) => svc.listSections(tid(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/academic-years/:yearId/sections',
      summary: 'Create a section of a class in this academic year',
      tags: TAG_C,
      access: 'tenant',
      permissions: MANAGE,
      params: YearIdParams,
      body: CreateSectionBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await svc.createSection(tid(req), params.yearId, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/sections/:id',
      summary: 'Section detail',
      tags: TAG_C,
      access: 'tenant',
      permissions: READ,
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await svc.getSection(tid(req), params.id) }),
    }),
    defineRoute({
      method: 'patch',
      path: '/sections/:id',
      summary: 'Edit a section name or capacity',
      tags: TAG_C,
      access: 'tenant',
      permissions: MANAGE,
      params: IdParams,
      body: UpdateSectionBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.updateSection(tid(req), params.id, body, actorFrom(req.ctx)),
      }),
    }),
    ...(['activate', 'close', 'archive'] as const).map((command) =>
      defineRoute({
        method: 'post',
        path: `/sections/:id/${command}`,
        summary: {
          activate: 'Open a draft or closed section for enrollment',
          close: 'Close a section to new enrollments',
          archive: 'Archive an empty section',
        }[command],
        tags: TAG_C,
        access: 'tenant',
        permissions: MANAGE,
        params: IdParams,
        handler: async ({ params, req }) => ({
          data: await svc.transitionSection(tid(req), params.id, command, actorFrom(req.ctx)),
        }),
      }),
    ),

    // ---- Subjects
    defineRoute({
      method: 'get',
      path: '/subjects',
      summary: 'List subjects',
      tags: TAG_S,
      access: 'tenant',
      permissions: READ,
      query: SubjectListQuery,
      handler: async ({ query, req }) => svc.listSubjects(tid(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/subjects',
      summary: 'Create a subject',
      tags: TAG_S,
      access: 'tenant',
      permissions: MANAGE,
      body: CreateSubjectBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await svc.createSubject(tid(req), body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/subjects/:id',
      summary: 'Subject detail',
      tags: TAG_S,
      access: 'tenant',
      permissions: READ,
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await svc.getSubject(tid(req), params.id) }),
    }),
    defineRoute({
      method: 'patch',
      path: '/subjects/:id',
      summary: 'Edit a subject',
      tags: TAG_S,
      access: 'tenant',
      permissions: MANAGE,
      params: IdParams,
      body: UpdateSubjectBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.updateSubject(tid(req), params.id, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/subjects/:id/archive',
      summary: 'Archive a subject (its offerings are deactivated)',
      tags: TAG_S,
      access: 'tenant',
      permissions: MANAGE,
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await svc.archiveSubject(tid(req), params.id, actorFrom(req.ctx)),
      }),
    }),

    // ---- Subject offerings
    defineRoute({
      method: 'get',
      path: '/subject-offerings',
      summary: 'List subject offerings (subject × year × class [× section])',
      tags: TAG_S,
      access: 'tenant',
      permissions: READ,
      query: OfferingListQuery,
      handler: async ({ query, req }) => svc.listOfferings(tid(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/subject-offerings',
      summary: 'Offer a subject to a class (or one section) in an academic year',
      tags: TAG_S,
      access: 'tenant',
      permissions: MANAGE,
      body: CreateOfferingBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await svc.createOffering(tid(req), body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/subject-offerings/:id',
      summary: 'Subject offering detail',
      tags: TAG_S,
      access: 'tenant',
      permissions: READ,
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await svc.getOffering(tid(req), params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/subject-offerings/:id/deactivate',
      summary: 'Stop offering the subject (history is kept)',
      tags: TAG_S,
      access: 'tenant',
      permissions: MANAGE,
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await svc.setOfferingStatus(tid(req), params.id, 'INACTIVE', actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/subject-offerings/:id/activate',
      summary: 'Offer the subject again',
      tags: TAG_S,
      access: 'tenant',
      permissions: MANAGE,
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await svc.setOfferingStatus(tid(req), params.id, 'ACTIVE', actorFrom(req.ctx)),
      }),
    }),
  ];
}
