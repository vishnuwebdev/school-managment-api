<!-- Source: Apple Notes, folder 'Notes' -->
# Phase 1 — Platform Foundation System Design

Part 1: Architecture Principles & System Context
This is the baseline design we should use for the rest of Phase 1. I’ll treat it as System Design V1, so we can revise it as we uncover gaps.

1. Product Definition
We are building a:
Multi-tenant, configurable SaaS platform for school management.
The platform is operated by your organization and provides different school-management capabilities to multiple independent schools.
Each school:
Has its own data
Has its own users
Has its own subscription
Has its own enabled features
Has its own permissions
Can have custom pricing/entitlements
Is isolated from other schools
The platform itself controls the commercial and technical availability of those capabilities.

2. Fundamental Architecture
At the highest level:
                         ┌─────────────────────┐
                         │    YOUR COMPANY     │
                         │  SaaS Platform      │
                         └──────────┬──────────┘
                                    │
                  ┌─────────────────┼─────────────────┐
                  │                 │                 │
                  ▼                 ▼                 ▼
            Platform Admin     Plans/Billing    Feature Catalog
                  │                 │                 │
                  └─────────────────┼─────────────────┘
                                    │
                             Tenant Management
                                    │
             ┌──────────────────────┼──────────────────────┐
             │                      │                      │
             ▼                      ▼                      ▼
          School A               School B               School C
             │                      │                      │
       Subscription            Subscription            Subscription
             │                      │                      │
       Entitlements             Entitlements            Entitlements
             │                      │                      │
        School Users           School Users           School Users
             │
        School Admin
             │
         Sub Admins
             │
       Roles & Permissions
             │
      Enabled Domain Features
This gives us three major levels:
Platform
Your organization operates the SaaS.
Tenant
Each school is an independent tenant.
User
People operate within the context of a tenant or the platform.

3. Architecture Principles
These principles should guide every future design decision.
Principle 1 — Tenant isolation first
No school should be able to access another school's data.
Every school-owned business object must have a clear tenant boundary.
Conceptually:
School A
 ├── Students
 ├── Teachers
 ├── Fees
 └── Exams

School B
 ├── Students
 ├── Teachers
 ├── Fees
 └── Exams
The application must never rely solely on the UI to enforce this.
Tenant isolation must exist at the service/API/data-access layers.

4. Principle 2 — Subscription is separate from access
We should never use:
subscription_active = true
as the entire access-control mechanism.
Instead:
Subscription
      ↓
Entitlement
      ↓
Feature
      ↓
Sub-feature
      ↓
Permission
      ↓
Action
This allows us to change commercial models without rewriting authorization.

5. Principle 3 — Features are configurable
A feature should be represented as a platform entity, not hardcoded throughout the application.
For example:
Feature
    Attendance

Sub-features
    Mark Attendance
    Attendance Report
    Attendance Export
Later:
Feature
    Transport

Sub-features
    Routes
    Vehicles
    Drivers
    Student Allocation
The platform can then manage these consistently.

6. Principle 4 — Permissions are independent from features
Feature:
"Does the school have Attendance?"
Permission:
"Can this user edit Attendance?"
These are different questions.
School Entitlement
        ↓
Attendance available
        ↓
User Permission
        ↓
Can Edit Attendance?
This is essential for your Sub Admin model.

7. Principle 5 — Domain modules own their business data
When we eventually implement:
Student
Teacher
Fee
Examination
Transport
Library
each module should own its own business rules and data.
For example:
Student Domain
 ├── Student
 ├── Admission
 ├── Student documents
 └── Student-related rules
The Student domain should not own:
Subscription logic
User authentication
Platform roles
Billing
It should consume those platform capabilities.

8. Principle 6 — Platform services should be reusable
Common capabilities should exist once.
For example:
Platform Core
├── Authentication
├── Authorization
├── Tenant Context
├── Feature Entitlement
├── Subscription
├── Audit
├── Notifications
├── File Storage
└── Configuration
Student, Teacher, Fee, etc. reuse these services.

9. Principle 7 — No destructive feature disabling
If a school loses access to a feature:
Feature = Disabled
does not mean:
Feature Data = Deleted
Example:
Fees disabled
        ↓
Fee records preserved
        ↓
Feature inaccessible
        ↓
School renews/re-enables
        ↓
Historical data available
This is critical for commercial changes and subscription expiry.

10. Principle 8 — Lifecycle state must be explicit
Important entities should have explicit states.
For example:
School
Requested
Under Review
Approved
Active
Suspended
Archived
Subscription
Pending
Trial
Active
Past Due
Expired
Grace Period
Cancelled
Feature Request
Requested
Under Review
Approved
Rejected
Awaiting Payment
Provisioned
Cancelled
This prevents ambiguous boolean flags such as:
is_active
from carrying too much meaning.

11. Principle 9 — Audit important changes
Anything affecting access, money, or configuration should be auditable.
Examples:
School created
Plan changed
Subscription renewed
Feature enabled
Feature disabled
Price overridden
Permission changed
Sub-admin created
School suspended
Audit information should capture at minimum:
Actor
Action
Entity
Entity ID
Timestamp
Tenant
Previous state
New state
Reason

12. Principle 10 — Design for extension, not speculation
We want the system to support future requirements without rework.
But we shouldn't implement every possible future feature today.
For example:
Today
School
Later
School
 ├── Campus A
 ├── Campus B
 └── Campus C
We don't implement campus management now.
But we should avoid architectural decisions that make it impossible or extremely expensive later.

13. System Actors
At Phase 1, I see these major actors.
Platform side
Super Admin
Platform Admin
Billing Admin
Support Admin
Sales Admin
Operations Admin
School side
School Admin
Sub Admin
Later Phase 2:
Teacher
Student
Parent
Accountant
Librarian
Transport Manager
etc.
Those are domain users rather than Phase 1 architecture concerns.

14. System Context
The platform will eventually interact with external systems.
At minimum:
                    ┌───────────────────┐
                    │    Admin Users    │
                    └─────────┬─────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │                   │
                    │ School Management │
                    │ SaaS Platform     │
                    │                   │
                    └─────────┬─────────┘
                              │
          ┌───────────────────┼────────────────────┐
          │                   │                    │
          ▼                   ▼                    ▼
       Payment             Email/SMS           File Storage
       Provider            Provider            / Documents
Potential future integrations:
Payment gateways
Email provider
SMS provider
WhatsApp provider
Cloud storage
Identity provider
Accounting systems
Biometric devices
Government education systems
Analytics platforms
We should therefore keep external integrations behind clear integration boundaries.

15. Major Platform Domains
At the architecture level, I would divide the platform into these domains.
PLATFORM
│
├── Identity & Access
│
├── Tenant Management
│
├── School Management
│
├── Product / Feature Catalog
│
├── Plans & Pricing
│
├── Subscription & Billing
│
├── Entitlement Management
│
├── Feature Dependency
│
├── User & Role Management
│
├── Audit
│
├── Notifications
│
└── Configuration
Then Phase 2 domains attach to this:
SCHOOL DOMAINS
│
├── Students
├── Teachers
├── Classes
├── Attendance
├── Fees
├── Examination
├── Timetable
├── Transportation
├── Library
└── Communication

16. Domain Boundary
A useful rule:
A domain owns its business rules and data; other domains interact with it through defined contracts.
For example:
Fee Management
      │
      │ needs to know
      ▼
Student identity
It should not directly manipulate the Student domain's internal tables.
Instead:
Fee Domain
     ↓
Student Service / API / Domain Contract
This reduces coupling.

17. Tenant Context
Every school-side request should carry a tenant context.
Conceptually:
Request
   ↓
Authenticated User
   ↓
Tenant Context
   ↓
School ID
   ↓
Authorization
   ↓
Domain Operation
Example:
User: 874
School: SCHOOL_102
Feature: ATTENDANCE
Action: ATTENDANCE_MARK
The backend then verifies all of these independently.

18. Platform Context vs School Context
This is important because some users can operate across multiple schools.
Platform user
Platform Admin
   │
   ├── School A
   ├── School B
   └── School C
School user
School Admin
   │
   └── School A
The authorization system therefore needs a concept of scope.
For example:
Platform Scope
School Scope
Later we may introduce:
Department Scope
Class Scope
depending on Phase 2 requirements.

19. High-Level Request Flow
A normal school operation should conceptually flow like this:
Client
  │
  ▼
Authentication
  │
  ▼
Identify User
  │
  ▼
Resolve Tenant
  │
  ▼
Check School Status
  │
  ▼
Check Subscription
  │
  ▼
Check Feature Entitlement
  │
  ▼
Check Sub-feature
  │
  ▼
Check Permission
  │
  ▼
Execute Domain Operation
  │
  ▼
Audit
  │
  ▼
Response
This is the backbone of the platform.

20. Important Architecture Decision
I recommend that authorization should not be implemented independently inside every future module.
Instead, we should have a central authorization/entitlement capability.
Conceptually:
Authorization Service

CanAccess(
    user,
    tenant,
    feature,
    subFeature,
    action
)
The actual implementation can be refined later, but the architectural responsibility should be centralized.

21. What we have now established
We can consider these decisions provisionally locked:
￼
Next design layer
With the architecture principles and system context established, the next piece should be Domain Architecture + Core Entity Model.
That is where we define precisely how these concepts relate:
Platform
   │
   ├── Platform User
   ├── Role
   ├── Permission
   │
   ├── School
   │     ├── School User
   │     └── School Role
   │
   ├── Feature
   │     └── Sub-feature
   │
   ├── Plan
   │
   ├── Subscription
   │
   ├── Entitlement
   │
   ├── Dependency
   │
   └── Audit
The next step should be to work through each entity, its responsibility, relationships, lifecycle, and ownership before we design actual database tables.
