<!-- Source: Apple Notes, folder 'Notes' -->
# Part 9 — Core Platform Data Model & Domain Boundaries

Now we can consolidate the architecture into a stable core data model.
The goal is not to create every table yet. The goal is to establish:
ownership,
relationships,
boundaries,
lifecycle,
dependencies,
and which module owns each piece of information.
The Phase 2 domain data—Students, Teachers, Fees, Exams, Transportation, etc.—will plug into this model later.

9.1 The Core Domains
I recommend separating the platform into these bounded domains:
1. Identity & Access
2. Tenant / School Management
3. Product & Feature Catalog
4. Plans & Pricing
5. Subscription & Billing
6. Entitlement
7. Feature Requests / Commercial Approval
8. Audit
9. Platform Services
Later:
10. Students
11. Teachers
12. Classes
13. Attendance
14. Fees
15. Examination
16. Timetable
17. Transportation
18. Library
19. Communication
...
The later modules should depend on the core, not the other way around.

9.2 Ownership Classification
Every entity should have an explicit ownership category.
Platform-global
Feature
SubFeature
Permission
Platform Role
Plan
Plan Version
Feature Dependency
Pricing Catalog
Tenant-owned
School Profile
School Settings
School Membership
School Roles
Students
Teachers
Classes
Fees
Exams
...
Tenant-scoped commercial
Subscription
Subscription Item
Invoice
Payment
Entitlement
Feature Request
Custom Pricing
System/audit
Audit
Notification
Domain Event
Background Job
This classification should be part of the architecture documentation.

9.3 Identity Domain
The most important decision here is:
User identity and school membership are different things.
Conceptually:
USER
 │
 ├── Membership → School A
 │                  └── Roles
 │
 ├── Membership → School B
 │                  └── Roles
 │
 └── Platform Membership
                       └── Platform Roles
Core entities:
User
Membership
Role
Permission
RolePermission
RoleAssignment
Session
Potential later entities:
MFA
LoginHistory
ExternalIdentity
APIKey

9.4 User
User represents a human/system identity.
It should not fundamentally contain:
school_id
because that prevents a user from having multiple legitimate memberships.
Instead:
User
 ├── id
 ├── identity information
 ├── status
 └── authentication metadata
Then:
Membership
 ├── user_id
 ├── tenant_id
 ├── status
 └── scope

9.5 Membership
Membership answers:
Which organization/context does this user belong to?
Example:
User A
 ├── Platform Membership
 │     └── Platform roles
 │
 └── School A Membership
       └── School roles
This is one of the most important entities in the entire system.

9.6 Role
A role is a reusable permission bundle.
Role
 ├── id
 ├── name
 ├── type
 ├── scope
 ├── status
 └── metadata
Types could conceptually be:
PLATFORM
TENANT
SYSTEM
CUSTOM
The exact values can be finalized during implementation.

9.7 Permission
Permission is the stable authorization contract.
Permission
 ├── key
 ├── name
 ├── description
 ├── category
 ├── scope
 └── status
Examples:
student.view
student.create
fee.collect
payment.refund
school.suspend
pricing.override

9.8 Role Assignment
A user may have multiple roles.
Therefore:
User
  ↓
Role Assignment
  ↓
Role
The assignment can include context:
RoleAssignment
 ├── user
 ├── role
 ├── tenant
 ├── scope
 ├── starts_at
 ├── ends_at
 └── status
This gives us room for temporary roles later.

9.9 Tenant / School Domain
Core entities:
School
SchoolProfile
SchoolSettings
SchoolRequest
Future:
Campus
but we deliberately don't implement Campus in V1.

9.10 School
The School is the V1 tenant.
Conceptually:
School
 ├── id
 ├── tenant_key
 ├── status
 ├── created_at
 └── lifecycle metadata
It should not become a giant object containing:
billing
students
teachers
settings
permissions
notifications
...
Those belong to their respective domains.

9.11 School Profile
SchoolProfile
 ├── school_id
 ├── legal/business name
 ├── display name
 ├── contact details
 ├── address
 ├── logo
 └── other profile information
Profile information changes for business reasons, while the tenant identity itself remains stable.

9.12 School Settings
SchoolSettings
 ├── school_id
 ├── timezone
 ├── locale
 ├── notification preferences
 └── configuration
Domain-specific configuration should eventually live with its domain where appropriate.

9.13 Product Catalog
The product catalog describes what the platform can sell/provide.
Feature
SubFeature
FeatureDependency
Potentially:
Product
but I would not introduce a generic Product entity until there is an actual business need.
Feature itself can be the commercial capability.

9.14 Feature
Feature
 ├── key
 ├── name
 ├── description
 ├── status
 └── metadata
Example:
student_management
fee_management
examination
transportation

9.15 SubFeature
SubFeature
 ├── feature_id
 ├── key
 ├── name
 ├── status
 └── metadata
Example:
Transportation
 ├── Route Management
 ├── Vehicle Management
 ├── Driver Management
 └── Student Assignment

9.16 Feature Dependency
This should be a relationship, not embedded as arbitrary application code.
FeatureDependency
 ├── feature
 ├── dependency
 ├── dependency_type
 └── status
For example:
Examination
      ↓
requires
      ↓
Student Management
Later:
Advanced Transport Billing
      ↓
requires
      ├── Transportation
      └── Fee Management

9.17 Plans
Plans sit on top of the product catalog.
Plan
 └── PlanVersion
        └── PlanFeature
Example:
Professional v3
 ├── Student Management
 ├── Teacher Management
 ├── Fee Management
 └── Examination

9.18 Why PlanFeature Is Separate
Avoid storing a giant JSON object such as:
plan.features = {
  "student": true,
  "fees": true,
  "exam": false
}
A relational/domain representation gives us:
dependencies,
history,
versioning,
querying,
auditability,
sub-feature support.
Conceptually:
PlanVersion
     ↓
PlanFeature
     ↓
Feature / SubFeature

9.19 Pricing
Pricing should reference commercial catalog entities.
Price
 ├── plan/version or add-on
 ├── billing_period
 ├── currency
 ├── amount
 ├── validity
 └── status
A historical subscription should not depend on a price record remaining unchanged forever.
The subscription item must preserve the actual commercial terms that were purchased.

9.20 Subscription
Core structure:
Subscription
 ├── school_id
 ├── status
 ├── billing_cycle
 ├── start
 ├── current_period
 ├── renewal
 └── commercial metadata
It should not directly represent every feature.
Instead:
Subscription
      ↓
SubscriptionItem

9.21 Subscription Item
SubscriptionItem
 ├── subscription_id
 ├── item_type
 ├── product_reference
 ├── quantity
 ├── standard_price
 ├── discount
 ├── final_price
 ├── currency
 ├── starts_at
 └── ends_at
Example:
Subscription
 ├── Professional Plan
 ├── Transportation Add-on
 └── Advanced Exam Add-on
This is the commercial composition of the customer's purchase.

9.22 Invoice
Invoice belongs to the billing domain and is tenant-scoped.
Invoice
 ├── school_id
 ├── invoice_number
 ├── status
 ├── issued_at
 ├── due_at
 ├── subtotal
 ├── discount
 ├── tax
 └── total
Invoice items reference the commercial purchase components.

9.23 Payment
Payment
 ├── school_id
 ├── invoice_id
 ├── amount
 ├── currency
 ├── method
 ├── status
 ├── reference
 ├── received_at
 └── verification metadata
Payment should not directly create feature access.
It causes a billing state transition, which then results in entitlement recalculation.

9.24 Entitlement
This is the bridge between commercial data and product access.
Entitlement
 ├── school_id
 ├── feature/sub-feature
 ├── source
 ├── source_reference
 ├── status
 ├── starts_at
 ├── expires_at
 └── metadata
Possible sources:
PLAN
ADD_ON
CUSTOM_CONTRACT
ADMIN_OVERRIDE

9.25 Entitlement History
Because access can change over time, we should preserve the history.
For example:
School A

2026-01-01
Fee Management → Active

2026-09-01
Fee Management → Revoked

2026-10-15
Fee Management → Active
This can be represented through an entitlement history/event model rather than overwriting the past.

9.26 Feature Request
Feature requests are tenant-scoped business objects.
FeatureRequest
 ├── school_id
 ├── requested_feature
 ├── requested_by
 ├── status
 ├── requested_at
 ├── reviewed_by
 └── review metadata
Commercial approval can be represented separately if the workflow becomes complex.

9.27 Commercial Approval
If we need formal approval tracking:
CommercialApproval
 ├── request
 ├── proposed_price
 ├── approved_price
 ├── approved_by
 ├── status
 ├── reason
 └── timestamps
This keeps:
Feature Request
separate from:
Commercial Agreement
which is a useful boundary.

9.28 Audit
Audit is cross-cutting but should be its own platform domain.
Audit
 ├── actor
 ├── actor_type
 ├── tenant
 ├── action
 ├── entity_type
 ├── entity_id
 ├── before
 ├── after
 ├── reason
 ├── request/context
 └── timestamp
It should be append-oriented.
Normal users should never be able to modify audit history.

9.29 Domain Events
We should establish an event concept even if we don't build a sophisticated event bus immediately.
Examples:
SchoolCreated
SubscriptionActivated
SubscriptionExpired
PaymentReceived
EntitlementActivated
EntitlementRevoked
UserCreated
RoleChanged
FeatureEnabled
FeatureDisabled
Later domain modules can publish:
StudentCreated
TeacherCreated
ExamPublished
FeeCollected
This gives future integrations a clean extension point.

9.30 Platform Services
Some capabilities are cross-domain services rather than business domains.
Notification
File Storage
Search
Configuration
Background Jobs
Event Publishing
They should not own the business rules of Students, Fees, etc.
For example:
Subscription Service
      ↓
Notification Service
not:
Notification Service
      ↓
knows subscription business rules

9.31 Core Relationship Diagram
The platform core can now be visualized as:
                         USER
                           │
                      MEMBERSHIP
                           │
                  ┌────────┴────────┐
                  │                 │
              PLATFORM           SCHOOL
              CONTEXT           CONTEXT
                  │                 │
                ROLES          SCHOOL PROFILE
                  │                 │
             PERMISSIONS       SETTINGS
                                    │
                    ┌───────────────┼────────────────┐
                    │               │                │
               SUBSCRIPTION    MEMBERSHIPS       FEATURE REQUESTS
                    │
             SUBSCRIPTION ITEMS
                    │
          ┌─────────┴─────────┐
          ↓                   ↓
       INVOICE             ENTITLEMENT
          │                   │
       PAYMENT                │
                              ↓
                    FEATURE / SUB-FEATURE
                              │
                         DEPENDENCIES

9.32 What Should Not Be Connected Directly
A few boundaries are especially important.
Domain → Plan
Avoid:
Fees → Professional Plan
Instead:
Fees → Entitlement Service
The Fees module shouldn't care which commercial plan produced the entitlement.

Domain → Billing
Avoid:
Student Service → Invoice
unless there is a genuine business requirement.
Instead:
Student Service
      ↓
Student domain
and commercial access is handled by the platform core.

Domain → Role Name
Avoid:
if role == "School Admin"
Use:
Permission check

9.33 Dependency Direction
A clean dependency direction should be:
                  PLATFORM CORE
                       ↑
                       │
              ┌────────┼────────┐
              │        │        │
          Students  Teachers   Fees
              │        │        │
              └────────┼────────┘
                       │
                  Other Domains
The core should not depend on Students.
Students may depend on:
Identity
Tenant
Authorization
Entitlement
Audit
File Storage
Notifications
but not the reverse.

9.34 Domain Module Contract
Every future module should ideally follow a consistent structure:
Module
 ├── Domain Model
 ├── Business Rules
 ├── Application Services
 ├── Authorization
 ├── Tenant Boundary
 ├── Events
 ├── Audit
 └── Persistence
This will make adding:
Library
later much less disruptive than if every module is built differently.

9.35 Cross-Domain References
A future Student record may reference:
Student
 ├── tenant_id
 ├── class_id
 └── ...
The Classes module owns the Class entity.
The Student module should not duplicate the entire Class object.
Likewise:
Fee Account
 └── student_id
references the Student domain.
Ownership remains clear:
Student Module → owns Student
Class Module   → owns Class
Fee Module     → owns Fee Account

9.36 Data Ownership Rule
For every important entity, we should be able to answer:
Which domain owns the truth?
Examples:
School → School Management
User → Identity
Role → Access
Permission → Access
Feature → Product Catalog
Plan → Commercial
Subscription → Billing
Invoice → Billing
Payment → Billing
Entitlement → Entitlement
Student → Student Domain
Teacher → Teacher Domain
Fee → Fee Domain
Exam → Examination Domain
Other domains may reference these entities, but should not become their source of truth.

9.37 Avoid a Giant Shared Database Model
The database can physically be shared while the domain ownership remains separated.
Don't create a conceptual structure like:
School
 ├── students
 ├── teachers
 ├── fees
 ├── exams
 ├── buses
 ├── books
 ├── payments
 └── everything else
Instead:
School
   │
   ├── Identity
   ├── Commercial
   ├── Entitlement
   │
   └── Domain Modules
        ├── Student
        ├── Teacher
        ├── Fee
        ├── Examination
        └── ...
That distinction will matter enormously as the product grows.

9.38 Stable Core vs Changeable Modules
The core should be relatively stable:
Identity
Tenant
RBAC
Feature Catalog
Plans
Subscription
Entitlement
Audit
Domain modules are expected to evolve much more frequently:
Students
Teachers
Fees
Exams
Transport
Library
Communication
This gives us a controlled architecture:
Stable Platform Core
        ↓
Extensible Domain Modules

9.39 What We Should Not Design Yet
At this stage, I would deliberately not finalize:
Student tables
Teacher tables
Fee tables
Exam tables
Transport tables
Timetable tables
Library tables
Attendance tables
We know where they belong.
We know how they should interact with the core.
But their internal business models should be designed separately when we reach Phase 2.
That prevents the core architecture from being polluted by premature domain assumptions.

9.40 Core Architecture Snapshot
The foundation now looks like:
                         PLATFORM
                            │
        ┌───────────────────┼────────────────────┐
        │                   │                    │
    IDENTITY            PRODUCT             COMMERCIAL
        │                CATALOG                  │
        │                   │                     │
        │              FEATURES                 PLANS
        │              SUBFEATURES             PRICING
        │              DEPENDENCIES            SUBSCRIPTIONS
        │                                       INVOICES
        │                                       PAYMENTS
        │                                           │
        └──────────────────┬────────────────────────┘
                           ↓
                     ENTITLEMENT
                           │
                           ↓
                    TENANT / SCHOOL
                           │
             ┌─────────────┼──────────────┐
             ↓             ↓              ↓
          MEMBERS       SETTINGS       DOMAIN MODULES
                                           │
                           ┌───────────────┼──────────────┐
                           ↓               ↓              ↓
                       STUDENTS        TEACHERS         FEES
                           ↓               ↓              ↓
                                      FUTURE MODULES
Across everything:
                    AUDIT
                      │
                  EVENTS
                      │
              PLATFORM SERVICES

What We Have Achieved
The architecture now has a clear answer for:
Who is the user? → Identity
Which school/context are they operating in? → Membership/Tenant Context
What can the school purchase? → Feature Catalog
What did the school purchase? → Subscription
What did it pay? → Invoice/Payment
What does the school currently have access to? → Entitlement
What can the individual user do? → RBAC/Permissions
What happens when something changes? → Lifecycle + Events
Who changed it? → Audit
Where does future business functionality live? → Independent Domain Modules
The next step should be Part 10 — Platform APIs, Service Boundaries & Request Flow. That will define how these domains communicate without becoming tightly coupled, including the request pipeline, service boundaries, transaction boundaries, events, background jobs, caching, and how a future Student/Fees module plugs into the core.
