import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import { files, studentDocuments, studentDocumentTypes, students } from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { addDays } from '../../shared/time.js';
import { todayIso } from '../../shared/dates.js';
import {
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import { DOCUMENT_TYPES, IMAGE_TYPES } from '../files/file-validation.js';
import type { FileService, PreparedFile } from '../files/files.service.js';
import type { CreateDocTypeBody, UpdateDocTypeBody } from './documents.schemas.js';
import { addHistory, loadStudent } from './support.js';

type TypeRow = typeof studentDocumentTypes.$inferSelect;

const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const EXPIRING_DAYS = 30;

const DEFAULT_TYPES = [
  { code: 'BIRTH_CERTIFICATE', name: 'Birth certificate', isRequired: true, sortOrder: 1 },
  { code: 'PREVIOUS_SCHOOL_CERT', name: 'Previous school certificate', sortOrder: 2 },
  { code: 'ADDRESS_PROOF', name: 'Address proof', isRequired: true, sortOrder: 3 },
  { code: 'PHOTOGRAPH', name: 'Photograph', sortOrder: 4 },
  { code: 'MEDICAL_CERT', name: 'Medical certificate', hasExpiry: true, sortOrder: 5 },
  { code: 'OTHER', name: 'Other', allowMultiple: true, sortOrder: 99 },
];

function presentType(t: TypeRow) {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    is_required: t.isRequired,
    has_expiry: t.hasExpiry,
    allow_multiple: t.allowMultiple,
    is_active: t.isActive,
    sort_order: t.sortOrder,
  };
}

export class StudentDocumentService {
  constructor(
    private readonly deps: Deps,
    private readonly fileSvc: FileService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  // ---- Document types (configurable per school) -----------------------------------------------

  /** A school's first visit seeds the standard types, so existing schools need no data migration. */
  private async ensureDefaults(tenantId: string) {
    const existing = await this.db
      .select({ id: studentDocumentTypes.id })
      .from(studentDocumentTypes)
      .where(eq(studentDocumentTypes.tenantId, tenantId))
      .limit(1);
    if (existing.length) return;
    await this.db
      .insert(studentDocumentTypes)
      .values(DEFAULT_TYPES.map((t) => ({ tenantId, ...t })))
      .onDuplicateKeyUpdate({ set: { code: sql`${studentDocumentTypes.code}` } });
  }

  private async types(tenantId: string, includeInactive: boolean) {
    await this.ensureDefaults(tenantId);
    return this.db
      .select()
      .from(studentDocumentTypes)
      .where(
        and(
          eq(studentDocumentTypes.tenantId, tenantId),
          includeInactive ? undefined : eq(studentDocumentTypes.isActive, true),
        ),
      )
      .orderBy(asc(studentDocumentTypes.sortOrder), asc(studentDocumentTypes.name));
  }

  async listTypes(tenantId: string, includeInactive = false) {
    return (await this.types(tenantId, includeInactive)).map(presentType);
  }

  async createType(tenantId: string, input: z.infer<typeof CreateDocTypeBody>, actor: Actor) {
    await this.ensureDefaults(tenantId);
    try {
      return await this.db.transaction(async (tx) => {
        const [ins] = await tx
          .insert(studentDocumentTypes)
          .values({
            tenantId,
            code: input.code,
            name: input.name,
            isRequired: input.is_required,
            hasExpiry: input.has_expiry,
            allowMultiple: input.allow_multiple,
            sortOrder: input.sort_order,
          })
          .$returningId();
        const [row] = await tx
          .select()
          .from(studentDocumentTypes)
          .where(eq(studentDocumentTypes.id, ins!.id));
        await recordChange(tx, actor, tenantId, {
          action: 'STUDENT_DOCUMENT_TYPE_CREATED',
          entityType: 'student_document_type',
          entityId: row!.id,
          after: presentType(row!),
        });
        return presentType(row!);
      });
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw new ConflictError('DUPLICATE_RESOURCE', 'A document type with this code exists', {
          field: 'code',
        });
      throw err;
    }
  }

  async updateType(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateDocTypeBody>,
    actor: Actor,
  ) {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(studentDocumentTypes)
        .where(and(eq(studentDocumentTypes.id, id), eq(studentDocumentTypes.tenantId, tenantId)))
        .for('update');
      if (!before) throw new NotFoundError('Document type');
      await tx
        .update(studentDocumentTypes)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.is_required !== undefined ? { isRequired: input.is_required } : {}),
          ...(input.has_expiry !== undefined ? { hasExpiry: input.has_expiry } : {}),
          ...(input.allow_multiple !== undefined ? { allowMultiple: input.allow_multiple } : {}),
          ...(input.is_active !== undefined ? { isActive: input.is_active } : {}),
          ...(input.sort_order !== undefined ? { sortOrder: input.sort_order } : {}),
        })
        .where(eq(studentDocumentTypes.id, id));
      const [after] = await tx
        .select()
        .from(studentDocumentTypes)
        .where(eq(studentDocumentTypes.id, id));
      await recordChange(tx, actor, tenantId, {
        action: 'STUDENT_DOCUMENT_TYPE_UPDATED',
        entityType: 'student_document_type',
        entityId: id,
        before: presentType(before),
        after: presentType(after!),
      });
      return presentType(after!);
    });
  }

  // ---- A student's documents -----------------------------------------------------------------

  /** Required types with what is on file; a type is MISSING, UPLOADED, EXPIRING or EXPIRED. */
  async list(tenantId: string, studentId: string, principal: Principal) {
    const student = await loadStudent(
      this.db,
      tenantId,
      studentId,
      principal,
      'students.documents.read',
    );
    const types = await this.types(tenantId, false);
    const docs = await this.db
      .select()
      .from(studentDocuments)
      .where(
        and(
          eq(studentDocuments.tenantId, tenantId),
          eq(studentDocuments.studentId, studentId),
          isNull(studentDocuments.replacedAt),
        ),
      )
      .orderBy(asc(studentDocuments.createdAt));
    const fileRows = docs.length
      ? await this.db
          .select()
          .from(files)
          .where(
            and(
              eq(files.tenantId, tenantId),
              inArray(
                files.id,
                docs.map((d) => d.fileId),
              ),
            ),
          )
      : [];
    const fileById = new Map(fileRows.map((f) => [f.id, f]));
    const today = todayIso(this.deps.clock);
    const soon = addDays(this.deps.clock.now(), EXPIRING_DAYS).toISOString().slice(0, 10);
    const stateOf = (expiresOn: string | null) =>
      !expiresOn
        ? 'UPLOADED'
        : expiresOn < today
          ? 'EXPIRED'
          : expiresOn <= soon
            ? 'EXPIRING'
            : 'UPLOADED';

    const grouped = types.map((t) => {
      const mine = docs
        .filter((d) => d.typeId === t.id)
        .map((d) => {
          const f = fileById.get(d.fileId);
          return {
            id: d.id,
            file_name: f?.originalName ?? 'file',
            mime_type: f?.mimeType ?? null,
            size_bytes: f?.sizeBytes ?? 0,
            expires_on: d.expiresOn,
            state: stateOf(d.expiresOn),
            notes: d.notes,
            uploaded_at: d.createdAt.toISOString(),
          };
        });
      const worst = mine.find((m) => m.state === 'EXPIRED')
        ? 'EXPIRED'
        : mine.find((m) => m.state === 'EXPIRING')
          ? 'EXPIRING'
          : mine.length
            ? 'UPLOADED'
            : 'MISSING';
      return { ...presentType(t), status: worst, documents: mine };
    });
    return {
      photo_file_id: student.photoFileId,
      types: grouped,
      missing_required: grouped
        .filter((t) => t.is_required && t.status === 'MISSING')
        .map((t) => t.name),
    };
  }

  async upload(
    tenantId: string,
    studentId: string,
    principal: Principal,
    actor: Actor,
    input: {
      data: unknown;
      typeCode: string;
      filename?: string;
      expiresOn?: string;
      notes?: string | null;
    },
  ) {
    const file = await this.fileSvc.prepare(tenantId, input.data, {
      allowed: DOCUMENT_TYPES,
      maxBytes: DOCUMENT_MAX_BYTES,
      label: 'Document',
      filename: input.filename,
    });
    try {
      return await this.db.transaction(async (tx) => {
        const student = await loadStudent(
          tx,
          tenantId,
          studentId,
          principal,
          'students.documents.manage',
          {
            lock: true,
          },
        );
        await this.ensureDefaults(tenantId);
        const [type] = await tx
          .select()
          .from(studentDocumentTypes)
          .where(
            and(
              eq(studentDocumentTypes.tenantId, tenantId),
              eq(studentDocumentTypes.code, input.typeCode),
              eq(studentDocumentTypes.isActive, true),
            ),
          );
        if (!type) throw new NotFoundError('Document type');
        if (input.expiresOn && !type.hasExpiry)
          throw new ValidationError(`${type.name} does not have an expiry date`, {
            issues: [{ path: 'expires_on', message: 'This document type has no expiry date' }],
          });
        let replaced = false;
        if (!type.allowMultiple) {
          const current = await tx
            .select()
            .from(studentDocuments)
            .where(
              and(
                eq(studentDocuments.tenantId, tenantId),
                eq(studentDocuments.studentId, studentId),
                eq(studentDocuments.typeId, type.id),
                isNull(studentDocuments.replacedAt),
              ),
            );
          for (const c of current) {
            replaced = true;
            await tx
              .update(studentDocuments)
              .set({ replacedAt: this.deps.clock.now() })
              .where(eq(studentDocuments.id, c.id));
            await this.fileSvc.supersede(tx, tenantId, c.fileId);
          }
        }
        await this.fileSvc.insert(tx, tenantId, 'STUDENT_DOCUMENT', file, actor);
        const [ins] = await tx
          .insert(studentDocuments)
          .values({
            tenantId,
            studentId,
            typeId: type.id,
            fileId: file.id,
            expiresOn: input.expiresOn ?? null,
            notes: input.notes ?? null,
            uploadedBy: actor.userId,
          })
          .$returningId();
        const event = replaced ? 'REPLACED' : 'ADDED';
        await addHistory(tx, actor, tenantId, student.id, {
          eventType: `STUDENT_DOCUMENT_${event}`,
          details: { type: type.code, type_name: type.name, file_name: file.name },
        });
        await recordChange(tx, actor, tenantId, {
          action: `STUDENT_DOCUMENT_${event}`,
          entityType: 'student_document',
          entityId: ins!.id,
          after: {
            student_id: studentId,
            type: type.code,
            file_name: file.name,
            size_bytes: file.size,
          },
        });
        return { id: ins!.id, type: type.code, file_name: file.name, replaced };
      });
    } catch (err) {
      await this.fileSvc.discard(file);
      throw err;
    }
  }

  async remove(
    tenantId: string,
    studentId: string,
    docId: string,
    principal: Principal,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const student = await loadStudent(
        tx,
        tenantId,
        studentId,
        principal,
        'students.documents.manage',
        {
          lock: true,
        },
      );
      const [doc] = await tx
        .select()
        .from(studentDocuments)
        .where(
          and(
            eq(studentDocuments.id, docId),
            eq(studentDocuments.tenantId, tenantId),
            eq(studentDocuments.studentId, studentId),
            isNull(studentDocuments.replacedAt),
          ),
        );
      if (!doc) throw new NotFoundError('Document');
      const [type] = await tx
        .select()
        .from(studentDocumentTypes)
        .where(eq(studentDocumentTypes.id, doc.typeId));
      await tx
        .update(studentDocuments)
        .set({ replacedAt: this.deps.clock.now() })
        .where(eq(studentDocuments.id, docId));
      await this.fileSvc.supersede(tx, tenantId, doc.fileId);
      await addHistory(tx, actor, tenantId, student.id, {
        eventType: 'STUDENT_DOCUMENT_REMOVED',
        details: { type: type?.code ?? null, type_name: type?.name ?? null },
      });
      await recordChange(tx, actor, tenantId, {
        action: 'STUDENT_DOCUMENT_REMOVED',
        entityType: 'student_document',
        entityId: docId,
        before: { student_id: studentId, type: type?.code ?? null },
      });
    });
  }

  async download(tenantId: string, studentId: string, docId: string, principal: Principal) {
    await loadStudent(this.db, tenantId, studentId, principal, 'students.documents.read');
    const [doc] = await this.db
      .select()
      .from(studentDocuments)
      .where(
        and(
          eq(studentDocuments.id, docId),
          eq(studentDocuments.tenantId, tenantId),
          eq(studentDocuments.studentId, studentId),
        ),
      );
    if (!doc) throw new NotFoundError('Document');
    return this.fileSvc.read(tenantId, doc.fileId);
  }

  // ---- Photo -------------------------------------------------------------------------------------

  async setPhoto(
    tenantId: string,
    studentId: string,
    principal: Principal,
    actor: Actor,
    input: { data: unknown; filename?: string },
  ) {
    const file: PreparedFile = await this.fileSvc.prepare(tenantId, input.data, {
      allowed: IMAGE_TYPES,
      maxBytes: PHOTO_MAX_BYTES,
      label: 'Photo',
      filename: input.filename,
    });
    try {
      return await this.db.transaction(async (tx) => {
        const student = await loadStudent(tx, tenantId, studentId, principal, 'students.update', {
          lock: true,
        });
        await this.fileSvc.insert(tx, tenantId, 'STUDENT_PHOTO', file, actor);
        await this.fileSvc.supersede(tx, tenantId, student.photoFileId);
        await tx
          .update(students)
          .set({ photoFileId: file.id })
          .where(and(eq(students.id, studentId), eq(students.tenantId, tenantId)));
        await addHistory(tx, actor, tenantId, studentId, {
          eventType: 'STUDENT_PHOTO_CHANGED',
          details: { file_name: file.name },
        });
        await recordChange(tx, actor, tenantId, {
          action: 'STUDENT_PHOTO_CHANGED',
          entityType: 'student',
          entityId: studentId,
          before: { photo_file_id: student.photoFileId },
          after: { photo_file_id: file.id },
        });
        return { photo_file_id: file.id };
      });
    } catch (err) {
      await this.fileSvc.discard(file);
      throw err;
    }
  }

  async removePhoto(tenantId: string, studentId: string, principal: Principal, actor: Actor) {
    await this.db.transaction(async (tx) => {
      const student = await loadStudent(tx, tenantId, studentId, principal, 'students.update', {
        lock: true,
      });
      if (!student.photoFileId) return;
      await this.fileSvc.supersede(tx, tenantId, student.photoFileId);
      await tx
        .update(students)
        .set({ photoFileId: null })
        .where(and(eq(students.id, studentId), eq(students.tenantId, tenantId)));
      await addHistory(tx, actor, tenantId, studentId, { eventType: 'STUDENT_PHOTO_REMOVED' });
      await recordChange(tx, actor, tenantId, {
        action: 'STUDENT_PHOTO_REMOVED',
        entityType: 'student',
        entityId: studentId,
        before: { photo_file_id: student.photoFileId },
        after: { photo_file_id: null },
      });
    });
  }

  async readPhoto(tenantId: string, studentId: string, principal: Principal) {
    const student = await loadStudent(this.db, tenantId, studentId, principal, 'students.read');
    if (!student.photoFileId) throw new NotFoundError('Photo');
    return this.fileSvc.read(tenantId, student.photoFileId);
  }
}
