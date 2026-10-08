import type { Request } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import { fileHeaders } from '../files/files.service.js';
import type { StaffDocumentService } from './documents.service.js';
import {
  CreateDocTypeBody,
  DocTypeParams,
  DocumentUploadQuery,
  PhotoUploadQuery,
  StudentDocParams,
  UpdateDocTypeBody,
} from '../students/documents.schemas.js';
import {
  CreateLookupBody,
  LookupListQuery,
  LookupParams,
  UpdateLookupBody,
  type StaffLookupService,
} from './lookups.service.js';
import { IdParams } from './teachers.schemas.js';

const TAG = ['School · Staff documents'];
const tid = (req: Request) => req.ctx.tenant!.tenantId;
const me = (req: Request) => req.ctx.principal!;

/**
 * Documents and photos. Files arrive as the raw request body (see the raw parser in app.ts);
 * the metadata travels in the query string. Every read and write re-checks the caller's access
 * to that particular staff member.
 */
export function staffDocumentRoutes(svc: StaffDocumentService, lookups: StaffLookupService) {
  return [
    defineRoute({
      method: 'get',
      path: '/staff-lookups',
      summary: 'Department and designation lists. Pass ?all=true to include switched-off entries.',
      tags: ['School · Staff settings'],
      access: 'tenant',
      permissions: ['teachers.read'],
      query: LookupListQuery,
      handler: async ({ query, req }) => ({ data: await lookups.list(tid(req), query) }),
    }),
    defineRoute({
      method: 'post',
      path: '/staff-lookups',
      summary: 'Add a department or designation',
      tags: ['School · Staff settings'],
      access: 'tenant',
      permissions: ['teachers.update'],
      body: CreateLookupBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await lookups.create(tid(req), body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/staff-lookups/:id',
      summary: 'Rename, reorder or switch off a department or designation',
      tags: ['School · Staff settings'],
      access: 'tenant',
      permissions: ['teachers.update'],
      params: LookupParams,
      body: UpdateLookupBody,
      handler: async ({ params, body, req }) => ({
        data: await lookups.update(tid(req), params.id, body, actorFrom(req.ctx)),
      }),
    }),

    defineRoute({
      method: 'get',
      path: '/staff-document-types',
      summary: 'Document types this school asks for. Pass ?all=true to include switched-off ones.',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.documents.read'],
      query: z.object({ all: z.stringbool().optional() }),
      handler: async ({ query, req }) => ({ data: await svc.listTypes(tid(req), query.all) }),
    }),
    defineRoute({
      method: 'post',
      path: '/staff-document-types',
      summary: 'Add a document type',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.documents.manage'],
      body: CreateDocTypeBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await svc.createType(tid(req), body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/staff-document-types/:id',
      summary: 'Edit or switch off a document type',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.documents.manage'],
      params: DocTypeParams,
      body: UpdateDocTypeBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.updateType(tid(req), params.id, body, actorFrom(req.ctx)),
      }),
    }),

    defineRoute({
      method: 'get',
      path: '/teachers/:id/documents',
      summary: 'Required and optional documents with what is on file and what is missing',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.documents.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await svc.list(tid(req), params.id, me(req)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/teachers/:id/documents',
      summary:
        'Upload a document (PNG, JPEG, WebP or PDF, up to 5 MB). Send the file as the raw body with its content-type, and ?type=<code>&filename=&expires_on=&notes=.',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.documents.manage'],
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
      path: '/teachers/:id/documents/:docId',
      summary: 'Remove a document (the file is kept for history)',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.documents.manage'],
      params: StudentDocParams,
      handler: async ({ params, req }) => {
        await svc.remove(tid(req), params.id, params.docId, me(req), actorFrom(req.ctx));
        return undefined;
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teachers/:id/documents/:docId/file',
      summary: 'Download a document',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.documents.read'],
      params: StudentDocParams,
      handler: async ({ params, req, res }) => {
        const f = await svc.download(tid(req), params.id, params.docId, me(req));
        res.status(200).set(fileHeaders(f)).end(f.data);
        return undefined;
      },
    }),

    defineRoute({
      method: 'put',
      path: '/teachers/:id/photo',
      summary:
        'Set the staff photo (PNG, JPEG or WebP, up to 2 MB). Send the image as the raw body with its content-type.',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.update'],
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
      path: '/teachers/:id/photo',
      summary: 'Remove the staff photo',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.update'],
      params: IdParams,
      handler: async ({ params, req }) => {
        await svc.removePhoto(tid(req), params.id, me(req), actorFrom(req.ctx));
        return undefined;
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teachers/:id/photo',
      summary: 'Download the staff photo',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.read'],
      params: IdParams,
      handler: async ({ params, req, res }) => {
        const f = await svc.readPhoto(tid(req), params.id, me(req));
        res.status(200).set(fileHeaders(f)).end(f.data);
        return undefined;
      },
    }),
  ];
}
