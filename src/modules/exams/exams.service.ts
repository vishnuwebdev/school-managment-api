import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  enrollments,
  examMarks,
  examPapers,
  exams,
  students,
  subjectOfferings,
  subjects,
} from '../../db/schema/index.js';
import type { Actor } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import type {
  AddClassesBody,
  CreateExamBody,
  CreatePaperBody,
  ExamListQuery,
  PublishBody,
  SaveMarksBody,
  UpdateExamBody,
  UpdatePaperBody,
} from './exams.schemas.js';

type Exam = typeof exams.$inferSelect;

/** The grading scale. Fixed for now (a per-school scale can replace it later). */
export const GRADE_SCALE = [
  { min: 90, grade: 'A+', remark: 'Outstanding' },
  { min: 80, grade: 'A', remark: 'Excellent' },
  { min: 70, grade: 'B+', remark: 'Very good' },
  { min: 60, grade: 'B', remark: 'Good' },
  { min: 50, grade: 'C', remark: 'Satisfactory' },
  { min: 40, grade: 'D', remark: 'Needs improvement' },
  { min: 0, grade: 'F', remark: 'Fail' },
] as const;

export const gradeOf = (pct: number) =>
  (GRADE_SCALE.find((g) => pct >= g.min) ?? GRADE_SCALE[GRADE_SCALE.length - 1]!).grade;

const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const fullName = (s: { firstName: string; lastName: string }) => `${s.firstName} ${s.lastName}`;

export class ExamService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  // ---- helpers ---------------------------------------------------------------------

  private async loadExam(tenantId: string, id: string, ex: Executor = this.db): Promise<Exam> {
    const [row] = await ex
      .select()
      .from(exams)
      .where(and(eq(exams.tenantId, tenantId), eq(exams.id, id)));
    if (!row) throw new NotFoundError('Exam');
    return row;
  }

  private async loadPaper(tenantId: string, paperId: string, ex: Executor = this.db) {
    const [paper] = await ex
      .select()
      .from(examPapers)
      .where(and(eq(examPapers.tenantId, tenantId), eq(examPapers.id, paperId)));
    if (!paper) throw new NotFoundError('Paper');
    const exam = await this.loadExam(tenantId, paper.examId, ex);
    return { paper, exam };
  }

  private assertOpen(exam: Exam) {
    if (exam.status === 'PUBLISHED')
      throw new BusinessRuleError(
        'INVALID_STATE',
        'These results are published. Reopen the exam to change it',
        { reason: 'EXAM_PUBLISHED' },
      );
  }

  /** Active students of a class in the exam's year (optionally narrowed to some classes). */
  private async roster(tenantId: string, yearId: string, classId: string, ex: Executor = this.db) {
    return ex
      .select({
        studentId: students.id,
        firstName: students.firstName,
        lastName: students.lastName,
        admissionNumber: students.admissionNumber,
        studentNumber: students.studentNumber,
        sectionId: academicSections.id,
        sectionName: academicSections.name,
      })
      .from(enrollments)
      .innerJoin(
        students,
        and(eq(students.tenantId, enrollments.tenantId), eq(students.id, enrollments.studentId)),
      )
      .leftJoin(
        academicSections,
        and(
          eq(academicSections.tenantId, enrollments.tenantId),
          eq(academicSections.id, enrollments.sectionId),
        ),
      )
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.academicYearId, yearId),
          eq(enrollments.classId, classId),
          eq(enrollments.status, 'ACTIVE'),
        ),
      )
      .orderBy(asc(academicSections.name), asc(students.firstName), asc(students.lastName));
  }

  /** Create a paper for every subject the class studies that year (existing papers are kept). */
  private async addPapersForClasses(
    tx: Executor,
    tenantId: string,
    exam: Exam,
    classIds: string[],
    maxMarks: number,
    passMarks: number,
  ) {
    const classes = await tx
      .select({ id: academicClasses.id })
      .from(academicClasses)
      .where(and(eq(academicClasses.tenantId, tenantId), inArray(academicClasses.id, classIds)));
    if (classes.length !== new Set(classIds).size) throw new NotFoundError('Class');
    const offered = await tx
      .select({ classId: subjectOfferings.classId, subjectId: subjectOfferings.subjectId })
      .from(subjectOfferings)
      .where(
        and(
          eq(subjectOfferings.tenantId, tenantId),
          eq(subjectOfferings.academicYearId, exam.academicYearId),
          eq(subjectOfferings.status, 'ACTIVE'),
          inArray(subjectOfferings.classId, classIds),
        ),
      );
    const seen = new Set<string>();
    const values = offered
      .filter((o) => {
        const k = `${o.classId}:${o.subjectId}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((o) => ({
        tenantId,
        examId: exam.id,
        classId: o.classId,
        subjectId: o.subjectId,
        examDate: null,
        maxMarks: String(maxMarks),
        passMarks: String(passMarks),
      }));
    if (values.length)
      await tx
        .insert(examPapers)
        .values(values)
        .onDuplicateKeyUpdate({ set: { examId: sql`${examPapers.examId}` } });
    return values.length;
  }

  /** Counts per exam: classes, papers, marks expected and marks entered. */
  private async stats(tenantId: string, list: Exam[]) {
    const out = new Map<
      string,
      { classes: number; papers: number; expected: number; entered: number; scheduled: number }
    >();
    for (const e of list) out.set(e.id, { classes: 0, papers: 0, expected: 0, entered: 0, scheduled: 0 });
    if (!list.length) return out;
    const ids = list.map((e) => e.id);
    const papers = await this.db
      .select()
      .from(examPapers)
      .where(and(eq(examPapers.tenantId, tenantId), inArray(examPapers.examId, ids)));
    const years = [...new Set(list.map((e) => e.academicYearId))];
    const rosterRows = await this.db
      .select({
        yearId: enrollments.academicYearId,
        classId: enrollments.classId,
        n: sql<number>`count(*)`,
      })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.status, 'ACTIVE'),
          inArray(enrollments.academicYearId, years),
        ),
      )
      .groupBy(enrollments.academicYearId, enrollments.classId);
    const rosterSize = new Map(rosterRows.map((r) => [`${r.yearId}:${r.classId}`, Number(r.n)]));
    const entered = papers.length
      ? await this.db
          .select({ paperId: examMarks.paperId, n: sql<number>`count(*)` })
          .from(examMarks)
          .where(
            and(
              eq(examMarks.tenantId, tenantId),
              inArray(
                examMarks.paperId,
                papers.map((p) => p.id),
              ),
              or(isNotNull(examMarks.marks), eq(examMarks.absent, true)),
            ),
          )
          .groupBy(examMarks.paperId)
      : [];
    const enteredBy = new Map(entered.map((r) => [r.paperId, Number(r.n)]));
    const examYear = new Map(list.map((e) => [e.id, e.academicYearId]));
    const classSets = new Map<string, Set<string>>();
    for (const p of papers) {
      const s = out.get(p.examId)!;
      s.papers++;
      if (p.examDate) s.scheduled++;
      s.expected += rosterSize.get(`${examYear.get(p.examId)}:${p.classId}`) ?? 0;
      s.entered += enteredBy.get(p.id) ?? 0;
      if (!classSets.has(p.examId)) classSets.set(p.examId, new Set());
      classSets.get(p.examId)!.add(p.classId);
    }
    for (const [id, set] of classSets) out.get(id)!.classes = set.size;
    return out;
  }

  /** Where the exam is in its life: set up → marking → ready → published. */
  private stage(e: Exam, s: { papers: number; expected: number; entered: number }) {
    if (e.status === 'PUBLISHED') return 'PUBLISHED';
    if (s.papers === 0) return 'SETUP';
    if (s.expected > 0 && s.entered >= s.expected) return 'READY';
    return 'MARKING';
  }

  private present(
    e: Exam,
    year: string | undefined,
    s: { classes: number; papers: number; expected: number; entered: number; scheduled: number },
  ) {
    return {
      id: e.id,
      name: e.name,
      exam_type: e.examType,
      academic_year_id: e.academicYearId,
      academic_year_name: year ?? null,
      start_date: e.startDate,
      end_date: e.endDate,
      status: e.status,
      stage: this.stage(e, s),
      published_at: e.publishedAt,
      version: e.version,
      classes: s.classes,
      papers: s.papers,
      papers_scheduled: s.scheduled,
      marks_expected: s.expected,
      marks_entered: s.entered,
      progress_percent: s.expected ? Math.min(100, Math.round((s.entered / s.expected) * 100)) : 0,
    };
  }

  private async yearNames(tenantId: string) {
    const rows = await this.db
      .select({ id: academicYears.id, name: academicYears.name })
      .from(academicYears)
      .where(eq(academicYears.tenantId, tenantId));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  // ---- exams -----------------------------------------------------------------------

  async list(tenantId: string, q: z.infer<typeof ExamListQuery>) {
    const conds = [eq(exams.tenantId, tenantId)];
    if (q.status) conds.push(eq(exams.status, q.status));
    if (q.year_id) conds.push(eq(exams.academicYearId, q.year_id));
    const rows = await this.db
      .select()
      .from(exams)
      .where(and(...conds))
      .orderBy(sql`${exams.startDate} is null`, sql`${exams.startDate} desc`, sql`${exams.createdAt} desc`);
    const [stats, years] = await Promise.all([this.stats(tenantId, rows), this.yearNames(tenantId)]);
    return rows.map((e) => this.present(e, years.get(e.academicYearId), stats.get(e.id)!));
  }

  /** One exam with a progress line per class. */
  async get(tenantId: string, id: string) {
    const exam = await this.loadExam(tenantId, id);
    const [stats, years, papers, classRows] = await Promise.all([
      this.stats(tenantId, [exam]),
      this.yearNames(tenantId),
      this.db
        .select()
        .from(examPapers)
        .where(and(eq(examPapers.tenantId, tenantId), eq(examPapers.examId, id))),
      this.db
        .select({
          id: academicClasses.id,
          name: academicClasses.name,
          displayName: academicClasses.displayName,
          sequence: academicClasses.sequence,
        })
        .from(academicClasses)
        .where(eq(academicClasses.tenantId, tenantId)),
    ]);
    const classMap = new Map(classRows.map((c) => [c.id, c]));
    const classIds = [...new Set(papers.map((p) => p.classId))];
    const rosters = new Map<string, number>();
    for (const cid of classIds)
      rosters.set(cid, (await this.roster(tenantId, exam.academicYearId, cid)).length);
    const entered = papers.length
      ? await this.db
          .select({ paperId: examMarks.paperId, n: sql<number>`count(*)` })
          .from(examMarks)
          .where(
            and(
              eq(examMarks.tenantId, tenantId),
              inArray(
                examMarks.paperId,
                papers.map((p) => p.id),
              ),
              or(isNotNull(examMarks.marks), eq(examMarks.absent, true)),
            ),
          )
          .groupBy(examMarks.paperId)
      : [];
    const enteredBy = new Map(entered.map((r) => [r.paperId, Number(r.n)]));
    const byClass = classIds
      .map((cid) => {
        const c = classMap.get(cid);
        const ps = papers.filter((p) => p.classId === cid);
        const expected = ps.length * (rosters.get(cid) ?? 0);
        const done = ps.reduce((a, p) => a + (enteredBy.get(p.id) ?? 0), 0);
        return {
          class_id: cid,
          class_name: c?.displayName || c?.name || '—',
          sequence: c?.sequence ?? 0,
          students: rosters.get(cid) ?? 0,
          papers: ps.length,
          papers_scheduled: ps.filter((p) => p.examDate).length,
          marks_expected: expected,
          marks_entered: done,
          progress_percent: expected ? Math.min(100, Math.round((done / expected) * 100)) : 0,
        };
      })
      .sort((a, b) => a.sequence - b.sequence);
    return {
      ...this.present(exam, years.get(exam.academicYearId), stats.get(id)!),
      class_progress: byClass,
    };
  }

  async create(tenantId: string, input: z.infer<typeof CreateExamBody>, actor: Actor) {
    const year = input.academic_year_id
      ? { id: input.academic_year_id }
      : await this.currentYear(tenantId);
    const id = await this.db.transaction(async (tx) => {
      const [y] = await tx
        .select({ id: academicYears.id })
        .from(academicYears)
        .where(and(eq(academicYears.tenantId, tenantId), eq(academicYears.id, year.id)));
      if (!y) throw new NotFoundError('Academic year');
      const [dup] = await tx
        .select({ id: exams.id })
        .from(exams)
        .where(
          and(eq(exams.tenantId, tenantId), eq(exams.academicYearId, y.id), eq(exams.name, input.name)),
        );
      if (dup)
        throw new ConflictError('DUPLICATE_RESOURCE', 'An exam with this name already exists this year');
      const newId = uuidv7();
      await tx.insert(exams).values({
        id: newId,
        tenantId,
        academicYearId: y.id,
        name: input.name,
        examType: input.exam_type,
        startDate: input.start_date ?? null,
        endDate: input.end_date ?? null,
        createdBy: actor.userId,
      });
      const exam = await this.loadExam(tenantId, newId, tx);
      const made = await this.addPapersForClasses(
        tx,
        tenantId,
        exam,
        input.class_ids,
        input.default_max_marks,
        input.default_pass_marks,
      );
      await recordChange(tx, actor, tenantId, {
        action: 'EXAM_CREATED',
        entityType: 'exam',
        entityId: newId,
        event: 'exam.created',
        after: { name: input.name, papers: made },
      });
      return newId;
    });
    return this.get(tenantId, id);
  }

  private async currentYear(tenantId: string) {
    const [y] = await this.db
      .select({ id: academicYears.id })
      .from(academicYears)
      .where(and(eq(academicYears.tenantId, tenantId), eq(academicYears.isCurrent, true)));
    if (!y)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'There is no active academic year. Activate one first',
        { reason: 'NO_ACTIVE_YEAR' },
      );
    return y;
  }

  async update(tenantId: string, id: string, input: z.infer<typeof UpdateExamBody>, actor: Actor) {
    await this.db.transaction(async (tx) => {
      const exam = await this.loadExam(tenantId, id, tx);
      if (exam.version !== input.version)
        throw new ConflictError('CONFLICT', undefined, { current_version: exam.version });
      const start = input.start_date === undefined ? exam.startDate : input.start_date;
      const end = input.end_date === undefined ? exam.endDate : input.end_date;
      if (start && end && start > end)
        throw new ValidationError('The exam must end on or after its start date');
      await tx
        .update(exams)
        .set({
          ...(input.name ? { name: input.name } : {}),
          ...(input.exam_type ? { examType: input.exam_type } : {}),
          startDate: start,
          endDate: end,
          version: exam.version + 1,
        })
        .where(and(eq(exams.tenantId, tenantId), eq(exams.id, id)));
      await recordChange(tx, actor, tenantId, {
        action: 'EXAM_UPDATED',
        entityType: 'exam',
        entityId: id,
        before: { name: exam.name, start, end },
        after: { name: input.name ?? exam.name },
      });
    });
    return this.get(tenantId, id);
  }

  async remove(tenantId: string, id: string, actor: Actor) {
    await this.db.transaction(async (tx) => {
      const exam = await this.loadExam(tenantId, id, tx);
      this.assertOpen(exam);
      const papers = await tx
        .select({ id: examPapers.id })
        .from(examPapers)
        .where(and(eq(examPapers.tenantId, tenantId), eq(examPapers.examId, id)));
      if (papers.length) {
        const ids = papers.map((p) => p.id);
        await tx
          .delete(examMarks)
          .where(and(eq(examMarks.tenantId, tenantId), inArray(examMarks.paperId, ids)));
        await tx
          .delete(examPapers)
          .where(and(eq(examPapers.tenantId, tenantId), eq(examPapers.examId, id)));
      }
      await tx.delete(exams).where(and(eq(exams.tenantId, tenantId), eq(exams.id, id)));
      await recordChange(tx, actor, tenantId, {
        action: 'EXAM_DELETED',
        entityType: 'exam',
        entityId: id,
        before: { name: exam.name },
      });
    });
  }

  async addClasses(tenantId: string, id: string, input: z.infer<typeof AddClassesBody>, actor: Actor) {
    await this.db.transaction(async (tx) => {
      const exam = await this.loadExam(tenantId, id, tx);
      this.assertOpen(exam);
      const made = await this.addPapersForClasses(
        tx,
        tenantId,
        exam,
        input.class_ids,
        input.default_max_marks,
        input.default_pass_marks,
      );
      await recordChange(tx, actor, tenantId, {
        action: 'EXAM_CLASSES_ADDED',
        entityType: 'exam',
        entityId: id,
        after: { class_ids: input.class_ids, papers: made },
      });
    });
    return this.get(tenantId, id);
  }

  async removeClass(tenantId: string, id: string, classId: string, actor: Actor) {
    await this.db.transaction(async (tx) => {
      const exam = await this.loadExam(tenantId, id, tx);
      this.assertOpen(exam);
      const papers = await tx
        .select({ id: examPapers.id })
        .from(examPapers)
        .where(
          and(
            eq(examPapers.tenantId, tenantId),
            eq(examPapers.examId, id),
            eq(examPapers.classId, classId),
          ),
        );
      if (papers.length) {
        const ids = papers.map((p) => p.id);
        await tx
          .delete(examMarks)
          .where(and(eq(examMarks.tenantId, tenantId), inArray(examMarks.paperId, ids)));
        await tx
          .delete(examPapers)
          .where(and(eq(examPapers.tenantId, tenantId), inArray(examPapers.id, ids)));
      }
      await recordChange(tx, actor, tenantId, {
        action: 'EXAM_CLASS_REMOVED',
        entityType: 'exam',
        entityId: id,
        after: { class_id: classId, papers: papers.length },
      });
    });
  }

  // ---- papers ----------------------------------------------------------------------

  private async paperRows(tenantId: string, exam: Exam, classId?: string) {
    const conds = [eq(examPapers.tenantId, tenantId), eq(examPapers.examId, exam.id)];
    if (classId) conds.push(eq(examPapers.classId, classId));
    const rows = await this.db
      .select({
        paper: examPapers,
        subjectName: subjects.name,
        subjectCode: subjects.code,
        className: academicClasses.name,
        classDisplay: academicClasses.displayName,
        classSequence: academicClasses.sequence,
      })
      .from(examPapers)
      .innerJoin(
        subjects,
        and(eq(subjects.tenantId, examPapers.tenantId), eq(subjects.id, examPapers.subjectId)),
      )
      .innerJoin(
        academicClasses,
        and(
          eq(academicClasses.tenantId, examPapers.tenantId),
          eq(academicClasses.id, examPapers.classId),
        ),
      )
      .where(and(...conds))
      .orderBy(asc(academicClasses.sequence), sql`${examPapers.examDate} is null`, asc(examPapers.examDate), asc(subjects.name));
    const ids = rows.map((r) => r.paper.id);
    const entered = ids.length
      ? await this.db
          .select({ paperId: examMarks.paperId, n: sql<number>`count(*)` })
          .from(examMarks)
          .where(
            and(
              eq(examMarks.tenantId, tenantId),
              inArray(examMarks.paperId, ids),
              or(isNotNull(examMarks.marks), eq(examMarks.absent, true)),
            ),
          )
          .groupBy(examMarks.paperId)
      : [];
    const enteredBy = new Map(entered.map((r) => [r.paperId, Number(r.n)]));
    const rosterSizes = new Map<string, number>();
    for (const cid of new Set(rows.map((r) => r.paper.classId)))
      rosterSizes.set(cid, (await this.roster(tenantId, exam.academicYearId, cid)).length);
    return rows.map((r) => ({
      id: r.paper.id,
      exam_id: exam.id,
      class_id: r.paper.classId,
      class_name: r.classDisplay || r.className,
      subject_id: r.paper.subjectId,
      subject_name: r.subjectName,
      subject_code: r.subjectCode,
      exam_date: r.paper.examDate,
      max_marks: num(r.paper.maxMarks)!,
      pass_marks: num(r.paper.passMarks)!,
      students: rosterSizes.get(r.paper.classId) ?? 0,
      marks_entered: enteredBy.get(r.paper.id) ?? 0,
    }));
  }

  async listPapers(tenantId: string, id: string, classId?: string) {
    const exam = await this.loadExam(tenantId, id);
    return this.paperRows(tenantId, exam, classId);
  }

  async createPaper(tenantId: string, id: string, input: z.infer<typeof CreatePaperBody>, actor: Actor) {
    if (input.pass_marks > input.max_marks)
      throw new ValidationError('Pass marks cannot be more than the maximum');
    const paperId = await this.db.transaction(async (tx) => {
      const exam = await this.loadExam(tenantId, id, tx);
      this.assertOpen(exam);
      const [dup] = await tx
        .select({ id: examPapers.id })
        .from(examPapers)
        .where(
          and(
            eq(examPapers.tenantId, tenantId),
            eq(examPapers.examId, id),
            eq(examPapers.classId, input.class_id),
            eq(examPapers.subjectId, input.subject_id),
          ),
        );
      if (dup) throw new ConflictError('DUPLICATE_RESOURCE', 'This subject already has a paper in this class');
      const newId = uuidv7();
      await tx.insert(examPapers).values({
        id: newId,
        tenantId,
        examId: id,
        classId: input.class_id,
        subjectId: input.subject_id,
        examDate: input.exam_date ?? null,
        maxMarks: String(input.max_marks),
        passMarks: String(input.pass_marks),
      });
      await recordChange(tx, actor, tenantId, {
        action: 'EXAM_PAPER_CREATED',
        entityType: 'exam_paper',
        entityId: newId,
        after: { exam_id: id, class_id: input.class_id, subject_id: input.subject_id },
      });
      return newId;
    });
    const exam = await this.loadExam(tenantId, id);
    return (await this.paperRows(tenantId, exam)).find((p) => p.id === paperId)!;
  }

  async updatePaper(tenantId: string, paperId: string, input: z.infer<typeof UpdatePaperBody>, actor: Actor) {
    const { paper, exam } = await this.loadPaper(tenantId, paperId);
    this.assertOpen(exam);
    const max = input.max_marks ?? num(paper.maxMarks)!;
    const pass = input.pass_marks ?? num(paper.passMarks)!;
    if (pass > max) throw new ValidationError('Pass marks cannot be more than the maximum');
    if (input.max_marks !== undefined) {
      const [over] = await this.db
        .select({ n: sql<number>`count(*)` })
        .from(examMarks)
        .where(
          and(
            eq(examMarks.tenantId, tenantId),
            eq(examMarks.paperId, paperId),
            sql`${examMarks.marks} > ${max}`,
          ),
        );
      if (Number(over?.n) > 0)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'Some students already have more marks than this maximum',
          { reason: 'MARKS_ABOVE_MAXIMUM' },
        );
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(examPapers)
        .set({
          ...(input.exam_date !== undefined ? { examDate: input.exam_date } : {}),
          maxMarks: String(max),
          passMarks: String(pass),
        })
        .where(and(eq(examPapers.tenantId, tenantId), eq(examPapers.id, paperId)));
      await recordChange(tx, actor, tenantId, {
        action: 'EXAM_PAPER_UPDATED',
        entityType: 'exam_paper',
        entityId: paperId,
        after: { exam_date: input.exam_date, max_marks: max, pass_marks: pass },
      });
    });
    return (await this.paperRows(tenantId, exam)).find((p) => p.id === paperId)!;
  }

  async deletePaper(tenantId: string, paperId: string, actor: Actor) {
    const { exam } = await this.loadPaper(tenantId, paperId);
    this.assertOpen(exam);
    await this.db.transaction(async (tx) => {
      await tx
        .delete(examMarks)
        .where(and(eq(examMarks.tenantId, tenantId), eq(examMarks.paperId, paperId)));
      await tx
        .delete(examPapers)
        .where(and(eq(examPapers.tenantId, tenantId), eq(examPapers.id, paperId)));
      await recordChange(tx, actor, tenantId, {
        action: 'EXAM_PAPER_DELETED',
        entityType: 'exam_paper',
        entityId: paperId,
      });
    });
  }

  // ---- marks -----------------------------------------------------------------------

  async getMarks(tenantId: string, paperId: string) {
    const { paper, exam } = await this.loadPaper(tenantId, paperId);
    const [roster, marks, subject, klass] = await Promise.all([
      this.roster(tenantId, exam.academicYearId, paper.classId),
      this.db
        .select()
        .from(examMarks)
        .where(and(eq(examMarks.tenantId, tenantId), eq(examMarks.paperId, paperId))),
      this.db
        .select({ name: subjects.name })
        .from(subjects)
        .where(and(eq(subjects.tenantId, tenantId), eq(subjects.id, paper.subjectId))),
      this.db
        .select({ name: academicClasses.name, displayName: academicClasses.displayName })
        .from(academicClasses)
        .where(and(eq(academicClasses.tenantId, tenantId), eq(academicClasses.id, paper.classId))),
    ]);
    const byStudent = new Map(marks.map((m) => [m.studentId, m]));
    return {
      paper: {
        id: paper.id,
        exam_id: exam.id,
        exam_name: exam.name,
        class_id: paper.classId,
        class_name: klass[0]?.displayName || klass[0]?.name || '—',
        subject_name: subject[0]?.name ?? '—',
        exam_date: paper.examDate,
        max_marks: num(paper.maxMarks)!,
        pass_marks: num(paper.passMarks)!,
      },
      locked: exam.status === 'PUBLISHED',
      rows: roster.map((s) => {
        const m = byStudent.get(s.studentId);
        return {
          student_id: s.studentId,
          name: fullName(s),
          admission_number: s.admissionNumber ?? s.studentNumber,
          section_name: s.sectionName,
          marks: num(m?.marks),
          absent: m?.absent ?? false,
          remark: m?.remark ?? null,
        };
      }),
    };
  }

  async saveMarks(tenantId: string, paperId: string, input: z.infer<typeof SaveMarksBody>, actor: Actor) {
    const { paper, exam } = await this.loadPaper(tenantId, paperId);
    this.assertOpen(exam);
    const max = num(paper.maxMarks)!;
    const roster = new Set(
      (await this.roster(tenantId, exam.academicYearId, paper.classId)).map((r) => r.studentId),
    );
    const issues: { path: string; message: string }[] = [];
    input.records.forEach((r, i) => {
      if (!roster.has(r.student_id))
        issues.push({ path: `records.${i}.student_id`, message: 'This student is not in the class' });
      if (!r.absent && r.marks != null && r.marks > max)
        issues.push({ path: `records.${i}.marks`, message: `Marks cannot be more than ${max}` });
    });
    if (issues.length)
      throw new ValidationError('Some marks are not valid', { location: 'body', issues });
    let saved = 0;
    await this.db.transaction(async (tx) => {
      for (const r of input.records) {
        const marks = r.absent ? null : (r.marks ?? null);
        const remark = r.remark?.trim() || null;
        if (marks === null && !r.absent && !remark) {
          await tx
            .delete(examMarks)
            .where(
              and(
                eq(examMarks.tenantId, tenantId),
                eq(examMarks.paperId, paperId),
                eq(examMarks.studentId, r.student_id),
              ),
            );
          continue;
        }
        await tx
          .insert(examMarks)
          .values({
            tenantId,
            paperId,
            studentId: r.student_id,
            marks: marks === null ? null : String(marks),
            absent: r.absent,
            remark,
            enteredBy: actor.userId,
          })
          .onDuplicateKeyUpdate({
            set: {
              marks: marks === null ? null : String(marks),
              absent: r.absent,
              remark,
              enteredBy: actor.userId,
            },
          });
        saved++;
      }
      await recordChange(tx, actor, tenantId, {
        action: 'EXAM_MARKS_SAVED',
        entityType: 'exam_paper',
        entityId: paperId,
        event: 'exam.marks_saved',
        after: { students: input.records.length, saved },
      });
    });
    return this.getMarks(tenantId, paperId);
  }

  // ---- results ---------------------------------------------------------------------

  /** Calculated from the marks every time; nothing here is stored. */
  async results(tenantId: string, id: string, classId: string) {
    const exam = await this.loadExam(tenantId, id);
    return this.resultsFor(tenantId, exam, classId);
  }

  private async resultsFor(tenantId: string, exam: Exam, classId: string) {
    const papers = await this.paperRows(tenantId, exam, classId);
    const [roster, marks] = await Promise.all([
      this.roster(tenantId, exam.academicYearId, classId),
      papers.length
        ? this.db
            .select()
            .from(examMarks)
            .where(
              and(
                eq(examMarks.tenantId, tenantId),
                inArray(
                  examMarks.paperId,
                  papers.map((p) => p.id),
                ),
              ),
            )
        : Promise.resolve([] as (typeof examMarks.$inferSelect)[]),
    ]);
    const cell = new Map(marks.map((m) => [`${m.paperId}:${m.studentId}`, m]));
    const rows = roster.map((s) => {
      let total = 0;
      let maxTotal = 0;
      let missing = 0;
      let failed = 0;
      const subjectMarks = papers.map((p) => {
        const m = cell.get(`${p.id}:${s.studentId}`);
        const absent = m?.absent ?? false;
        const value = absent ? null : num(m?.marks);
        maxTotal += p.max_marks;
        if (value !== null) total += value;
        const entered = absent || value !== null;
        if (!entered) missing++;
        const passed = value !== null && value >= p.pass_marks;
        if (absent || (value !== null && !passed)) failed++;
        return {
          paper_id: p.id,
          subject_name: p.subject_name,
          max_marks: p.max_marks,
          pass_marks: p.pass_marks,
          marks: value,
          absent,
          entered,
          passed: entered ? passed : null,
          grade: value !== null ? gradeOf((value / p.max_marks) * 100) : null,
        };
      });
      const percentage = maxTotal ? round((total / maxTotal) * 100, 2) : 0;
      const result = missing > 0 ? 'INCOMPLETE' : failed > 0 ? 'FAIL' : 'PASS';
      return {
        student_id: s.studentId,
        name: fullName(s),
        admission_number: s.admissionNumber ?? s.studentNumber,
        section_name: s.sectionName,
        subjects: subjectMarks,
        total: round(total, 2),
        max_total: maxTotal,
        percentage,
        grade: missing > 0 ? null : gradeOf(percentage),
        result,
        rank: null as number | null,
        failed_subjects: failed,
        missing_subjects: missing,
      };
    });
    // Rank everyone whose marks are complete, by total (ties share a rank).
    const ranked = rows.filter((r) => r.result !== 'INCOMPLETE').sort((a, b) => b.total - a.total);
    let last = -1;
    let lastRank = 0;
    ranked.forEach((r, i) => {
      if (r.total !== last) {
        lastRank = i + 1;
        last = r.total;
      }
      r.rank = lastRank;
    });
    rows.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999) || a.name.localeCompare(b.name));

    const complete = rows.filter((r) => r.result !== 'INCOMPLETE');
    const passed = rows.filter((r) => r.result === 'PASS').length;
    const subjectStats = papers.map((p, i) => {
      const vals = rows
        .map((r) => r.subjects[i]!)
        .filter((c) => c.marks !== null)
        .map((c) => c.marks as number);
      const appeared = vals.length;
      return {
        paper_id: p.id,
        subject_name: p.subject_name,
        max_marks: p.max_marks,
        appeared,
        average: appeared ? round(vals.reduce((a, b) => a + b, 0) / appeared) : null,
        highest: appeared ? Math.max(...vals) : null,
        lowest: appeared ? Math.min(...vals) : null,
        pass_percent: appeared
          ? Math.round((vals.filter((v) => v >= p.pass_marks).length / appeared) * 100)
          : null,
      };
    });
    const grades: Record<string, number> = {};
    for (const g of GRADE_SCALE) grades[g.grade] = 0;
    for (const r of complete) if (r.grade) grades[r.grade] = (grades[r.grade] ?? 0) + 1;
    return {
      exam: { id: exam.id, name: exam.name, status: exam.status },
      class_id: classId,
      papers: papers.map((p) => ({
        id: p.id,
        subject_name: p.subject_name,
        max_marks: p.max_marks,
        pass_marks: p.pass_marks,
      })),
      summary: {
        students: rows.length,
        complete: complete.length,
        incomplete: rows.length - complete.length,
        passed,
        failed: complete.length - passed,
        pass_percent: complete.length ? Math.round((passed / complete.length) * 100) : null,
        average_percent: complete.length
          ? round(complete.reduce((a, r) => a + r.percentage, 0) / complete.length)
          : null,
        topper: ranked[0] ? { name: ranked[0].name, percentage: ranked[0].percentage } : null,
      },
      grade_counts: grades,
      subjects: subjectStats,
      rows,
    };
  }

  // ---- publish ---------------------------------------------------------------------

  /** What is still missing before the results can go out. */
  async readiness(tenantId: string, id: string) {
    const exam = await this.loadExam(tenantId, id);
    const papers = await this.paperRows(tenantId, exam);
    const missing = papers
      .filter((p) => p.marks_entered < p.students)
      .map((p) => ({
        paper_id: p.id,
        class_name: p.class_name,
        subject_name: p.subject_name,
        missing: p.students - p.marks_entered,
      }));
    return {
      papers: papers.length,
      ready: papers.length > 0 && missing.length === 0,
      empty_classes: papers.filter((p) => p.students === 0).length,
      missing_papers: missing,
    };
  }

  async publish(tenantId: string, id: string, input: z.infer<typeof PublishBody>, actor: Actor) {
    const ready = await this.readiness(tenantId, id);
    if (ready.papers === 0)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'Add at least one paper before publishing', {
        reason: 'NO_PAPERS',
      });
    if (!ready.ready && !input.allow_incomplete)
      throw new ConflictError(
        'CONFIRMATION_REQUIRED',
        'Some marks are still missing. Publish anyway, or finish entering them first',
        { reason: 'MARKS_MISSING', ...ready },
      );
    await this.db.transaction(async (tx) => {
      const exam = await this.loadExam(tenantId, id, tx);
      this.assertOpen(exam);
      await tx
        .update(exams)
        .set({ status: 'PUBLISHED', publishedAt: this.deps.clock.now(), version: exam.version + 1 })
        .where(and(eq(exams.tenantId, tenantId), eq(exams.id, id)));
      await recordChange(tx, actor, tenantId, {
        action: 'EXAM_PUBLISHED',
        entityType: 'exam',
        entityId: id,
        event: 'exam.published',
        after: { incomplete: !ready.ready },
      });
    });
    return this.get(tenantId, id);
  }

  async unpublish(tenantId: string, id: string, actor: Actor) {
    await this.db.transaction(async (tx) => {
      const exam = await this.loadExam(tenantId, id, tx);
      if (exam.status !== 'PUBLISHED')
        throw new BusinessRuleError('INVALID_STATE', 'This exam is not published');
      await tx
        .update(exams)
        .set({ status: 'DRAFT', publishedAt: null, version: exam.version + 1 })
        .where(and(eq(exams.tenantId, tenantId), eq(exams.id, id)));
      await recordChange(tx, actor, tenantId, {
        action: 'EXAM_UNPUBLISHED',
        entityType: 'exam',
        entityId: id,
        event: 'exam.unpublished',
      });
    });
    return this.get(tenantId, id);
  }

  // ---- a student's published results -------------------------------------------------

  async forStudent(tenantId: string, studentId: string) {
    const [student] = await this.db
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.tenantId, tenantId), eq(students.id, studentId)));
    if (!student) throw new NotFoundError('Student');
    const rows = await this.db
      .select({ paper: examPapers, exam: exams })
      .from(examMarks)
      .innerJoin(
        examPapers,
        and(eq(examPapers.tenantId, examMarks.tenantId), eq(examPapers.id, examMarks.paperId)),
      )
      .innerJoin(
        exams,
        and(eq(exams.tenantId, examPapers.tenantId), eq(exams.id, examPapers.examId)),
      )
      .where(
        and(
          eq(examMarks.tenantId, tenantId),
          eq(examMarks.studentId, studentId),
          eq(exams.status, 'PUBLISHED'),
        ),
      );
    const seen = new Map<string, { exam: Exam; classId: string }>();
    for (const r of rows) seen.set(`${r.exam.id}:${r.paper.classId}`, { exam: r.exam, classId: r.paper.classId });
    const out = [];
    for (const { exam, classId } of seen.values()) {
      const res = await this.resultsFor(tenantId, exam, classId);
      const me = res.rows.find((r) => r.student_id === studentId);
      if (!me) continue;
      out.push({
        exam_id: exam.id,
        exam_name: exam.name,
        exam_type: exam.examType,
        start_date: exam.startDate,
        total: me.total,
        max_total: me.max_total,
        percentage: me.percentage,
        grade: me.grade,
        result: me.result,
        rank: me.rank,
        class_size: res.summary.students,
        subjects: me.subjects.map((s) => ({
          subject_name: s.subject_name,
          marks: s.marks,
          absent: s.absent,
          max_marks: s.max_marks,
          grade: s.grade,
          passed: s.passed,
        })),
      });
    }
    return out.sort((a, b) => String(b.start_date ?? '').localeCompare(String(a.start_date ?? '')));
  }
}
