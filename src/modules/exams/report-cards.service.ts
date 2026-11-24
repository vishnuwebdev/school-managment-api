import { and, eq } from 'drizzle-orm';
import type { Deps } from '../../container.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  enrollments,
  exams,
  students,
} from '../../db/schema/index.js';
import { BusinessRuleError, NotFoundError } from '../../shared/errors.js';
import { sectionInScope } from '../attendance/support.js';
import type { FileService } from '../files/files.service.js';
import { renderReportCards, type ReportCardInput } from '../parent-app/documents.pdf.js';
import type { SchoolSetupService } from '../tenants/school-setup.service.js';
import { loadPdfBranding } from '../tenants/pdf-branding.js';
import type { ExamService } from './exams.service.js';
import type { ExamRemarkService } from './remarks.service.js';
import type { Caller } from './scope.js';

/** Office staff print report cards with the same read permission they use for results. */
const PERMISSION = 'exams.read';

type Results = Awaited<ReturnType<ExamService['results']>>;

const fileSafe = (s: string) => s.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-');

/**
 * Printable report cards (A4 PDF). One code path for the parent app (one child) and the school
 * office (one student, or a whole section for a PTM). Same rules as the parent app: only
 * published results, and only remarks the teacher shared with parents.
 */
export class ReportCardService {
  constructor(
    private readonly deps: Deps,
    private readonly s: {
      exams: ExamService;
      remarks: ExamRemarkService;
      schoolSetup: SchoolSetupService;
      files: FileService;
    },
  ) {}

  private get db() {
    return this.deps.db;
  }

  /** One student's report card. */
  async studentPdf(c: Caller, examId: string, studentId: string) {
    const exam = await this.publishedExam(c.tenantId, examId);
    const [e] = await this.db
      .select({
        classId: enrollments.classId,
        className: academicClasses.name,
        sectionId: enrollments.sectionId,
      })
      .from(enrollments)
      .innerJoin(
        students,
        and(eq(students.tenantId, enrollments.tenantId), eq(students.id, enrollments.studentId)),
      )
      .innerJoin(
        academicClasses,
        and(
          eq(academicClasses.tenantId, enrollments.tenantId),
          eq(academicClasses.id, enrollments.classId),
        ),
      )
      .where(
        and(
          eq(enrollments.tenantId, c.tenantId),
          eq(enrollments.studentId, studentId),
          eq(enrollments.academicYearId, exam.yearId),
          eq(enrollments.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    // Another school's student, or one outside the caller's classes, looks missing.
    if (
      !e ||
      !sectionInScope(c.principal, PERMISSION, { id: e.sectionId ?? '', classId: e.classId })
    )
      throw new NotFoundError('Student');
    const res = await this.classResults(c.tenantId, exam, e.classId, e.className);
    const row = res.rows.find((r) => r.student_id === studentId);
    if (!row)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'This student has no results in this exam',
        { reason: 'NO_RESULTS' },
      );
    const cards = await this.cards(c.tenantId, exam, e.className, res, [row]);
    return {
      data: await this.render(c.tenantId, cards),
      filename: `Report-card-${fileSafe(`${row.name}-${exam.name}`)}.pdf`,
    };
  }

  /** Every student of one section in one PDF, one page each, in roll-number order. */
  async sectionPdf(c: Caller, examId: string, sectionId: string) {
    const exam = await this.publishedExam(c.tenantId, examId);
    const [sec] = await this.db
      .select({
        id: academicSections.id,
        name: academicSections.name,
        yearId: academicSections.academicYearId,
        classId: academicSections.classId,
        className: academicClasses.name,
      })
      .from(academicSections)
      .innerJoin(
        academicClasses,
        and(
          eq(academicClasses.tenantId, academicSections.tenantId),
          eq(academicClasses.id, academicSections.classId),
        ),
      )
      .where(and(eq(academicSections.tenantId, c.tenantId), eq(academicSections.id, sectionId)));
    if (!sec || !sectionInScope(c.principal, PERMISSION, sec)) throw new NotFoundError('Section');
    if (sec.yearId !== exam.yearId)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'This section is from a different academic year than the exam',
        { reason: 'OTHER_YEAR' },
      );
    const res = await this.classResults(c.tenantId, exam, sec.classId, sec.className);
    const rows = res.rows
      .filter((r) => r.section_id === sec.id)
      .sort(
        (a, b) =>
          (a.roll_number ?? '').localeCompare(b.roll_number ?? '', undefined, { numeric: true }) ||
          a.name.localeCompare(b.name),
      );
    if (!rows.length)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'There are no students with results in this section for this exam',
        { reason: 'NO_RESULTS' },
      );
    const cards = await this.cards(c.tenantId, exam, sec.className, res, rows);
    return {
      data: await this.render(c.tenantId, cards),
      filename: `Report-cards-${fileSafe(`${sec.className}-${sec.name}-${exam.name}`)}.pdf`,
      count: rows.length,
    };
  }

  /** The exam, which must be published: report cards show final results only. */
  private async publishedExam(tenantId: string, examId: string) {
    const [exam] = await this.db
      .select({
        id: exams.id,
        name: exams.name,
        status: exams.status,
        publishedAt: exams.publishedAt,
        yearId: exams.academicYearId,
        yearName: academicYears.name,
      })
      .from(exams)
      .leftJoin(
        academicYears,
        and(eq(academicYears.tenantId, exams.tenantId), eq(academicYears.id, exams.academicYearId)),
      )
      .where(and(eq(exams.tenantId, tenantId), eq(exams.id, examId)));
    if (!exam) throw new NotFoundError('Exam');
    if (exam.status !== 'PUBLISHED')
      throw new BusinessRuleError(
        'INVALID_STATE',
        'Report cards can be printed only after the results are published. Publish the exam first',
        { reason: 'EXAM_NOT_PUBLISHED' },
      );
    return exam;
  }

  private async classResults(
    tenantId: string,
    exam: { id: string },
    classId: string,
    className: string,
  ) {
    const res = await this.s.exams.results(tenantId, exam.id, classId);
    if (!res.papers.length)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        `${className} is not part of this exam`,
        { reason: 'CLASS_NOT_IN_EXAM' },
      );
    return res;
  }

  private async cards(
    tenantId: string,
    exam: Awaited<ReturnType<ReportCardService['publishedExam']>>,
    className: string,
    res: Results,
    rows: Results['rows'],
  ): Promise<ReportCardInput[]> {
    const remarks = await this.s.remarks.sharedForExam(
      tenantId,
      exam.id,
      rows.map((r) => r.student_id),
    );
    const today = this.deps.clock.now().toISOString().slice(0, 10);
    return rows.map((r) => {
      const remark = remarks.get(r.student_id);
      return {
        exam_name: exam.name,
        academic_year: exam.yearName ?? null,
        published_on: exam.publishedAt?.toISOString().slice(0, 10) ?? null,
        student_name: r.name,
        admission_number: r.admission_number,
        class_label: [className, r.section_name].filter(Boolean).join(' · '),
        roll_number: r.roll_number,
        subjects: r.subjects,
        total: r.total,
        max_total: r.max_total,
        percentage: r.percentage,
        grade: r.grade,
        result: r.result,
        rank: r.rank,
        class_size: res.summary.students,
        class_average: res.summary.average_percent,
        remark: remark ? { text: remark.remark, by: remark.by } : null,
        generated_on: today,
      };
    });
  }

  private async render(tenantId: string, cards: ReportCardInput[]) {
    return renderReportCards(await loadPdfBranding(this.s, tenantId), cards);
  }
}
