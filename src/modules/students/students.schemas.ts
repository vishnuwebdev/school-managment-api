import { z } from 'zod';
import {
  ADMISSION_STATUS,
  ENROLLMENT_STATUS,
  ENROLLMENT_TYPE,
  GENDER,
  GUARDIAN_CHANNEL,
  GUARDIAN_RELATION,
  ADMISSION_NUMBER_MODE,
  ADMISSION_TYPE,
  BLOOD_GROUP,
  GUARDIAN_STATUS,
  STUDENT_STATUS,
} from '../../db/schema/index.js';
import { PaginationQuery } from '../../shared/pagination.js';

export const IdParams = z.object({ id: z.uuid() });
export const StudentLinkParams = z.object({ id: z.uuid(), linkId: z.uuid() });
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

// ---- Guardians -------------------------------------------------------------
export const GuardianFields = {
  first_name: Text(100),
  middle_name: OptText(100),
  last_name: Text(100),
  email: Email,
  phone: Phone,
  address: Address,
  occupation: OptText(100),
  preferred_channel: z.enum(GUARDIAN_CHANNEL).nullable().optional(),
  notify_email: z.boolean().optional(),
  notify_sms: z.boolean().optional(),
  notify_whatsapp: z.boolean().optional(),
  preferred_language: OptText(16),
};
export const GuardianBody = z.object(GuardianFields);
/** Create a parent without linking a child yet. Same-phone / same-email matches need `confirm_duplicate`. */
export const CreateGuardianBody = GuardianBody.extend({
  confirm_duplicate: z.boolean().optional(),
});

const LinkFields = {
  relationship_type: z.enum(GUARDIAN_RELATION),
  relationship_label: OptText(64),
  is_primary: z.boolean().optional(),
  is_emergency_contact: z.boolean().optional(),
  can_pick_up: z.boolean().optional(),
  portal_access_allowed: z.boolean().optional(),
};
/** Link an existing guardian (guardian_id) or create one inline (guardian). */
export const LinkGuardianBody = z
  .object({
    guardian_id: z.uuid().optional(),
    guardian: GuardianBody.optional(),
    ...LinkFields,
  })
  .refine((b) => Boolean(b.guardian_id) !== Boolean(b.guardian), {
    message: 'Provide either guardian_id or guardian',
    path: ['guardian_id'],
  });
export const UpdateLinkBody = z.object({
  relationship_type: LinkFields.relationship_type.optional(),
  relationship_label: LinkFields.relationship_label,
  is_primary: LinkFields.is_primary,
  is_emergency_contact: LinkFields.is_emergency_contact,
  can_pick_up: LinkFields.can_pick_up,
  portal_access_allowed: LinkFields.portal_access_allowed,
});
export const UpdateGuardianBody = z.object({
  version: Version,
  first_name: Text(100).optional(),
  middle_name: OptText(100),
  last_name: Text(100).optional(),
  email: Email,
  phone: Phone,
  address: Address,
  occupation: OptText(100),
  preferred_channel: z.enum(GUARDIAN_CHANNEL).nullable().optional(),
  notify_email: z.boolean().optional(),
  notify_sms: z.boolean().optional(),
  notify_whatsapp: z.boolean().optional(),
  preferred_language: OptText(16),
});
export const GuardianListQuery = PaginationQuery.extend({
  status: z.enum(GUARDIAN_STATUS).optional(),
});

// ---- Enrollments -----------------------------------------------------------
export const EnrollBody = z.object({
  academic_year_id: z.uuid(),
  class_id: z.uuid(),
  section_id: z.uuid().nullable().optional(),
  enrollment_type: z.enum(ENROLLMENT_TYPE).default('NEW'),
  start_date: IsoDate.optional(),
  /** For an ADMITTED student, also make them ACTIVE (default). */
  activate_student: z.boolean().default(true),
});
export const ChangeEnrollmentBody = z
  .object({
    class_id: z.uuid().optional(),
    section_id: z.uuid().nullable().optional(),
    effective_date: IsoDate.optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine((b) => b.class_id !== undefined || b.section_id !== undefined, {
    message: 'Provide a new class and/or section',
    path: ['class_id'],
  });
export const CompleteEnrollmentBody = z.object({ end_date: IsoDate.optional() });
export const EnrollmentListQuery = PaginationQuery.extend({
  academic_year_id: z.uuid().optional(),
  class_id: z.uuid().optional(),
  section_id: z.uuid().optional(),
  student_id: z.uuid().optional(),
  status: z.enum(ENROLLMENT_STATUS).optional(),
});

// ---- Students --------------------------------------------------------------
export const StudentFields = {
  first_name: Text(100),
  middle_name: OptText(100),
  last_name: Text(100),
  preferred_name: OptText(100),
  date_of_birth: IsoDate.nullable().optional(),
  gender: z.enum(GENDER).optional(),
  primary_email: Email,
  primary_phone: Phone,
  nationality: OptText(64),
  address: Address,
  notes: z.string().trim().max(5000).nullable().optional(),
  blood_group: z.enum(BLOOD_GROUP).nullable().optional(),
  house_id: z.uuid().nullable().optional(),
  previous_school: OptText(200),
  category: OptText(64),
  admission_date: IsoDate.nullable().optional(),
  admission_type: z.enum(ADMISSION_TYPE).optional(),
  /** Write-only. Stored encrypted; responses show the last 4 characters. null clears it. */
  government_id: z.string().trim().min(3).max(40).nullable().optional(),
};
const AdmissionNumber = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9/_.-]{0,31}$/, 'Use letters, numbers and / _ . - (max 32)');
const StudentNumber = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9/_.-]{0,31}$/, 'Use letters, numbers and / _ . - (max 32)');

const DateOfBirth = IsoDate.refine((d) => d <= new Date().toISOString().slice(0, 10), {
  message: 'Date of birth cannot be in the future',
});

export const CreateStudentBody = z.object({
  /** Leave empty to let the school's numbering generate one. */
  student_number: StudentNumber.optional(),
  /** Needed when the school enters admission numbers by hand; ignored when they are generated. */
  admission_number: AdmissionNumber.optional(),
  ...StudentFields,
  date_of_birth: DateOfBirth.nullable().optional(),
  guardians: z.array(LinkGuardianBody).max(10).optional(),
  /** Enroll on creation → the student starts ACTIVE. Without it they start ADMITTED. */
  enrollment: EnrollBody.omit({ enrollment_type: true, activate_student: true })
    .extend({ enrollment_type: z.enum(ENROLLMENT_TYPE).default('NEW') })
    .optional(),
  /** Acknowledge the "possible duplicate" warning and create anyway. */
  confirm_duplicate: z.boolean().optional(),
});
export const UpdateStudentBody = z.object({
  version: Version,
  student_number: StudentNumber.optional(),
  admission_number: AdmissionNumber.optional(),
  first_name: Text(100).optional(),
  middle_name: OptText(100),
  last_name: Text(100).optional(),
  preferred_name: OptText(100),
  date_of_birth: DateOfBirth.nullable().optional(),
  gender: z.enum(GENDER).optional(),
  primary_email: Email,
  primary_phone: Phone,
  nationality: OptText(64),
  address: Address,
  notes: z.string().trim().max(5000).nullable().optional(),
  blood_group: StudentFields.blood_group,
  house_id: StudentFields.house_id,
  previous_school: StudentFields.previous_school,
  category: StudentFields.category,
  admission_date: StudentFields.admission_date,
  admission_type: StudentFields.admission_type,
  government_id: StudentFields.government_id,
});
export const StudentListQuery = PaginationQuery.extend({
  status: z.enum(STUDENT_STATUS).optional(),
  gender: z.enum(GENDER).optional(),
  admission_type: z.enum(ADMISSION_TYPE).optional(),
  house_id: z.uuid().optional(),
  academic_year_id: z.uuid().optional(),
  class_id: z.uuid().optional(),
  section_id: z.uuid().optional(),
  /** true = has an open enrollment, false = has none. */
  enrolled: z.stringbool().optional(),
});
export const StudentCommands = [
  'admit',
  'activate',
  'transfer',
  'withdraw',
  'graduate',
  'archive',
  'reinstate',
] as const;
export type StudentCommand = (typeof StudentCommands)[number];
export const StudentCommandBody = z.object({
  reason: z.string().trim().min(3).max(500).optional(),
  effective_date: IsoDate.optional(),
  /** withdraw / transfer only. */
  remarks: z.string().trim().max(1000).optional(),
  /** transfer only: the school the student is moving to. */
  destination_school: z.string().trim().max(200).optional(),
});

// ---- Admissions ------------------------------------------------------------
export const CreateAdmissionBody = z
  .object({
    student_id: z.uuid().optional(),
    student: z
      .object({ ...StudentFields, date_of_birth: DateOfBirth.nullable().optional() })
      .optional(),
    application_date: IsoDate.optional(),
    source: OptText(64),
    notes: z.string().trim().max(5000).nullable().optional(),
    confirm_duplicate: z.boolean().optional(),
  })
  .refine((b) => Boolean(b.student_id) !== Boolean(b.student), {
    message: 'Provide either student_id or student',
    path: ['student_id'],
  });
export const ApproveAdmissionBody = z.object({
  admission_date: IsoDate.optional(),
  note: z.string().trim().max(500).optional(),
});
export const AdmissionListQuery = PaginationQuery.extend({
  status: z.enum(ADMISSION_STATUS).optional(),
});

// ---- Houses and settings -------------------------------------------------------
export const HouseParams = z.object({ id: z.uuid() });
export const CreateHouseBody = z.object({
  name: Text(64),
  sort_order: z.number().int().min(0).max(9999).default(0),
});
export const UpdateHouseBody = z.object({
  name: Text(64).optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
});
export const UpdateStudentSettingsBody = z.object({
  admission_number_mode: z.enum(ADMISSION_NUMBER_MODE),
});

// ---- Bulk placement (class roster tools) -----------------------------------
const StudentIds = z.array(z.uuid()).min(1).max(200);
/** Move students of one year into another section (or class) of that same year. */
export const BulkMoveBody = z.object({
  student_ids: StudentIds,
  to_section_id: z.uuid(),
  reason: z.string().trim().min(3).max(500),
  effective_date: IsoDate.optional(),
});
/** Year-end: complete each open enrollment and enroll in the next year as a promotion. */
export const BulkPromoteBody = z.object({
  student_ids: StudentIds,
  to_academic_year_id: z.uuid(),
  to_class_id: z.uuid(),
  to_section_id: z.uuid().nullable().optional(),
  effective_date: IsoDate.optional(),
});
