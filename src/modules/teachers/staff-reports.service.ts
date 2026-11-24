import { and, asc, eq, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Deps } from '../../container.js';
import {
  staffDocuments,
  staffDocumentTypes,
  teacherQualifications,
  teachers,
  TEACHER_STATUS,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { csvLine } from '../../shared/csv.js';
import { todayIso } from '../../shared/dates.js';
import { AuthorizationError } from '../../shared/errors.js';
import { addDays } from '../../shared/time.js';
import { hasTenantWideScope } from '../access/authorization.service.js';
import { fullName } from './support.js';

export const STAFF_REPORTS = [
  'directory',
  'by-department',
  'qualifications',
  'expiring-documents',
] as const;
export type StaffReport = (typeof STAFF_REPORTS)[number];

export const StaffReportParams = z.object({ report: z.enum(STAFF_REPORTS) });
export const StaffReportQuery = z.object({
  format: z.enum(['json', 'csv']).default('json'),
  status: z.enum(TEACHER_STATUS).optional(),
  department: z.string().trim().min(1).max(100).optional(),
  /** expiring-documents: how far ahead to look (default 60 days). */
  days: z.coerce.number().int().min(1).max(365).default(60),
});

export interface ReportTable {
  report: StaffReport;
  title: string;
  columns: { key: string; label: string }[];
  rows: Record<string, string | number | null>[];
  generated_at: string;
}

const LIVE = ['ACTIVE', 'ON_LEAVE', 'ONBOARDING'] as const;

/** Tabular teacher reports. One shape (columns + rows) so the app and the CSV share one renderer. */
export class StaffReportService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  async run(
    tenantId: string,
    report: StaffReport,
    q: z.infer<typeof StaffReportQuery>,
    principal: Principal,
    actor: Actor,
  ): Promise<ReportTable | string> {
    if (!hasTenantWideScope(principal, 'teachers.reports.read'))
      throw new AuthorizationError('PERMISSION_DENIED', 'Teacher reports need school-wide access');
    if (q.format === 'csv' && !hasTenantWideScope(principal, 'teachers.export'))
      throw new AuthorizationError('PERMISSION_DENIED', 'You cannot export teacher data');
    const table = await this.build(tenantId, report, q);
    if (q.format === 'json') return table;
    await this.db.transaction(async (tx) => {
      await recordChange(tx, actor, tenantId, {
        action: 'STAFF_REPORT_EXPORTED',
        entityType: 'staff_report',
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

  private staffFilter(tenantId: string, q: z.infer<typeof StaffReportQuery>): SQL {
    return and(
      eq(teachers.tenantId, tenantId),
      q.status ? eq(teachers.status, q.status) : undefined,
      q.department ? eq(teachers.department, q.department) : undefined,
    )!;
  }

  private async build(
    tenantId: string,
    report: StaffReport,
    q: z.infer<typeof StaffReportQuery>,
  ): Promise<ReportTable> {
    const base = { report, generated_at: this.deps.clock.now().toISOString() };
    switch (report) {
      case 'directory': {
        const rows = await this.db
          .select()
          .from(teachers)
          .where(this.staffFilter(tenantId, q))
          .orderBy(asc(teachers.lastName), asc(teachers.firstName));
        return {
          ...base,
          title: 'Teacher directory',
          columns: [
            { key: 'teacher_number', label: 'Teacher no.' },
            { key: 'name', label: 'Name' },
            { key: 'status', label: 'Status' },
            { key: 'department', label: 'Department' },
            { key: 'designation', label: 'Designation' },
            { key: 'employment_type', label: 'Employment' },
            { key: 'joining_date', label: 'Joined' },
            { key: 'email', label: 'Email' },
            { key: 'phone', label: 'Phone' },
          ],
          rows: rows.map((t) => ({
            teacher_number: t.teacherNumber,
            name: fullName(t),
            status: t.status,
            department: t.department,
            designation: t.designation,
            employment_type: t.employmentType,
            joining_date: t.joiningDate,
            email: t.email,
            phone: t.phone,
          })),
        };
      }
      case 'by-department': {
        const rows = await this.db
          .select({
            department: teachers.department,
            n: sql<number>`count(*)`.mapWith(Number),
          })
          .from(teachers)
          .where(and(eq(teachers.tenantId, tenantId), inArray(teachers.status, [...LIVE])))
          .groupBy(teachers.department);
        return {
          ...base,
          title: 'Teachers by department (active, on leave and onboarding)',
          columns: [
            { key: 'department', label: 'Department' },
            { key: 'total', label: 'Teachers' },
          ],
          rows: rows
            .map((r) => ({ department: r.department ?? '(No department)', total: r.n }))
            .sort((a, b) => a.department.localeCompare(b.department)),
        };
      }
      case 'qualifications': {
        const rows = await this.db
          .select({ t: teachers, qual: teacherQualifications })
          .from(teacherQualifications)
          .innerJoin(
            teachers,
            and(
              eq(teachers.tenantId, teacherQualifications.tenantId),
              eq(teachers.id, teacherQualifications.teacherId),
            ),
          )
          .where(and(this.staffFilter(tenantId, q), eq(teacherQualifications.status, 'ACTIVE')))
          .orderBy(asc(teachers.lastName), asc(teachers.firstName));
        return {
          ...base,
          title: 'Teacher qualifications',
          columns: [
            { key: 'teacher_number', label: 'Teacher no.' },
            { key: 'name', label: 'Name' },
            { key: 'department', label: 'Department' },
            { key: 'type', label: 'Type' },
            { key: 'title', label: 'Qualification' },
            { key: 'institution', label: 'Institution' },
            { key: 'year', label: 'Year' },
          ],
          rows: rows.map(({ t, qual }) => ({
            teacher_number: t.teacherNumber,
            name: fullName(t),
            department: t.department,
            type: qual.qualificationType,
            title: qual.title,
            institution: qual.institution,
            year: qual.completionYear,
          })),
        };
      }
      case 'expiring-documents': {
        const today = todayIso(this.deps.clock);
        const until = addDays(new Date(`${today}T00:00:00Z`), q.days)
          .toISOString()
          .slice(0, 10);
        const rows = await this.db
          .select({ t: teachers, d: staffDocuments, type: staffDocumentTypes })
          .from(staffDocuments)
          .innerJoin(
            teachers,
            and(
              eq(teachers.tenantId, staffDocuments.tenantId),
              eq(teachers.id, staffDocuments.teacherId),
            ),
          )
          .innerJoin(
            staffDocumentTypes,
            and(
              eq(staffDocumentTypes.tenantId, staffDocuments.tenantId),
              eq(staffDocumentTypes.id, staffDocuments.typeId),
            ),
          )
          .where(
            and(
              this.staffFilter(tenantId, q),
              isNull(staffDocuments.replacedAt),
              lte(staffDocuments.expiresOn, until),
              inArray(teachers.status, [...LIVE]),
            ),
          )
          .orderBy(asc(staffDocuments.expiresOn));
        return {
          ...base,
          title: `Documents expired or expiring within ${q.days} days`,
          columns: [
            { key: 'teacher_number', label: 'Teacher no.' },
            { key: 'name', label: 'Name' },
            { key: 'document', label: 'Document' },
            { key: 'expires_on', label: 'Expires' },
            { key: 'state', label: 'State' },
          ],
          rows: rows.map(({ t, d, type }) => ({
            teacher_number: t.teacherNumber,
            name: fullName(t),
            document: type.name,
            expires_on: d.expiresOn,
            state: d.expiresOn! < today ? 'Expired' : 'Expiring soon',
          })),
        };
      }
    }
  }
}
