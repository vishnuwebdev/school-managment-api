<!-- Source: Apple Notes, folder 'Core Database design system' -->
# Master V1 Architecture Specification — Consolidated Foundation

This consolidates the architecture established through Parts 1–42 into one implementation-oriented reference. It intentionally stops short of generating every SQL table and endpoint.

1. System Goal
The platform is a multi-tenant school-management SaaS.
Platform
 ├── Commercial / Subscription
 ├── Feature / Entitlement
 ├── Identity / RBAC
 ├── Tenant Management
 ├── Audit
 └── Shared Platform Services
          │
          ↓
       Schools
          │
          ├── Academic
          ├── Students
          ├── Teachers
          ├── Attendance
          ├── Examination
          ├── Fees
          ├── Transportation
          ├── Timetable
          ├── Library
          ├── Leave
          ├── Communication
          └── Parent Portal
V1 architecture:
modular monolith,
shared database,
explicit tenant isolation,
domain-owned business logic,
centralized authorization/entitlement,
asynchronous events through an outbox,
external integrations behind adapters.

2. Architectural Layers
┌───────────────────────────────────────────┐
│                API / UI                   │
├───────────────────────────────────────────┤
│        Application / Use Cases             │
├───────────────────────────────────────────┤
│             Domain Modules                │
├───────────────────────────────────────────┤
│       Repositories / Persistence           │
├───────────────────────────────────────────┤
│      Shared Platform Infrastructure        │
└───────────────────────────────────────────┘
Controller
Handles:
authentication extraction,
request validation,
HTTP mapping,
response formatting,
error mapping.
It should not contain business rules.
Application Service
Coordinates:
use case,
authorization,
domain operations,
transaction,
event/audit generation.
Domain
Owns:
business rules,
lifecycle transitions,
calculations,
invariants,
domain decisions.
Repository
Owns:
persistence,
tenant filtering,
entity retrieval,
database queries.

3. Core Access Model
Every protected school operation conceptually follows:
USER
 ↓
AUTHENTICATION
 ↓
MEMBERSHIP
 ↓
TENANT CONTEXT
 ↓
ROLE ASSIGNMENTS
 ↓
PERMISSIONS
 ↓
SCOPE
 ↓
SCHOOL LIFECYCLE
 ↓
SUBSCRIPTION / ENTITLEMENT
 ↓
DOMAIN RULES
 ↓
ALLOW / DENY
The complete authorization condition is:
Authenticated
AND Tenant Access
AND School Operationally Accessible
AND Valid Entitlement
AND Feature Enabled
AND Sub-feature Enabled
AND Permission Granted
AND Scope Allows Action
AND Domain Rules Pass

4. Tenant Model
V1:
Tenant = School
Future-compatible structure:
Tenant
   ↓
Campus
   ↓
Domain Data
V1 does not need a Campus entity unless actual requirements emerge.

5. Identity Model
Never use:
User.school_id
Instead:
User
 ↓
Membership
 ↓
School
A user may therefore belong to multiple schools where appropriate.
Normal school users typically have one active school context.
Platform users may have:
ALL_TENANTS
SELECTED_TENANTS
NO_TENANT
scope.

6. RBAC Model
User
 ↓
Membership
 ↓
Role Assignment
 ↓
Role
 ↓
Permissions
Permissions are action-level contracts.
Examples:
student.view
student.create
student.update
student.archive

fee.demand.create
fee.payment.verify
fee.refund.approve

exam.mark.enter
exam.result.publish
Roles are bundles of permissions.
Roles can be:
system-defined,
tenant-defined,
configurable,
disabled/archived.

7. Scope Model
Permission alone is insufficient.
Examples:
ALL_TENANT
ASSIGNED_CLASS
ASSIGNED_SECTION
ASSIGNED_SUBJECT
OWN_RECORD
SELECTED_RESOURCE
Example:
Teacher
+ attendance.view
+ ASSIGNED_SECTION
does not mean the teacher can view attendance for every section.

8. Entitlement Model
Entitlement answers:
Is this school commercially/administratively entitled to use this capability?
Sources:
PLAN
ADD_ON
CUSTOM_CONTRACT
ADMIN_OVERRIDE
Effective state:
Plan
+
Add-ons
+
Overrides
+
Validity
+
Subscription State
+
Dependencies
        ↓
Entitlement Resolver
        ↓
Effective Capabilities
Domain code should ask:
Can tenant perform capability X?
not:
Does tenant have Plan Gold?

9. Feature Dependency
Dependencies are data-driven.
Example:
Parent Portal
   ↓
Attendance Portal
   ↓
Attendance
Disabling a dependency must:
identify impacted features,
show the impact,
require confirmation,
update entitlement consistently.
Never silently cascade.
Disabling a feature never deletes its data.

10. Commercial Model
Plan
 ↓
Plan Version
 ↓
Subscription
 ↓
Subscription Items
 ↓
Invoice
 ↓
Payment
 ↓
Entitlement
Supports:
monthly,
annual,
free trial,
grace/recovery,
auto-renew,
offline payment,
custom pricing,
add-ons,
negotiated contracts.
Historical prices remain immutable.

11. Subscription Lifecycle
PENDING
 ↓
TRIAL
 ↓
ACTIVE
 ↓
PAST_DUE
 ↓
EXPIRED
 ↓
CANCELLED
Cancellation and expiration remain distinct.
After expiry:
0–30 days
→ School Admin can log in
→ operational features restricted
→ renewal/billing/support available

After 30 days
→ normal login locked
→ data preserved

12. School Lifecycle
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
ARCHIVED
School archival is not physical deletion.

13. Provisioning
Provisioning initializes:
School
Default Roles
Initial Admin Invitation
Settings
Subscription / Entitlement
Storage Namespace
Audit Context
Provisioning failure remains retryable.
It must not produce a partially active school.

14. Domain Ownership Matrix
￼
15. Core Domain Dependency Graph
Academic
 ├──→ Student
 ├──→ Teacher
 ├──→ Attendance
 ├──→ Examination
 ├──→ Fees
 ├──→ Transportation
 └──→ Timetable

Student
 ├──→ Attendance
 ├──→ Examination
 ├──→ Fees
 ├──→ Transportation
 └──→ Library

Teacher
 ├──→ Attendance
 ├──→ Examination
 └──→ Timetable

Leave
 └──→ Timetable availability

Transportation
 └──→ Fees charge applicability

Library
 └──→ Fees financial obligation

Operational Domains
 ├──→ Communication
 └──→ Reporting

Operational Domains
 └──→ Integrations
Avoid circular ownership.

16. Student Model
Core:
Student
 ├── Admission
 ├── Enrollment
 ├── Guardians
 └── Documents
Student and Enrollment are separate.
Historical enrollment is preserved.
Student
 ↓
Enrollment
 ↓
Academic Year
 ↓
Class
 ↓
Section

17. Academic Model
Academic Year
 ├── Class
 │    └── Section
 └── Subject Offering
A Subject Offering represents:
This subject exists for this academic context.
It later connects to:
teaching,
timetable,
attendance,
examination.

18. Teacher Model
Teacher
 ├── Employment information
 ├── Qualifications
 ├── Documents
 └── Teaching Assignments
Teacher != User.
Optional:
Teacher
 ↓
User Account
Teaching Assignment connects teacher to Subject Offering.

19. Attendance Model
Attendance Session
 ↓
Attendance Record
 ↓
Student + Enrollment
Supports:
daily attendance,
subject/period attendance,
configurable statuses,
corrections,
approval/finalization.
Attendance does not require Timetable for daily attendance.

20. Examination Model
Assessment Period
 ↓
Assessment
 ↓
Assessment Paper
 ↓
Components
 ↓
Student Assessment
 ↓
Mark Entries
 ↓
Paper Result
 ↓
Result
 ↓
Publication
Raw marks remain separate from derived results.
Published results should be historically reproducible.

21. Fees Model
The crucial financial distinction:
Fee Structure
 ↓
Student Fee Assignment
 ↓
Fee Demand
 ↓
Payment
 ↓
Allocation
 ↓
Receipt
Payment does not equal Demand.
One payment can allocate across multiple demands.
Refunds never delete the original payment.

22. Transportation Model
Route
 ↓
Route Version
 ↓
Route Stops

Transport Service
 ↓
Trip
 ├── Vehicle
 └── Driver

Student
 ↓
Transport Assignment
 ↓
Route Version / Stops
Route changes create versions.
Historical trips preserve the route version used.

23. Timetable Model
Timetable
 ↓
Timetable Entries
 ↓
Teacher / Subject / Class / Section / Room
Operational exceptions:
Timetable Entry
 ↓
Override / Substitution
Published timetable versions remain historically preserved.

24. Library Model
Resource
 ↓
Physical Copies
 ↓
Loans
 ↓
Returns
Reservations:
Reservation → Resource
Loan → Copy
Library owns fines.
Fees owns financial collection.

25. Leave Model
Leave Type
 ↓
Leave Policy
 ↓
Allocation
 ↓
Leave Request
 ↓
Approval
 ↓
Leave Period
 ↓
Availability
 ↓
Timetable
Leave does not directly modify timetable entries.
Leave does not equal staff attendance.

26. Communication Model
Domain Event
 ↓
Notification Request
 ↓
Recipient Resolution
 ↓
Delivery
 ↓
Provider
Templates are versioned.
Delivery is asynchronous.
Communication failures do not roll back business transactions.

27. Parent Portal
Guardian
 ↓
Portal Access
 ↓
Guardian Scope
 ↓
Student Relationship
 ↓
Domain Data
Portal is downstream.
It does not own:
students,
fees,
attendance,
examination,
library,
transport.
Portal requests go back to the owning domain.

28. Reporting
Operational Data
 ↓
Events / Read Models
 ↓
Reports
 ↓
Dashboards
 ↓
Exports
V1 does not require a full data warehouse.
Complex reporting can use dedicated read models.

29. Integrations
Internal Domain
 ↓
Integration Adapter
 ↓
External Provider
External IDs are stored separately.
Webhooks are:
authenticated,
validated,
deduplicated,
idempotent,
translated into internal operations.

30. Database Strategy
V1:
One Application
+
One Shared Database
+
tenant_id
Not:
Database per school
The architecture does not prevent future physical isolation.

31. Core Platform Tables
Conceptually:
users
memberships
roles
permissions
role_assignments
invitations

schools
school_settings

plans
plan_versions
features
feature_dependencies
subscriptions
subscription_items
invoices
payments
entitlements

audit_records
outbox_events
jobs
files
Additional configuration tables exist within domains where appropriate.

32. Tenant Database Rule
Every tenant-owned table should contain:
tenant_id
Repository queries should automatically apply tenant scope.
Cross-tenant references should be blocked through application validation and, where practical, database constraints.

33. Database Integrity Layers
DATABASE
 ├── NOT NULL
 ├── Foreign Keys
 ├── Unique Constraints
 ├── Check Constraints
 └── Indexes

APPLICATION
 ├── Tenant Context
 ├── Authorization
 ├── Validation
 └── Transaction Coordination

DOMAIN
 ├── Business Rules
 ├── State Transitions
 ├── Calculations
 └── Cross-entity Decisions

34. Transaction Model
A normal business operation:
Request
 ↓
Auth
 ↓
Tenant
 ↓
Authorization
 ↓
Entitlement
 ↓
Domain Validation
 ↓
BEGIN
 ↓
Business Changes
 ↓
Audit
 ↓
Outbox Event
 ↓
COMMIT
 ↓
Async Side Effects

35. Concurrency Model
Use optimistic concurrency for normal administrative editing:
version
Use transactional locking for resource/financial contention:
Library Copy
Fee Allocation
Payment
Leave Balance
Transport Capacity

36. Idempotency
Required for operations such as:
Payments
Payment Webhooks
Bulk Imports
Bulk Attendance
Mark Submission
Invoice Generation
Notification Delivery
External Synchronization
Repeated requests must not create duplicate business effects.

37. Outbox
Business transaction:
Business Data
+
Audit
+
Outbox Event
all commit together.
Then:
Outbox
 ↓
Worker
 ↓
Consumers
Events are treated as at-least-once delivery.
Consumers must be idempotent.

38. Audit
Audit record should contain:
audit_id
tenant_id
actor_id
actor_type
action
entity_type
entity_id
before
after
reason
request_id
correlation_id
created_at
Audit is distinct from:
domain history,
events,
application logs,
security logs.

39. Files
Common File Service:
Domain
 ↓
file_id
 ↓
File Metadata
 ↓
Private Storage
Storage is tenant-scoped.
Private files require authorized access.

40. Notifications
Business domains should emit facts:
FeeDemandIssued
ResultPublished
BookOverdue
LeaveApproved
Communication decides:
recipient
channel
template
timing
provider

41. Background Jobs
Every important job carries:
job_id
tenant_id
job_type
actor_id where applicable
payload
status
attempt_count
correlation_id
timestamps
A background worker must establish tenant context before accessing tenant data.

42. Search and Cache
Both must be tenant-aware.
Search:
tenant_id + entity
Cache:
tenant:{tenant_id}:...
Never allow a shared cache key to cross tenant boundaries.

43. API Architecture
Base path:
/api/v1
Example:
/api/v1/students
/api/v1/enrollments
/api/v1/attendance/sessions
/api/v1/exams
/api/v1/fees/demands
/api/v1/library/loans
Version only for breaking API changes.

44. API Request Pipeline
HTTP
 ↓
Authentication
 ↓
Tenant Context
 ↓
School Lifecycle
 ↓
Authorization
 ↓
Entitlement
 ↓
Application Service
 ↓
Domain Rules
 ↓
Repository
 ↓
Audit/Event
 ↓
Response

45. Standard Errors
Use stable machine-readable errors:
AUTHENTICATION_REQUIRED
TENANT_ACCESS_DENIED
PERMISSION_DENIED
ENTITLEMENT_REQUIRED
FEATURE_DISABLED
RESOURCE_NOT_FOUND
VALIDATION_ERROR
BUSINESS_RULE_VIOLATION
CONFLICT
SUBSCRIPTION_EXPIRED
SCHOOL_SUSPENDED
RATE_LIMITED
SYSTEM_ERROR
The frontend should not have to parse arbitrary human messages to understand failures.

46. Security Model
Security principles:
Defense in depth
Fail closed
Least privilege
Tenant isolation
Audit sensitive operations
Private files
Secure password hashing
Revocable sessions
MFA for privileged platform accounts
No sensitive credentials in logs
UI hiding is never authorization.

47. Platform Roles
Initial platform roles:
Super Admin
Platform Admin
Billing Admin
Support Admin
Sales Admin
Operations Admin
These are RBAC roles, not hardcoded application branches.
Avoid:
if role == "SuperAdmin"
Prefer:
hasPermission(...)

48. School Roles
A typical school installation may have:
School Admin
Sub Admin
Teacher
Accountant
Librarian
Transport Coordinator
Parent/Guardian
But these are configurable role bundles.
The system should not hardcode every role as a special application type.

49. School Admin
School Admin can have broad tenant permissions but is still constrained by:
Entitlement
+
Feature State
+
Permission
Therefore:
School Admin
does not mean:
Automatically allowed to use every future module

50. Sensitive Operations
Potential future controls:
Permission
+
Reason
+
Re-authentication
+
Second Approval
Examples:
fee write-off,
payment verification,
pricing override,
feature override,
permission escalation,
fine waiver.
V1 should architecturally support this without implementing every advanced control immediately.

51. What Is Deliberately Deferred
To avoid premature complexity:
Multi-campus operational model
Full HR
Payroll
Accounting / GL
Advanced workflow engine
Generic report builder
Full data warehouse
AI analytics
Automatic timetable optimization
GPS streaming
RFID
Digital library/DRM
Advanced procurement
Complex multi-level approval engine
Database-per-tenant isolation
The architecture should not prevent these later.

52. Implementation Principle
The next implementation should proceed from:
Foundation
 ↓
Identity / Tenant / RBAC
 ↓
Commercial / Entitlement
 ↓
Academic + Student + Teacher
 ↓
Operational Domains
 ↓
Portal / Communication
 ↓
Reporting / Integrations
rather than implementing isolated screens module-by-module.

53. Recommended Implementation Layers
Phase A — Platform Foundation
Database foundation
Tenant context
Users
Memberships
Authentication
RBAC
Audit
Configuration
Files
Jobs
Outbox
Phase B — Commercial
Feature catalog
Plans
Plan versions
Subscriptions
Subscription items
Invoices
Payments
Entitlements
Phase C — Academic Core
Academic Years
Classes
Sections
Subjects
Students
Admissions
Enrollment
Guardians
Teachers
Teaching Assignments
Phase D — School Operations
Attendance
Examination
Fees
Transportation
Timetable
Library
Leave
Phase E — Access & Communication
Communication
Parent Portal
Phase F — Intelligence & External Systems
Reporting
Integrations
Advanced exports

54. Implementation Order Within a Domain
For each domain:
1. Domain contract
2. Entities
3. State/lifecycle
4. Business rules
5. Permissions
6. Database migration
7. Repository
8. Application service
9. API
10. Events
11. Audit
12. Tests
13. Reporting/read models
This keeps domain behavior ahead of UI implementation.

55. Testing Strategy
Every domain should test at least:
Tenant isolation
School A cannot access School B data.
Authorization
Permission absent → denied.
Scope
Teacher assigned to Section A
cannot access Section B.
Entitlement
Feature disabled → operation denied.
Lifecycle
Invalid transition → rejected.
Concurrency
Two conflicting operations
→ only valid result survives.
Idempotency
Same request twice
→ one business effect.
Historical integrity
Configuration change
→ old transactions remain correct.

56. The Most Important Engineering Rule
For every new requirement, ask:
Which domain owns this business rule?
Not:
Which screen displays this information?
For example:
Parent Portal displays fee
→ Fees still owns fee.

Dashboard displays attendance
→ Attendance still owns attendance.

Library creates fine
→ Library owns fine.

Fees collects fine
→ Fees owns payment.
This one rule will prevent a large amount of architectural coupling.

57. Final Architecture
                         ┌──────────────────────┐
                         │       PLATFORM       │
                         │                      │
                         │ Identity / RBAC       │
                         │ Tenant Management     │
                         │ Commercial/Billing    │
                         │ Feature/Entitlement  │
                         │ Configuration         │
                         │ Audit                 │
                         │ Files                 │
                         │ Jobs / Outbox         │
                         └──────────┬───────────┘
                                    │
                                    ↓
                         ┌──────────────────────┐
                         │       SCHOOL         │
                         └──────────┬───────────┘
                                    │
             ┌──────────────────────┼──────────────────────┐
             ↓                      ↓                      ↓
        Academic/People        Operations             Access
             │                      │                      │
     ┌───────┼────────┐     ┌───────┼────────┐      ┌─────┴─────┐
     │       │        │     │       │        │      │           │
 Student  Teacher  Academic Fees  Exam  Attendance Portal  Communication
     │       │                  │
     └───────┴──────────────────┘
             │
      ┌──────┼──────────────┐
      ↓      ↓              ↓
 Transport Timetable      Library
             │
             ↓
           Leave

Operational Domains
        │
        ├────────────→ Reporting
        │
        ├────────────→ Communication
        │
        └────────────→ Integrations

58. Foundation Decision
The architecture is now sufficiently defined to move from architecture design into implementation design.
The next artifact should therefore be a V1 Technical Specification, beginning with:
1. Technology stack assumptions
2. Repository/project structure
3. Exact database schema conventions
4. Core platform schema
5. Tenant/RBAC schema
6. Feature/entitlement schema
7. API contracts
8. Authentication/session design
9. Transaction boundaries
10. Event/outbox implementation
11. Domain-by-domain implementation contracts
12. Testing strategy
13. Deployment/environment structure
The important constraint remains: do not generate the entire database or API implementation in one pass. Build the foundation first, validate it, then implement each domain against the same contracts.
