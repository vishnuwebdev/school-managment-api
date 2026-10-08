import type { Request, Response } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom, type Actor } from '../../platform/context.js';
import type { BillingService } from './billing.service.js';
import {
  CreateInvoiceBody,
  InvoiceIdParams,
  PaymentBody,
  PaymentIdParams,
  TenantIdParams,
  VoidBody,
} from './billing.schemas.js';

const T_PLATFORM = ['Platform · Billing'];
const T_SCHOOL = ['School · Billing'];

function sendPdf(res: Response, f: { data: Buffer; filename: string }) {
  res
    .status(200)
    .set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(f.data.length),
      'Content-Disposition': `inline; filename="${f.filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    .end(f.data);
}

/** Invoices and offline payments for school subscriptions. */
export function billingRoutes(svc: BillingService) {
  const platformActor = (req: Request): Actor => ({ ...actorFrom(req.ctx), tenantId: null });
  const tenantOf = (req: Request) => req.ctx.tenant!.tenantId;

  return [
    // ---- Platform ------------------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/platform/billing/overview',
      summary:
        'Revenue across all schools: collected, outstanding, overdue, and each school’s position',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: ['platform.subscriptions.read'],
      handler: async () => ({ data: await svc.revenueOverview() }),
    }),
    defineRoute({
      method: 'get',
      path: '/platform/billing/payments',
      summary: 'Every payment received, newest first',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: ['platform.subscriptions.read'],
      query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
      handler: async ({ query }) => ({ data: await svc.paymentLedger({ limit: query.limit }) }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/billing/missing-invoices',
      summary:
        'Create an invoice for every paid subscription that has none (schools enrolled before billing)',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: ['platform.subscriptions.manage'],
      handler: async ({ req }) => ({ data: await svc.createMissingInvoices(platformActor(req)) }),
    }),
    defineRoute({
      method: 'get',
      path: '/platform/tenants/:id/billing',
      summary: 'Plan, dates, invoices and payments of a school',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: ['platform.subscriptions.read'],
      params: TenantIdParams,
      handler: async ({ params }) => ({ data: await svc.overview(params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/tenants/:id/billing/invoices',
      summary: 'Issue an invoice to a school (optionally recording a payment received with it)',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: ['platform.subscriptions.manage'],
      params: TenantIdParams,
      body: CreateInvoiceBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await svc.createManualInvoice(
          params.id,
          {
            description: body.description,
            amountMinor: body.amount_minor,
            discountMinor: body.discount_minor,
            dueAt: body.due_on,
            subscriptionId: body.subscription_id,
            payment: body.payment,
          },
          platformActor(req),
        ),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/billing/invoices/:invoice_id/payments',
      summary: 'Record an offline payment (cash, bank transfer, cheque …) against an invoice',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: ['platform.subscriptions.manage'],
      params: InvoiceIdParams,
      body: PaymentBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await svc.recordPayment(params.invoice_id, body, platformActor(req)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/platform/billing/invoices/:invoice_id/void',
      summary: 'Void an invoice that has no payments',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: ['platform.subscriptions.manage'],
      params: InvoiceIdParams,
      body: VoidBody,
      handler: async ({ params, body, req }) => {
        await svc.voidInvoice(params.invoice_id, body.reason, platformActor(req));
        return { data: { voided: true } };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/platform/billing/payments/:payment_id/reverse',
      summary: 'Reverse a payment recorded by mistake (the receipt is kept, marked reversed)',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: ['platform.subscriptions.manage'],
      params: PaymentIdParams,
      body: VoidBody,
      handler: async ({ params, body, req }) => {
        await svc.reversePayment(params.payment_id, body.reason, platformActor(req));
        return { data: { reversed: true } };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/platform/billing/invoices/:invoice_id/pdf',
      summary: 'Printable invoice',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: ['platform.subscriptions.read'],
      params: InvoiceIdParams,
      handler: async ({ params, res }) => {
        sendPdf(res, await svc.invoicePdf(params.invoice_id));
        return undefined;
      },
    }),
    defineRoute({
      method: 'get',
      path: '/platform/billing/payments/:payment_id/receipt',
      summary: 'Printable receipt for a payment',
      tags: T_PLATFORM,
      access: 'platform',
      permissions: ['platform.subscriptions.read'],
      params: PaymentIdParams,
      handler: async ({ params, res }) => {
        sendPdf(res, await svc.receiptPdf(params.payment_id));
        return undefined;
      },
    }),

    // ---- School (read-only) ----------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/tenants/current/billing',
      summary: 'The school’s plan, purchase and end dates, invoices and payments',
      tags: T_SCHOOL,
      access: 'tenant',
      permissions: ['tenant.billing.read'],
      handler: async ({ req }) => ({ data: await svc.overview(tenantOf(req)) }),
    }),
    defineRoute({
      method: 'get',
      path: '/tenants/current/billing/invoices/:invoice_id/pdf',
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
      path: '/tenants/current/billing/payments/:payment_id/receipt',
      summary: 'Printable receipt for a payment',
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
