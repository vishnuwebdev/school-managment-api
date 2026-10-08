import { z } from 'zod';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const OptText = (max: number) => z.string().trim().max(max).nullable().optional();

export const DocTypeCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z][A-Z0-9_]{1,31}$/,
    'Use letters, numbers and underscores (2–32), starting with a letter',
  );

export const CreateDocTypeBody = z.object({
  code: DocTypeCode,
  name: z.string().trim().min(2).max(100),
  is_required: z.boolean().default(false),
  has_expiry: z.boolean().default(false),
  allow_multiple: z.boolean().default(false),
  sort_order: z.number().int().min(0).max(999).default(50),
});

export const UpdateDocTypeBody = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  is_required: z.boolean().optional(),
  has_expiry: z.boolean().optional(),
  allow_multiple: z.boolean().optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(999).optional(),
});

export const DocTypeParams = z.object({ id: z.uuid() });
export const StudentDocParams = z.object({ id: z.uuid(), docId: z.uuid() });

/** Uploads send the file as the raw body; everything else travels in the query string. */
export const DocumentUploadQuery = z.object({
  type: DocTypeCode,
  filename: z.string().trim().max(255).optional(),
  expires_on: IsoDate.optional(),
  notes: OptText(500),
});
export const PhotoUploadQuery = z.object({ filename: z.string().trim().max(255).optional() });
