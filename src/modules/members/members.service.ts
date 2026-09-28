import { and, count, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  invitations,
  memberships,
  roleAssignments,
  roles,
  userSessions,
  users,
  type MembershipStatus,
} from '../../db/schema/index.js';
import { recordAudit } from '../../platform/audit.js';
import type { Actor, Principal } from '../../platform/context.js';
import { publishEvent } from '../../platform/outbox.js';
import { BusinessRuleError, NotFoundError } from '../../shared/errors.js';
import { offsetOf, orderFrom, pageOf, type PaginationQuery } from '../../shared/pagination.js';
import { adminCount, assertAdminSurvives, lockAdminScope } from '../access/admin-guard.js';
import type { AuthorizationService } from '../access/authorization.service.js';
import { assertCanGrant, assertScopeWithin, type RoleService } from '../access/roles.service.js';
import { assignRoles, inviteMember, queueInvitation, type AssignmentInput } from './invitations.js';

type LatestInvitation = {
  membershipId: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
  sentAt: Date | null;
  expiresAt: Date;
};

/**
 * Memberships of one context: a school (tenantId) or the platform (null).
 * Every query is filtered by tenant, so ids from another school resolve to 404.
 */
export class MemberService {
  constructor(
    private readonly deps: Deps,
    private readonly authz: AuthorizationService,
    private readonly rolesSvc: RoleService,
  ) {}

  private tenantFilter(tenantId: string | null) {
    return tenantId
      ? eq(memberships.tenantId, tenantId)
      : and(isNull(memberships.tenantId), eq(memberships.kind, 'PLATFORM'));
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async list(
    tenantId: string | null,
    q: PaginationQuery & { status?: MembershipStatus; role_id?: string },
  ) {
    const conds: (SQL | undefined)[] = [this.tenantFilter(tenantId)];
    if (q.status) conds.push(eq(memberships.status, q.status));
    if (q.search) {
      const s = `%${q.search}%`;
      conds.push(or(like(users.email, s), like(users.firstName, s), like(users.lastName, s)));
    }
    if (q.role_id) {
      conds.push(
        sql`exists (select 1 from ${roleAssignments} ra where ra.membership_id = ${memberships.id} and ra.role_id = ${q.role_id} and ra.status = 'ACTIVE')`,
      );
    }
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.deps.db
        .select({ m: memberships, u: users })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(where)
        .orderBy(
          orderFrom(
            q,
            {
              created_at: memberships.createdAt,
              email: users.email,
              first_name: users.firstName,
              last_name: users.lastName,
              status: memberships.status,
            },
            'created_at',
          ),
        )
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.deps.db
        .select({ n: count() })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(where),
    ]);
    const ids = rows.map((r) => r.m.id);
    const [assignments, invites] = await Promise.all([
      this.assignmentsOf(ids),
      this.latestInvitations(ids),
    ]);
    return pageOf(
      rows.map((r) => this.present(r.m, r.u, assignments, invites)),
      total?.n ?? 0,
      q,
    );
  }

  async get(tenantId: string | null, membershipId: string, executor: Executor = this.deps.db) {
    const [row] = await executor
      .select({ m: memberships, u: users })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.id, membershipId), this.tenantFilter(tenantId)));
    if (!row) throw new NotFoundError('Member');
    const [assignments, invites] = await Promise.all([
      this.assignmentsOf([membershipId], executor),
      this.latestInvitations([membershipId], executor),
    ]);
    const invite = invites.get(membershipId);
    return {
      ...this.present(row.m, row.u, assignments, invites),
      invitation: invite
        ? {
            status: invite.status,
            sent_at: invite.sentAt?.toISOString() ?? null,
            expires_at: invite.expiresAt.toISOString(),
          }
        : null,
    };
  }

  private async assignmentsOf(membershipIds: string[], executor: Executor = this.deps.db) {
    if (membershipIds.length === 0) return [];
    return executor
      .select({
        id: roleAssignments.id,
        membershipId: roleAssignments.membershipId,
        roleId: roles.id,
        roleCode: roles.code,
        roleName: roles.name,
        scopeType: roleAssignments.scopeType,
        scopeRef: roleAssignments.scopeRef,
      })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(
        and(
          inArray(roleAssignments.membershipId, membershipIds),
          eq(roleAssignments.status, 'ACTIVE'),
        ),
      );
  }

  private async latestInvitations(
    membershipIds: string[],
    executor: Executor = this.deps.db,
  ): Promise<Map<string, LatestInvitation>> {
    const out = new Map<string, LatestInvitation>();
    if (membershipIds.length === 0) return out;
    const rows = await executor
      .select({
        membershipId: invitations.membershipId,
        firstName: invitations.invitedFirstName,
        lastName: invitations.invitedLastName,
        status: invitations.status,
        sentAt: invitations.sentAt,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
        id: invitations.id,
      })
      .from(invitations)
      .where(inArray(invitations.membershipId, membershipIds))
      .orderBy(desc(invitations.createdAt), desc(invitations.id));
    for (const r of rows) if (!out.has(r.membershipId)) out.set(r.membershipId, r);
    return out;
  }

  private present(
    m: typeof memberships.$inferSelect,
    u: typeof users.$inferSelect,
    assignments: Awaited<ReturnType<MemberService['assignmentsOf']>>,
    invites: Map<string, LatestInvitation>,
  ) {
    // Until the invitee accepts, show only what the inviter typed: an invitation
    // must never reveal the name or activity of an existing account elsewhere.
    const pending = m.status === 'INVITED';
    const invite = invites.get(m.id);
    return {
      id: m.id,
      status: m.status,
      kind: m.kind,
      joined_at: m.joinedAt?.toISOString() ?? null,
      ended_at: m.endedAt?.toISOString() ?? null,
      created_at: m.createdAt.toISOString(),
      user: pending
        ? {
            id: u.id,
            email: u.email,
            first_name: invite?.firstName ?? null,
            last_name: invite?.lastName ?? null,
            status: 'INVITED' as const,
            last_login_at: null,
          }
        : {
            id: u.id,
            email: u.email,
            first_name: u.firstName,
            last_name: u.lastName,
            status: u.status,
            last_login_at: u.lastLoginAt?.toISOString() ?? null,
          },
      roles: assignments
        .filter((a) => a.membershipId === m.id)
        .map((a) => ({
          assignment_id: a.id,
          role_id: a.roleId,
          code: a.roleCode,
          name: a.roleName,
          scope_type: a.scopeType,
          scope_ref: a.scopeRef ?? null,
        })),
    };
  }

  // ---------------------------------------------------------------------------
  // Anti-escalation helpers
  // ---------------------------------------------------------------------------

  /** Caller must hold every permission (and scope) they hand out. */
  private async assertCanAssign(
    tx: Executor,
    tenantId: string | null,
    principal: Principal,
    assignments: AssignmentInput[],
  ) {
    const perms = await this.rolesSvc.permissionsOfRoles(
      tenantId,
      assignments.map((a) => a.roleId),
      tx,
    );
    for (const a of assignments) {
      const codes = perms.get(a.roleId)!;
      assertCanGrant(principal, codes);
      assertScopeWithin(
        principal,
        codes,
        a.scopeType ?? (tenantId ? 'ALL_TENANT' : 'ALL_TENANTS'),
        a.scopeRef ?? null,
      );
    }
  }

  /** Caller must hold every permission of the roles they take away or act upon. */
  private async assertCanManage(
    tx: Executor,
    tenantId: string | null,
    principal: Principal,
    roleIds: string[],
  ) {
    const perms = await this.rolesSvc.permissionsOfRoles(tenantId, roleIds, tx);
    assertCanGrant(principal, [...perms.values()].flat());
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  async invite(
    tenantId: string | null,
    input: { email: string; firstName: string; lastName?: string; assignments: AssignmentInput[] },
    principal: Principal,
    actor: Actor,
  ) {
    const res = await this.deps.db.transaction(async (tx) => {
      await this.assertCanAssign(tx, tenantId, principal, input.assignments);
      return inviteMember(this.deps, tx, { ...input, tenantId }, actor);
    });
    await this.authz.invalidateTenant(tenantId);
    return this.get(tenantId, res.membershipId);
  }

  async resendInvitation(
    tenantId: string | null,
    membershipId: string,
    principal: Principal,
    actor: Actor,
  ) {
    await this.deps.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.id, membershipId), this.tenantFilter(tenantId)))
        .for('update');
      if (!locked) throw new NotFoundError('Member');
      if (locked.status !== 'INVITED')
        throw new BusinessRuleError('INVALID_STATE', 'Only pending invitations can be resent');
      const member = await this.get(tenantId, membershipId, tx);
      await this.assertCanManage(
        tx,
        tenantId,
        principal,
        member.roles.map((r) => r.role_id),
      );
      await queueInvitation(
        this.deps,
        tx,
        {
          membershipId,
          tenantId,
          email: member.user.email,
          firstName: member.user.first_name,
          lastName: member.user.last_name,
        },
        actor,
      );
      await recordAudit(tx, actor, {
        tenantId,
        action: 'INVITATION_RESENT',
        entityType: 'membership',
        entityId: membershipId,
      });
    });
    return this.get(tenantId, membershipId);
  }

  async setStatus(
    tenantId: string | null,
    membershipId: string,
    status: 'ACTIVE' | 'SUSPENDED',
    reason: string,
    principal: Principal,
    actor: Actor,
  ) {
    if (membershipId === principal.membershipId)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'You cannot change your own access');
    const result = await this.deps.db.transaction(async (tx) => {
      await lockAdminScope(tx, tenantId);
      const adminsBefore = await adminCount(tx, tenantId);
      const member = await this.get(tenantId, membershipId, tx);
      if (status === 'SUSPENDED' && member.status !== 'ACTIVE')
        throw new BusinessRuleError('INVALID_STATE', 'Only active members can be suspended');
      if (status === 'ACTIVE' && member.status !== 'SUSPENDED')
        throw new BusinessRuleError('INVALID_STATE', 'Only suspended members can be reactivated');
      await this.assertCanManage(
        tx,
        tenantId,
        principal,
        member.roles.map((r) => r.role_id),
      );
      await tx.update(memberships).set({ status }).where(eq(memberships.id, membershipId));
      if (status === 'SUSPENDED') {
        await assertAdminSurvives(tx, tenantId, adminsBefore);
        await this.revokeSessions(tx, membershipId, 'MEMBERSHIP_SUSPENDED');
      }
      await recordAudit(tx, actor, {
        tenantId,
        action: status === 'SUSPENDED' ? 'MEMBER_SUSPENDED' : 'MEMBER_REACTIVATED',
        entityType: 'membership',
        entityId: membershipId,
        before: { status: member.status },
        after: { status },
        reason,
      });
      return this.get(tenantId, membershipId, tx);
    });
    await this.authz.invalidateTenant(tenantId);
    return result;
  }

  /** Remove someone from the school. Their user account and history remain. */
  async revoke(
    tenantId: string | null,
    membershipId: string,
    reason: string,
    principal: Principal,
    actor: Actor,
  ) {
    if (membershipId === principal.membershipId)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'You cannot remove yourself');
    await this.deps.db.transaction(async (tx) => {
      await lockAdminScope(tx, tenantId);
      const adminsBefore = await adminCount(tx, tenantId);
      const member = await this.get(tenantId, membershipId, tx);
      if (member.status === 'REVOKED')
        throw new BusinessRuleError('INVALID_STATE', 'This member was already removed');
      await this.assertCanManage(
        tx,
        tenantId,
        principal,
        member.roles.map((r) => r.role_id),
      );
      const now = this.deps.clock.now();
      await tx
        .update(memberships)
        .set({ status: 'REVOKED', endedAt: now })
        .where(eq(memberships.id, membershipId));
      await tx
        .update(roleAssignments)
        .set({ status: 'REVOKED', endsAt: now })
        .where(
          and(eq(roleAssignments.membershipId, membershipId), eq(roleAssignments.status, 'ACTIVE')),
        );
      await tx
        .update(invitations)
        .set({ status: 'REVOKED' })
        .where(
          and(
            eq(invitations.membershipId, membershipId),
            inArray(invitations.status, ['PENDING', 'SENT']),
          ),
        );
      await assertAdminSurvives(tx, tenantId, adminsBefore);
      await this.revokeSessions(tx, membershipId, 'MEMBERSHIP_REVOKED');
      await recordAudit(tx, actor, {
        tenantId,
        action: 'MEMBER_REVOKED',
        entityType: 'membership',
        entityId: membershipId,
        before: { status: member.status, roles: member.roles.map((r) => r.code) },
        after: { status: 'REVOKED' },
        reason,
      });
      await publishEvent(tx, actor, {
        tenantId,
        eventType: 'membership.revoked',
        aggregateType: 'membership',
        aggregateId: membershipId,
        payload: { membership_id: membershipId, user_id: member.user.id },
      });
    });
    await this.authz.invalidateTenant(tenantId);
  }

  /** Replace a member's role assignments. */
  async setRoles(
    tenantId: string | null,
    membershipId: string,
    assignments: AssignmentInput[],
    principal: Principal,
    actor: Actor,
  ) {
    if (membershipId === principal.membershipId)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'You cannot change your own roles');
    const result = await this.deps.db.transaction(async (tx) => {
      await lockAdminScope(tx, tenantId);
      const adminsBefore = await adminCount(tx, tenantId);
      const member = await this.get(tenantId, membershipId, tx);
      if (member.status === 'REVOKED')
        throw new BusinessRuleError('INVALID_STATE', 'Removed members cannot be assigned roles');
      // Must hold every permission being taken away, and every permission + scope being granted.
      await this.assertCanManage(
        tx,
        tenantId,
        principal,
        member.roles.map((r) => r.role_id),
      );
      await this.assertCanAssign(tx, tenantId, principal, assignments);

      const now = this.deps.clock.now();
      await tx
        .update(roleAssignments)
        .set({ status: 'REVOKED', endsAt: now })
        .where(
          and(eq(roleAssignments.membershipId, membershipId), eq(roleAssignments.status, 'ACTIVE')),
        );
      await assignRoles(tx, { membershipId, tenantId, assignments, actor });
      await assertAdminSurvives(tx, tenantId, adminsBefore);

      await recordAudit(tx, actor, {
        tenantId,
        action: 'MEMBER_ROLES_CHANGED',
        entityType: 'membership',
        entityId: membershipId,
        before: {
          roles: member.roles.map((r) => ({
            role_id: r.role_id,
            code: r.code,
            scope_type: r.scope_type,
          })),
        },
        after: {
          roles: assignments.map((a) => ({
            role_id: a.roleId,
            scope_type: a.scopeType ?? 'ALL_TENANT',
          })),
        },
      });
      return this.get(tenantId, membershipId, tx);
    });
    await this.authz.invalidateTenant(tenantId);
    return result;
  }

  private async revokeSessions(tx: Executor, membershipId: string, reason: string) {
    await tx
      .update(userSessions)
      .set({ revokedAt: this.deps.clock.now(), revokedReason: reason })
      .where(and(eq(userSessions.membershipId, membershipId), isNull(userSessions.revokedAt)));
  }
}
