import { z } from 'zod';
import { SaveMarksBody } from '../exams/exams.schemas.js';

const IsoDate = z.iso.date();
const Marks = z.number().min(0).max(1000);

export const PaperIdParams = z.object({ paperId: z.uuid() });
export const ExamIdParams = z.object({ examId: z.uuid() });
export const DutiesRangeQuery = z.object({ from: IsoDate.optional(), to: IsoDate.optional() });

/** Same shape as the office's marks body; only students in my sections are accepted. */
export const TeacherMarksBody = SaveMarksBody;

/** Hand one section's marks in to the office. */
export const SubmitMarksBody = z.object({ section_id: z.uuid() });

/** My own test: one section, one subject I teach there. */
export const CreateTestBody = z.object({
  name: z.string().trim().min(2).max(120),
  section_id: z.uuid(),
  subject_id: z.uuid(),
  exam_date: IsoDate.optional(),
  max_marks: Marks.positive().default(50),
  pass_marks: Marks.default(20),
});
