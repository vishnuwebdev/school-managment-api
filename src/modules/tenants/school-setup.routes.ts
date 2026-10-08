import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import {
  BankAccountParams,
  BrandingKind,
  BrandingUploadQuery,
  CreateBankAccountBody,
  ReasonBody,
  RegistrationBody,
  RegistrationParams,
  UpdateBankAccountBody,
} from './school-setup.schemas.js';
import type { SchoolSetupService } from './school-setup.service.js';

const T = ['School · Setup'];
const tenantOf = (req: { ctx: { tenant?: { tenantId: string } | null } }) =>
  req.ctx.tenant!.tenantId;

/** Branding, bank accounts, registration details and document branding of the signed-in school. */
export function schoolSetupRoutes(svc: SchoolSetupService) {
  return [
    // ---- Setup status -----------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/tenants/current/setup-status',
      summary: 'How complete the school setup is, with what is still missing',
      tags: T,
      access: 'tenant',
      permissions: ['tenant.profile.read'],
      handler: async ({ req }) => ({ data: await svc.completeness(tenantOf(req)) }),
    }),
    defineRoute({
      method: 'get',
      path: '/tenants/current/document-branding',
      summary:
        'School name, address, logo, header image, footer, default bank (masked) and registration numbers for printed documents',
      tags: T,
      access: 'tenant',
      permissions: ['tenant.profile.read'],
      handler: async ({ req }) => ({ data: await svc.documentBranding(tenantOf(req)) }),
    }),

    // ---- Branding (§12.4) -------------------------------------------------------------------
    defineRoute({
      method: 'put',
      path: '/tenants/current/branding/:kind',
      summary:
        'Upload a logo (2 MB), banner (5 MB) or document header (5 MB). Send the raw image as the body with its content-type (PNG, JPEG, WebP or plain SVG) and an optional ?filename=.',
      tags: T,
      access: 'tenant',
      permissions: ['tenant.settings.update'],
      params: z.object({ kind: BrandingKind }),
      query: BrandingUploadQuery,
      body: z.any(),
      handler: async ({ params, query, body, req }) => ({
        data: await svc.uploadBranding(
          tenantOf(req),
          params.kind,
          { data: body, filename: query.filename },
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'delete',
      path: '/tenants/current/branding/:kind',
      summary: 'Remove the logo, banner or document header (the file is kept for audit)',
      tags: T,
      access: 'tenant',
      permissions: ['tenant.settings.update'],
      params: z.object({ kind: BrandingKind }),
      handler: async ({ params, req }) => ({
        data: await svc.removeBranding(tenantOf(req), params.kind, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/files/:id',
      summary: "Download one of the school's uploaded images (never another school's)",
      tags: T,
      access: 'tenant',
      permissions: ['tenant.profile.read'],
      params: z.object({ id: z.string().uuid() }),
      handler: async ({ params, req, res }) => {
        const f = await svc.readFile(tenantOf(req), params.id);
        res
          .status(200)
          .set({
            'Content-Type': f.mime,
            'Content-Length': String(f.data.length),
            ETag: `"${f.checksum}"`,
            'Cache-Control': 'private, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            'Content-Disposition': 'inline',
          })
          .end(f.data);
        return undefined;
      },
    }),

    // ---- Bank accounts (§12.5) ----------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/tenants/current/bank-accounts',
      summary: 'Bank accounts. Numbers are always masked here (last 4 digits).',
      tags: T,
      access: 'tenant',
      permissions: ['tenant.finance.read'],
      handler: async ({ req }) => ({ data: await svc.listBankAccounts(tenantOf(req)) }),
    }),
    defineRoute({
      method: 'post',
      path: '/tenants/current/bank-accounts',
      summary: 'Add a bank account. The number is encrypted at rest.',
      tags: T,
      access: 'tenant',
      permissions: ['tenant.finance.manage'],
      body: CreateBankAccountBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await svc.createBankAccount(tenantOf(req), body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/tenants/current/bank-accounts/:id',
      summary: 'Edit a bank account. Send account_number only to replace the stored number.',
      tags: T,
      access: 'tenant',
      permissions: ['tenant.finance.manage'],
      params: BankAccountParams,
      body: UpdateBankAccountBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.updateBankAccount(tenantOf(req), params.id, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/tenants/current/bank-accounts/:id/make-default',
      summary: 'Use this account on receipts and documents',
      tags: T,
      access: 'tenant',
      permissions: ['tenant.finance.manage'],
      params: BankAccountParams,
      handler: async ({ params, req }) => ({
        data: await svc.makeDefaultBankAccount(tenantOf(req), params.id, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/tenants/current/bank-accounts/:id/archive',
      summary: 'Remove a bank account (kept for audit)',
      tags: T,
      access: 'tenant',
      permissions: ['tenant.finance.manage'],
      params: BankAccountParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.archiveBankAccount(
          tenantOf(req),
          params.id,
          body.reason,
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/tenants/current/bank-accounts/:id/reveal',
      summary: 'Show the full account number. A reason is required and the reveal is audited.',
      tags: T,
      access: 'tenant',
      permissions: ['tenant.finance.reveal'],
      params: BankAccountParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.revealBankAccount(
          tenantOf(req),
          params.id,
          body.reason,
          actorFrom(req.ctx),
        ),
      }),
    }),

    // ---- Registration details (§12.6) ---------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/tenants/current/registrations',
      summary: 'Registration types for the school’s country and the values saved so far',
      tags: T,
      access: 'tenant',
      permissions: ['tenant.finance.read'],
      handler: async ({ req }) => ({ data: await svc.listRegistrations(tenantOf(req)) }),
    }),
    defineRoute({
      method: 'put',
      path: '/tenants/current/registrations/:type',
      summary: 'Save one registration number (PAN, TAN, GSTIN, UDISE, …)',
      tags: T,
      access: 'tenant',
      permissions: ['tenant.finance.manage'],
      params: RegistrationParams,
      body: RegistrationBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.setRegistration(tenantOf(req), params.type, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'delete',
      path: '/tenants/current/registrations/:type',
      summary: 'Remove a registration number',
      tags: T,
      access: 'tenant',
      permissions: ['tenant.finance.manage'],
      params: RegistrationParams,
      handler: async ({ params, req }) => {
        await svc.removeRegistration(tenantOf(req), params.type, actorFrom(req.ctx));
        return undefined;
      },
    }),
  ];
}
