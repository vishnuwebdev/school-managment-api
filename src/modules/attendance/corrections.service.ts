import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import { attendanceCorrections, attendanceRecords } from '../../db/schema/index.js';
import { recordChange } from '../../platform/record.js';
import {
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
} from '../../shared/errors.js';
import { offsetOf, pageOf } from '../../shared/pagination.js';
import { fullName } from '../students/support.js';
import type {
  ApproveCorrectionBody,
  CorrectionListQuery,
  RejectCorrectionBody,
  RequestCorrectionBody,
} from './attendance.schemas.js';
import type { AttendanceConfigService } from './config.service.js';
import type { SessionService } from './sessions.service.js';
import {
  loadStatuses,
  num,
  placementScope,
  readSettings,
  rows,
  type Caller,
  type StatusRow,
} from './support.js';

type CorrectionRow = typeof attendanceCorrections.$inferSelect;
type RecordRow = typeof attendanceRecords.$inferSelect;

/**
 * Corrections of FINAL records. The correction row is the business history (old →
 * new status, reason, who asked, who decided); audit + outbox record the same
 * change for security. Records of DRAFT sessions are edited directly instead.
 */
export class CorrectionService {
  constructor(
    private readonly deps: Deps,
    private readonly config: AttendanceConfigService,
    private readonly sessions: SessionService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  /**
   * Lock order everywhere: session (share) → record (update) → correction (update).
   * The session is found first with a plain read of the record / correction.
   */
  private async lockChain(
    tx: Executor,
    c: Caller,
    peek: { recordId: string; sessionId: string },
    permission: string,
  ) {
    const session = await this.sessions.loadSession(tx, c, peek.sessionId, permission, 'share');
    const [record] = await tx
      .select()
      .from(attendanceRecords)
      .where(
        and(eq(attendanceRecords.id, peek.recordId), eq(attendanceRecords.tenantId, c.tenantId)),
      )
      .for('update');
    if (!record) throw new NotFoundError('Attendance record');
    return { session, record };
  }

  private async peekRecord(ex: Executor, tenantId: string, recordId: string) {
    const [r] = await ex
      .select({ recordId: attendanceRecords.id, sessionId: attendanceRecords.sessionId })
      .from(attendanceRecords)
      .where(and(eq(attendanceRecords.id, recordId), eq(attendanceRecords.tenantId, tenantId)));
    if (!r) throw new NotFoundError('Attendance record');
    return r;
  }

  private async peekCorrection(ex: Executor, tenantId: string, id: string) {
    const [r] = await ex
      .select({ recordId: attendanceRecords.id, sessionId: attendanceRecords.sessionId })
      .from(attendanceCorrections)
      .innerJoin(
        attendanceRecords,
        and(
          eq(attendanceRecords.tenantId, attendanceCorrections.tenantId),
          eq(attendanceRecords.id, attendanceCorrections.recordId),
        ),
      )
      .where(and(eq(attendanceCorrections.id, id), eq(attendanceCorrections.tenantId, tenantId)));
    if (!r) throw new NotFoundError('Attendance correction');
    return r;
  }

  private async applyToRecord(tx: Executor, c: Caller, record: RecordRow, to: StatusRow) {
    await tx
      .update(attendanceRecords)
      .set({
        statusId: to.id,
        presentWeight: to.countsAsPresent,
        absentWeight: to.countsAsAbsent,
        version: record.version + 1,
      })
      .where(and(eq(attendanceRecords.id, record.id), eq(attendanceRecords.tenantId, c.tenantId)));
  }

  private eventPayload(
    corr: { id: string; status: string; reason: string },
    record: RecordRow,
    from: StatusRow,
    to: StatusRow,
    extra: Record<string, unknown> = {},
  ) {
    return {
      record_id: record.id,
      session_id: record.sessionId,
      student_id: record.studentId,
      old_status_id: from.id,
      new_status_id: to.id,
      old_status_code: from.code,
      new_status_code: to.code,
      correction_status: corr.status,
      ...extra,
    };
  }

  // ---- request -----------------------------------------------------------------

  /** Needs `attendance.correct`. Applied at once (AUTO_APPLIED) or left PENDING, per settings. */
  async request(c: Caller, recordId: string, input: z.infer<typeof RequestCorrectionBody>) {
    await this.config.ensureDefaults(c.tenantId);
    const id = await this.db.transaction(async (tx) => {
      const peek = await this.peekRecord(tx, c.tenantId, recordId);
      const { session, record } = await this.lockChain(tx, c, peek, 'attendance.correct');
      if (session.status !== 'FINAL')
        throw new BusinessRuleError(
          'INVALID_STATE',
          'Only records of a final session need a correction. Edit the register directly instead.',
          { session_status: session.status },
        );
      const settings = await readSettings(tx, c.tenantId, 'share');
      const st = await loadStatuses(
        tx,
        c.tenantId,
        [record.statusId, input.new_status_id],
        'share',
      );
      const from = st.get(record.statusId)!;
      const to = st.get(input.new_status_id);
      if (!to) throw new NotFoundError('Attendance status');
      if (to.status !== 'ACTIVE')
        throw new BusinessRuleError('INVALID_STATE', `The status ${to.code} is inactive`);
      if (to.id === from.id)
        throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'The record already has that status');
      const now = this.deps.clock.now();
      const auto = !settings.correctionRequiresApproval;
      let corrId: string;
      try {
        const [ins] = await tx
          .insert(attendanceCorrections)
          .values({
            tenantId: c.tenantId,
            recordId: record.id,
            oldStatusId: from.id,
            newStatusId: to.id,
            reason: input.reason,
            status: auto ? 'AUTO_APPLIED' : 'PENDING',
            requestedBy: c.actor.userId,
            requestedAt: now,
            decidedAt: auto ? now : null,
          })
          .$returningId();
        corrId = ins!.id;
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          const [pending] = await tx
            .select({ id: attendanceCorrections.id })
            .from(attendanceCorrections)
            .where(
              and(
                eq(attendanceCorrections.tenantId, c.tenantId),
                eq(attendanceCorrections.recordId, record.id),
                eq(attendanceCorrections.status, 'PENDING'),
              ),
            );
          throw new ConflictError(
            'DUPLICATE_RESOURCE',
            'A correction for this record is already waiting for approval',
            pending ? { correction_id: pending.id } : null,
          );
        }
        throw err;
      }
      const corr = { id: corrId, status: auto ? 'AUTO_APPLIED' : 'PENDING', reason: input.reason };
      if (auto) {
        await this.applyToRecord(tx, c, record, to);
        await recordChange(tx, c.actor, c.tenantId, {
          action: 'ATTENDANCE_CORRECTED',
          entityType: 'attendance_correction',
          entityId: corrId,
          event: 'attendance.corrected',
          before: { status: from.code },
          after: { status: to.code },
          reason: input.reason,
          payload: this.eventPayload(corr, record, from, to, { mode: 'AUTO_APPLIED' }),
        });
      } else {
        await recordChange(tx, c.actor, c.tenantId, {
          action: 'ATTENDANCE_CORRECTION_REQUESTED',
          entityType: 'attendance_correction',
          entityId: corrId,
          event: 'attendance.correction_requested',
          before: { status: from.code },
          after: { requested_status: to.code },
          reason: input.reason,
          payload: this.eventPayload(corr, record, from, to),
        });
      }
      return corrId;
    });
    return this.get(c, id, 'attendance.correct');
  }

  // ---- decide ------------------------------------------------------------------

  /** PENDING → APPROVED and the record changes. Needs `attendance.approve`. */
  async approve(c: Caller, id: string, input: z.infer<typeof ApproveCorrectionBody>) {
    await this.config.ensureDefaults(c.tenantId);
    await this.db.transaction(async (tx) => {
      const peek = await this.peekCorrection(tx, c.tenantId, id);
      const { session, record } = await this.lockChain(tx, c, peek, 'attendance.approve');
      const corr = await this.lockCorrection(tx, c, id);
      if (corr.status !== 'PENDING')
        throw new BusinessRuleError('INVALID_STATE', 'The correction has already been decided', {
          correction_status: corr.status,
        });
      if (session.status !== 'FINAL')
        throw new BusinessRuleError('INVALID_STATE', 'The session is no longer final', {
          session_status: session.status,
        });
      const st = await loadStatuses(tx, c.tenantId, [corr.oldStatusId, corr.newStatusId], 'share');
      const from = st.get(corr.oldStatusId)!;
      const to = st.get(corr.newStatusId)!;
      if (record.statusId !== corr.oldStatusId)
        throw new BusinessRuleError(
          'INVALID_STATE',
          'The record has changed since the correction was requested. Reject this request and raise a new one.',
          { reason: 'RECORD_CHANGED' },
        );
      if (to.status !== 'ACTIVE')
        throw new BusinessRuleError('INVALID_STATE', `The status ${to.code} is inactive`);
      const now = this.deps.clock.now();
      await this.applyToRecord(tx, c, record, to);
      await tx
        .update(attendanceCorrections)
        .set({
          status: 'APPROVED',
          decidedBy: c.actor.userId,
          decidedAt: now,
          decisionNote: input.note ?? null,
          version: corr.version + 1,
        })
        .where(
          and(eq(attendanceCorrections.id, id), eq(attendanceCorrections.tenantId, c.tenantId)),
        );
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'ATTENDANCE_CORRECTION_APPROVED',
        entityType: 'attendance_correction',
        entityId: id,
        event: 'attendance.corrected',
        before: { status: from.code, correction_status: 'PENDING' },
        after: { status: to.code, correction_status: 'APPROVED' },
        reason: input.note ?? corr.reason,
        payload: this.eventPayload({ ...corr, status: 'APPROVED' }, record, from, to, {
          mode: 'APPROVED',
          requested_by: corr.requestedBy,
        }),
      });
    });
    return this.get(c, id, 'attendance.approve');
  }

  /** PENDING → REJECTED (reason required); the record is untouched. Needs `attendance.approve`. */
  async reject(c: Caller, id: string, input: z.infer<typeof RejectCorrectionBody>) {
    await this.config.ensureDefaults(c.tenantId);
    await this.db.transaction(async (tx) => {
      const peek = await this.peekCorrection(tx, c.tenantId, id);
      const { record } = await this.lockChain(tx, c, peek, 'attendance.approve');
      const corr = await this.lockCorrection(tx, c, id);
      if (corr.status !== 'PENDING')
        throw new BusinessRuleError('INVALID_STATE', 'The correction has already been decided', {
          correction_status: corr.status,
        });
      const st = await loadStatuses(tx, c.tenantId, [corr.oldStatusId, corr.newStatusId], 'share');
      await tx
        .update(attendanceCorrections)
        .set({
          status: 'REJECTED',
          decidedBy: c.actor.userId,
          decidedAt: this.deps.clock.now(),
          decisionNote: input.reason,
          version: corr.version + 1,
        })
        .where(
          and(eq(attendanceCorrections.id, id), eq(attendanceCorrections.tenantId, c.tenantId)),
        );
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'ATTENDANCE_CORRECTION_REJECTED',
        entityType: 'attendance_correction',
        entityId: id,
        event: 'attendance.correction_rejected',
        before: { correction_status: 'PENDING' },
        after: { correction_status: 'REJECTED' },
        reason: input.reason,
        payload: this.eventPayload(
          { ...corr, status: 'REJECTED' },
          record,
          st.get(corr.oldStatusId)!,
          st.get(corr.newStatusId)!,
          { requested_by: corr.requestedBy },
        ),
      });
    });
    return this.get(c, id, 'attendance.approve');
  }

  private async lockCorrection(tx: Executor, c: Caller, id: string): Promise<CorrectionRow> {
    const [corr] = await tx
      .select()
      .from(attendanceCorrections)
      .where(and(eq(attendanceCorrections.id, id), eq(attendanceCorrections.tenantId, c.tenantId)))
      .for('update');
    if (!corr) throw new NotFoundError('Attendance correction');
    return corr;
  }

  // ---- reads -------------------------------------------------------------------

  private baseFrom = sql`from attendance_corrections k
      join attendance_records r on r.tenant_id = k.tenant_id and r.id = k.record_id
      join attendance_sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
      join academic_sections sec on sec.tenant_id = s.tenant_id and sec.id = s.section_id
      join academic_classes cl on cl.tenant_id = s.tenant_id and cl.id = s.class_id
      join students st on st.tenant_id = r.tenant_id and st.id = r.student_id
      join attendance_statuses os on os.tenant_id = k.tenant_id and os.id = k.old_status_id
      join attendance_statuses ns on ns.tenant_id = k.tenant_id and ns.id = k.new_status_id`;

  private async query(
    c: Caller,
    permission: string,
    extra: SQL[],
    page?: { limit: number; offset: number },
  ) {
    const conds: SQL[] = [sql`k.tenant_id = ${c.tenantId}`, ...extra];
    const scope = placementScope(c.principal, permission, {
      section: sql`s.section_id`,
      klass: sql`s.class_id`,
    });
    if (scope) conds.push(scope);
    if (!c.features.includes('attendance.subject')) conds.push(sql`s.attendance_type = 'DAILY'`);
    const where = sql.join(conds, sql` and `);
    type Row = {
      id: string;
      status: string;
      reason: string;
      record_id: string;
      session_id: string;
      session_date: string;
      attendance_type: string;
      section_id: string;
      sec_name: string;
      class_id: string;
      cl_name: string;
      student_id: string;
      student_number: string;
      first_name: string;
      middle_name: string | null;
      last_name: string;
      old_id: string;
      old_code: string;
      old_name: string;
      new_id: string;
      new_code: string;
      new_name: string;
      requested_by: string | null;
      requested_at: Date;
      decided_by: string | null;
      decided_at: Date | null;
      decision_note: string | null;
      version: number;
    };
    const [total] = await rows<{ n: number }>(
      this.db,
      sql`select count(*) as n ${this.baseFrom} where ${where}`,
    );
    const data = await rows<Row>(
      this.db,
      sql`select k.id, k.status, k.reason, k.record_id, s.id as session_id,
        date_format(s.session_date, '%Y-%m-%d') as session_date, s.attendance_type,
        s.section_id, sec.name as sec_name, s.class_id, cl.name as cl_name,
        st.id as student_id, st.student_number, st.first_name, st.middle_name, st.last_name,
        os.id as old_id, os.code as old_code, os.name as old_name,
        ns.id as new_id, ns.code as new_code, ns.name as new_name,
        k.requested_by, k.requested_at, k.decided_by, k.decided_at, k.decision_note, k.version
        ${this.baseFrom} where ${where}
        order by k.created_at desc, k.id desc
        ${page ? sql`limit ${page.limit} offset ${page.offset}` : sql`limit 1`}`,
    );
    const present = data.map((r) => ({
      id: r.id,
      status: r.status,
      reason: r.reason,
      record_id: r.record_id,
      session: {
        id: r.session_id,
        session_date: r.session_date,
        attendance_type: r.attendance_type,
        section: { id: r.section_id, name: r.sec_name },
        class: { id: r.class_id, name: r.cl_name },
      },
      student: {
        id: r.student_id,
        student_number: r.student_number,
        full_name: fullName({
          firstName: r.first_name,
          middleName: r.middle_name,
          lastName: r.last_name,
        }),
      },
      old_status: { id: r.old_id, code: r.old_code, name: r.old_name },
      new_status: { id: r.new_id, code: r.new_code, name: r.new_name },
      requested_by: r.requested_by,
      requested_at: new Date(r.requested_at).toISOString(),
      decided_by: r.decided_by,
      decided_at: r.decided_at ? new Date(r.decided_at).toISOString() : null,
      decision_note: r.decision_note,
      version: r.version,
    }));
    return { present, total: num(total?.n) };
  }

  async get(c: Caller, id: string, permission = 'attendance.read') {
    await this.config.ensureDefaults(c.tenantId);
    const { present } = await this.query(c, permission, [sql`k.id = ${id}`], {
      limit: 1,
      offset: 0,
    });
    if (!present[0]) throw new NotFoundError('Attendance correction');
    return present[0];
  }

  async list(c: Caller, q: z.infer<typeof CorrectionListQuery>) {
    await this.config.ensureDefaults(c.tenantId);
    const extra: SQL[] = [];
    if (q.status) extra.push(sql`k.status = ${q.status}`);
    if (q.section_id) extra.push(sql`s.section_id = ${q.section_id}`);
    if (q.student_id) extra.push(sql`r.student_id = ${q.student_id}`);
    if (q.session_id) extra.push(sql`s.id = ${q.session_id}`);
    if (q.record_id) extra.push(sql`k.record_id = ${q.record_id}`);
    if (q.date_from) extra.push(sql`s.session_date >= ${q.date_from}`);
    if (q.date_to) extra.push(sql`s.session_date <= ${q.date_to}`);
    const { present, total } = await this.query(c, 'attendance.read', extra, {
      limit: q.page_size,
      offset: offsetOf(q),
    });
    return pageOf(present, total, q);
  }
}
