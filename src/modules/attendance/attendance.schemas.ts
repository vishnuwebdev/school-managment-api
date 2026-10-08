import { z } from 'zod';
import {
  ATTENDANCE_CORRECTION_STATUS,
  ATTENDANCE_SESSION_STATUS,
  ATTENDANCE_STATUS_CATEGORY,
  ATTENDANCE_TYPE,
} from '../../db/schema/index.js';
import { PaginationQuery } from '../../shared/pagination.js';

export const IdParams = z.object({ id: z.uuid() });
const Version = z.number().int().positive();
const IsoDate = z.iso.date();
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const Remarks = z.string().trim().max(500).nullable().optional();
const Reason = z.string().trim().min(3).max(500);
const Weight = z.number().min(0).max(1).multipleOf(0.01);
const Percent = z.number().min(0).max(100);

// ---- Statuses ------------------------------------------------------------------
export const StatusCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z][A-Z0-9_]{1,31}$/,
    'Use letters, numbers and underscore (2–32, start with a letter)',
  );

export const StatusListQuery = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});
export const CreateStatusBody = z
  .object({
    code: StatusCode,
    name: z.string().trim().min(1).max(80),
    category: z.enum(ATTENDANCE_STATUS_CATEGORY),
    /** Defaults from the category (PRESENT 1/0, ABSENT 0/1, HALF_DAY .5/.5, EXCUSED 1/0, LEAVE 0/1, OTHER 0/0). */
    counts_as_present: Weight.optional(),
    counts_as_absent: Weight.optional(),
    requires_reason: z.boolean().default(false),
    sort_order: z.number().int().min(0).max(10_000).default(100),
  })
  .refine((b) => (b.counts_as_present ?? 0) + (b.counts_as_absent ?? 0) <= 1.0001, {
    message: 'counts_as_present + counts_as_absent cannot exceed 1',
    path: ['counts_as_absent'],
  });
export const UpdateStatusBody = z.object({
  version: Version,
  name: z.string().trim().min(1).max(80).optional(),
  category: z.enum(ATTENDANCE_STATUS_CATEGORY).optional(),
  counts_as_present: Weight.optional(),
  counts_as_absent: Weight.optional(),
  requires_reason: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(10_000).optional(),
});

// ---- Settings ------------------------------------------------------------------
export const UpdateSettingsBody = z.object({
  version: Version,
  approval_required: z.boolean().optional(),
  correction_requires_approval: z.boolean().optional(),
  edit_window_days: z.number().int().min(0).max(365).optional(),
  defaulter_threshold_percent: Percent.optional(),
  late_counts_as_present: z.boolean().optional(),
});

// ---- Sessions ------------------------------------------------------------------
export const OpenSessionBody = z.object({
  attendance_type: z.enum(ATTENDANCE_TYPE).default('DAILY'),
  section_id: z.uuid(),
  session_date: IsoDate,
  /** SUBJECT sessions only. */
  subject_offering_id: z.uuid().optional(),
  /** SUBJECT sessions only: "Period 2", "08:00"… Distinguishes several sessions of one offering per day. */
  period_label: z.string().trim().min(1).max(40).optional(),
});

export const SessionListQuery = PaginationQuery.extend({
  section_id: z.uuid().optional(),
  class_id: z.uuid().optional(),
  academic_year_id: z.uuid().optional(),
  attendance_type: z.enum(ATTENDANCE_TYPE).optional(),
  status: z.enum(ATTENDANCE_SESSION_STATUS).optional(),
  date_from: IsoDate.optional(),
  date_to: IsoDate.optional(),
});

const RecordEntry = z.object({
  student_id: z.uuid(),
  status_id: z.uuid(),
  remarks: Remarks,
});
export const SaveRecordsBody = z
  .object({
    /** Optional optimistic check: the session version you read. */
    version: Version.optional(),
    records: z.array(RecordEntry).min(1).max(500),
  })
  .superRefine((b, ctx) => {
    const seen = new Set<string>();
    b.records.forEach((r, i) => {
      if (seen.has(r.student_id))
        ctx.addIssue({
          code: 'custom',
          path: ['records', i, 'student_id'],
          message: 'Duplicate student in the request',
        });
      seen.add(r.student_id);
    });
  });
export const MarkAllBody = z.object({
  version: Version.optional(),
  /** Defaults to the system PRESENT status. */
  status_id: z.uuid().optional(),
  remarks: Remarks,
  /** false (default): only students without a record; true: replace everyone's mark. */
  overwrite: z.boolean().default(false),
});
export const SessionCommandBody = z.object({ version: Version.optional() });
export const SessionReasonBody = z.object({ version: Version.optional(), reason: Reason });

// ---- Corrections -----------------------------------------------------------------
export const RequestCorrectionBody = z.object({
  new_status_id: z.uuid(),
  reason: Reason,
});
export const ApproveCorrectionBody = z.object({ note: z.string().trim().max(500).optional() });
export const RejectCorrectionBody = z.object({ reason: Reason });
export const CorrectionListQuery = PaginationQuery.extend({
  status: z.enum(ATTENDANCE_CORRECTION_STATUS).optional(),
  section_id: z.uuid().optional(),
  student_id: z.uuid().optional(),
  session_id: z.uuid().optional(),
  record_id: z.uuid().optional(),
  date_from: IsoDate.optional(),
  date_to: IsoDate.optional(),
});

// ---- Reads / reports ---------------------------------------------------------------
export const TodayQuery = z.object({ date: IsoDate.optional() });
export const RegisterQuery = z.object({
  section_id: z.uuid(),
  date_from: IsoDate,
  date_to: IsoDate,
});
export const MonthlyQuery = z.object({ section_id: z.uuid(), month: Month });
export const DefaultersQuery = PaginationQuery.extend({
  academic_year_id: z.uuid().optional(),
  class_id: z.uuid().optional(),
  section_id: z.uuid().optional(),
  /** Percent, 0–100. Defaults to the school's setting. Students strictly below it are listed. */
  threshold: z.coerce.number().min(0).max(100).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});
export const StudentHistoryQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  academic_year_id: z.uuid().optional(),
});
