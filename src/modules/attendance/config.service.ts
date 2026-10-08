import { and, asc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  attendanceSettings,
  attendanceStatuses,
  type AttendanceStatusCategory,
} from '../../db/schema/index.js';
import type { Actor } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import {
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
} from '../../shared/errors.js';
import type {
  CreateStatusBody,
  StatusListQuery,
  UpdateSettingsBody,
  UpdateStatusBody,
} from './attendance.schemas.js';
import {
  readSettings,
  settingsPresent,
  statusPresent,
  validationIssue,
  weight,
  type StatusRow,
} from './support.js';

interface DefaultStatus {
  code: string;
  name: string;
  category: AttendanceStatusCategory;
  present: number;
  absent: number;
  requiresReason: boolean;
  sortOrder: number;
}

/**
 * The six built-in statuses every school starts with. Weights are shares of one
 * attendance unit. EXCUSED (school-approved absence, e.g. a sports event) does not
 * count against a student; LEAVE (leave of absence) does. Both are reconfigurable
 * by adding custom statuses; the built-ins themselves are locked.
 */
export const DEFAULT_STATUSES: readonly DefaultStatus[] = [
  {
    code: 'PRESENT',
    name: 'Present',
    category: 'PRESENT',
    present: 1,
    absent: 0,
    requiresReason: false,
    sortOrder: 10,
  },
  {
    code: 'ABSENT',
    name: 'Absent',
    category: 'ABSENT',
    present: 0,
    absent: 1,
    requiresReason: false,
    sortOrder: 20,
  },
  {
    code: 'LATE',
    name: 'Late',
    category: 'LATE',
    present: 1,
    absent: 0,
    requiresReason: false,
    sortOrder: 30,
  },
  {
    code: 'HALF_DAY',
    name: 'Half day',
    category: 'HALF_DAY',
    present: 0.5,
    absent: 0.5,
    requiresReason: false,
    sortOrder: 40,
  },
  {
    code: 'EXCUSED',
    name: 'Excused',
    category: 'EXCUSED',
    present: 1,
    absent: 0,
    requiresReason: true,
    sortOrder: 50,
  },
  {
    code: 'LEAVE',
    name: 'Leave',
    category: 'LEAVE',
    present: 0,
    absent: 1,
    requiresReason: true,
    sortOrder: 60,
  },
];

const CATEGORY_WEIGHTS: Record<AttendanceStatusCategory, [number, number]> = {
  PRESENT: [1, 0],
  ABSENT: [0, 1],
  LATE: [1, 0],
  HALF_DAY: [0.5, 0.5],
  EXCUSED: [1, 0],
  LEAVE: [0, 1],
  OTHER: [0, 0],
};

const isDeadlock = (err: unknown) => {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i++) {
    if (typeof cur === 'object' && cur !== null && 'code' in cur) {
      const c = (cur as { code: unknown }).code;
      if (c === 'ER_LOCK_DEADLOCK' || c === 'ER_LOCK_WAIT_TIMEOUT') return true;
    }
    cur = typeof cur === 'object' && cur !== null ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
};

/** Attendance configuration: the status catalog and the per-school settings. */
export class AttendanceConfigService {
  /** Schools already known to have defaults (system rows are never deleted, so this is safe). */
  private readonly ready = new Set<string>();

  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  /**
   * Idempotent, concurrency-safe creation of the school's six default statuses and
   * its settings row. Runs on every attendance read/write path (schools created
   * before this module existed are backfilled on first use; there is no provisioning
   * hook because a school without the `attendance` feature never needs the rows).
   * Uses its own autocommit statements, so callers must run it BEFORE opening their
   * transaction.
   */
  async ensureDefaults(tenantId: string): Promise<void> {
    if (this.ready.has(tenantId)) return;
    for (let attempt = 0; ; attempt++) {
      try {
        const present = await this.db
          .select({ code: attendanceStatuses.code })
          .from(attendanceStatuses)
          .where(
            and(eq(attendanceStatuses.tenantId, tenantId), eq(attendanceStatuses.isSystem, true)),
          );
        const have = new Set(present.map((p) => p.code));
        const missing = DEFAULT_STATUSES.filter((d) => !have.has(d.code));
        if (missing.length) {
          await this.db
            .insert(attendanceStatuses)
            .values(
              missing.map((d) => ({
                tenantId,
                code: d.code,
                name: d.name,
                category: d.category,
                countsAsPresent: weight(d.present),
                countsAsAbsent: weight(d.absent),
                requiresReason: d.requiresReason,
                sortOrder: d.sortOrder,
                isSystem: true,
              })),
            )
            .onDuplicateKeyUpdate({ set: { code: sql`${attendanceStatuses.code}` } });
        }
        await this.db
          .insert(attendanceSettings)
          .values({ tenantId })
          .onDuplicateKeyUpdate({ set: { tenantId: sql`${attendanceSettings.tenantId}` } });
        this.ready.add(tenantId);
        return;
      } catch (err) {
        if (attempt < 3 && isDeadlock(err)) continue;
        throw err;
      }
    }
  }

  // ---- settings ----------------------------------------------------------------

  async getSettings(tenantId: string) {
    await this.ensureDefaults(tenantId);
    return settingsPresent(await readSettings(this.db, tenantId));
  }

  async updateSettings(tenantId: string, input: z.infer<typeof UpdateSettingsBody>, actor: Actor) {
    await this.ensureDefaults(tenantId);
    await this.db.transaction(async (tx) => {
      const before = await readSettings(tx, tenantId, 'update');
      if (before.version !== input.version) throw new ConflictError('CONFLICT');
      const set: Partial<typeof attendanceSettings.$inferInsert> = {};
      if (input.approval_required !== undefined) set.approvalRequired = input.approval_required;
      if (input.correction_requires_approval !== undefined)
        set.correctionRequiresApproval = input.correction_requires_approval;
      if (input.edit_window_days !== undefined) set.editWindowDays = input.edit_window_days;
      if (input.defaulter_threshold_percent !== undefined)
        set.defaulterThresholdPercent = input.defaulter_threshold_percent.toFixed(2);
      if (input.late_counts_as_present !== undefined)
        set.lateCountsAsPresent = input.late_counts_as_present;
      await tx
        .update(attendanceSettings)
        .set({ ...set, version: before.version + 1, updatedBy: actor.userId })
        .where(eq(attendanceSettings.tenantId, tenantId));
      let cascaded = 0;
      if (
        input.late_counts_as_present !== undefined &&
        input.late_counts_as_present !== before.lateCountsAsPresent
      ) {
        // The switch is applied to the status definitions; existing records keep the weights
        // they were marked with (snapshot), so history is not rewritten.
        const [res] = await tx
          .update(attendanceStatuses)
          .set({
            countsAsPresent: weight(input.late_counts_as_present ? 1 : 0),
            version: sql`${attendanceStatuses.version} + 1`,
            updatedBy: actor.userId,
          })
          .where(
            and(eq(attendanceStatuses.tenantId, tenantId), eq(attendanceStatuses.category, 'LATE')),
          );
        cascaded = res.affectedRows;
      }
      const after = await readSettings(tx, tenantId);
      await recordChange(tx, actor, tenantId, {
        action: 'ATTENDANCE_SETTINGS_UPDATED',
        entityType: 'attendance_settings',
        entityId: tenantId,
        event: 'attendance.settings_updated',
        before: settingsPresent(before),
        after: { ...settingsPresent(after), late_statuses_updated: cascaded },
        payload: { changed: Object.keys(input).filter((k) => k !== 'version') },
      });
    });
    return settingsPresent(await readSettings(this.db, tenantId));
  }

  // ---- statuses ----------------------------------------------------------------

  async listStatuses(tenantId: string, q: z.infer<typeof StatusListQuery>) {
    await this.ensureDefaults(tenantId);
    const conds = [eq(attendanceStatuses.tenantId, tenantId)];
    if (q.status) conds.push(eq(attendanceStatuses.status, q.status));
    const rows = await this.db
      .select()
      .from(attendanceStatuses)
      .where(and(...conds))
      .orderBy(asc(attendanceStatuses.sortOrder), asc(attendanceStatuses.code));
    return rows.map(statusPresent);
  }

  private async row(ex: Executor, tenantId: string, id: string, lock = false): Promise<StatusRow> {
    const q = ex
      .select()
      .from(attendanceStatuses)
      .where(and(eq(attendanceStatuses.id, id), eq(attendanceStatuses.tenantId, tenantId)));
    const [r] = await (lock ? q.for('update') : q);
    if (!r) throw new NotFoundError('Attendance status');
    return r;
  }

  async getStatus(tenantId: string, id: string) {
    await this.ensureDefaults(tenantId);
    return statusPresent(await this.row(this.db, tenantId, id));
  }

  async createStatus(tenantId: string, input: z.infer<typeof CreateStatusBody>, actor: Actor) {
    await this.ensureDefaults(tenantId);
    const [dp, da] = CATEGORY_WEIGHTS[input.category];
    let present = input.counts_as_present ?? dp;
    const absent = input.counts_as_absent ?? da;
    if (present + absent > 1.0001)
      throw validationIssue(
        'counts_as_absent',
        'counts_as_present + counts_as_absent cannot exceed 1',
      );
    const id = await this.db.transaction(async (tx) => {
      if (input.category === 'LATE') {
        // LATE-category statuses follow the school-wide switch.
        const s = await readSettings(tx, tenantId, 'share');
        present = s.lateCountsAsPresent ? 1 : 0;
      }
      try {
        const [ins] = await tx
          .insert(attendanceStatuses)
          .values({
            tenantId,
            code: input.code,
            name: input.name,
            category: input.category,
            countsAsPresent: weight(present),
            countsAsAbsent: weight(absent),
            requiresReason: input.requires_reason,
            sortOrder: input.sort_order,
            isSystem: false,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          })
          .$returningId();
        const created = await this.row(tx, tenantId, ins!.id);
        await recordChange(tx, actor, tenantId, {
          action: 'ATTENDANCE_STATUS_CREATED',
          entityType: 'attendance_status',
          entityId: created.id,
          event: 'attendance.status_created',
          after: statusPresent(created),
          payload: { code: created.code, category: created.category },
        });
        return created.id;
      } catch (err) {
        if (isDuplicateKeyError(err))
          throw new ConflictError(
            'DUPLICATE_RESOURCE',
            `An attendance status with code ${input.code} already exists`,
          );
        throw err;
      }
    });
    return statusPresent(await this.row(this.db, tenantId, id));
  }

  async updateStatus(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateStatusBody>,
    actor: Actor,
  ) {
    await this.ensureDefaults(tenantId);
    await this.db.transaction(async (tx) => {
      const before = await this.row(tx, tenantId, id, true);
      if (before.version !== input.version) throw new ConflictError('CONFLICT');
      const semantic =
        input.category !== undefined ||
        input.counts_as_present !== undefined ||
        input.counts_as_absent !== undefined ||
        input.requires_reason !== undefined;
      if (before.isSystem && semantic)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'Built-in statuses keep their meaning; only name and sort order can change. Add a custom status instead.',
        );
      const category = input.category ?? before.category;
      let present = input.counts_as_present ?? Number(before.countsAsPresent);
      const absent = input.counts_as_absent ?? Number(before.countsAsAbsent);
      if (category === 'LATE' && !before.isSystem) {
        const s = await readSettings(tx, tenantId, 'share');
        present = s.lateCountsAsPresent ? 1 : 0;
      }
      if (present + absent > 1.0001)
        throw validationIssue(
          'counts_as_absent',
          'counts_as_present + counts_as_absent cannot exceed 1',
        );
      await tx
        .update(attendanceStatuses)
        .set({
          name: input.name ?? before.name,
          sortOrder: input.sort_order ?? before.sortOrder,
          ...(before.isSystem
            ? {}
            : {
                category,
                countsAsPresent: weight(present),
                countsAsAbsent: weight(absent),
                requiresReason: input.requires_reason ?? before.requiresReason,
              }),
          version: before.version + 1,
          updatedBy: actor.userId,
        })
        .where(and(eq(attendanceStatuses.id, id), eq(attendanceStatuses.tenantId, tenantId)));
      const after = await this.row(tx, tenantId, id);
      await recordChange(tx, actor, tenantId, {
        action: 'ATTENDANCE_STATUS_UPDATED',
        entityType: 'attendance_status',
        entityId: id,
        event: 'attendance.status_updated',
        before: statusPresent(before),
        after: statusPresent(after),
        payload: { code: after.code, changed: Object.keys(input).filter((k) => k !== 'version') },
      });
    });
    return statusPresent(await this.row(this.db, tenantId, id));
  }

  /** Deactivate (custom statuses only) or reactivate. Records keep referencing an inactive status. */
  async setStatusState(tenantId: string, id: string, to: 'ACTIVE' | 'INACTIVE', actor: Actor) {
    await this.ensureDefaults(tenantId);
    await this.db.transaction(async (tx) => {
      const before = await this.row(tx, tenantId, id, true);
      if (before.isSystem)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'Built-in attendance statuses cannot be deactivated',
        );
      if (before.status === to)
        throw new BusinessRuleError('INVALID_STATE', `The status is already ${to.toLowerCase()}`);
      await tx
        .update(attendanceStatuses)
        .set({ status: to, version: before.version + 1, updatedBy: actor.userId })
        .where(and(eq(attendanceStatuses.id, id), eq(attendanceStatuses.tenantId, tenantId)));
      await recordChange(tx, actor, tenantId, {
        action: to === 'INACTIVE' ? 'ATTENDANCE_STATUS_DEACTIVATED' : 'ATTENDANCE_STATUS_ACTIVATED',
        entityType: 'attendance_status',
        entityId: id,
        event: to === 'INACTIVE' ? 'attendance.status_deactivated' : 'attendance.status_activated',
        before: { status: before.status },
        after: { status: to },
        payload: { code: before.code },
      });
    });
    return statusPresent(await this.row(this.db, tenantId, id));
  }
}
