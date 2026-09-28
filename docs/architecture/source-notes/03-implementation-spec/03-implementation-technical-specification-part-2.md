<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 2

Tenant Management, School Lifecycle, Feature Catalog & Entitlements

42. Tenant Management Module
The Tenant module owns the school as a platform tenant.
It owns:
school identity
school lifecycle
school profile
school configuration
tenant timezone/locale
provisioning state
tenant-level operational metadata
It does not own:
users
memberships
subscriptions
feature definitions
domain data

43. tenants
tenants
-------
id
tenant_code
name
legal_name
status
timezone
locale
currency
created_at
updated_at
activated_at
suspended_at
archived_at
Tenant status
REQUESTED
UNDER_REVIEW
APPROVED
PROVISIONING
ACTIVE
SUSPENDED
ARCHIVED
tenant_code should be unique platform-wide.
It is a business identifier, not a security boundary.

44. Tenant Profile
Keep profile information separate from the tenant lifecycle record.
tenant_profiles
--------------
tenant_id
display_name
legal_name
logo_file_id
address
city
state
country
postal_code
primary_email
primary_phone
website
updated_at
This prevents the core tenant table from becoming a large collection of school-specific profile attributes.

45. Tenant Settings
tenant_settings
---------------
tenant_id
timezone
locale
date_format
time_format
currency
academic_configuration
notification_configuration
updated_at
Only configuration belongs here.
Commercial entitlement does not.

46. School Request
School onboarding is separate from an existing tenant.
school_requests
--------------
id
requested_name
requested_by_user_id
contact_name
contact_email
contact_phone
status
reviewed_by
reviewed_at
review_reason
approved_at
created_at
updated_at
Status:
REQUESTED
UNDER_REVIEW
APPROVED
REJECTED
CANCELLED
Approval does not automatically mean the school is active.

47. School Creation Workflow
School Request
      ↓
Review
      ↓
Approved
      ↓
Create Tenant
      ↓
Provisioning
      ↓
Initialize Platform Records
      ↓
Invite School Admin
      ↓
Subscription / Entitlement
      ↓
ACTIVE
Provisioning should be retryable.

48. Provisioning
A provisioning workflow creates:
tenant
default tenant configuration
system tenant roles/role assignments as applicable
initial school administrator membership
subscription/entitlement state
storage namespace
required platform configuration
initial audit records
Provisioning failures must not result in a partially active tenant.
Tenant remains:
PROVISIONING
until all mandatory initialization succeeds.

49. Tenant Activation
Activation requires:
Provisioning complete
+
Tenant approved
+
Required commercial/access state valid
Then:
PROVISIONING → ACTIVE
Activation is audited.

50. Suspension
Suspension is a tenant operational state, separate from subscription expiry.
Example reasons:
administrative suspension
compliance issue
operational intervention
security incident
Suspension blocks normal school operations.
Recovery is explicit:
SUSPENDED → ACTIVE

51. Archive
Archive is a lifecycle transition:
ACTIVE/SUSPENDED → ARCHIVED
Archived tenants:
retain data
cannot perform normal school operations
are read-only by default for authorized platform users
cannot be reactivated by normal tenant users
Restore is a privileged platform operation.

52. Tenant Lifecycle Authorization
Tenant status must be evaluated before ordinary domain authorization.
Conceptually:
Tenant ACTIVE
   ↓
Normal tenant operations possible

Tenant SUSPENDED
   ↓
Only explicitly permitted recovery/support operations

Tenant ARCHIVED
   ↓
Read-only platform access by default
Tenant Admin permissions cannot override tenant lifecycle restrictions.

53. Tenant APIs
Initial API structure:
/api/v1/tenants
/api/v1/tenants/:tenantId
/api/v1/tenants/:tenantId/profile
/api/v1/tenants/:tenantId/settings
/api/v1/tenant-requests
Administrative lifecycle actions:
POST   /tenant-requests
POST   /tenant-requests/:id/approve
POST   /tenants/:id/provision
POST   /tenants/:id/suspend
POST   /tenants/:id/restore
POST   /tenants/:id/archive
POST   /tenants/:id/unarchive
Exact route exposure depends on platform permissions.

54. Feature Catalog
The Feature Catalog is platform-owned.
A feature is a capability that can be commercially or operationally enabled.
Example:
Student Management
 ├── Student Profiles
 ├── Admissions
 ├── Enrollment
 ├── Guardians
 └── Documents
Features are not permissions.

55. features
features
--------
id
code
name
description
parent_feature_id
feature_type
status
sort_order
created_at
updated_at
Feature types:
ROOT
FEATURE
SUB_FEATURE
Keep hierarchy shallow.
Recommended maximum:

Avoid arbitrary recursive feature trees.

56. Feature Codes
Feature codes are stable contracts.
Examples:
student
student.profiles
student.admissions
student.enrollment

attendance
attendance.daily
attendance.subject

examination
examination.assessments
examination.results
The code should not be casually renamed after production usage.

57. Feature Status
ACTIVE
DEPRECATED
DISABLED
Do not physically delete a feature once referenced by commercial or entitlement history.

58. Feature Dependencies
Separate table:
feature_dependencies
--------------------
id
feature_id
depends_on_feature_id
dependency_type
created_at
Initial dependency type:
REQUIRED
Example:
Admissions
    ↓ requires
Student Profiles
Dependency resolution belongs to the entitlement/configuration layer, not RBAC.

59. Dependency Rule
When enabling:
Feature A
 ↓
requires Feature B
the system must verify B is available.
If B is unavailable:
explain dependency
identify affected feature
require explicit confirmation if activation changes multiple entitlements
never silently activate unrelated commercial capabilities
When disabling B:
Feature B
 ↓
impacts A
the platform must show the impact.
Disabling B never deletes A's data.

60. Feature Permissions
Permissions reference feature applicability.
Conceptually:
Feature
  ↓
Applicable Permissions
A permission cannot be assigned to a tenant if its required feature/sub-feature is unavailable.
However, existing assignments remain stored.
This enables:
Feature disabled
      ↓
Permission assignment retained
      ↓
Permission ineffective
      ↓
Feature re-enabled
      ↓
Permission potentially effective again

61. Entitlement Model
Entitlement answers:
Is this tenant currently entitled to use this capability?
Sources:
PLAN
ADD_ON
CUSTOM_CONTRACT
ADMIN_OVERRIDE
The entitlement engine combines them.

62. Commercial Product Catalog
Separate commercial products from feature definitions.
commercial_products
-------------------
id
code
name
product_type
status
description
created_at
updated_at
Product types:
PLAN
ADD_ON
SERVICE
A product can grant one or more features.

63. Product → Feature Mapping
product_features
----------------
id
product_id
feature_id
access_mode
created_at
This means a plan can contain:
Basic Plan
 ├── Student Profiles
 ├── Admissions
 └── Attendance
without embedding feature lists inside application code.

64. Plan Versions
Plans should be versioned.
plan_versions
------------
id
product_id
version_number
status
effective_from
effective_until
created_at
Possible status:
DRAFT
ACTIVE
RETIRED
A purchased subscription references the applicable plan/version.
This preserves historical commercial terms.

65. Add-ons
Add-ons use the same product catalog model.
Example:
Base Plan
   +
Transport Add-on
   +
Advanced Examination Add-on
Add-ons can grant additional features without modifying the base plan.

66. Subscription Structure
The relationship becomes:
Tenant
 ↓
Subscription
 ↓
Subscription Items
 ↓
Plan / Add-on / Custom Product
 ↓
Features
 ↓
Entitlements
Core tables:
subscriptions
subscription_items

67. subscriptions
subscriptions
-------------
id
tenant_id
status
billing_cycle
starts_at
trial_ends_at
current_period_start
current_period_end
auto_renew
cancelled_at
cancel_reason
expired_at
created_at
updated_at
Statuses:
PENDING
TRIAL
ACTIVE
PAST_DUE
EXPIRED
CANCELLED

68. subscription_items
subscription_items
------------------
id
subscription_id
product_id
plan_version_id
quantity
standard_price
discount_amount
custom_price
final_price
price_source
effective_from
effective_until
status
created_at
updated_at
Historical commercial values are retained.
The catalog price can change later without changing the historical subscription item.

69. Pricing
Never overwrite standard pricing to represent a negotiated deal.
Store:
standard_price
custom_price
discount_amount
final_price
price_source
Example:
Standard: 100,000
Custom:    80,000
Discount:  20,000
Final:     80,000
Approval metadata belongs to the commercial workflow.

70. Effective Entitlement Calculation
The entitlement engine conceptually calculates:
Plan
+
Add-ons
+
Custom Contract
+
Admin Overrides
+
Subscription State
+
Validity Dates
+
Feature Dependencies
+
Tenant Lifecycle
        ↓
Effective Entitlements
The result is capability-based, not plan-name-based.

71. Entitlement Resolver API
Domains should ask:
entitlementService.isEnabled({
  tenantId,
  featureCode
})
or:
entitlementService.require({
  tenantId,
  featureCode
})
They should not ask:
if (plan === 'PREMIUM')
Plan names must never become business authorization logic.

72. Effective Entitlement Record
A materialized/read-optimized representation can be maintained:
effective_entitlements
----------------------
id
tenant_id
feature_id
source_type
source_id
status
effective_from
effective_until
calculated_at
This is a derived authorization/commercial representation.
The underlying subscription/product records remain authoritative.

73. Entitlement Sources
Multiple sources may contribute:
PLAN
ADD_ON
CUSTOM_CONTRACT
ADMIN_OVERRIDE
The resolver should retain the reason/source for why a capability is enabled.
This is important for support, billing and audit.

74. Admin Override
Override:
entitlement_overrides
---------------------
id
tenant_id
feature_id
status
effective_from
effective_until
granted_by
reason
created_at
updated_at
Status:
ACTIVE
REVOKED
EXPIRED
Overrides do not modify the plan.

75. Override Precedence
Recommended precedence:
Commercial Entitlement
        ↓
Custom Contract
        ↓
Admin Override
        ↓
Effective Entitlement
An override is explicit and auditable.
It should not silently rewrite subscription history.

76. Feature Disablement
Disabling a feature changes capability availability:
Feature Disabled
      ↓
Entitlement ineffective
      ↓
Existing permissions retained
      ↓
Existing data retained
No business data is deleted.

77. Entitlement + Authorization
Final authorization:
Authenticated
   ↓
Tenant Access
   ↓
Tenant Lifecycle
   ↓
Entitlement
   ↓
Permission
   ↓
Scope
   ↓
Domain Rule
   ↓
ALLOW
A valid permission alone is insufficient.
A valid entitlement alone is also insufficient.
Both are required.

78. Feature Request
Feature requests are separate from entitlement.
feature_requests
----------------
id
tenant_id
feature_id
requested_by
status
requested_at
reviewed_by
reviewed_at
decision_reason
created_at
updated_at
Status:
REQUESTED
UNDER_REVIEW
APPROVED
REJECTED
AWAITING_PAYMENT
PROVISIONED
CANCELLED

79. Feature Request Workflow
REQUESTED
   ↓
UNDER_REVIEW
   ↓
APPROVED
   ↓
AWAITING_PAYMENT
   ↓
Commercial Subscription Item
   ↓
Payment / Activation
   ↓
ENTITLEMENT
   ↓
PROVISIONED
For free/admin-approved features:
APPROVED
 ↓
Entitlement
 ↓
PROVISIONED
No automatic entitlement is created merely because a request is approved.

80. Entitlement Cache
Use the previously established local-cache architecture.
Cache key conceptually:
tenant:{tenantId}:entitlement:{featureCode}
But:
cache is not authoritative
commercial changes invalidate affected entries where possible
TTL provides eventual refresh
sensitive access can resolve authoritative state
unavailable authoritative state fails closed

81. Entitlement Events
Important internal events:
SubscriptionCreated
SubscriptionActivated
SubscriptionPastDue
SubscriptionExpired
SubscriptionCancelled

SubscriptionItemAdded
SubscriptionItemRemoved

EntitlementGranted
EntitlementRevoked
EntitlementExpired

FeatureEnabled
FeatureDisabled

FeatureRequestCreated
FeatureRequestApproved
FeatureRequestRejected
FeatureRequestProvisioned
These drive downstream behavior such as:
cache invalidation
notifications
reporting
provisioning
audit
integrations

82. Tenant Lifecycle + Subscription Interaction
These are intentionally separate.
Example:
Tenant ACTIVE
+
Subscription EXPIRED
=
Tenant operationally restricted
This does not change the tenant itself to SUSPENDED.
Likewise:
Tenant SUSPENDED
+
Subscription ACTIVE
=
Still operationally blocked
Both dimensions must pass.

83. Expired Subscription Recovery
After subscription expiry:
ACTIVE
 ↓
EXPIRED
 ↓
30-day Recovery
 ↓
Access Locked
During recovery:
School Admin can authenticate.
Operational school features are restricted.
Renewal/payment/support actions remain available.
Data remains intact.
After the recovery window:
normal school login is locked
data remains retained
authorized platform staff can still perform recovery operations.

84. Subscription Authorization Helper
Application services should be able to express:
subscriptionAccess.requireOperationalAccess({
  tenantId
})
This resolves:
tenant lifecycle
subscription state
recovery state
relevant entitlement
without embedding commercial logic inside every domain.

85. Important Boundary
Do not create a single giant:
AccessService
that owns every rule.
Keep:
Tenant Management
Authentication
Membership
Authorization
Feature Management
Entitlement
Subscription
Billing
as separate modules.
Authorization coordinates the final decision but does not own the underlying commercial or tenant data.

86. Platform Core Result
At this point the core access model is:
USER
 ↓
AUTH SESSION
 ↓
CONTEXT
 ↓
MEMBERSHIP / PLATFORM SCOPE
 ↓
TENANT LIFECYCLE
 ↓
SUBSCRIPTION
 ↓
ENTITLEMENT
 ↓
FEATURE / SUB-FEATURE
 ↓
PERMISSION
 ↓
ROLE / DIRECT GRANT
 ↓
SCOPE
 ↓
DOMAIN RULE
 ↓
ALLOW / DENY
This is now the implementation contract that the business domains will consume.
Next
The next technical specification will cover Subscription + Billing + Invoicing + Payments + Renewal/Expiry, followed by the first major business domain: Student Management.
