import { and, eq, inArray, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { uuidv7 } from 'uuidv7';
import type { Deps } from '../../container.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  guardians,
  studentHouses,
  students,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { BusinessRuleError, ValidationError } from '../../shared/errors.js';
import { hasTenantWideScope } from '../access/authorization.service.js';
import type { AcademicService } from '../academic/academic.service.js';
import type { GuardianService } from './guardians.service.js';
import type { StudentConfigService } from './config.service.js';
import { CreateStudentBody } from './students.schemas.js';
import type { StudentService } from './students.service.js';

export const STUDENT_IMPORT_MAX_ROWS = 1000;
export const STUDENT_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const STUDENT_IMPORT_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const COLUMNS: { key: string; example: string; note: string }[] = [
  { key: 'first_name', example: 'Aanya', note: 'Required' },
  { key: 'middle_name', example: '', note: '' },
  { key: 'last_name', example: 'Sharma', note: 'Required' },
  {
    key: 'admission_number',
    example: '',
    note: 'Required when the school enters admission numbers by hand; ignored otherwise',
  },
  { key: 'gender', example: 'FEMALE', note: 'MALE, FEMALE, OTHER or UNDISCLOSED' },
  { key: 'date_of_birth', example: '2014-06-21', note: 'YYYY-MM-DD' },
  { key: 'blood_group', example: 'O+', note: 'A+, A-, B+, B-, AB+, AB-, O+ or O-' },
  { key: 'nationality', example: '', note: '' },
  { key: 'category', example: '', note: '' },
  { key: 'house', example: '', note: "Name of one of the school's houses" },
  { key: 'previous_school', example: '', note: '' },
  { key: 'admission_date', example: '2026-01-12', note: 'YYYY-MM-DD (defaults to today)' },
  { key: 'admission_type', example: 'NEW', note: 'NEW, TRANSFER_IN or RE_ADMISSION' },
  {
    key: 'class_code',
    example: 'G7',
    note: 'Class code (see the Lists sheet). Leave empty to add the student without a class',
  },
  {
    key: 'section_code',
    example: 'A',
    note: 'Section code in the active academic year (optional)',
  },
  { key: 'email', example: '', note: "The student's own email" },
  { key: 'phone', example: '', note: '' },
  { key: 'address_line1', example: '', note: '' },
  { key: 'address_city', example: '', note: '' },
  { key: 'address_postal_code', example: '', note: '' },
  { key: 'father_name', example: 'Raj Sharma', note: 'A single word uses the student last name' },
  { key: 'father_phone', example: '', note: '' },
  { key: 'father_email', example: '', note: '' },
  { key: 'mother_name', example: '', note: '' },
  { key: 'mother_phone', example: '', note: '' },
  { key: 'mother_email', example: '', note: '' },
  { key: 'guardian_name', example: '', note: 'For a guardian who is not the father or mother' },
  {
    key: 'guardian_relation',
    example: '',
    note: 'GRANDPARENT, SIBLING, RELATIVE, FOSTER, LEGAL_GUARDIAN or OTHER',
  },
  { key: 'guardian_phone', example: '', note: '' },
  { key: 'guardian_email', example: '', note: '' },
];
const KEYS = new Set(COLUMNS.map((c) => c.key));
const ENUM_FIELDS = ['gender', 'admission_type', 'guardian_relation'];

export interface StudentImportRow {
  row: number;
  name: string;
  status: 'OK' | 'ERROR';
  errors: string[];
  placement: string | null;
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

/** "Raj Kumar Sharma" → first "Raj Kumar", last "Sharma". One word falls back to the student's last name. */
function splitName(full: string, fallbackLast: string) {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0]!, last_name: fallbackLast };
  return { first_name: parts.slice(0, -1).join(' '), last_name: parts[parts.length - 1]! };
}

type Parsed = ReturnType<typeof CreateStudentBody.parse>;

export class StudentImportService {
  constructor(
    private readonly deps: Deps,
    private readonly studentSvc: StudentService,
    private readonly guardianSvc: GuardianService,
    private readonly academic: AcademicService,
    private readonly config: StudentConfigService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  private async activeYear(tenantId: string) {
    const [y] = await this.db
      .select()
      .from(academicYears)
      .where(and(eq(academicYears.tenantId, tenantId), eq(academicYears.status, 'ACTIVE')));
    return y ?? null;
  }

  async template(tenantId: string): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Students');
    ws.addRow(COLUMNS.map((c) => c.key)).font = { bold: true };
    ws.addRow(COLUMNS.map((c) => c.example));
    ws.columns.forEach((c) => (c.width = 22));

    const help = wb.addWorksheet('Instructions');
    help.addRow(['Column', 'Notes']).font = { bold: true };
    for (const c of COLUMNS) help.addRow([c.key, c.note]);
    help.addRow([]);
    help.addRow([
      `Up to ${STUDENT_IMPORT_MAX_ROWS} rows. Delete the example row before uploading. Nothing is saved if any row has an error.`,
    ]);
    help.getColumn(1).width = 26;
    help.getColumn(2).width = 80;

    const year = await this.activeYear(tenantId);
    const lists = wb.addWorksheet('Lists');
    lists.addRow(['Class code', 'Class name', 'Section code', 'Section name']).font = {
      bold: true,
    };
    const classes = await this.db
      .select()
      .from(academicClasses)
      .where(and(eq(academicClasses.tenantId, tenantId), eq(academicClasses.status, 'ACTIVE')))
      .orderBy(academicClasses.sequence);
    const sections = year
      ? await this.db
          .select()
          .from(academicSections)
          .where(
            and(
              eq(academicSections.tenantId, tenantId),
              eq(academicSections.academicYearId, year.id),
              eq(academicSections.status, 'ACTIVE'),
            ),
          )
      : [];
    for (const c of classes) {
      const own = sections.filter((s) => s.classId === c.id);
      if (!own.length) lists.addRow([c.code, c.name, '', '']);
      for (const s of own) lists.addRow([c.code, c.name, s.code, s.name]);
    }
    lists.addRow([]);
    lists.addRow(['Houses']).font = { bold: true };
    const houses = await this.db
      .select()
      .from(studentHouses)
      .where(and(eq(studentHouses.tenantId, tenantId), eq(studentHouses.isActive, true)));
    for (const h of houses) lists.addRow([h.name]);
    lists.columns.forEach((c) => (c.width = 20));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  private async parse(data: Buffer): Promise<Record<string, string>[]> {
    if (data.length > STUDENT_IMPORT_MAX_BYTES)
      throw new ValidationError('The file is larger than 5 MB');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(data as unknown as ArrayBuffer);
    } catch {
      throw new ValidationError('The file could not be read. Upload the template as .xlsx.');
    }
    const ws = wb.getWorksheet('Students') ?? wb.worksheets[0];
    if (!ws) throw new ValidationError('The file has no sheet');
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = cellText(cell.value)
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    });
    const missing = ['first_name', 'last_name'].filter((h) => !headers.includes(h));
    if (missing.length)
      throw new ValidationError('The first row must contain the template headings', { missing });
    const unknown = headers.filter((h) => h && !KEYS.has(h));
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
    if (!out.length) throw new ValidationError('The file has no student rows');
    if (out.length > STUDENT_IMPORT_MAX_ROWS)
      throw new ValidationError(
        `Too many rows (${out.length}). The limit is ${STUDENT_IMPORT_MAX_ROWS}.`,
      );
    return out;
  }

  /**
   * Checks the whole file row by row. With commit=true and no errors, creates every
   * student (with parents and class placement) in ONE transaction, or none at all.
   */
  async run(
    tenantId: string,
    file: { data: Buffer; contentType: string },
    opts: { commit: boolean; allowDuplicates: boolean },
    principal: Principal,
    actor: Actor,
  ) {
    if (!hasTenantWideScope(principal, 'students.import'))
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'Importing students needs school-wide access',
      );
    if (!Buffer.isBuffer(file.data) || !file.data.length)
      throw new ValidationError('Send the .xlsx file as the request body');
    if (!file.contentType.includes('spreadsheetml'))
      throw new ValidationError('Upload the template as an .xlsx file');
    const raw = await this.parse(file.data);

    const { admission_number_mode: mode } = await this.config.getSettings(tenantId);
    const year = await this.activeYear(tenantId);

    const classes = await this.db
      .select()
      .from(academicClasses)
      .where(and(eq(academicClasses.tenantId, tenantId), eq(academicClasses.status, 'ACTIVE')));
    const classByCode = new Map(classes.map((c) => [c.code.toUpperCase(), c]));
    const sections = year
      ? await this.db
          .select()
          .from(academicSections)
          .where(
            and(
              eq(academicSections.tenantId, tenantId),
              eq(academicSections.academicYearId, year.id),
              eq(academicSections.status, 'ACTIVE'),
            ),
          )
      : [];
    const houses = await this.db
      .select()
      .from(studentHouses)
      .where(and(eq(studentHouses.tenantId, tenantId), eq(studentHouses.isActive, true)));
    const houseByName = new Map(houses.map((h) => [h.name.toLowerCase(), h.id]));

    const given = raw.map((r) => r.admission_number?.toUpperCase()).filter((n): n is string => !!n);
    const takenNumbers = given.length
      ? new Set(
          (
            await this.db
              .select({ n: students.admissionNumber })
              .from(students)
              .where(and(eq(students.tenantId, tenantId), inArray(students.admissionNumber, given)))
          ).map((s) => s.n),
        )
      : new Set<string>();

    const seats = new Map<string, number>(); // section id -> seats still free (null capacity = absent)
    const rows: StudentImportRow[] = [];
    const inputs: Parsed[] = [];
    const seenNumbers = new Map<string, number>();
    const seenPeople = new Map<string, number>();

    for (const r of raw) {
      const rowNo = Number(r.__row);
      const errors: string[] = [];
      const name = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || '(no name)';
      let placement: string | null = null;

      const candidate: Record<string, unknown> = {};
      const direct = [
        'first_name',
        'middle_name',
        'last_name',
        'admission_number',
        'gender',
        'date_of_birth',
        'blood_group',
        'nationality',
        'category',
        'previous_school',
        'admission_date',
        'admission_type',
      ];
      for (const k of direct) {
        const v = r[k];
        if (!v) continue;
        candidate[k] = ENUM_FIELDS.includes(k) ? v.toUpperCase().replace(/[\s-]+/g, '_') : v;
      }
      if (r.blood_group) candidate.blood_group = r.blood_group.toUpperCase().replace(/\s+/g, '');
      if (r.email) candidate.primary_email = r.email;
      if (r.phone) candidate.primary_phone = r.phone;
      if (r.address_line1 || r.address_city || r.address_postal_code)
        candidate.address = {
          line1: r.address_line1 || null,
          city: r.address_city || null,
          postal_code: r.address_postal_code || null,
        };
      if (mode === 'AUTO') delete candidate.admission_number;

      if (r.house) {
        const hid = houseByName.get(r.house.toLowerCase());
        if (!hid) errors.push(`house: "${r.house}" is not one of the school's houses`);
        else candidate.house_id = hid;
      }

      // Parents / guardian.
      const last = r.last_name || 'Unknown';
      const links: Record<string, unknown>[] = [];
      const addParent = (who: 'father' | 'mother' | 'guardian', relation: string | null) => {
        const nm = r[`${who}_name`];
        const phone = r[`${who}_phone`];
        const email = r[`${who}_email`];
        if (!nm) {
          if (phone || email)
            errors.push(`${who}_name: needed when a ${who} phone or email is given`);
          return;
        }
        links.push({
          guardian: {
            ...splitName(nm, last),
            phone: phone || null,
            email: email || null,
          },
          relationship_type: relation,
          is_primary: links.length === 0,
        });
      };
      addParent('father', 'FATHER');
      addParent('mother', 'MOTHER');
      if (r.guardian_name && !r.guardian_relation)
        errors.push('guardian_relation: needed when a guardian is given');
      addParent(
        'guardian',
        r.guardian_relation ? r.guardian_relation.toUpperCase().replace(/[\s-]+/g, '_') : null,
      );
      if (links.length) candidate.guardians = links;

      // Placement.
      if (r.section_code && !r.class_code)
        errors.push('class_code: needed when a section is given');
      if (r.class_code) {
        const cls = classByCode.get(r.class_code.toUpperCase());
        if (!year) errors.push('There is no active academic year, so students cannot be placed');
        else if (!cls) errors.push(`class_code: "${r.class_code}" not found`);
        else {
          const enrol: Record<string, unknown> = {
            academic_year_id: year.id,
            class_id: cls.id,
          };
          placement = cls.name;
          if (r.section_code) {
            const sec = sections.find(
              (s) => s.classId === cls.id && s.code.toUpperCase() === r.section_code!.toUpperCase(),
            );
            if (!sec)
              errors.push(`section_code: "${r.section_code}" not found for ${cls.code} this year`);
            else {
              enrol.section_id = sec.id;
              placement = `${cls.name} · ${sec.name}`;
              if (sec.capacity !== null) {
                if (!seats.has(sec.id))
                  seats.set(
                    sec.id,
                    sec.capacity - (await this.academic.seatsTaken(tenantId, sec.id, this.db)),
                  );
                const free = seats.get(sec.id)!;
                if (free <= 0) errors.push(`${sec.name} is full`);
                else seats.set(sec.id, free - 1);
              }
            }
          }
          candidate.enrollment = enrol;
        }
      }

      const parsed = CreateStudentBody.safeParse(candidate);
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          errors.push(`${issue.path.join('.') || 'row'}: ${issue.message}`);

      if (parsed.success) {
        const input = parsed.data;
        if (mode === 'MANUAL') {
          if (!input.admission_number) errors.push('admission_number: required for this school');
          else {
            if (takenNumbers.has(input.admission_number))
              errors.push(`admission_number: ${input.admission_number} is already in use`);
            const prev = seenNumbers.get(input.admission_number);
            if (prev) errors.push(`admission_number: also used on row ${prev}`);
            else seenNumbers.set(input.admission_number, rowNo);
          }
        }
        if (input.date_of_birth) {
          const key = `${input.first_name.toLowerCase()}|${input.last_name.toLowerCase()}|${input.date_of_birth}`;
          const prev = seenPeople.get(key);
          if (prev !== undefined && !opts.allowDuplicates)
            errors.push(`Looks like the same student as row ${prev}`);
          else seenPeople.set(key, rowNo);
        }
        if (!opts.allowDuplicates) {
          const dups = await this.studentSvc.findDuplicates(this.db, tenantId, {
            firstName: input.first_name,
            lastName: input.last_name,
            dateOfBirth: input.date_of_birth,
            phone: input.primary_phone,
            email: input.primary_email,
          });
          if (dups.length)
            errors.push(
              `Possible duplicate of ${dups[0]!.full_name} (${dups[0]!.student_number}) — matched on ${dups[0]!.matched_on.join(', ')}`,
            );
        }
        if (!errors.length) inputs.push({ ...input, confirm_duplicate: true });
      }
      rows.push({ row: rowNo, name, status: errors.length ? 'ERROR' : 'OK', errors, placement });
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
      const cache = new Map<string, string>();
      for (const input of inputs) {
        const links = [];
        for (const l of input.guardians ?? []) {
          if (!l.guardian) {
            links.push(l);
            continue;
          }
          const g = l.guardian;
          const key = (g.phone ?? g.email ?? `${g.first_name} ${g.last_name}`).toLowerCase();
          let gid = cache.get(key);
          if (!gid && (g.phone || g.email)) {
            const [found] = await tx
              .select({ id: guardians.id })
              .from(guardians)
              .where(
                and(
                  eq(guardians.tenantId, tenantId),
                  eq(guardians.status, 'ACTIVE'),
                  sql`lower(${guardians.firstName}) = lower(${g.first_name})`,
                  g.phone ? eq(guardians.phone, g.phone) : eq(guardians.email, g.email!),
                ),
              )
              .limit(1);
            gid = found?.id;
          }
          if (!gid) gid = (await this.guardianSvc.createInTx(tx, tenantId, g, actor)).id;
          cache.set(key, gid);
          links.push({
            guardian_id: gid,
            relationship_type: l.relationship_type,
            is_primary: l.is_primary,
          });
        }
        await this.studentSvc.createInTx(tx, tenantId, { ...input, guardians: links }, actor);
      }
      await recordChange(tx, actor, tenantId, {
        action: 'STUDENTS_IMPORTED',
        entityType: 'student_import',
        entityId: uuidv7(),
        after: { created: inputs.length },
      });
    });
    return { ...summary, created: inputs.length };
  }
}
