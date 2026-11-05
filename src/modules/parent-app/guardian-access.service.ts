import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  guardians,
  invitations,
  memberships,
  roleAssignments,
  roles,
  studentGuardians,
  tenants,
  userSessions,
  users,
} from '../../db/schema/index.js';
import type { Actor } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import { toLoginPhone } from '../../shared/phone.js';
import type { AuthorizationService } from '../access/authorization.service.js';
import { deletePin } from '../identity/app-pin.js';
import { hashPassword, PasswordSchema } from '../identity/password.js';
import { setPasswordByAdmin } from '../members/credentials.js';
import { assignRoles, inviteMember } from '../members/invitations.js';

export const EnableAppAccessBody = z.object({
  /** Mobile number the parent signs in with. Defaults to the guardian's phone on file. */
  phone: z.string().trim().min(7).max(32).optional(),
  /** Email for the login. Defaults to the guardian's email; may be left out entirely. */
  email: z.string().trim().toLowerCase().pipe(z.email()).optional(),
  /** First password, given to the parent by the school. Required for a new login. */
  password: PasswordSchema.optional(),
});
export const AppPasswordBody = z.object({ password: PasswordSchema });
export const DisableAppAccessBody = z.object({ reason: z.string().trim().max(500).optional() });

type GuardianRow = typeof guardians.$inferSelect;

const PARENT_ROLE = 'PARENT';

/** Placeholder sign-in email for a parent who has none (they sign in with the mobile number). */
const placeholderEmail = (guardianId: string) => `guardian-${guardianId}@parents.invalid`;

/**
 * Parent app logins, managed by the school (admin panel → Guardians). The school turns the app
 * on for a guardian and sets a first password; the parent signs in with the mobile number (or
 * email). A guardian who already signs in at this school (a teacher who is also a parent) keeps
 * their login and gains the Parent role.
 *
 * The Parent role holds only `portal.access`, and every /parent route is limited to the
 * guardian's own linked children, so assigning it skips the staff anti-escalation check and
 * does not take a staff seat on the plan.
 */
export class GuardianAccessService {
  constructor(
    private readonly deps: Deps,
    private readonly authz: AuthorizationService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  private async loadGuardian(ex: Executor, tenantId: string, id: string, lock = false) {
    const q = ex
      .select()
      .from(guardians)
      .where(and(eq(guardians.tenantId, tenantId), eq(guardians.id, id)));
    const [g] = lock ? await q.for('update') : await q;
    if (!g) throw new NotFoundError('Guardian');
    return g;
  }

  private async parentRoleId(ex: Executor) {
    const [r] = await ex
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.tenantKey, 'SYSTEM'), eq(roles.code, PARENT_ROLE)));
    if (!r) throw new NotFoundError('Role', { code: PARENT_ROLE });
    return r.id;
  }

  /** The guardian's login at this school: membership plus its active role codes. */
  private async loginOf(ex: Executor, tenantId: string, g: GuardianRow) {
    if (!g.userId) return null;
    const [row] = await ex
      .select({ m: memberships, u: users })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.userId, g.userId), eq(memberships.tenantKey, tenantId)));
    if (!row)
      return {
        user: null,
        membership: null,
        roleCodes: [] as string[],
        assignments: [] as { id: string; code: string }[],
      };
    const rs = await ex
      .select({ id: roleAssignments.id, code: roles.code })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(and(eq(roleAssignments.membershipId, row.m.id), eq(roleAssignments.status, 'ACTIVE')));
    return { user: row.u, membership: row.m, roleCodes: rs.map((r) => r.code), assignments: rs };
  }

  async status(tenantId: string, guardianId: string) {
    const g = await this.loadGuardian(this.db, tenantId, guardianId);
    const login = await this.loginOf(this.db, tenantId, g);
    const links = await this.db
      .select({
        studentId: studentGuardians.studentId,
        allowed: studentGuardians.portalAccessAllowed,
      })
      .from(studentGuardians)
      .where(
        and(
          eq(studentGuardians.tenantId, tenantId),
          eq(studentGuardians.guardianId, g.id),
          eq(studentGuardians.status, 'ACTIVE'),
        ),
      );
    const enabled =
      !!login?.membership &&
      login.membership.status !== 'REVOKED' &&
      login.roleCodes.includes(PARENT_ROLE);
    return {
      guardian_id: g.id,
      enabled,
      membership_status: login?.membership?.status ?? null,
      login_phone: login?.user?.loginPhone ?? null,
      email:
        login?.user && !login.user.email.endsWith('@parents.invalid') ? login.user.email : null,
      last_login_at: login?.user?.lastLoginAt?.toISOString() ?? null,
      also_staff: !!login?.roleCodes.some((c) => c !== PARENT_ROLE),
      children_linked: links.length,
      children_visible: links.filter((l) => l.allowed).length,
    };
  }

  private async country(ex: Executor, tenantId: string) {
    const [t] = await ex
      .select({ c: tenants.country })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return t?.c ?? null;
  }

  private async assertPhoneFree(ex: Executor, phone: string, userId: string | null) {
    const [other] = await ex
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.loginPhone, phone), userId ? ne(users.id, userId) : undefined));
    if (other)
      throw new ConflictError(
        'DUPLICATE_RESOURCE',
        'This mobile number already signs in to another account',
        { field: 'phone' },
      );
  }

  /** Turn the parent app on for a guardian (create or reuse the login, add the Parent role). */
  async enable(
    tenantId: string,
    guardianId: string,
    input: z.infer<typeof EnableAppAccessBody>,
    actor: Actor,
  ) {
    const g = await this.loadGuardian(this.db, tenantId, guardianId);
    if (g.status !== 'ACTIVE')
      throw new BusinessRuleError('INVALID_STATE', 'This guardian is archived');
    const [anyLink] = await this.db
      .select({ id: studentGuardians.id })
      .from(studentGuardians)
      .where(
        and(
          eq(studentGuardians.tenantId, tenantId),
          eq(studentGuardians.guardianId, g.id),
          eq(studentGuardians.status, 'ACTIVE'),
        ),
      )
      .limit(1);
    if (!anyLink)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'Link this guardian to a student before turning on the parent app',
      );

    const rawPhone = input.phone ?? g.phone;
    const phone = rawPhone ? toLoginPhone(rawPhone, await this.country(this.db, tenantId)) : null;
    if (rawPhone && !phone)
      throw new ValidationError('The request is invalid', {
        location: 'body',
        issues: [{ path: 'phone', message: 'This is not a valid mobile number' }],
      });
    const email = input.email ?? g.email?.trim().toLowerCase() ?? null;
    if (!phone && !email)
      throw new ValidationError('The request is invalid', {
        location: 'body',
        issues: [
          {
            path: 'phone',
            message: 'This guardian has no mobile number or email. Add a mobile number.',
          },
        ],
      });

    const passwordHash = input.password ? await hashPassword(input.password) : null;
    const result = await this.db.transaction(async (tx) => {
      const locked = await this.loadGuardian(tx, tenantId, guardianId, true);
      const roleId = await this.parentRoleId(tx);
      const current = await this.loginOf(tx, tenantId, locked);
      if (
        current?.membership &&
        current.membership.status !== 'REVOKED' &&
        current.roleCodes.includes(PARENT_ROLE)
      )
        throw new ConflictError('DUPLICATE_RESOURCE', 'This guardian already has the parent app');

      // Someone who already signs in with this email (e.g. a teacher who is also a parent).
      // A mobile number is only ever a parent login, so a number in use is a conflict below.
      const [existing] = email ? await tx.select().from(users).where(eq(users.email, email)) : [];
      if (existing) {
        const [owner] = await tx
          .select({ id: guardians.id })
          .from(guardians)
          .where(
            and(
              eq(guardians.tenantId, tenantId),
              eq(guardians.userId, existing.id),
              ne(guardians.id, locked.id),
            ),
          )
          .limit(1);
        if (owner)
          throw new ConflictError(
            'DUPLICATE_RESOURCE',
            'This email already signs in as another guardian',
            { field: 'email', guardian_id: owner.id },
          );
      }
      const [existingMembership] = existing
        ? await tx
            .select()
            .from(memberships)
            .where(and(eq(memberships.userId, existing.id), eq(memberships.tenantKey, tenantId)))
        : [];

      let userId: string;
      let membershipId: string;
      let created = false;
      if (existing && existingMembership && existingMembership.status === 'ACTIVE') {
        // Staff at this school who is also a parent: same login, one more role.
        userId = existing.id;
        membershipId = existingMembership.id;
        await assignRoles(tx, {
          membershipId,
          tenantId,
          assignments: [{ roleId }],
          actor,
        });
      } else {
        if (!passwordHash)
          throw new ValidationError('The request is invalid', {
            location: 'body',
            issues: [{ path: 'password', message: 'Set a first password for the parent' }],
          });
        const inv = await inviteMember(
          this.deps,
          tx,
          {
            email: email ?? placeholderEmail(locked.id),
            firstName: locked.firstName,
            lastName: locked.lastName,
            tenantId,
            assignments: [{ roleId }],
            skipPlanLimit: true,
          },
          actor,
        );
        userId = inv.userId;
        membershipId = inv.membershipId;
        // Accepts the invitation on the parent's behalf: active at once, no email is sent.
        await setPasswordByAdmin(
          this.deps,
          tx,
          {
            tenantId,
            membershipId,
            passwordHash,
            reason: 'Parent app login created by the school',
          },
          actor,
        );
        created = true;
      }
      if (phone) {
        await this.assertPhoneFree(tx, phone, userId);
        await tx.update(users).set({ loginPhone: phone }).where(eq(users.id, userId));
      }
      await tx
        .update(guardians)
        .set({ userId, version: locked.version + 1 })
        .where(eq(guardians.id, locked.id));
      // The children this guardian is linked to become visible in the app.
      await tx
        .update(studentGuardians)
        .set({ portalAccessAllowed: true })
        .where(
          and(
            eq(studentGuardians.tenantId, tenantId),
            eq(studentGuardians.guardianId, locked.id),
            eq(studentGuardians.status, 'ACTIVE'),
          ),
        );
      await recordChange(tx, actor, tenantId, {
        action: 'GUARDIAN_APP_ACCESS_ENABLED',
        entityType: 'guardian',
        entityId: locked.id,
        event: 'guardian.app_access_enabled',
        before: { user_id: locked.userId },
        after: { user_id: userId, membership_id: membershipId, new_login: created },
        payload: { membership_id: membershipId },
      });
      return { created };
    });
    await this.authz.invalidateTenant(tenantId);
    return { ...(await this.status(tenantId, guardianId)), new_login: result.created };
  }

  /** The school sets a new password (forgotten password). Signs the parent out everywhere. */
  async setPassword(tenantId: string, guardianId: string, password: string, actor: Actor) {
    const g = await this.loadGuardian(this.db, tenantId, guardianId);
    const login = await this.loginOf(this.db, tenantId, g);
    if (!login?.membership || login.membership.status === 'REVOKED')
      throw new NotFoundError('Parent app login');
    if (login.roleCodes.some((c) => c !== PARENT_ROLE))
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'This guardian also signs in as staff. Change the password from Users or Teachers.',
      );
    const passwordHash = await hashPassword(password);
    await this.db.transaction(async (tx) => {
      await setPasswordByAdmin(
        this.deps,
        tx,
        {
          tenantId,
          membershipId: login.membership!.id,
          passwordHash,
          reason: 'Parent app password set by the school',
        },
        actor,
      );
      await recordChange(tx, actor, tenantId, {
        action: 'GUARDIAN_APP_PASSWORD_SET',
        entityType: 'guardian',
        entityId: g.id,
      });
    });
    return this.status(tenantId, guardianId);
  }

  /**
   * Turn the parent app off. A parent-only login is removed (signed out everywhere, the mobile
   * number is freed); a staff login only loses the Parent role.
   */
  async disable(tenantId: string, guardianId: string, reason: string | undefined, actor: Actor) {
    const why = reason ?? 'Parent app turned off by the school';
    await this.db.transaction(async (tx) => {
      const g = await this.loadGuardian(tx, tenantId, guardianId, true);
      const login = await this.loginOf(tx, tenantId, g);
      if (!login?.membership || !login.roleCodes.includes(PARENT_ROLE))
        throw new NotFoundError('Parent app login');
      const m = login.membership;
      const now = this.deps.clock.now();
      const parentOnly = login.roleCodes.every((c) => c === PARENT_ROLE);
      const parentAssignments = (login.assignments ?? [])
        .filter((a) => a.code === PARENT_ROLE)
        .map((a) => a.id);
      await tx
        .update(roleAssignments)
        .set({ status: 'REVOKED', endsAt: now })
        .where(inArray(roleAssignments.id, parentAssignments));
      if (parentOnly) {
        await tx
          .update(memberships)
          .set({ status: 'REVOKED', endedAt: now })
          .where(eq(memberships.id, m.id));
        await tx
          .update(invitations)
          .set({ status: 'REVOKED' })
          .where(
            and(
              eq(invitations.membershipId, m.id),
              inArray(invitations.status, ['PENDING', 'SENT']),
            ),
          );
        await tx
          .update(userSessions)
          .set({ revokedAt: now, revokedReason: 'MEMBERSHIP_REVOKED' })
          .where(and(eq(userSessions.membershipId, m.id), isNull(userSessions.revokedAt)));
        await deletePin(tx, tenantId, m.id);
        // Free the number unless the account still signs in to another school.
        const [elsewhere] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, login.user!.id),
              ne(memberships.id, m.id),
              ne(memberships.status, 'REVOKED'),
            ),
          )
          .limit(1);
        if (!elsewhere)
          await tx.update(users).set({ loginPhone: null }).where(eq(users.id, login.user!.id));
      }
      await tx
        .update(guardians)
        .set({ userId: null, version: g.version + 1 })
        .where(eq(guardians.id, g.id));
      await recordChange(tx, actor, tenantId, {
        action: 'GUARDIAN_APP_ACCESS_DISABLED',
        entityType: 'guardian',
        entityId: g.id,
        event: 'guardian.app_access_disabled',
        before: { user_id: g.userId, membership_id: m.id },
        after: { user_id: null, login_removed: parentOnly },
        reason: why,
      });
    });
    await this.authz.invalidateTenant(tenantId);
    return this.status(tenantId, guardianId);
  }
}
