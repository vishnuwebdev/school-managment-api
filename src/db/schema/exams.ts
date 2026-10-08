import {
  boolean,
  date,
  decimal,
  foreignKey,
  index,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt, version } from './_columns.js';
import { academicClasses, academicYears, subjects } from './academic.js';
import { EXAM_STATUS, EXAM_TYPE } from './enums.js';
import { students } from './students.js';
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
    publishedAt: dt('published_at'),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('exams_tenant_id_uq').on(t.tenantId, t.id),
    index('exams_year_idx').on(t.tenantId, t.academicYearId, t.status),
    foreignKey({
      name: 'exams_year_fk',
      columns: [t.tenantId, t.academicYearId],
      foreignColumns: [academicYears.tenantId, academicYears.id],
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
