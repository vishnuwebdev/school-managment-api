import { and, eq, inArray } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { uuidv7 } from 'uuidv7';
import type { Deps } from '../../container.js';
import { teachers } from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { BusinessRuleError, ValidationError } from '../../shared/errors.js';
import { hasTenantWideScope } from '../access/authorization.service.js';
import type { StaffLookupService } from './lookups.service.js';
import type { TeacherService } from './teachers.service.js';
import { CreateTeacherBody } from './teachers.schemas.js';

export const IMPORT_MAX_ROWS = 500;
export const IMPORT_CONTENT_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
];

/** Columns of the template, in order. `*` marks required ones in the template only. */
const COLUMNS: { key: string; label: string; example: string; note: string }[] = [
  { key: 'first_name', label: 'first_name', example: 'Asha', note: 'Required' },
  { key: 'last_name', label: 'last_name', example: 'Patel', note: 'Required' },
  { key: 'middle_name', label: 'middle_name', example: '', note: '' },
  {
    key: 'teacher_number',
    label: 'teacher_number',
    example: '',
    note: 'Leave empty to number automatically',
  },
  {
    key: 'staff_type',
    label: 'staff_type',
    example: 'TEACHING',
    note: 'TEACHING or NON_TEACHING (default TEACHING)',
  },
  { key: 'gender', label: 'gender', example: 'FEMALE', note: 'MALE, FEMALE, OTHER or UNDISCLOSED' },
  { key: 'date_of_birth', label: 'date_of_birth', example: '1990-04-18', note: 'YYYY-MM-DD' },
  { key: 'email', label: 'email', example: 'asha@example.com', note: '' },
  { key: 'phone', label: 'phone', example: '+27 82 000 0000', note: '' },
  { key: 'joining_date', label: 'joining_date', example: '2026-01-12', note: 'YYYY-MM-DD' },
  {
    key: 'employment_type',
    label: 'employment_type',
    example: 'FULL_TIME',
    note: 'FULL_TIME, PART_TIME, CONTRACT or VISITING',
  },
  {
    key: 'department',
    label: 'department',
    example: 'Mathematics',
    note: "Must be on the school's list when it has one",
  },
  {
    key: 'designation',
    label: 'designation',
    example: 'Senior teacher',
    note: "Must be on the school's list when it has one",
  },
  { key: 'emergency_contact_name', label: 'emergency_contact_name', example: '', note: '' },
  { key: 'emergency_contact_phone', label: 'emergency_contact_phone', example: '', note: '' },
  { key: 'emergency_contact_relation', label: 'emergency_contact_relation', example: '', note: '' },
  { key: 'id_number', label: 'id_number', example: '', note: 'Stored encrypted' },
  {
    key: 'reporting_manager_number',
    label: 'reporting_manager_number',
    example: '',
    note: 'Teacher number of an existing staff member',
  },
];
const KEYS = new Set(COLUMNS.map((c) => c.key));
const ENUM_FIELDS = ['staff_type', 'gender', 'employment_type'];

export interface ImportRow {
  row: number;
  name: string;
  status: 'OK' | 'ERROR';
  errors: string[];
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v)
      return v.richText
        .map((t) => t.text)
        .join('')
        .trim();
    if ('text' in v && typeof v.text === 'string') return v.text.trim();
    if ('result' in v && v.result !== undefined) return cellText(v.result as ExcelJS.CellValue);
    return '';
  }
  return String(v).trim();
}

export class StaffImportService {
  constructor(
    private readonly deps: Deps,
    private readonly teachersSvc: TeacherService,
    private readonly lookups: StaffLookupService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  async template(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Staff');
    ws.addRow(COLUMNS.map((c) => c.label)).font = { bold: true };
    ws.addRow(COLUMNS.map((c) => c.example));
    ws.columns.forEach((c) => (c.width = 24));
    const help = wb.addWorksheet('Instructions');
    help.addRow(['Column', 'Notes']).font = { bold: true };
    for (const c of COLUMNS) help.addRow([c.label, c.note]);
    help.addRow([]);
    help.addRow([
      `Up to ${IMPORT_MAX_ROWS} rows. Delete the example row before uploading. Nothing is saved if any row has an error.`,
    ]);
    help.getColumn(1).width = 30;
    help.getColumn(2).width = 70;
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  private async parse(data: Buffer, contentType: string): Promise<Record<string, string>[]> {
    const wb = new ExcelJS.Workbook();
    try {
      if (contentType.includes('csv')) {
        const { Readable } = await import('node:stream');
        await wb.csv.read(Readable.from(data));
      } else {
        await wb.xlsx.load(data as unknown as ArrayBuffer);
      }
    } catch {
      throw new ValidationError(
        'The file could not be read. Upload the template as .xlsx or .csv.',
      );
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new ValidationError('The file has no sheet');
    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = cellText(cell.value)
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    });
    const unknown = headers.filter((h) => h && !KEYS.has(h));
    if (!headers.includes('first_name') || !headers.includes('last_name'))
      throw new ValidationError('The first row must contain the template headings', {
        missing: ['first_name', 'last_name'].filter((h) => !headers.includes(h)),
      });
    if (unknown.length)
      throw new ValidationError(`Unknown columns: ${unknown.join(', ')}. Use the template.`);
    const out: Record<string, string>[] = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      const rec: Record<string, string> = { __row: String(n) };
      let any = false;
      headers.forEach((h, col) => {
        if (!h) return;
        const v = cellText(row.getCell(col).value);
        if (v) any = true;
        rec[h] = v;
      });
      if (any) out.push(rec);
    });
    if (!out.length) throw new ValidationError('The file has no staff rows');
    if (out.length > IMPORT_MAX_ROWS)
      throw new ValidationError(`Too many rows (${out.length}). The limit is ${IMPORT_MAX_ROWS}.`);
    return out;
  }

  /**
   * Validates the whole file; with commit=true and no errors, creates every
   * row in ONE transaction (all or nothing) and writes one audit entry.
   */
  async run(
    tenantId: string,
    file: { data: Buffer; contentType: string },
    opts: { commit: boolean; allowDuplicates: boolean },
    principal: Principal,
    actor: Actor,
  ) {
    if (!hasTenantWideScope(principal, 'teachers.create'))
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'Importing staff needs school-wide access',
      );
    if (!file.data?.length || !Buffer.isBuffer(file.data))
      throw new ValidationError('Send the .xlsx or .csv file as the request body');
    const raw = await this.parse(file.data, file.contentType);

    const numbers = raw.map((r) => r.reporting_manager_number).filter((n): n is string => !!n);
    const managers = numbers.length
      ? await this.db
          .select({ id: teachers.id, n: teachers.teacherNumber })
          .from(teachers)
          .where(and(eq(teachers.tenantId, tenantId), inArray(teachers.teacherNumber, numbers)))
      : [];
    const managerByNumber = new Map(managers.map((m) => [m.n.toUpperCase(), m.id]));
    const given = raw.map((r) => r.teacher_number?.toUpperCase()).filter((n): n is string => !!n);
    const taken = given.length
      ? new Set(
          (
            await this.db
              .select({ n: teachers.teacherNumber })
              .from(teachers)
              .where(and(eq(teachers.tenantId, tenantId), inArray(teachers.teacherNumber, given)))
          ).map((t) => t.n),
        )
      : new Set<string>();

    const rows: ImportRow[] = [];
    const inputs: { row: number; input: ReturnType<typeof CreateTeacherBody.parse> }[] = [];
    const seen = new Map<string, number>();
    const seenNumbers = new Map<string, number>();

    for (const r of raw) {
      const rowNo = Number(r.__row);
      const errors: string[] = [];
      const candidate: Record<string, unknown> = { status: 'ACTIVE' };
      for (const c of COLUMNS) {
        const v = r[c.key];
        if (!v || c.key === 'reporting_manager_number') continue;
        candidate[c.key] = ENUM_FIELDS.includes(c.key)
          ? v.toUpperCase().replace(/[\s-]+/g, '_')
          : v;
      }
      const parsed = CreateTeacherBody.safeParse(candidate);
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          errors.push(`${issue.path.join('.') || 'row'}: ${issue.message}`);
      const name = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || '(no name)';

      if (parsed.success) {
        const input = parsed.data;
        if (r.reporting_manager_number) {
          const mid = managerByNumber.get(r.reporting_manager_number.toUpperCase());
          if (!mid)
            errors.push(`reporting_manager_number: ${r.reporting_manager_number} not found`);
          else input.reporting_manager_id = mid;
        }
        if (input.teacher_number) {
          if (taken.has(input.teacher_number))
            errors.push(`teacher_number: ${input.teacher_number} is already in use`);
          const prev = seenNumbers.get(input.teacher_number);
          if (prev) errors.push(`teacher_number: also used on row ${prev}`);
          else seenNumbers.set(input.teacher_number, rowNo);
        }
        for (const [kind, value] of [
          ['DEPARTMENT', input.department],
          ['DESIGNATION', input.designation],
        ] as const) {
          try {
            await this.lookups.assertAllowed(this.db, tenantId, kind, value);
          } catch (e) {
            if (e instanceof ValidationError) errors.push(e.message);
            else throw e;
          }
        }
        const keys = [
          input.email ? `e:${input.email.toLowerCase()}` : null,
          input.phone ? `p:${input.phone}` : null,
          input.date_of_birth
            ? `n:${input.first_name.toLowerCase()}|${input.last_name.toLowerCase()}|${input.date_of_birth}`
            : null,
        ].filter((k): k is string => !!k);
        const dupRow = keys.map((k) => seen.get(k)).find((x) => x !== undefined);
        if (dupRow !== undefined && !opts.allowDuplicates)
          errors.push(`Looks like the same person as row ${dupRow}`);
        for (const k of keys) if (!seen.has(k)) seen.set(k, rowNo);
        if (!opts.allowDuplicates) {
          const dups = await this.teachersSvc.findDuplicates(this.db, tenantId, {
            firstName: input.first_name,
            lastName: input.last_name,
            dateOfBirth: input.date_of_birth,
            phone: input.phone,
            email: input.email,
          });
          if (dups.length)
            errors.push(
              `Possible duplicate of ${dups[0]!.full_name} (${dups[0]!.teacher_number}) — matched on ${dups[0]!.matched_on.join(', ')}`,
            );
        }
        if (!errors.length)
          inputs.push({ row: rowNo, input: { ...input, confirm_duplicate: true } });
      }
      rows.push({ row: rowNo, name, status: errors.length ? 'ERROR' : 'OK', errors });
    }

    const invalid = rows.filter((r) => r.status === 'ERROR').length;
    const summary = {
      dry_run: !opts.commit,
      total: rows.length,
      valid: rows.length - invalid,
      invalid,
      created: 0,
      rows,
    };
    if (!opts.commit) return summary;
    if (invalid)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'Fix the errors before importing',
        summary,
      );

    await this.db.transaction(async (tx) => {
      for (const { input } of inputs) await this.teachersSvc.insertInTx(tx, tenantId, input, actor);
      await recordChange(tx, actor, tenantId, {
        action: 'STAFF_IMPORTED',
        entityType: 'staff_import',
        entityId: uuidv7(),
        after: { created: inputs.length },
      });
    });
    return { ...summary, created: inputs.length };
  }
}
