import { z } from 'zod';
import {
  ASSIGNMENT_ROLE,
  EMPLOYMENT_TYPE,
  GENDER,
  QUALIFICATION_TYPE,
  STAFF_TYPE,
  TEACHER_STATUS,
  TEACHING_ASSIGNMENT_STATUS,
} from '../../db/schema/index.js';
import { PaginationQuery } from '../../shared/pagination.js';

export const IdParams = z.object({ id: z.uuid() });
export const QualificationParams = z.object({ id: z.uuid(), qid: z.uuid() });
const Version = z.number().int().positive();
const IsoDate = z.iso.date();
const Text = (max: number) => z.string().trim().min(1).max(max);
const OptText = (max: number) => z.string().trim().max(max).nullable().optional();
export const Reason = z.object({ reason: z.string().trim().min(3).max(500) });

const Address = z
  .object({
    line1: OptText(200),
    line2: OptText(200),
    city: OptText(100),
    state: OptText(100),
    postal_code: OptText(20),
    country: z.string().length(2).toUpperCase().nullable().optional(),
  })
  .nullable()
  .optional();
const Phone = z
  .string()
  .trim()
  .regex(/^[0-9+()\-.\s]{5,32}$/, 'Enter a valid phone number')
  .nullable()
  .optional();
const Email = z.email().max(254).toLowerCase().nullable().optional();
const TeacherNumber = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9/_.-]{0,31}$/, 'Use letters, numbers and / _ . - (max 32)');
const DateOfBirth = IsoDate.refine((d) => d <= new Date().toISOString().slice(0, 10), {
  message: 'Date of birth cannot be in the future',
});

// ---- Qualifications ----------------------------------------------------------
const QualificationFields = {
  type: z.enum(QUALIFICATION_TYPE),
  title: Text(200),
  institution: OptText(200),
  field_of_study: OptText(200),
  completion_year: z.number().int().min(1900).max(2100).nullable().optional(),
};
export const QualificationBody = z.object(QualificationFields);
export const UpdateQualificationBody = z.object({
  version: Version,
  type: QualificationFields.type.optional(),
  title: QualificationFields.title.optional(),
  institution: QualificationFields.institution,
  field_of_study: QualificationFields.field_of_study,
  completion_year: QualificationFields.completion_year,
});

// ---- Teachers ------------------------------------------------------------------
export const TeacherFields = {
  staff_type: z.enum(STAFF_TYPE).optional(),
  first_name: Text(100),
  middle_name: OptText(100),
  last_name: Text(100),
  preferred_name: OptText(100),
  date_of_birth: DateOfBirth.nullable().optional(),
  gender: z.enum(GENDER).optional(),
  email: Email,
  phone: Phone,
  address: Address,
  joining_date: IsoDate.nullable().optional(),
  employment_type: z.enum(EMPLOYMENT_TYPE).optional(),
  department: OptText(100),
  designation: OptText(100),
  emergency_contact_name: OptText(150),
  emergency_contact_phone: Phone,
  emergency_contact_relation: OptText(50),
  reporting_manager_id: z.uuid().nullable().optional(),
  /** Write-only. Stored encrypted; responses only ever show the last 4 characters. null clears it. */
  id_number: z.string().trim().min(3).max(40).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
};

export const CreateTeacherBody = z.object({
  /** Leave empty to let the school's numbering generate one (TCH-YYYY-00001). */
  teacher_number: TeacherNumber.optional(),
  ...TeacherFields,
  /** Defaults to ACTIVE. A candidate may start PROSPECTIVE or ONBOARDING. */
  status: z.enum(['PROSPECTIVE', 'ONBOARDING', 'ACTIVE']).default('ACTIVE'),
  qualifications: z.array(QualificationBody).max(20).optional(),
  /** Acknowledge the "possible duplicate" warning and create anyway. */
  confirm_duplicate: z.boolean().optional(),
});

export const UpdateTeacherBody = z.object({
  version: Version,
  teacher_number: TeacherNumber.optional(),
  ...TeacherFields,
  first_name: TeacherFields.first_name.optional(),
  last_name: TeacherFields.last_name.optional(),
});

export const TeacherListQuery = PaginationQuery.extend({
  status: z.enum(TEACHER_STATUS).optional(),
  staff_type: z.enum(STAFF_TYPE).optional(),
  employment_type: z.enum(EMPLOYMENT_TYPE).optional(),
  department: z.string().trim().min(1).max(100).optional(),
  /** true = has a linked login (membership), false = none. */
  has_login: z.stringbool().optional(),
});

export const TeacherCommands = [
  'onboard',
  'activate',
  'start-leave',
  'return-from-leave',
  'deactivate',
  'resign',
  'retire',
  'terminate',
  'archive',
  'restore',
] as const;
export type TeacherCommand = (typeof TeacherCommands)[number];

export const TeacherCommandBody = z.object({
  reason: z.string().trim().min(3).max(500).optional(),
  /** When the change takes effect (defaults to today). */
  effective_date: IsoDate.optional(),
  /** resign / retire / terminate only: last day of employment (defaults to today, never in the future). */
  exit_date: IsoDate.optional(),
  /** start-leave only: last day of the leave (inclusive). Defaults to the effective date (a single day). */
  leave_end_date: IsoDate.optional(),
});

export const PortalAccessBody = z.object({
  role_id: z.uuid(),
  /** ASSIGNED (default): only the sections the teacher is assigned to. ALL: school-wide. */
  scope: z.enum(['ASSIGNED', 'ALL']).default('ASSIGNED'),
  /** Defaults to the teacher's email; required when the teacher has none. */
  email: z.email().max(254).toLowerCase().optional(),
});
export const RevokePortalBody = z.object({ reason: z.string().trim().min(3).max(500).optional() });

// ---- Teaching assignments ----------------------------------------------------------
export const CreateAssignmentBody = z.object({
  subject_offering_id: z.uuid(),
  role: z.enum(ASSIGNMENT_ROLE).default('PRIMARY'),
  start_date: IsoDate.optional(),
  reason: z.string().trim().max(500).optional(),
});
export const CreateAssignmentWithTeacherBody = CreateAssignmentBody.extend({
  teacher_id: z.uuid(),
});
export const EndAssignmentBody = z.object({
  end_date: IsoDate.optional(),
  reason: z.string().trim().min(3).max(500).optional(),
});
export const AssignmentListQuery = PaginationQuery.extend({
  teacher_id: z.uuid().optional(),
  subject_offering_id: z.uuid().optional(),
  academic_year_id: z.uuid().optional(),
  class_id: z.uuid().optional(),
  section_id: z.uuid().optional(),
  status: z.enum(TEACHING_ASSIGNMENT_STATUS).optional(),
});

// ---- Class teachers ----------------------------------------------------------------
export const SectionParams = z.object({ sectionId: z.uuid() });
export const ClassTeacherListQuery = z.object({ academic_year_id: z.uuid().optional() });
export const AssignClassTeacherBody = z.object({
  teacher_id: z.uuid(),
  start_date: z.iso.date().optional(),
  reason: z.string().trim().min(3).max(500).optional(),
});
