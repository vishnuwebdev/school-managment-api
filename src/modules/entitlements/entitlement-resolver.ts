import type { EntitlementEffect, EntitlementSource } from '../../db/schema/index.js';
import type { AccessMode, EffectiveSubscription } from './subscription-state.js';

export interface FeatureNode {
  code: string;
  isCore: boolean;
  dependsOn: string[];
}

export interface EntitlementRow {
  featureCode: string;
  sourceType: EntitlementSource;
  sourceReference: string | null;
  effect: EntitlementEffect;
  startsAt: Date;
  endsAt: Date | null;
}

export interface BlockedFeature {
  feature: string;
  reason: 'DEPENDENCY_MISSING' | 'DENIED_BY_OVERRIDE';
  missing?: string[];
}

/** Serializable result cached per tenant. */
export interface EntitlementSnapshot {
  accessMode: AccessMode;
  subscription: {
    id: string | null;
    status: string;
    planCode: string | null;
    expiredAt: string | null;
    graceEndsAt: string | null;
  };
  features: string[];
  blocked: BlockedFeature[];
  /** Plan limits of the governing subscription; null = unlimited. */
  limits?: PlanLimits;
  resolvedAt: string;
}

export interface PlanLimits {
  maxStaffUsers: number | null;
  maxStudents: number | null;
}

/**
 * Entitlement resolver — the only place that turns commercial state into
 * effective capabilities. Domain code asks "is feature X enabled for this
 * tenant?", never "is this tenant on plan Y?".
 *
 *   plan + add-ons + contracts + overrides + validity + subscription state
 *   + dependencies  →  effective feature set
 */
export function resolveEntitlements(input: {
  catalog: FeatureNode[];
  rows: EntitlementRow[];
  subscription: EffectiveSubscription;
  planCode: string | null;
  limits?: PlanLimits;
  now: Date;
}): EntitlementSnapshot {
  const { catalog, rows, subscription, now } = input;
  const valid = (r: EntitlementRow) => r.startsAt <= now && (r.endsAt === null || r.endsAt > now);
  const known = new Set(catalog.map((f) => f.code));

  const granted = new Set<string>();
  if (subscription.accessMode === 'FULL') {
    for (const r of rows) {
      if (r.effect !== 'GRANT' || !valid(r) || !known.has(r.featureCode)) continue;
      // Plan/add-on grants only count while they belong to the governing subscription.
      if (
        (r.sourceType === 'PLAN' || r.sourceType === 'ADD_ON') &&
        r.sourceReference !== subscription.subscriptionId
      )
        continue;
      granted.add(r.featureCode);
    }
  }

  const blocked: BlockedFeature[] = [];
  for (const r of rows) {
    if (r.effect === 'DENY' && valid(r) && granted.delete(r.featureCode)) {
      blocked.push({ feature: r.featureCode, reason: 'DENIED_BY_OVERRIDE' });
    }
  }

  // Core capabilities are always present for an accessible tenant.
  for (const f of catalog) if (f.isCore) granted.add(f.code);

  // Dependency closure: drop anything whose prerequisites are missing, until stable.
  const byCode = new Map(catalog.map((f) => [f.code, f]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const code of [...granted]) {
      const missing = (byCode.get(code)?.dependsOn ?? []).filter((d) => !granted.has(d));
      if (missing.length > 0) {
        granted.delete(code);
        blocked.push({ feature: code, reason: 'DEPENDENCY_MISSING', missing });
        changed = true;
      }
    }
  }

  return {
    accessMode: subscription.accessMode,
    subscription: {
      id: subscription.subscriptionId,
      status: subscription.effectiveStatus,
      planCode: input.planCode,
      expiredAt: subscription.expiredAt?.toISOString() ?? null,
      graceEndsAt: subscription.graceEndsAt?.toISOString() ?? null,
    },
    features: [...granted].sort(),
    blocked,
    limits: input.limits ?? { maxStaffUsers: null, maxStudents: null },
    resolvedAt: now.toISOString(),
  };
}

/** Features that (transitively) depend on `code` — shown before disabling it. */
export function dependentsOf(catalog: FeatureNode[], code: string): string[] {
  const out = new Set<string>();
  const visit = (c: string) => {
    for (const f of catalog) {
      if (f.dependsOn.includes(c) && !out.has(f.code)) {
        out.add(f.code);
        visit(f.code);
      }
    }
  };
  visit(code);
  return [...out].sort();
}

/** API representation (snake_case, like every other response). */
export function presentSnapshot(s: EntitlementSnapshot) {
  return {
    access_mode: s.accessMode,
    subscription: {
      id: s.subscription.id,
      status: s.subscription.status,
      plan_code: s.subscription.planCode,
      expired_at: s.subscription.expiredAt,
      grace_ends_at: s.subscription.graceEndsAt,
    },
    features: s.features,
    blocked: s.blocked,
    limits: {
      max_staff_users: s.limits?.maxStaffUsers ?? null,
      max_students: s.limits?.maxStudents ?? null,
    },
    resolved_at: s.resolvedAt,
  };
}
