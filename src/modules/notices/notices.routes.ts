import { and, eq, inArray } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { academicSections, academicYears } from '../../db/schema/index.js';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import type { ExamRemarkService } from '../exams/remarks.service.js';
import { fileHeaders } from '../files/files.service.js';
import type { TeacherAppService } from '../teacher-app/teacher-app.service.js';
import type { ClassTeacherService } from '../teachers/class-teachers.service.js';
import type { Author, NoticeService } from './notices.service.js';
import {
  AttachmentQuery,
  CancelNoticeBody,
  CreateNoticeBody,
  NoticeListQuery,
  UpdateNoticeBody,
} from './notices.schemas.js';

const IdParams = z.object({ id: z.uuid() });
const tid = (req: Request) => req.ctx.tenant!.tenantId;
const OFFICE: Author = { kind: 'office' };

const sendFile = (
  res: Response,
  f: { mime: string; data: Buffer; checksum: string; name: string },
) => {
  res.status(200).set(fileHeaders(f)).end(f.data);
  return undefined;
};

const READ = 'communication.read';
const MANAGE = 'communication.announcements.manage';
const TAG = ['School · Notices'];

/** Admin panel: notices for parents (whole school, classes or sections). */
export function noticeRoutes(svc: NoticeService) {
  return [
    defineRoute({
      method: 'get',
      path: '/notices',
      summary: 'Notices for parents, newest first, with read and acknowledgement counts',
      tags: TAG,
      access: 'tenant',
      permissions: [READ],
      query: NoticeListQuery,
      handler: async ({ query, req }) => svc.list(tid(req), query, OFFICE),
    }),
    defineRoute({
      method: 'post',
      path: '/notices',
      summary:
        'Post a notice, circular, announcement or event to parents (whole school, classes or sections), now or at publish_at',
      tags: TAG,
      access: 'tenant',
      permissions: [MANAGE],
      body: CreateNoticeBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await svc.create(tid(req), body, OFFICE, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/notices/:id',
      summary: 'One notice',
      tags: TAG,
      access: 'tenant',
      permissions: [READ],
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await svc.get(tid(req), params.id, OFFICE) }),
    }),
    defineRoute({
      method: 'patch',
      path: '/notices/:id',
      summary: 'Edit a notice (send the version you read)',
      tags: TAG,
      access: 'tenant',
      permissions: [MANAGE],
      params: IdParams,
      body: UpdateNoticeBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.update(tid(req), params.id, body, OFFICE, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/notices/:id/cancel',
      summary: 'Withdraw a notice (it disappears from the parent app)',
      tags: TAG,
      access: 'tenant',
      permissions: [MANAGE],
      params: IdParams,
      body: CancelNoticeBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.cancel(tid(req), params.id, body.reason, OFFICE, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/notices/:id/receipts',
      summary: 'Parents who read / acknowledged the notice',
      tags: TAG,
      access: 'tenant',
      permissions: [READ],
      params: IdParams,
      handler: async ({ params, req }) => svc.receipts(tid(req), params.id, OFFICE),
    }),
    defineRoute({
      method: 'put',
      path: '/notices/:id/attachment',
      summary:
        'Attach a file (PDF, PNG, JPEG or WebP, up to 5 MB): the raw body with its content-type, and ?filename=',
      tags: TAG,
      access: 'tenant',
      permissions: [MANAGE],
      params: IdParams,
      query: AttachmentQuery,
      body: z.any(),
      handler: async ({ params, query, body, req }) => ({
        data: await svc.setAttachment(
          tid(req),
          params.id,
          body,
          query.filename,
          OFFICE,
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'delete',
      path: '/notices/:id/attachment',
      summary: 'Remove the attachment',
      tags: TAG,
      access: 'tenant',
      permissions: [MANAGE],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await svc.removeAttachment(tid(req), params.id, OFFICE, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/notices/:id/attachment',
      summary: 'Download the attachment',
      tags: TAG,
      access: 'tenant',
      permissions: [READ],
      params: IdParams,
      handler: async ({ params, req, res }) =>
        sendFile(res, await svc.attachment(tid(req), params.id, OFFICE)),
    }),
  ];
}

const APP = 'teacher_app.use';
const POST = 'communication.notices.post';
const T_TAG = ['Teacher app'];

export interface TeacherNoticeDeps {
  notices: NoticeService;
  app: TeacherAppService;
  classTeachers: ClassTeacherService;
  remarks: ExamRemarkService;
  db: Database;
}

/**
 * Sections a teacher may post to: class-teacher sections, sections they teach, and every
 * section of a class they teach or are class teacher of as a whole (live years).
 */
async function teacherSectionIds(d: TeacherNoticeDeps, req: Request, teacherId: string) {
  const tenantId = tid(req);
  const [mine, ct] = await Promise.all([
    d.classTeachers.mine(tenantId, req.ctx.principal!),
    d.remarks.classTeacherOf(tenantId, teacherId),
  ]);
  const out = new Set<string>([
    ...mine.class_teacher_of.map((s) => s.section_id),
    ...mine.teaching.map((t) => t.section_id).filter((x): x is string => !!x),
    ...ct.sectionIds,
  ]);
  const wholeClasses = new Set<string>([
    ...mine.teaching.filter((t) => !t.section_id).map((t) => t.class_id),
    ...[...ct.classKeys].map((k) => k.split(':')[0]!),
  ]);
  if (wholeClasses.size) {
    const secs = await d.db
      .select({ id: academicSections.id })
      .from(academicSections)
      .innerJoin(academicYears, eq(academicYears.id, academicSections.academicYearId))
      .where(
        and(
          eq(academicSections.tenantId, tenantId),
          inArray(academicSections.classId, [...wholeClasses]),
          inArray(academicYears.status, ['ACTIVE', 'UPCOMING']),
        ),
      );
    for (const s of secs) out.add(s.id);
  }
  return out;
}

/** Teacher app: notices a teacher posts to parents of their own sections. */
export function teacherNoticeRoutes(d: TeacherNoticeDeps) {
  const author = async (req: Request): Promise<Author> => {
    const t = await d.app.myTeacher(tid(req), req.ctx.principal!);
    return {
      kind: 'teacher',
      teacherId: t.id,
      name: t.fullName,
      sectionIds: await teacherSectionIds(d, req, t.id),
    };
  };
  return [
    defineRoute({
      method: 'get',
      path: '/teacher/notices/sections',
      summary: 'Sections I can post notices to',
      tags: T_TAG,
      access: 'tenant',
      permissions: [APP, POST],
      handler: async ({ req }) => {
        const a = await author(req);
        const ids = a.kind === 'teacher' ? [...a.sectionIds] : [];
        return { data: { section_ids: ids } };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/notices',
      summary: 'Notices I posted to parents',
      tags: T_TAG,
      access: 'tenant',
      permissions: [APP, POST],
      query: NoticeListQuery,
      handler: async ({ query, req }) => d.notices.list(tid(req), query, await author(req)),
    }),
    defineRoute({
      method: 'post',
      path: '/teacher/notices',
      summary: 'Post a notice to parents of my sections (audience SECTIONS)',
      tags: T_TAG,
      access: 'tenant',
      permissions: [APP, POST],
      body: CreateNoticeBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await d.notices.create(tid(req), body, await author(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/notices/:id',
      summary: 'One of my notices, with read and acknowledgement counts',
      tags: T_TAG,
      access: 'tenant',
      permissions: [APP, POST],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await d.notices.get(tid(req), params.id, await author(req)),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/teacher/notices/:id',
      summary: 'Edit one of my notices',
      tags: T_TAG,
      access: 'tenant',
      permissions: [APP, POST],
      params: IdParams,
      body: UpdateNoticeBody,
      handler: async ({ params, body, req }) => ({
        data: await d.notices.update(
          tid(req),
          params.id,
          body,
          await author(req),
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/teacher/notices/:id/cancel',
      summary: 'Withdraw one of my notices',
      tags: T_TAG,
      access: 'tenant',
      permissions: [APP, POST],
      params: IdParams,
      body: CancelNoticeBody,
      handler: async ({ params, body, req }) => ({
        data: await d.notices.cancel(
          tid(req),
          params.id,
          body.reason,
          await author(req),
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/teacher/notices/:id/receipts',
      summary: 'Parents who read / acknowledged my notice',
      tags: T_TAG,
      access: 'tenant',
      permissions: [APP, POST],
      params: IdParams,
      handler: async ({ params, req }) =>
        d.notices.receipts(tid(req), params.id, await author(req)),
    }),
    defineRoute({
      method: 'put',
      path: '/teacher/notices/:id/attachment',
      summary: 'Attach a file to my notice (PDF or image, up to 5 MB, raw body), ?filename=',
      tags: T_TAG,
      access: 'tenant',
      permissions: [APP, POST],
      params: IdParams,
      query: AttachmentQuery,
      body: z.any(),
      handler: async ({ params, query, body, req }) => ({
        data: await d.notices.setAttachment(
          tid(req),
          params.id,
          body,
          query.filename,
          await author(req),
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'delete',
      path: '/teacher/notices/:id/attachment',
      summary: 'Remove the attachment from my notice',
      tags: T_TAG,
      access: 'tenant',
      permissions: [APP, POST],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await d.notices.removeAttachment(
          tid(req),
          params.id,
          await author(req),
          actorFrom(req.ctx),
        ),
      }),
    }),
  ];
}
