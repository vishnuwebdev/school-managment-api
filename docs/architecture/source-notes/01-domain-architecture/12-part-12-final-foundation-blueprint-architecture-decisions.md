<!-- Source: Apple Notes, folder 'Notes' -->
# Part 12 — Final Foundation Blueprint & Architecture Decisions

This consolidates the architecture we've established so far into a single reference model.
The goal is now to distinguish between:
Locked decisions — foundation we should build around.
Flexible decisions — implementation choices that can change without redesigning the product.
Deferred decisions — intentionally postponed until the relevant domain is designed.

12.1 Final Architecture
                                      PLATFORM
                                         │
                    ┌────────────────────┼────────────────────┐
                    │                    │                    │
               IDENTITY & RBAC      PRODUCT CATALOG      COMMERCIAL
                    │                    │                    │
                 Users              Features              Plans
              Memberships          Sub-features           Pricing
                  Roles            Dependencies        Subscriptions
              Permissions                               Invoices
                                                         Payments
                    │                    │                    │
                    └────────────────────┼────────────────────┘
                                         │
                                  ENTITLEMENT ENGINE
                                         │
                                  TENANT MANAGEMENT
                                         │
                                  ┌──────┴──────┐
                                  │             │
                               SCHOOL A      SCHOOL B
                                  │             │
                          ┌───────┼───────┐     │
                          │       │       │     │
                       Students Teachers Fees   ...
                          │       │       │
                          └───────┼───────┘
                                  │
                           FUTURE MODULES
Cross-cutting:
Audit
Events
Notifications
Files
Search
Background Jobs
Security
Configuration

12.2 Locked Decision #1 — School Is the V1 Tenant
For V1:
Tenant = School
Every school is isolated from every other school.
We are not implementing multi-campus yet.
Future:
Tenant
  ↓
Campus
  ↓
Domain Data
remains possible without making Campus part of V1.

12.3 Locked Decision #2 — User Is Not Directly Owned by School
We will use:
User
  ↓
Membership
  ↓
School
instead of:
User.school_id
This supports:
platform employees,
users belonging to multiple schools,
future organization structures,
explicit tenant context.

12.4 Locked Decision #3 — Tenant Isolation Is a Security Boundary
Every tenant-owned entity is tenant-scoped.
Conceptually:
Entity
 ├── id
 ├── tenant_id
 └── business data
The application/data-access layer enforces tenant scope.
Client-provided tenant IDs are never trusted as proof of authorization.

12.5 Locked Decision #4 — Shared Database Initially
Initial architecture:
Shared Database
       +
tenant_id
       +
central tenant-aware data access
We are not committing to:
database-per-school
or:
schema-per-school
at this stage.
If future enterprise/compliance requirements justify stronger physical isolation, individual tenants can potentially be moved to isolated infrastructure later.

12.6 Locked Decision #5 — Modular Monolith for V1
The initial application should be:
One deployable application with strong internal domain boundaries.
Not a collection of microservices from day one.
Logical modules:
Identity
Tenant
RBAC
Product
Commercial
Entitlement
Audit
Platform Services

Students
Teachers
Fees
Exams
...
This gives us modularity without premature distributed-system complexity.

12.7 Locked Decision #6 — Commercial Access and Authorization Are Separate
This is one of the most important decisions.
Subscription
     ↓
Entitlement
     ↓
"What can the school use?"
while:
Role
     ↓
Permission
     ↓
"What can this user do?"
Neither replaces the other.

12.8 Locked Decision #7 — Feature ≠ Permission
Feature:
Student Management
Permission:
student.create
student.update
student.delete
The feature catalog describes the product.
The permission catalog describes user authority.

12.9 Locked Decision #8 — Plans Don't Directly Control Domain Logic
A domain module must not ask:
"Does this school have Professional?"
Instead:
"Does this school have student.management?"
The entitlement engine resolves:
Plan
+
Add-ons
+
Overrides
+
Subscription state
+
Dependencies
into effective capabilities.

12.10 Locked Decision #9 — Action-Level Permissions
Permissions will be granular.
Examples:
student.view
student.create
student.update
student.delete
student.import
student.export
and:
fee.view
fee.collect
fee.refund
fee.export
This gives the platform sufficient control for configurable Sub Admin access and future commercial/operational requirements.

12.11 Locked Decision #10 — Roles Are Configuration
Roles should not be hardcoded throughout the application.
Instead:
Role
  ↓
Role Assignment
  ↓
Permissions
Initial roles can include:
Super Admin
Platform Admin
Billing Admin
Support Admin
Sales Admin
Operations Admin

School Admin
Sub Admin/custom school roles
Additional roles can be created later.

12.12 Locked Decision #11 — Feature Dependencies Are Data
For example:
Examination
    requires
Student Management
is represented by dependency configuration.
The platform can therefore:
validate enablement,
detect impacted features,
show confirmation,
recalculate entitlements.
It should not be scattered across unrelated domain code.

12.13 Locked Decision #12 — No Silent Cascading
If an administrator disables:
Student Management
and that affects:
Examination
Attendance
the platform must show the impact and require confirmation.
It must not silently disable everything.

12.14 Locked Decision #13 — Disabling Features Never Deletes Data
This is fundamental.
Feature OFF
    ≠
Data DELETED
A school can potentially re-enable the feature later and recover operational access to existing data.

12.15 Locked Decision #14 — School Lifecycle and Subscription Lifecycle Are Separate
School:
Requested
Under Review
Approved
Provisioning
Active
Suspended
Archived
Subscription:
Pending
Trial
Active
Past Due
Expired
Cancelled
These must not be collapsed into one status.

12.16 Locked Decision #15 — 30-Day Recovery
After subscription expiry:
Subscription Expired
        ↓
30-Day Recovery
        ↓
School Admin can log in
        ↓
Renew / Pay / Contact Support
        ↓
Operational modules remain locked
After 30 days:
Access Locked
Data remains retained.

12.17 Locked Decision #16 — School Deletion Is Soft/Archive
Normal school deletion means:
Archive
not physical deletion.
Historical:
Billing
Payments
Audit
School data
remain preserved according to retention policies.

12.18 Locked Decision #17 — Custom Pricing Is a Historical Commercial Fact
If standard price is:
₹100,000
and negotiated price is:
₹75,000
the system retains:
Standard = ₹100,000
Discount = ₹25,000
Final = ₹75,000
Approved By = ...
Reason = ...
We don't overwrite the catalog's standard price.

12.19 Locked Decision #18 — Multiple Subscription Items
A school may have:
Professional Plan
+
Transportation Add-on
+
Advanced Examination Add-on
Therefore:
Subscription
  ↓
Subscription Items
is required.
A single subscription.plan_id model is insufficient.

12.20 Locked Decision #19 — Plan Versioning
Plans should support versions.
Professional
 ├── v1
 ├── v2
 └── v3
Existing subscriptions retain the commercial version they purchased.
Future catalog changes shouldn't silently rewrite historical customer agreements.

12.21 Locked Decision #20 — Audit Is Mandatory
At minimum, audit:
School creation
School approval
School suspension
School restoration
School archive

Plan changes
Subscription changes
Pricing overrides
Payments
Refunds

Feature enable/disable
Entitlement overrides

User creation
User removal
Role changes
Permission changes
Audit captures:
Actor
Tenant
Action
Entity
Entity ID
Before
After
Reason
Timestamp

12.22 Locked Decision #21 — Platform Context vs Tenant Context
We have two fundamental operating contexts:
PLATFORM
TENANT
A platform administrator may switch into an authorized tenant context.
A school user normally has a fixed tenant context.
Platform operations should not accidentally inherit a school context.

12.23 Locked Decision #22 — Domain Ownership
Every important entity has one source of truth.
For example:
User             → Identity
School           → Tenant
Feature          → Product Catalog
Plan             → Commercial
Subscription     → Billing
Invoice          → Billing
Payment          → Billing
Entitlement      → Entitlement
Student          → Student Domain
Teacher          → Teacher Domain
Fee              → Fee Domain
Exam             → Examination Domain
Other domains may reference these entities but shouldn't duplicate ownership.

12.24 Locked Decision #23 — Core Does Not Depend on Future Domains
The dependency direction is:
              PLATFORM CORE
                    ↑
                    │
       ┌────────────┼────────────┐
       │            │            │
    Students     Teachers       Fees
       │            │            │
       └────────────┼────────────┘
                    │
             Other Modules
The core must remain usable even if a particular domain module doesn't exist.

12.25 Locked Decision #24 — Central Authorization
Every domain uses the platform authorization mechanism.
Not:
Student module has its own RBAC
Fee module has its own RBAC
Exam module has its own RBAC
Instead:
Central Authorization
       ↓
All Domain Modules
This prevents inconsistent access behavior.

12.26 Locked Decision #25 — Tenant-Aware Background Jobs
Every tenant-specific background operation carries tenant context.
Examples:
Generate report
Process import
Send notification
Expire subscription
Generate invoice
Recalculate entitlement
This prevents background workers from becoming an accidental cross-tenant access path.

12.27 Locked Decision #26 — Events for Extensibility
We will establish domain events such as:
SchoolCreated
SchoolActivated
SubscriptionActivated
SubscriptionExpired
PaymentReceived
EntitlementChanged
FeatureEnabled
FeatureDisabled
UserCreated
RoleChanged
Later:
StudentCreated
TeacherCreated
FeeCollected
ExamPublished
We don't need a sophisticated event infrastructure immediately.
The important thing is defining the boundaries.

12.28 Locked Decision #27 — Failure Must Not Grant Access
If authorization cannot be established:
FAIL CLOSED
Especially for:
Financial operations
Administrative operations
Cross-tenant access
Permission changes
Entitlement changes
Cached entitlement state may be useful for appropriate low-risk/read scenarios, but it must not become an accidental access escalation mechanism.

12.29 Locked Decision #28 — Payment Operations Are Idempotent
External payment systems can retry events.
Therefore:
Same payment event twice
        ↓
One logical payment
The same applies to:
Renewal
Invoice generation
Webhook processing
Entitlement activation

12.30 Locked Decision #29 — Security Is Layered
The platform security chain is:
Authentication
     ↓
Membership
     ↓
Tenant
     ↓
School lifecycle
     ↓
Entitlement
     ↓
Permission
     ↓
Scope
     ↓
Domain rules
     ↓
Tenant-aware data access
No single check is considered sufficient by itself.

12.31 Deferred Decision — Exact Authentication Technology
We know we need:
Authentication
Sessions
Password reset
MFA capability
But we don't yet need to lock:
JWT vs opaque sessions
OAuth/OIDC provider
SSO provider
Identity infrastructure
That can be chosen during the implementation architecture phase.

12.32 Deferred Decision — Physical Database Isolation
We start with:
Shared DB + tenant_id
Later, if enterprise requirements justify it:
Selected Tenant
       ↓
Dedicated Database
can be considered.
The application architecture should avoid making that migration impossible.

12.33 Deferred Decision — Multi-Campus
Explicitly deferred.
V1:
School = Tenant
Future:
School
  ↓
Campus
  ↓
Domain Data
No need to add campus_id everywhere today.

12.34 Deferred Decision — Advanced Pricing Engine
We support:
Monthly
Annual
Trial
Add-ons
Discounts
Custom pricing
Negotiated pricing
But advanced rules such as:
Per student
Per teacher
Per campus
Usage-based
Tiered pricing
Regional pricing
Volume discounts
should be introduced only when the actual commercial model requires them.

12.35 Deferred Decision — Advanced Scope Engine
The architecture can support:
All students
Assigned classes
Own records
Specific department
but V1 can start with tenant-level permissions.
We should not build a sophisticated attribute-based authorization engine until the product actually needs it.

12.36 Deferred Decision — Microservices
We don't need microservices now.
If later there is a clear reason to extract:
Billing
Notifications
Search
Reporting
the existing module boundaries should make that possible.

12.37 What Is Now Ready for Phase 2
The platform can now expose a stable contract to future domains.
A future Student module should be able to assume:
I can obtain:
- authenticated user
- tenant context
- authorization decision
- entitlement decision
- audit service
- event service
- file service
- notification service
without knowing:
Plan pricing
Subscription mechanics
Payment gateways
Platform role administration
That is exactly the separation we wanted.

12.38 Phase 2 Domain Template
When we start a domain such as Students, we should design it using the same template:
1. Domain purpose
2. Scope / ownership
3. Actors
4. Core entities
5. Entity relationships
6. Lifecycle states
7. Business rules
8. Feature/sub-feature structure
9. Permissions
10. Dependencies
11. Tenant boundaries
12. Cross-domain references
13. Events
14. Audit requirements
15. Reports
16. Files/documents
17. Notifications
18. Failure scenarios
19. Future extension points
This keeps every module architecturally consistent.

12.39 Example: Student Module Plug-In
Eventually:
                     PLATFORM CORE
                           │
             ┌─────────────┼─────────────┐
             ↓             ↓             ↓
        Authorization  Entitlement      Audit
             │             │             │
             └─────────────┼─────────────┘
                           ↓
                    STUDENT MODULE
                           │
                  ┌────────┼────────┐
                  ↓        ↓        ↓
               Student Admission Documents
                  │
               Business Rules
                  │
              Tenant Data
The Student module is a consumer of the platform foundation.

12.40 Final System Blueprint
The overall architecture is now:
┌─────────────────────────────────────────────────────────────┐
│                        PLATFORM                             │
│                                                             │
│ Identity │ Tenant │ RBAC │ Feature Catalog │ Commercial    │
│                                                             │
│ Plans │ Pricing │ Subscriptions │ Billing │ Payments       │
│                                                             │
│ Entitlements │ Dependencies │ Feature Requests             │
│                                                             │
│ Audit │ Events │ Notifications │ Files │ Search             │
└──────────────────────────────┬──────────────────────────────┘
                               │
                         AUTHORIZATION
                               │
                         TENANT CONTEXT
                               │
       ┌───────────────────────┼───────────────────────┐
       │                       │                       │
   SCHOOL A               SCHOOL B                SCHOOL C
       │                       │                       │
       │                       │                       │
 ┌─────┼─────┐           ┌─────┼─────┐           ┌─────┼─────┐
 │     │     │           │     │     │           │     │     │
Students Teachers Fees   Students Teachers Fees   ...
 │     │     │
 └─────┼─────┘
       │
 Future Modules

12.41 The Fundamental Access Equation
This is the architecture's central rule:
ALLOW
=
Authenticated
AND
Authorized Membership
AND
Valid Tenant Context
AND
Allowed School State
AND
Effective Entitlement
AND
Enabled Feature
AND
User Permission
AND
Allowed Scope
AND
Valid Domain Operation
That equation should guide every future feature.

12.42 The Fundamental Dependency Direction
And the dependency direction should remain:
                    PLATFORM CORE
                         │
        ┌────────────────┼────────────────┐
        ↓                ↓                ↓
   Identity/RBAC    Commercial       Entitlement
        │                │                │
        └────────────────┼────────────────┘
                         ↓
                     TENANT
                         ↓
                 DOMAIN MODULES
Never reverse this into:
Student → Subscription internals
Fee → Plan internals
Exam → Billing internals

12.43 Architecture Maturity Checkpoint
At this point, we have enough foundation to stop expanding the platform core and move into the actual product domains.
The next phase should therefore not be another large generic architecture exercise.
It should be:
Phase 2 — Domain Architecture
Recommended sequence:
1. Student Management
2. Teacher Management
3. Class / Academic Structure
4. Attendance
5. Fee Management
6. Examination
7. Timetable
8. Transportation
9. Communication
10. Library
The exact order can change based on product priorities.
For each module, we will plug it into the foundation rather than redesigning the foundation.

One Important Boundary Before We Start
I would now consider the following foundation decisions stable enough to stop revisiting unless a concrete Phase 2 requirement exposes a problem:
✓ Multi-tenant school architecture
✓ Tenant isolation
✓ User/Membership model
✓ Platform vs school context
✓ RBAC
✓ Action-level permissions
✓ Feature/sub-feature model
✓ Feature dependencies
✓ Entitlements
✓ Plans and plan versions
✓ Subscriptions and add-ons
✓ Custom pricing
✓ Billing/payment separation
✓ School lifecycle
✓ Subscription lifecycle
✓ 30-day recovery
✓ Audit
✓ Events
✓ Modular-monolith architecture
✓ Central authorization
✓ Tenant-aware persistence
✓ Security/failure principles
This gives us the stable foundation you originally wanted: future modules can be added or modified without rebuilding the platform's core access, tenancy, subscription, and authorization model.
The natural next design is Student Management, starting from its domain purpose and boundaries rather than immediately jumping into database tables.
