<!-- Source: Apple Notes, folder 'Notes' -->
# Part 6 — School / Tenant Management

This module owns the lifecycle of a school as a tenant. It should be independent from the domain modules such as Students, Fees, or Exams.
The core principle is:
A school must exist and have an appropriate lifecycle state before its users and business modules can operate.

6.1 School Lifecycle
I recommend this lifecycle:
REQUESTED
    ↓
UNDER_REVIEW
    ↓
APPROVED
    ↓
PROVISIONING
    ↓
ACTIVE
    ↓
SUSPENDED
    ↓
ACTIVE
    ↓
ARCHIVED
There is also a separate commercial lifecycle:
SUBSCRIPTION
    ↓
TRIAL / ACTIVE
    ↓
PAST_DUE
    ↓
EXPIRED
    ↓
30-DAY RECOVERY
    ↓
ACCESS_LOCKED
These two lifecycles should not be merged.
A school can be:
School = ACTIVE
Subscription = EXPIRED
That is very different from:
School = SUSPENDED
Subscription = ACTIVE

6.2 School Request
A school can submit a request to join the platform.
Conceptually:
SchoolRequest
 ├── id
 ├── requested_name
 ├── contact_information
 ├── requested_features
 ├── requested_plan
 ├── submitted_by
 ├── status
 ├── reviewed_by
 ├── reviewed_at
 ├── rejection_reason
 └── timestamps
Important:
SchoolRequest is not yet a tenant.
It is an application/request to create one.

6.3 School Creation Sources
There are three supported paths.
Path A — School-requested
School
 ↓
Submit Request
 ↓
Platform Review
 ↓
Approve
 ↓
Create School
Path B — Super Admin created
Super Admin
 ↓
Create School
 ↓
Provision
Path C — Platform Admin created
Provided that the Platform Admin has:
school.create
permission.
This should be authorization-driven rather than based on hardcoded role names.

6.4 Approval Should Not Automatically Mean Active
I recommend:
APPROVED
   ↓
PROVISIONING
   ↓
ACTIVE
rather than:
APPROVED
   ↓
ACTIVE
Why?
Because provisioning may eventually include:
Tenant creation
Default settings
Initial roles
Initial administrator
Subscription setup
Entitlement calculation
Storage namespace
Notification setup
Separating these states gives us room for failures and retries.

6.5 Provisioning
When a school is approved:
School
 ↓
Provisioning
The platform creates the foundational tenant configuration.
Conceptually:
Create School
     ↓
Create Tenant
     ↓
Create Default Roles
     ↓
Create School Admin Membership
     ↓
Initialize Settings
     ↓
Initialize Subscription/Entitlement
     ↓
Initialize Storage Namespace
     ↓
Initialize Audit Context
     ↓
ACTIVE
The exact implementation can later be synchronous or event-driven.

6.6 School Admin Creation
Every active school needs an initial administrative user.
Conceptually:
School
   ↓
Initial Membership
   ↓
School Admin Role
   ↓
Invitation / Account Setup
The platform should avoid creating a generic shared account such as:
admin@school
with multiple people using the same credentials.
Each human should have an individual user identity.

6.7 School Profile vs School Settings
Keep these separate.
School Profile
Business/identity information:
School name
Address
Contact information
Registration information
Logo
Timezone
Locale
School Settings
Operational configuration:
Academic configuration
Notification preferences
Numbering formats
Default preferences
Module-specific settings
Future domain modules can add their own settings without making the core School entity enormous.

6.8 School Status
The School entity should have an explicit lifecycle state.
For example:
REQUESTED
UNDER_REVIEW
APPROVED
PROVISIONING
ACTIVE
SUSPENDED
ARCHIVED
Don't rely on:
is_active = true/false
because that cannot properly represent the lifecycle.

6.9 Suspension
Suspension is a platform administrative action.
Possible reasons:
Policy issue
Administrative action
Fraud investigation
Technical issue
Manual platform intervention
When suspended:
School
 ↓
SUSPENDED
Normal users should lose operational access.
Whether School Admin can still access a restricted support/billing area should be explicitly controlled by the suspension reason/policy.
The action must be audited:
school.suspend
with:
actor
tenant
reason
timestamp
previous_state
new_state

6.10 Subscription Expiry Is Not School Suspension
This distinction is especially important.
Subscription expiry
School = ACTIVE
Subscription = EXPIRED
Result:
Operational features = locked
Renewal = available
Data = retained
Administrative suspension
School = SUSPENDED
Subscription = ACTIVE/whatever
Result:
Normal access = locked
Reason = platform action
These should never be represented by the same flag.

6.11 30-Day Recovery Period
We already established:
Subscription Expired
       ↓
30-day recovery period
During this period:
School Admin
 ├── Can authenticate
 ├── Can view subscription
 ├── Can renew
 ├── Can make payment
 └── Can contact/support renewal
But:
Students = locked
Teachers = locked
Fees = locked
Exams = locked
Other operational modules = locked
The data remains intact.
After 30 days:
ACCESS_LOCKED
School Admin cannot log in through the normal school application.
The tenant itself is not deleted.

6.12 Why We Should Not Archive Automatically After 30 Days
Expiration and archival are different concepts.
Expired
≠
Archived
A school may return months later.
Therefore:
Subscription expired
     ↓
Access locked
     ↓
Data retained
The platform can later provide a separate archival policy.

6.13 School Archive
Archiving should be an explicit lifecycle action.
ACTIVE
   ↓
ARCHIVED
Archived schools should generally be:
Non-operational
Non-loginable
Data retained
Historically reportable
Recoverable according to platform policy
Physical deletion should not be the normal workflow.

6.14 School Deletion
For this platform:
Do not expose normal hard-delete functionality for schools.
Instead:
Archive
This protects:
Audit history
Billing history
Payment history
Historical records
Compliance information
Support history
If legal/data-retention requirements later require actual deletion, that should be a separate controlled process.

6.15 School Admin Responsibilities
School Admin operates within their tenant.
Typical responsibilities:
Manage school profile
Manage school settings
Manage users
Manage sub-admins
Assign roles
Manage permitted modules
Request additional features
View subscription
Renew subscription
Manage school-level configuration
But all of these remain subject to:
Platform entitlement
+
School Admin permissions

6.16 Sub Admin Management
School Admin can:
Create user
Invite user
Assign role
Change role
Disable user
Remove membership
For example:
School Admin
    ↓
Create User
    ↓
Assign Finance Admin
    ↓
Finance Admin permissions
The School Admin should not be able to grant permissions that the platform does not allow the school to use.
For example, if Transportation isn't entitled:
School Admin
    ↓
Create Transport Admin
could potentially create the role itself, but:
transport.route.create
would not result in usable access because the school lacks the entitlement.
Even better, the role-management UI should hide or disable unavailable permissions.

6.17 School Admin Cannot Grant Platform Permissions
A school administrator should not be able to assign:
school.suspend
school.archive
plan.update
pricing.override
feature.catalog.update
subscription.admin.override
unless those are explicitly tenant-level permissions intended for them.
Platform permissions and tenant permissions should be separated conceptually.

6.18 School Onboarding Example
A realistic flow:
School submits request
        ↓
UNDER_REVIEW
        ↓
Platform Admin reviews
        ↓
APPROVED
        ↓
Plan / pricing selected
        ↓
Subscription created
        ↓
Provisioning
        ↓
School Admin invited
        ↓
Entitlements resolved
        ↓
ACTIVE
The first login can then take the School Admin into:
School Setup
rather than immediately exposing every future domain module.

6.19 School Setup
Before domain modules are used, the school may need foundational information:
School profile
Academic year
Basic settings
Contact details
Timezone
Notification preferences
The exact setup checklist can later be made configurable.
We should avoid hardcoding a giant onboarding wizard into the School entity.

6.20 School Lifecycle + Commercial Lifecycle
The relationship should look like this:
                 SCHOOL
                   │
             Lifecycle State
                   │
          ┌────────┴────────┐
          ↓                 ↓
       ACTIVE            SUSPENDED
          │
          ↓
    SUBSCRIPTION
          │
    ┌─────┴──────┐
    ↓            ↓
  ACTIVE       EXPIRED
                  │
                  ↓
            30-Day Recovery
                  │
                  ↓
             ACCESS LOCKED
This separation will prevent a lot of future conditional logic from becoming tangled.

6.21 School Access Matrix
A conceptual matrix:
￼
The exact "restricted" capabilities for suspension can be refined later.

6.22 Important Entity Relationships
The tenant-management area now looks like:
SchoolRequest
      │
      │ approved
      ↓
    School
      │
      ├── SchoolProfile
      ├── SchoolSettings
      ├── Memberships
      │
      ├── Subscriptions
      ├── Entitlements
      ├── FeatureRequests
      │
      └── Domain Modules
The important boundary is:
School
   │
   └── owns tenant data
while:
Plan
Feature
Permission
Pricing Catalog
remain platform-level entities.

6.23 Events
The school lifecycle should expose domain events.
Examples:
SchoolRequested
SchoolApproved
SchoolProvisioningStarted
SchoolProvisioned
SchoolActivated
SchoolSuspended
SchoolRestored
SchoolArchived
SchoolAdminInvited
Commercial events remain separate:
SubscriptionActivated
SubscriptionExpired
SubscriptionRenewed
PaymentFailed
EntitlementActivated
EntitlementRevoked
This gives us a clean foundation for notifications and future integrations.

6.24 Failure Handling
Provisioning should be designed for failure.
For example:
APPROVED
   ↓
PROVISIONING
   ↓
Create School ✓
Create Membership ✓
Initialize Settings ✓
Create Subscription ✗
The system should not simply pretend the school is active.
Instead:
PROVISIONING
   ↓
FAILED / RETRYABLE
or maintain a provisioning status internally.
This becomes especially useful if provisioning later involves external services.

6.25 Final School Management Model
                    SCHOOL REQUEST
                          │
                          ↓
                    REVIEW / APPROVAL
                          │
                          ↓
                      PROVISIONING
                          │
                          ↓
                        ACTIVE
                          │
              ┌───────────┼────────────┐
              │           │            │
              ↓           ↓            ↓
          MEMBERS       BILLING    ENTITLEMENTS
              │
              ↓
           RBAC
              │
              ↓
       DOMAIN MODULES
With independent administrative lifecycle:
ACTIVE
  │
  ├── SUSPENDED
  │      ↓
  │    ACTIVE
  │
  └── ARCHIVED
And independent subscription lifecycle:
ACTIVE
  ↓
PAST_DUE
  ↓
EXPIRED
  ↓
30-DAY RECOVERY
  ↓
ACCESS LOCKED

Core Decisions Now Established
We now have four strong foundational layers:
1. Tenant Architecture
        ↓
2. RBAC / Permissions
        ↓
3. Entitlement / Feature Dependencies
        ↓
4. School Lifecycle
Together:
                     USER
                       ↓
                  MEMBERSHIP
                       ↓
                  TENANT CONTEXT
                       ↓
                SCHOOL LIFECYCLE
                       ↓
                SUBSCRIPTION
                       ↓
                 ENTITLEMENT
                       ↓
              FEATURE / SUB-FEATURE
                       ↓
                    ROLE
                       ↓
                  PERMISSION
                       ↓
                    ACTION
The next major foundation should be Part 7 — Subscription, Billing, Pricing & Commercial Architecture. That is where we should settle the exact relationship between plans, plan versions, monthly/annual billing, trials, add-ons, custom pricing, invoices, payments, renewals, failed payments, and the entitlement activation flow.
