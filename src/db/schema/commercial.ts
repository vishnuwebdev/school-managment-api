import {
  bigint,
  boolean,
  char,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dt, id, ref, updatedAt, version } from './_columns.js';
import {
  BILLING_INTERVAL,
  ENTITLEMENT_EFFECT,
  ENTITLEMENT_SOURCE,
  ENTITLEMENT_STATUS,
  PLAN_VERSION_STATUS,
  PRICING_SOURCE,
  RECORD_STATUS,
  SUBSCRIPTION_ITEM_TYPE,
  SUBSCRIPTION_STATUS,
} from './enums.js';
import { tenants } from './tenancy.js';

/** Product capability catalog. Seeded from src/catalog/features.ts. */
export const features = mysqlTable(
  'features',
  {
    id: id(),
    code: varchar('code', { length: 64 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    description: varchar('description', { length: 500 }),
    parentCode: varchar('parent_code', { length: 64 }),
    /** Core features are always available to an accessible tenant. */
    isCore: boolean('is_core').notNull().default(false),
    sortOrder: int('sort_order').notNull().default(0),
    status: mysqlEnum('status', RECORD_STATUS).notNull().default('ACTIVE'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('features_code_uq').on(t.code)],
);

/** Data-driven dependencies: feature_id requires depends_on_feature_id. */
export const featureDependencies = mysqlTable(
  'feature_dependencies',
  {
    featureId: ref('feature_id')
      .notNull()
      .references(() => features.id),
    dependsOnFeatureId: ref('depends_on_feature_id')
      .notNull()
      .references(() => features.id),
  },
  (t) => [
    primaryKey({ name: 'feature_dependencies_pk', columns: [t.featureId, t.dependsOnFeatureId] }),
  ],
);

export const plans = mysqlTable(
  'plans',
  {
    id: id(),
    code: varchar('code', { length: 64 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    description: varchar('description', { length: 500 }),
    status: mysqlEnum('status', RECORD_STATUS).notNull().default('ACTIVE'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('plans_code_uq').on(t.code)],
);

/**
 * Commercial terms at a point in time. Subscriptions reference a version so
 * historical prices and feature sets never change underneath them.
 */
export const planVersions = mysqlTable(
  'plan_versions',
  {
    id: id(),
    planId: ref('plan_id')
      .notNull()
      .references(() => plans.id),
    version: int('version').notNull(),
    status: mysqlEnum('status', PLAN_VERSION_STATUS).notNull().default('ACTIVE'),
    currency: char('currency', { length: 3 }).notNull(),
    priceMonthlyMinor: bigint('price_monthly_minor', { mode: 'number' }).notNull(),
    priceAnnualMinor: bigint('price_annual_minor', { mode: 'number' }).notNull(),
    /** Plan limits; null = unlimited. Checked when staff are invited / students are admitted. */
    maxStaffUsers: int('max_staff_users'),
    maxStudents: int('max_students'),
    effectiveFrom: dt('effective_from').notNull(),
    effectiveTo: dt('effective_to'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('plan_versions_plan_version_uq').on(t.planId, t.version)],
);

export const planFeatures = mysqlTable(
  'plan_features',
  {
    planVersionId: ref('plan_version_id')
      .notNull()
      .references(() => planVersions.id),
    featureId: ref('feature_id')
      .notNull()
      .references(() => features.id),
  },
  (t) => [primaryKey({ name: 'plan_features_pk', columns: [t.planVersionId, t.featureId] })],
);

export const subscriptions = mysqlTable(
  'subscriptions',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    planVersionId: ref('plan_version_id')
      .notNull()
      .references(() => planVersions.id),
    status: mysqlEnum('status', SUBSCRIPTION_STATUS).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    billingInterval: mysqlEnum('billing_interval', BILLING_INTERVAL).notNull(),
    startsAt: dt('starts_at').notNull(),
    trialEndsAt: dt('trial_ends_at'),
    currentPeriodStart: dt('current_period_start').notNull(),
    currentPeriodEnd: dt('current_period_end').notNull(),
    cancelledAt: dt('cancelled_at'),
    endedAt: dt('ended_at'),
    autoRenew: boolean('auto_renew').notNull().default(true),
    version: version(),
    createdBy: ref('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('subscriptions_tenant_status_idx').on(t.tenantId, t.status)],
);

export const subscriptionItems = mysqlTable(
  'subscription_items',
  {
    id: id(),
    subscriptionId: ref('subscription_id')
      .notNull()
      .references(() => subscriptions.id),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    itemType: mysqlEnum('item_type', SUBSCRIPTION_ITEM_TYPE).notNull(),
    /** For ADD_ON items: the feature the add-on unlocks. */
    featureId: ref('feature_id').references(() => features.id),
    quantity: int('quantity').notNull().default(1),
    currency: char('currency', { length: 3 }).notNull(),
    standardPriceMinor: bigint('standard_price_minor', { mode: 'number' }).notNull(),
    customPriceMinor: bigint('custom_price_minor', { mode: 'number' }),
    discountMinor: bigint('discount_minor', { mode: 'number' }).notNull().default(0),
    finalPriceMinor: bigint('final_price_minor', { mode: 'number' }).notNull(),
    pricingSource: mysqlEnum('pricing_source', PRICING_SOURCE).notNull().default('CATALOG'),
    approvedBy: ref('approved_by'),
    reason: varchar('reason', { length: 500 }),
    startsAt: dt('starts_at').notNull(),
    endsAt: dt('ends_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('subscription_items_tenant_idx').on(t.tenantId),
    index('subscription_items_subscription_idx').on(t.subscriptionId),
  ],
);

/**
 * Why a tenant has (or is explicitly denied) a feature. The entitlement
 * resolver combines these rows with subscription state and dependencies.
 */
export const entitlements = mysqlTable(
  'entitlements',
  {
    id: id(),
    tenantId: ref('tenant_id')
      .notNull()
      .references(() => tenants.id),
    featureId: ref('feature_id')
      .notNull()
      .references(() => features.id),
    sourceType: mysqlEnum('source_type', ENTITLEMENT_SOURCE).notNull(),
    /** Subscription id for PLAN/ADD_ON; contract reference for CUSTOM_CONTRACT. */
    sourceReference: varchar('source_reference', { length: 64 }),
    effect: mysqlEnum('effect', ENTITLEMENT_EFFECT).notNull().default('GRANT'),
    status: mysqlEnum('status', ENTITLEMENT_STATUS).notNull().default('ACTIVE'),
    startsAt: dt('starts_at').notNull(),
    endsAt: dt('ends_at'),
    grantedBy: ref('granted_by'),
    reason: varchar('reason', { length: 500 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('entitlements_tenant_status_idx').on(t.tenantId, t.status),
    index('entitlements_source_ref_idx').on(t.sourceReference),
  ],
);
