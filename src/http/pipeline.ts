import { and, eq, gt, isNull } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Deps } from '../container.js';
import { memberships, tenants, userSessions, users } from '../db/schema/index.js';
import {
  authorize,
  scopeOfPermission,
  type AuthorizationService,
} from '../modules/access/authorization.service.js';
import { platformGrantsInSchool } from '../modules/access/scope-policy.js';
import type { EntitlementService } from '../modules/entitlements/entitlements.service.js';
import type { TokenService } from '../modules/identity/tokens.js';
import type { Principal } from '../platform/context.js';
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
} from '../shared/errors.js';
import type { Access, Pipeline } from './route.js';

interface PipelineServices {
  tokens: TokenService;
  authz: AuthorizationService;
  entitlements: EntitlementService;
}

/** Membership row loaded with the session, kept on the request for context resolution. */
interface LoadedSession {
  membershipKind: 'PLATFORM' | 'TENANT';
  membershipTenantId: string | null;
}
const sessionInfo = new WeakMap<object, LoadedSession>();

const handler =
  (fn: RequestHandler): RequestHandler =>
  async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      next(err);
    }
  };

export function createPipeline(deps: Deps, svc: PipelineServices): Pipeline {
  // ---- Authentication: verified token + live session + active user & membership
  const authenticate: RequestHandler = handler(async (req, _res, next) => {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) throw new AuthenticationError();
    const claims = await svc.tokens.verifyAccess(header.slice(7).trim());
    const now = deps.clock.now();

    const [row] = await deps.db
      .select({
        userStatus: users.status,
        membershipStatus: memberships.status,
        membershipKind: memberships.kind,
        membershipTenantId: memberships.tenantId,
      })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .innerJoin(memberships, eq(memberships.id, userSessions.membershipId))
      .where(
        and(
          eq(userSessions.id, claims.sid),
          eq(userSessions.userId, claims.sub),
          eq(userSessions.membershipId, claims.mid),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, now),
        ),
      );
    if (!row)
      throw new AuthenticationError('INVALID_TOKEN', 'The session has ended. Sign in again.');
    if (row.userStatus !== 'ACTIVE')
      throw new AuthorizationError('ACCOUNT_DISABLED', 'This account is not active');
    if (row.membershipStatus !== 'ACTIVE')
      throw new AuthorizationError(
        'TENANT_ACCESS_DENIED',
        'Your access to this school is not active',
      );

    const grants = await svc.authz.grantsFor(claims.mid, row.membershipTenantId);
    const principal: Principal = {
      userId: claims.sub,
      sessionId: claims.sid,
      membershipId: claims.mid,
      membershipKind: row.membershipKind,
      actorType: row.membershipKind === 'PLATFORM' ? 'PLATFORM_USER' : 'USER',
      permissions: new Set(grants.permissions),
      scopes: grants.scopes,
    };
    req.ctx.principal = principal;
    sessionInfo.set(req, {
      membershipKind: row.membershipKind,
      membershipTenantId: row.membershipTenantId,
    });
    next();
  });

  // ---- Tenant / platform context
  const resolveContext = (access: Access): RequestHandler =>
    handler(async (req, _res, next) => {
      const principal = req.ctx.principal!;
      const info = sessionInfo.get(req)!;
      const requestedTenant = req.header('x-tenant-id')?.trim() || null;

      if (access === 'authenticated') {
        if (info.membershipTenantId)
          req.ctx.tenant = await tenantContext(info.membershipTenantId, false, principal, false);
        return next();
      }

      if (access === 'platform') {
        if (info.membershipKind !== 'PLATFORM')
          throw new AuthorizationError(
            'PERMISSION_DENIED',
            'Platform administration access is required',
          );
        return next();
      }

      // access === 'tenant'
      if (info.membershipKind === 'TENANT') {
        // The tenant always comes from the membership; a client cannot pick another school.
        if (requestedTenant && requestedTenant !== info.membershipTenantId) {
          throw new AuthorizationError(
            'TENANT_ACCESS_DENIED',
            'You do not have access to this school',
          );
        }
        req.ctx.tenant = await tenantContext(info.membershipTenantId!, false, principal, true);
        return next();
      }

      // Platform user acting inside a school (support access).
      if (!requestedTenant)
        throw new AuthorizationError(
          'TENANT_ACCESS_DENIED',
          'Select a school with the X-Tenant-Id header',
        );
      if (!principal.permissions.has('platform.tenants.access')) {
        throw new AuthorizationError(
          'PERMISSION_DENIED',
          'Support access to schools is not permitted',
          { permission: 'platform.tenants.access' },
        );
      }
      // Platform support access can be limited to selected schools (SELECTED_TENANTS).
      const accessGrants = principal.scopes['platform.tenants.access'] ?? [];
      const mayEnter = accessGrants.some(
        (g) =>
          g.type === 'ALL_TENANTS' ||
          (g.type === 'SELECTED_TENANTS' && (g.ref?.tenant_ids ?? []).includes(requestedTenant)),
      );
      if (!mayEnter) {
        throw new AuthorizationError(
          'TENANT_ACCESS_DENIED',
          'Your support access does not include this school',
        );
      }
      // Only the tenant-scoped permissions of the platform role apply inside a school.
      const tenantPermissions = [...principal.permissions].filter(
        (c) => scopeOfPermission(c) === 'TENANT',
      );
      // Entry to this school was checked above, so those permissions cover the whole school.
      req.ctx.principal = {
        ...principal,
        permissions: new Set(tenantPermissions),
        scopes: platformGrantsInSchool(principal.scopes, tenantPermissions),
      };
      req.ctx.tenant = await tenantContext(requestedTenant, true, req.ctx.principal, true);
      // A school that is not ACTIVE is read-only for platform support: recovery happens through
      // the platform school actions (reactivate, restore, subscription), never by editing inside it.
      const readOnly = req.method === 'GET' || req.method === 'HEAD';
      if (req.ctx.tenant.tenantStatus !== 'ACTIVE' && !readOnly) {
        throw new AuthorizationError(
          req.ctx.tenant.tenantStatus === 'SUSPENDED' ? 'SCHOOL_SUSPENDED' : 'SCHOOL_NOT_ACTIVE',
          'This school is not active, so it is read-only. Use the platform school actions to recover it.',
          { status: req.ctx.tenant.tenantStatus },
        );
      }
      next();
    });

  async function tenantContext(
    tenantId: string,
    actingAsPlatform: boolean,
    principal: Principal,
    enforce: boolean,
  ) {
    const [tenant] = await deps.db
      .select({ id: tenants.id, status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!tenant) {
      if (actingAsPlatform) throw new NotFoundError('School');
      throw new AuthorizationError('TENANT_ACCESS_DENIED', 'You do not have access to this school');
    }
    const snapshot = await svc.entitlements.snapshot(tenant.id);
    if (enforce && !actingAsPlatform) {
      if (tenant.status === 'SUSPENDED')
        throw new AuthorizationError(
          'SCHOOL_SUSPENDED',
          'This school is suspended. Contact support.',
        );
      if (tenant.status !== 'ACTIVE')
        throw new AuthorizationError('SCHOOL_NOT_ACTIVE', 'This school is not active');
      if (snapshot.accessMode === 'LOCKED') {
        throw new AuthorizationError(
          'SUBSCRIPTION_EXPIRED',
          'The school subscription has expired. Contact your school administrator.',
        );
      }
      if (
        snapshot.accessMode === 'GRACE' &&
        !principal.permissions.has('tenant.subscription.read')
      ) {
        throw new AuthorizationError(
          'SUBSCRIPTION_EXPIRED',
          'The school subscription has expired. Contact your school administrator.',
          { grace_ends_at: snapshot.subscription.graceEndsAt },
        );
      }
    }
    return {
      tenantId: tenant.id,
      tenantStatus: tenant.status,
      actingAsPlatform,
      entitlements: snapshot,
    };
  }

  // ---- Permission + entitlement
  const authorizeMw = (permissions: string[]): RequestHandler =>
    handler(async (req, _res, next) => {
      authorize(req.ctx.principal!, req.ctx.tenant, permissions);
      next();
    });

  const authRateLimit = rateLimit({
    windowMs: 60_000,
    limit: deps.env.NODE_ENV === 'test' ? 10_000 : 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, _res, next) =>
      next(new AppError(429, 'RATE_LIMITED', 'Too many attempts. Try again in a minute.')),
  });

  return { authenticate, resolveContext, authorize: authorizeMw, authRateLimit };
}
