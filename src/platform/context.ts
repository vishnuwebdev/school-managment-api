import type { ActorType, MembershipKind, ScopeType, TenantStatus } from '../db/schema/index.js';
import type { EntitlementSnapshot } from '../modules/entitlements/entitlement-resolver.js';

export interface RequestMeta {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface ScopeGrant {
  type: ScopeType;
  ref: Record<string, string[]> | null;
}

/** Who is calling, resolved from a verified session — never from client input. */
export interface Principal {
  userId: string;
  sessionId: string;
  membershipId: string;
  membershipKind: MembershipKind;
  actorType: Extract<ActorType, 'USER' | 'PLATFORM_USER'>;
  /** Effective permission codes in the current context. */
  permissions: ReadonlySet<string>;
  /** Scope grants per permission (union across role assignments). */
  scopes: Readonly<Record<string, ScopeGrant[]>>;
}

/** Established by the tenant-context middleware for tenant routes. */
export interface TenantContext {
  tenantId: string;
  tenantStatus: TenantStatus;
  /** True when a platform user is acting inside the school (support access). */
  actingAsPlatform: boolean;
  entitlements: EntitlementSnapshot;
}

export interface RequestContext {
  meta: RequestMeta;
  principal?: Principal;
  tenant?: TenantContext;
}

/** Minimal actor description used by audit and outbox writes. */
export interface Actor {
  userId: string | null;
  actorType: ActorType;
  tenantId: string | null;
  meta?: RequestMeta;
}

export const systemActor = (tenantId: string | null = null): Actor => ({
  userId: null,
  actorType: 'SYSTEM',
  tenantId,
});

export function actorFrom(ctx: RequestContext): Actor {
  return {
    userId: ctx.principal?.userId ?? null,
    actorType: ctx.principal?.actorType ?? 'ANONYMOUS',
    tenantId: ctx.tenant?.tenantId ?? null,
    meta: ctx.meta,
  };
}

declare module 'express-serve-static-core' {
  interface Request {
    ctx: RequestContext;
  }
}
