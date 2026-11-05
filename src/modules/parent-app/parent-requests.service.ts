import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import {
  guardians,
  memberships,
  parentMessageReplies,
  parentMessages,
  students,
  studentChangeRequests,
  users,
  type FieldChange,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
  isDuplicateKeyError,
} from '../../shared/errors.js';
import type { StudentService } from '../students/students.service.js';
import {
  STUDENT_REQUEST_FIELDS,
  type ChangeRequestListQuery,
  type CreateChangeRequestBody,
  type CreateParentMessageBody,
  type ParentMessageListQuery,
  type UpdateParentMessageBody,
  type UpdateParentProfileBody,
} from './parent-requests.schemas.js';

type GuardianRow = typeof guardians.$inferSelect;
type StudentRow = typeof students.$inferSelect;
type RequestRow = typeof studentChangeRequests.$inferSelect;
type MessageRow = typeof parentMessages.$inferSelect;

const nameOf = (p: { firstName: string; middleName?: string | null; lastName: string }) =>
  [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ');

/** The student's value of a parent-editable field, in API form. */
function studentValue(s: StudentRow, field: string): unknown {
  switch (field) {
    case 'first_name':
      return s.firstName;
    case 'middle_name':
      return s.middleName;
    case 'last_name':
      return s.lastName;
    case 'preferred_name':
      return s.preferredName;
    case 'date_of_birth':
      return s.dateOfBirth;
    case 'gender':
      return s.gender;
    case 'primary_email':
      return s.primaryEmail;
    case 'primary_phone':
      return s.primaryPhone;
    case 'nationality':
      return s.nationality;
    case 'address':
      return s.address ?? null;
    case 'blood_group':
      return s.bloodGroup;
    default:
      return null;
  }
}

/** Compares values ignoring key order and empty parts ({ city: 'Pune', line2: null } = { city: 'Pune' }). */
function canonical(v: unknown): unknown {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'object' || Array.isArray(v)) return v;
  const entries = Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => [k, canonical(x)] as const)
    .filter(([, x]) => x !== null)
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? Object.fromEntries(entries) : null;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** The parent's own details, as the parent app shows them. */
export function presentParentProfile(
  g: GuardianRow,
  login: { email: string; loginPhone: string | null } | null,
) {
  return {
    guardian_id: g.id,
    first_name: g.firstName,
    middle_name: g.middleName,
    last_name: g.lastName,
    full_name: nameOf(g),
    email: g.email,
    phone: g.phone,
    sign_in: {
      mobile: login?.loginPhone ? `+${login.loginPhone}` : null,
      email: login && !login.email.endsWith('@parents.invalid') ? login.email : null,
    },
    address: g.address ?? null,
    occupation: g.occupation,
    preferred_channel: g.preferredChannel,
    notify_email: g.notifyEmail,
    notify_sms: g.notifySms,
    notify_whatsapp: g.notifyWhatsapp,
    preferred_language: g.preferredLanguage,
    version: g.version,
  };
}

/**
 * What a parent sends to the school from the parent app (0046):
 * - edits to their own details (saved at once; the sign-in number stays with the school),
 * - requests to change a child's details (the office approves before anything changes),
 * - complaints, feedback and suggestions, with a reply thread.
 */
export class ParentRequestService {
  constructor(
    private readonly deps: Deps,
    private readonly studentsSvc: StudentService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  // ================================================================ own profile

  async profile(tenantId: string, guardianId: string, userId: string) {
    const [g] = await this.db
      .select()
      .from(guardians)
      .where(and(eq(guardians.tenantId, tenantId), eq(guardians.id, guardianId)));
    if (!g) throw new NotFoundError('Guardian');
    const [u] = await this.db
      .select({ email: users.email, loginPhone: users.loginPhone })
      .from(users)
      .where(eq(users.id, userId));
    return presentParentProfile(g, u ?? null);
  }

  async updateProfile(
    tenantId: string,
    guardianId: string,
    userId: string,
    input: z.infer<typeof UpdateParentProfileBody>,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(guardians)
        .where(and(eq(guardians.tenantId, tenantId), eq(guardians.id, guardianId)))
        .for('update');
      if (!before) throw new NotFoundError('Guardian');
      if (before.version !== input.version)
        throw new ConflictError('CONFLICT', undefined, { current_version: before.version });
      const pick = <T>(v: T | undefined, cur: T) => (v === undefined ? cur : v);
      await tx
        .update(guardians)
        .set({
          firstName: input.first_name ?? before.firstName,
          middleName: pick(input.middle_name, before.middleName),
          lastName: input.last_name ?? before.lastName,
          email: pick(input.email, before.email),
          address: pick(input.address, before.address),
          occupation: pick(input.occupation, before.occupation),
          preferredChannel: pick(input.preferred_channel, before.preferredChannel),
          notifyEmail: input.notify_email ?? before.notifyEmail,
          notifySms: input.notify_sms ?? before.notifySms,
          notifyWhatsapp: input.notify_whatsapp ?? before.notifyWhatsapp,
          preferredLanguage: pick(input.preferred_language, before.preferredLanguage),
          version: before.version + 1,
        })
        .where(eq(guardians.id, guardianId));
      // The login's display name follows the parent's name.
      if (input.first_name || input.last_name)
        await tx
          .update(users)
          .set({
            firstName: input.first_name ?? before.firstName,
            lastName: input.last_name ?? before.lastName,
          })
          .where(eq(users.id, userId));
      const [after] = await tx.select().from(guardians).where(eq(guardians.id, guardianId));
      await recordChange(tx, actor, tenantId, {
        action: 'GUARDIAN_UPDATED_BY_PARENT',
        entityType: 'guardian',
        entityId: guardianId,
        event: 'guardian.updated',
        before: presentParentProfile(before, null),
        after: presentParentProfile(after!, null),
        reason: 'Updated by the parent in the parent app',
      });
    });
    return this.profile(tenantId, guardianId, userId);
  }

  // ================================================================ child detail requests

  private async student(tenantId: string, id: string) {
    const [s] = await this.db
      .select()
      .from(students)
      .where(and(eq(students.tenantId, tenantId), eq(students.id, id)));
    if (!s) throw new NotFoundError('Student');
    return s;
  }

  private presentRequest(
    r: RequestRow,
    extra: { student?: StudentRow; guardian?: GuardianRow; decidedBy?: string | null } = {},
  ) {
    return {
      id: r.id,
      student_id: r.studentId,
      student_name: extra.student ? nameOf(extra.student) : undefined,
      student_number: extra.student?.studentNumber,
      guardian_id: r.guardianId,
      guardian_name: extra.guardian ? nameOf(extra.guardian) : undefined,
      guardian_phone: extra.guardian?.phone,
      changes: r.changes,
      note: r.note,
      status: r.status,
      decided_at: r.decidedAt?.toISOString() ?? null,
      decided_by: extra.decidedBy ?? null,
      decision_note: r.decisionNote,
      version: r.version,
      created_at: r.createdAt.toISOString(),
    };
  }

  /** The child's editable details, plus the parent's requests about them. */
  async childDetails(tenantId: string, guardianId: string, studentId: string) {
    const s = await this.student(tenantId, studentId);
    const rows = await this.db
      .select()
      .from(studentChangeRequests)
      .where(
        and(
          eq(studentChangeRequests.tenantId, tenantId),
          eq(studentChangeRequests.studentId, studentId),
          eq(studentChangeRequests.guardianId, guardianId),
        ),
      )
      .orderBy(desc(studentChangeRequests.createdAt))
      .limit(20);
    return {
      student_id: s.id,
      fields: Object.fromEntries(STUDENT_REQUEST_FIELDS.map((f) => [f, studentValue(s, f)])),
      pending: rows.some((r) => r.status === 'PENDING'),
      requests: rows.map((r) => this.presentRequest(r)),
    };
  }

  async requestChange(
    tenantId: string,
    guardianId: string,
    studentId: string,
    input: z.infer<typeof CreateChangeRequestBody>,
    actor: Actor,
  ) {
    const s = await this.student(tenantId, studentId);
    const changes: Record<string, FieldChange> = {};
    for (const [field, to] of Object.entries(input.changes)) {
      if (to === undefined) continue;
      const from = studentValue(s, field);
      if (!same(from, to)) changes[field] = { from: from ?? null, to: to ?? null };
    }
    if (!Object.keys(changes).length)
      throw new ValidationError(
        'Nothing to change: the new values are the same as the current ones',
      );
    const [open] = await this.db
      .select({ id: studentChangeRequests.id })
      .from(studentChangeRequests)
      .where(
        and(
          eq(studentChangeRequests.tenantId, tenantId),
          eq(studentChangeRequests.studentId, studentId),
          eq(studentChangeRequests.guardianId, guardianId),
          eq(studentChangeRequests.status, 'PENDING'),
        ),
      );
    if (open)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'You already have a request waiting for the school. Cancel it to send a new one.',
        { request_id: open.id },
      );
    const id = uuidv7();
    await this.db.transaction(async (tx) => {
      await tx.insert(studentChangeRequests).values({
        id,
        tenantId,
        studentId,
        guardianId,
        changes,
        note: input.note ?? null,
        requestedBy: actor.userId,
      });
      await recordChange(tx, actor, tenantId, {
        action: 'STUDENT_CHANGE_REQUESTED',
        entityType: 'student',
        entityId: studentId,
        event: 'student.change_requested',
        after: { request_id: id, fields: Object.keys(changes) },
      });
    });
    return this.childDetails(tenantId, guardianId, studentId);
  }

  async cancelRequest(tenantId: string, guardianId: string, requestId: string, actor: Actor) {
    const r = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(studentChangeRequests)
        .where(
          and(
            eq(studentChangeRequests.tenantId, tenantId),
            eq(studentChangeRequests.id, requestId),
            eq(studentChangeRequests.guardianId, guardianId),
          ),
        )
        .for('update');
      if (!row) throw new NotFoundError('Request');
      if (row.status !== 'PENDING')
        throw new BusinessRuleError('INVALID_STATE', 'Only a waiting request can be cancelled');
      await tx
        .update(studentChangeRequests)
        .set({ status: 'CANCELLED', version: row.version + 1 })
        .where(eq(studentChangeRequests.id, row.id));
      await recordChange(tx, actor, tenantId, {
        action: 'STUDENT_CHANGE_REQUEST_CANCELLED',
        entityType: 'student',
        entityId: row.studentId,
        after: { request_id: row.id },
      });
      return row;
    });
    return this.childDetails(tenantId, guardianId, r.studentId);
  }

  // ---- office ----

  async listRequests(tenantId: string, q: z.infer<typeof ChangeRequestListQuery>) {
    const where = and(
      eq(studentChangeRequests.tenantId, tenantId),
      q.status ? eq(studentChangeRequests.status, q.status) : undefined,
      q.student_id ? eq(studentChangeRequests.studentId, q.student_id) : undefined,
    );
    const [rows, [total], [pending]] = await Promise.all([
      this.db
        .select({ r: studentChangeRequests, s: students, g: guardians })
        .from(studentChangeRequests)
        .innerJoin(students, eq(students.id, studentChangeRequests.studentId))
        .innerJoin(guardians, eq(guardians.id, studentChangeRequests.guardianId))
        .where(where)
        .orderBy(desc(studentChangeRequests.createdAt))
        .limit(q.page_size)
        .offset((q.page - 1) * q.page_size),
      this.db.select({ n: count() }).from(studentChangeRequests).where(where),
      this.db
        .select({ n: count() })
        .from(studentChangeRequests)
        .where(
          and(
            eq(studentChangeRequests.tenantId, tenantId),
            eq(studentChangeRequests.status, 'PENDING'),
          ),
        ),
    ]);
    return {
      data: rows.map((x) => this.presentRequest(x.r, { student: x.s, guardian: x.g })),
      meta: {
        page: q.page,
        page_size: q.page_size,
        total: Number(total?.n ?? 0),
        pending: Number(pending?.n ?? 0),
      },
    };
  }

  async getRequest(tenantId: string, id: string) {
    const [x] = await this.db
      .select({ r: studentChangeRequests, s: students, g: guardians })
      .from(studentChangeRequests)
      .innerJoin(students, eq(students.id, studentChangeRequests.studentId))
      .innerJoin(guardians, eq(guardians.id, studentChangeRequests.guardianId))
      .where(and(eq(studentChangeRequests.tenantId, tenantId), eq(studentChangeRequests.id, id)));
    if (!x) throw new NotFoundError('Request');
    let decidedBy: string | null = null;
    if (x.r.decidedBy) {
      const [u] = await this.db.select().from(users).where(eq(users.id, x.r.decidedBy));
      decidedBy = u ? `${u.firstName} ${u.lastName}`.trim() : null;
    }
    // Current values next to the requested ones, so the office sees what changes.
    return {
      ...this.presentRequest(x.r, { student: x.s, guardian: x.g, decidedBy }),
      current: Object.fromEntries(Object.keys(x.r.changes).map((f) => [f, studentValue(x.s, f)])),
    };
  }

  async decide(
    tenantId: string,
    id: string,
    approve: boolean,
    note: string | undefined,
    principal: Principal,
    actor: Actor,
  ) {
    const [r] = await this.db
      .select()
      .from(studentChangeRequests)
      .where(and(eq(studentChangeRequests.tenantId, tenantId), eq(studentChangeRequests.id, id)));
    if (!r) throw new NotFoundError('Request');
    if (r.status !== 'PENDING')
      throw new BusinessRuleError('INVALID_STATE', 'This request was already decided');
    if (approve) {
      const s = await this.student(tenantId, r.studentId);
      const values = Object.fromEntries(Object.entries(r.changes).map(([f, c]) => [f, c.to]));
      // The normal student edit: same validation, scope, history and audit as the office's own edits.
      await this.studentsSvc.update(
        tenantId,
        s.id,
        { version: s.version, ...values } as never,
        principal,
        actor,
      );
    }
    await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(studentChangeRequests)
        .where(eq(studentChangeRequests.id, id))
        .for('update');
      if (locked!.status !== 'PENDING') throw new ConflictError();
      await tx
        .update(studentChangeRequests)
        .set({
          status: approve ? 'APPROVED' : 'REJECTED',
          decidedBy: actor.userId,
          decidedAt: this.deps.clock.now(),
          decisionNote: note ?? null,
          version: locked!.version + 1,
        })
        .where(eq(studentChangeRequests.id, id));
      await recordChange(tx, actor, tenantId, {
        action: approve ? 'STUDENT_CHANGE_REQUEST_APPROVED' : 'STUDENT_CHANGE_REQUEST_REJECTED',
        entityType: 'student',
        entityId: r.studentId,
        event: approve ? 'student.change_request_approved' : 'student.change_request_rejected',
        after: { request_id: id, fields: Object.keys(r.changes) },
        reason: note,
      });
    });
    return this.getRequest(tenantId, id);
  }

  // ================================================================ complaints & feedback

  private async nextReference(tenantId: string, kind: MessageRow['kind']) {
    const prefix = kind === 'COMPLAINT' ? 'CMP' : kind === 'SUGGESTION' ? 'SUG' : 'FBK';
    const year = this.deps.clock.now().getUTCFullYear();
    const [r] = await this.db
      .select({ n: count() })
      .from(parentMessages)
      .where(and(eq(parentMessages.tenantId, tenantId), eq(parentMessages.kind, kind)));
    return `${prefix}-${year}-${String(Number(r?.n ?? 0) + 1).padStart(5, '0')}`;
  }

  private async names(rows: MessageRow[]) {
    const gIds = [...new Set(rows.map((r) => r.guardianId))];
    const sIds = [...new Set(rows.map((r) => r.studentId).filter((x): x is string => !!x))];
    const uIds = [...new Set(rows.map((r) => r.assignedTo).filter((x): x is string => !!x))];
    const [gs, ss, us] = await Promise.all([
      gIds.length ? this.db.select().from(guardians).where(inArray(guardians.id, gIds)) : [],
      sIds.length ? this.db.select().from(students).where(inArray(students.id, sIds)) : [],
      uIds.length ? this.db.select().from(users).where(inArray(users.id, uIds)) : [],
    ]);
    return {
      guardian: new Map(gs.map((g) => [g.id, g])),
      student: new Map(ss.map((s) => [s.id, s])),
      user: new Map(us.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()])),
    };
  }

  private presentMessage(
    r: MessageRow,
    n: Awaited<ReturnType<ParentRequestService['names']>>,
    side: 'school' | 'parent',
  ) {
    const g = n.guardian.get(r.guardianId);
    const s = r.studentId ? n.student.get(r.studentId) : undefined;
    return {
      id: r.id,
      reference_number: r.referenceNumber,
      kind: r.kind,
      topic: r.topic,
      subject: r.subject,
      body: r.body,
      status: r.status,
      student: s ? { id: s.id, full_name: nameOf(s), student_number: s.studentNumber } : null,
      guardian:
        side === 'school' && g
          ? { id: g.id, full_name: nameOf(g), phone: g.phone, email: g.email }
          : undefined,
      assigned_to:
        side === 'school' && r.assignedTo
          ? { user_id: r.assignedTo, name: n.user.get(r.assignedTo) ?? null }
          : null,
      unread: side === 'school' ? r.unreadBySchool : r.unreadByParent,
      last_activity_at: r.lastActivityAt.toISOString(),
      resolved_at: r.resolvedAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
      version: r.version,
    };
  }

  private async replies(tenantId: string, messageId: string) {
    const rows = await this.db
      .select()
      .from(parentMessageReplies)
      .where(
        and(
          eq(parentMessageReplies.tenantId, tenantId),
          eq(parentMessageReplies.messageId, messageId),
        ),
      )
      .orderBy(parentMessageReplies.createdAt);
    return rows.map((x) => ({
      id: x.id,
      author: x.author,
      author_name: x.authorName,
      body: x.body,
      created_at: x.createdAt.toISOString(),
    }));
  }

  // ---- parent ----

  async parentList(
    tenantId: string,
    guardianId: string,
    q: z.infer<typeof ParentMessageListQuery>,
  ) {
    const where = and(
      eq(parentMessages.tenantId, tenantId),
      eq(parentMessages.guardianId, guardianId),
      q.kind ? eq(parentMessages.kind, q.kind) : undefined,
      q.status ? eq(parentMessages.status, q.status) : undefined,
    );
    const [rows, [total], [unread]] = await Promise.all([
      this.db
        .select()
        .from(parentMessages)
        .where(where)
        .orderBy(desc(parentMessages.lastActivityAt))
        .limit(q.page_size)
        .offset((q.page - 1) * q.page_size),
      this.db.select({ n: count() }).from(parentMessages).where(where),
      this.db
        .select({ n: count() })
        .from(parentMessages)
        .where(
          and(
            eq(parentMessages.tenantId, tenantId),
            eq(parentMessages.guardianId, guardianId),
            eq(parentMessages.unreadByParent, true),
          ),
        ),
    ]);
    const n = await this.names(rows);
    return {
      data: rows.map((r) => this.presentMessage(r, n, 'parent')),
      meta: {
        page: q.page,
        page_size: q.page_size,
        total: Number(total?.n ?? 0),
        unread: Number(unread?.n ?? 0),
      },
    };
  }

  async parentCreate(
    tenantId: string,
    guardian: GuardianRow,
    childIds: string[],
    input: z.infer<typeof CreateParentMessageBody>,
    actor: Actor,
  ) {
    if (input.student_id && !childIds.includes(input.student_id))
      throw new NotFoundError('Student');
    const now = this.deps.clock.now();
    for (let attempt = 0; ; attempt++) {
      const id = uuidv7();
      const ref = await this.nextReference(tenantId, input.kind);
      try {
        await this.db.transaction(async (tx) => {
          await tx.insert(parentMessages).values({
            id,
            tenantId,
            referenceNumber: ref,
            guardianId: guardian.id,
            studentId: input.student_id ?? null,
            kind: input.kind,
            topic: input.topic,
            subject: input.subject,
            body: input.body,
            lastActivityAt: now,
            createdBy: actor.userId,
          });
          await recordChange(tx, actor, tenantId, {
            action: 'PARENT_MESSAGE_CREATED',
            entityType: 'parent_message',
            entityId: id,
            event: 'parent_message.created',
            after: { kind: input.kind, topic: input.topic, reference: ref },
          });
        });
        return this.parentGet(tenantId, guardian.id, id);
      } catch (e) {
        if (attempt < 3 && isDuplicateKeyError(e)) continue;
        throw e;
      }
    }
  }

  private async loadMessage(tenantId: string, id: string, extra?: SQL) {
    const [r] = await this.db
      .select()
      .from(parentMessages)
      .where(and(eq(parentMessages.tenantId, tenantId), eq(parentMessages.id, id), extra));
    if (!r) throw new NotFoundError('Message');
    return r;
  }

  async parentGet(tenantId: string, guardianId: string, id: string) {
    const r = await this.loadMessage(tenantId, id, eq(parentMessages.guardianId, guardianId));
    if (r.unreadByParent)
      await this.db
        .update(parentMessages)
        .set({ unreadByParent: false })
        .where(eq(parentMessages.id, id));
    const n = await this.names([r]);
    return {
      ...this.presentMessage({ ...r, unreadByParent: false }, n, 'parent'),
      replies: await this.replies(tenantId, id),
    };
  }

  async parentReply(
    tenantId: string,
    guardian: GuardianRow,
    id: string,
    body: string,
    actor: Actor,
  ) {
    const r = await this.loadMessage(tenantId, id, eq(parentMessages.guardianId, guardian.id));
    if (r.status === 'CLOSED')
      throw new BusinessRuleError(
        'INVALID_STATE',
        'This conversation is closed. Send a new message instead.',
      );
    const now = this.deps.clock.now();
    await this.db.transaction(async (tx) => {
      await tx.insert(parentMessageReplies).values({
        id: uuidv7(),
        tenantId,
        messageId: id,
        author: 'PARENT',
        authorUserId: actor.userId,
        authorName: nameOf(guardian),
        body,
      });
      // A parent replying to a resolved one reopens it.
      await tx
        .update(parentMessages)
        .set({
          unreadBySchool: true,
          lastActivityAt: now,
          status: r.status === 'RESOLVED' ? 'OPEN' : r.status,
          version: r.version + 1,
        })
        .where(eq(parentMessages.id, id));
    });
    return this.parentGet(tenantId, guardian.id, id);
  }

  /** The parent closes it (no answer needed any more). */
  async parentClose(tenantId: string, guardianId: string, id: string, actor: Actor) {
    const r = await this.loadMessage(tenantId, id, eq(parentMessages.guardianId, guardianId));
    if (r.status !== 'CLOSED')
      await this.db.transaction(async (tx) => {
        await tx
          .update(parentMessages)
          .set({
            status: 'CLOSED',
            resolvedAt: r.resolvedAt ?? this.deps.clock.now(),
            version: r.version + 1,
          })
          .where(eq(parentMessages.id, id));
        await recordChange(tx, actor, tenantId, {
          action: 'PARENT_MESSAGE_CLOSED_BY_PARENT',
          entityType: 'parent_message',
          entityId: id,
        });
      });
    return this.parentGet(tenantId, guardianId, id);
  }

  // ---- school ----

  /** Complaints are for the principal (feedback.complaints); feedback and suggestions for the office. */
  private visibleKinds(principal: Principal): SQL | undefined {
    return principal.permissions.has('feedback.complaints')
      ? undefined
      : sql`${parentMessages.kind} <> 'COMPLAINT'`;
  }

  private assertKindVisible(r: MessageRow, principal: Principal) {
    if (r.kind === 'COMPLAINT' && !principal.permissions.has('feedback.complaints'))
      throw new NotFoundError('Message');
  }

  async schoolList(
    tenantId: string,
    q: z.infer<typeof ParentMessageListQuery>,
    principal: Principal,
  ) {
    const where = and(
      eq(parentMessages.tenantId, tenantId),
      this.visibleKinds(principal),
      q.kind ? eq(parentMessages.kind, q.kind) : undefined,
      q.status ? eq(parentMessages.status, q.status) : undefined,
      q.topic ? eq(parentMessages.topic, q.topic) : undefined,
      q.unread ? eq(parentMessages.unreadBySchool, true) : undefined,
      q.assigned_to_me ? eq(parentMessages.assignedTo, principal.userId) : undefined,
      q.search
        ? sql`(${parentMessages.subject} like ${`%${q.search}%`} or ${parentMessages.referenceNumber} like ${`%${q.search}%`})`
        : undefined,
    );
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(parentMessages)
        .where(where)
        .orderBy(desc(parentMessages.lastActivityAt))
        .limit(q.page_size)
        .offset((q.page - 1) * q.page_size),
      this.db.select({ n: count() }).from(parentMessages).where(where),
    ]);
    const n = await this.names(rows);
    return {
      data: rows.map((r) => this.presentMessage(r, n, 'school')),
      meta: { page: q.page, page_size: q.page_size, total: Number(total?.n ?? 0) },
    };
  }

  /** Counts for the sidebar badge and the inbox tabs. */
  async summary(tenantId: string, principal: Principal) {
    const rows = await this.db
      .select({
        kind: parentMessages.kind,
        status: parentMessages.status,
        unread: parentMessages.unreadBySchool,
        n: count(),
      })
      .from(parentMessages)
      .where(and(eq(parentMessages.tenantId, tenantId), this.visibleKinds(principal)))
      .groupBy(parentMessages.kind, parentMessages.status, parentMessages.unreadBySchool);
    const sum = (f: (r: (typeof rows)[number]) => boolean) =>
      rows.filter(f).reduce((t, r) => t + Number(r.n), 0);
    return {
      unread: sum((r) => r.unread),
      open: sum((r) => r.status === 'OPEN' || r.status === 'IN_PROGRESS'),
      by_kind: Object.fromEntries(
        (['COMPLAINT', 'FEEDBACK', 'SUGGESTION'] as const).map((k) => [
          k,
          {
            open: sum((r) => r.kind === k && (r.status === 'OPEN' || r.status === 'IN_PROGRESS')),
            total: sum((r) => r.kind === k),
          },
        ]),
      ),
    };
  }

  async schoolGet(tenantId: string, id: string, principal: Principal) {
    const r = await this.loadMessage(tenantId, id);
    this.assertKindVisible(r, principal);
    if (r.unreadBySchool)
      await this.db
        .update(parentMessages)
        .set({ unreadBySchool: false })
        .where(eq(parentMessages.id, id));
    const n = await this.names([r]);
    return {
      ...this.presentMessage({ ...r, unreadBySchool: false }, n, 'school'),
      replies: await this.replies(tenantId, id),
    };
  }

  async schoolReply(
    tenantId: string,
    id: string,
    body: string,
    principal: Principal,
    actor: Actor,
  ) {
    const r = await this.loadMessage(tenantId, id);
    this.assertKindVisible(r, principal);
    if (r.status === 'CLOSED')
      throw new BusinessRuleError('INVALID_STATE', 'This conversation is closed');
    const [u] = await this.db.select().from(users).where(eq(users.id, principal.userId));
    const now = this.deps.clock.now();
    await this.db.transaction(async (tx) => {
      await tx.insert(parentMessageReplies).values({
        id: uuidv7(),
        tenantId,
        messageId: id,
        author: 'SCHOOL',
        authorUserId: principal.userId,
        authorName: u ? `${u.firstName} ${u.lastName}`.trim() : 'School',
        body,
      });
      await tx
        .update(parentMessages)
        .set({
          unreadByParent: true,
          lastActivityAt: now,
          status: r.status === 'OPEN' ? 'IN_PROGRESS' : r.status,
          version: r.version + 1,
        })
        .where(eq(parentMessages.id, id));
      await recordChange(tx, actor, tenantId, {
        action: 'PARENT_MESSAGE_REPLIED',
        entityType: 'parent_message',
        entityId: id,
      });
    });
    return this.schoolGet(tenantId, id, principal);
  }

  async schoolUpdate(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateParentMessageBody>,
    principal: Principal,
    actor: Actor,
  ) {
    const r = await this.loadMessage(tenantId, id);
    this.assertKindVisible(r, principal);
    if (input.assigned_to) {
      const [m] = await this.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, input.assigned_to),
            eq(memberships.tenantKey, tenantId),
            eq(memberships.status, 'ACTIVE'),
          ),
        );
      if (!m) throw new NotFoundError('User');
    }
    const status = input.status ?? r.status;
    await this.db.transaction(async (tx) => {
      await tx
        .update(parentMessages)
        .set({
          status,
          assignedTo: input.assigned_to === undefined ? r.assignedTo : input.assigned_to,
          resolvedAt:
            status === 'RESOLVED' || status === 'CLOSED'
              ? (r.resolvedAt ?? this.deps.clock.now())
              : null,
          // A status change is news for the parent.
          unreadByParent: status !== r.status ? true : r.unreadByParent,
          version: r.version + 1,
        })
        .where(eq(parentMessages.id, id));
      await recordChange(tx, actor, tenantId, {
        action: 'PARENT_MESSAGE_UPDATED',
        entityType: 'parent_message',
        entityId: id,
        before: { status: r.status, assigned_to: r.assignedTo },
        after: {
          status,
          assigned_to: input.assigned_to === undefined ? r.assignedTo : input.assigned_to,
        },
      });
    });
    return this.schoolGet(tenantId, id, principal);
  }
}
