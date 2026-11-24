import type { Request } from 'express';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import type { TeacherAppService } from '../teacher-app/teacher-app.service.js';
import type { TeacherNotificationService } from './teacher-notifications.service.js';
import {
  CreateNotificationBody,
  NotificationIdParams,
  NotificationListQuery,
  ReadNotificationsBody,
} from './teacher-notifications.schemas.js';

const TAG = ['Teacher notifications'];
const MANAGE = 'teachers.notifications.manage';

const tid = (req: Request) => req.ctx.tenant!.tenantId;

/** Office side (admin panel). */
export function teacherNotificationRoutes(svc: TeacherNotificationService) {
  return [
    defineRoute({
      method: 'get',
      path: '/teacher-notifications',
      summary:
        'Notifications sent or scheduled for teachers, newest first, with how many have read each',
      tags: TAG,
      access: 'tenant',
      permissions: [MANAGE],
      query: NotificationListQuery,
      handler: async ({ query, req }) => svc.list(tid(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/teacher-notifications',
      summary: 'Send a notification to all teachers or chosen teachers, now or at a set time',
      tags: TAG,
      access: 'tenant',
      permissions: [MANAGE],
      body: CreateNotificationBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await svc.create(tid(req), body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/teacher-notifications/:id/cancel',
      summary:
        'Withdraw a notification (a scheduled one is never shown; a sent one leaves the app)',
      tags: TAG,
      access: 'tenant',
      permissions: [MANAGE],
      params: NotificationIdParams,
      status: 204,
      handler: async ({ params, req }) => {
        await svc.cancel(tid(req), params.id, actorFrom(req.ctx));
      },
    }),
  ];
}

/** Teacher app side (`/teacher/*`). */
export function teacherAppNotificationRoutes(
  svc: TeacherNotificationService,
  app: TeacherAppService,
) {
  const myId = async (req: Request) => (await app.myTeacher(tid(req), req.ctx.principal!)).id;
  return [
    defineRoute({
      method: 'get',
      path: '/teacher/notifications',
      summary: 'Notifications the office has sent me (latest 100) with read state',
      tags: ['Teacher app'],
      access: 'tenant',
      permissions: ['teacher_app.use', 'teachers.read'],
      handler: async ({ req }) => ({ data: await svc.mine(tid(req), await myId(req)) }),
    }),
    defineRoute({
      method: 'post',
      path: '/teacher/notifications/read',
      summary: 'Mark some (ids) or all of my notifications read',
      tags: ['Teacher app'],
      access: 'tenant',
      permissions: ['teacher_app.use', 'teachers.read'],
      body: ReadNotificationsBody,
      handler: async ({ body, req }) => ({
        data: await svc.markRead(tid(req), await myId(req), body),
      }),
    }),
  ];
}
