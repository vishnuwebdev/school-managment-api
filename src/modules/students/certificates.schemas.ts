import { z } from 'zod';
import { STUDENT_DOCUMENT_KIND } from '../../db/schema/index.js';
import { IdParams } from './students.schemas.js';

export const IssueDocumentBody = z.object({
  kind: z.enum(STUDENT_DOCUMENT_KIND),
  remarks: z.string().trim().max(500).nullable().optional(),
  /** Needed when the student already has a valid document of this kind. */
  confirm_duplicate: z.boolean().optional(),
});
export const IssuedDocParams = IdParams.extend({ docId: z.uuid() });
export const VoidDocumentBody = z.object({ reason: z.string().trim().min(3).max(500) });
export const TemplateParams = z.object({ kind: z.enum(STUDENT_DOCUMENT_KIND) });
export const UpdateTemplateBody = z.object({
  title: z.string().trim().min(2).max(150),
  body: z.string().trim().min(10).max(4000),
});
