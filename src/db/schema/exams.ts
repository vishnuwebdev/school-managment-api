import {
  boolean,
  date,
  decimal,
  foreignKey,
  index,
  mysqlEnum,
  mysqlTable,
  time,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';
import { createdAt, dt, id, ref, updatedAt, version } from './_columns.js';
import { academicClasses, academicSections, academicYears, subjects } from './academic.js';
import { EXAM_STATUS, EXAM_TYPE } from './enums.js';
import { students } from './students.js';
import { teachers } from './teachers.js';
import { timetableVenues } from './timetable.js';
import { tenants } from './tenancy.js';

/**
 * Examinations, kept deliberately simple: an exam (Term 1 Unit Test) has one paper per
 * class and subject, and each paper has one mark per student. Results (total, percentage,
 * grade, rank) are always calculated from the marks, never stored.
 */
export const exams = mysqlTable(
  'exams',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    academicYearId: ref('academic_year_id').notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    examType: mysqlEnum('exam_type', EXAM_TYPE).notNull().default('UNIT_TEST'),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    status: mysqlEnum('status', EXAM_STATUS).notNull().default('DRAFT'),
    /** A teacher's own test: only this section sits it (0043). Null = every section of its classes. */
    sectionId: ref('section_id'),
    /** The teacher who created this test in the teacher app (0043); null for office exams. */
    teacherId: ref('teacher_id'),
    publishedAt: dt('published_at'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('exams_tenant_id_uq').on(t.tenantId, t.id),
    index('exams_year_idx').on(t.tenantId, t.academicYearId, t.status),
    index('exams_teacher_idx').on(t.tenantId, t.teacherId),
    foreignKey({
      name: 'exams_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
    }),
  ],
);

/**
 * The classes that sit an exam. Kept apart from the papers so a class with no
 * subjects offered yet still belongs to the exam and its papers can be added by hand.
 */
export const examClasses = mysqlTable(
  'exam_classes',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    examId: ref('exam_id').notNull(),
    classId: ref('class_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('exam_classes_uq').on(t.tenantId, t.examId, t.classId),
    foreignKey({
      name: 'exam_classes_exam_fk',
      columns: [t.tenantId, t.examId],
      foreignColumns: [exams.tenantId, exams.id],
    }),
    foreignKey({
      name: 'exam_classes_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [academicClasses.tenantId, academicClasses.id],
    }),
  ],
);

/** One subject paper of one class in an exam. */
export const examPapers = mysqlTable(
  'exam_papers',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    examId: ref('exam_id').notNull(),
    classId: ref('class_id').notNull(),
    subjectId: ref('subject_id').notNull(),
    examDate: date('exam_date', { mode: 'string' }),
    /** When the paper is sat (both or neither). Sections can override (exam_paper_sittings). */
    startTime: time('start_time'),
    endTime: time('end_time'),
    venueId: ref('venue_id'),
    maxMarks: decimal('max_marks', { precision: 6, scale: 2 }).notNull().default('100.00'),
    passMarks: decimal('pass_marks', { precision: 6, scale: 2 }).notNull().default('35.00'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('exam_papers_tenant_id_uq').on(t.tenantId, t.id),
    uniqueIndex('exam_papers_uq').on(t.tenantId, t.examId, t.classId, t.subjectId),
    index('exam_papers_class_idx').on(t.tenantId, t.examId, t.classId),
    foreignKey({
      name: 'exam_papers_exam_fk',
      columns: [t.tenantId, t.examId],
      foreignColumns: [exams.tenantId, exams.id],
    }),
    foreignKey({
      name: 'exam_papers_class_fk',
      columns: [t.tenantId, t.classId],
      foreignColumns: [academicClasses.tenantId, academicClasses.id],
    }),
    foreignKey({
      name: 'exam_papers_subject_fk',
      columns: [t.tenantId, t.subjectId],
      foreignColumns: [subjects.tenantId, subjects.id],
    }),
    foreignKey({
      name: 'exam_papers_venue_fk',
      columns: [t.tenantId, t.venueId],
      foreignColumns: [timetableVenues.tenantId, timetableVenues.id],
    }),
    index('exam_papers_date_idx').on(t.tenantId, t.examDate),
  ],
);

/**
 * A section that sits a paper differently from the rest of its class: its own
 * date / time / venue. A NULL column means "same as the class".
 */
export const examPaperSittings = mysqlTable(
  'exam_paper_sittings',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paperId: ref('paper_id').notNull(),
    sectionId: ref('section_id').notNull(),
    examDate: date('exam_date', { mode: 'string' }),
    startTime: time('start_time'),
    endTime: time('end_time'),
    venueId: ref('venue_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('exam_paper_sittings_uq').on(t.tenantId, t.paperId, t.sectionId),
    index('exam_paper_sittings_date_idx').on(t.tenantId, t.examDate),
    foreignKey({
      name: 'exam_paper_sittings_paper_fk',
      columns: [t.tenantId, t.paperId],
      foreignColumns: [examPapers.tenantId, examPapers.id],
    }),
    foreignKey({
      name: 'exam_paper_sittings_section_fk',
      columns: [t.tenantId, t.sectionId],
      foreignColumns: [academicSections.tenantId, academicSections.id],
    }),
    foreignKey({
      name: 'exam_paper_sittings_venue_fk',
      columns: [t.tenantId, t.venueId],
      foreignColumns: [timetableVenues.tenantId, timetableVenues.id],
    }),
  ],
);

/**
 * Who runs a paper. INVIGILATOR supervises the sitting (section_id set = only that
 * section's sitting, replacing the class invigilators there); MARKER may enter its marks.
 */
export const examPaperStaff = mysqlTable(
  'exam_paper_staff',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paperId: ref('paper_id').notNull(),
    sectionId: ref('section_id'),
    sectionKey: varchar('section_key', { length: 36 }).generatedAlwaysAs(
      sql`(IFNULL(\`section_id\`, ''))`,
      {
        mode: 'virtual',
      },
    ),
    teacherId: ref('teacher_id').notNull(),
    role: mysqlEnum('role', ['INVIGILATOR', 'MARKER']).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('exam_paper_staff_uq').on(t.tenantId, t.paperId, t.sectionKey, t.teacherId, t.role),
    index('exam_paper_staff_teacher_idx').on(t.tenantId, t.teacherId, t.role),
    foreignKey({
      name: 'exam_paper_staff_paper_fk',
      columns: [t.tenantId, t.paperId],
      foreignColumns: [examPapers.tenantId, examPapers.id],
    }),
    foreignKey({
      name: 'exam_paper_staff_section_fk',
      columns: [t.tenantId, t.sectionId],
      foreignColumns: [academicSections.tenantId, academicSections.id],
    }),
    foreignKey({
      name: 'exam_paper_staff_teacher_fk',
      columns: [t.tenantId, t.teacherId],
      foreignColumns: [teachers.tenantId, teachers.id],
    }),
  ],
);

/** A student's mark in one paper. `marks` is NULL when absent or not yet entered. */
export const examMarks = mysqlTable(
  'exam_marks',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paperId: ref('paper_id').notNull(),
    studentId: ref('student_id').notNull(),
    marks: decimal('marks', { precision: 6, scale: 2 }),
    absent: boolean('absent').notNull().default(false),
    remark: varchar('remark', { length: 200 }),
    enteredBy: ref('entered_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('exam_marks_uq').on(t.tenantId, t.paperId, t.studentId),
    index('exam_marks_student_idx').on(t.tenantId, t.studentId),
    foreignKey({
      name: 'exam_marks_paper_fk',
      columns: [t.tenantId, t.paperId],
      foreignColumns: [examPapers.tenantId, examPapers.id],
    }),
    foreignKey({
      name: 'exam_marks_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
  ],
);

/**
 * Hand-in state of a paper's marks for one section (0043). DRAFT while the teacher
 * works; SUBMITTED once every student has a mark and the teacher hands it to the
 * office (locked for the teacher). The office can return it (back to DRAFT).
 */
export const examPaperSections = mysqlTable(
  'exam_paper_sections',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    paperId: ref('paper_id').notNull(),
    sectionId: ref('section_id').notNull(),
    status: mysqlEnum('status', ['DRAFT', 'SUBMITTED']).notNull().default('DRAFT'),
    submittedBy: ref('submitted_by'),
    submittedAt: dt('submitted_at'),
    returnedBy: ref('returned_by'),
    returnedAt: dt('returned_at'),
    returnNote: varchar('return_note', { length: 500 }),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('exam_paper_sections_uq').on(t.tenantId, t.paperId, t.sectionId)],
);

/**
 * The class teacher's remark on a student's report card for one exam (0045). Parents see it
 * only when `share_with_parent` is on and the exam's results are published.
 */
export const examStudentRemarks = mysqlTable(
  'exam_student_remarks',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    examId: ref('exam_id').notNull(),
    studentId: ref('student_id').notNull(),
    remark: varchar('remark', { length: 1000 }).notNull(),
    shareWithParent: boolean('share_with_parent').notNull().default(false),
    /** The teacher who wrote it (null when the office wrote it). */
    teacherId: ref('teacher_id'),
    createdBy: ref('created_by'),
    updatedBy: ref('updated_by'),
    version: version(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('exam_student_remarks_uq').on(t.tenantId, t.examId, t.studentId),
    index('exam_student_remarks_student_idx').on(t.tenantId, t.studentId),
    foreignKey({
      name: 'exam_student_remarks_exam_fk',
      columns: [t.tenantId, t.examId],
      foreignColumns: [exams.tenantId, exams.id],
    }),
    foreignKey({
      name: 'exam_student_remarks_student_fk',
      columns: [t.tenantId, t.studentId],
      foreignColumns: [students.tenantId, students.id],
    }),
  ],
);
