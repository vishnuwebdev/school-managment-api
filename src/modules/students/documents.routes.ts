import type { Request } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import { fileHeaders } from '../files/files.service.js';
import type { StudentDocumentService } from './documents.service.js';
import {
  CreateDocTypeBody,
  DocTypeParams,
  DocumentUploadQuery,
  PhotoUploadQuery,
  StudentDocParams,
  UpdateDocTypeBody,
} from './documents.schemas.js';
import { IdParams } from './students.schemas.js';

const TAG = ['School · Student documents'];
const tid = (req: Request) => req.ctx.tenant!.tenantId;
const me = (req: Request) => req.ctx.principal!;

/**
 * Documents and photos. Files arrive as the raw request body (see the raw parser in app.ts);
 * the metadata travels in the query string. Every read and write re-checks the caller's access
 * to that particular student.
 */
export function studentDocumentRoutes(svc: StudentDocumentService) {
  return [
    defineRoute({
      method: 'get',
      path: '/student-document-types',
      summary: 'Document types this school asks for. Pass ?all=true to include switched-off ones.',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.documents.read'],
      query: z.object({ all: z.stringbool().optional() }),
      handler: async ({ query, req }) => ({ data: await svc.listTypes(tid(req), query.all) }),
    }),
    defineRoute({
      method: 'post',
      path: '/student-document-types',
      summary: 'Add a document type',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.documents.manage'],
      body: CreateDocTypeBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await svc.createType(tid(req), body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/student-document-types/:id',
      summary: 'Edit or switch off a document type',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.documents.manage'],
      params: DocTypeParams,
      body: UpdateDocTypeBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.updateType(tid(req), params.id, body, actorFrom(req.ctx)),
      }),
    }),

    defineRoute({
      method: 'get',
      path: '/students/:id/documents',
      summary: 'Required and optional documents with what is on file and what is missing',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.documents.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await svc.list(tid(req), params.id, me(req)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/students/:id/documents',
      summary:
        'Upload a document (PNG, JPEG, WebP or PDF, up to 5 MB). Send the file as the raw body with its content-type, and ?type=<code>&filename=&expires_on=&notes=.',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.documents.manage'],
      params: IdParams,
      query: DocumentUploadQuery,
      body: z.any(),
      status: 201,
      handler: async ({ params, query, body, req }) => ({
        data: await svc.upload(tid(req), params.id, me(req), actorFrom(req.ctx), {
          data: body,
          typeCode: query.type,
          filename: query.filename,
          expiresOn: query.expires_on,
          notes: query.notes,
        }),
      }),
    }),
    defineRoute({
      method: 'delete',
      path: '/students/:id/documents/:docId',
      summary: 'Remove a document (the file is kept for history)',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.documents.manage'],
      params: StudentDocParams,
      handler: async ({ params, req }) => {
        await svc.remove(tid(req), params.id, params.docId, me(req), actorFrom(req.ctx));
        return undefined;
      },
    }),
    defineRoute({
      method: 'get',
      path: '/students/:id/documents/:docId/file',
      summary: 'Download a document',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.documents.read'],
      params: StudentDocParams,
      handler: async ({ params, req, res }) => {
        const f = await svc.download(tid(req), params.id, params.docId, me(req));
        res.status(200).set(fileHeaders(f)).end(f.data);
        return undefined;
      },
    }),

    defineRoute({
      method: 'put',
      path: '/students/:id/photo',
      summary:
        'Set the student photo (PNG, JPEG or WebP, up to 2 MB). Send the image as the raw body with its content-type.',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.update'],
      params: IdParams,
      query: PhotoUploadQuery,
      body: z.any(),
      handler: async ({ params, query, body, req }) => ({
        data: await svc.setPhoto(tid(req), params.id, me(req), actorFrom(req.ctx), {
          data: body,
          filename: query.filename,
        }),
      }),
    }),
    defineRoute({
      method: 'delete',
      path: '/students/:id/photo',
      summary: 'Remove the student photo',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.update'],
      params: IdParams,
      handler: async ({ params, req }) => {
        await svc.removePhoto(tid(req), params.id, me(req), actorFrom(req.ctx));
        return undefined;
      },
    }),
    defineRoute({
      method: 'get',
      path: '/students/:id/photo',
      summary: 'Download the student photo',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.read'],
      params: IdParams,
      handler: async ({ params, req, res }) => {
        const f = await svc.readPhoto(tid(req), params.id, me(req));
        res.status(200).set(fileHeaders(f)).end(f.data);
        return undefined;
      },
    }),
  ];
}
