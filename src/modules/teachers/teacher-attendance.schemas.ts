import { z } from 'zod';
import { TEACHER_ATTENDANCE_STATUS } from '../../db/schema/teacher-attendance.js';

const IsoDate = z.iso.date();
const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

export const AttendanceDayQuery = z.object({ date: IsoDate });
export const AttendanceMonthQuery = z.object({ month: Month });
export const MarkAttendanceBody = z.object({
  entries: z
    .array(
      z.object({
        teacher_id: z.uuid(),
        status: z.enum(TEACHER_ATTENDANCE_STATUS),
        note: z.string().trim().max(255).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

// ---- teacher attendance register

export const RegisterQuery = z.object({
  month: Month,
  department: z.string().trim().max(100).optional(),
  q: z.string().trim().max(100).optional(),
  /** CSV only: add one column per day (P, L, H, A, LV, OFF, HOL, ?). */
  with_days: z.stringbool().optional(),
});
export const TeacherParams = z.object({ id: z.uuid() });
export const TeacherDayParams = z.object({ id: z.uuid(), date: IsoDate });
export const TeacherYearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
/** status null clears the day's mark. */
export const SetDayBody = z.object({
  status: z.enum(TEACHER_ATTENDANCE_STATUS).nullable(),
  note: z.string().trim().max(255).nullable().optional(),
});
