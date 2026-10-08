import { z } from 'zod';
import { LEAVE_STATUS, STAFF_ATTENDANCE_STATUS } from '../../db/schema/leave.js';
import { PaginationQuery } from '../../shared/pagination.js';

const IsoDate = z.iso.date();
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

export const LeaveTypeCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[A-Z][A-Z0-9_]{1,31}$/,
    'Use letters, numbers and underscores (2–32), starting with a letter',
  );

export const CreateLeaveTypeBody = z.object({
  code: LeaveTypeCode,
  name: z.string().trim().min(2).max(100),
  annual_quota: z.number().int().min(0).max(366).nullable().default(null),
  is_paid: z.boolean().default(true),
  sort_order: z.number().int().min(0).max(999).default(50),
});
export const UpdateLeaveTypeBody = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  annual_quota: z.number().int().min(0).max(366).nullable().optional(),
  is_paid: z.boolean().optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(999).optional(),
});
export const LeaveTypeParams = z.object({ id: z.uuid() });
export const LeaveParams = z.object({ id: z.uuid() });

export const CreateLeaveBody = z.object({
  /** Only for requests entered on someone's behalf (needs leave.approve). */
  teacher_id: z.uuid().optional(),
  leave_type_id: z.uuid(),
  start_date: IsoDate,
  end_date: IsoDate,
  reason: z.string().trim().min(3).max(500).optional(),
});
export const DecideLeaveBody = z.object({ note: z.string().trim().min(3).max(500).optional() });
export const RejectLeaveBody = z.object({ note: z.string().trim().min(3).max(500) });
export const CancelLeaveBody = z.object({ reason: z.string().trim().min(3).max(500).optional() });

export const LeaveListQuery = PaginationQuery.extend({
  status: z.enum(LEAVE_STATUS).optional(),
  teacher_id: z.uuid().optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});
export const LeaveBalanceQuery = z.object({
  teacher_id: z.uuid().optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const AttendanceDayQuery = z.object({ date: IsoDate });
export const AttendanceMonthQuery = z.object({ month: Month });
export const MarkAttendanceBody = z.object({
  entries: z
    .array(
      z.object({
        teacher_id: z.uuid(),
        status: z.enum(STAFF_ATTENDANCE_STATUS),
        note: z.string().trim().max(255).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});
