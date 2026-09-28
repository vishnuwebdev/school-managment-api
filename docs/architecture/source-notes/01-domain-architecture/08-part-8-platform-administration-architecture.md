<!-- Source: Apple Notes, folder 'Notes' -->
# Part 8 — Platform Administration Architecture

The platform administration layer controls the SaaS itself, while School Administration controls an individual school.
The most important rule is:
Platform administrators manage the platform and authorized tenants; School administrators manage only their own tenant.

8.1 Platform vs School Administration
                         PLATFORM
                            │
              ┌─────────────┴─────────────┐
              │                           │
      Platform Administration       School Administration
              │                           │
       Multiple / all tenants          One tenant
              │                           │
      Platform configuration        School operations
Platform administrators may operate across schools, but only according to their permissions and assigned scope.

8.2 Platform Roles
The initial role catalog can contain:
Super Admin
Platform Admin
Billing Admin
Support Admin
Sales Admin
Operations Admin
These are initial role definitions, not permanent architectural assumptions.
Because the RBAC system is configurable, additional roles can later be introduced without changing the authorization architecture.

8.3 Super Admin
Super Admin is the highest platform-level administrative role.
Typical capabilities may include:
Platform configuration
School creation
School approval
School suspension
School restoration
Plan management
Feature management
Pricing overrides
Entitlement overrides
Platform role management
Permission management
Subscription intervention
Audit access
But even Super Admin actions should ultimately be represented as permissions.
Avoid special code such as:
if role == SUPER_ADMIN
throughout the application.
Instead:
authorization.hasPermission(...)

8.4 Platform Admin
Platform Admin handles general platform operations.
Possible permissions:
school.view
school.create
school.approve
school.update
school.suspend
school.restore

user.view
user.manage

feature.view
entitlement.view

subscription.view
Some particularly sensitive operations may remain restricted to Super Admin.
For example:
pricing.override
permission.catalog.update
platform_role.manage
The exact split is configurable.

8.5 Billing Admin
Billing Admin should primarily work with commercial data.
Typical permissions:
subscription.view
subscription.create
subscription.update

invoice.view
invoice.create
invoice.update

payment.view
payment.record
payment.verify
payment.refund

pricing.view
discount.manage
Depending on policy, Billing Admin might not be allowed to:
school.suspend
feature.catalog.update
role.permission.update
This gives proper separation of responsibilities.

8.6 Support Admin
Support personnel may need to investigate a school without receiving broad administrative authority.
For example:
school.view
user.view
subscription.view
entitlement.view
audit.view
support.manage
But they might not have:
payment.refund
pricing.override
school.archive
permission.catalog.update
This is a good example of why granular permissions are valuable.

8.7 Sales Admin
Sales users may need access to:
school.view
school.create
feature.view
plan.view
pricing.view
custom_pricing.request
feature_request.view
They generally should not be able to:
payment.refund
school.suspend
role.permission.update
audit.delete
Again, this is role configuration rather than application logic.

8.8 Operations Admin
Operations can handle tenant lifecycle and operational configuration.
Potential permissions:
school.view
school.approve
school.provision
school.suspend
school.restore
school.archive

user.view
user.manage

entitlement.view
Sensitive commercial overrides can remain outside this role.

8.9 Platform Roles Should Be Composable
A person may need multiple platform responsibilities.
For example:
User A
 ├── Platform Admin
 └── Billing Admin
The effective permissions are derived from both roles.
This is preferable to creating roles like:
PlatformBillingOperationsAdmin
for every combination.

8.10 Platform User Membership
The same user/membership concept should work here.
Conceptually:
User
 ├── Platform Membership
 │      └── Platform Roles
 │
 ├── School Membership
 │      └── School Roles
 │
 └── Another School Membership
        └── School Roles
This preserves the earlier requirement that internal users can belong to multiple schools.

8.11 Example: Platform Employee
Suppose:
User: Rahul
has:
Platform Membership
 ├── Platform Admin
 └── Billing Admin
and additionally:
School Membership
 └── School A
      └── Support role
The same identity can therefore operate in different contexts.
The active context must always be explicit.

8.12 Platform Context vs Tenant Context
We should model two primary contexts:
PLATFORM
TENANT
Example:
Platform Admin
 ↓
PLATFORM CONTEXT
 ↓
View School A
 ↓
TENANT CONTEXT = School A
When the operation is complete, the system should not accidentally retain School A as an implicit context for unrelated platform operations.

8.13 Tenant Scope
A platform role does not necessarily mean access to every school.
We should support a scope concept.
For example:
Operations Admin
 ├── Region: North
 └── Schools: A, B, C
or simply:
Support Admin
 └── Schools: A, B
The exact scope system can start simple.
Possible scope types:
ALL_TENANTS
SELECTED_TENANTS
NO_TENANT
Future:
REGION
ORGANIZATION
PARTNER
CAMPUS
if the business eventually needs them.

8.14 Authorization Example
A Billing Admin attempts:
Refund payment for School A
The platform checks:
Authenticated?
       ↓
Platform membership?
       ↓
Has payment.refund?
       ↓
Has access to School A?
       ↓
Payment belongs to School A?
       ↓
ALLOW
Every layer matters.

8.15 Platform Admin Cannot Bypass Tenant Isolation
Even privileged users should not have an invisible "everything" path that bypasses all normal safeguards.
Instead:
Platform permission
+
Explicit tenant scope
+
Audit
should govern cross-tenant operations.
For exceptional system-level operations, the permission itself can explicitly represent the capability.

8.16 Sensitive Operations
Certain operations should receive additional protection.
Examples:
school.suspend
school.archive
pricing.override
payment.refund
entitlement.override
permission.update
platform_role.update
subscription.cancel
The architecture should allow policies such as:
Permission
    +
Reason required
    +
Audit required
Later, some operations could require:
Two-person approval
without redesigning RBAC.

8.17 Approval Workflows
Some platform operations are naturally approval-based.
Example:
Feature Request
      ↓
Sales Review
      ↓
Commercial Approval
      ↓
Billing
      ↓
Entitlement
Another:
School Request
      ↓
Operations Review
      ↓
Approval
      ↓
Provisioning
Another:
Custom Price
      ↓
Sales proposes
      ↓
Authorized Admin approves
      ↓
Subscription
Approval should be represented as an explicit business object/state where appropriate rather than merely an audit entry.

8.18 Approval vs Permission
A permission answers:
Can this person perform this type of action?
An approval answers:
Has this specific business operation been approved?
For example:
Sales Admin
 └── has custom_pricing.request
does not mean:
Custom price automatically approved
Instead:
Request
 ↓
Approval
 ↓
Commercial action
This distinction becomes important as the platform grows.

8.19 Platform Dashboard
The platform dashboard should aggregate platform-level information.
Potential areas:
Schools
Subscriptions
Revenue
Payments
Feature Usage
Feature Requests
Pending Approvals
System Health
Audit Activity
But dashboard visibility itself should be permission-controlled.
For example:
Billing Admin
→ billing metrics

Support Admin
→ support / school status

Sales Admin
→ pipeline / prospects

Operations Admin
→ provisioning / school lifecycle
No role should automatically see every sensitive dashboard.

8.20 School Directory
Platform users with appropriate permission can see:
Schools
 ├── Status
 ├── Subscription
 ├── Entitlement summary
 ├── Primary admin
 └── Operational information
Selecting a school establishes:
TenantContext = selected school
All subsequent tenant operations are authorized against that context.

8.21 "Act as School Admin" Should Be Avoided Initially
A tempting support feature is:
Login as this school's administrator.
I recommend not making this a basic impersonation mechanism.
It creates significant security and audit complexity.
If support eventually needs this capability, design it explicitly as:
Privileged Support Session
with:
Actor = Support Admin
Acting Tenant = School A
Reason = ...
Started At
Ended At
Every action remains attributed to the real platform employee.
Never make audit logs appear as though the school admin actually performed the action.

8.22 Audit Attribution
For platform operations:
Actor:
Platform User A

Context:
School A

Action:
FEATURE_DISABLED
For school operations:
Actor:
School Admin A

Context:
School A

Action:
USER_CREATED
For system automation:
Actor:
SYSTEM

Context:
School A

Action:
SUBSCRIPTION_EXPIRED
This gives us three useful actor categories:
HUMAN_PLATFORM
HUMAN_TENANT
SYSTEM

8.23 Platform Configuration
Platform configuration should be separated from tenant configuration.
Platform-level examples:
Default trial duration
Default notification rules
Global billing settings
Supported currencies
Feature catalog configuration
Platform security policies
School-level:
School timezone
School notification preferences
Academic settings
School-specific numbering
Avoid putting everything into one generic:
settings
table/object with no ownership model.

8.24 Platform Permission Catalog
Permissions themselves should be platform-managed.
Conceptually:
Permission
 ├── key
 ├── name
 ├── description
 ├── category
 ├── scope_type
 ├── status
 └── metadata
Examples:
school.create
school.approve
school.suspend

subscription.view
subscription.update

payment.record
payment.refund

feature.enable
feature.disable

role.create
role.update
role.delete
The permission catalog becomes a stable contract for the application.

8.25 Permission Lifecycle
Permissions themselves may need lifecycle handling.
For example:
ACTIVE
DEPRECATED
Suppose:
student.import
is replaced later by:
student.data.import
We shouldn't immediately delete the old permission if existing roles reference it.
Instead:
student.import
    ↓
DEPRECATED
Then migrate affected roles before eventually retiring it.
This is another reason configuration versioning matters.

8.26 Role Lifecycle
Roles can similarly have:
ACTIVE
DISABLED
ARCHIVED
A disabled role should not be assignable to new users.
Existing assignments should be handled through a controlled migration process.

8.27 Platform Role Management
Who can modify platform roles?
We should not assume every Super Admin can arbitrarily change every permission without audit.
A sensible foundation is:
role.view
role.create
role.update
role.archive

role.permission.assign
role.permission.remove
with sensitive role-management actions requiring explicit authorization.
This keeps the model configurable.

8.28 Platform Administration Architecture
Putting everything together:
                     PLATFORM USER
                           │
                     PLATFORM MEMBERSHIP
                           │
                       PLATFORM ROLE
                           │
                       PERMISSIONS
                           │
                ┌──────────┴──────────┐
                ↓                     ↓
        PLATFORM OPERATIONS      TENANT ACCESS
                │                     │
                ↓                     ↓
      Plans / Features / Billing   School A
      Roles / Permissions          School B
      Configuration                School C

8.29 Responsibility Matrix
A starting point:
￼
This is not a hardcoded role matrix.
It is the initial business configuration that will ultimately be represented through permissions and scopes.

8.30 The Most Important Architectural Rule
Do not build:
SuperAdminService
PlatformAdminService
BillingAdminService
SupportAdminService
with completely separate authorization logic.
Instead, build common platform capabilities:
School Management
Subscription Management
Billing
Feature Management
Entitlement Management
Role Management
Audit
and control access through:
Roles
+
Permissions
+
Scope
This is considerably more extensible.

8.31 Complete Platform Administration Model
We now have:
                     PLATFORM
                        │
               Identity & RBAC
                        │
              ┌─────────┴─────────┐
              ↓                   ↓
       Platform Context       Tenant Context
              │                   │
     Platform Operations      School Operations
              │                   │
      ┌───────┼───────┐           │
      ↓       ↓       ↓           ↓
    Plans   Billing Features   Domain Modules
      │       │       │           │
      └───────┴───────┘           │
              │                   │
         Entitlements ────────────┘
At this point, the platform control plane is largely defined.

Foundation Before Phase 2
We have now designed:
Multi-tenancy & data isolation
RBAC & permissions
Feature catalog & dependencies
Entitlement engine
School lifecycle
Subscription & billing
Platform administration
The next step should be Part 9 — Core Platform Data Model & Domain Boundaries.
That will turn these concepts into a coherent entity/relationship model—without yet designing Students, Teachers, Fees, Exams, Transportation, or other Phase 2 domain databases. It will also identify which entities are platform-global, tenant-scoped, commercial, or identity/access so the eventual database architecture doesn't become tangled.
