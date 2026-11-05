import type { Request } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import type { TeacherAppService } from '../teacher-app/teacher-app.service.js';
import { RemarkListQuery, SaveRemarksBody, type ExamRemarkService } from './remarks.service.js';

const IdParams = z.object({ id: z.uuid() });
const tid = (req: Request) => req.ctx.tenant!.tenantId;

/** Admin panel: report-card remarks for an exam. */
export function examRemarkRoutes(svc: ExamRemarkService) {
  const TAG = ['School · Examinations'];
  return [
    defineRoute({
      method: 'get',
      path: '/exams/:id/remarks',
      summary: "Report-card remarks of an exam's students (filter by class_id / section_id)",
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.read'],
      params: IdParams,
      query: RemarkListQuery,
      handler: async ({ params, query, req }) =>
        svc.list(tid(req), params.id, query, { kind: 'office', principal: req.ctx.principal! }),
    }),
    defineRoute({
      method: 'put',
      path: '/exams/:id/remarks',
      summary:
        'Write report-card remarks (empty text removes one). Parents see a remark when share_with_parent is on and results are published.',
      tags: TAG,
      access: 'tenant',
      permissions: ['exams.remarks.write'],
      params: IdParams,
      body: SaveRemarksBody,
      handler: async ({ params, body, req }) =>
        svc.save(
          tid(req),
          params.id,
          body,
          { kind: 'office', principal: req.ctx.principal! },
          actorFrom(req.ctx),
        ),
    }),
  ];
}

/** Teacher app: the class teacher's remarks for their own sections. */
export function teacherRemarkRoutes(svc: ExamRemarkService, app: TeacherAppService) {
  const TAG = ['Teacher app'];
  const PERMS = ['teacher_app.use', 'exams.remarks.write'];
  const Params = z.object({ examId: z.uuid() });
  const who = async (req: Request) => ({
    kind: 'teacher' as const,
    teacherId: (await app.myTeacher(tid(req), req.ctx.principal!)).id,
  });
  return [
    defineRoute({
      method: 'get',
      path: '/teacher/exams/:examId/remarks',
      summary: 'Report-card remarks for the students of the sections I am class teacher of',
      tags: TAG,
      access: 'tenant',
      permissions: PERMS,
      params: Params,
      query: RemarkListQuery,
      handler: async ({ params, query, req }) =>
        svc.list(tid(req), params.examId, query, await who(req)),
    }),
    defineRoute({
      method: 'put',
      path: '/teacher/exams/:examId/remarks',
      summary:
        'Write report-card remarks (class teacher only). Turn on share_with_parent for the parent to see it.',
      tags: TAG,
      access: 'tenant',
      permissions: PERMS,
      params: Params,
      body: SaveRemarksBody,
      handler: async ({ params, body, req }) =>
        svc.save(tid(req), params.examId, body, await who(req), actorFrom(req.ctx)),
    }),
  ];
}
