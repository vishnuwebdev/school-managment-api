import { and, asc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Deps } from '../../container.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  ADMISSION_TYPE,
  enrollments,
  GENDER,
  OPEN_ENROLLMENT_STATUSES,
  STUDENT_STATUS,
  studentExits,
  studentHouses,
  students,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { csvLine } from '../../shared/csv.js';
import { AuthorizationError } from '../../shared/errors.js';
import { hasTenantWideScope } from '../access/authorization.service.js';
import { fullName, studentScope } from './support.js';

export const STUDENT_REPORTS = [
  'class-strength',
  'gender-strength',
  'admissions',
  'withdrawals',
  'transfers',
  'student-list',
] as const;
export type StudentReport = (typeof STUDENT_REPORTS)[number];

export const StudentReportParams = z.object({ report: z.enum(STUDENT_REPORTS) });
const IsoDate = z.iso.date();
export const StudentReportQuery = z
  .object({
    format: z.enum(['json', 'csv']).default('json'),
    academic_year_id: z.uuid().optional(),
    class_id: z.uuid().optional(),
    section_id: z.uuid().optional(),
    status: z.enum(STUDENT_STATUS).optional(),
    gender: z.enum(GENDER).optional(),
    admission_type: z.enum(ADMISSION_TYPE).optional(),
    date_from: IsoDate.optional(),
    date_to: IsoDate.optional(),
  })
  .refine((q) => !q.date_from || !q.date_to || q.date_from <= q.date_to, {
    message: 'The start date must not be after the end date',
    path: ['date_from'],
  });

export interface StudentReportTable {
  report: StudentReport;
  title: string;
  columns: { key: string; label: string }[];
  rows: Record<string, string | number | null>[];
  generated_at: string;
}

const MAX_ROWS = 5000;
const OPEN = [...OPEN_ENROLLMENT_STATUSES];

/** Tabular student reports: one shape (columns + rows) shared by the app and the CSV. */
export class StudentReportService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  async run(
    tenantId: string,
    report: StudentReport,
    q: z.infer<typeof StudentReportQuery>,
    principal: Principal,
    actor: Actor,
  ): Promise<StudentReportTable | string> {
    if (q.format === 'csv' && !hasTenantWideScope(principal, 'students.export'))
      throw new AuthorizationError('PERMISSION_DENIED', 'You cannot export student data');
    const table = await this.build(tenantId, report, q, principal);
    if (q.format === 'json') return table;
    await this.db.transaction(async (tx) => {
      await recordChange(tx, actor, tenantId, {
        action: 'STUDENT_REPORT_EXPORTED',
        entityType: 'student_report',
        entityId: tenantId,
        payload: { report, rows: table.rows.length },
      });
    });
    return (
      [
        csvLine(table.columns.map((c) => c.label)),
        ...table.rows.map((r) => csvLine(table.columns.map((c) => r[c.key]))),
      ].join('\n') + '\n'
    );
  }

  /** The year to report on: the one asked for, else the active one. */
  private async yearId(tenantId: string, asked?: string): Promise<string | null> {
    if (asked) return asked;
    const [y] = await this.db
      .select({ id: academicYears.id })
      .from(academicYears)
      .where(and(eq(academicYears.tenantId, tenantId), eq(academicYears.status, 'ACTIVE')));
    return y?.id ?? null;
  }

  private async build(
    tenantId: string,
    report: StudentReport,
    q: z.infer<typeof StudentReportQuery>,
    principal: Principal,
  ): Promise<StudentReportTable> {
    const base = { report, generated_at: this.deps.clock.now().toISOString() };
    const scope = studentScope(principal, 'students.read');

    switch (report) {
      case 'class-strength':
      case 'gender-strength': {
        const yearId = await this.yearId(tenantId, q.academic_year_id);
        if (!yearId) return this.empty(base, report);
        const bySection = report === 'class-strength';
        const rows = await this.db
          .select({
            className: academicClasses.name,
            classSeq: academicClasses.sequence,
            // Not grouped for the gender report, so they must not be selected there (ONLY_FULL_GROUP_BY).
            sectionName: bySection ? academicSections.name : sql<string | null>`null`,
            capacity: bySection ? academicSections.capacity : sql<number | null>`null`,
            total: sql<number>`count(*)`,
            male: sql<number>`sum(${students.gender} = 'MALE')`,
            female: sql<number>`sum(${students.gender} = 'FEMALE')`,
            other: sql<number>`sum(${students.gender} in ('OTHER','UNDISCLOSED'))`,
          })
          .from(enrollments)
          .innerJoin(
            students,
            and(
              eq(students.tenantId, enrollments.tenantId),
              eq(students.id, enrollments.studentId),
            ),
          )
          .innerJoin(academicClasses, eq(academicClasses.id, enrollments.classId))
          .leftJoin(academicSections, eq(academicSections.id, enrollments.sectionId))
          .where(
            and(
              eq(enrollments.tenantId, tenantId),
              eq(enrollments.academicYearId, yearId),
              inArray(enrollments.status, OPEN),
              q.class_id ? eq(enrollments.classId, q.class_id) : undefined,
              q.section_id ? eq(enrollments.sectionId, q.section_id) : undefined,
              scope,
            ),
          )
          .groupBy(
            academicClasses.id,
            academicClasses.name,
            academicClasses.sequence,
            ...(bySection
              ? [academicSections.id, academicSections.name, academicSections.capacity]
              : []),
          )
          .orderBy(
            asc(academicClasses.sequence),
            ...(bySection ? [asc(academicSections.name)] : []),
          );
        const n = (v: unknown) => Number(v ?? 0);
        const body = rows.map((r) => ({
          class: r.className,
          section: bySection ? (r.sectionName ?? 'No section') : null,
          capacity: bySection ? r.capacity : null,
          male: n(r.male),
          female: n(r.female),
          other: n(r.other),
          total: n(r.total),
        }));
        const sum = (k: 'male' | 'female' | 'other' | 'total') =>
          body.reduce((a, r) => a + r[k], 0);
        body.push({
          class: 'Total',
          section: null,
          capacity: null,
          male: sum('male'),
          female: sum('female'),
          other: sum('other'),
          total: sum('total'),
        });
        return {
          ...base,
          title: bySection ? 'Class strength' : 'Gender strength by class',
          columns: [
            { key: 'class', label: 'Class' },
            ...(bySection
              ? [
                  { key: 'section', label: 'Section' },
                  { key: 'capacity', label: 'Capacity' },
                ]
              : []),
            { key: 'male', label: 'Boys' },
            { key: 'female', label: 'Girls' },
            { key: 'other', label: 'Other' },
            { key: 'total', label: 'Total' },
          ],
          rows: body,
        };
      }

      case 'admissions': {
        const rows = await this.db
          .select({ s: students, house: studentHouses.name })
          .from(students)
          .leftJoin(studentHouses, eq(studentHouses.id, students.houseId))
          .where(
            and(
              eq(students.tenantId, tenantId),
              scope,
              q.date_from ? gte(students.admissionDate, q.date_from) : undefined,
              q.date_to ? lte(students.admissionDate, q.date_to) : undefined,
              q.admission_type ? eq(students.admissionType, q.admission_type) : undefined,
              q.gender ? eq(students.gender, q.gender) : undefined,
              this.placement(q),
            ),
          )
          .orderBy(asc(students.admissionDate), asc(students.lastName))
          .limit(MAX_ROWS);
        const places = await this.placements(
          tenantId,
          rows.map((r) => r.s.id),
        );
        return {
          ...base,
          title: 'Admissions',
          columns: [
            { key: 'admission_number', label: 'Admission no.' },
            { key: 'name', label: 'Name' },
            { key: 'admission_date', label: 'Admission date' },
            { key: 'admission_type', label: 'Type' },
            { key: 'class', label: 'Class' },
            { key: 'previous_school', label: 'Previous school' },
            { key: 'status', label: 'Status' },
          ],
          rows: rows.map(({ s }) => ({
            admission_number: s.admissionNumber,
            name: fullName(s),
            admission_date: s.admissionDate,
            admission_type: s.admissionType,
            class: places.get(s.id) ?? null,
            previous_school: s.previousSchool,
            status: s.status,
          })),
        };
      }

      case 'withdrawals':
      case 'transfers': {
        const kind = report === 'withdrawals' ? 'WITHDRAWN' : 'TRANSFERRED';
        const rows = await this.db
          .select({ e: studentExits, s: students })
          .from(studentExits)
          .innerJoin(
            students,
            and(
              eq(students.tenantId, studentExits.tenantId),
              eq(students.id, studentExits.studentId),
            ),
          )
          .where(
            and(
              eq(studentExits.tenantId, tenantId),
              eq(studentExits.kind, kind),
              scope,
              q.date_from ? gte(studentExits.exitDate, q.date_from) : undefined,
              q.date_to ? lte(studentExits.exitDate, q.date_to) : undefined,
              q.gender ? eq(students.gender, q.gender) : undefined,
              this.exitPlacement(q),
            ),
          )
          .orderBy(asc(studentExits.exitDate), asc(students.lastName))
          .limit(MAX_ROWS);
        const classes = await this.lastClasses(
          tenantId,
          rows.map((r) => r.s.id),
        );
        const isTransfer = kind === 'TRANSFERRED';
        return {
          ...base,
          title: isTransfer ? 'Transfers out' : 'Withdrawals',
          columns: [
            { key: 'admission_number', label: 'Admission no.' },
            { key: 'name', label: 'Name' },
            { key: 'class', label: 'Class' },
            { key: 'exit_date', label: isTransfer ? 'Transfer date' : 'Withdrawal date' },
            ...(isTransfer ? [{ key: 'destination', label: 'Transferred to' }] : []),
            { key: 'reason', label: 'Reason' },
            { key: 'remarks', label: 'Remarks' },
            { key: 'returned', label: 'Reinstated' },
          ],
          rows: rows.map(({ e, s }) => ({
            admission_number: s.admissionNumber,
            name: fullName(s),
            class: classes.get(s.id) ?? null,
            exit_date: e.exitDate,
            destination: e.destinationSchool,
            reason: e.reason,
            remarks: e.remarks,
            returned: e.reinstatedAt ? 'Yes' : 'No',
          })),
        };
      }

      case 'student-list': {
        const rows = await this.db
          .select({ s: students, house: studentHouses.name })
          .from(students)
          .leftJoin(studentHouses, eq(studentHouses.id, students.houseId))
          .where(
            and(
              eq(students.tenantId, tenantId),
              scope,
              q.status ? eq(students.status, q.status) : undefined,
              q.gender ? eq(students.gender, q.gender) : undefined,
              q.admission_type ? eq(students.admissionType, q.admission_type) : undefined,
              this.placement(q),
            ),
          )
          .orderBy(asc(students.lastName), asc(students.firstName))
          .limit(MAX_ROWS);
        const places = await this.placements(
          tenantId,
          rows.map((r) => r.s.id),
        );
        return {
          ...base,
          title: 'Student list',
          columns: [
            { key: 'student_number', label: 'Student no.' },
            { key: 'admission_number', label: 'Admission no.' },
            { key: 'name', label: 'Name' },
            { key: 'gender', label: 'Gender' },
            { key: 'date_of_birth', label: 'Date of birth' },
            { key: 'class', label: 'Class' },
            { key: 'house', label: 'House' },
            { key: 'status', label: 'Status' },
            { key: 'phone', label: 'Phone' },
            { key: 'email', label: 'Email' },
          ],
          rows: rows.map(({ s, house }) => ({
            student_number: s.studentNumber,
            admission_number: s.admissionNumber,
            name: fullName(s),
            gender: s.gender,
            date_of_birth: s.dateOfBirth,
            class: places.get(s.id) ?? null,
            house,
            status: s.status,
            phone: s.primaryPhone,
            email: s.primaryEmail,
          })),
        };
      }
    }
  }

  private empty(
    base: { report: StudentReport; generated_at: string },
    report: StudentReport,
  ): StudentReportTable {
    return {
      ...base,
      title: report === 'class-strength' ? 'Class strength' : 'Gender strength by class',
      columns: [{ key: 'class', label: 'Class' }],
      rows: [],
    };
  }

  /** Filter: the student has an open enrollment matching the year / class / section filters. */
  private placement(q: z.infer<typeof StudentReportQuery>): SQL | undefined {
    if (!q.academic_year_id && !q.class_id && !q.section_id) return undefined;
    const place = and(
      eq(enrollments.tenantId, students.tenantId),
      eq(enrollments.studentId, students.id),
      inArray(enrollments.status, OPEN),
      q.academic_year_id ? eq(enrollments.academicYearId, q.academic_year_id) : undefined,
      q.class_id ? eq(enrollments.classId, q.class_id) : undefined,
      q.section_id ? eq(enrollments.sectionId, q.section_id) : undefined,
    );
    return sql`exists (select 1 from ${enrollments} where ${place})`;
  }

  /** Exits are for students who no longer have an open enrollment, so match any enrollment. */
  private exitPlacement(q: z.infer<typeof StudentReportQuery>): SQL | undefined {
    if (!q.academic_year_id && !q.class_id && !q.section_id) return undefined;
    const place = and(
      eq(enrollments.tenantId, students.tenantId),
      eq(enrollments.studentId, students.id),
      q.academic_year_id ? eq(enrollments.academicYearId, q.academic_year_id) : undefined,
      q.class_id ? eq(enrollments.classId, q.class_id) : undefined,
      q.section_id ? eq(enrollments.sectionId, q.section_id) : undefined,
    );
    return sql`exists (select 1 from ${enrollments} where ${place})`;
  }

  /** "Grade 7 · Section A" of each student's open enrollment. */
  private async placements(tenantId: string, ids: string[]) {
    return this.classLabels(tenantId, ids, true);
  }

  /** The class a student was last in, open or not. */
  private async lastClasses(tenantId: string, ids: string[]) {
    return this.classLabels(tenantId, ids, false);
  }

  private async classLabels(tenantId: string, ids: string[], openOnly: boolean) {
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const rows = await this.db
      .select({
        studentId: enrollments.studentId,
        className: academicClasses.name,
        sectionName: academicSections.name,
        start: enrollments.startDate,
      })
      .from(enrollments)
      .innerJoin(academicClasses, eq(academicClasses.id, enrollments.classId))
      .leftJoin(academicSections, eq(academicSections.id, enrollments.sectionId))
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          inArray(enrollments.studentId, ids),
          openOnly ? inArray(enrollments.status, OPEN) : undefined,
        ),
      )
      .orderBy(asc(enrollments.startDate));
    for (const r of rows)
      out.set(r.studentId, r.sectionName ? `${r.className} · ${r.sectionName}` : r.className);
    return out; // later start dates overwrite earlier ones
  }
}
