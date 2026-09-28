<!-- Source: Apple Notes, folder 'Notes' -->
# Part 5 — Entitlement & Feature Dependency Engine

This is the layer that answers:
“What is this school actually entitled to use right now?”
It sits between the commercial system and application authorization.
The important distinction is:
Subscription
    ↓
Commercial agreement

Entitlement
    ↓
Effective product access

Permission
    ↓
User authority

5.1 The Complete Access Chain
For an operation such as:
Finance Admin → collect a fee
the platform should evaluate:
User authenticated
        ↓
User belongs to School A
        ↓
School A is in an accessible lifecycle state
        ↓
School A has valid entitlement to Fee Management
        ↓
Fee Management is enabled
        ↓
Fee collection capability is enabled
        ↓
User has fee.collect permission
        ↓
ALLOW
So the domain module should not need to understand plans, pricing, or subscriptions directly.

5.2 What Is an Entitlement?
An entitlement is an effective right granted to a tenant by the platform.
Example:
School A
 ├── student.management
 ├── fee.management
 ├── fee.collection
 └── examination.basic
Another school might have:
School B
 ├── student.management
 ├── teacher.management
 ├── fee.management
 ├── fee.collection
 ├── examination.basic
 └── transportation
The application asks:
Does School A have fee.collection?
not:
Does School A have Professional Plan?
This is important because a school may have:
a plan,
add-ons,
custom pricing,
manually granted features,
promotional access,
negotiated contracts.

5.3 Sources of Entitlements
We previously identified several possible sources.
Plan
Add-on
Custom Contract
Super Admin Override
Conceptually:
                 ┌── Base Plan
                 │
School ──────────┼── Add-ons
                 │
                 ├── Custom Contract
                 │
                 └── Admin Override
                          ↓
                 Entitlement Resolver
                          ↓
                 Effective Entitlements
The domain system should only consume the final result.

5.4 Don't Store Only feature_enabled
Avoid making the entire system depend on:
school.feature_enabled = true
because that loses important information.
We need to know why the school has access.
For example:
School A
Feature: transportation

Source:
ADD_ON

Subscription:
SUB-123

Valid Until:
2027-04-30
Or:
Source:
ADMIN_OVERRIDE

Approved By:
Super Admin

Reason:
Enterprise contract
This becomes valuable for billing, support, auditing, and troubleshooting.

5.5 Entitlement Model
Conceptually:
Entitlement
 ├── tenant_id
 ├── feature_id
 ├── sub_feature_id
 ├── source
 ├── source_reference
 ├── status
 ├── starts_at
 ├── expires_at
 ├── granted_by
 └── metadata
The exact database structure can wait.
The important thing is that an entitlement is:
tenant + capability + source + validity + state

5.6 Effective Entitlement
A school may receive the same feature from multiple sources.
Example:
Professional Plan
     ↓
Transportation

Transportation Add-on
     ↓
Transportation
Both may grant the same capability.
The resolver should produce:
transportation = AVAILABLE
rather than duplicate access decisions throughout the application.

5.7 Entitlement Resolution
Conceptually:
Plan
+
Add-ons
+
Custom Contract
+
Overrides
+
Validity
+
Feature State
+
Dependencies
+
Subscription State
        ↓
ENTITLEMENT RESOLVER
        ↓
EFFECTIVE ENTITLEMENT SET
For example:
School A
might resolve to:
student.view       = true
student.create     = true
fee.view            = true
fee.collect         = true
transport.view      = false
exam.view           = true
The result should be deterministic.

5.8 Feature Hierarchy
We should keep the product hierarchy relatively shallow.
Example:
Student Management
 ├── Student Profile
 ├── Admission
 ├── Documents
 ├── Import
 └── Reports
Avoid:
Student
 └── Admission
      └── Online
           └── Application
                └── International
                     └── ...
Excessive nesting makes configuration and authorization unnecessarily complicated.
A practical model is:
Feature
   ↓
Sub-feature
with permissions separate from both.

5.9 Independent Sub-Features
A sub-feature may be commercially independent.
For example:
Examination
 ├── Basic Exams
 ├── Advanced Analytics
 └── Online Results
A school could have:
Examination = YES
Basic Exams = YES
Advanced Analytics = NO
Online Results = YES
This allows the commercial model to evolve without restructuring the entire product.

5.10 Feature Dependencies
Some features require other features.
For example:
Examination
   ↓
requires
   ↓
Student Management
or:
Fee Collection
   ↓
requires
   ↓
Student Management
or later:
Transport Fee Integration
   ↓
requires
   ├── Transportation
   └── Fee Management
These dependencies should be represented as data/configuration rather than hardcoded across domain modules.

5.11 Dependency Types
We should distinguish at least two concepts.
Hard dependency
Feature cannot operate without the dependency.
Example:
Exam Results
requires
Student Management
If Student Management isn't available, Exam Results cannot be provisioned.

Soft/recommended dependency
Feature can technically operate independently but another feature is recommended.
Example:
Advanced Analytics
recommends
Reports
For V1, I would implement hard dependencies first.
We can add richer dependency types later if needed.

5.12 Enabling a Feature
Suppose Super Admin wants to enable:
Transportation
The engine evaluates:
Transportation
    ↓
Dependencies?
    ↓
Student Management ── YES
Fee Management ────── YES
    ↓
Eligible
Then it can be enabled.
If a dependency is missing:
Transportation
    ↓
requires Fee Management
    ↓
Fee Management = NOT ENTITLED
the platform should not silently enable it.
It should show the administrator the dependency.

5.13 Disabling a Dependency
This is where the confirmation behavior we established earlier becomes important.
Suppose:
School A

Student Management = ON
Fee Management = ON
Examination = ON
and:
Examination
requires
Student Management
An administrator tries to disable Student Management.
The system should detect:
Student Management
       ↓
used by
       ↓
Examination
and respond conceptually:
Disabling Student Management will affect Examination. Continue?
The administrator must explicitly confirm.
No silent cascading.

5.14 What Happens After Confirmation?
This is an important business rule.
Disabling a dependency should generally result in:
Dependency = DISABLED
Affected dependent feature = DISABLED / BLOCKED
but:
Data is never deleted.
For example:
Student Management
     ↓
DISABLED

Existing students
     ↓
RETAINED
and:
Examination
     ↓
BLOCKED
The examination data remains preserved.

5.15 Disabled Does Not Mean Deleted
This distinction should be fundamental:
Feature disabled
≠
Feature data deleted
For example:
Transportation disabled
does not delete:
Routes
Vehicles
Drivers
Student assignments
Historical transport records
It only prevents normal operational access according to the entitlement/authorization rules.
This is critical for future reactivation.

5.16 Subscription Expiration
Now combine this with the subscription lifecycle we already designed.
Suppose:
Subscription
    ↓
Expired
The entitlement engine should stop treating normal operational entitlements as active.
Conceptually:
Subscription Active
        ↓
Entitlements Active
        ↓
Features Available
After expiry:
Subscription Expired
        ↓
Operational Entitlements Inactive
        ↓
Operational Features Locked
But during the 30-day recovery period:
School Admin
    ↓
Can authenticate
    ↓
Can access renewal/billing/support
    ↓
Cannot perform normal school operations
The entitlement engine therefore needs to understand validity state, not merely whether a feature record exists.

5.17 Entitlement State
A useful conceptual lifecycle:
Pending
   ↓
Active
   ↓
Expiring
   ↓
Expired
   ↓
Revoked
Not every entitlement needs every state.
For example:
Active
Expired
Revoked
may be sufficient internally, with subscription status determining the broader commercial state.
The exact state machine can be finalized later.

5.18 Super Admin Override
We previously agreed that Super Admin can override a plan.
For example:
School A
Plan:
Basic
but Super Admin grants:
Advanced Examination
The entitlement should record:
Source:
ADMIN_OVERRIDE

Granted By:
User X

Reason:
Custom enterprise agreement

Start:
2026-09-01

Expiry:
2027-09-01
This prevents an override from becoming an unexplained permanent flag.

5.19 Override Priority
We need deterministic rules when sources conflict.
A sensible conceptual order is:
Commercial Entitlement
        +
Explicit Administrative Override
        ↓
Effective Entitlement
But we should distinguish:
Grant override
Plan says NO
Admin override says YES

→ YES
Restriction/revocation
Potentially:
Plan says YES
Admin restriction says NO

→ NO
Whether we need negative overrides should be decided carefully.
For V1, I recommend supporting positive grants first and adding explicit deny/restriction semantics only when there is a real requirement.
This keeps the model simpler.

5.20 Feature Request Flow
When School Admin requests a feature:
School Admin
    ↓
Feature Request
    ↓
Platform Review
    ↓
Approved
    ↓
Commercial Terms
    ↓
Payment / Subscription Item
    ↓
Entitlement
    ↓
Feature Available
Approval itself should not automatically equal access.
This distinction prevents:
Approved request
→ free access
unless the business rules explicitly say so.

5.21 Example: Transportation Request
School A currently has:
Student Management = YES
Fee Management = YES
Transportation = NO
School Admin requests:
Transportation
Platform Admin agrees:
₹X/month
The flow becomes:
Feature Request
      ↓
Approved
      ↓
Price Agreed
      ↓
Subscription Item / Add-on
      ↓
Payment
      ↓
Entitlement Activated
      ↓
Transportation Available
That gives us a clean commercial audit trail.

5.22 Entitlement vs Permission — Final Example
Suppose:
School A
Transportation = ENABLED
but:
User A
Role = Finance Admin
and Finance Admin has no transport permissions.
Then:
transport.view
is denied.
Conversely:
User B
Role = Transport Admin
has:
transport.view
transport.route.create
Then those actions are allowed.
So:
Entitlement:
"Can the school use it?"

Permission:
"Can this user use it?"
This distinction should remain intact throughout the platform.

5.23 The Authorization Engine Should Not Recalculate Everything Every Time
We need a practical balance.
We can have:
Source Data
   ↓
Entitlement Resolver
   ↓
Effective Entitlements
   ↓
Cached/read-optimized representation
Then authorization checks can be fast.
When something changes:
Plan changed
Subscription changed
Add-on purchased
Feature disabled
Override added
Override removed
we invalidate/recalculate the affected tenant's entitlement state.

5.24 Domain Modules Should Consume a Simple Contract
A future Fees module should not know about:
Plan
Subscription
Invoice
Pricing
Feature Request
Add-on
Override
It should be able to ask something like:
Can tenant perform:
fee.collect?
or:
Is capability:
fee.collection
available?
The platform core handles the complexity.
This keeps future modules independent.

5.25 Proposed Core Components
At this point, the platform core contains:
Identity & Access
        │
        ├── Users
        ├── Memberships
        ├── Roles
        └── Permissions
        │
Tenant Management
        │
        └── Schools
        │
Product Catalog
        │
        ├── Features
        ├── Sub-features
        └── Dependencies
        │
Commercial
        │
        ├── Plans
        ├── Pricing
        ├── Subscriptions
        ├── Add-ons
        └── Payments
        │
Entitlement
        │
        ├── Entitlements
        ├── Overrides
        └── Resolver
        │
Platform Services
        │
        ├── Audit
        ├── Notifications
        ├── Files
        └── Events
Then:
                 PLATFORM CORE
                       │
        ┌──────────────┼──────────────┐
        ↓              ↓              ↓
    Students       Teachers        Finance
        ↓              ↓              ↓
      Future Domain Modules

5.26 The Access Decision Is Now Complete
We can now define the central authorization concept as:
ALLOW =
    Authenticated
    AND
    Authorized Membership
    AND
    Valid Tenant Context
    AND
    School Lifecycle Allows Access
    AND
    Effective Entitlement
    AND
    Feature/Sub-feature Enabled
    AND
    User Permission
    AND
    Scope Allows Action
This becomes the foundation that every future domain module uses.

Architecture Decisions We Can Now Treat as Stable
￼
The next logical step is Part 6 — School/Tenant Management itself: school onboarding/request → approval → provisioning → activation → suspension → renewal/recovery → archive, including the exact lifecycle and responsibilities of Super Admin, Platform Admin, and School Admin.
