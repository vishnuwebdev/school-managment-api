/**
 * Enum value lists shared by the database schema, validation and OpenAPI.
 * Changing a list requires a migration.
 */
export const TENANT_STATUS = [
  'REQUESTED',
  'UNDER_REVIEW',
  'APPROVED',
  'PROVISIONING',
  'ACTIVE',
  'SUSPENDED',
  'ARCHIVED',
] as const;
export type TenantStatus = (typeof TENANT_STATUS)[number];

export const SCHOOL_REQUEST_STATUS = ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'] as const;
export type SchoolRequestStatus = (typeof SCHOOL_REQUEST_STATUS)[number];

export const USER_STATUS = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type UserStatus = (typeof USER_STATUS)[number];

export const ONE_TIME_TOKEN_STATUS = ['PENDING', 'SENT', 'USED', 'EXPIRED', 'REVOKED'] as const;
export type OneTimeTokenStatus = (typeof ONE_TIME_TOKEN_STATUS)[number];

export const MEMBERSHIP_KIND = ['PLATFORM', 'TENANT'] as const;
export type MembershipKind = (typeof MEMBERSHIP_KIND)[number];

export const MEMBERSHIP_STATUS = ['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUS)[number];

export const PERMISSION_SCOPE = ['PLATFORM', 'TENANT'] as const;
export type PermissionScope = (typeof PERMISSION_SCOPE)[number];

export const RECORD_STATUS = ['ACTIVE', 'ARCHIVED'] as const;
export type RecordStatus = (typeof RECORD_STATUS)[number];

export const ROLE_TYPE = ['SYSTEM', 'CUSTOM'] as const;
export type RoleType = (typeof ROLE_TYPE)[number];

export const SCOPE_TYPE = [
  'ALL_TENANTS', // platform: every school
  'SELECTED_TENANTS', // platform: scope_ref.tenant_ids
  'ALL_TENANT',
  'ASSIGNED_CLASS',
  'ASSIGNED_SECTION',
  'ASSIGNED_SUBJECT',
  'OWN_RECORD',
  'SELECTED_RESOURCE',
] as const;
export type ScopeType = (typeof SCOPE_TYPE)[number];

export const ASSIGNMENT_STATUS = ['ACTIVE', 'REVOKED'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUS)[number];

export const PLAN_VERSION_STATUS = ['DRAFT', 'ACTIVE', 'RETIRED'] as const;

export const SUBSCRIPTION_STATUS = [
  'PENDING',
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'EXPIRED',
  'CANCELLED',
  /** Replaced by a newer subscription (upgrade, downgrade, renewal). Not a cancellation. */
  'SUPERSEDED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[number];

export const BILLING_INTERVAL = ['MONTHLY', 'ANNUAL', 'CUSTOM'] as const;
export type BillingInterval = (typeof BILLING_INTERVAL)[number];

export const SUBSCRIPTION_ITEM_TYPE = ['PLAN', 'ADD_ON'] as const;
export const PRICING_SOURCE = ['CATALOG', 'CUSTOM_CONTRACT'] as const;

export const ENTITLEMENT_SOURCE = ['PLAN', 'ADD_ON', 'CUSTOM_CONTRACT', 'ADMIN_OVERRIDE'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCE)[number];

export const ENTITLEMENT_EFFECT = ['GRANT', 'DENY'] as const;
export type EntitlementEffect = (typeof ENTITLEMENT_EFFECT)[number];

export const ENTITLEMENT_STATUS = ['ACTIVE', 'REVOKED'] as const;

export const ACTOR_TYPE = ['USER', 'PLATFORM_USER', 'SYSTEM', 'ANONYMOUS'] as const;
export type ActorType = (typeof ACTOR_TYPE)[number];

export const OUTBOX_STATUS = ['PENDING', 'PUBLISHED', 'FAILED'] as const;
