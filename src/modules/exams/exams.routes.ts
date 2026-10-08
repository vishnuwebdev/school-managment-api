import type { Request } from 'express';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import { GRADE_SCALE, type ExamService } from './exams.service.js';
import {
  AddClassesBody,
  ClassParams,
  CreateExamBody,
  CreatePaperBody,
  ExamListQuery,
  IdParams,
  PaperListQuery,
  PaperParams,
  PublishBody,
  ResultsQuery,
  SaveMarksBody,
  StudentParams,
  UpdateExamBody,
  UpdatePaperBody,
} from './exams.schemas.js';

const ctx = (req: Request) => ({
  tenantId: req.ctx.tenant!.tenantId,
  actor: actorFrom(req.ctx),
});

const TAG = ['School · Examinations'];

export function examRoutes(svc: ExamService) {
  return [
    defineRoute({
      method: 'get',
      path: '/exams',
      summary: 'Exams with their progress (stage, papers, marks entered). Filters: status, year_id',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.read'],
      query: ExamListQuery,
      handler: async ({ query, req }) => ({ data: await svc.list(ctx(req).tenantId, query) }),
    }),
    defineRoute({
      method: 'get',
      path: '/exams/grading-scale',
      summary: 'The grading scale used to turn percentages into grades',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.read'],
      handler: async () => ({ data: GRADE_SCALE }),
    }),
    defineRoute({
      method: 'post',
      path: '/exams',
      summary:
        'Create an exam for some classes. A paper is created for every subject each class studies',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.manage'],
      body: CreateExamBody,
      status: 201,
      handler: async ({ body, req }) => {
        const c = ctx(req);
        return { data: await svc.create(c.tenantId, body, c.actor) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/exams/:id',
      summary: 'One exam with progress per class',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await svc.get(ctx(req).tenantId, params.id) }),
    }),
    defineRoute({
      method: 'patch',
      path: '/exams/:id',
      summary: 'Rename an exam or change its dates (send the version you read)',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.manage'],
      params: IdParams,
      body: UpdateExamBody,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return { data: await svc.update(c.tenantId, params.id, body, c.actor) };
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/exams/:id',
      summary: 'Delete an exam and its papers and marks. Refused once published',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.manage'],
      params: IdParams,
      status: 204,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        await svc.remove(c.tenantId, params.id, c.actor);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/exams/:id/classes',
      summary: 'Add classes to an exam (papers are created for their subjects)',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.manage'],
      params: IdParams,
      body: AddClassesBody,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return { data: await svc.addClasses(c.tenantId, params.id, body, c.actor) };
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/exams/:id/classes/:class_id',
      summary: 'Remove a class from an exam, with its papers and marks',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.manage'],
      params: ClassParams,
      status: 204,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        await svc.removeClass(c.tenantId, params.id, params.class_id, c.actor);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/exams/:id/papers',
      summary: 'Papers of an exam with date, marks and entry progress. Filter: class_id',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.read'],
      params: IdParams,
      query: PaperListQuery,
      handler: async ({ params, query, req }) => ({
        data: await svc.listPapers(ctx(req).tenantId, params.id, query.class_id),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/exams/:id/papers',
      summary: 'Add one paper (a subject in a class)',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.manage'],
      params: IdParams,
      body: CreatePaperBody,
      status: 201,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return { data: await svc.createPaper(c.tenantId, params.id, body, c.actor) };
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/exams/papers/:paper_id',
      summary: 'Set a paper’s date, maximum or pass marks',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.manage'],
      params: PaperParams,
      body: UpdatePaperBody,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return { data: await svc.updatePaper(c.tenantId, params.paper_id, body, c.actor) };
      },
    }),
    defineRoute({
      method: 'delete',
      path: '/exams/papers/:paper_id',
      summary: 'Delete a paper and its marks',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.manage'],
      params: PaperParams,
      status: 204,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        await svc.deletePaper(c.tenantId, params.paper_id, c.actor);
      },
    }),
    defineRoute({
      method: 'get',
      path: '/exams/papers/:paper_id/marks',
      summary: 'The class list for a paper with each student’s marks',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.read'],
      params: PaperParams,
      handler: async ({ params, req }) => ({
        data: await svc.getMarks(ctx(req).tenantId, params.paper_id),
      }),
    }),
    defineRoute({
      method: 'put',
      path: '/exams/papers/:paper_id/marks',
      summary: 'Save marks (or absent) for students of a paper. Blank clears a mark',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.marks.enter'],
      params: PaperParams,
      body: SaveMarksBody,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return { data: await svc.saveMarks(c.tenantId, params.paper_id, body, c.actor) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/exams/:id/results',
      summary: 'Results of one class: totals, grades, ranks and subject analysis',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.read'],
      params: IdParams,
      query: ResultsQuery,
      handler: async ({ params, query, req }) => ({
        data: await svc.results(ctx(req).tenantId, params.id, query.class_id),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/exams/:id/readiness',
      summary: 'What is still missing before the results can be published',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await svc.readiness(ctx(req).tenantId, params.id),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/exams/:id/publish',
      summary: 'Publish the results and lock the marks. Missing marks need allow_incomplete',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.results.publish'],
      params: IdParams,
      body: PublishBody,
      handler: async ({ params, body, req }) => {
        const c = ctx(req);
        return { data: await svc.publish(c.tenantId, params.id, body, c.actor) };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/exams/:id/unpublish',
      summary: 'Reopen a published exam so marks can be corrected',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.results.publish'],
      params: IdParams,
      handler: async ({ params, req }) => {
        const c = ctx(req);
        return { data: await svc.unpublish(c.tenantId, params.id, c.actor) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/students/:id/exams',
      summary: 'A student’s published exam results',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.read'],
      params: StudentParams,
      handler: async ({ params, req }) => ({
        data: await svc.forStudent(ctx(req).tenantId, params.id),
      }),
    }),
  ];
}
