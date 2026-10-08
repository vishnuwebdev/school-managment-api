import type { Request } from 'express';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import { fileHeaders } from '../files/files.service.js';
import {
  IssueDocumentBody,
  IssuedDocParams,
  TemplateParams,
  UpdateTemplateBody,
  VoidDocumentBody,
} from './certificates.schemas.js';
import type { StudentCertificateService } from './certificates.service.js';
import { IdParams } from './students.schemas.js';

const TAG = ['School · Student certificates'];
const tid = (req: Request) => req.ctx.tenant!.tenantId;
const me = (req: Request) => req.ctx.principal!;

export function studentCertificateRoutes(svc: StudentCertificateService) {
  return [
    defineRoute({
      method: 'get',
      path: '/student-document-templates',
      summary:
        'The wording of each certificate and the ID card back, with the placeholders you can use',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.certificates.read'],
      handler: async ({ req }) => ({ data: await svc.listTemplates(tid(req)) }),
    }),
    defineRoute({
      method: 'put',
      path: '/student-document-templates/:kind',
      summary: 'Change the wording. A new version is saved; documents already issued keep theirs.',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.certificates.manage'],
      params: TemplateParams,
      body: UpdateTemplateBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.updateTemplate(tid(req), params.kind, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/students/:id/issued-documents',
      summary: 'Certificates and ID cards issued to this student (voided ones included)',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.certificates.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await svc.list(tid(req), params.id, me(req)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/students/:id/issued-documents',
      summary:
        'Issue a bonafide, transfer or character certificate, or an ID card. Returns the record; download the PDF from the file link.',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.certificates.issue'],
      params: IdParams,
      body: IssueDocumentBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await svc.issue(tid(req), params.id, body, me(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/students/:id/issued-documents/:docId/file',
      summary: 'Download the PDF',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.certificates.read'],
      params: IssuedDocParams,
      handler: async ({ params, req, res }) => {
        const f = await svc.download(tid(req), params.id, params.docId, me(req));
        res.status(200).set(fileHeaders(f)).end(f.data);
        return undefined;
      },
    }),
    defineRoute({
      method: 'post',
      path: '/students/:id/issued-documents/:docId/void',
      summary: 'Void a document that was issued by mistake. It is never edited or deleted.',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.certificates.void'],
      params: IssuedDocParams,
      body: VoidDocumentBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.void(tid(req), params.id, params.docId, body, me(req), actorFrom(req.ctx)),
      }),
    }),
  ];
}
