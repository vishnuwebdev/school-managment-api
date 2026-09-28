<!-- Source: Apple Notes, folder 'Notes' -->
# Phase 1 — Domain Architecture

Part 2: Core Domain Model
We now move from “what the platform should do” to “what the platform consists of.”
The most important rule at this stage is:
We define business entities and their responsibilities first. We do not yet decide whether something becomes a table, collection, service, or microservice.

1. Domain Map
I would divide the foundation into seven major domains:
┌───────────────────────────────────────────────────────┐
│                    PLATFORM CORE                      │
│                                                       │
│  Identity        Tenant         Product               │
│  & Access        Management     Catalog               │
│                                                       │
│  Commercial      Entitlement    Audit &               │
│  Management      Management     Platform Services     │
└───────────────────────────────────────────────────────┘
More specifically:
1. Identity & Access
2. Tenant / School Management
3. Product & Feature Catalog
4. Plans & Pricing
5. Subscription & Billing
6. Entitlement & Dependency
7. Audit & Platform Services
Phase 2 domains will plug into these.

2. Domain 1 — Identity & Access
This domain answers:
Who is this person and what are they allowed to do?
Core entities:
User
Role
Permission
RolePermission
UserRole
Session
Later we may add:
MFA
Login history
Password policy
API credentials
SSO
external identity providers

3. User
User represents an identity.
It should not inherently represent a school employee.
For example:
User
│
├── Identity
├── Authentication
├── Status
└── Memberships
A user may potentially belong to:
User
 ├── Platform
 ├── School A
 └── School B
This supports your requirement that platform/internal users may operate across multiple schools.

4. User vs School Membership
This is an important distinction.
Don't model:
User
 └── school_id
as the fundamental relationship.
Instead:
User
  │
  └── Membership
        │
        ├── School
        ├── Role
        ├── Status
        └── Scope
This gives us:
User
   │
   ├── Platform Membership
   │
   ├── School A Membership
   │      └── School Admin
   │
   └── School B Membership
          └── Support Role
This is much more extensible.

5. Role
A role is a collection of permissions.
Examples:
School Admin
Finance Admin
Attendance Admin
Teacher Admin
Support Admin
Role itself should not necessarily determine tenant.
Instead:
Membership
     ↓
Role Assignment
     ↓
Permissions
This allows the same role definition to potentially be reused.

6. Permission
Permission is the smallest meaningful authorization unit.
I'd use:
Resource + Action
For example:
student.view
student.create
student.update
student.delete
student.export
Later:
fee.collection.create
fee.collection.refund
fee.report.export
This gives us fine-grained control.

7. Permission Hierarchy
We should keep product hierarchy and permission hierarchy separate.
Product:
Student Management
    └── Student Admission
Permission:
student.admission.view
student.admission.create
student.admission.update
This separation is extremely useful.

8. Domain 2 — Tenant / School Management
This domain answers:
Which organizations use our platform and what is their lifecycle?
Core entities:
School
SchoolRequest
SchoolProfile
SchoolSettings
SchoolMembership
Potential future entities:
Campus
but Campus is deliberately excluded from V1.

9. School
School is the central tenant.
Conceptually:
School
│
├── Identity
├── Status
├── Profile
├── Settings
├── Memberships
├── Subscriptions
├── Entitlements
├── Feature Requests
└── Audit History
Every school-owned Phase 2 entity ultimately belongs to a School.
Example:
School
  │
  ├── Student
  ├── Teacher
  ├── Fee
  ├── Examination
  └── Transport

10. School Request
Because schools can request to join the platform:
School Request
│
├── Applicant
├── Requested school information
├── Requested plan/features
├── Review status
├── Reviewer
└── Decision
Lifecycle:
Submitted
   ↓
Under Review
   ↓
Approved ─────→ School Created
   │
   └──────────→ Rejected
This should remain separate from School.
A request is not yet a tenant.

11. School Lifecycle
The School itself:
Provisioning
    ↓
Active
    ↓
Suspended
    ↓
Archived
We may retain Requested and Approved in the onboarding workflow rather than treating them as permanent School states.
This distinction keeps lifecycle responsibilities cleaner.

12. Domain 3 — Product & Feature Catalog
This domain answers:
What functionality does our SaaS product offer?
Core entities:
Product
Feature
SubFeature
FeatureDependency
FeaturePermission
Depending on the final commercial model, we may not need a separate Product entity initially.

13. Feature
A Feature represents a major product capability.
Examples:
Student Management
Teacher Management
Attendance
Fees
Examination
Transportation
Library
A Feature has:
Feature
├── Identity
├── Description
├── Category
├── Status
├── Version
└── Configuration

14. Sub-feature
A feature can contain independently configurable capabilities.
Example:
Student Management
│
├── Student Profile
├── Admission
├── Documents
├── Import
└── Reports
Each sub-feature can have its own:
Status
Pricing
Dependencies
Entitlements
Permissions
depending on the commercial configuration.

15. Feature Dependency
This entity represents:
Feature A requires Feature B.
Example:
Examination
      │
      ├── requires → Students
      ├── requires → Classes
      └── requires → Subjects
A dependency should contain information such as:
Source
Dependency
Type
Status
For V1:
Hard dependency is sufficient.
We can introduce soft dependencies later if needed.

16. Domain 4 — Plans & Pricing
This domain answers:
What are we selling, and at what price?
Core entities:
Plan
PlanVersion
PlanFeature
Price
PricingRule
Discount
The exact pricing model still needs to evolve, but the architecture should support:
Monthly
Annual
Trial
Custom pricing
Add-ons
Discounts
Negotiated prices

17. Plan
A Plan is a commercial package.
Example:
Professional
It might contain:
Professional
│
├── Student Management
├── Teacher Management
├── Attendance
├── Examination
└── Reports
But a plan should not directly grant user permissions.
It grants commercial entitlement.

18. Plan Version
I strongly recommend introducing versioning for plans.
Example:
Professional v1
Professional v2
Professional v3
Why?
Suppose 50 schools purchased Professional in 2026.
You later change the Professional package in 2027.
You shouldn't unintentionally change what the existing customers purchased.
Therefore:
Plan
  ├── Version 1
  ├── Version 2
  └── Version 3
This is an important foundation for commercial stability.

19. Price
Price should be its own concept rather than a field like:
plan.price
because eventually we may have:
Plan
 ├── Monthly Price
 ├── Annual Price
 ├── Currency
 ├── Region
 ├── Promotional Price
 └── Custom Price
We don't have to implement all of these now, but the architecture should permit them.

20. Domain 5 — Subscription & Billing
This domain answers:
What has this school purchased and what is its commercial status?
Core entities:
Subscription
SubscriptionItem
Invoice
Payment
PaymentMethod
BillingCycle
Renewal

21. Subscription
A school can have multiple subscriptions/add-ons.
Example:
School A
│
├── Base Subscription
│      Professional
│
├── Add-on Subscription
│      Transportation
│
└── Add-on Subscription
       Advanced Exams
Each subscription has its own lifecycle.

22. Subscription Item
This is important for flexibility.
Instead of:
Subscription
  └── one feature
we can have:
Subscription
   │
   ├── Item: Professional Plan
   ├── Item: Transport Add-on
   └── Item: Advanced Exam Add-on
This makes the commercial model much more extensible.

23. Custom Pricing
A subscription item can have:
Standard Price
Custom Price
Discount
Final Price
Example:
Transport Add-on

Standard: ₹20,000
Negotiated: ₹15,000
Approved by: Super Admin
The agreed commercial value should be stored as a historical fact.

24. Domain 6 — Entitlement Management
This is arguably the most important domain in your platform.
It answers:
What is this school actually entitled to use?
Core entities:
Entitlement
EntitlementSource
EntitlementOverride
EntitlementHistory

25. Entitlement Sources
An entitlement can come from:
Plan
Add-on
Custom Contract
Super Admin Override
Example:
Attendance
│
├── Plan entitlement
├── Add-on entitlement
└── Custom grant
The system resolves these into the school's effective entitlement.

26. Effective Entitlement
This is a crucial concept.
We don't want every module asking:
"Does School A have Professional Plan?"
Instead:
"Does School A currently have entitlement to attendance.mark?"
The entitlement engine calculates the answer.
Conceptually:
Commercial Sources
       │
       ▼
Entitlement Resolver
       │
       ├── Plan
       ├── Add-ons
       ├── Overrides
       ├── Expiration
       └── Dependencies
       │
       ▼
Effective Entitlement

27. Entitlement vs Permission
This distinction should remain absolute.
Entitlement
School has access to:
Attendance
Permission
User can:
attendance.mark
Therefore:
School entitlement
       +
User permission
       =
Actual access

28. Domain 7 — Audit & Platform Services
Cross-cutting capabilities:
Audit
Notification
File Storage
Configuration
Search
Event / Messaging
These shouldn't belong to Student, Teacher, Fee, etc.

29. Audit
Audit records should reference:
Actor
Tenant
Action
Entity
Entity ID
Timestamp
Before
After
Reason
Example:
Actor:
Super Admin

Tenant:
School A

Action:
FEATURE_ENABLED

Entity:
Attendance

Previous:
Disabled

New:
Enabled

Reason:
Approved add-on

30. Notification
Notification should become a reusable platform service.
Examples:
Subscription expiring
Payment failed
Feature approved
Feature rejected
School request approved
User invited
Password reset
Later Phase 2 modules can use the same notification infrastructure.

31. The Core Relationship Model
Putting everything together:
                         USER
                          │
                    Membership
                          │
                 ┌────────┴────────┐
                 │                 │
              Platform           School
               Scope              Scope
                                  │
                                  ▼
                               SCHOOL
                                  │
             ┌────────────────────┼───────────────────┐
             │                    │                   │
             ▼                    ▼                   ▼
       SUBSCRIPTIONS        ENTITLEMENTS          USERS
             │                    │                   │
             ▼                    ▼                   ▼
        PLAN / ADDONS         FEATURES             ROLES
             │                    │                   │
             ▼                    ▼                   ▼
          PRICING           SUB-FEATURES         PERMISSIONS
                                  │
                                  ▼
                            DEPENDENCIES
This is the core of the platform.

32. The Most Important Relationship
The ultimate access chain becomes:
USER
 ↓
MEMBERSHIP
 ↓
SCHOOL
 ↓
SUBSCRIPTION
 ↓
ENTITLEMENT
 ↓
FEATURE
 ↓
SUB-FEATURE
 ↓
PERMISSION
 ↓
ACTION
This is the architecture we should preserve as we move into implementation.

33. Example: Future Attendance Module
Let's test the architecture.
Suppose we add Attendance in Phase 2.
Attendance registers:
Feature:
attendance

Sub-features:
attendance.mark
attendance.edit
attendance.report
attendance.export
Dependencies:
attendance
 → students
 → classes
Permissions:
attendance.view
attendance.mark
attendance.edit
attendance.delete
attendance.export
Pricing:
Attendance Add-on
₹X/month
The existing platform doesn't need to change its fundamental architecture.
That's exactly the extensibility we're aiming for.

34. What We Should NOT Define Yet
At this stage, I would intentionally avoid:
Student tables
Teacher tables
Fee transaction schema
Exam schema
Transport schema
Attendance schema
Detailed school operational schema
Those belong to their domains.
We only need the contracts that allow those domains to plug into the foundation.

35. Next Design Step — Tenant Architecture
The next area needs particularly careful design because everything depends on it:
Multi-tenancy + data isolation
We'll need to decide:
Tenant identification
Tenant context
Tenant-aware APIs
Data ownership
Cross-tenant platform access
School-user access
Platform-user access
Multi-school memberships
Database isolation strategy
File/document isolation
Cache isolation
Search isolation
Background-job tenant context
Audit tenant context
Future campus compatibility
I recommend we design that before the detailed RBAC and entitlement engine, because RBAC and entitlements both depend on knowing the scope in which the request is being evaluated.
