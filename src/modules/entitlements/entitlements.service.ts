import { and, eq, inArray } from 'drizzle-orm';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  entitlements,
  featureDependencies,
  features,
  planFeatures,
  plans,
  planVersions,
  subscriptions,
} from '../../db/schema/index.js';
import { cacheKeys } from '../../infrastructure/cache.js';
import { tenants } from '../../db/schema/index.js';
import { recordAudit } from '../../platform/audit.js';
import type { Actor } from '../../platform/context.js';
import { publishEvent } from '../../platform/outbox.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors.js';
import {
  resolveEntitlements,
  type EntitlementSnapshot,
  type FeatureNode,
} from './entitlement-resolver.js';
import { currentSubscription, effectiveSubscription } from './subscription-state.js';

export class EntitlementService {
  constructor(private readonly deps: Deps) {}

  async catalog(executor: Executor = this.deps.db): Promise<FeatureNode[]> {
    const [rows, deps] = await Promise.all([
      executor
        .select({ id: features.id, code: features.code, isCore: features.isCore })
        .from(features)
        .where(eq(features.status, 'ACTIVE')),
      executor.select().from(featureDependencies),
    ]);
    const codeById = new Map(rows.map((r) => [r.id, r.code]));
    return rows.map((r) => ({
      code: r.code,
      isCore: r.isCore,
      dependsOn: deps
        .filter((d) => d.featureId === r.id)
        .map((d) => codeById.get(d.dependsOnFeatureId))
        .filter((c): c is string => !!c),
    }));
  }

  /** Effective entitlements for a tenant (cached; invalidated on every change). */
  async snapshot(tenantId: string): Promise<EntitlementSnapshot> {
    // Versioned key: a slow read that started before a change can never
    // re-populate the cache with a stale snapshot after invalidation.
    const version = await this.deps.cache.version(cacheKeys.tenantEntitlementsNamespace(tenantId));
    return this.deps.cache.remember(
      cacheKeys.tenantEntitlements(tenantId, version),
      this.deps.env.CACHE_TTL_SECONDS,
      () => this.compute(tenantId),
    );
  }

  async compute(tenantId: string, executor: Executor = this.deps.db): Promise<EntitlementSnapshot> {
    const now = this.deps.clock.now();
    const [catalog, subs, rows] = await Promise.all([
      this.catalog(executor),
      executor
        .select({
          id: subscriptions.id,
          status: subscriptions.status,
          startsAt: subscriptions.startsAt,
          trialEndsAt: subscriptions.trialEndsAt,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          cancelledAt: subscriptions.cancelledAt,
          endedAt: subscriptions.endedAt,
          planCode: plans.code,
        })
        .from(subscriptions)
        .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
        .innerJoin(plans, eq(plans.id, planVersions.planId))
        .where(eq(subscriptions.tenantId, tenantId)),
      executor
        .select({
          featureCode: features.code,
          sourceType: entitlements.sourceType,
          sourceReference: entitlements.sourceReference,
          effect: entitlements.effect,
          startsAt: entitlements.startsAt,
          endsAt: entitlements.endsAt,
        })
        .from(entitlements)
        .innerJoin(features, eq(features.id, entitlements.featureId))
        .where(and(eq(entitlements.tenantId, tenantId), eq(entitlements.status, 'ACTIVE'))),
    ]);
    const current = currentSubscription(subs, now);
    return resolveEntitlements({
      catalog,
      rows,
      subscription: effectiveSubscription(current, now, this.deps.env.SUBSCRIPTION_GRACE_DAYS),
      planCode: current?.planCode ?? null,
      now,
    });
  }

  async invalidate(tenantId: string): Promise<void> {
    await this.deps.cache.bump(cacheKeys.tenantEntitlementsNamespace(tenantId));
  }

  /** Create PLAN-sourced entitlement rows for a subscription (inside the caller's transaction). */
  async materializePlan(
    tx: Executor,
    tenantId: string,
    subscriptionId: string,
    planVersionId: string,
    actor: Actor,
  ): Promise<void> {
    const rows = await tx
      .select({ featureId: planFeatures.featureId })
      .from(planFeatures)
      .where(eq(planFeatures.planVersionId, planVersionId));
    if (rows.length === 0) return;
    await tx.insert(entitlements).values(
      rows.map((r) => ({
        tenantId,
        featureId: r.featureId,
        sourceType: 'PLAN' as const,
        sourceReference: subscriptionId,
        effect: 'GRANT' as const,
        startsAt: this.deps.clock.now(),
        grantedBy: actor.userId,
      })),
    );
  }

  /** Revoke entitlement rows sourced from a subscription (history is kept as REVOKED). */
  async revokeSubscriptionSourced(
    tx: Executor,
    tenantId: string,
    subscriptionId: string,
  ): Promise<void> {
    await tx
      .update(entitlements)
      .set({ status: 'REVOKED', endsAt: this.deps.clock.now() })
      .where(
        and(
          eq(entitlements.tenantId, tenantId),
          eq(entitlements.sourceReference, subscriptionId),
          eq(entitlements.status, 'ACTIVE'),
          inArray(entitlements.sourceType, ['PLAN', 'ADD_ON']),
        ),
      );
  }

  /**
   * Platform override: explicitly GRANT or DENY a feature for a tenant.
   * Any change that switches off features the school has today (including
   * dependents) requires `confirm: true` and reports the impact — dependencies
   * never cascade silently, and data is never deleted. The impact is computed
   * inside the transaction, on the state the change is actually applied to.
   */
  async setOverride(
    tenantId: string,
    input: {
      featureCode: string;
      effect: 'GRANT' | 'DENY';
      reason: string;
      endsAt?: Date | null;
      confirm?: boolean;
    },
    actor: Actor,
  ) {
    const [feature] = await this.deps.db
      .select()
      .from(features)
      .where(eq(features.code, input.featureCode));
    if (!feature) throw new NotFoundError('Feature');
    if (feature.isCore)
      throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'Core features cannot be overridden');

    const id = await this.deps.db.transaction(async (tx) => {
      await lockTenant(tx, tenantId);
      const before = await this.compute(tenantId, tx);
      const [previous] = await tx
        .select()
        .from(entitlements)
        .where(this.activeOverrideOf(tenantId, feature.id));
      await tx
        .update(entitlements)
        .set({ status: 'REVOKED', endsAt: this.deps.clock.now() })
        .where(this.activeOverrideOf(tenantId, feature.id));
      const [row] = await tx
        .insert(entitlements)
        .values({
          tenantId,
          featureId: feature.id,
          sourceType: 'ADMIN_OVERRIDE',
          effect: input.effect,
          startsAt: this.deps.clock.now(),
          endsAt: input.endsAt ?? null,
          grantedBy: actor.userId,
          reason: input.reason,
        })
        .$returningId();
      await this.assertNoSilentLoss(tx, tenantId, before, feature.code, input.confirm);
      await recordAudit(tx, actor, {
        tenantId,
        action: 'ENTITLEMENT_OVERRIDE_SET',
        entityType: 'entitlement',
        entityId: row!.id,
        before: previous
          ? { feature: feature.code, effect: previous.effect, ends_at: previous.endsAt }
          : null,
        after: { feature: feature.code, effect: input.effect, ends_at: input.endsAt ?? null },
        reason: input.reason,
      });
      await publishEvent(tx, actor, {
        tenantId,
        eventType: 'entitlement.changed',
        aggregateType: 'tenant',
        aggregateId: tenantId,
        payload: { tenant_id: tenantId, feature: feature.code, effect: input.effect },
      });
      return row!.id;
    });
    await this.invalidate(tenantId);
    return { id, snapshot: await this.snapshot(tenantId) };
  }

  async removeOverride(
    tenantId: string,
    featureCode: string,
    input: { reason: string; confirm?: boolean },
    actor: Actor,
  ) {
    const [feature] = await this.deps.db
      .select()
      .from(features)
      .where(eq(features.code, featureCode));
    if (!feature) throw new NotFoundError('Feature');
    await this.deps.db.transaction(async (tx) => {
      await lockTenant(tx, tenantId);
      const before = await this.compute(tenantId, tx);
      const [previous] = await tx
        .select()
        .from(entitlements)
        .where(this.activeOverrideOf(tenantId, feature.id));
      if (!previous) throw new NotFoundError('Active override');
      await tx
        .update(entitlements)
        .set({ status: 'REVOKED', endsAt: this.deps.clock.now() })
        .where(eq(entitlements.id, previous.id));
      // Removing a GRANT can switch off the feature and everything depending on it.
      await this.assertNoSilentLoss(tx, tenantId, before, feature.code, input.confirm);
      await recordAudit(tx, actor, {
        tenantId,
        action: 'ENTITLEMENT_OVERRIDE_REMOVED',
        entityType: 'entitlement',
        entityId: previous.id,
        before: { feature: feature.code, effect: previous.effect },
        reason: input.reason,
      });
      await publishEvent(tx, actor, {
        tenantId,
        eventType: 'entitlement.changed',
        aggregateType: 'tenant',
        aggregateId: tenantId,
        payload: { tenant_id: tenantId, feature: feature.code, effect: 'REMOVED' },
      });
    });
    await this.invalidate(tenantId);
    return this.snapshot(tenantId);
  }

  private activeOverrideOf(tenantId: string, featureId: string) {
    return and(
      eq(entitlements.tenantId, tenantId),
      eq(entitlements.featureId, featureId),
      eq(entitlements.sourceType, 'ADMIN_OVERRIDE'),
      eq(entitlements.status, 'ACTIVE'),
    );
  }

  /**
   * Compare effective features before/after a change (inside its transaction).
   * `expected` is the feature the caller explicitly targets; losing only that
   * one is the intent, anything more needs confirmation.
   */
  private async assertNoSilentLoss(
    tx: Executor,
    tenantId: string,
    before: EntitlementSnapshot,
    expected: string | null,
    confirm: boolean | undefined,
  ) {
    if (confirm || before.accessMode !== 'FULL') return;
    const after = await this.compute(tenantId, tx);
    const lost = before.features.filter((f) => !after.features.includes(f));
    const unexpected = lost.filter((f) => f !== expected);
    if (unexpected.length > 0) {
      throw new ConflictError(
        'CONFIRMATION_REQUIRED',
        'This change switches off features the school uses today. Resend with confirm=true to proceed.',
        { impacted_features: lost.sort() },
      );
    }
  }

  async listOverrides(tenantId: string) {
    return this.deps.db
      .select({
        id: entitlements.id,
        feature: features.code,
        effect: entitlements.effect,
        startsAt: entitlements.startsAt,
        endsAt: entitlements.endsAt,
        reason: entitlements.reason,
        grantedBy: entitlements.grantedBy,
      })
      .from(entitlements)
      .innerJoin(features, eq(features.id, entitlements.featureId))
      .where(
        and(
          eq(entitlements.tenantId, tenantId),
          eq(entitlements.sourceType, 'ADMIN_OVERRIDE'),
          eq(entitlements.status, 'ACTIVE'),
        ),
      );
  }
}

/** Serialize entitlement changes per school. */
async function lockTenant(tx: Executor, tenantId: string) {
  const [row] = await tx
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .for('update');
  if (!row) throw new NotFoundError('School');
}
