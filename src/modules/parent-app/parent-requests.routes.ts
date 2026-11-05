import type { Request } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import type { ParentAppService } from './parent-app.service.js';
import {
  ChangeRequestListQuery,
  CreateChangeRequestBody,
  CreateParentMessageBody,
  DecideChangeRequestBody,
  ParentMessageListQuery,
  ReplyBody,
  UpdateParentMessageBody,
  UpdateParentProfileBody,
} from './parent-requests.schemas.js';
import type { ParentRequestService } from './parent-requests.service.js';

const APP = 'portal.access';
const PARENT_TAG = ['Parent app · Requests & messages'];
const OFFICE_TAG = ['School · Parent requests & feedback'];

const ChildParams = z.object({ childId: z.uuid() });
const IdParams = z.object({ id: z.uuid() });
const tid = (req: Request) => req.ctx.tenant!.tenantId;

/**
 * What parents send to the school (0046):
 * - parent app: own profile (saved at once), requests to change a child's details, and
 *   complaints / feedback / suggestions with a reply thread;
 * - admin panel: the change-request queue (approve / reject) and the feedback inbox.
 * Complaints are only visible to staff with `feedback.complaints` (the principal by default).
 */
export function parentRequestRoutes(svc: ParentRequestService, app: ParentAppService) {
  const me = (req: Request) => app.me(tid(req), req.ctx.principal!);
  const myChild = async (req: Request, childId: string) => {
    const m = await me(req);
    await app.child(tid(req), m, childId);
    return m;
  };

  return [
    // ---- parent: my profile -----------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/parent/profile',
      summary:
        "The parent's own details (the sign-in mobile is shown but can only be changed by the school)",
      tags: PARENT_TAG,
      access: 'tenant',
      permissions: [APP],
      handler: async ({ req }) => {
        const m = await me(req);
        return { data: await svc.profile(tid(req), m.guardianId, req.ctx.principal!.userId) };
      },
    }),
    defineRoute({
      method: 'patch',
      path: '/parent/profile',
      summary:
        'Update my details: name, email, address, occupation, language and how the school contacts me',
      tags: PARENT_TAG,
      access: 'tenant',
      permissions: [APP],
      body: UpdateParentProfileBody,
      handler: async ({ body, req }) => {
        const m = await me(req);
        return {
          data: await svc.updateProfile(
            tid(req),
            m.guardianId,
            req.ctx.principal!.userId,
            body,
            actorFrom(req.ctx),
          ),
        };
      },
    }),

    // ---- parent: child details change requests ------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/parent/children/:childId/details',
      summary: "The child's editable details and my requests to change them (newest first)",
      tags: PARENT_TAG,
      access: 'tenant',
      permissions: [APP],
      params: ChildParams,
      handler: async ({ params, req }) => {
        const m = await myChild(req, params.childId);
        return { data: await svc.childDetails(tid(req), m.guardianId, params.childId) };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/parent/children/:childId/change-requests',
      summary: "Ask the school to change the child's details (applied once the office approves)",
      tags: PARENT_TAG,
      access: 'tenant',
      permissions: [APP],
      params: ChildParams,
      body: CreateChangeRequestBody,
      status: 201,
      handler: async ({ params, body, req }) => {
        const m = await myChild(req, params.childId);
        return {
          data: await svc.requestChange(
            tid(req),
            m.guardianId,
            params.childId,
            body,
            actorFrom(req.ctx),
          ),
        };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/parent/change-requests/:id/cancel',
      summary: 'Withdraw a pending change request',
      tags: PARENT_TAG,
      access: 'tenant',
      permissions: [APP],
      params: IdParams,
      handler: async ({ params, req }) => {
        const m = await me(req);
        return {
          data: await svc.cancelRequest(tid(req), m.guardianId, params.id, actorFrom(req.ctx)),
        };
      },
    }),

    // ---- parent: complaints, feedback, suggestions ---------------------------------------------
    defineRoute({
      method: 'get',
      path: '/parent/messages',
      summary:
        'My complaints, feedback and suggestions, latest activity first (meta.unread = with new replies)',
      tags: PARENT_TAG,
      access: 'tenant',
      permissions: [APP],
      query: ParentMessageListQuery,
      handler: async ({ query, req }) => {
        const m = await me(req);
        return svc.parentList(tid(req), m.guardianId, query);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/parent/messages',
      summary:
        'Raise a complaint (goes to the principal) or send feedback / a suggestion (goes to the office), optionally about one child',
      tags: PARENT_TAG,
      access: 'tenant',
      permissions: [APP],
      body: CreateParentMessageBody,
      status: 201,
      handler: async ({ body, req }) => {
        const m = await me(req);
        const kids = await app.children(tid(req), m.guardianId);
        return {
          data: await svc.parentCreate(
            tid(req),
            m.guardian,
            kids.map((k) => k.id),
            body,
            actorFrom(req.ctx),
          ),
        };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/parent/messages/:id',
      summary: 'One conversation with all replies (marks the school’s replies as read)',
      tags: PARENT_TAG,
      access: 'tenant',
      permissions: [APP],
      params: IdParams,
      handler: async ({ params, req }) => {
        const m = await me(req);
        return { data: await svc.parentGet(tid(req), m.guardianId, params.id) };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/parent/messages/:id/replies',
      summary: 'Reply in the conversation (re-opens a resolved one; not allowed once closed)',
      tags: PARENT_TAG,
      access: 'tenant',
      permissions: [APP],
      params: IdParams,
      body: ReplyBody,
      status: 201,
      handler: async ({ params, body, req }) => {
        const m = await me(req);
        return {
          data: await svc.parentReply(
            tid(req),
            m.guardian,
            params.id,
            body.body,
            actorFrom(req.ctx),
          ),
        };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/parent/messages/:id/close',
      summary: 'Close the conversation (no further answer needed)',
      tags: PARENT_TAG,
      access: 'tenant',
      permissions: [APP],
      params: IdParams,
      handler: async ({ params, req }) => {
        const m = await me(req);
        return {
          data: await svc.parentClose(tid(req), m.guardianId, params.id, actorFrom(req.ctx)),
        };
      },
    }),

    // ---- admin: student change requests ---------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/student-change-requests',
      summary:
        'Requests from parents to change student details (meta.pending = waiting for a decision)',
      tags: OFFICE_TAG,
      access: 'tenant',
      permissions: ['students.read'],
      query: ChangeRequestListQuery,
      handler: async ({ query, req }) => svc.listRequests(tid(req), query),
    }),
    defineRoute({
      method: 'get',
      path: '/student-change-requests/:id',
      summary: 'One request: each field with its value now, before and requested',
      tags: OFFICE_TAG,
      access: 'tenant',
      permissions: ['students.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await svc.getRequest(tid(req), params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/student-change-requests/:id/approve',
      summary: "Approve: the requested values are saved on the student's record",
      tags: OFFICE_TAG,
      access: 'tenant',
      permissions: ['students.update'],
      params: IdParams,
      body: DecideChangeRequestBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.decide(
          tid(req),
          params.id,
          true,
          body.note,
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/student-change-requests/:id/reject',
      summary: 'Reject with an optional note the parent will see',
      tags: OFFICE_TAG,
      access: 'tenant',
      permissions: ['students.update'],
      params: IdParams,
      body: DecideChangeRequestBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.decide(
          tid(req),
          params.id,
          false,
          body.note,
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),

    // ---- admin: feedback & complaints inbox -----------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/feedback',
      summary:
        'Complaints, feedback and suggestions from parents (complaints only with feedback.complaints)',
      tags: OFFICE_TAG,
      access: 'tenant',
      permissions: ['feedback.read'],
      query: ParentMessageListQuery,
      handler: async ({ query, req }) => svc.schoolList(tid(req), query, req.ctx.principal!),
    }),
    defineRoute({
      method: 'get',
      path: '/feedback/summary',
      summary: 'Counts for the inbox badge: unread, open, and open by kind',
      tags: OFFICE_TAG,
      access: 'tenant',
      permissions: ['feedback.read'],
      handler: async ({ req }) => ({ data: await svc.summary(tid(req), req.ctx.principal!) }),
    }),
    defineRoute({
      method: 'get',
      path: '/feedback/:id',
      summary: 'One conversation with all replies (marks it read for the school)',
      tags: OFFICE_TAG,
      access: 'tenant',
      permissions: ['feedback.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await svc.schoolGet(tid(req), params.id, req.ctx.principal!),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/feedback/:id/replies',
      summary: 'Reply to the parent (an open message moves to In progress)',
      tags: OFFICE_TAG,
      access: 'tenant',
      permissions: ['feedback.respond'],
      params: IdParams,
      body: ReplyBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await svc.schoolReply(
          tid(req),
          params.id,
          body.body,
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/feedback/:id',
      summary: 'Change status (Open → In progress → Resolved / Closed) or assign to a staff member',
      tags: OFFICE_TAG,
      access: 'tenant',
      permissions: ['feedback.respond'],
      params: IdParams,
      body: UpdateParentMessageBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.schoolUpdate(
          tid(req),
          params.id,
          body,
          req.ctx.principal!,
          actorFrom(req.ctx),
        ),
      }),
    }),
  ];
}
