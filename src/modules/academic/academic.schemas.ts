import { z } from 'zod';
import {
  ACADEMIC_YEAR_STATUS,
  CLASS_PHASE,
  CLASS_STATUS,
  OFFERING_STATUS,
  SECTION_STATUS,
  SUBJECT_STATUS,
  SUBJECT_TYPE,
} from '../../db/schema/index.js';
import { PaginationQuery } from '../../shared/pagination.js';

export const IdParams = z.object({ id: z.uuid() });
export const YearIdParams = z.object({ yearId: z.uuid() });
const Version = z.number().int().positive();
export const Reason = z.object({ reason: z.string().trim().min(3).max(500).optional() });

/** Business codes are stored upper-case, so "grade_01" and "GRADE_01" are the same code. */
const Code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_.-]{0,31}$/, 'Use letters, numbers, dot, dash or underscore (max 32)');
const YearCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,31}$/, 'Use letters, numbers and - _ . / (max 32)');
const IsoDate = z.iso.date();
const Name = (max: number) => z.string().trim().min(1).max(max);

// ---- Academic years
export const CreateYearBody = z.object({
  code: YearCode,
  name: Name(120),
  start_date: IsoDate,
  end_date: IsoDate,
});
export const UpdateYearBody = z.object({
  version: Version,
  code: YearCode.optional(),
  name: Name(120).optional(),
  start_date: IsoDate.optional(),
  end_date: IsoDate.optional(),
});
export const ActivateYearBody = z.object({
  /** Complete the currently active year in the same transaction. */
  complete_current: z.boolean().default(false),
});
export const YearListQuery = PaginationQuery.extend({
  status: z.enum(ACADEMIC_YEAR_STATUS).optional(),
});

// ---- Classes
export const CreateClassBody = z.object({
  code: Code,
  name: Name(100),
  display_name: Name(100).nullable().optional(),
  /** Optional: when omitted the class is placed in its natural position (Nursery, LKG, UKG, Class 1...). */
  sequence: z.number().int().min(0).max(10_000).optional(),
  phase: z.enum(CLASS_PHASE).nullable().optional(),
  language_of_instruction: Name(64).nullable().optional(),
  promotes_to_class_id: z.uuid().nullable().optional(),
});
export const ReorderClassesBody = z.object({ ids: z.array(z.uuid()).min(1).max(500) });
export const UpdateClassBody = z.object({
  version: Version,
  name: Name(100).optional(),
  display_name: Name(100).nullable().optional(),
  sequence: z.number().int().min(0).max(10_000).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  phase: z.enum(CLASS_PHASE).nullable().optional(),
  language_of_instruction: Name(64).nullable().optional(),
  promotes_to_class_id: z.uuid().nullable().optional(),
});
export const ClassListQuery = PaginationQuery.extend({ status: z.enum(CLASS_STATUS).optional() });

// ---- Sections
export const CreateSectionBody = z.object({
  class_id: z.uuid(),
  code: Code,
  name: Name(100),
  capacity: z.number().int().min(1).max(5000).nullable().optional(),
  room: Name(50).nullable().optional(),
  status: z.enum(['DRAFT', 'ACTIVE']).default('ACTIVE'),
});
export const UpdateSectionBody = z.object({
  version: Version,
  name: Name(100).optional(),
  capacity: z.number().int().min(1).max(5000).nullable().optional(),
  room: Name(50).nullable().optional(),
});
export const SectionListQuery = PaginationQuery.extend({
  academic_year_id: z.uuid().optional(),
  class_id: z.uuid().optional(),
  status: z.enum(SECTION_STATUS).optional(),
});

// ---- Subjects
export const CreateSubjectBody = z.object({
  code: Code,
  name: Name(120),
  description: z.string().trim().max(500).nullable().optional(),
  subject_type: z.enum(SUBJECT_TYPE).default('CORE'),
});
export const UpdateSubjectBody = z.object({
  version: Version,
  name: Name(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  subject_type: z.enum(SUBJECT_TYPE).optional(),
});
export const SubjectListQuery = PaginationQuery.extend({
  status: z.enum(SUBJECT_STATUS).optional(),
  subject_type: z.enum(SUBJECT_TYPE).optional(),
});

// ---- Subject offerings
export const CreateOfferingBody = z.object({
  academic_year_id: z.uuid(),
  subject_id: z.uuid(),
  class_id: z.uuid(),
  /** Omit for a class-wide offering. */
  section_id: z.uuid().nullable().optional(),
});
export const OfferingListQuery = PaginationQuery.extend({
  academic_year_id: z.uuid().optional(),
  class_id: z.uuid().optional(),
  section_id: z.uuid().optional(),
  subject_id: z.uuid().optional(),
  status: z.enum(OFFERING_STATUS).optional(),
});
