import { z } from 'zod';
import {
  CHANGE_REQUEST_STATUS,
  PARENT_MESSAGE_KIND,
  PARENT_MESSAGE_STATUS,
  PARENT_MESSAGE_TOPIC,
} from '../../db/schema/index.js';
import { PaginationQuery } from '../../shared/pagination.js';
import { UpdateGuardianBody, UpdateStudentBody } from '../students/students.schemas.js';

// ---- the parent's own details ------------------------------------------------------------

/** What a parent may change on their own record (not the sign-in mobile number). */
export const UpdateParentProfileBody = UpdateGuardianBody.pick({
  version: true,
  first_name: true,
  middle_name: true,
  last_name: true,
  email: true,
  address: true,
  occupation: true,
  preferred_channel: true,
  notify_email: true,
  notify_sms: true,
  notify_whatsapp: true,
  preferred_language: true,
});

// ---- child detail change requests ---------------------------------------------------------

/** Student fields a parent may ask to change (the office approves). */
export const STUDENT_REQUEST_FIELDS = [
  'first_name',
  'middle_name',
  'last_name',
  'preferred_name',
  'date_of_birth',
  'gender',
  'primary_email',
  'primary_phone',
  'nationality',
  'address',
  'blood_group',
] as const;
export type StudentRequestField = (typeof STUDENT_REQUEST_FIELDS)[number];

export const StudentRequestChanges = UpdateStudentBody.pick({
  first_name: true,
  middle_name: true,
  last_name: true,
  preferred_name: true,
  date_of_birth: true,
  gender: true,
  primary_email: true,
  primary_phone: true,
  nationality: true,
  address: true,
  blood_group: true,
});

export const CreateChangeRequestBody = z.object({
  /** Only the fields to change, with their new values. */
  changes: StudentRequestChanges,
  note: z.string().trim().max(1000).optional(),
});

export const ChangeRequestListQuery = PaginationQuery.extend({
  status: z.enum(CHANGE_REQUEST_STATUS).optional(),
  student_id: z.uuid().optional(),
});

export const DecideChangeRequestBody = z.object({ note: z.string().trim().max(1000).optional() });

// ---- complaints, feedback and suggestions ------------------------------------------------

export const CreateParentMessageBody = z.object({
  kind: z.enum(PARENT_MESSAGE_KIND),
  topic: z.enum(PARENT_MESSAGE_TOPIC).default('SCHOOL'),
  /** The child it is about (one of the parent's children), if any. */
  student_id: z.uuid().nullable().optional(),
  subject: z.string().trim().min(3).max(150),
  body: z.string().trim().min(3).max(5000),
});

export const ReplyBody = z.object({ body: z.string().trim().min(1).max(5000) });

export const ParentMessageListQuery = PaginationQuery.extend({
  kind: z.enum(PARENT_MESSAGE_KIND).optional(),
  status: z.enum(PARENT_MESSAGE_STATUS).optional(),
  topic: z.enum(PARENT_MESSAGE_TOPIC).optional(),
  /** Only ones with something new from the parent. */
  unread: z.stringbool().optional(),
  assigned_to_me: z.stringbool().optional(),
});

export const UpdateParentMessageBody = z.object({
  status: z.enum(PARENT_MESSAGE_STATUS).optional(),
  /** Staff user to handle it; null unassigns. */
  assigned_to: z.uuid().nullable().optional(),
});
