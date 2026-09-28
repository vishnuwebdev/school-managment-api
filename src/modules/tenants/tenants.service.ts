import { presentSnapshot } from '../entitlements/entitlement-resolver.js';
import { and, count, desc, eq, inArray, like, or, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  memberships,
  plans,
  planVersions,
  roles,
  schoolRequests,
  subscriptionItems,
  subscriptions,
  tenantSettings,
  tenantStatusHistory,
  tenants,
  type BillingInterval,
  type TenantStatus,
} from '../../db/schema/index.js';
import { recordAudit } from '../../platform/audit.js';
import type { Actor } from '../../platform/context.js';
import { publishEvent } from '../../platform/outbox.js';
import {
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
} from '../../shared/errors.js';
import { offsetOf, orderFrom, pageOf, type PaginationQuery } from '../../shared/pagination.js';
import { addDays } from '../../shared/time.js';
import type { AuthorizationService } from '../access/authorization.service.js';
import type { EntitlementService } from '../entitlements/entitlements.service.js';
import { inviteMember } from '../members/invitations.js';
import { assertTransition } from './lifecycle.js';
import { presentSettings, presentTenant } from './presenters.js';
import type {
  ChangeSubscriptionBody,
  CreateTenantBody,
  ProvisionBody,
  SettingsBody,
  UpdateTenantBody,
} from './schemas.js';

type ProfileInput = Partial<z.infer<typeof CreateTenantBody>>;

const DEFAULT_WORKING_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function profileColumns(input: ProfileInput) {
  const out: Partial<typeof tenants.$inferInsert> = {};
  if (input.name !== undefined) out.name = input.name;
  if (input.short_name !== undefined) out.shortName = input.short_name;
  if (input.school_type !== undefined) out.schoolType = input.school_type;
  if (input.contact_email !== undefined) out.contactEmail = input.contact_email;
  if (input.contact_phone !== undefined) out.contactPhone = input.contact_phone;
  const a = input.address;
  if (a) {
    if (a.line1 !== undefined) out.addressLine1 = a.line1;
    if (a.line2 !== undefined) out.addressLine2 = a.line2;
    if (a.city !== undefined) out.city = a.city;
    if (a.state !== undefined) out.state = a.state;
    if (a.postal_code !== undefined) out.postalCode = a.postal_code;
    if (a.country !== undefined) out.country = a.country;
  }
  return out;
}

function settingsColumns(input: Partial<z.infer<typeof SettingsBody>>) {
  const out: Partial<typeof tenantSettings.$inferInsert> = {};
  if (input.timezone !== undefined) out.timezone = input.timezone;
  if (input.locale !== undefined) out.locale = input.locale;
  if (input.currency !== undefined) out.currency = input.currency;
  if (input.date_format !== undefined) out.dateFormat = input.date_format;
  if (input.week_starts_on !== undefined) out.weekStartsOn = input.week_starts_on;
  if (input.working_days !== undefined) out.workingDays = input.working_days;
  if (input.academic_year_start_month !== undefined)
    out.academicYearStartMonth = input.academic_year_start_month;
  if (input.brand_primary_color !== undefined) out.brandPrimaryColor = input.brand_primary_color;
  return out;
}

export class TenantService {
  constructor(
    private readonly deps: Deps,
    private readonly entitlements: EntitlementService,
    private readonly authz: AuthorizationService,
  ) {}

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async list(q: PaginationQuery & { status?: TenantStatus }) {
    const conds: SQL[] = [];
    if (q.status) conds.push(eq(tenants.status, q.status));
    if (q.search)
      conds.push(or(like(tenants.name, `%${q.search}%`), like(tenants.code, `%${q.search}%`))!);
    const where = conds.length ? and(...conds) : undefined;
    const [rows, [total]] = await Promise.all([
      this.deps.db
        .select()
        .from(tenants)
        .where(where)
        .orderBy(
          orderFrom(
            q,
            {
              created_at: tenants.createdAt,
              name: tenants.name,
              code: tenants.code,
              status: tenants.status,
            },
            'created_at',
          ),
        )
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.deps.db.select({ n: count() }).from(tenants).where(where),
    ]);
    return pageOf(rows.map(presentTenant), total?.n ?? 0, q);
  }

  async getRow(tenantId: string, executor: Executor = this.deps.db) {
    const [row] = await executor.select().from(tenants).where(eq(tenants.id, tenantId));
    if (!row) throw new NotFoundError('School');
    return row;
  }

  async detail(tenantId: string) {
    const tenant = await this.getRow(tenantId);
    const [settings] = await this.deps.db
      .select()
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    const [members] = await this.deps.db
      .select({ n: count() })
      .from(memberships)
      .where(
        and(eq(memberships.tenantId, tenantId), inArray(memberships.status, ['ACTIVE', 'INVITED'])),
      );
    const snapshot = await this.entitlements.snapshot(tenantId);
    return {
      ...presentTenant(tenant),
      settings: settings ? presentSettings(settings) : null,
      member_count: members?.n ?? 0,
      entitlements: presentSnapshot(snapshot),
    };
  }

  async getSettings(tenantId: string) {
    const [settings] = await this.deps.db
      .select()
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, tenantId));
    if (!settings) throw new NotFoundError('School settings');
    return presentSettings(settings);
  }

  async statusHistory(tenantId: string) {
    await this.getRow(tenantId);
    const rows = await this.deps.db
      .select()
      .from(tenantStatusHistory)
      .where(eq(tenantStatusHistory.tenantId, tenantId))
      .orderBy(desc(tenantStatusHistory.createdAt));
    return rows.map((r) => ({
      id: r.id,
      from_status: r.fromStatus,
      to_status: r.toStatus,
      reason: r.reason,
      actor_user_id: r.actorUserId,
      created_at: r.createdAt.toISOString(),
    }));
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  async create(
    input: z.infer<typeof CreateTenantBody>,
    actor: Actor,
    opts: { schoolRequestId?: string; executor?: Executor } = {},
  ) {
    const run = async (tx: Executor) => {
      const [row] = await tx
        .insert(tenants)
        .values({
          code: input.code,
          status: 'APPROVED',
          createdBy: actor.userId,
          ...profileColumns(input),
          name: input.name,
        })
        .$returningId();
      const tenantId = row!.id;
      await tx.insert(tenantSettings).values({ tenantId, workingDays: DEFAULT_WORKING_DAYS });
      await tx.insert(tenantStatusHistory).values({
        tenantId,
        fromStatus: null,
        toStatus: 'APPROVED',
        actorUserId: actor.userId,
        reason: opts.schoolRequestId ? 'Approved school request' : 'Created by platform',
      });
      await recordAudit(tx, actor, {
        tenantId,
        action: 'TENANT_CREATED',
        entityType: 'tenant',
        entityId: tenantId,
        after: { code: input.code, name: input.name },
      });
      await publishEvent(tx, actor, {
        tenantId,
        eventType: 'tenant.created',
        aggregateType: 'tenant',
        aggregateId: tenantId,
        payload: { tenant_id: tenantId, code: input.code },
      });
      return tenantId;
    };
    try {
      const id = opts.executor ? await run(opts.executor) : await this.deps.db.transaction(run);
      return id;
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw new ConflictError('DUPLICATE_RESOURCE', 'A school with this code already exists', {
          field: 'code',
        });
      throw err;
    }
  }

  /** Optimistic concurrency: the caller must send the version it read. */
  async updateProfile(tenantId: string, input: z.infer<typeof UpdateTenantBody>, actor: Actor) {
    return this.deps.db.transaction(async (tx) => {
      const before = await this.getRow(tenantId, tx);
      const changes = profileColumns(input);
      const [res] = await tx
        .update(tenants)
        .set({ ...changes, version: before.version + 1 })
        .where(and(eq(tenants.id, tenantId), eq(tenants.version, input.version)));
      if (res.affectedRows !== 1)
        throw new ConflictError('CONFLICT', undefined, { current_version: before.version });
      const after = await this.getRow(tenantId, tx);
      await recordAudit(tx, actor, {
        tenantId,
        action: 'TENANT_UPDATED',
        entityType: 'tenant',
        entityId: tenantId,
        before: presentTenant(before),
        after: presentTenant(after),
      });
      return presentTenant(after);
    });
  }

  async updateSettings(tenantId: string, input: z.infer<typeof SettingsBody>, actor: Actor) {
    return this.deps.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tenantId));
      if (!before) throw new NotFoundError('School settings');
      const [res] = await tx
        .update(tenantSettings)
        .set({ ...settingsColumns(input), version: before.version + 1, updatedBy: actor.userId })
        .where(
          and(eq(tenantSettings.tenantId, tenantId), eq(tenantSettings.version, input.version)),
        );
      if (res.affectedRows !== 1)
        throw new ConflictError('CONFLICT', undefined, { current_version: before.version });
      const [after] = await tx
        .select()
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, tenantId));
      await recordAudit(tx, actor, {
        tenantId,
        action: 'TENANT_SETTINGS_UPDATED',
        entityType: 'tenant_settings',
        entityId: tenantId,
        before: presentSettings(before),
        after: presentSettings(after!),
      });
      return presentSettings(after!);
    });
  }

  /** Suspend / reactivate / archive. Data is always preserved. */
  async transition(
    tenantId: string,
    to: TenantStatus,
    reason: string,
    actor: Actor,
    opts: { restore?: boolean } = {},
  ) {
    const result = await this.deps.db.transaction(async (tx) => {
      const [tenant] = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      if (!tenant) throw new NotFoundError('School');
      if (to === 'ACTIVE' && tenant.status !== 'SUSPENDED') {
        throw new BusinessRuleError(
          'INVALID_STATE',
          'Only a suspended school can be reactivated. New schools become active through provisioning.',
        );
      }
      if ((tenant.status === 'ARCHIVED') !== !!opts.restore) {
        throw new BusinessRuleError(
          'INVALID_STATE',
          opts.restore
            ? 'Only an archived school can be restored'
            : 'An archived school must be restored before any other change',
        );
      }
      assertTransition(tenant.status, to);
      await this.setStatus(tx, tenant, to, reason, actor);
      return this.getRow(tenantId, tx);
    });
    await this.entitlements.invalidate(tenantId);
    return presentTenant(result);
  }

  private async setStatus(
    tx: Executor,
    tenant: typeof tenants.$inferSelect,
    to: TenantStatus,
    reason: string | null,
    actor: Actor,
  ) {
    const now = this.deps.clock.now();
    const stamps: Partial<typeof tenants.$inferInsert> = {};
    if (to === 'ACTIVE') stamps.activatedAt = tenant.activatedAt ?? now;
    if (to === 'SUSPENDED') stamps.suspendedAt = now;
    if (to === 'ARCHIVED') stamps.archivedAt = now;
    await tx
      .update(tenants)
      .set({ status: to, ...stamps, version: tenant.version + 1 })
      .where(eq(tenants.id, tenant.id));
    await tx.insert(tenantStatusHistory).values({
      tenantId: tenant.id,
      fromStatus: tenant.status,
      toStatus: to,
      reason,
      actorUserId: actor.userId,
    });
    await recordAudit(tx, actor, {
      tenantId: tenant.id,
      action: `TENANT_${to}`,
      entityType: 'tenant',
      entityId: tenant.id,
      before: { status: tenant.status },
      after: { status: to },
      reason,
    });
    await publishEvent(tx, actor, {
      tenantId: tenant.id,
      eventType: 'tenant.status_changed',
      aggregateType: 'tenant',
      aggregateId: tenant.id,
      payload: { tenant_id: tenant.id, from: tenant.status, to },
    });
    tenant.status = to;
    tenant.version += 1;
  }

  /**
   * Provisioning — one transaction, so a failure leaves the school APPROVED
   * and retryable, never partially active:
   *   settings → subscription → plan entitlements → first admin invitation → ACTIVE
   */
  async provision(tenantId: string, input: z.infer<typeof ProvisionBody>, actor: Actor) {
    const result = await this.deps.db.transaction(async (tx) => {
      const [tenant] = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      if (!tenant) throw new NotFoundError('School');
      if (tenant.status !== 'APPROVED')
        throw new BusinessRuleError(
          'INVALID_STATE',
          `Only an APPROVED school can be provisioned (current: ${tenant.status})`,
        );

      await this.setStatus(tx, tenant, 'PROVISIONING', 'Provisioning started', actor);

      if (input.settings) {
        await tx
          .update(tenantSettings)
          .set({ ...settingsColumns(input.settings), updatedBy: actor.userId })
          .where(eq(tenantSettings.tenantId, tenantId));
      }

      const subscriptionId = await this.startSubscription(
        tx,
        tenantId,
        {
          planCode: input.plan_code,
          status: input.trial_days > 0 ? 'TRIAL' : 'ACTIVE',
          billingInterval: input.billing_interval,
          trialDays: input.trial_days,
          autoRenew: true,
        },
        actor,
      );

      const [adminRole] = await tx
        .select()
        .from(roles)
        .where(
          and(
            eq(roles.tenantKey, 'SYSTEM'),
            eq(roles.code, 'SCHOOL_ADMIN'),
            eq(roles.scope, 'TENANT'),
          ),
        );
      if (!adminRole) throw new Error('System role SCHOOL_ADMIN is missing — run the seed');
      const invite = await inviteMember(
        this.deps,
        tx,
        {
          email: input.admin.email,
          firstName: input.admin.first_name,
          lastName: input.admin.last_name,
          tenantId,
          assignments: [{ roleId: adminRole.id }],
        },
        { ...actor, tenantId },
      );

      await this.setStatus(tx, tenant, 'ACTIVE', 'Provisioning completed', actor);
      await recordAudit(tx, actor, {
        tenantId,
        action: 'TENANT_PROVISIONED',
        entityType: 'tenant',
        entityId: tenantId,
        after: {
          plan_code: input.plan_code,
          subscription_id: subscriptionId,
          admin_email: input.admin.email,
        },
      });
      await publishEvent(tx, actor, {
        tenantId,
        eventType: 'tenant.provisioned',
        aggregateType: 'tenant',
        aggregateId: tenantId,
        payload: {
          tenant_id: tenantId,
          subscription_id: subscriptionId,
          admin_membership_id: invite.membershipId,
        },
      });
      return {
        subscriptionId,
        adminMembershipId: invite.membershipId,
        invitationId: invite.invitationId,
      };
    });
    await Promise.all([
      this.entitlements.invalidate(tenantId),
      this.authz.invalidateTenant(tenantId),
    ]);
    return {
      tenant: await this.detail(tenantId),
      subscription_id: result.subscriptionId,
      admin_membership_id: result.adminMembershipId,
      invitation_id: result.invitationId,
    };
  }

  /** Replace the governing subscription (plan change, renewal, conversion from trial). History is preserved. */
  async changeSubscription(
    tenantId: string,
    input: z.infer<typeof ChangeSubscriptionBody>,
    actor: Actor,
  ) {
    const id = await this.deps.db.transaction(async (tx) => {
      const [tenant] = await tx
        .select()
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      if (!tenant) throw new NotFoundError('School');
      if (tenant.status === 'ARCHIVED')
        throw new BusinessRuleError(
          'INVALID_STATE',
          'An archived school cannot change subscription',
        );
      const now = this.deps.clock.now();
      const before = await this.entitlements.compute(tenantId, tx);
      const open = await tx
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.tenantId, tenantId),
            inArray(subscriptions.status, ['TRIAL', 'ACTIVE', 'PAST_DUE', 'PENDING']),
          ),
        );
      for (const sub of open) {
        // Replaced, not cancelled: cancellation and expiry keep their own meaning.
        await tx
          .update(subscriptions)
          .set({ status: 'SUPERSEDED', endedAt: now, version: sub.version + 1 })
          .where(eq(subscriptions.id, sub.id));
        await this.entitlements.revokeSubscriptionSourced(tx, tenantId, sub.id);
      }
      const newId = await this.startSubscription(
        tx,
        tenantId,
        {
          planCode: input.plan_code,
          status: input.status,
          billingInterval: input.billing_interval,
          trialDays: input.trial_days ?? 14,
          periodEnd: input.current_period_end,
          autoRenew: input.auto_renew,
        },
        actor,
      );
      // A downgrade must never switch features off silently.
      const after = await this.entitlements.compute(tenantId, tx);
      const lost = before.features.filter((f) => !after.features.includes(f));
      if (before.accessMode === 'FULL' && lost.length > 0 && !input.confirm) {
        throw new ConflictError(
          'CONFIRMATION_REQUIRED',
          'This change removes features the school uses today. Resend with confirm=true to proceed.',
          { lost_features: lost },
        );
      }
      await recordAudit(tx, actor, {
        tenantId,
        action: 'SUBSCRIPTION_CHANGED',
        entityType: 'subscription',
        entityId: newId,
        before: open.map((s) => ({ id: s.id, status: s.status })),
        after: { plan_code: input.plan_code, status: input.status },
        reason: input.reason,
      });
      return newId;
    });
    await this.entitlements.invalidate(tenantId);
    return {
      subscription_id: id,
      entitlements: presentSnapshot(await this.entitlements.snapshot(tenantId)),
    };
  }

  /**
   * Cancel the governing subscription. By default access continues until the
   * end of the paid period; `immediately` ends it now (then the grace period applies).
   */
  async cancelSubscription(
    tenantId: string,
    input: { reason: string; immediately: boolean },
    actor: Actor,
  ) {
    await this.deps.db.transaction(async (tx) => {
      await tx.select().from(tenants).where(eq(tenants.id, tenantId)).for('update');
      const [sub] = await tx
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.tenantId, tenantId),
            inArray(subscriptions.status, ['TRIAL', 'ACTIVE', 'PAST_DUE']),
          ),
        )
        .orderBy(desc(subscriptions.startsAt))
        .limit(1);
      if (!sub)
        throw new BusinessRuleError('INVALID_STATE', 'There is no active subscription to cancel');
      const now = this.deps.clock.now();
      await tx
        .update(subscriptions)
        .set({
          status: 'CANCELLED',
          cancelledAt: now,
          endedAt: input.immediately ? now : null,
          autoRenew: false,
          version: sub.version + 1,
        })
        .where(eq(subscriptions.id, sub.id));
      await recordAudit(tx, actor, {
        tenantId,
        action: 'SUBSCRIPTION_CANCELLED',
        entityType: 'subscription',
        entityId: sub.id,
        before: { status: sub.status },
        after: { status: 'CANCELLED', immediately: input.immediately },
        reason: input.reason,
      });
      await publishEvent(tx, actor, {
        tenantId,
        eventType: 'subscription.cancelled',
        aggregateType: 'subscription',
        aggregateId: sub.id,
        payload: { tenant_id: tenantId, subscription_id: sub.id, immediately: input.immediately },
      });
    });
    await this.entitlements.invalidate(tenantId);
    return { entitlements: presentSnapshot(await this.entitlements.snapshot(tenantId)) };
  }

  private async startSubscription(
    tx: Executor,
    tenantId: string,
    input: {
      planCode: string;
      status: 'TRIAL' | 'ACTIVE';
      billingInterval: BillingInterval;
      trialDays: number;
      periodEnd?: Date;
      autoRenew: boolean;
    },
    actor: Actor,
  ) {
    const now = this.deps.clock.now();
    const [version] = await tx
      .select({
        id: planVersions.id,
        currency: planVersions.currency,
        monthly: planVersions.priceMonthlyMinor,
        annual: planVersions.priceAnnualMinor,
      })
      .from(planVersions)
      .innerJoin(plans, eq(plans.id, planVersions.planId))
      .where(
        and(
          eq(plans.code, input.planCode),
          eq(plans.status, 'ACTIVE'),
          eq(planVersions.status, 'ACTIVE'),
        ),
      )
      .orderBy(desc(planVersions.version))
      .limit(1);
    if (!version) throw new NotFoundError('Plan', { plan_code: input.planCode });

    const periodEnd =
      input.status === 'TRIAL'
        ? addDays(now, input.trialDays)
        : (input.periodEnd ?? addDays(now, input.billingInterval === 'MONTHLY' ? 30 : 365));
    if (periodEnd <= now)
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'The subscription period must end in the future',
      );

    const [row] = await tx
      .insert(subscriptions)
      .values({
        tenantId,
        planVersionId: version.id,
        status: input.status,
        currency: version.currency,
        billingInterval: input.billingInterval,
        startsAt: now,
        trialEndsAt: input.status === 'TRIAL' ? periodEnd : null,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        autoRenew: input.autoRenew,
        createdBy: actor.userId,
      })
      .$returningId();
    const price =
      input.status === 'TRIAL'
        ? 0
        : input.billingInterval === 'MONTHLY'
          ? version.monthly
          : version.annual;
    await tx.insert(subscriptionItems).values({
      subscriptionId: row!.id,
      tenantId,
      itemType: 'PLAN',
      currency: version.currency,
      standardPriceMinor: price,
      finalPriceMinor: price,
      startsAt: now,
      endsAt: periodEnd,
    });
    await this.entitlements.materializePlan(tx, tenantId, row!.id, version.id, actor);
    await publishEvent(tx, actor, {
      tenantId,
      eventType: 'subscription.started',
      aggregateType: 'subscription',
      aggregateId: row!.id,
      payload: {
        tenant_id: tenantId,
        subscription_id: row!.id,
        plan_code: input.planCode,
        status: input.status,
      },
    });
    return row!.id;
  }

  async subscriptions(tenantId: string) {
    await this.getRow(tenantId);
    const rows = await this.deps.db
      .select({
        s: subscriptions,
        planCode: plans.code,
        planName: plans.name,
        planVersion: planVersions.version,
      })
      .from(subscriptions)
      .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
      .innerJoin(plans, eq(plans.id, planVersions.planId))
      .where(eq(subscriptions.tenantId, tenantId))
      .orderBy(desc(subscriptions.startsAt));
    return rows.map(({ s, planCode, planName, planVersion }) => ({
      id: s.id,
      plan: { code: planCode, name: planName, version: planVersion },
      status: s.status,
      currency: s.currency,
      billing_interval: s.billingInterval,
      starts_at: s.startsAt.toISOString(),
      trial_ends_at: s.trialEndsAt?.toISOString() ?? null,
      current_period_start: s.currentPeriodStart.toISOString(),
      current_period_end: s.currentPeriodEnd.toISOString(),
      cancelled_at: s.cancelledAt?.toISOString() ?? null,
      ended_at: s.endedAt?.toISOString() ?? null,
      auto_renew: s.autoRenew,
    }));
  }

  // ---------------------------------------------------------------------------
  // School requests (public onboarding form)
  // ---------------------------------------------------------------------------

  async submitRequest(
    input: {
      school_name: string;
      contact_name: string;
      contact_email: string;
      contact_phone?: string;
      city?: string;
      country?: string;
      message?: string;
    },
    actor: Actor,
  ) {
    return this.deps.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schoolRequests)
        .values({
          schoolName: input.school_name,
          contactName: input.contact_name,
          contactEmail: input.contact_email.toLowerCase(),
          contactPhone: input.contact_phone ?? null,
          city: input.city ?? null,
          country: input.country ?? null,
          message: input.message ?? null,
        })
        .$returningId();
      await recordAudit(tx, actor, {
        tenantId: null,
        action: 'SCHOOL_REQUEST_SUBMITTED',
        entityType: 'school_request',
        entityId: row!.id,
        after: { school_name: input.school_name, contact_email: input.contact_email },
      });
      await publishEvent(tx, actor, {
        tenantId: null,
        eventType: 'school_request.submitted',
        aggregateType: 'school_request',
        aggregateId: row!.id,
        payload: { school_request_id: row!.id },
      });
      return { id: row!.id, status: 'PENDING' as const };
    });
  }

  async listRequests(
    q: PaginationQuery & { status?: 'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' },
  ) {
    const where = q.status ? eq(schoolRequests.status, q.status) : undefined;
    const [rows, [total]] = await Promise.all([
      this.deps.db
        .select()
        .from(schoolRequests)
        .where(where)
        .orderBy(
          orderFrom(
            q,
            { created_at: schoolRequests.createdAt, school_name: schoolRequests.schoolName },
            'created_at',
          ),
        )
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.deps.db.select({ n: count() }).from(schoolRequests).where(where),
    ]);
    return pageOf(
      rows.map((r) => ({
        id: r.id,
        school_name: r.schoolName,
        contact_name: r.contactName,
        contact_email: r.contactEmail,
        contact_phone: r.contactPhone,
        city: r.city,
        country: r.country,
        message: r.message,
        status: r.status,
        review_note: r.reviewNote,
        reviewed_at: r.reviewedAt?.toISOString() ?? null,
        tenant_id: r.tenantId,
        created_at: r.createdAt.toISOString(),
      })),
      total?.n ?? 0,
      q,
    );
  }

  async reviewRequest(
    requestId: string,
    decision:
      | { approve: true; tenant: z.infer<typeof CreateTenantBody> }
      | { approve: false; note: string },
    actor: Actor,
  ) {
    return this.deps.db.transaction(async (tx) => {
      const [req] = await tx
        .select()
        .from(schoolRequests)
        .where(eq(schoolRequests.id, requestId))
        .for('update');
      if (!req) throw new NotFoundError('School request');
      if (req.status !== 'PENDING' && req.status !== 'UNDER_REVIEW')
        throw new BusinessRuleError(
          'INVALID_STATE',
          `This request was already ${req.status.toLowerCase()}`,
        );
      const now = this.deps.clock.now();
      if (!decision.approve) {
        await tx
          .update(schoolRequests)
          .set({
            status: 'REJECTED',
            reviewNote: decision.note,
            reviewedBy: actor.userId,
            reviewedAt: now,
          })
          .where(eq(schoolRequests.id, requestId));
        await recordAudit(tx, actor, {
          tenantId: null,
          action: 'SCHOOL_REQUEST_REJECTED',
          entityType: 'school_request',
          entityId: requestId,
          reason: decision.note,
        });
        return { id: requestId, status: 'REJECTED' as const, tenant_id: null };
      }
      let tenantId: string;
      try {
        tenantId = await this.create(decision.tenant, actor, {
          schoolRequestId: requestId,
          executor: tx,
        });
      } catch (err) {
        if (isDuplicateKeyError(err))
          throw new ConflictError('DUPLICATE_RESOURCE', 'A school with this code already exists', {
            field: 'code',
          });
        throw err;
      }
      await tx
        .update(schoolRequests)
        .set({ status: 'APPROVED', tenantId, reviewedBy: actor.userId, reviewedAt: now })
        .where(eq(schoolRequests.id, requestId));
      await recordAudit(tx, actor, {
        tenantId,
        action: 'SCHOOL_REQUEST_APPROVED',
        entityType: 'school_request',
        entityId: requestId,
      });
      return { id: requestId, status: 'APPROVED' as const, tenant_id: tenantId };
    });
  }
}
