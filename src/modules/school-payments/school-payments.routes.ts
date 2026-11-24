import type { Request } from 'express';
import { sendPdf } from '../../http/pdf.js';
import { defineRoute } from '../../http/route.js';
import { actorFrom, type Actor } from '../../platform/context.js';
import type { SchoolPaymentsService } from './school-payments.service.js';
import {
  FeeBody,
  InvoiceIdParams,
  LedgerQuery,
  PaymentBody,
  PaymentIdParams,
  ReasonBody,
  SessionQuery,
  SetUpFeeBody,
  SettingsBody,
  TenantIdParams,
} from './school-payments.schemas.js';

const T_PLATFORM = ['Platform · School payments'];
const T_SCHOOL = ['School · Platform fees'];
const READ = ['platform.subscriptions.read'];
const MANAGE = ['platform.subscriptions.manage'];

/**
 * The yearly platform fee each school pays us, offline, in agreed instalments.
 * Served in both product modes (simple mode included).
 */
export function schoolPaymentRoutes(svc: SchoolPaymentsService) {
  const platformActor = (req: Request): Actor => ({ ...actorFrom(req.ctx), tenantId: null });
  const tenantOf = (req: Request) => req.ctx.tenant!.tenantId;

  return [
    // ---- Platform: all schools -------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/platform/school-payments/overview',
      summary: 'All schools for one session: billed, received, pending, overdue, and who pays on time',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: READ,
      query: SessionQuery,
      handler: async ({ query }) => ({ data: await svc.overview(query.session) }),
    }),
    defineRoute({
      method: 'get',
      path: '/platform/school-payments/payments',
      summary: 'Every school fee payment received, newest first',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: READ,
      query: LedgerQuery,
      handler: async ({ query }) => ({ data: await svc.ledger(query) }),
    }),
    defineRoute({
      method: 'get',
      path: '/platform/school-payments/settings',
      summary: 'Default yearly fee and the current session',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: READ,
      handler: async () => ({ data: await svc.settings() }),
    }),
    defineRoute({
      method: 'put',
      path: '/platform/school-payments/settings',
      summary: 'Change the default yearly fee (fees already set up keep their amount)',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: MANAGE,
      body: SettingsBody,
      handler: async ({ body, req }) => ({
        data: await svc.updateSettings(body.default_fee_minor, platformActor(req)),
      }),
    }),

    // ---- Platform: one school ----------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/platform/tenants/:id/school-payments',
      summary: 'A school’s fee for every session, its instalments, payments and payment record',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: READ,
      params: TenantIdParams,
      handler: async ({ params }) => ({ data: await svc.forSchool(params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/tenants/:id/school-payments',
      summary: 'Set a school’s fee for a session and when it is to be paid',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: MANAGE,
      params: TenantIdParams,
      body: SetUpFeeBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await svc.setUpFee(params.id, body.session, body, platformActor(req)),
      }),
    }),
    defineRoute({
      method: 'put',
      path: '/platform/school-payments/fees/:invoice_id',
      summary: 'Change a fee’s amount, discount or instalments',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: MANAGE,
      params: InvoiceIdParams,
      body: FeeBody,
      handler: async ({ params, body, req }) => {
        await svc.changeFee(params.invoice_id, body, platformActor(req));
        return { data: { updated: true } };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/platform/school-payments/fees/:invoice_id/payments',
      summary: 'Record money received offline (cash, UPI, bank transfer, cheque …)',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: MANAGE,
      params: InvoiceIdParams,
      body: PaymentBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await svc.recordPayment(params.invoice_id, body, platformActor(req)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/school-payments/fees/:invoice_id/cancel',
      summary: 'Cancel a fee set up by mistake (only when it has no payments)',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: MANAGE,
      params: InvoiceIdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => {
        await svc.cancelFee(params.invoice_id, body.reason, platformActor(req));
        return { data: { cancelled: true } };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/platform/school-payments/payments/:payment_id/reverse',
      summary: 'Reverse a payment recorded by mistake (the receipt stays, marked reversed)',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: MANAGE,
      params: PaymentIdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => {
        await svc.reversePayment(params.payment_id, body.reason, platformActor(req));
        return { data: { reversed: true } };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/platform/school-payments/fees/:invoice_id/pdf',
      summary: 'Printable invoice with the payment schedule',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: READ,
      params: InvoiceIdParams,
      handler: async ({ params, res }) => {
        sendPdf(res, await svc.invoicePdf(params.invoice_id));
        return undefined;
      },
    }),
    defineRoute({
      method: 'get',
      path: '/platform/school-payments/payments/:payment_id/receipt',
      summary: 'Printable receipt for a payment',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: READ,
      params: PaymentIdParams,
      handler: async ({ params, res }) => {
        sendPdf(res, await svc.receiptPdf(params.payment_id));
        return undefined;
      },
    }),

    // ---- School (read-only) --------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/tenants/current/school-payments',
      summary: 'The school’s platform fee for every session, instalments, payments and receipts',
      tags: T_SCHOOL,
      access: 'tenant',
      permissions: ['tenant.billing.read'],
      handler: async ({ req }) => ({ data: await svc.forSchool(tenantOf(req)) }),
    }),
    defineRoute({
      method: 'get',
      path: '/tenants/current/school-payments/fees/:invoice_id/pdf',
      summary: 'Printable invoice',
      tags: T_SCHOOL,
      access: 'tenant',
      permissions: ['tenant.billing.read'],
      params: InvoiceIdParams,
      handler: async ({ params, req, res }) => {
        sendPdf(res, await svc.invoicePdf(params.invoice_id, tenantOf(req)));
        return undefined;
      },
    }),
    defineRoute({
      method: 'get',
      path: '/tenants/current/school-payments/payments/:payment_id/receipt',
      summary: 'Printable receipt',
      tags: T_SCHOOL,
      access: 'tenant',
      permissions: ['tenant.billing.read'],
      params: PaymentIdParams,
      handler: async ({ params, req, res }) => {
        sendPdf(res, await svc.receiptPdf(params.payment_id, tenantOf(req)));
        return undefined;
      },
    }),
  ];
}
