import { z } from 'zod';
import { EXAM_STATUS, EXAM_TYPE } from '../../db/schema/index.js';

export const IdParams = z.object({ id: z.uuid() });
export const PaperParams = z.object({ paper_id: z.uuid() });
export const ClassParams = z.object({ id: z.uuid(), class_id: z.uuid() });
export const StudentParams = z.object({ id: z.uuid() });

const IsoDate = z.iso.date();
const Marks = z.number().min(0).max(1000);

export const ExamListQuery = z.object({
  status: z.enum(EXAM_STATUS).optional(),
  year_id: z.uuid().optional(),
});

export const CreateExamBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    exam_type: z.enum(EXAM_TYPE).default('UNIT_TEST'),
    /** Defaults to the current academic year. */
    academic_year_id: z.uuid().optional(),
    start_date: IsoDate.optional(),
    end_date: IsoDate.optional(),
    /** A paper is created for every subject each of these classes studies. */
    class_ids: z.array(z.uuid()).min(1).max(40),
    default_max_marks: Marks.positive().default(100),
    default_pass_marks: Marks.default(35),
  })
  .refine((b) => !b.start_date || !b.end_date || b.start_date <= b.end_date, {
    message: 'The exam must end on or after its start date',
    path: ['end_date'],
  })
  .refine((b) => b.default_pass_marks <= b.default_max_marks, {
    message: 'Pass marks cannot be more than the maximum',
    path: ['default_pass_marks'],
  });

export const UpdateExamBody = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(2).max(120).optional(),
  exam_type: z.enum(EXAM_TYPE).optional(),
  start_date: IsoDate.nullable().optional(),
  end_date: IsoDate.nullable().optional(),
});

export const AddClassesBody = z.object({
  class_ids: z.array(z.uuid()).min(1).max(40),
  default_max_marks: Marks.positive().default(100),
  default_pass_marks: Marks.default(35),
});

export const PaperListQuery = z.object({ class_id: z.uuid().optional() });

export const CreatePaperBody = z.object({
  class_id: z.uuid(),
  subject_id: z.uuid(),
  exam_date: IsoDate.nullable().optional(),
  max_marks: Marks.positive().default(100),
  pass_marks: Marks.default(35),
});

export const UpdatePaperBody = z
  .object({
    exam_date: IsoDate.nullable().optional(),
    max_marks: Marks.positive().optional(),
    pass_marks: Marks.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Send something to change');

export const SaveMarksBody = z.object({
  records: z
    .array(
      z.object({
        student_id: z.uuid(),
        /** null = not entered (clears it). Ignored when absent. */
        marks: Marks.nullable().optional(),
        absent: z.boolean().default(false),
        remark: z.string().trim().max(200).nullable().optional(),
      }),
    )
    .min(1)
    .max(500),
});

export const ResultsQuery = z.object({ class_id: z.uuid() });

/** The office returns a section's handed-in marks to the teacher. */
export const ReturnMarksBody = z.object({
  note: z.string().trim().max(500).nullable().optional(),
});

export const PublishBody = z.object({
  /** Publish even though some marks are still missing. */
  allow_incomplete: z.boolean().default(false),
});

// ---- exam timetable ------------------------------------------------------------------

/** 'HH:MM' (24h). */
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
const TeacherIds = z.array(z.uuid()).max(20);

export const SectionParams = z.object({ paper_id: z.uuid(), section_id: z.uuid() });

/**
 * When, where and by whom a paper is sat by the whole class. Omitted fields are kept;
 * null clears. Times go together and need a date.
 */
export const PaperScheduleBody = z
  .object({
    exam_date: IsoDate.nullable().optional(),
    start_time: Clock.nullable().optional(),
    end_time: Clock.nullable().optional(),
    venue_id: z.uuid().nullable().optional(),
    invigilator_ids: TeacherIds.optional(),
    marker_ids: TeacherIds.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Send something to change');

/** A section sitting differently. null / omitted date, times or venue = same as the class. */
export const SectionScheduleBody = z.object({
  exam_date: IsoDate.nullable().optional(),
  start_time: Clock.nullable().optional(),
  end_time: Clock.nullable().optional(),
  venue_id: z.uuid().nullable().optional(),
  /** Omitted or empty = the class invigilators supervise this section too. */
  invigilator_ids: TeacherIds.optional(),
});

export const DutiesQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});
