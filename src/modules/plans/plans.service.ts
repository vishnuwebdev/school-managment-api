import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  featureDependencies,
  features,
  planFeatures,
  plans,
  planVersions,
  subscriptions,
} from '../../db/schema/index.js';
import { recordAudit } from '../../platform/audit.js';
import type { Actor } from '../../platform/context.js';
import { publishEvent } from '../../platform/outbox.js';
import {
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import type { EntitlementService } from '../entitlements/entitlements.service.js';
import {
  LIVE_SUBSCRIPTION_STATUSES,
  syncPlanVersionEntitlements,
} from '../entitlements/plan-sync.js';

type PlanRow = typeof plans.$inferSelect;
type VersionRow = typeof planVersions.$inferSelect;

export interface PlanFieldsInput {
  name?: string;
  description?: string | null;
  price_monthly_minor?: number;
  price_annual_minor?: number;
  max_staff_users?: number | null;
  max_students?: number | null;
}

export interface FeatureImpact {
  features: string[];
  auto_included: string[];
  added: string[];
  removed: string[];
  schools_affected: number;
  /** Schools that lose each removed feature (every school on the plan does). */
  schools_losing: number;
}

/**
 * Plans are owned by the super admin. Features, limits, name and description
 * apply to every school on the plan immediately; a price change only reaches a
 * school when it starts or renews a subscription, because each subscription
 * stores the price it was sold at.
 */
export class PlanService {
  constructor(
    private readonly deps: Deps,
    private readonly entitlements: EntitlementService,
  ) {}

  // ---- reads --------------------------------------------------------------------

  async list() {
    const db = this.deps.db;
    const planRows = await db.select().from(plans).orderBy(asc(plans.createdAt), asc(plans.code));
    return Promise.all(planRows.map((p) => this.present(db, p)));
  }

  async get(code: string) {
    const plan = await this.row(this.deps.db, code);
    return this.present(this.deps.db, plan);
  }

  /** What changing the plan's features to `requested` would do, without doing it. */
  async preview(code: string, requested: string[]) {
    const db = this.deps.db;
    const plan = await this.row(db, code);
    return this.impactOf(db, plan, requested);
  }

  // ---- writes -------------------------------------------------------------------

  async create(
    input: {
      code: string;
      name: string;
      description?: string | null;
      currency?: string;
      price_monthly_minor: number;
      price_annual_minor: number;
      max_staff_users?: number | null;
      max_students?: number | null;
      features: string[];
      reason: string;
    },
    actor: Actor,
  ) {
    const catalog = await this.featureCatalog(this.deps.db);
    const normalized = normalizeFeatures(catalog, input.features);
    try {
      await this.deps.db.transaction(async (tx) => {
        const [p] = await tx
          .insert(plans)
          .values({ code: input.code, name: input.name, description: input.description ?? null })
          .$returningId();
        const [v] = await tx
          .insert(planVersions)
          .values({
            planId: p!.id,
            version: 1,
            currency: input.currency ?? 'INR',
            priceMonthlyMinor: input.price_monthly_minor,
            priceAnnualMinor: input.price_annual_minor,
            maxStaffUsers: input.max_staff_users ?? null,
            maxStudents: input.max_students ?? null,
            effectiveFrom: this.deps.clock.now(),
          })
          .$returningId();
        if (normalized.features.length)
          await tx.insert(planFeatures).values(
            normalized.features.map((c) => ({
              planVersionId: v!.id,
              featureId: catalog.byCode.get(c)!.id,
            })),
          );
        await recordAudit(tx, actor, {
          tenantId: null,
          action: 'PLAN_CREATED',
          entityType: 'plan',
          entityId: p!.id,
          after: {
            code: input.code,
            name: input.name,
            price_monthly_minor: input.price_monthly_minor,
            price_annual_minor: input.price_annual_minor,
            max_staff_users: input.max_staff_users ?? null,
            max_students: input.max_students ?? null,
            features: normalized.features,
          },
          reason: input.reason,
        });
        await publishEvent(tx, actor, {
          tenantId: null,
          eventType: 'plan.created',
          aggregateType: 'plan',
          aggregateId: p!.id,
          payload: { plan_code: input.code, features: normalized.features },
        });
      });
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw new ConflictError('DUPLICATE_RESOURCE', 'A plan with this code already exists', {
          code: input.code,
        });
      throw err;
    }
    return { ...(await this.get(input.code)), auto_included: normalized.autoIncluded };
  }

  /** Name, description, prices and limits. */
  async update(code: string, input: PlanFieldsInput & { reason: string }, actor: Actor) {
    const affected = await this.deps.db.transaction(async (tx) => {
      const plan = await this.lockPlan(tx, code);
      const versions = await this.versions(tx, plan.id);
      const current = this.currentVersion(versions);
      if (!current) throw new BusinessRuleError('INVALID_STATE', 'This plan has no active version');
      const before = {
        name: plan.name,
        description: plan.description,
        price_monthly_minor: current.priceMonthlyMinor,
        price_annual_minor: current.priceAnnualMinor,
        max_staff_users: current.maxStaffUsers,
        max_students: current.maxStudents,
      };
      const after = {
        name: input.name ?? before.name,
        description: input.description === undefined ? before.description : input.description,
        price_monthly_minor: input.price_monthly_minor ?? before.price_monthly_minor,
        price_annual_minor: input.price_annual_minor ?? before.price_annual_minor,
        max_staff_users:
          input.max_staff_users === undefined ? before.max_staff_users : input.max_staff_users,
        max_students: input.max_students === undefined ? before.max_students : input.max_students,
      };
      if (JSON.stringify(before) === JSON.stringify(after)) return [] as string[];

      await tx
        .update(plans)
        .set({ name: after.name, description: after.description })
        .where(eq(plans.id, plan.id));
      // Price: only the version new subscriptions are sold from.
      await tx
        .update(planVersions)
        .set({
          priceMonthlyMinor: after.price_monthly_minor,
          priceAnnualMinor: after.price_annual_minor,
        })
        .where(eq(planVersions.id, current.id));
      // Limits: every version, so schools on an older version follow immediately.
      await tx
        .update(planVersions)
        .set({ maxStaffUsers: after.max_staff_users, maxStudents: after.max_students })
        .where(eq(planVersions.planId, plan.id));

      await recordAudit(tx, actor, {
        tenantId: null,
        action: 'PLAN_UPDATED',
        entityType: 'plan',
        entityId: plan.id,
        before,
        after,
        reason: input.reason,
      });
      await publishEvent(tx, actor, {
        tenantId: null,
        eventType: 'plan.updated',
        aggregateType: 'plan',
        aggregateId: plan.id,
        payload: { plan_code: code },
      });
      // Limits are part of every school's cached entitlements.
      const limitsChanged =
        before.max_staff_users !== after.max_staff_users ||
        before.max_students !== after.max_students;
      return limitsChanged
        ? this.tenantsOnPlan(
            tx,
            versions.map((v) => v.id),
          )
        : [];
    });
    await this.invalidate(affected);
    return this.get(code);
  }

  /**
   * Replace the features of a plan. Dependencies are added automatically; removing
   * anything from a plan that schools are on needs `confirm`.
   */
  async setFeatures(
    code: string,
    input: { features: string[]; reason: string; confirm?: boolean },
    actor: Actor,
  ) {
    const result = await this.deps.db.transaction(async (tx) => {
      const plan = await this.lockPlan(tx, code);
      const versions = await this.versions(tx, plan.id);
      const impact = await this.impactOf(tx, plan, input.features);
      if (impact.removed.length > 0 && impact.schools_affected > 0 && !input.confirm)
        throw new ConflictError(
          'CONFIRMATION_REQUIRED',
          `This removes ${impact.removed.length} feature(s) from ${impact.schools_affected} school(s) on this plan. Resend with confirm=true to proceed.`,
          impact,
        );
      if (impact.added.length === 0 && impact.removed.length === 0)
        return { impact, tenantIds: [] as string[] };

      const catalog = await this.featureCatalog(tx);
      const versionIds = versions.map((v) => v.id);
      await tx.delete(planFeatures).where(inArray(planFeatures.planVersionId, versionIds));
      if (impact.features.length)
        await tx
          .insert(planFeatures)
          .values(
            versionIds.flatMap((planVersionId) =>
              impact.features.map((c) => ({ planVersionId, featureId: catalog.byCode.get(c)!.id })),
            ),
          );
      const tenantIds = await syncPlanVersionEntitlements(
        tx,
        versionIds,
        this.deps.clock.now(),
        actor.userId,
      );
      await recordAudit(tx, actor, {
        tenantId: null,
        action: 'PLAN_FEATURES_CHANGED',
        entityType: 'plan',
        entityId: plan.id,
        after: {
          added: impact.added,
          removed: impact.removed,
          auto_included: impact.auto_included,
          schools_affected: impact.schools_affected,
        },
        reason: input.reason,
      });
      await publishEvent(tx, actor, {
        tenantId: null,
        eventType: 'plan.features_changed',
        aggregateType: 'plan',
        aggregateId: plan.id,
        payload: {
          plan_code: code,
          added: impact.added,
          removed: impact.removed,
          schools_affected: impact.schools_affected,
        },
      });
      return { impact, tenantIds };
    });
    await this.invalidate(result.tenantIds);
    return { ...(await this.get(code)), impact: result.impact };
  }

  /** Retire a plan (no new schools can be put on it; schools already on it are untouched) or bring it back. */
  async setStatus(code: string, status: 'ACTIVE' | 'ARCHIVED', reason: string, actor: Actor) {
    await this.deps.db.transaction(async (tx) => {
      const plan = await this.lockPlan(tx, code);
      if (plan.status === status) return;
      await tx.update(plans).set({ status }).where(eq(plans.id, plan.id));
      await recordAudit(tx, actor, {
        tenantId: null,
        action: status === 'ARCHIVED' ? 'PLAN_RETIRED' : 'PLAN_RESTORED',
        entityType: 'plan',
        entityId: plan.id,
        before: { status: plan.status },
        after: { status },
        reason,
      });
      await publishEvent(tx, actor, {
        tenantId: null,
        eventType: status === 'ARCHIVED' ? 'plan.retired' : 'plan.restored',
        aggregateType: 'plan',
        aggregateId: plan.id,
        payload: { plan_code: code },
      });
    });
    return this.get(code);
  }

  // ---- internals ----------------------------------------------------------------

  private async row(ex: Executor, code: string): Promise<PlanRow> {
    const [plan] = await ex.select().from(plans).where(eq(plans.code, code));
    if (!plan) throw new NotFoundError('Plan', { plan_code: code });
    return plan;
  }

  private async lockPlan(tx: Executor, code: string): Promise<PlanRow> {
    const [plan] = await tx.select().from(plans).where(eq(plans.code, code)).for('update');
    if (!plan) throw new NotFoundError('Plan', { plan_code: code });
    return plan;
  }

  private versions(ex: Executor, planId: string): Promise<VersionRow[]> {
    return ex
      .select()
      .from(planVersions)
      .where(eq(planVersions.planId, planId))
      .orderBy(desc(planVersions.version));
  }

  /** The version new subscriptions are sold from. */
  private currentVersion(versions: VersionRow[]): VersionRow | undefined {
    return versions.find((v) => v.status === 'ACTIVE');
  }

  private async featureCatalog(ex: Executor) {
    const [rows, deps] = await Promise.all([
      ex.select().from(features).where(eq(features.status, 'ACTIVE')),
      ex.select().from(featureDependencies),
    ]);
    const byCode = new Map(rows.map((f) => [f.code, f]));
    const codeById = new Map(rows.map((f) => [f.id, f.code]));
    const dependsOn = new Map<string, string[]>();
    for (const d of deps) {
      const from = codeById.get(d.featureId);
      const to = codeById.get(d.dependsOnFeatureId);
      if (!from || !to) continue;
      dependsOn.set(from, [...(dependsOn.get(from) ?? []), to]);
    }
    return { byCode, dependsOn };
  }

  private async tenantsOnPlan(ex: Executor, versionIds: string[]): Promise<string[]> {
    if (versionIds.length === 0) return [];
    const rows = await ex
      .selectDistinct({ tenantId: subscriptions.tenantId })
      .from(subscriptions)
      .where(
        and(
          inArray(subscriptions.planVersionId, versionIds),
          inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
          isNull(subscriptions.endedAt),
        ),
      );
    return rows.map((r) => r.tenantId);
  }

  private async impactOf(ex: Executor, plan: PlanRow, requested: string[]): Promise<FeatureImpact> {
    const catalog = await this.featureCatalog(ex);
    const normalized = normalizeFeatures(catalog, requested);
    const versions = await this.versions(ex, plan.id);
    const current = this.currentVersion(versions);
    const have = current
      ? (
          await ex
            .select({ code: features.code })
            .from(planFeatures)
            .innerJoin(features, eq(features.id, planFeatures.featureId))
            .where(eq(planFeatures.planVersionId, current.id))
        ).map((r) => r.code)
      : [];
    const haveSet = new Set(have);
    const wantSet = new Set(normalized.features);
    const schools = (
      await this.tenantsOnPlan(
        ex,
        versions.map((v) => v.id),
      )
    ).length;
    return {
      features: normalized.features,
      auto_included: normalized.autoIncluded,
      added: normalized.features.filter((c) => !haveSet.has(c)),
      removed: have.filter((c) => !wantSet.has(c)).sort(),
      schools_affected: schools,
      schools_losing: schools,
    };
  }

  private async invalidate(tenantIds: string[]) {
    for (let i = 0; i < tenantIds.length; i += 50)
      await Promise.all(tenantIds.slice(i, i + 50).map((t) => this.entitlements.invalidate(t)));
  }

  private async present(ex: Executor, plan: PlanRow) {
    const versions = await this.versions(ex, plan.id);
    const current = this.currentVersion(versions) ?? versions[0];
    const codes = current
      ? (
          await ex
            .select({ code: features.code })
            .from(planFeatures)
            .innerJoin(features, eq(features.id, planFeatures.featureId))
            .where(eq(planFeatures.planVersionId, current.id))
        )
          .map((r) => r.code)
          .sort()
      : [];
    const schools = await this.tenantsOnPlan(
      ex,
      versions.map((v) => v.id),
    );
    return {
      code: plan.code,
      name: plan.name,
      description: plan.description,
      status: plan.status,
      version: current?.version ?? null,
      currency: current?.currency ?? 'INR',
      price_monthly_minor: current?.priceMonthlyMinor ?? 0,
      price_annual_minor: current?.priceAnnualMinor ?? 0,
      max_staff_users: current?.maxStaffUsers ?? null,
      max_students: current?.maxStudents ?? null,
      features: codes,
      schools_count: schools.length,
      updated_at: plan.updatedAt.toISOString(),
    };
  }
}

/**
 * Validate the requested feature codes and add what they depend on (turning on a
 * sub-feature or capability turns on its parent). Core features belong to every
 * school and cannot be put on a plan.
 */
export function normalizeFeatures(
  catalog: {
    byCode: Map<string, { id: string; isCore: boolean }>;
    dependsOn: Map<string, string[]>;
  },
  requested: string[],
): { features: string[]; autoIncluded: string[] } {
  const asked = new Set(requested);
  const unknown = [...asked].filter((c) => !catalog.byCode.has(c));
  if (unknown.length)
    throw new ValidationError('Unknown features', {
      location: 'body',
      issues: [{ path: 'features', code: 'not_found', message: 'Unknown feature', codes: unknown }],
    });
  const core = [...asked].filter((c) => catalog.byCode.get(c)!.isCore);
  if (core.length)
    throw new ValidationError('Core features are part of every plan', {
      location: 'body',
      issues: [
        {
          path: 'features',
          code: 'invalid',
          message: 'Core features cannot be listed',
          codes: core,
        },
      ],
    });
  const out = new Set(asked);
  const stack = [...asked];
  while (stack.length) {
    const c = stack.pop()!;
    for (const d of catalog.dependsOn.get(c) ?? []) {
      if (catalog.byCode.get(d)?.isCore || out.has(d)) continue;
      out.add(d);
      stack.push(d);
    }
  }
  return {
    features: [...out].sort(),
    autoIncluded: [...out].filter((c) => !asked.has(c)).sort(),
  };
}
