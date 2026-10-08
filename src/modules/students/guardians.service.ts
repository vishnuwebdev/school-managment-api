import { and, asc, count, desc, eq, inArray, like, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  enrollments,
  guardians,
  OPEN_ENROLLMENT_STATUSES,
  studentGuardians,
  students,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { todayIso } from '../../shared/dates.js';
import {
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
} from '../../shared/errors.js';
import { offsetOf, pageOf } from '../../shared/pagination.js';
import type {
  CreateGuardianBody,
  GuardianListQuery,
  LinkGuardianBody,
  UpdateGuardianBody,
  UpdateLinkBody,
} from './students.schemas.js';
import { addHistory, likeOf, loadStudent, studentScope } from './support.js';

type GuardianRow = typeof guardians.$inferSelect;
type LinkRow = typeof studentGuardians.$inferSelect;
type GuardianInput = NonNullable<z.infer<typeof LinkGuardianBody>['guardian']>;

const presentGuardian = (g: GuardianRow) => ({
  id: g.id,
  first_name: g.firstName,
  middle_name: g.middleName,
  last_name: g.lastName,
  full_name: [g.firstName, g.middleName, g.lastName].filter(Boolean).join(' '),
  email: g.email,
  phone: g.phone,
  address: g.address,
  occupation: g.occupation,
  preferred_channel: g.preferredChannel,
  notify_email: g.notifyEmail,
  notify_sms: g.notifySms,
  notify_whatsapp: g.notifyWhatsapp,
  preferred_language: g.preferredLanguage,
  status: g.status,
  has_login: g.userId !== null,
  version: g.version,
  created_at: g.createdAt.toISOString(),
  updated_at: g.updatedAt.toISOString(),
});

const presentLink = (l: LinkRow, g: GuardianRow) => ({
  id: l.id,
  guardian: presentGuardian(g),
  relationship_type: l.relationshipType,
  relationship_label: l.relationshipLabel,
  is_primary: l.isPrimary,
  is_emergency_contact: l.isEmergencyContact,
  can_pick_up: l.canPickUp,
  portal_access_allowed: l.portalAccessAllowed,
  effective_from: l.effectiveFrom,
  effective_until: l.effectiveUntil,
  status: l.status,
  version: l.version,
});

/** Guardians are contact records linked to students; a login is optional and separate. */
export class GuardianService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  // ---- reads -------------------------------------------------------------------

  async forStudent(
    tenantId: string,
    studentId: string,
    principal: Principal,
    includeEnded = false,
    ex: Executor = this.db,
  ) {
    await loadStudent(ex, tenantId, studentId, principal, 'students.read');
    const rows = await ex
      .select({ l: studentGuardians, g: guardians })
      .from(studentGuardians)
      .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
      .where(
        and(
          eq(studentGuardians.tenantId, tenantId),
          eq(studentGuardians.studentId, studentId),
          includeEnded ? undefined : eq(studentGuardians.status, 'ACTIVE'),
        ),
      )
      .orderBy(desc(studentGuardians.isPrimary), asc(studentGuardians.createdAt));
    return rows.map((r) => presentLink(r.l, r.g));
  }

  /** Guardian directory. Scoped users only see guardians of students they may see. */
  async list(tenantId: string, q: z.infer<typeof GuardianListQuery>, principal: Principal) {
    const conds: (SQL | undefined)[] = [eq(guardians.tenantId, tenantId)];
    const scope = studentScope(principal, 'students.read');
    if (scope) {
      conds.push(
        sql`exists (select 1 from ${studentGuardians} inner join ${students} on ${students.id} = ${studentGuardians.studentId} where ${studentGuardians.guardianId} = ${guardians.id} and ${studentGuardians.status} = 'ACTIVE' and ${scope})`,
      );
    }
    if (q.status) conds.push(eq(guardians.status, q.status));
    if (q.search) {
      const s = likeOf(q.search);
      conds.push(
        or(
          like(guardians.firstName, s),
          like(guardians.lastName, s),
          like(guardians.phone, s),
          like(guardians.email, s),
          sql`concat(${guardians.firstName}, ' ', ${guardians.lastName}) like ${s}`,
        ),
      );
    }
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.db
        .select({
          g: guardians,
          children: sql<number>`(select count(*) from student_guardians sg where sg.guardian_id = guardians.id and sg.status = 'ACTIVE')`,
          childNames: sql<
            string | null
          >`(select group_concat(concat(st.first_name, ' ', st.last_name) order by st.first_name separator ', ') from student_guardians sg inner join students st on st.id = sg.student_id where sg.guardian_id = guardians.id and sg.status = 'ACTIVE')`,
        })
        .from(guardians)
        .where(where)
        .orderBy(asc(guardians.lastName), asc(guardians.firstName))
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(guardians).where(where),
    ]);
    return pageOf(
      rows.map((r) => ({
        ...presentGuardian(r.g),
        student_count: Number(r.children),
        student_names: r.childNames,
      })),
      total?.n ?? 0,
      q,
    );
  }

  async get(tenantId: string, id: string, principal: Principal) {
    const [g] = await this.db
      .select()
      .from(guardians)
      .where(and(eq(guardians.id, id), eq(guardians.tenantId, tenantId)));
    if (!g) throw new NotFoundError('Guardian');
    const scope = studentScope(principal, 'students.read');
    const links = await this.db
      .select({ l: studentGuardians, s: students })
      .from(studentGuardians)
      .innerJoin(students, eq(students.id, studentGuardians.studentId))
      .where(
        and(
          eq(studentGuardians.tenantId, tenantId),
          eq(studentGuardians.guardianId, id),
          eq(studentGuardians.status, 'ACTIVE'),
          scope,
        ),
      );
    // A scoped user may not learn that an unrelated guardian exists.
    if (scope && links.length === 0) throw new NotFoundError('Guardian');
    const placements = await this.placements(
      tenantId,
      links.map((r) => r.s.id),
    );
    return {
      ...presentGuardian(g),
      students: links.map((r) => ({
        link_id: r.l.id,
        student_id: r.s.id,
        student_number: r.s.studentNumber,
        full_name: [r.s.firstName, r.s.middleName, r.s.lastName].filter(Boolean).join(' '),
        status: r.s.status,
        relationship_type: r.l.relationshipType,
        relationship_label: r.l.relationshipLabel,
        is_primary: r.l.isPrimary,
        is_emergency_contact: r.l.isEmergencyContact,
        can_pick_up: r.l.canPickUp,
        portal_access_allowed: r.l.portalAccessAllowed,
        class_name: placements.get(r.s.id)?.className ?? null,
        section_name: placements.get(r.s.id)?.sectionName ?? null,
      })),
    };
  }

  /** Current (open) class and section of each student; the current academic year wins. */
  private async placements(tenantId: string, ids: string[]) {
    const out = new Map<string, { className: string; sectionName: string | null }>();
    if (!ids.length) return out;
    const rows = await this.db
      .select({
        studentId: enrollments.studentId,
        className: academicClasses.name,
        sectionName: academicSections.name,
      })
      .from(enrollments)
      .innerJoin(academicYears, eq(academicYears.id, enrollments.academicYearId))
      .innerJoin(academicClasses, eq(academicClasses.id, enrollments.classId))
      .leftJoin(academicSections, eq(academicSections.id, enrollments.sectionId))
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          inArray(enrollments.studentId, ids),
          inArray(enrollments.status, [...OPEN_ENROLLMENT_STATUSES]),
        ),
      )
      .orderBy(desc(academicYears.isCurrent), desc(academicYears.startDate));
    for (const r of rows)
      if (!out.has(r.studentId))
        out.set(r.studentId, { className: r.className, sectionName: r.sectionName });
    return out;
  }

  // ---- commands ----------------------------------------------------------------

  async createInTx(tx: Executor, tenantId: string, input: GuardianInput, actor: Actor) {
    const [ins] = await tx
      .insert(guardians)
      .values({
        tenantId,
        firstName: input.first_name,
        middleName: input.middle_name ?? null,
        lastName: input.last_name,
        email: input.email ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        occupation: input.occupation ?? null,
        preferredChannel: input.preferred_channel ?? null,
        notifyEmail: input.notify_email ?? true,
        notifySms: input.notify_sms ?? true,
        notifyWhatsapp: input.notify_whatsapp ?? false,
        preferredLanguage: input.preferred_language ?? null,
        createdBy: actor.userId,
      })
      .$returningId();
    const [row] = await tx.select().from(guardians).where(eq(guardians.id, ins!.id));
    await recordChange(tx, actor, tenantId, {
      action: 'GUARDIAN_CREATED',
      entityType: 'guardian',
      entityId: row!.id,
      event: 'guardian.created',
      after: presentGuardian(row!),
    });
    return row!;
  }

  /**
   * Create a parent with no child yet. Parents are reusable across children, so a parent who
   * already has the same phone or email is reported (409 with the matches) unless the caller
   * confirms the duplicate.
   */
  async create(
    tenantId: string,
    input: z.infer<typeof CreateGuardianBody>,
    principal: Principal,
    actor: Actor,
  ) {
    // A parent with no child yet is outside every class scope, so only school-wide managers add them.
    if (studentScope(principal, 'students.guardians.manage'))
      throw new AuthorizationError(
        'PERMISSION_DENIED',
        'Adding a parent without a student needs school-wide access',
      );
    const { confirm_duplicate: confirm, ...fields } = input;
    if (!confirm) {
      const same: SQL[] = [];
      if (fields.phone) same.push(eq(guardians.phone, fields.phone));
      if (fields.email) same.push(eq(guardians.email, fields.email));
      if (same.length) {
        const matches = await this.db
          .select()
          .from(guardians)
          .where(and(eq(guardians.tenantId, tenantId), eq(guardians.status, 'ACTIVE'), or(...same)))
          .limit(5);
        if (matches.length)
          throw new ConflictError(
            'DUPLICATE_RESOURCE',
            'A parent with the same phone or email already exists. Link that parent instead, or confirm to create a new record.',
            { matches: matches.map(presentGuardian) },
          );
      }
    }
    const row = await this.db.transaction((tx) => this.createInTx(tx, tenantId, fields, actor));
    return { ...presentGuardian(row), students: [] };
  }

  /** Link a guardian to a student inside the caller's transaction (student already locked). */
  async linkInTx(
    tx: Executor,
    tenantId: string,
    studentId: string,
    input: z.infer<typeof LinkGuardianBody>,
    actor: Actor,
  ) {
    let guardian: GuardianRow;
    if (input.guardian_id) {
      const [g] = await tx
        .select()
        .from(guardians)
        .where(and(eq(guardians.id, input.guardian_id), eq(guardians.tenantId, tenantId)));
      if (!g) throw new NotFoundError('Guardian');
      if (g.status !== 'ACTIVE')
        throw new BusinessRuleError('INVALID_STATE', 'That guardian is archived');
      guardian = g;
    } else {
      guardian = await this.createInTx(tx, tenantId, input.guardian!, actor);
    }
    const [{ n: active } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(studentGuardians)
      .where(
        and(
          eq(studentGuardians.tenantId, tenantId),
          eq(studentGuardians.studentId, studentId),
          eq(studentGuardians.status, 'ACTIVE'),
        ),
      );
    // The first guardian of a student is their primary contact unless told otherwise.
    const makePrimary = input.is_primary ?? active === 0;
    if (makePrimary) await this.demotePrimary(tx, tenantId, studentId);
    let linkId: string;
    try {
      const [ins] = await tx
        .insert(studentGuardians)
        .values({
          tenantId,
          studentId,
          guardianId: guardian.id,
          relationshipType: input.relationship_type,
          relationshipLabel: input.relationship_label ?? null,
          isPrimary: makePrimary,
          isEmergencyContact: input.is_emergency_contact ?? false,
          canPickUp: input.can_pick_up ?? false,
          portalAccessAllowed: input.portal_access_allowed ?? false,
          effectiveFrom: todayIso(this.deps.clock),
          createdBy: actor.userId,
        })
        .$returningId();
      linkId = ins!.id;
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw new ConflictError(
          'DUPLICATE_RESOURCE',
          'This guardian is already linked to the student',
        );
      throw err;
    }
    await addHistory(tx, actor, tenantId, studentId, {
      eventType: 'GUARDIAN_LINKED',
      details: {
        guardian: `${guardian.firstName} ${guardian.lastName}`.trim(),
        relationship: input.relationship_type,
        is_primary: makePrimary,
      },
    });
    await recordChange(tx, actor, tenantId, {
      action: 'GUARDIAN_LINKED',
      entityType: 'student_guardian',
      entityId: linkId,
      event: 'guardian.linked',
      after: { relationship_type: input.relationship_type, is_primary: makePrimary },
      payload: { student_id: studentId, guardian_id: guardian.id, is_primary: makePrimary },
    });
    return linkId;
  }

  private async demotePrimary(
    tx: Executor,
    tenantId: string,
    studentId: string,
    exceptId?: string,
  ) {
    await tx
      .update(studentGuardians)
      .set({ isPrimary: false })
      .where(
        and(
          eq(studentGuardians.tenantId, tenantId),
          eq(studentGuardians.studentId, studentId),
          eq(studentGuardians.isPrimary, true),
          exceptId ? sql`${studentGuardians.id} <> ${exceptId}` : undefined,
        ),
      );
  }

  private async linkView(tx: Executor, tenantId: string, linkId: string) {
    const [r] = await tx
      .select({ l: studentGuardians, g: guardians })
      .from(studentGuardians)
      .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
      .where(and(eq(studentGuardians.id, linkId), eq(studentGuardians.tenantId, tenantId)));
    if (!r) throw new NotFoundError('Guardian link');
    return presentLink(r.l, r.g);
  }

  async link(
    tenantId: string,
    studentId: string,
    input: z.infer<typeof LinkGuardianBody>,
    principal: Principal,
    actor: Actor,
  ) {
    const linkId = await this.db.transaction(async (tx) => {
      await loadStudent(tx, tenantId, studentId, principal, 'students.guardians.manage', {
        lock: true,
      });
      return this.linkInTx(tx, tenantId, studentId, input, actor);
    });
    return this.linkView(this.db, tenantId, linkId);
  }

  async updateLink(
    tenantId: string,
    studentId: string,
    linkId: string,
    input: z.infer<typeof UpdateLinkBody>,
    principal: Principal,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      await loadStudent(tx, tenantId, studentId, principal, 'students.guardians.manage', {
        lock: true,
      });
      const [before] = await tx
        .select()
        .from(studentGuardians)
        .where(
          and(
            eq(studentGuardians.id, linkId),
            eq(studentGuardians.tenantId, tenantId),
            eq(studentGuardians.studentId, studentId),
          ),
        )
        .for('update');
      if (!before) throw new NotFoundError('Guardian link');
      if (before.status !== 'ACTIVE')
        throw new BusinessRuleError('INVALID_STATE', 'This guardian link has ended');
      const isPrimary = input.is_primary ?? before.isPrimary;
      if (isPrimary && !before.isPrimary) await this.demotePrimary(tx, tenantId, studentId, linkId);
      const next = {
        relationshipType: input.relationship_type ?? before.relationshipType,
        relationshipLabel:
          input.relationship_label === undefined
            ? before.relationshipLabel
            : input.relationship_label,
        isPrimary,
        isEmergencyContact: input.is_emergency_contact ?? before.isEmergencyContact,
        canPickUp: input.can_pick_up ?? before.canPickUp,
        portalAccessAllowed: input.portal_access_allowed ?? before.portalAccessAllowed,
      };
      await tx
        .update(studentGuardians)
        .set({ ...next, version: before.version + 1 })
        .where(eq(studentGuardians.id, linkId));
      const primaryChanged = isPrimary !== before.isPrimary;
      await addHistory(tx, actor, tenantId, studentId, {
        eventType: primaryChanged ? 'PRIMARY_GUARDIAN_CHANGED' : 'GUARDIAN_RELATIONSHIP_CHANGED',
        details: { link_id: linkId, ...next },
      });
      await recordChange(tx, actor, tenantId, {
        action: primaryChanged ? 'PRIMARY_GUARDIAN_CHANGED' : 'GUARDIAN_RELATIONSHIP_CHANGED',
        entityType: 'student_guardian',
        entityId: linkId,
        event: 'guardian.relationship_changed',
        before: {
          relationship_type: before.relationshipType,
          is_primary: before.isPrimary,
          can_pick_up: before.canPickUp,
          portal_access_allowed: before.portalAccessAllowed,
        },
        after: next,
        payload: { student_id: studentId, guardian_id: before.guardianId },
      });
    });
    return this.linkView(this.db, tenantId, linkId);
  }

  /** End the relationship (kept for history); the guardian record stays. */
  async unlink(
    tenantId: string,
    studentId: string,
    linkId: string,
    principal: Principal,
    actor: Actor,
  ) {
    await this.db.transaction(async (tx) => {
      await loadStudent(tx, tenantId, studentId, principal, 'students.guardians.manage', {
        lock: true,
      });
      const [before] = await tx
        .select()
        .from(studentGuardians)
        .where(
          and(
            eq(studentGuardians.id, linkId),
            eq(studentGuardians.tenantId, tenantId),
            eq(studentGuardians.studentId, studentId),
          ),
        )
        .for('update');
      if (!before) throw new NotFoundError('Guardian link');
      if (before.status !== 'ACTIVE')
        throw new BusinessRuleError('INVALID_STATE', 'This guardian link has already ended');
      await tx
        .update(studentGuardians)
        .set({
          status: 'ENDED',
          isPrimary: false,
          effectiveUntil: todayIso(this.deps.clock),
          version: before.version + 1,
        })
        .where(eq(studentGuardians.id, linkId));
      await addHistory(tx, actor, tenantId, studentId, {
        eventType: 'GUARDIAN_UNLINKED',
        details: { link_id: linkId, guardian_id: before.guardianId },
      });
      await recordChange(tx, actor, tenantId, {
        action: 'GUARDIAN_UNLINKED',
        entityType: 'student_guardian',
        entityId: linkId,
        event: 'guardian.unlinked',
        before: { status: 'ACTIVE', was_primary: before.isPrimary },
        after: { status: 'ENDED' },
        payload: { student_id: studentId, guardian_id: before.guardianId },
      });
    });
  }

  /** Edit the guardian's own contact details (shared across all their students). */
  async update(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateGuardianBody>,
    principal: Principal,
    actor: Actor,
  ) {
    await this.get(tenantId, id, principal); // scope + existence
    await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(guardians)
        .where(and(eq(guardians.id, id), eq(guardians.tenantId, tenantId)))
        .for('update');
      if (!before) throw new NotFoundError('Guardian');
      const pick = <T>(v: T | undefined, cur: T) => (v === undefined ? cur : v);
      const [res] = await tx
        .update(guardians)
        .set({
          firstName: input.first_name ?? before.firstName,
          middleName: pick(input.middle_name, before.middleName),
          lastName: input.last_name ?? before.lastName,
          email: pick(input.email, before.email),
          phone: pick(input.phone, before.phone),
          address: pick(input.address, before.address),
          occupation: pick(input.occupation, before.occupation),
          preferredChannel: pick(input.preferred_channel, before.preferredChannel),
          notifyEmail: input.notify_email ?? before.notifyEmail,
          notifySms: input.notify_sms ?? before.notifySms,
          notifyWhatsapp: input.notify_whatsapp ?? before.notifyWhatsapp,
          preferredLanguage: pick(input.preferred_language, before.preferredLanguage),
          version: before.version + 1,
        })
        .where(and(eq(guardians.id, id), eq(guardians.version, input.version)));
      if (res.affectedRows !== 1)
        throw new ConflictError('CONFLICT', undefined, { current_version: before.version });
      const [after] = await tx.select().from(guardians).where(eq(guardians.id, id));
      await recordChange(tx, actor, tenantId, {
        action: 'GUARDIAN_UPDATED',
        entityType: 'guardian',
        entityId: id,
        event: 'guardian.updated',
        before: presentGuardian(before),
        after: presentGuardian(after!),
      });
    });
    return this.get(tenantId, id, principal);
  }
}
