import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  sql,
  type SQL,
} from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import {
  academicClasses,
  academicSections,
  files,
  guardians,
  noticeReceipts,
  notices,
} from '../../db/schema/index.js';
import type { Actor } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import {
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import { DOCUMENT_TYPES } from '../files/file-validation.js';
import type { FileService } from '../files/files.service.js';
import type {
  CreateNoticeBody,
  NoticeListQuery,
  ParentNoticeQuery,
  UpdateNoticeBody,
} from './notices.schemas.js';

type Row = typeof notices.$inferSelect;

/** Who is writing: the office (admin panel) or a teacher limited to their sections. */
export type Author =
  | { kind: 'office' }
  | { kind: 'teacher'; teacherId: string; name: string; sectionIds: ReadonlySet<string> };

/** A child as the parent app sees it: where they are placed this year. */
export interface ChildPlacement {
  studentId: string;
  firstName: string;
  classId: string | null;
  sectionId: string | null;
}

const ATTACHMENT_MAX = 5 * 1024 * 1024;

const paragraphs = (body: string) =>
  body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

const summaryOf = (body: string) => {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 137)}…` : flat;
};

const jsonHas = (col: unknown, id: string) => sql`json_contains(${col}, json_quote(${id}))`;

/**
 * Notices for parents (0045): notices, circulars, announcements and events, for the whole
 * school, chosen classes or chosen sections. The office writes them in the admin panel and
 * teachers write them for their own sections in the teacher app. Parents read them in the
 * parent app once `publish_at` has passed, mark them read and acknowledge the ones that ask.
 */
export class NoticeService {
  constructor(
    private readonly deps: Deps,
    private readonly fileSvc: FileService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  private state(r: Row, now: Date) {
    if (r.status === 'CANCELLED') return 'CANCELLED' as const;
    return r.publishAt.getTime() > now.getTime() ? ('SCHEDULED' as const) : ('PUBLISHED' as const);
  }

  private async attachmentsOf(rows: Row[]) {
    const ids = rows.map((r) => r.attachmentFileId).filter((x): x is string => !!x);
    if (!ids.length) return new Map<string, { name: string; size: number; mime: string }>();
    const fs = await this.db
      .select({
        id: files.id,
        name: files.originalName,
        size: files.sizeBytes,
        mime: files.mimeType,
      })
      .from(files)
      .where(inArray(files.id, ids));
    return new Map(fs.map((f) => [f.id, { name: f.name, size: Number(f.size), mime: f.mime }]));
  }

  private async audienceLabels(tenantId: string, rows: Row[]) {
    const classIds = new Set<string>();
    const sectionIds = new Set<string>();
    for (const r of rows) {
      for (const c of r.classIds ?? []) classIds.add(c);
      for (const s of r.sectionIds ?? []) sectionIds.add(s);
    }
    const [cls, secs] = await Promise.all([
      classIds.size
        ? this.db
            .select({ id: academicClasses.id, name: academicClasses.name })
            .from(academicClasses)
            .where(
              and(
                eq(academicClasses.tenantId, tenantId),
                inArray(academicClasses.id, [...classIds]),
              ),
            )
        : [],
      sectionIds.size
        ? this.db
            .select({
              id: academicSections.id,
              name: academicSections.name,
              className: academicClasses.name,
            })
            .from(academicSections)
            .innerJoin(academicClasses, eq(academicClasses.id, academicSections.classId))
            .where(
              and(
                eq(academicSections.tenantId, tenantId),
                inArray(academicSections.id, [...sectionIds]),
              ),
            )
        : [],
    ]);
    const cName = new Map(cls.map((c) => [c.id, c.name]));
    const sName = new Map(secs.map((s) => [s.id, `${s.className} ${s.name}`]));
    return (r: Row) => {
      if (r.audience === 'SCHOOL') return 'Entire school';
      const names =
        r.audience === 'CLASSES'
          ? (r.classIds ?? []).map((id) => cName.get(id)).filter(Boolean)
          : (r.sectionIds ?? []).map((id) => sName.get(id)).filter(Boolean);
      return names.join(', ') || (r.audience === 'CLASSES' ? 'Chosen classes' : 'Chosen sections');
    };
  }

  private present(
    r: Row,
    now: Date,
    audienceLabel: string,
    att: { name: string; size: number; mime: string } | undefined,
  ) {
    return {
      id: r.id,
      category: r.category,
      title: r.title,
      summary: r.summary,
      body: r.body,
      paragraphs: paragraphs(r.body),
      audience: r.audience,
      audience_label: audienceLabel,
      class_ids: r.classIds ?? [],
      section_ids: r.sectionIds ?? [],
      attachment: att ? { name: att.name, size_bytes: att.size, content_type: att.mime } : null,
      requires_acknowledgement: r.requiresAcknowledgement,
      event_date: r.eventDate,
      event_title: r.eventTitle,
      event_subtitle: r.eventSubtitle,
      publish_at: r.publishAt.toISOString(),
      state: this.state(r, now),
      posted_by: { name: r.postedByName, teacher_id: r.teacherId },
      cancelled_at: r.cancelledAt?.toISOString() ?? null,
      cancel_reason: r.cancelReason,
      version: r.version,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    };
  }

  private async presentMany(tenantId: string, rows: Row[]) {
    const now = this.deps.clock.now();
    const [label, atts] = await Promise.all([
      this.audienceLabels(tenantId, rows),
      this.attachmentsOf(rows),
    ]);
    return rows.map((r) =>
      this.present(r, now, label(r), r.attachmentFileId ? atts.get(r.attachmentFileId) : undefined),
    );
  }

  private async load(tenantId: string, id: string, ex = this.db, lock = false) {
    const q = ex
      .select()
      .from(notices)
      .where(and(eq(notices.tenantId, tenantId), eq(notices.id, id)));
    const [r] = lock ? await q.for('update') : await q;
    if (!r) throw new NotFoundError('Notice');
    return r;
  }

  private assertOwn(r: Row, author: Author) {
    if (author.kind === 'teacher' && r.teacherId !== author.teacherId)
      throw new NotFoundError('Notice');
  }

  /** Normalises and checks the audience; a teacher may only reach their own sections. */
  private async audienceOf(
    tenantId: string,
    a: { audience: Row['audience']; class_ids?: string[]; section_ids?: string[] },
    author: Author,
  ) {
    const classIds = [...new Set(a.class_ids ?? [])];
    const sectionIds = [...new Set(a.section_ids ?? [])];
    const issue = (path: string, message: string) =>
      new ValidationError('The request is invalid', {
        location: 'body',
        issues: [{ path, message }],
      });
    if (author.kind === 'teacher') {
      if (a.audience !== 'SECTIONS') throw issue('audience', 'Teachers post to their own sections');
      if (!sectionIds.length) throw issue('section_ids', 'Choose at least one section');
      const outside = sectionIds.filter((s) => !author.sectionIds.has(s));
      if (outside.length)
        throw new AuthorizationError(
          'PERMISSION_DENIED',
          'You can only post to sections you teach',
          {
            section_ids: outside,
          },
        );
    }
    if (a.audience === 'CLASSES') {
      if (!classIds.length) throw issue('class_ids', 'Choose at least one class');
      const found = await this.db
        .select({ id: academicClasses.id })
        .from(academicClasses)
        .where(and(eq(academicClasses.tenantId, tenantId), inArray(academicClasses.id, classIds)));
      if (found.length !== classIds.length) throw new NotFoundError('Class');
      return { classIds, sectionIds: null };
    }
    if (a.audience === 'SECTIONS') {
      if (!sectionIds.length) throw issue('section_ids', 'Choose at least one section');
      const found = await this.db
        .select({ id: academicSections.id })
        .from(academicSections)
        .where(
          and(eq(academicSections.tenantId, tenantId), inArray(academicSections.id, sectionIds)),
        );
      if (found.length !== sectionIds.length) throw new NotFoundError('Section');
      return { classIds: null, sectionIds };
    }
    return { classIds: null, sectionIds: null };
  }

  // ---- office and teachers ---------------------------------------------------------------

  async list(tenantId: string, q: z.infer<typeof NoticeListQuery>, author: Author) {
    const now = this.deps.clock.now();
    const conds: (SQL | undefined)[] = [
      eq(notices.tenantId, tenantId),
      author.kind === 'teacher' ? eq(notices.teacherId, author.teacherId) : undefined,
      q.category ? eq(notices.category, q.category) : undefined,
      q.from_teachers === true ? isNotNull(notices.teacherId) : undefined,
      q.from_teachers === false ? isNull(notices.teacherId) : undefined,
      q.search ? like(notices.title, `%${q.search.replace(/[%_\\]/g, '\\$&')}%`) : undefined,
      q.state === 'CANCELLED' ? eq(notices.status, 'CANCELLED') : undefined,
      q.state === 'SCHEDULED'
        ? and(eq(notices.status, 'ACTIVE'), sql`${notices.publishAt} > ${now}`)
        : undefined,
      q.state === 'PUBLISHED'
        ? and(eq(notices.status, 'ACTIVE'), lte(notices.publishAt, now))
        : undefined,
    ];
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(notices)
        .where(where)
        .orderBy(desc(notices.publishAt))
        .limit(q.page_size)
        .offset((q.page - 1) * q.page_size),
      this.db.select({ n: count() }).from(notices).where(where),
    ]);
    const stats = await this.stats(
      tenantId,
      rows.map((r) => r.id),
    );
    const data = (await this.presentMany(tenantId, rows)).map((n) => ({
      ...n,
      read_count: stats.get(n.id)?.read ?? 0,
      acknowledged_count: stats.get(n.id)?.ack ?? 0,
    }));
    return { data, meta: { page: q.page, page_size: q.page_size, total: Number(total?.n ?? 0) } };
  }

  private async stats(tenantId: string, ids: string[]) {
    if (!ids.length) return new Map<string, { read: number; ack: number }>();
    const rows = await this.db
      .select({
        id: noticeReceipts.noticeId,
        read: count(),
        ack: sql<number>`sum(case when ${noticeReceipts.acknowledgedAt} is not null then 1 else 0 end)`,
      })
      .from(noticeReceipts)
      .where(and(eq(noticeReceipts.tenantId, tenantId), inArray(noticeReceipts.noticeId, ids)))
      .groupBy(noticeReceipts.noticeId);
    return new Map(rows.map((r) => [r.id, { read: Number(r.read), ack: Number(r.ack ?? 0) }]));
  }

  async get(tenantId: string, id: string, author: Author) {
    const r = await this.load(tenantId, id);
    this.assertOwn(r, author);
    const [n] = await this.presentMany(tenantId, [r]);
    const s = (await this.stats(tenantId, [id])).get(id);
    return { ...n!, read_count: s?.read ?? 0, acknowledged_count: s?.ack ?? 0 };
  }

  /** Who has read / acknowledged a notice (guardian, their children, when). */
  async receipts(tenantId: string, id: string, author: Author) {
    const r = await this.load(tenantId, id);
    this.assertOwn(r, author);
    const rows = await this.db
      .select({ rc: noticeReceipts, g: guardians })
      .from(noticeReceipts)
      .innerJoin(guardians, eq(guardians.id, noticeReceipts.guardianId))
      .where(and(eq(noticeReceipts.tenantId, tenantId), eq(noticeReceipts.noticeId, id)))
      .orderBy(desc(noticeReceipts.readAt));
    return {
      data: rows.map(({ rc, g }) => ({
        guardian_id: g.id,
        guardian_name: [g.firstName, g.lastName].filter(Boolean).join(' '),
        phone: g.phone,
        read_at: rc.readAt.toISOString(),
        acknowledged_at: rc.acknowledgedAt?.toISOString() ?? null,
      })),
    };
  }

  async create(
    tenantId: string,
    input: z.infer<typeof CreateNoticeBody>,
    author: Author,
    actor: Actor,
  ) {
    const now = this.deps.clock.now();
    const aud = await this.audienceOf(tenantId, input, author);
    const id = uuidv7();
    const publishAt = input.publish_at ? new Date(input.publish_at) : now;
    await this.db.transaction(async (tx) => {
      await tx.insert(notices).values({
        id,
        tenantId,
        category: input.category,
        title: input.title,
        summary: input.summary || summaryOf(input.body),
        body: input.body,
        audience: input.audience,
        classIds: aud.classIds,
        sectionIds: aud.sectionIds,
        requiresAcknowledgement: input.requires_acknowledgement,
        eventDate: input.event_date ?? null,
        eventTitle: input.event_title ?? null,
        eventSubtitle: input.event_subtitle ?? null,
        publishAt,
        teacherId: author.kind === 'teacher' ? author.teacherId : null,
        postedByName:
          author.kind === 'teacher' ? author.name : (input.posted_by_name ?? 'School office'),
        createdBy: actor.userId,
        updatedBy: actor.userId,
      });
      await recordChange(tx, actor, tenantId, {
        action: 'NOTICE_CREATED',
        entityType: 'notice',
        entityId: id,
        event: 'notice.created',
        after: {
          category: input.category,
          audience: input.audience,
          publish_at: publishAt.toISOString(),
          by: author.kind,
        },
      });
    });
    return this.get(tenantId, id, author);
  }

  async update(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateNoticeBody>,
    author: Author,
    actor: Actor,
  ) {
    const current = await this.load(tenantId, id);
    this.assertOwn(current, author);
    if (current.status === 'CANCELLED')
      throw new BusinessRuleError('INVALID_STATE', 'A withdrawn notice cannot be edited');
    const audience = input.audience ?? current.audience;
    const aud =
      input.audience || input.class_ids || input.section_ids
        ? await this.audienceOf(
            tenantId,
            {
              audience,
              class_ids: input.class_ids ?? current.classIds ?? [],
              section_ids: input.section_ids ?? current.sectionIds ?? [],
            },
            author,
          )
        : { classIds: current.classIds, sectionIds: current.sectionIds };
    await this.db.transaction(async (tx) => {
      const r = await this.load(tenantId, id, tx, true);
      if (r.version !== input.version) throw new ConflictError();
      const body = input.body ?? r.body;
      await tx
        .update(notices)
        .set({
          category: input.category ?? r.category,
          title: input.title ?? r.title,
          body,
          summary: input.summary ?? (input.body ? summaryOf(body) : r.summary),
          audience,
          classIds: aud.classIds,
          sectionIds: aud.sectionIds,
          requiresAcknowledgement: input.requires_acknowledgement ?? r.requiresAcknowledgement,
          eventDate: input.event_date !== undefined ? input.event_date : r.eventDate,
          eventTitle: input.event_title !== undefined ? input.event_title : r.eventTitle,
          eventSubtitle:
            input.event_subtitle !== undefined ? input.event_subtitle : r.eventSubtitle,
          publishAt: input.publish_at ? new Date(input.publish_at) : r.publishAt,
          postedByName:
            author.kind === 'office' && input.posted_by_name
              ? input.posted_by_name
              : r.postedByName,
          updatedBy: actor.userId,
          version: r.version + 1,
        })
        .where(eq(notices.id, id));
      await recordChange(tx, actor, tenantId, {
        action: 'NOTICE_UPDATED',
        entityType: 'notice',
        entityId: id,
        event: 'notice.updated',
        before: { title: r.title, audience: r.audience },
        after: { title: input.title ?? r.title, audience },
      });
    });
    return this.get(tenantId, id, author);
  }

  /** Withdraw a notice: it disappears from the parent app. */
  async cancel(
    tenantId: string,
    id: string,
    reason: string | undefined,
    author: Author,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const r = await this.load(tenantId, id, tx, true);
      this.assertOwn(r, author);
      if (r.status === 'CANCELLED')
        throw new BusinessRuleError('INVALID_STATE', 'This notice was already withdrawn');
      await tx
        .update(notices)
        .set({
          status: 'CANCELLED',
          cancelledAt: this.deps.clock.now(),
          cancelReason: reason ?? null,
          updatedBy: actor.userId,
          version: r.version + 1,
        })
        .where(eq(notices.id, id));
      await recordChange(tx, actor, tenantId, {
        action: 'NOTICE_CANCELLED',
        entityType: 'notice',
        entityId: id,
        event: 'notice.cancelled',
        reason,
      });
    });
    return this.get(tenantId, id, author);
  }

  async setAttachment(
    tenantId: string,
    id: string,
    data: unknown,
    filename: string | undefined,
    author: Author,
    actor: Actor,
  ) {
    const r = await this.load(tenantId, id);
    this.assertOwn(r, author);
    if (r.status === 'CANCELLED')
      throw new BusinessRuleError('INVALID_STATE', 'A withdrawn notice cannot be edited');
    const file = await this.fileSvc.prepare(tenantId, data, {
      allowed: DOCUMENT_TYPES,
      maxBytes: ATTACHMENT_MAX,
      label: 'Attachment',
      filename,
    });
    try {
      await this.db.transaction(async (tx) => {
        const locked = await this.load(tenantId, id, tx, true);
        await this.fileSvc.insert(tx, tenantId, 'NOTICE_ATTACHMENT', file, actor);
        await this.fileSvc.supersede(tx, tenantId, locked.attachmentFileId);
        await tx
          .update(notices)
          .set({ attachmentFileId: file.id, updatedBy: actor.userId, version: locked.version + 1 })
          .where(eq(notices.id, id));
        await recordChange(tx, actor, tenantId, {
          action: 'NOTICE_ATTACHMENT_SET',
          entityType: 'notice',
          entityId: id,
          after: { file_id: file.id, name: file.name },
        });
      });
    } catch (e) {
      await this.fileSvc.discard(file);
      throw e;
    }
    return this.get(tenantId, id, author);
  }

  async removeAttachment(tenantId: string, id: string, author: Author, actor: Actor) {
    await this.db.transaction(async (tx) => {
      const r = await this.load(tenantId, id, tx, true);
      this.assertOwn(r, author);
      if (!r.attachmentFileId) throw new NotFoundError('Attachment');
      await this.fileSvc.supersede(tx, tenantId, r.attachmentFileId);
      await tx
        .update(notices)
        .set({ attachmentFileId: null, updatedBy: actor.userId, version: r.version + 1 })
        .where(eq(notices.id, id));
      await recordChange(tx, actor, tenantId, {
        action: 'NOTICE_ATTACHMENT_REMOVED',
        entityType: 'notice',
        entityId: id,
      });
    });
    return this.get(tenantId, id, author);
  }

  async attachment(tenantId: string, id: string, author: Author) {
    const r = await this.load(tenantId, id);
    this.assertOwn(r, author);
    if (!r.attachmentFileId) throw new NotFoundError('Attachment');
    return this.fileSvc.read(tenantId, r.attachmentFileId);
  }

  // ---- parent app -------------------------------------------------------------------------

  /** Published, active notices that reach at least one of these children. */
  private reach(children: ChildPlacement[]): SQL {
    const classIds = [...new Set(children.map((c) => c.classId).filter((x): x is string => !!x))];
    const sectionIds = [
      ...new Set(children.map((c) => c.sectionId).filter((x): x is string => !!x)),
    ];
    const parts: SQL[] = [sql`${notices.audience} = 'SCHOOL'`];
    if (classIds.length)
      parts.push(
        sql`(${notices.audience} = 'CLASSES' and (${sql.join(
          classIds.map((id) => jsonHas(notices.classIds, id)),
          sql` or `,
        )}))`,
      );
    if (sectionIds.length)
      parts.push(
        sql`(${notices.audience} = 'SECTIONS' and (${sql.join(
          sectionIds.map((id) => jsonHas(notices.sectionIds, id)),
          sql` or `,
        )}))`,
      );
    return sql`(${sql.join(parts, sql` or `)})`;
  }

  private concerns(r: Row, children: ChildPlacement[]) {
    if (r.audience === 'SCHOOL') return children;
    if (r.audience === 'CLASSES')
      return children.filter((c) => c.classId && (r.classIds ?? []).includes(c.classId));
    return children.filter((c) => c.sectionId && (r.sectionIds ?? []).includes(c.sectionId));
  }

  private visibleWhere(tenantId: string, children: ChildPlacement[]) {
    return and(
      eq(notices.tenantId, tenantId),
      eq(notices.status, 'ACTIVE'),
      lte(notices.publishAt, this.deps.clock.now()),
      this.reach(children),
    );
  }

  private presentForParent(
    n: ReturnType<NoticeService['present']>,
    r: Row,
    rc: typeof noticeReceipts.$inferSelect | undefined,
    children: ChildPlacement[],
  ) {
    return {
      id: n.id,
      category: n.category,
      title: n.title,
      summary: n.summary,
      paragraphs: n.paragraphs,
      audience_label: n.audience_label,
      posted_at: n.publish_at,
      posted_by: n.posted_by.name,
      attachment: n.attachment,
      requires_acknowledgement: n.requires_acknowledgement,
      event_date: n.event_date,
      event_title: n.event_title,
      event_subtitle: n.event_subtitle,
      read: !!rc,
      read_at: rc?.readAt.toISOString() ?? null,
      acknowledged: !!rc?.acknowledgedAt,
      acknowledged_at: rc?.acknowledgedAt?.toISOString() ?? null,
      children: this.concerns(r, children).map((c) => ({
        id: c.studentId,
        first_name: c.firstName,
      })),
    };
  }

  async parentList(
    tenantId: string,
    guardianId: string,
    children: ChildPlacement[],
    q: z.infer<typeof ParentNoticeQuery>,
  ) {
    const scope = q.child_id ? children.filter((c) => c.studentId === q.child_id) : children;
    if (q.child_id && !scope.length) throw new NotFoundError('Student');
    const receiptJoin = and(
      eq(noticeReceipts.tenantId, notices.tenantId),
      eq(noticeReceipts.noticeId, notices.id),
      eq(noticeReceipts.guardianId, guardianId),
    );
    const where = and(
      this.visibleWhere(tenantId, scope),
      q.category ? eq(notices.category, q.category) : undefined,
      q.unread ? isNull(noticeReceipts.id) : undefined,
    );
    const [rows, [total], [unread]] = await Promise.all([
      this.db
        .select({ n: notices, rc: noticeReceipts })
        .from(notices)
        .leftJoin(noticeReceipts, receiptJoin)
        .where(where)
        .orderBy(desc(notices.publishAt))
        .limit(q.page_size)
        .offset((q.page - 1) * q.page_size),
      this.db
        .select({ n: count() })
        .from(notices)
        .leftJoin(noticeReceipts, receiptJoin)
        .where(where),
      this.db
        .select({ n: count() })
        .from(notices)
        .leftJoin(noticeReceipts, receiptJoin)
        .where(and(this.visibleWhere(tenantId, scope), isNull(noticeReceipts.id))),
    ]);
    const presented = await this.presentMany(
      tenantId,
      rows.map((x) => x.n),
    );
    return {
      data: presented.map((n, i) =>
        this.presentForParent(n, rows[i]!.n, rows[i]!.rc ?? undefined, children),
      ),
      meta: {
        page: q.page,
        page_size: q.page_size,
        total: Number(total?.n ?? 0),
        unread: Number(unread?.n ?? 0),
      },
    };
  }

  private async loadVisible(tenantId: string, id: string, children: ChildPlacement[]) {
    const [r] = await this.db
      .select()
      .from(notices)
      .where(and(eq(notices.id, id), this.visibleWhere(tenantId, children)));
    if (!r) throw new NotFoundError('Notice');
    return r;
  }

  private async receiptOf(tenantId: string, id: string, guardianId: string) {
    const [rc] = await this.db
      .select()
      .from(noticeReceipts)
      .where(
        and(
          eq(noticeReceipts.tenantId, tenantId),
          eq(noticeReceipts.noticeId, id),
          eq(noticeReceipts.guardianId, guardianId),
        ),
      );
    return rc;
  }

  async parentGet(tenantId: string, guardianId: string, children: ChildPlacement[], id: string) {
    const r = await this.loadVisible(tenantId, id, children);
    const [n] = await this.presentMany(tenantId, [r]);
    return this.presentForParent(n!, r, await this.receiptOf(tenantId, id, guardianId), children);
  }

  private async upsertRead(tenantId: string, ids: string[], guardianId: string) {
    if (!ids.length) return;
    await this.db
      .insert(noticeReceipts)
      .values(ids.map((noticeId) => ({ id: uuidv7(), tenantId, noticeId, guardianId })))
      .onDuplicateKeyUpdate({ set: { noticeId: sql`${noticeReceipts.noticeId}` } });
  }

  async markRead(tenantId: string, guardianId: string, children: ChildPlacement[], id: string) {
    await this.loadVisible(tenantId, id, children);
    await this.upsertRead(tenantId, [id], guardianId);
    return this.parentGet(tenantId, guardianId, children, id);
  }

  async markAllRead(tenantId: string, guardianId: string, children: ChildPlacement[]) {
    const rows = await this.db
      .select({ id: notices.id })
      .from(notices)
      .leftJoin(
        noticeReceipts,
        and(
          eq(noticeReceipts.tenantId, notices.tenantId),
          eq(noticeReceipts.noticeId, notices.id),
          eq(noticeReceipts.guardianId, guardianId),
        ),
      )
      .where(and(this.visibleWhere(tenantId, children), isNull(noticeReceipts.id)));
    await this.upsertRead(
      tenantId,
      rows.map((r) => r.id),
      guardianId,
    );
    return { marked: rows.length };
  }

  async acknowledge(
    tenantId: string,
    guardianId: string,
    children: ChildPlacement[],
    id: string,
    actor: Actor,
  ) {
    const r = await this.loadVisible(tenantId, id, children);
    if (!r.requiresAcknowledgement)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'This notice does not ask for acknowledgement',
      );
    await this.upsertRead(tenantId, [id], guardianId);
    const rc = await this.receiptOf(tenantId, id, guardianId);
    if (!rc!.acknowledgedAt)
      await this.db.transaction(async (tx) => {
        await tx
          .update(noticeReceipts)
          .set({ acknowledgedAt: this.deps.clock.now(), acknowledgedBy: actor.userId })
          .where(eq(noticeReceipts.id, rc!.id));
        await recordChange(tx, actor, tenantId, {
          action: 'NOTICE_ACKNOWLEDGED',
          entityType: 'notice',
          entityId: id,
          after: { guardian_id: guardianId },
        });
      });
    return this.parentGet(tenantId, guardianId, children, id);
  }

  async parentAttachment(tenantId: string, children: ChildPlacement[], id: string) {
    const r = await this.loadVisible(tenantId, id, children);
    if (!r.attachmentFileId) throw new NotFoundError('Attachment');
    return this.fileSvc.read(tenantId, r.attachmentFileId);
  }

  /** Dated notices from today on, for the parent app's "Coming up". */
  async upcomingEvents(tenantId: string, children: ChildPlacement[], from: string) {
    const rows = await this.db
      .select()
      .from(notices)
      .where(
        and(
          this.visibleWhere(tenantId, children),
          isNotNull(notices.eventDate),
          sql`${notices.eventDate} >= ${from}`,
        ),
      )
      .orderBy(notices.eventDate)
      .limit(20);
    return rows.map((r) => ({
      date: r.eventDate!,
      title: r.eventTitle ?? r.title,
      subtitle: r.eventSubtitle ?? '',
      notice_id: r.id,
      children: this.concerns(r, children).map((c) => ({
        id: c.studentId,
        first_name: c.firstName,
      })),
    }));
  }
}
