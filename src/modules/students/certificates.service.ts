import { and, asc, desc, eq, isNull, max } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  enrollments,
  guardians,
  issuedDocuments,
  studentDocumentTemplates,
  studentExits,
  studentGuardians,
  STUDENT_DOCUMENT_KIND,
  type StudentDocumentKind,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { todayIso } from '../../shared/dates.js';
import {
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import { DOCUMENT_TYPES } from '../files/file-validation.js';
import type { FileService, PreparedFile } from '../files/files.service.js';
import type { SchoolSetupService } from '../tenants/school-setup.service.js';
import {
  fillTemplate,
  PLACEHOLDERS,
  renderCertificate,
  renderIdCard,
  unknownPlaceholders,
  type PdfBranding,
} from './certificates.pdf.js';
import type {
  IssueDocumentBody,
  UpdateTemplateBody,
  VoidDocumentBody,
} from './certificates.schemas.js';
import { addHistory, fullName, loadStudent, nextNumber } from './support.js';

type DocRow = typeof issuedDocuments.$inferSelect;

const SERIAL_PREFIX: Record<StudentDocumentKind, 'BON' | 'TRC' | 'CHC' | 'IDC'> = {
  BONAFIDE: 'BON',
  TRANSFER_CERTIFICATE: 'TRC',
  CHARACTER_CERTIFICATE: 'CHC',
  ID_CARD: 'IDC',
};

const DEFAULTS: Record<StudentDocumentKind, { title: string; body: string }> = {
  BONAFIDE: {
    title: 'Bonafide certificate',
    body: 'This is to certify that {{student_name}} (Admission No. {{admission_number}}), child of {{parent_name}}, is a bonafide student of {{school_name}}, studying in {{class}} {{section}} during the academic year {{academic_year}}.\n\nAs per the school records, the date of birth of the student is {{date_of_birth}}.\n\nThis certificate is issued on request for whatever purpose it may serve.',
  },
  TRANSFER_CERTIFICATE: {
    title: 'Transfer certificate',
    body: 'This is to certify that {{student_name}} (Admission No. {{admission_number}}), child of {{parent_name}}, date of birth {{date_of_birth}}, was admitted to {{school_name}} on {{admission_date}}.\n\nThe student last studied in {{class}} {{section}} and left the school on {{exit_date}}. Reason for leaving: {{exit_reason}}. Transferred to: {{destination_school}}.\n\nAll dues to the school have been cleared up to the date of leaving unless stated otherwise by the office.',
  },
  CHARACTER_CERTIFICATE: {
    title: 'Character certificate',
    body: 'This is to certify that {{student_name}} (Admission No. {{admission_number}}), child of {{parent_name}}, has been a student of {{school_name}}, in {{class}} {{section}}, during the academic year {{academic_year}}.\n\nDuring this period the conduct and character of the student have been found satisfactory.\n\nWe wish the student every success.',
  },
  ID_CARD: {
    title: 'ID card (back)',
    body: 'This card is the property of {{school_name}}. If found, please return it to the school office.\n\nIssued: {{issue_date}}',
  },
};

const CHARACTER_STATUSES = ['ACTIVE', 'GRADUATED', 'TRANSFERRED', 'WITHDRAWN', 'ARCHIVED'];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
/** "2014-06-21" → "21 June 2014". */
export function longDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}

const cap = (s: string | null | undefined) =>
  s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : '';

function presentDoc(d: DocRow) {
  return {
    id: d.id,
    kind: d.kind,
    serial_number: d.serialNumber,
    template_version: d.templateVersion,
    is_duplicate: d.isDuplicate,
    remarks: d.remarks,
    issued_at: d.issuedAt.toISOString(),
    voided_at: d.voidedAt ? d.voidedAt.toISOString() : null,
    void_reason: d.voidReason,
  };
}

export class StudentCertificateService {
  constructor(
    private readonly deps: Deps,
    private readonly fileSvc: FileService,
    private readonly school: SchoolSetupService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  // ---- wording (templates) ---------------------------------------------------------------------

  /** A school's first visit seeds the standard wording. */
  private async ensureTemplates(tenantId: string) {
    const have = await this.db
      .select({ kind: studentDocumentTemplates.kind })
      .from(studentDocumentTemplates)
      .where(eq(studentDocumentTemplates.tenantId, tenantId));
    const present = new Set(have.map((r) => r.kind));
    for (const kind of STUDENT_DOCUMENT_KIND) {
      if (present.has(kind)) continue;
      try {
        await this.db.insert(studentDocumentTemplates).values({
          tenantId,
          kind,
          version: 1,
          title: DEFAULTS[kind].title,
          body: DEFAULTS[kind].body,
        });
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
    }
  }

  private async currentTemplate(ex: Executor, tenantId: string, kind: StudentDocumentKind) {
    const [t] = await ex
      .select()
      .from(studentDocumentTemplates)
      .where(
        and(
          eq(studentDocumentTemplates.tenantId, tenantId),
          eq(studentDocumentTemplates.kind, kind),
          eq(studentDocumentTemplates.isCurrent, true),
        ),
      );
    if (!t) throw new NotFoundError('Document wording');
    return t;
  }

  async listTemplates(tenantId: string) {
    await this.ensureTemplates(tenantId);
    const rows = await this.db
      .select()
      .from(studentDocumentTemplates)
      .where(
        and(
          eq(studentDocumentTemplates.tenantId, tenantId),
          eq(studentDocumentTemplates.isCurrent, true),
        ),
      )
      .orderBy(asc(studentDocumentTemplates.kind));
    return {
      placeholders: PLACEHOLDERS,
      templates: rows.map((t) => ({
        kind: t.kind,
        title: t.title,
        body: t.body,
        version: t.version,
        default_body: DEFAULTS[t.kind].body,
      })),
    };
  }

  async updateTemplate(
    tenantId: string,
    kind: StudentDocumentKind,
    input: z.infer<typeof UpdateTemplateBody>,
    actor: Actor,
  ) {
    const bad = unknownPlaceholders(input.body);
    if (bad.length)
      throw new ValidationError(`Unknown placeholders: ${bad.map((b) => `{{${b}}}`).join(', ')}`, {
        unknown: bad,
      });
    await this.ensureTemplates(tenantId);
    return this.db.transaction(async (tx) => {
      const current = await tx
        .select()
        .from(studentDocumentTemplates)
        .where(
          and(
            eq(studentDocumentTemplates.tenantId, tenantId),
            eq(studentDocumentTemplates.kind, kind),
            eq(studentDocumentTemplates.isCurrent, true),
          ),
        )
        .for('update');
      const [{ v } = { v: 0 }] = await tx
        .select({ v: max(studentDocumentTemplates.version) })
        .from(studentDocumentTemplates)
        .where(
          and(
            eq(studentDocumentTemplates.tenantId, tenantId),
            eq(studentDocumentTemplates.kind, kind),
          ),
        );
      const version = (v ?? 0) + 1;
      await tx
        .update(studentDocumentTemplates)
        .set({ isCurrent: false })
        .where(
          and(
            eq(studentDocumentTemplates.tenantId, tenantId),
            eq(studentDocumentTemplates.kind, kind),
          ),
        );
      await tx.insert(studentDocumentTemplates).values({
        tenantId,
        kind,
        version,
        title: input.title,
        body: input.body,
        createdBy: actor.userId,
      });
      await recordChange(tx, actor, tenantId, {
        action: 'STUDENT_DOCUMENT_TEMPLATE_UPDATED',
        entityType: 'student_document_template',
        entityId: `${tenantId}:${kind}`,
        before: current[0] ? { version: current[0].version, title: current[0].title } : null,
        after: { version, title: input.title },
      });
      return { kind, title: input.title, body: input.body, version };
    });
  }

  // ---- issuing ---------------------------------------------------------------------------------

  async list(tenantId: string, studentId: string, principal: Principal) {
    await loadStudent(this.db, tenantId, studentId, principal, 'students.certificates.read');
    const rows = await this.db
      .select()
      .from(issuedDocuments)
      .where(and(eq(issuedDocuments.tenantId, tenantId), eq(issuedDocuments.studentId, studentId)))
      .orderBy(desc(issuedDocuments.issuedAt));
    return rows.map(presentDoc);
  }

  async download(tenantId: string, studentId: string, docId: string, principal: Principal) {
    await loadStudent(this.db, tenantId, studentId, principal, 'students.certificates.read');
    const [d] = await this.db
      .select()
      .from(issuedDocuments)
      .where(
        and(
          eq(issuedDocuments.id, docId),
          eq(issuedDocuments.tenantId, tenantId),
          eq(issuedDocuments.studentId, studentId),
        ),
      );
    if (!d) throw new NotFoundError('Document');
    const f = await this.fileSvc.read(tenantId, d.fileId);
    return { ...f, name: `${d.serialNumber}.pdf` };
  }

  async issue(
    tenantId: string,
    studentId: string,
    input: z.infer<typeof IssueDocumentBody>,
    principal: Principal,
    actor: Actor,
  ) {
    await this.ensureTemplates(tenantId);
    let prepared: PreparedFile | null = null;
    try {
      return await this.db.transaction(async (tx) => {
        const student = await loadStudent(
          tx,
          tenantId,
          studentId,
          principal,
          'students.certificates.issue',
          { lock: true },
        );
        const kind = input.kind;
        const [exit] = await tx
          .select()
          .from(studentExits)
          .where(
            and(
              eq(studentExits.tenantId, tenantId),
              eq(studentExits.studentId, studentId),
              isNull(studentExits.reinstatedAt),
            ),
          )
          .orderBy(desc(studentExits.createdAt))
          .limit(1);

        if (kind === 'TRANSFER_CERTIFICATE') {
          if (!exit || !['TRANSFERRED', 'WITHDRAWN', 'ARCHIVED'].includes(student.status))
            throw new BusinessRuleError(
              'OPERATION_NOT_ALLOWED',
              'A transfer certificate can only be issued to a student who has been transferred or withdrawn.',
            );
        } else if (kind === 'CHARACTER_CERTIFICATE') {
          if (!CHARACTER_STATUSES.includes(student.status))
            throw new BusinessRuleError(
              'OPERATION_NOT_ALLOWED',
              'This student is not yet admitted, so a character certificate cannot be issued.',
            );
        } else if (student.status !== 'ACTIVE') {
          throw new BusinessRuleError(
            'OPERATION_NOT_ALLOWED',
            kind === 'ID_CARD'
              ? 'ID cards are only issued to active students.'
              : 'A bonafide certificate is only issued to an active student.',
          );
        }

        const [existing] = await tx
          .select()
          .from(issuedDocuments)
          .where(
            and(
              eq(issuedDocuments.tenantId, tenantId),
              eq(issuedDocuments.studentId, studentId),
              eq(issuedDocuments.kind, kind),
              isNull(issuedDocuments.voidedAt),
            ),
          )
          .limit(1);
        if (existing && !input.confirm_duplicate)
          throw new ConflictError(
            'DUPLICATE_RESOURCE',
            'This student already has a valid document of this kind. Issue again only if a copy is needed.',
            { serial_number: existing.serialNumber },
          );

        const now = this.deps.clock.now();
        const serial = await nextNumber(tx, tenantId, SERIAL_PREFIX[kind], now);
        const template = await this.currentTemplate(tx, tenantId, kind);
        const branding = await this.brandingFor(tenantId);

        // ---- the values printed ----
        const [place] = await tx
          .select({
            className: academicClasses.name,
            sectionName: academicSections.name,
            yearName: academicYears.name,
            yearEnd: academicYears.endDate,
          })
          .from(enrollments)
          .innerJoin(academicClasses, eq(academicClasses.id, enrollments.classId))
          .innerJoin(academicYears, eq(academicYears.id, enrollments.academicYearId))
          .leftJoin(academicSections, eq(academicSections.id, enrollments.sectionId))
          .where(and(eq(enrollments.tenantId, tenantId), eq(enrollments.studentId, studentId)))
          .orderBy(desc(enrollments.startDate), desc(enrollments.createdAt))
          .limit(1);
        const links = await tx
          .select({
            rel: studentGuardians.relationshipType,
            primary: studentGuardians.isPrimary,
            first: guardians.firstName,
            last: guardians.lastName,
            phone: guardians.phone,
          })
          .from(studentGuardians)
          .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
          .where(
            and(
              eq(studentGuardians.tenantId, tenantId),
              eq(studentGuardians.studentId, studentId),
              eq(studentGuardians.status, 'ACTIVE'),
            ),
          );
        const nameOf = (g?: { first: string; last: string }) =>
          g ? `${g.first} ${g.last}`.trim() : '';
        const father = links.find((l) => l.rel === 'FATHER');
        const mother = links.find((l) => l.rel === 'MOTHER');
        const parent = links.find((l) => l.primary) ?? father ?? mother ?? links[0];
        const issueDate = longDate(todayIso(this.deps.clock));
        const values: Record<string, string> = {
          school_name: branding.school_name,
          school_address: branding.address,
          school_phone: branding.phone,
          school_email: branding.email,
          student_name: fullName(student),
          student_number: student.studentNumber,
          admission_number: student.admissionNumber ?? '',
          date_of_birth: longDate(student.dateOfBirth),
          gender: cap(student.gender),
          parent_name: nameOf(parent),
          father_name: nameOf(father),
          mother_name: nameOf(mother),
          class: place?.className ?? '',
          section: place?.sectionName ?? '',
          academic_year: place?.yearName ?? '',
          admission_date: longDate(student.admissionDate),
          exit_date: longDate(exit?.exitDate),
          exit_reason: exit?.reason ?? '',
          destination_school: exit?.destinationSchool ?? '—',
          issue_date: issueDate,
          serial_number: serial,
        };

        let pdf: Buffer;
        if (kind === 'ID_CARD') {
          const photo = student.photoFileId
            ? await this.fileSvc.read(tenantId, student.photoFileId).catch(() => null)
            : null;
          pdf = await renderIdCard({
            branding: branding.pdf,
            name: values.student_name!,
            lines: [
              ['Class', [values.class, values.section].filter(Boolean).join(' · ')],
              ['Adm. no.', values.admission_number!],
              ['DOB', values.date_of_birth!],
              ['Blood group', student.bloodGroup ?? ''],
              ['Parent', parent?.phone ?? ''],
            ],
            photo: photo ? { bytes: photo.data, mime: photo.mime } : null,
            back: fillTemplate(template.body, values),
            serial,
            validUntil: place?.yearEnd ? longDate(place.yearEnd) : null,
          });
        } else {
          pdf = await renderCertificate({
            title: template.title,
            text: fillTemplate(template.body, values),
            branding: branding.pdf,
            serial,
            issueDate,
            duplicate: Boolean(existing),
          });
        }

        prepared = await this.fileSvc.prepare(tenantId, pdf, {
          allowed: DOCUMENT_TYPES,
          maxBytes: 5 * 1024 * 1024,
          label: 'Certificate',
          filename: `${serial}.pdf`,
        });
        await this.fileSvc.insert(tx, tenantId, 'STUDENT_CERTIFICATE', prepared, actor);
        const [ins] = await tx
          .insert(issuedDocuments)
          .values({
            tenantId,
            studentId,
            kind,
            serialNumber: serial,
            templateId: template.id,
            templateVersion: template.version,
            snapshot: values,
            fileId: prepared.id,
            isDuplicate: Boolean(existing),
            remarks: input.remarks ?? null,
            issuedBy: actor.userId,
            issuedAt: now,
          })
          .$returningId();
        await addHistory(tx, actor, tenantId, studentId, {
          eventType: 'STUDENT_DOCUMENT_ISSUED',
          details: { kind, serial_number: serial, is_duplicate: Boolean(existing) },
        });
        await recordChange(tx, actor, tenantId, {
          action: 'STUDENT_DOCUMENT_ISSUED',
          entityType: 'student',
          entityId: studentId,
          after: { document_id: ins!.id, kind, serial_number: serial },
        });
        const [row] = await tx
          .select()
          .from(issuedDocuments)
          .where(eq(issuedDocuments.id, ins!.id));
        return presentDoc(row!);
      });
    } catch (err) {
      if (prepared) await this.fileSvc.discard(prepared);
      throw err;
    }
  }

  async void(
    tenantId: string,
    studentId: string,
    docId: string,
    input: z.infer<typeof VoidDocumentBody>,
    principal: Principal,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      await loadStudent(tx, tenantId, studentId, principal, 'students.certificates.void', {
        lock: true,
      });
      const [d] = await tx
        .select()
        .from(issuedDocuments)
        .where(
          and(
            eq(issuedDocuments.id, docId),
            eq(issuedDocuments.tenantId, tenantId),
            eq(issuedDocuments.studentId, studentId),
          ),
        )
        .for('update');
      if (!d) throw new NotFoundError('Document');
      if (d.voidedAt)
        throw new BusinessRuleError('INVALID_STATE', 'This document is already void.');
      const now = this.deps.clock.now();
      await tx
        .update(issuedDocuments)
        .set({ voidedAt: now, voidedBy: actor.userId, voidReason: input.reason })
        .where(and(eq(issuedDocuments.id, docId), eq(issuedDocuments.tenantId, tenantId)));
      await addHistory(tx, actor, tenantId, studentId, {
        eventType: 'STUDENT_DOCUMENT_VOIDED',
        reason: input.reason,
        details: { kind: d.kind, serial_number: d.serialNumber },
      });
      await recordChange(tx, actor, tenantId, {
        action: 'STUDENT_DOCUMENT_VOIDED',
        entityType: 'student',
        entityId: studentId,
        reason: input.reason,
        before: { document_id: d.id, serial_number: d.serialNumber, voided: false },
        after: { document_id: d.id, serial_number: d.serialNumber, voided: true },
      });
      const [row] = await tx.select().from(issuedDocuments).where(eq(issuedDocuments.id, docId));
      return presentDoc(row!);
    });
  }

  /** School name, address, contact, logo and colour for the printed page. */
  private async brandingFor(tenantId: string) {
    const b = await this.school.documentBranding(tenantId);
    const address = [
      b.address.line1,
      b.address.line2,
      b.address.city,
      b.address.state,
      b.address.postal_code,
      b.address.country,
    ]
      .filter(Boolean)
      .join(', ');
    let logo: PdfBranding['logo'] = null;
    if (b.logo_file_id) {
      const f = await this.fileSvc.read(tenantId, b.logo_file_id).catch(() => null);
      if (f) logo = { bytes: f.data, mime: f.mime };
    }
    return {
      school_name: b.school_name,
      address,
      phone: b.phone ?? '',
      email: b.email ?? '',
      pdf: {
        school_name: b.school_name,
        address,
        contact: [b.phone, b.email].filter(Boolean).join(' · '),
        footer_text: b.footer_text,
        primary_color: b.primary_color,
        logo,
      } satisfies PdfBranding,
    };
  }
}
