import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  enrollments,
  examClasses,
  examMarks,
  examPaperSections,
  examPaperStaff,
  examPapers,
  exams,
  subjectOfferings,
  subjects,
  teachingAssignments,
} from '../../db/schema/index.js';
import { recordChange } from '../../platform/record.js';
import {
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import type { Caller } from '../attendance/support.js';
import type { ExamService } from '../exams/exams.service.js';
import type { ExamTimetableService } from '../exams/timetable.service.js';
import type { CreateTestBody, TeacherMarksBody } from './teacher-exams.schemas.js';
import type { TeacherAppService } from './teacher-app.service.js';

type Exam = typeof exams.$inferSelect;
type Paper = typeof examPapers.$inferSelect;

/** One subject the teacher teaches: in one section, or (sectionId null) every section of the class. */
interface Grant {
  yearId: string;
  classId: string;
  subjectId: string;
  sectionId: string | null;
}

const num = (v: string | null | undefined) => (v == null ? null : Number(v));

/**
 * Exams and marks in the teacher app. The rule (product owner, 26 Oct 2026): a teacher
 * enters marks only for the class sections and subjects they teach (active teaching
 * assignment), or where the office named them the paper's marker. They keep the marks
 * as a draft, then hand each section in to the office when every student has a mark.
 * They can also set their own test for one section, and delete it until it is handed in.
 * Publishing results stays with the office.
 */
export class TeacherExamService {
  constructor(
    private readonly deps: Deps,
    private readonly app: TeacherAppService,
    private readonly exams: ExamService,
    private readonly timetable: ExamTimetableService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  // ---- scope -------------------------------------------------------------------------

  private async grants(tenantId: string, teacherId: string): Promise<Grant[]> {
    const rows = await this.db
      .select({
        yearId: subjectOfferings.academicYearId,
        classId: subjectOfferings.classId,
        subjectId: subjectOfferings.subjectId,
        sectionId: subjectOfferings.sectionId,
      })
      .from(teachingAssignments)
      .innerJoin(
        subjectOfferings,
        and(
          eq(subjectOfferings.tenantId, teachingAssignments.tenantId),
          eq(subjectOfferings.id, teachingAssignments.subjectOfferingId),
        ),
      )
      .innerJoin(
        academicYears,
        and(
          eq(academicYears.tenantId, subjectOfferings.tenantId),
          eq(academicYears.id, subjectOfferings.academicYearId),
        ),
      )
      .where(
        and(
          eq(teachingAssignments.tenantId, tenantId),
          eq(teachingAssignments.teacherId, teacherId),
          eq(teachingAssignments.status, 'ACTIVE'),
          inArray(academicYears.status, ['ACTIVE', 'UPCOMING']),
        ),
      );
    return rows;
  }

  private async markerRows(tenantId: string, teacherId: string) {
    return this.db
      .select({ paperId: examPaperStaff.paperId, sectionId: examPaperStaff.sectionId })
      .from(examPaperStaff)
      .where(
        and(
          eq(examPaperStaff.tenantId, tenantId),
          eq(examPaperStaff.teacherId, teacherId),
          eq(examPaperStaff.role, 'MARKER'),
        ),
      );
  }

  private async classSections(tenantId: string, yearId: string, classId: string) {
    return this.db
      .select({ id: academicSections.id, name: academicSections.name })
      .from(academicSections)
      .where(
        and(
          eq(academicSections.tenantId, tenantId),
          eq(academicSections.academicYearId, yearId),
          eq(academicSections.classId, classId),
        ),
      );
  }

  /**
   * The sections of this paper whose marks the teacher may enter: sections where they
   * teach the paper's subject, sections they mark for the office, and their own test's
   * section. A teacher's own test is sat by one section only.
   */
  private async allowedSections(
    tenantId: string,
    teacherId: string,
    exam: Exam,
    paper: Paper,
    grants: Grant[],
    markers: { paperId: string; sectionId: string | null }[],
  ): Promise<Set<string>> {
    const out = new Set<string>();
    let wholeClass = false;
    if (exam.teacherId === teacherId && exam.sectionId) out.add(exam.sectionId);
    for (const g of grants) {
      if (g.yearId !== exam.academicYearId || g.classId !== paper.classId) continue;
      if (g.subjectId !== paper.subjectId) continue;
      if (g.sectionId) out.add(g.sectionId);
      else wholeClass = true;
    }
    for (const m of markers) {
      if (m.paperId !== paper.id) continue;
      if (m.sectionId) out.add(m.sectionId);
      else wholeClass = true;
    }
    if (wholeClass)
      for (const s of await this.classSections(tenantId, exam.academicYearId, paper.classId))
        out.add(s.id);
    if (exam.sectionId) return out.has(exam.sectionId) ? new Set([exam.sectionId]) : new Set();
    return out;
  }

  private async loadPaper(tenantId: string, paperId: string) {
    const [row] = await this.db
      .select({ paper: examPapers, exam: exams })
      .from(examPapers)
      .innerJoin(
        exams,
        and(eq(exams.tenantId, examPapers.tenantId), eq(exams.id, examPapers.examId)),
      )
      .where(and(eq(examPapers.tenantId, tenantId), eq(examPapers.id, paperId)));
    if (!row) throw new NotFoundError('Paper');
    return row;
  }

  /** Paper + exam + my sections, or 403 when none of its sections is mine. */
  private async myPaper(c: Caller, paperId: string) {
    const me = await this.app.myTeacher(c.tenantId, c.principal);
    const { paper, exam } = await this.loadPaper(c.tenantId, paperId);
    const [grants, markers] = await Promise.all([
      this.grants(c.tenantId, me.id),
      this.markerRows(c.tenantId, me.id),
    ]);
    const sections = await this.allowedSections(c.tenantId, me.id, exam, paper, grants, markers);
    if (!sections.size)
      throw new AuthorizationError(
        'PERMISSION_DENIED',
        'You can enter marks only for the classes and subjects you teach',
      );
    return { me, paper, exam, sections };
  }

  // ---- reads -------------------------------------------------------------------------

  /**
   * My exams: every exam with a paper I can mark (subjects I teach, papers I mark for
   * the office, my own tests), with my sections' progress and hand-in state.
   */
  async list(c: Caller) {
    const me = await this.app.myTeacher(c.tenantId, c.principal);
    const [grants, markers] = await Promise.all([
      this.grants(c.tenantId, me.id),
      this.markerRows(c.tenantId, me.id),
    ]);
    const classIds = [...new Set(grants.map((g) => g.classId))];
    const markerPaperIds = [...new Set(markers.map((m) => m.paperId))];
    if (!classIds.length && !markerPaperIds.length) return [];
    const conds = [];
    if (classIds.length) conds.push(inArray(examPapers.classId, classIds));
    if (markerPaperIds.length) conds.push(inArray(examPapers.id, markerPaperIds));
    const rows = await this.db
      .select({
        paper: examPapers,
        exam: exams,
        subjectName: subjects.name,
        className: academicClasses.name,
        classDisplay: academicClasses.displayName,
      })
      .from(examPapers)
      .innerJoin(
        exams,
        and(eq(exams.tenantId, examPapers.tenantId), eq(exams.id, examPapers.examId)),
      )
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
      .where(and(eq(examPapers.tenantId, c.tenantId), or(...conds)));

    // Sections I may mark, per paper.
    const mine: { row: (typeof rows)[number]; sections: Set<string> }[] = [];
    for (const row of rows) {
      const sections = await this.allowedSections(
        c.tenantId,
        me.id,
        row.exam,
        row.paper,
        grants,
        markers,
      );
      if (sections.size) mine.push({ row, sections });
    }
    if (!mine.length) return [];

    const allSections = [...new Set(mine.flatMap((m) => [...m.sections]))];
    const paperIds = mine.map((m) => m.row.paper.id);
    const [sectionRows, roster, marked, status] = await Promise.all([
      this.db
        .select({ id: academicSections.id, name: academicSections.name })
        .from(academicSections)
        .where(
          and(eq(academicSections.tenantId, c.tenantId), inArray(academicSections.id, allSections)),
        ),
      this.db
        .select({ studentId: enrollments.studentId, sectionId: enrollments.sectionId })
        .from(enrollments)
        .where(
          and(
            eq(enrollments.tenantId, c.tenantId),
            eq(enrollments.status, 'ACTIVE'),
            inArray(enrollments.sectionId, allSections),
          ),
        ),
      this.db
        .select({ paperId: examMarks.paperId, studentId: examMarks.studentId })
        .from(examMarks)
        .where(
          and(
            eq(examMarks.tenantId, c.tenantId),
            inArray(examMarks.paperId, paperIds),
            or(isNotNull(examMarks.marks), eq(examMarks.absent, true)),
          ),
        ),
      this.db
        .select()
        .from(examPaperSections)
        .where(
          and(
            eq(examPaperSections.tenantId, c.tenantId),
            inArray(examPaperSections.paperId, paperIds),
          ),
        ),
    ]);
    const sectionName = new Map(sectionRows.map((s) => [s.id, s.name]));
    const studentsIn = new Map<string, string[]>();
    for (const r of roster) {
      const k = String(r.sectionId);
      studentsIn.set(k, [...(studentsIn.get(k) ?? []), r.studentId]);
    }
    const markedSet = new Set(marked.map((m) => `${m.paperId}:${m.studentId}`));
    const statusOf = new Map(status.map((s) => [`${s.paperId}:${s.sectionId}`, s]));

    const byExam = new Map<string, { exam: Exam; papers: unknown[]; dates: string[] }>();
    for (const { row, sections } of mine) {
      const p = row.paper;
      const entry = byExam.get(row.exam.id) ?? { exam: row.exam, papers: [], dates: [] };
      if (p.examDate) entry.dates.push(p.examDate);
      entry.papers.push({
        paper_id: p.id,
        class_id: p.classId,
        class_name: row.classDisplay || row.className,
        subject_id: p.subjectId,
        subject_name: row.subjectName,
        exam_date: p.examDate,
        start_time: p.startTime ? p.startTime.slice(0, 5) : null,
        end_time: p.endTime ? p.endTime.slice(0, 5) : null,
        max_marks: num(p.maxMarks),
        pass_marks: num(p.passMarks),
        sections: [...sections].map((sid) => {
          const ids = studentsIn.get(sid) ?? [];
          const st = statusOf.get(`${p.id}:${sid}`);
          return {
            section_id: sid,
            section_name: sectionName.get(sid) ?? null,
            students: ids.length,
            entered: ids.filter((id) => markedSet.has(`${p.id}:${id}`)).length,
            status: st?.status ?? 'DRAFT',
            return_note: st?.status === 'DRAFT' ? (st?.returnNote ?? null) : null,
          };
        }),
      });
      byExam.set(row.exam.id, entry);
    }
    return [...byExam.values()]
      .map(({ exam, papers, dates }) => ({
        id: exam.id,
        name: exam.name,
        exam_type: exam.examType,
        status: exam.status,
        start_date: exam.startDate ?? dates.sort()[0] ?? null,
        end_date: exam.endDate ?? dates.sort().at(-1) ?? null,
        by_me: exam.teacherId === me.id,
        papers,
      }))
      .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''));
  }

  /** My exam duties (invigilation and marking) as the office set them. */
  async duties(c: Caller, q: { from?: string; to?: string }) {
    await this.app.myTeacher(c.tenantId, c.principal);
    return this.timetable.myDuties(c.tenantId, c.principal, q);
  }

  /** An exam's timetable, for an exam I mark or have a duty in. */
  async examTimetable(c: Caller, examId: string) {
    const me = await this.app.myTeacher(c.tenantId, c.principal);
    const mineExams = await this.list(c);
    if (!mineExams.some((e) => e.id === examId)) {
      const duty = await this.db
        .select({ id: examPaperStaff.id })
        .from(examPaperStaff)
        .innerJoin(
          examPapers,
          and(
            eq(examPapers.tenantId, examPaperStaff.tenantId),
            eq(examPapers.id, examPaperStaff.paperId),
          ),
        )
        .where(
          and(
            eq(examPaperStaff.tenantId, c.tenantId),
            eq(examPaperStaff.teacherId, me.id),
            eq(examPapers.examId, examId),
          ),
        )
        .limit(1);
      if (!duty.length) throw new NotFoundError('Exam');
    }
    return this.timetable.timetable(c.tenantId, examId);
  }

  /** The class list of a paper narrowed to my sections, with each section's hand-in state. */
  async marks(c: Caller, paperId: string) {
    const { exam, sections } = await this.myPaper(c, paperId);
    return this.shape(c.tenantId, paperId, exam, sections);
  }

  private async shape(tenantId: string, paperId: string, exam: Exam, sections: Set<string>) {
    const full = await this.exams.getMarks(tenantId, paperId);
    const rows = full.rows.filter((r) => r.section_id && sections.has(r.section_id));
    const mySections = full.sections
      .filter((s) => sections.has(s.section_id))
      .map((s) => {
        const inSection = rows.filter((r) => r.section_id === s.section_id);
        const entered = inSection.filter((r) => r.absent || r.marks !== null).length;
        return {
          ...s,
          students: inSection.length,
          entered,
          can_edit: exam.status === 'DRAFT' && s.status !== 'SUBMITTED',
          can_submit:
            exam.status === 'DRAFT' &&
            s.status !== 'SUBMITTED' &&
            inSection.length > 0 &&
            entered === inSection.length,
        };
      });
    return {
      paper: full.paper,
      exam: {
        id: exam.id,
        name: exam.name,
        status: exam.status,
        by_teacher: exam.teacherId !== null,
      },
      locked: full.locked,
      sections: mySections,
      rows,
    };
  }

  // ---- writes ------------------------------------------------------------------------

  /** Save marks for students in my sections. Handed-in sections are locked. */
  async saveMarks(c: Caller, paperId: string, body: z.infer<typeof TeacherMarksBody>) {
    const { exam, sections } = await this.myPaper(c, paperId);
    const current = await this.exams.getMarks(c.tenantId, paperId);
    const sectionOf = new Map(current.rows.map((r) => [r.student_id, r.section_id]));
    const submitted = new Set(
      current.sections.filter((s) => s.status === 'SUBMITTED').map((s) => s.section_id),
    );
    const issues: { path: string; message: string }[] = [];
    body.records.forEach((r, i) => {
      const sec = sectionOf.get(r.student_id);
      if (!sec || !sections.has(sec))
        issues.push({
          path: `records.${i}.student_id`,
          message: 'This student is not in your class',
        });
    });
    if (issues.length)
      throw new ValidationError('Some marks are not valid', { location: 'body', issues });
    if (body.records.some((r) => submitted.has(sectionOf.get(r.student_id)!)))
      throw new BusinessRuleError(
        'INVALID_STATE',
        'These marks were handed in. Ask the office to send them back to change them',
        { reason: 'MARKS_SUBMITTED' },
      );
    await this.exams.saveMarks(c.tenantId, paperId, body, c.actor);
    return this.shape(c.tenantId, paperId, exam, sections);
  }

  /** Hand a section's marks in to the office. Every student needs a mark (or absent). */
  async submit(c: Caller, paperId: string, sectionId: string) {
    const { exam, sections } = await this.myPaper(c, paperId);
    if (!sections.has(sectionId))
      throw new AuthorizationError('PERMISSION_DENIED', 'This section isn’t one of yours');
    if (exam.status !== 'DRAFT')
      throw new BusinessRuleError('INVALID_STATE', 'These results are already published', {
        reason: 'EXAM_PUBLISHED',
      });
    const current = await this.exams.getMarks(c.tenantId, paperId);
    const inSection = current.rows.filter((r) => r.section_id === sectionId);
    const missing = inSection.filter((r) => !r.absent && r.marks === null).length;
    if (!inSection.length || missing)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        missing
          ? `${missing} student${missing === 1 ? ' has' : 's have'} no mark yet`
          : 'There are no students in this section',
        { reason: 'MARKS_INCOMPLETE', missing },
      );
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(examPaperSections)
        .where(
          and(
            eq(examPaperSections.tenantId, c.tenantId),
            eq(examPaperSections.paperId, paperId),
            eq(examPaperSections.sectionId, sectionId),
          ),
        )
        .for('update');
      if (row?.status === 'SUBMITTED')
        throw new BusinessRuleError('INVALID_STATE', 'These marks are already handed in', {
          reason: 'MARKS_SUBMITTED',
        });
      const now = new Date();
      if (row)
        await tx
          .update(examPaperSections)
          .set({
            status: 'SUBMITTED',
            submittedBy: c.actor.userId,
            submittedAt: now,
            version: row.version + 1,
          })
          .where(eq(examPaperSections.id, row.id));
      else
        await tx.insert(examPaperSections).values({
          id: uuidv7(),
          tenantId: c.tenantId,
          paperId,
          sectionId,
          status: 'SUBMITTED',
          submittedBy: c.actor.userId,
          submittedAt: now,
        });
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'EXAM_MARKS_SUBMITTED',
        entityType: 'exam_paper',
        entityId: paperId,
        event: 'exam.marks_submitted',
        after: { section_id: sectionId, students: inSection.length },
      });
    });
    return this.shape(c.tenantId, paperId, exam, sections);
  }

  /** My own test for one section and one subject I teach there. */
  async createTest(c: Caller, body: z.infer<typeof CreateTestBody>) {
    const me = await this.app.myTeacher(c.tenantId, c.principal);
    const [section] = await this.db
      .select({
        id: academicSections.id,
        classId: academicSections.classId,
        yearId: academicSections.academicYearId,
      })
      .from(academicSections)
      .where(
        and(eq(academicSections.tenantId, c.tenantId), eq(academicSections.id, body.section_id)),
      );
    if (!section) throw new NotFoundError('Section');
    const grants = await this.grants(c.tenantId, me.id);
    const teaches = grants.some(
      (g) =>
        g.yearId === section.yearId &&
        g.classId === section.classId &&
        g.subjectId === body.subject_id &&
        (g.sectionId === null || g.sectionId === section.id),
    );
    if (!teaches)
      throw new AuthorizationError(
        'PERMISSION_DENIED',
        'You can set a test only for a class and subject you teach',
      );
    if (body.pass_marks > body.max_marks)
      throw new ValidationError('Pass marks cannot be more than the maximum', {
        location: 'body',
        issues: [{ path: 'pass_marks', message: 'Pass marks cannot be more than the maximum' }],
      });
    const examId = uuidv7();
    const paperId = uuidv7();
    await this.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: exams.id })
        .from(exams)
        .where(
          and(
            eq(exams.tenantId, c.tenantId),
            eq(exams.academicYearId, section.yearId),
            eq(exams.sectionId, section.id),
            eq(exams.name, body.name),
          ),
        );
      if (dup)
        throw new ConflictError(
          'DUPLICATE_RESOURCE',
          'This class already has a test with this name',
        );
      await tx.insert(exams).values({
        id: examId,
        tenantId: c.tenantId,
        academicYearId: section.yearId,
        name: body.name,
        examType: 'UNIT_TEST',
        startDate: body.exam_date ?? null,
        endDate: body.exam_date ?? null,
        sectionId: section.id,
        teacherId: me.id,
        createdBy: c.actor.userId,
      });
      await tx
        .insert(examClasses)
        .values({ id: uuidv7(), tenantId: c.tenantId, examId, classId: section.classId });
      await tx.insert(examPapers).values({
        id: paperId,
        tenantId: c.tenantId,
        examId,
        classId: section.classId,
        subjectId: body.subject_id,
        examDate: body.exam_date ?? null,
        maxMarks: String(body.max_marks),
        passMarks: String(body.pass_marks),
      });
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'EXAM_CREATED',
        entityType: 'exam',
        entityId: examId,
        event: 'exam.created',
        after: { name: body.name, by_teacher: me.id, section_id: section.id, papers: 1 },
      });
    });
    return { exam_id: examId, paper_id: paperId };
  }

  /** Delete my own test while no section has been handed in and results aren't out. */
  async deleteTest(c: Caller, examId: string) {
    const me = await this.app.myTeacher(c.tenantId, c.principal);
    const [exam] = await this.db
      .select()
      .from(exams)
      .where(and(eq(exams.tenantId, c.tenantId), eq(exams.id, examId)));
    if (!exam || exam.teacherId !== me.id) throw new NotFoundError('Test');
    if (exam.status !== 'DRAFT')
      throw new BusinessRuleError('INVALID_STATE', 'These results are published', {
        reason: 'EXAM_PUBLISHED',
      });
    const [handedIn] = await this.db
      .select({ id: examPaperSections.id })
      .from(examPaperSections)
      .innerJoin(
        examPapers,
        and(
          eq(examPapers.tenantId, examPaperSections.tenantId),
          eq(examPapers.id, examPaperSections.paperId),
        ),
      )
      .where(
        and(
          eq(examPaperSections.tenantId, c.tenantId),
          eq(examPapers.examId, examId),
          eq(examPaperSections.status, 'SUBMITTED'),
        ),
      )
      .limit(1);
    if (handedIn)
      throw new BusinessRuleError(
        'INVALID_STATE',
        'This test was handed in. Ask the office to send it back first',
        { reason: 'MARKS_SUBMITTED' },
      );
    await this.exams.remove(c.tenantId, examId, c.actor);
  }
}
