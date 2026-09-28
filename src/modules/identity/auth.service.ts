import { and, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  invitations,
  memberships,
  passwordResetTokens,
  tenants,
  userSessions,
  users,
  roles,
  roleAssignments,
} from '../../db/schema/index.js';
import { recordAudit } from '../../platform/audit.js';
import type { Actor, Principal, RequestMeta, TenantContext } from '../../platform/context.js';
import { publishEvent } from '../../platform/outbox.js';
import { randomToken, sha256 } from '../../shared/crypto.js';
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
} from '../../shared/errors.js';
import { addDays, addMinutes } from '../../shared/time.js';
import type { AuthorizationService } from '../access/authorization.service.js';
import { dummyVerify, hashPassword, verifyPassword } from './password.js';
import type { TokenService } from './tokens.js';

export interface DeviceInfo {
  deviceName?: string | null;
  deviceType?: string | null;
}

export interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  refresh_expires_at: string;
  session_id: string;
}

interface MembershipOption {
  membership_id: string;
  kind: 'PLATFORM' | 'TENANT';
  tenant: { id: string; name: string; code: string; status: string } | null;
}

export class AuthService {
  constructor(
    private readonly deps: Deps,
    private readonly tokens: TokenService,
    private readonly authz: AuthorizationService,
  ) {}

  private anonymous(meta: RequestMeta, tenantId: string | null = null): Actor {
    return { userId: null, actorType: 'ANONYMOUS', tenantId, meta };
  }

  // ---------------------------------------------------------------------------
  // Login / refresh / logout
  // ---------------------------------------------------------------------------

  async login(
    input: { email: string; password: string; membershipId?: string; device?: DeviceInfo },
    meta: RequestMeta,
  ) {
    const now = this.deps.clock.now();
    const email = input.email.trim().toLowerCase();
    const [user] = await this.deps.db.select().from(users).where(eq(users.email, email));

    if (!user || !user.passwordHash) {
      await dummyVerify(input.password);
      await recordAudit(this.deps.db, this.anonymous(meta), {
        action: 'LOGIN_FAILED',
        entityType: 'user',
        entityId: user?.id ?? null,
        after: { email, reason: 'UNKNOWN_USER' },
      });
      throw new AuthenticationError('INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    if (user.lockedUntil && user.lockedUntil > now) {
      throw new AuthorizationError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.', {
        locked_until: user.lockedUntil.toISOString(),
      });
    }

    const ok = await verifyPassword(user.passwordHash, input.password);
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      const lock = failed >= this.deps.env.LOGIN_MAX_FAILED_ATTEMPTS;
      await this.deps.db
        .update(users)
        .set({
          failedLoginCount: lock ? 0 : failed,
          lockedUntil: lock
            ? addMinutes(now, this.deps.env.LOGIN_LOCKOUT_MINUTES)
            : user.lockedUntil,
        })
        .where(eq(users.id, user.id));
      await recordAudit(this.deps.db, this.anonymous(meta), {
        action: lock ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED',
        entityType: 'user',
        entityId: user.id,
        after: { reason: 'BAD_PASSWORD' },
      });
      throw new AuthenticationError('INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    if (user.status !== 'ACTIVE')
      throw new AuthorizationError('ACCOUNT_DISABLED', 'This account is not active');

    const options = await this.membershipOptions(user.id);
    if (options.length === 0)
      throw new AuthorizationError('TENANT_ACCESS_DENIED', 'You do not have access to any school');

    let chosen: MembershipOption | undefined;
    if (input.membershipId) {
      chosen = options.find((o) => o.membership_id === input.membershipId);
      if (!chosen)
        throw new AuthorizationError(
          'TENANT_ACCESS_DENIED',
          'You do not have access to this school',
        );
    } else if (options.length === 1) {
      chosen = options[0];
    } else {
      throw new ConflictError('CONTEXT_SELECTION_REQUIRED', 'Choose which school to sign in to', {
        memberships: options,
      });
    }

    const issued = await this.deps.db.transaction(async (tx) => {
      const tokens = await this.createSession(
        tx,
        user.id,
        chosen!.membership_id,
        input.device ?? {},
        meta,
      );
      await tx
        .update(users)
        .set({ lastLoginAt: now, failedLoginCount: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
      await recordAudit(
        tx,
        {
          userId: user.id,
          actorType: chosen!.kind === 'PLATFORM' ? 'PLATFORM_USER' : 'USER',
          tenantId: chosen!.tenant?.id ?? null,
          meta,
        },
        {
          action: 'LOGIN_SUCCESS',
          entityType: 'session',
          entityId: tokens.session_id,
        },
      );
      return tokens;
    });
    return { ...issued, membership: chosen! };
  }

  /** Active memberships a user can sign in to (archived schools are excluded). */
  async membershipOptions(userId: string): Promise<MembershipOption[]> {
    const rows = await this.deps.db
      .select({
        id: memberships.id,
        kind: memberships.kind,
        tenantId: tenants.id,
        tenantName: tenants.name,
        tenantCode: tenants.code,
        tenantStatus: tenants.status,
      })
      .from(memberships)
      .leftJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(and(eq(memberships.userId, userId), eq(memberships.status, 'ACTIVE')))
      .orderBy(memberships.kind, tenants.name);
    return rows
      .filter((r) => r.kind === 'PLATFORM' || (r.tenantStatus && r.tenantStatus !== 'ARCHIVED'))
      .map((r) => ({
        membership_id: r.id,
        kind: r.kind,
        tenant: r.tenantId
          ? { id: r.tenantId, name: r.tenantName!, code: r.tenantCode!, status: r.tenantStatus! }
          : null,
      }));
  }

  private async createSession(
    executor: Executor,
    userId: string,
    membershipId: string,
    device: DeviceInfo,
    meta: RequestMeta,
    /** Rotation keeps the original absolute expiry: a session cannot be extended forever. */
    absoluteExpiresAt?: Date,
  ): Promise<IssuedTokens> {
    const refresh = randomToken();
    const expiresAt =
      absoluteExpiresAt ?? addDays(this.deps.clock.now(), this.deps.env.REFRESH_TTL_DAYS);
    const [row] = await executor
      .insert(userSessions)
      .values({
        userId,
        membershipId,
        refreshTokenHash: sha256(refresh),
        deviceName: device.deviceName ?? null,
        deviceType: device.deviceType ?? null,
        ipAddress: meta.ip,
        userAgent: meta.userAgent?.slice(0, 500) ?? null,
        expiresAt,
      })
      .$returningId();
    const access = await this.tokens.signAccess({ sub: userId, sid: row!.id, mid: membershipId });
    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: access.expiresIn,
      refresh_token: refresh,
      refresh_expires_at: expiresAt.toISOString(),
      session_id: row!.id,
    };
  }

  /**
   * Rotating refresh tokens. Presenting an already-rotated token signals theft:
   * every session of that user is revoked.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<IssuedTokens> {
    const now = this.deps.clock.now();
    const [session] = await this.deps.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.refreshTokenHash, sha256(refreshToken)));
    if (!session || !session.membershipId)
      throw new AuthenticationError('INVALID_TOKEN', 'The refresh token is invalid');

    if (session.revokedAt) {
      if (session.revokedReason === 'ROTATED' || session.revokedReason === 'CONTEXT_SWITCH') {
        await this.revokeAllSessions(this.deps.db, session.userId, 'REFRESH_REUSE');
        await recordAudit(
          this.deps.db,
          { userId: session.userId, actorType: 'SYSTEM', tenantId: null, meta },
          {
            action: 'SESSION_REVOKED',
            entityType: 'user',
            entityId: session.userId,
            reason: 'Refresh token reuse detected; all sessions revoked',
          },
        );
      }
      throw new AuthenticationError('INVALID_TOKEN', 'The refresh token is invalid');
    }
    if (session.expiresAt <= now)
      throw new AuthenticationError('INVALID_TOKEN', 'The refresh token has expired');
    // Idle timeout: each rotation creates a new session row, so created_at is the last refresh.
    if (addDays(session.createdAt, this.deps.env.REFRESH_IDLE_DAYS) <= now) {
      await this.deps.db
        .update(userSessions)
        .set({ revokedAt: now, revokedReason: 'IDLE_TIMEOUT' })
        .where(and(eq(userSessions.id, session.id), isNull(userSessions.revokedAt)));
      throw new AuthenticationError('INVALID_TOKEN', 'The session expired after inactivity');
    }

    const [ctx] = await this.deps.db
      .select({ userStatus: users.status, membershipStatus: memberships.status })
      .from(users)
      .innerJoin(memberships, eq(memberships.id, session.membershipId))
      .where(eq(users.id, session.userId));
    if (!ctx || ctx.userStatus !== 'ACTIVE' || ctx.membershipStatus !== 'ACTIVE') {
      await this.deps.db
        .update(userSessions)
        .set({ revokedAt: now, revokedReason: 'ACCESS_REVOKED' })
        .where(eq(userSessions.id, session.id));
      throw new AuthenticationError('INVALID_TOKEN', 'The session is no longer valid');
    }

    return this.deps.db.transaction(async (tx) => {
      // Conditional update guards against two concurrent refreshes of the same token.
      const [res] = await tx
        .update(userSessions)
        .set({ revokedAt: now, revokedReason: 'ROTATED', lastUsedAt: now })
        .where(and(eq(userSessions.id, session.id), isNull(userSessions.revokedAt)));
      if (res.affectedRows !== 1)
        throw new AuthenticationError('INVALID_TOKEN', 'The refresh token is invalid');
      return this.createSession(
        tx,
        session.userId,
        session.membershipId!,
        { deviceName: session.deviceName, deviceType: session.deviceType },
        meta,
        session.expiresAt,
      );
    });
  }

  async logout(principal: Principal, meta: RequestMeta): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      await tx
        .update(userSessions)
        .set({ revokedAt: this.deps.clock.now(), revokedReason: 'LOGOUT' })
        .where(and(eq(userSessions.id, principal.sessionId), isNull(userSessions.revokedAt)));
      await recordAudit(
        tx,
        { userId: principal.userId, actorType: principal.actorType, tenantId: null, meta },
        { action: 'LOGOUT', entityType: 'session', entityId: principal.sessionId },
      );
    });
  }

  /** Move the current session to another of the user's memberships. */
  async switchContext(principal: Principal, membershipId: string, meta: RequestMeta) {
    const options = await this.membershipOptions(principal.userId);
    const chosen = options.find((o) => o.membership_id === membershipId);
    if (!chosen)
      throw new AuthorizationError('TENANT_ACCESS_DENIED', 'You do not have access to this school');
    const tokens = await this.deps.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(userSessions)
        .where(eq(userSessions.id, principal.sessionId))
        .for('update');
      const [res] = await tx
        .update(userSessions)
        .set({ revokedAt: this.deps.clock.now(), revokedReason: 'CONTEXT_SWITCH' })
        .where(and(eq(userSessions.id, principal.sessionId), isNull(userSessions.revokedAt)));
      if (!current || res.affectedRows !== 1)
        throw new AuthenticationError('INVALID_TOKEN', 'The session has ended. Sign in again.');
      return this.createSession(
        tx,
        principal.userId,
        membershipId,
        { deviceName: current.deviceName, deviceType: current.deviceType },
        meta,
        current.expiresAt,
      );
    });
    return { ...tokens, membership: chosen };
  }

  async revokeAllSessions(
    executor: Executor,
    userId: string,
    reason: string,
    exceptSessionId?: string,
  ) {
    const conds = [eq(userSessions.userId, userId), isNull(userSessions.revokedAt)];
    if (exceptSessionId) conds.push(ne(userSessions.id, exceptSessionId));
    await executor
      .update(userSessions)
      .set({ revokedAt: this.deps.clock.now(), revokedReason: reason })
      .where(and(...conds));
  }

  // ---------------------------------------------------------------------------
  // Current user & sessions
  // ---------------------------------------------------------------------------

  async me(principal: Principal, tenant: TenantContext | undefined) {
    const [user] = await this.deps.db.select().from(users).where(eq(users.id, principal.userId));
    const [membership] = await this.deps.db
      .select({
        id: memberships.id,
        kind: memberships.kind,
        status: memberships.status,
        tenantId: tenants.id,
        tenantName: tenants.name,
        tenantCode: tenants.code,
        tenantStatus: tenants.status,
      })
      .from(memberships)
      .leftJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(eq(memberships.id, principal.membershipId));
    const options = await this.membershipOptions(principal.userId);
    // Role names are for display only; authorization always uses `permissions`.
    const roleRows = await this.deps.db
      .select({ code: roles.code, name: roles.name, scopeType: roleAssignments.scopeType })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(
        and(
          eq(roleAssignments.membershipId, principal.membershipId),
          eq(roleAssignments.status, 'ACTIVE'),
          eq(roles.status, 'ACTIVE'),
        ),
      );
    return {
      user: presentUser(user!),
      roles: roleRows.map((r) => ({ code: r.code, name: r.name, scope_type: r.scopeType })),
      membership: {
        id: membership!.id,
        kind: membership!.kind,
        status: membership!.status,
        tenant: membership!.tenantId
          ? {
              id: membership!.tenantId,
              name: membership!.tenantName,
              code: membership!.tenantCode,
              status: membership!.tenantStatus,
            }
          : null,
      },
      permissions: [...principal.permissions].sort(),
      scopes: principal.scopes,
      entitlements: tenant
        ? {
            access_mode: tenant.entitlements.accessMode,
            features: tenant.entitlements.features,
            subscription: {
              status: tenant.entitlements.subscription.status,
              plan_code: tenant.entitlements.subscription.planCode,
              grace_ends_at: tenant.entitlements.subscription.graceEndsAt,
            },
          }
        : null,
      available_memberships: options,
    };
  }

  async listSessions(principal: Principal) {
    const rows = await this.deps.db
      .select()
      .from(userSessions)
      .where(
        and(
          eq(userSessions.userId, principal.userId),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, this.deps.clock.now()),
        ),
      )
      .orderBy(desc(userSessions.createdAt));
    return rows.map((s) => ({
      id: s.id,
      current: s.id === principal.sessionId,
      device_name: s.deviceName,
      device_type: s.deviceType,
      ip_address: s.ipAddress,
      user_agent: s.userAgent,
      created_at: s.createdAt.toISOString(),
      last_used_at: s.lastUsedAt?.toISOString() ?? null,
      expires_at: s.expiresAt.toISOString(),
    }));
  }

  async revokeSession(principal: Principal, sessionId: string, meta: RequestMeta) {
    await this.deps.db.transaction(async (tx) => {
      const [res] = await tx
        .update(userSessions)
        .set({ revokedAt: this.deps.clock.now(), revokedReason: 'USER_REVOKED' })
        .where(
          and(
            eq(userSessions.id, sessionId),
            eq(userSessions.userId, principal.userId),
            isNull(userSessions.revokedAt),
          ),
        );
      if (res.affectedRows === 0) throw new NotFoundError('Session');
      await recordAudit(
        tx,
        { userId: principal.userId, actorType: principal.actorType, tenantId: null, meta },
        { action: 'SESSION_REVOKED', entityType: 'session', entityId: sessionId },
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Passwords
  // ---------------------------------------------------------------------------

  async changePassword(principal: Principal, current: string, next: string, meta: RequestMeta) {
    const [user] = await this.deps.db.select().from(users).where(eq(users.id, principal.userId));
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, current))) {
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'The current password is incorrect');
    }
    const hash = await hashPassword(next);
    await this.deps.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash: hash, passwordChangedAt: this.deps.clock.now() })
        .where(eq(users.id, user.id));
      await this.revokeAllSessions(tx, user.id, 'PASSWORD_CHANGED', principal.sessionId);
      await recordAudit(
        tx,
        { userId: user.id, actorType: principal.actorType, tenantId: null, meta },
        { action: 'PASSWORD_CHANGED', entityType: 'user', entityId: user.id },
      );
    });
  }

  /** Always succeeds from the caller's perspective, so accounts cannot be enumerated. */
  async forgotPassword(email: string, meta: RequestMeta) {
    const [user] = await this.deps.db
      .select()
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()));
    if (!user || user.status !== 'ACTIVE') return;
    const now = this.deps.clock.now();
    await this.deps.db.transaction(async (tx) => {
      await tx
        .update(passwordResetTokens)
        .set({ status: 'REVOKED' })
        .where(
          and(
            eq(passwordResetTokens.userId, user.id),
            inArray(passwordResetTokens.status, ['PENDING', 'SENT']),
          ),
        );
      const [row] = await tx
        .insert(passwordResetTokens)
        .values({
          userId: user.id,
          expiresAt: addMinutes(now, this.deps.env.PASSWORD_RESET_TTL_MINUTES),
        })
        .$returningId();
      const actor = this.anonymous(meta);
      await publishEvent(tx, actor, {
        eventType: 'password_reset.requested',
        aggregateType: 'user',
        aggregateId: user.id,
        payload: { reset_id: row!.id, user_id: user.id },
      });
      await recordAudit(tx, actor, {
        action: 'PASSWORD_RESET_REQUESTED',
        entityType: 'user',
        entityId: user.id,
      });
    });
  }

  async resetPassword(token: string, next: string, meta: RequestMeta) {
    const now = this.deps.clock.now();
    const [reset] = await this.deps.db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, sha256(token)));
    if (!reset || reset.status !== 'SENT' || reset.expiresAt <= now) {
      throw new BusinessRuleError('INVALID_STATE', 'This reset link is invalid or has expired');
    }
    const hash = await hashPassword(next);
    await this.deps.db.transaction(async (tx) => {
      const [res] = await tx
        .update(passwordResetTokens)
        .set({ status: 'USED', usedAt: now })
        .where(and(eq(passwordResetTokens.id, reset.id), eq(passwordResetTokens.status, 'SENT')));
      if (res.affectedRows !== 1)
        throw new BusinessRuleError('INVALID_STATE', 'This reset link is invalid or has expired');
      await tx
        .update(users)
        .set({ passwordHash: hash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null })
        .where(eq(users.id, reset.userId));
      await this.revokeAllSessions(tx, reset.userId, 'PASSWORD_RESET');
      await recordAudit(
        tx,
        { userId: reset.userId, actorType: 'USER', tenantId: null, meta },
        { action: 'PASSWORD_RESET', entityType: 'user', entityId: reset.userId },
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Invitations
  // ---------------------------------------------------------------------------

  private async findInvitation(token: string) {
    const [row] = await this.deps.db
      .select({
        invitation: invitations,
        membershipStatus: memberships.status,
        membershipKind: memberships.kind,
        userId: users.id,
        userStatus: users.status,
        hasPassword: users.passwordHash,
        firstName: users.firstName,
        lastName: users.lastName,
        tenantId: tenants.id,
        tenantName: tenants.name,
      })
      .from(invitations)
      .innerJoin(memberships, eq(memberships.id, invitations.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(eq(invitations.tokenHash, sha256(token)));
    if (
      !row ||
      row.invitation.status !== 'SENT' ||
      row.membershipStatus !== 'INVITED' ||
      row.invitation.expiresAt <= this.deps.clock.now()
    ) {
      throw new BusinessRuleError('INVALID_STATE', 'This invitation is invalid or has expired');
    }
    return row;
  }

  async previewInvitation(token: string) {
    const row = await this.findInvitation(token);
    return {
      email: row.invitation.email,
      first_name: row.hasPassword
        ? row.firstName
        : (row.invitation.invitedFirstName ?? row.firstName),
      last_name: row.hasPassword ? row.lastName : (row.invitation.invitedLastName ?? row.lastName),
      kind: row.membershipKind,
      tenant: row.tenantId ? { id: row.tenantId, name: row.tenantName } : null,
      requires_password: !row.hasPassword,
      expires_at: row.invitation.expiresAt.toISOString(),
    };
  }

  /** Accept: activates the membership; new users set their password here. */
  async acceptInvitation(
    input: { token: string; password?: string; firstName?: string; lastName?: string },
    meta: RequestMeta,
  ) {
    const row = await this.findInvitation(input.token);
    if (row.userStatus === 'SUSPENDED' || row.userStatus === 'DEACTIVATED')
      throw new AuthorizationError('ACCOUNT_DISABLED', 'This account is not active');
    if (!row.hasPassword && !input.password)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'A password is required to activate this account',
        { field: 'password' },
      );
    const hash = !row.hasPassword && input.password ? await hashPassword(input.password) : null;
    const now = this.deps.clock.now();

    await this.deps.db.transaction(async (tx) => {
      const [res] = await tx
        .update(invitations)
        .set({ status: 'USED', acceptedAt: now })
        .where(and(eq(invitations.id, row.invitation.id), eq(invitations.status, 'SENT')));
      if (res.affectedRows !== 1)
        throw new BusinessRuleError('INVALID_STATE', 'This invitation is invalid or has expired');
      // The membership must still be pending (not revoked since the email went out).
      const [activated] = await tx
        .update(memberships)
        .set({ status: 'ACTIVE', joinedAt: now })
        .where(
          and(eq(memberships.id, row.invitation.membershipId), eq(memberships.status, 'INVITED')),
        );
      if (activated.affectedRows !== 1)
        throw new BusinessRuleError('INVALID_STATE', 'This invitation is invalid or has expired');
      await tx
        .update(users)
        .set({
          status: 'ACTIVE',
          emailVerifiedAt: now,
          ...(hash ? { passwordHash: hash, passwordChangedAt: now } : {}),
          ...(input.firstName ? { firstName: input.firstName } : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
        })
        .where(and(eq(users.id, row.userId), inArray(users.status, ['INVITED', 'ACTIVE'])));
      const actor: Actor = {
        userId: row.userId,
        actorType: row.membershipKind === 'PLATFORM' ? 'PLATFORM_USER' : 'USER',
        tenantId: row.tenantId,
        meta,
      };
      await recordAudit(tx, actor, {
        action: 'INVITATION_ACCEPTED',
        entityType: 'membership',
        entityId: row.invitation.membershipId,
      });
      await publishEvent(tx, actor, {
        eventType: 'membership.activated',
        aggregateType: 'membership',
        aggregateId: row.invitation.membershipId,
        payload: { membership_id: row.invitation.membershipId, user_id: row.userId },
      });
    });
    await this.authz.invalidateTenant(row.tenantId);
    return {
      email: row.invitation.email,
      tenant: row.tenantId ? { id: row.tenantId, name: row.tenantName } : null,
    };
  }
}

export function presentUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    phone: u.phone,
    first_name: u.firstName,
    last_name: u.lastName,
    status: u.status,
    email_verified_at: u.emailVerifiedAt?.toISOString() ?? null,
    last_login_at: u.lastLoginAt?.toISOString() ?? null,
    created_at: u.createdAt.toISOString(),
  };
}
