import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Deps } from '../../container.js';
import { studentExits } from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { BusinessRuleError, NotFoundError } from '../../shared/errors.js';
import { DOCUMENT_TYPES } from '../files/file-validation.js';
import type { FileService, PreparedFile } from '../files/files.service.js';
import { addHistory, loadStudent } from './support.js';

type ExitRow = typeof studentExits.$inferSelect;

const DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;

function present(e: ExitRow) {
  return {
    id: e.id,
    kind: e.kind,
    exit_date: e.exitDate,
    reason: e.reason,
    remarks: e.remarks,
    destination_school: e.destinationSchool,
    has_document: Boolean(e.documentFileId),
    document_name: e.documentName,
    reinstated_at: e.reinstatedAt ? e.reinstatedAt.toISOString() : null,
    recorded_at: e.createdAt.toISOString(),
  };
}

/** Read the exit record of a student and attach a supporting document to it. */
export class StudentExitService {
  constructor(
    private readonly deps: Deps,
    private readonly fileSvc: FileService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  /** The latest exit, plus earlier ones (a student can leave, return and leave again). */
  async get(tenantId: string, studentId: string, principal: Principal) {
    await loadStudent(this.db, tenantId, studentId, principal, 'students.read');
    const rows = await this.db
      .select()
      .from(studentExits)
      .where(and(eq(studentExits.tenantId, tenantId), eq(studentExits.studentId, studentId)))
      .orderBy(desc(studentExits.createdAt));
    return {
      current: rows.find((r) => !r.reinstatedAt)
        ? present(rows.find((r) => !r.reinstatedAt)!)
        : null,
      all: rows.map(present),
    };
  }

  /** Attaches a file to the open exit. Replaces an earlier attachment. */
  async attachDocument(
    tenantId: string,
    studentId: string,
    principal: Principal,
    actor: Actor,
    input: { data: unknown; filename?: string },
  ) {
    const file: PreparedFile = await this.fileSvc.prepare(tenantId, input.data, {
      allowed: DOCUMENT_TYPES,
      maxBytes: DOCUMENT_MAX_BYTES,
      label: 'Document',
      filename: input.filename,
    });
    try {
      return await this.db.transaction(async (tx) => {
        await loadStudent(tx, tenantId, studentId, principal, 'students.archive', { lock: true });
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
          .limit(1)
          .for('update');
        if (!exit) {
          throw new BusinessRuleError(
            'INVALID_STATE',
            'This student has no withdrawal or transfer on record.',
          );
        }
        await this.fileSvc.insert(tx, tenantId, 'STUDENT_DOCUMENT', file, actor);
        await this.fileSvc.supersede(tx, tenantId, exit.documentFileId);
        await tx
          .update(studentExits)
          .set({ documentFileId: file.id, documentName: file.name })
          .where(and(eq(studentExits.id, exit.id), eq(studentExits.tenantId, tenantId)));
        await addHistory(tx, actor, tenantId, studentId, {
          eventType: 'STUDENT_EXIT_DOCUMENT_ADDED',
          details: { file_name: file.name, kind: exit.kind },
        });
        await recordChange(tx, actor, tenantId, {
          action: 'STUDENT_EXIT_DOCUMENT_ADDED',
          entityType: 'student',
          entityId: studentId,
          after: { exit_id: exit.id, file_id: file.id },
        });
        return { id: exit.id, document_name: file.name };
      });
    } catch (err) {
      await this.fileSvc.discard(file);
      throw err;
    }
  }

  async readDocument(tenantId: string, studentId: string, principal: Principal, exitId?: string) {
    await loadStudent(this.db, tenantId, studentId, principal, 'students.read');
    const rows = await this.db
      .select()
      .from(studentExits)
      .where(and(eq(studentExits.tenantId, tenantId), eq(studentExits.studentId, studentId)))
      .orderBy(desc(studentExits.createdAt));
    const exit = exitId ? rows.find((r) => r.id === exitId) : rows.find((r) => r.documentFileId);
    if (!exit?.documentFileId) throw new NotFoundError('Exit document');
    return this.fileSvc.read(tenantId, exit.documentFileId);
  }
}
