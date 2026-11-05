import { and, desc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import { teacherNotificationReads, teacherNotifications, teachers } from '../../db/schema/index.js';
import type { Actor } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../shared/errors.js';
import type {
  CreateNotificationBody,
  NotificationListQuery,
  ReadNotificationsBody,
} from './teacher-notifications.schemas.js';

type Row = typeof teacherNotifications.$inferSelect;

/**
 * Notifications from the office to teachers (admin panel → teacher app). No push yet:
 * the app lists what has been sent to the teacher, and a scheduled one appears once
 * its send time has passed, so no background job is needed.
 */
export class TeacherNotificationService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  private state(r: Row, now: Date) {
    if (r.status === 'CANCELLED') return 'CANCELLED';
    return r.sendAt.getTime() > now.getTime() ? 'SCHEDULED' : 'SENT';
  }

  // ---- office (admin panel) ------------------------------------------------------------

  async list(tenantId: string, q: z.infer<typeof NotificationListQuery>) {
    const now = this.deps.clock.now();
    const offset = (q.page - 1) * q.page_size;
    const [rows, counted, activeTeachers] = await Promise.all([
      this.db
        .select()
        .from(teacherNotifications)
        .where(eq(teacherNotifications.tenantId, tenantId))
        .orderBy(desc(teacherNotifications.sendAt))
        .limit(q.page_size)
        .offset(offset),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(teacherNotifications)
        .where(eq(teacherNotifications.tenantId, tenantId)),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(teachers)
        .where(
          and(eq(teachers.tenantId, tenantId), inArray(teachers.status, ['ACTIVE', 'ON_LEAVE'])),
        ),
    ]);
    const ids = rows.map((r) => r.id);
    const reads = ids.length
      ? await this.db
          .select({ id: teacherNotificationReads.notificationId, n: sql<number>`count(*)` })
          .from(teacherNotificationReads)
          .where(
            and(
              eq(teacherNotificationReads.tenantId, tenantId),
              inArray(teacherNotificationReads.notificationId, ids),
            ),
          )
          .groupBy(teacherNotificationReads.notificationId)
      : [];
    const readBy = new Map(reads.map((r) => [r.id, Number(r.n)]));
    const allCount = Number(activeTeachers[0]?.n ?? 0);
    return {
      data: rows.map((r) => ({
        ...this.present(r, now),
        recipients: r.audience === 'ALL' ? allCount : (r.teacherIds ?? []).length,
        read_count: readBy.get(r.id) ?? 0,
      })),
      meta: { page: q.page, page_size: q.page_size, total: Number(counted[0]?.total ?? 0) },
    };
  }

  private present(r: Row, now: Date) {
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      audience: r.audience,
      teacher_ids: r.teacherIds ?? [],
      send_at: r.sendAt.toISOString(),
      state: this.state(r, now),
      status: r.status,
      version: r.version,
      created_at: r.createdAt.toISOString(),
    };
  }

  async create(tenantId: string, input: z.infer<typeof CreateNotificationBody>, actor: Actor) {
    const now = this.deps.clock.now();
    const sendAt = input.send_at ? new Date(input.send_at) : now;
    const ids = input.audience === 'SELECTED' ? [...new Set(input.teacher_ids ?? [])] : null;
    if (ids) {
      if (!ids.length)
        throw new ValidationError('Choose at least one teacher', {
          location: 'body',
          issues: [{ path: 'teacher_ids', message: 'Choose at least one teacher' }],
        });
      const found = await this.db
        .select({ id: teachers.id })
        .from(teachers)
        .where(and(eq(teachers.tenantId, tenantId), inArray(teachers.id, ids)));
      if (found.length !== ids.length) throw new NotFoundError('Teacher');
    }
    const id = uuidv7();
    await this.db.transaction(async (tx) => {
      await tx.insert(teacherNotifications).values({
        id,
        tenantId,
        title: input.title,
        body: input.body,
        audience: input.audience,
        teacherIds: ids,
        sendAt,
        createdBy: actor.userId,
      });
      await recordChange(tx, actor, tenantId, {
        action: 'TEACHER_NOTIFICATION_CREATED',
        entityType: 'teacher_notification',
        entityId: id,
        event: 'teacher_notification.created',
        after: {
          audience: input.audience,
          recipients: ids?.length ?? null,
          send_at: sendAt.toISOString(),
        },
      });
    });
    const [row] = await this.db
      .select()
      .from(teacherNotifications)
      .where(eq(teacherNotifications.id, id));
    return this.present(row!, now);
  }

  /** Withdraw a notification: a scheduled one is never shown; a sent one disappears from the app. */
  async cancel(tenantId: string, id: string, actor: Actor) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(teacherNotifications)
        .where(and(eq(teacherNotifications.tenantId, tenantId), eq(teacherNotifications.id, id)))
        .for('update');
      if (!row) throw new NotFoundError('Notification');
      if (row.status === 'CANCELLED')
        throw new BusinessRuleError('INVALID_STATE', 'This notification is already withdrawn');
      await tx
        .update(teacherNotifications)
        .set({ status: 'CANCELLED', version: row.version + 1 })
        .where(eq(teacherNotifications.id, id));
      await recordChange(tx, actor, tenantId, {
        action: 'TEACHER_NOTIFICATION_CANCELLED',
        entityType: 'teacher_notification',
        entityId: id,
        event: 'teacher_notification.cancelled',
      });
    });
  }

  // ---- teacher app --------------------------------------------------------------------

  private mineWhere(tenantId: string, teacherId: string, now: Date) {
    return and(
      eq(teacherNotifications.tenantId, tenantId),
      eq(teacherNotifications.status, 'ACTIVE'),
      lte(teacherNotifications.sendAt, now),
      or(
        eq(teacherNotifications.audience, 'ALL'),
        sql`json_contains(${teacherNotifications.teacherIds}, json_quote(${teacherId}))`,
      ),
    );
  }

  /** What the office has sent me (latest 100), with read state. */
  async mine(tenantId: string, teacherId: string) {
    const now = this.deps.clock.now();
    const rows = await this.db
      .select({
        n: teacherNotifications,
        readAt: teacherNotificationReads.readAt,
      })
      .from(teacherNotifications)
      .leftJoin(
        teacherNotificationReads,
        and(
          eq(teacherNotificationReads.notificationId, teacherNotifications.id),
          eq(teacherNotificationReads.teacherId, teacherId),
        ),
      )
      .where(this.mineWhere(tenantId, teacherId, now))
      .orderBy(desc(teacherNotifications.sendAt))
      .limit(100);
    return {
      unread: rows.filter((r) => !r.readAt).length,
      items: rows.map((r) => ({
        id: r.n.id,
        title: r.n.title,
        body: r.n.body,
        sent_at: r.n.sendAt.toISOString(),
        read: !!r.readAt,
      })),
    };
  }

  /** Mark some (ids) or all of my notifications read. */
  async markRead(
    tenantId: string,
    teacherId: string,
    input: z.infer<typeof ReadNotificationsBody>,
  ) {
    const now = this.deps.clock.now();
    const visible = await this.db
      .select({ id: teacherNotifications.id })
      .from(teacherNotifications)
      .where(this.mineWhere(tenantId, teacherId, now));
    const allowed = new Set(visible.map((v) => v.id));
    const ids = input.all ? [...allowed] : (input.ids ?? []).filter((id) => allowed.has(id));
    if (ids.length)
      await this.db
        .insert(teacherNotificationReads)
        .values(
          ids.map((notificationId) => ({ id: uuidv7(), tenantId, notificationId, teacherId })),
        )
        .onDuplicateKeyUpdate({ set: { teacherId: sql`${teacherNotificationReads.teacherId}` } });
    return this.mine(tenantId, teacherId);
  }
}
