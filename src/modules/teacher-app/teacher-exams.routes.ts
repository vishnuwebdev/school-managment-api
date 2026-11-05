import type { Request } from 'express';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import type { Caller } from '../attendance/support.js';
import type { TeacherExamService } from './teacher-exams.service.js';
import {
  CreateTestBody,
  DutiesRangeQuery,
  ExamIdParams,
  PaperIdParams,
  SubmitMarksBody,
  TeacherMarksBody,
} from './teacher-exams.schemas.js';

/**
 * Exams and marks in the teacher app (`/api/v1/teacher/*`). Same gate as the other
 * teacher routes (`teacher_app.use` on the paid `teachers.mobile_app` feature) plus the
 * office's exam permissions; the section/subject rule lives in TeacherExamService.
 */
const APP = 'teacher_app.use';
const TAG = ['Teacher app'];

const caller = (req: Request): Caller => ({
  tenantId: req.ctx.tenant!.tenantId,
  principal: req.ctx.principal!,
  actor: actorFrom(req.ctx),
  features: req.ctx.tenant!.entitlements.features,
});

export function teacherExamRoutes(svc: TeacherExamService) {
  return [
    defineRoute({
      method: 'get',
      path: '/teacher/exams',
      summary:
        'My exams: papers I can mark (subjects I teach, papers I mark for the office, my own tests) with my sections’ progress',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'exams.read'],
      handler: async ({ req }) => ({ data: await svc.list(caller(req)) }),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/exam-duties',
      summary: 'My exam duties: sittings I invigilate and papers I mark',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'exams.read'],
      query: DutiesRangeQuery,
      handler: async ({ query, req }) => ({ data: await svc.duties(caller(req), query) }),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/exams/:examId/timetable',
      summary: 'The timetable of an exam I mark or have a duty in',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'exams.read'],
      params: ExamIdParams,
      handler: async ({ params, req }) => ({
        data: await svc.examTimetable(caller(req), params.examId),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/papers/:paperId/marks',
      summary: 'A paper’s class list for my sections only, with each section’s hand-in state',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'exams.read'],
      params: PaperIdParams,
      handler: async ({ params, req }) => ({ data: await svc.marks(caller(req), params.paperId) }),
    }),
    defineRoute({
      method: 'put',
      path: '/teacher/papers/:paperId/marks',
      summary:
        'Save marks (draft) for students in my sections. Blank clears a mark. Handed-in sections are locked',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'exams.marks.enter'],
      params: PaperIdParams,
      body: TeacherMarksBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.saveMarks(caller(req), params.paperId, body),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/teacher/papers/:paperId/submit',
      summary: 'Hand a section’s marks in to the office. Every student needs a mark or absent',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'exams.marks.enter'],
      params: PaperIdParams,
      body: SubmitMarksBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.submit(caller(req), params.paperId, body.section_id),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/teacher/tests',
      summary: 'Set my own test for one section and a subject I teach there',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'exams.marks.enter'],
      body: CreateTestBody,
      status: 201,
      handler: async ({ body, req }) => ({ data: await svc.createTest(caller(req), body) }),
    }),
    defineRoute({
      method: 'delete',
      path: '/teacher/tests/:examId',
      summary: 'Delete my own test (only before it is handed in and results are published)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP, 'exams.marks.enter'],
      params: ExamIdParams,
      status: 204,
      handler: async ({ params, req }) => {
        await svc.deleteTest(caller(req), params.examId);
      },
    }),
  ];
}
