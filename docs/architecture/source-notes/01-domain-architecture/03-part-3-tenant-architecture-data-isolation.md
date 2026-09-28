<!-- Source: Apple Notes, folder 'Notes' -->
# Part 3 — Tenant Architecture & Data Isolation

The tenant boundary should be treated as a security boundary, not merely a database field.
For V1:
One school = one tenant. One user request executes in exactly one tenant context unless it is an explicitly authorized platform-level operation.
3.1 Tenant Context
Every authenticated request should resolve:
USER
 ↓
MEMBERSHIP
 ↓
TENANT CONTEXT
 ↓
AUTHORIZATION
 ↓
BUSINESS OPERATION
For a normal school user:
User
 └── Membership
      └── School A
           ↓
      TenantContext = School A
The application should not trust something like:
{
  "schoolId": "school-b"
}
sent by the client to determine ownership.
Instead, the backend derives the tenant from the authenticated user's membership/session and the explicitly selected context where applicable.

3.2 Two Types of Users
School-scoped user
Example:
School Admin
Teacher
Accountant
Receptionist
Sub Admin
Their request has a fixed school context:
User
 ↓
Membership(School A)
 ↓
TenantContext(School A)
They cannot switch to School B.

Platform-scoped user
Example:
Super Admin
Platform Admin
Billing Admin
Support Admin
Sales Admin
They may have access to multiple schools.
But this should not mean that every platform user automatically operates across every tenant.
Instead:
Platform User
 ↓
Platform Permission
 ↓
Optional Tenant Scope
 ↓
Selected Tenant
For example:
Billing Admin
 ├── School A
 ├── School B
 └── School C
A platform operation should explicitly establish:
TenantContext = School B
before touching School B's tenant data.
This makes accidental cross-school access much harder.

3.3 Global vs Tenant-Owned Data
We should classify data into three categories.
A. Platform-global
Not owned by any school.
Feature
SubFeature
Permission
Platform Role
Plan
Plan Version
Feature Dependency
Pricing Catalog
Example:
Feature: Student Management
exists once in the platform catalog.

B. Tenant-owned
Belongs to exactly one school.
School Profile
School Settings
School Memberships
Students
Teachers
Classes
Fees
Exams
Attendance
Transport
Future domain modules will primarily live here.
Conceptually:
Tenant A
 ├── Students
 ├── Teachers
 ├── Classes
 └── Fees

Tenant B
 ├── Students
 ├── Teachers
 ├── Classes
 └── Fees

C. Tenant-scoped commercial data
The platform owns the commercial system, but records belong to a specific tenant.
Subscription
Subscription Items
Invoices
Payments
Entitlements
Feature Requests
Custom Pricing
Discounts
For example:
Subscription #123
tenant_id = School A
This distinction will become important later when designing the database.

3.4 Recommended V1 Database Strategy
There are three common approaches.
￼
For the initial SaaS architecture, I would design around:
Shared database + explicit tenant ownership + centralized tenant-aware data access.
This gives us a practical starting point without preventing stronger isolation later.
For tenant-owned records:
students
---------
id
tenant_id
...
teachers
---------
id
tenant_id
...
classes
---------
id
tenant_id
...
But simply adding tenant_id is not sufficient.
The application must enforce it consistently.

3.5 Never Rely on Developers Remembering tenant_id
A dangerous pattern would be:
repository.findStudent(studentId)
and hoping the developer remembers to verify ownership.
Prefer:
studentRepository.findByTenant(
    tenantContext,
    studentId
)
or have the repository/data-access layer automatically apply tenant scope.
Conceptually:
TenantContext
      ↓
Tenant-aware Repository
      ↓
Database Query
      ↓
WHERE tenant_id = currentTenant
So a query effectively becomes:
SELECT *
FROM students
WHERE id = ?
AND tenant_id = ?;
rather than:
SELECT *
FROM students
WHERE id = ?;
The second pattern is a potential cross-tenant security vulnerability.

3.6 Tenant ID Should Be Everywhere It Needs to Be
For tenant-owned entities:
tenant_id
should generally be a first-class field.
For example:
Student
 ├── id
 ├── tenant_id
 ├── admission_no
 ├── name
 └── ...
The same principle applies to future modules:
Teacher
Class
Subject
Attendance
Fee
Exam
Transport
Library
This also makes tenant-specific reporting and data lifecycle management much easier.

3.7 Cross-Tenant References Must Be Prevented
Suppose:
Student A → School A
Class X   → School B
The system must never allow:
Student A → Class X
even if the IDs happen to be valid.
Business relationships should respect the same tenant boundary:
Student
   │
   └── tenant_id = A
          ↓
Class
   │
   └── tenant_id = A
The system should validate this at the service/data layer.
This becomes especially important once we build:
Student → Class
Teacher → Class
Student → Fee Account
Student → Exam
Student → Transport Route

3.8 Tenant Context in APIs
The API architecture should conceptually look like:
HTTP Request
     ↓
Authentication
     ↓
Identify User
     ↓
Resolve Membership
     ↓
Resolve Tenant Context
     ↓
Authorization
     ↓
Entitlement Check
     ↓
Domain Service
     ↓
Tenant-aware Data Access
For example:
GET /students
doesn't mean:
Give me all students.
It means:
Give me students belonging to the currently authorized tenant context.

3.9 Platform APIs Are Different
Some operations are genuinely platform-wide:
Create Feature
Create Plan
Change Pricing
Create Platform Role
Manage Feature Dependencies
These don't need a school tenant.
So we should distinguish:
PLATFORM CONTEXT
from:
TENANT CONTEXT
A platform operation should not accidentally inherit a random school context.
Conceptually:
Platform operation
 → TenantContext = NONE

School operation
 → TenantContext = School A
This is a useful safety rule:
No implicit tenant for platform operations. No missing tenant for tenant operations.

3.10 Background Jobs
This is frequently overlooked.
Suppose subscription expiry generates a background job:
SubscriptionExpired
The worker must know which school it belongs to.
Instead of:
Job
 └── subscriptionId
prefer the conceptual model:
Job
 ├── tenantId
 └── entityId
Example:
Job
 ├── tenant_id = School A
 ├── type = SubscriptionExpired
 └── subscription_id = 123
The worker establishes tenant context before executing.
This applies to:
Emails
Notifications
Reports
Imports
Exports
Scheduled jobs
Payment processing
Data processing

3.11 Cache Isolation
Caching must also understand tenancy.
Bad:
cache["students"]
Better:
cache["tenant:A:students"]
cache["tenant:B:students"]
Likewise:
tenant:A:permissions
tenant:B:permissions
tenant:A:dashboard
tenant:B:dashboard
Otherwise a perfectly valid cache can become a cross-tenant data leak.

3.12 File Storage Isolation
Documents should also have tenant boundaries.
Instead of:
/uploads/student123.pdf
use a conceptual structure such as:
/tenants/{tenantId}/students/{studentId}/documents/{fileId}
Later:
/tenants/{tenantId}/teachers/...
/tenants/{tenantId}/fees/...
/tenants/{tenantId}/exams/...
The storage access layer should validate tenant ownership before generating a download/access URL.

3.13 Search and Reporting
Search indexes must also preserve tenant isolation.
Conceptually:
Search Index
 ├── tenant_id
 ├── entity_type
 ├── entity_id
 └── searchable_data
Every search query must include tenant scope.
Reports are similar.
A school administrator asking:
"Show all students"
must never reach another school's records through a reporting query.
Platform reporting is different:
Platform Analytics
 ├── School A
 ├── School B
 ├── School C
 └── ...
That requires explicit platform permission.

3.14 Audit Must Always Capture Tenant
An audit record should identify the school context whenever applicable:
Audit
 ├── id
 ├── actor_user_id
 ├── tenant_id
 ├── action
 ├── entity_type
 ├── entity_id
 ├── before
 ├── after
 ├── reason
 └── timestamp
Example:
Actor: Platform Admin
Tenant: School A
Action: FEATURE_ENABLED
Feature: Transportation
Even though the actor is a platform user, we know exactly which school was affected.
For platform-global operations:
Tenant = NULL
Scope = PLATFORM

3.15 School Switching
A platform administrator may eventually see:
Schools
 ├── Sunrise Public School
 ├── Delhi Public School
 └── ABC Academy
When they select a school:
Platform User
      ↓
Select School A
      ↓
TenantContext = School A
      ↓
Operate within School A
The UI selection is only a convenience.
The backend must still verify:
Does this platform user have permission
to operate on School A?
So the client cannot simply change:
tenant_id = School B
and gain access.

3.16 Tenant Isolation Across the Entire Stack
The important part is that tenancy isn't only a database concern.
It should exist across:
                 TENANT BOUNDARY
                       │
       ┌───────────────┼────────────────┐
       ↓               ↓                ↓
      API          Background Jobs     Events
       ↓               ↓                ↓
   Services       Tenant Context    Tenant Context
       ↓               ↓                ↓
    Cache          File Storage       Search
       ↓               ↓                ↓
                  Database
Every layer understands tenant ownership where applicable.

3.17 Future Multi-Campus Compatibility
We are not implementing campuses in V1.
But we should avoid architectural decisions that make campuses impossible later.
Current:
School
 ├── Users
 ├── Students
 ├── Teachers
 └── Classes
Future:
School
 ├── Campus A
 │    ├── Students
 │    ├── Teachers
 │    └── Classes
 │
 └── Campus B
      ├── Students
      ├── Teachers
      └── Classes
So conceptually:
Tenant
  ↓
Campus (future)
  ↓
Domain Data
But we should not add campus_id everywhere right now merely for theoretical future-proofing.
Instead, establish the boundary:
Tenant
now, and make the domain architecture capable of introducing:
Campus
later.
That avoids premature complexity.

3.18 The Tenant Ownership Rule
This should become one of the fundamental architecture rules:
Every tenant-owned entity must have an unambiguous owner tenant, and every operation against that entity must execute within an authorized tenant context.
This applies to:
School settings
Users
Students
Teachers
Classes
Fees
Exams
Attendance
Transport
Files
Reports
Notifications
Subscriptions
Entitlements
with the appropriate distinction between tenant-owned and platform-global entities.

3.19 Resulting Architecture
The architecture is now becoming:
                    PLATFORM
                       │
        ┌──────────────┼───────────────┐
        │              │               │
   Identity       Product/Billing    Platform
   & Access       & Entitlement      Services
        │              │               │
        └──────────────┼───────────────┘
                       │
                TENANT CONTEXT
                       │
          ┌────────────┴────────────┐
          │                         │
      SCHOOL A                  SCHOOL B
          │                         │
     Domain Modules            Domain Modules
          │                         │
    ┌─────┼─────┐             ┌─────┼─────┐
 Students Teachers Fees      Students Teachers Fees
The critical boundary is:
                    PLATFORM
                       │
                Authorization
                       │
                Tenant Context
                       │
              ┌────────┴────────┐
              │                 │
           SCHOOL A          SCHOOL B
              │                 │
        isolated data      isolated data
This gives us a stable foundation for the next layer.
Next: RBAC + Permission Architecture
The next design should define how roles, permissions, feature entitlements, sub-feature access, action-level permissions, platform roles, School Admins, and Sub Admins work together.
That is where we should resolve the exact difference between:
Feature entitlement
        vs
Permission
        vs
Role
        vs
User assignment
        vs
Tenant scope
before we design the actual domain modules.
