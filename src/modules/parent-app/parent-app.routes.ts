import type { Request, Response } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import { AuthorizationError } from '../../shared/errors.js';
import type { Caller } from '../attendance/support.js';
import { fileHeaders } from '../files/files.service.js';
import type { NoticeService } from '../notices/notices.service.js';
import { ParentNoticeQuery } from '../notices/notices.schemas.js';
import { RangeQuery, YearQuery, type ParentAppService } from './parent-app.service.js';

/**
 * The parent app's API (`/api/v1/parent/*`). Every route:
 * - needs `portal.access` (PARENT role; feature `parent_portal`), and a guardian record linked
 *   to the signed-in account (403 NOT_A_PARENT otherwise);
 * - only ever returns the parent's own linked children (with app access allowed). Another
 *   family's child, receipt or invoice is a 404.
 * Areas also need the school's feature: attendance, examinations, fees, communication.
 */
const APP = 'portal.access';
const TAG = ['Parent app'];

const ChildParams = z.object({ childId: z.uuid() });
const ExamParams = ChildParams.extend({ examId: z.uuid() });
const InvoiceParams = ChildParams.extend({ demandId: z.uuid() });
const IdParams = z.object({ id: z.uuid() });

const caller = (req: Request): Caller => ({
  tenantId: req.ctx.tenant!.tenantId,
  principal: req.ctx.principal!,
  actor: actorFrom(req.ctx),
  features: req.ctx.tenant!.entitlements.features,
});

const NAMES: Record<string, string> = {
  attendance: 'Attendance',
  examinations: 'Examinations & results',
  fees: 'Fees',
  communication: 'Notices',
};

function need(req: Request, feature: string) {
  if (!req.ctx.tenant!.entitlements.features.includes(feature))
    throw new AuthorizationError(
      'FEATURE_NOT_ENABLED',
      `${NAMES[feature] ?? feature} is not part of your school's plan`,
      { feature },
    );
}

const pdf = (res: Response, f: { data: Buffer; filename: string }) => {
  res
    .status(200)
    .set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(f.data.length),
      'Content-Disposition': `inline; filename="${f.filename.replace(/[^\w.\- ]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    .end(f.data);
  return undefined;
};

const file = (res: Response, f: { mime: string; data: Buffer; checksum: string; name: string }) => {
  res.status(200).set(fileHeaders(f)).end(f.data);
  return undefined;
};

export function parentAppRoutes(svc: ParentAppService, notices: NoticeService) {
  const scope = (req: Request) => svc.noticeScope(req.ctx.tenant!.tenantId, req.ctx.principal!);
  return [
    // ---- Account & Home ---------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/parent/me',
      summary: 'The signed-in parent, their school and their children (call after sign-in)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      handler: async ({ req }) => ({
        data: await svc.account(req.ctx.tenant!.tenantId, req.ctx.principal!),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/parent/home',
      summary:
        "Home screen: per child today's attendance, attendance %, last result, next exam and next fee due; unread notices; coming up",
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      handler: async ({ req }) => ({ data: await svc.home(caller(req)) }),
    }),
    defineRoute({
      method: 'get',
      path: '/parent/school/logo',
      summary: "The school's logo",
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      handler: async ({ req, res }) =>
        file(res, await svc.schoolLogo(req.ctx.tenant!.tenantId, req.ctx.principal!)),
    }),

    // ---- Child ----------------------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/parent/children/:childId',
      summary: 'Child profile: class, section, roll no., admission no., class teacher, guardians',
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      params: ChildParams,
      handler: async ({ params, req }) => ({
        data: await svc.profile(req.ctx.tenant!.tenantId, req.ctx.principal!, params.childId),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/parent/children/:childId/photo',
      summary: "The child's photo",
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      params: ChildParams,
      handler: async ({ params, req, res }) =>
        file(res, await svc.photo(req.ctx.tenant!.tenantId, req.ctx.principal!, params.childId)),
    }),

    // ---- Attendance & calendar ------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/parent/children/:childId/attendance',
      summary:
        "Attendance from–to (default: the school year so far): each day's status, totals, today's mark (once the teacher submits the register) and off days",
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      params: ChildParams,
      query: RangeQuery,
      handler: async ({ params, query, req }) => {
        need(req, 'attendance');
        return { data: await svc.attendance(caller(req), params.childId, query) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/parent/children/:childId/calendar',
      summary:
        "School calendar for the child's class: off days, holidays and events (default: next 60 days)",
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      params: ChildParams,
      query: RangeQuery,
      handler: async ({ params, query, req }) => ({
        data: await svc.calendar(caller(req), params.childId, query),
      }),
    }),

    // ---- Results --------------------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/parent/children/:childId/exams',
      summary:
        'Published results (newest first) with subject marks, rank, class average and the shared teacher remark; plus upcoming exams with their datesheet',
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      params: ChildParams,
      handler: async ({ params, req }) => {
        need(req, 'examinations');
        return { data: await svc.exams(caller(req), params.childId) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/parent/children/:childId/exams/:examId',
      summary: 'Report card of one published exam',
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      params: ExamParams,
      handler: async ({ params, req }) => {
        need(req, 'examinations');
        return { data: await svc.reportCard(caller(req), params.childId, params.examId) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/parent/children/:childId/exams/:examId/report-card.pdf',
      summary: 'Report card PDF of one published exam',
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      params: ExamParams,
      handler: async ({ params, req, res }) => {
        need(req, 'examinations');
        return pdf(res, await svc.reportCardPdf(caller(req), params.childId, params.examId));
      },
    }),

    // ---- Fees -----------------------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/parent/children/:childId/fees',
      summary:
        'Fee account for the year: totals, amount owing, next instalment, every instalment and charge (with invoice PDF link) and payments (with receipt PDF link)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      params: ChildParams,
      query: YearQuery,
      handler: async ({ params, query, req }) => {
        need(req, 'fees');
        return { data: await svc.fees(caller(req), params.childId, query) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/parent/children/:childId/fees/invoices/:demandId/pdf',
      summary: 'Invoice PDF for one instalment or charge (billed, discounts, payments, balance)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      params: InvoiceParams,
      handler: async ({ params, req, res }) => {
        need(req, 'fees');
        return pdf(res, await svc.invoicePdf(caller(req), params.childId, params.demandId));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/parent/receipts/:id/pdf',
      summary: 'Receipt PDF of a payment for one of my children',
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      params: IdParams,
      handler: async ({ params, req, res }) => {
        need(req, 'fees');
        return pdf(res, await svc.receiptPdf(caller(req), params.id));
      },
    }),

    // ---- Notices --------------------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/parent/notices',
      summary:
        'Notices for my children (school, class or section), newest first; filter by category, child_id or unread. meta.unread = unread count.',
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      query: ParentNoticeQuery,
      handler: async ({ query, req }) => {
        need(req, 'communication');
        const s = await scope(req);
        return notices.parentList(req.ctx.tenant!.tenantId, s.me.guardianId, s.children, query);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/parent/notices/read-all',
      summary: 'Mark every notice read',
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      handler: async ({ req }) => {
        need(req, 'communication');
        const s = await scope(req);
        return {
          data: await notices.markAllRead(req.ctx.tenant!.tenantId, s.me.guardianId, s.children),
        };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/parent/notices/:id',
      summary: 'One notice (does not mark it read; call /read when opened)',
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      params: IdParams,
      handler: async ({ params, req }) => {
        need(req, 'communication');
        const s = await scope(req);
        return {
          data: await notices.parentGet(
            req.ctx.tenant!.tenantId,
            s.me.guardianId,
            s.children,
            params.id,
          ),
        };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/parent/notices/:id/read',
      summary: 'Mark a notice read',
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      params: IdParams,
      handler: async ({ params, req }) => {
        need(req, 'communication');
        const s = await scope(req);
        return {
          data: await notices.markRead(
            req.ctx.tenant!.tenantId,
            s.me.guardianId,
            s.children,
            params.id,
          ),
        };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/parent/notices/:id/acknowledge',
      summary: '"I have read this" for a notice that asks for acknowledgement',
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      params: IdParams,
      handler: async ({ params, req }) => {
        need(req, 'communication');
        const s = await scope(req);
        return {
          data: await notices.acknowledge(
            req.ctx.tenant!.tenantId,
            s.me.guardianId,
            s.children,
            params.id,
            actorFrom(req.ctx),
          ),
        };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/parent/notices/:id/attachment',
      summary: "Download a notice's attachment",
      tags: TAG,
      access: 'tenant',
      permissions: [APP],
      params: IdParams,
      handler: async ({ params, req, res }) => {
        need(req, 'communication');
        const s = await scope(req);
        return file(
          res,
          await notices.parentAttachment(req.ctx.tenant!.tenantId, s.children, params.id),
        );
      },
    }),
  ];
}
