import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Executor } from '../../db/client.js';
import { entitlements, planFeatures, subscriptions } from '../../db/schema/index.js';

/** Subscriptions whose plan entitlements are live (everything except replaced / not yet started). */
export const LIVE_SUBSCRIPTION_STATUSES = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'EXPIRED',
  'CANCELLED',
] as const;

/**
 * Make the PLAN-sourced entitlement rows of every live subscription on the given
 * plan versions match the versions' feature lists: grant what was added, revoke
 * what was removed (history is kept as REVOKED). Returns the affected school ids
 * so the caller can drop their cached entitlements after the transaction commits.
 */
export async function syncPlanVersionEntitlements(
  tx: Executor,
  planVersionIds: string[],
  now: Date,
  grantedBy: string | null,
): Promise<string[]> {
  if (planVersionIds.length === 0) return [];
  const subs = await tx
    .select({
      id: subscriptions.id,
      tenantId: subscriptions.tenantId,
      planVersionId: subscriptions.planVersionId,
    })
    .from(subscriptions)
    .where(
      and(
        inArray(subscriptions.planVersionId, planVersionIds),
        inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
        isNull(subscriptions.endedAt),
      ),
    );
  if (subs.length === 0) return [];

  const wantedRows = await tx
    .select({ versionId: planFeatures.planVersionId, featureId: planFeatures.featureId })
    .from(planFeatures)
    .where(inArray(planFeatures.planVersionId, planVersionIds));
  const wanted = new Map<string, Set<string>>();
  for (const r of wantedRows) {
    if (!wanted.has(r.versionId)) wanted.set(r.versionId, new Set());
    wanted.get(r.versionId)!.add(r.featureId);
  }

  const existingRows = await tx
    .select({
      id: entitlements.id,
      featureId: entitlements.featureId,
      sourceReference: entitlements.sourceReference,
    })
    .from(entitlements)
    .where(
      and(
        inArray(
          entitlements.sourceReference,
          subs.map((s) => s.id),
        ),
        eq(entitlements.sourceType, 'PLAN'),
        eq(entitlements.status, 'ACTIVE'),
      ),
    );

  const touched = new Set<string>();
  for (const sub of subs) {
    const want = wanted.get(sub.planVersionId) ?? new Set<string>();
    const have = existingRows.filter((r) => r.sourceReference === sub.id);
    const haveIds = new Set(have.map((r) => r.featureId));
    const toAdd = [...want].filter((f) => !haveIds.has(f));
    const toRevoke = have.filter((r) => !want.has(r.featureId)).map((r) => r.id);
    if (toAdd.length) {
      await tx.insert(entitlements).values(
        toAdd.map((featureId) => ({
          tenantId: sub.tenantId,
          featureId,
          sourceType: 'PLAN' as const,
          sourceReference: sub.id,
          effect: 'GRANT' as const,
          startsAt: now,
          grantedBy,
        })),
      );
    }
    if (toRevoke.length) {
      await tx
        .update(entitlements)
        .set({ status: 'REVOKED', endsAt: now })
        .where(inArray(entitlements.id, toRevoke));
    }
    if (toAdd.length || toRevoke.length) touched.add(sub.tenantId);
  }
  return [...touched];
}
