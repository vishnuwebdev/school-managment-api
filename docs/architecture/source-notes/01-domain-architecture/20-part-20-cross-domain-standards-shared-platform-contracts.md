<!-- Source: Apple Notes, folder 'Notes' -->
# Part 20 — Cross-Domain Standards & Shared Platform Contracts

We have now designed enough domains that a common set of rules is necessary.
Without this layer, future modules could independently invent:
Student status rules
Teacher status rules
Fee status rules
Attendance status rules
Exam status rules
and eventually the platform would become inconsistent.
The goal of Part 20 is to establish shared conventions without turning everything into one giant generic framework.

20.1 The Core Principle
Every domain should follow the same overall shape:
Domain
│
├── Domain Entities
├── Value Objects / Config
├── Lifecycle
├── Business Rules
├── Application Services
├── Authorization
├── Tenant Boundary
├── Persistence
├── Events
├── Audit
├── Files
└── Reports
But each domain remains responsible for its own business rules.

20.2 Standard Domain Layering
Each module should conceptually have:
API / Controller
       ↓
Application Service
       ↓
Domain Logic
       ↓
Repository / Persistence
Cross-cutting services sit around it:
Authentication
Authorization
Tenant Context
Entitlement
Audit
Events
Notifications
Files
Configuration

20.3 Controller Responsibility
Controllers should handle:
HTTP
Request parsing
Input DTO validation
Authentication context
Response mapping
HTTP errors
Controllers should not contain business logic.
Avoid:
if fee > 0:
    ...
if role == admin:
    ...
if subscription == ...
inside controllers.

20.4 Application Service Responsibility
Application services coordinate use cases.
Example:
CreateStudent
UpdateTeacher
SubmitAttendance
PublishExamResult
CollectFee
AssignTransport
They coordinate:
Authorization
Entitlement
Domain rules
Repositories
Transactions
Audit
Events

20.5 Domain Logic Responsibility
Domain logic owns rules such as:
A student cannot have two active enrollments
for the same academic context.

A payment cannot be allocated above
the permitted outstanding amount.

Marks cannot exceed maximum marks.

A vehicle cannot exceed configured capacity.

A published result requires controlled correction.
These rules should not depend on HTTP.

20.6 Repository Responsibility
Repositories/data-access layers should enforce tenant boundaries.
Conceptually:
StudentRepository
      ↓
Current Tenant Context
      ↓
Only Student records for that tenant
A developer shouldn't have to remember:
WHERE tenant_id = ?
on every query.
The architecture should make the secure path the default path.

20.7 Entity IDs
Use stable internal identifiers.
Conceptually:
Student
id = internal identifier
student_number = business identifier
Same pattern:
Teacher
teacher_id
teacher_number
School
school_id
school_code
Business identifiers should not become the primary relationship mechanism throughout the system.

20.8 UUID / Identifier Strategy
The exact identifier technology can remain an implementation decision.
The architectural requirement is:
unique,
stable,
non-semantic,
safe for distributed/background operations,
not dependent on business numbering.
Business numbers remain separate.

20.9 Timestamps
Important entities should use explicit timestamps.
Common fields:
created_at
updated_at
Where lifecycle matters:
activated_at
archived_at
completed_at
cancelled_at
Do not overload updated_at to represent business events.

20.10 Actor Information
Where an action matters, record the actor.
Examples:
created_by
updated_by
approved_by
cancelled_by
published_by
But don't add dozens of actor fields to every table without a business reason.
Audit remains the authoritative detailed history.

20.11 Soft Delete vs Archive
We should distinguish:
Delete
Archive
Cancel
Deactivate
They are not interchangeable.
Examples:
Student:
Archive
Exam:
Cancel
Teacher:
Deactivate / Archive
Vehicle:
Retire
Fee:
Cancel
The domain decides the appropriate lifecycle operation.

20.12 Avoid Generic status Without Semantics
A field such as:
status = 7
is not sufficient architecture.
Every lifecycle should define its meaning.
For example:
Teacher:
ACTIVE
INACTIVE
TERMINATED
ARCHIVED
and:
Fee Demand:
DRAFT
ISSUED
PARTIALLY_PAID
PAID
OVERDUE
CANCELLED
Status values belong to the domain.

20.13 State Transition Rules
Every important lifecycle should define valid transitions.
Example:
DRAFT
 ↓
ISSUED
 ↓
PAID
should not permit:
PAID → DRAFT
unless an explicit correction workflow exists.
This prevents invalid state mutations.

20.14 Tenant Context Contract
Every tenant-aware operation must receive a tenant context.
Conceptually:
TenantContext
├── tenant_id
├── actor_id
├── membership_id
└── scope
A service should never silently infer a tenant from arbitrary request data.

20.15 Platform Context
Some operations are platform-wide:
Create Plan
Create Feature
Manage Platform Roles
View Cross-Tenant Report
These require:
PlatformContext
rather than pretending they belong to one school.

20.16 Explicit Context Switching
For platform users:
Platform User
    ↓
Select Authorized School
    ↓
Tenant Context
    ↓
School Operation
The selected school must be validated against the user's platform/tenant scope.

20.17 Cross-Tenant References
Never allow:
Student from School A
      ↓
Fee record belonging to School B
Even if IDs happen to be valid.
Every cross-entity reference should validate tenant compatibility.

20.18 Cross-Domain References
Prefer stable references/contracts.
For example:
Attendance
  → student_id
  → enrollment_id
rather than copying:
student_name
class_name
section_name
as authoritative fields.
Snapshots can be used when historical reporting specifically requires them.

20.19 Avoid Cross-Domain Table Ownership
Bad:
Fee module directly modifies Student tables.
Better:
Fee module
   ↓
Student contract/service
or an approved read model.
Each domain owns its own state.

20.20 Cross-Domain Reads
There are three reasonable patterns.
1. Synchronous domain service
When an immediate authoritative answer is required:
Fee
 ↓
Student Service
 ↓
Student information
2. Read model
For reporting/search:
Multiple Domains
      ↓
Read Model
      ↓
Query
3. Domain event
For asynchronous reaction:
StudentCreated
      ↓
Notification / Fee / Reporting
Choose based on business need rather than using one mechanism everywhere.

20.21 Domain Events vs Integration Events
A useful distinction:
Domain Event
Something meaningful happened inside the domain.
Example:
StudentEnrolled
Integration Event
Something is intentionally exposed for another system/module to consume.
Example:
PaymentReceived
The same fact may eventually be published externally, but internal domain events shouldn't automatically become public APIs.

20.22 Event Structure
A standard event envelope should contain concepts such as:
Event ID
Event Type
Occurred At
Actor
Tenant ID
Entity Type
Entity ID
Payload
Schema Version
Correlation ID
Example:
Event:
StudentEnrolled

Tenant:
School A

Entity:
Enrollment/123

Version:
1

20.23 Event Versioning
Events may evolve.
Therefore:
StudentEnrolled v1
StudentEnrolled v2
can exist if the payload changes incompatibly.
Consumers should not be broken silently.

20.24 Outbox Pattern
For important domain events:
Business Transaction
       ↓
Database Commit
       ↓
Outbox Event
       ↓
Publisher
       ↓
Consumers
This prevents:
Database updated
BUT
event lost
We don't need a sophisticated message broker immediately.
An outbox table/process can be enough for V1.

20.25 Transaction Boundary
A core business operation should be atomic where appropriate.
Example:
Publish Exam Result
   ├── validate
   ├── update result state
   ├── audit
   └── create event/outbox record
These should be coordinated carefully.
But avoid transactions spanning:
Database
+
External Payment Gateway
+
Email Provider
+
SMS Provider
External systems should use state machines/retries/idempotency.

20.26 Audit vs Events
They are not the same thing.
Audit
Answers:
Who changed what?
Event
Answers:
What happened that another component may react to?
Application Log
Answers:
What happened while the software was executing?
Security Event
Answers:
What security-relevant activity occurred?
Keep these concepts separate.

20.27 Standard Audit Envelope
Across domains:
Audit
├── ID
├── Tenant
├── Actor
├── Actor Type
├── Action
├── Entity Type
├── Entity ID
├── Before
├── After
├── Reason
├── Request ID
└── Timestamp
Sensitive fields should be filtered/redacted according to data classification.

20.28 Configuration vs Business Data
This distinction should now be standardized.
Configuration:
Attendance statuses
Fee policies
Grading scales
Notification preferences
School settings
Business data:
Attendance record
Fee payment
Exam result
Student enrollment
Configuration changes should not rewrite historical business records.

20.29 Effective-Dated Configuration
When configuration affects historical behavior, use effective dates or versions.
Examples:
Fee Structure v1
Effective Jan 2026

Fee Structure v2
Effective Apr 2026
and:
Grade Scale v1
Used for 2025–26 results
This principle applies across domains.

20.30 Files
All domains use the common file service.
Standard conceptual contract:
File
├── Tenant
├── Owner Type
├── Owner ID
├── File Type
├── Storage Reference
├── Size
├── MIME Type
├── Uploaded By
└── Created At
Examples:
Student → Birth Certificate
Teacher → Qualification Certificate
School → Registration Document
Files remain private by default.

20.31 File Access
Access flow:
User
 ↓
Tenant
 ↓
Permission
 ↓
Owner Relationship
 ↓
File Access
Never expose permanent storage URLs as the authorization mechanism.
Use controlled/signed access where appropriate.

20.32 Notifications
All domains use one notification service.
Conceptually:
Domain Event
      ↓
Notification Policy
      ↓
Notification
      ↓
Channel
Channels can include:
Email
SMS
Push
In-app
The core domains shouldn't know provider-specific implementation details.

20.33 Notification Failure
If an email fails:
Payment Received
      ↓
SUCCESS
      ↓
Notification failed
the payment must not roll back.
Instead:
Notification
 ↓
Retry
 ↓
Dead-letter / failure state
Business transaction and notification delivery are separate.

20.34 Search
Search should be tenant-aware.
For example:
Search "Rahul"
must never return another school's student.
Search indexes should include:
tenant_id
entity_type
entity_id
Platform-wide searches require explicit platform permission.

20.35 Background Jobs
Every tenant-specific job should carry:
job_id
tenant_id
actor_id, where applicable
job_type
payload
created_at
status
Examples:
Student Import
Fee Generation
Report Generation
Bulk Promotion
Exam Result Calculation
Transport Assignment Import

20.36 Background Job Isolation
A job worker must establish:
Tenant Context
before accessing tenant data.
Never rely on a global/default tenant.

20.37 Bulk Operations
All domains should treat bulk operations as first-class workflows.
Pattern:
Request
 ↓
Validate
 ↓
Preview
 ↓
Confirm
 ↓
Background Job
 ↓
Result Summary
Examples:
Import 500 students
Generate 2,000 fee demands
Promote 300 students
Enter 1,000 exam marks

20.38 Bulk Operation Results
A bulk job should report:
Total
Successful
Failed
Skipped
Warnings
and ideally provide failed-row details.
Never return:
"Import failed"
without actionable information.

20.39 Idempotency Standard
Operations that may be retried should support idempotency where appropriate.
Examples:
Payment
Webhook
Bulk submission
Invoice generation
Notification dispatch
External synchronization
A unique business/external key should prevent duplicate processing.

20.40 Concurrency
Important records should support concurrency protection.
Possible mechanisms:
Optimistic version
Database constraint
Transaction
Row-level lock
depending on the operation.
Example:
Two admins edit same fee structure
The system should not silently overwrite one administrator's changes.

20.41 Unique Constraints
Important business uniqueness rules should be enforced at the database level where practical.
Examples:
school_code unique
student_number unique within tenant
teacher_number unique within tenant
Not merely:
Check in application
because concurrent requests can bypass application-only checks.

20.42 Tenant-Scoped Uniqueness
Most business identifiers should be unique within a tenant, not globally.
For example:
School A:
STU-001

School B:
STU-001
Both can be valid.
Conceptually:
UNIQUE(tenant_id, student_number)
where appropriate.

20.43 API Naming
Use consistent API conventions.
Conceptually:
/api/v1/students
/api/v1/teachers
/api/v1/attendance
/api/v1/exams
/api/v1/fees
/api/v1/transport
Avoid mixing patterns such as:
/getStudents
/createStudent
/students/list
The exact API style can be finalized during implementation.

20.44 API Versioning
Start with:
/api/v1
Don't create:
/api/v2
for every small change.
Create a new version when a breaking contract change is genuinely required.

20.45 Standard Error Model
Across domains:
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
Domain-specific error codes can be added when necessary.

20.46 Not-Found Semantics
For tenant-sensitive resources, sometimes:
RESOURCE_NOT_FOUND
is preferable to:
This resource exists in another school
because the latter can leak cross-tenant information.

20.47 Authorization Contract
Every protected operation should conceptually evaluate:
authorize(
    actor,
    tenant,
    permission,
    resource,
    scope
)
The application should not scatter authorization logic throughout business code.

20.48 Entitlement Contract
Domain modules should use a simple capability interface:
isEntitled(
    tenant,
    capability
)
Example:
isEntitled(
    school,
    "examination.result"
)
The domain should not know whether access came from:
Plan
Add-on
Custom Contract
Admin Override
That is the Entitlement Engine's responsibility.

20.49 Permission Contract
Similarly:
can(
    user,
    "exam.result.publish",
    context
)
The permission engine handles:
Role
Role Assignment
Direct Override
Scope
Membership
The domain receives the authorization decision.

20.50 Domain Module Checklist
Every future module must answer:
□ What does this domain own?
□ What does it reference?
□ What does it NOT own?
□ What are its entities?
□ What are its lifecycles?
□ What are its business rules?
□ What are its permissions?
□ What entitlement does it require?
□ What tenant boundaries exist?
□ What configuration exists?
□ What events does it emit?
□ What events does it consume?
□ What must be audited?
□ What files does it own?
□ What notifications can it trigger?
□ What reports does it own?
□ What background jobs exist?
□ What bulk operations exist?
□ What failure scenarios exist?
□ What future extension points exist?
This becomes our standard domain-design template.

20.51 Cross-Domain Ownership Matrix
The current ownership model is:
￼
The exact ownership of some cross-cutting entities can be refined later, but this gives us a strong boundary.

20.52 The Most Important Rule
If a new module asks:
"Where should this data live?"
the first question is:
Which domain owns the business rule that makes this data meaningful?
Not:
Which module needs to display it?
For example:
Transport charge
may be displayed in Fees, but its applicability can originate in Transportation.
Likewise:
Student class
may be displayed in Attendance, but the academic structure belongs to Academic Management and the enrollment relationship belongs to Student Management.

20.53 Current Architecture After Part 20
                         PLATFORM CORE
                              │
       ┌──────────────────────┼───────────────────────┐
       │                      │                       │
 Identity/RBAC         Product/Entitlement      Commercial/Billing
       │                      │                       │
       └──────────────────────┼───────────────────────┘
                              ↓
                         SCHOOL/TENANT
                              │
        ┌─────────────────────┼─────────────────────┐
        ↓                     ↓                     ↓
    ACADEMIC              STUDENT                TEACHER
        │                     │                     │
        └──────────────┬──────┴──────────┬──────────┘
                       ↓                 ↓
                  ATTENDANCE         EXAMINATION
                       │                 │
                       └────────┬────────┘
                                ↓
                             FEES
                                │
                         ┌──────┴──────┐
                         ↓             ↓
                 TRANSPORTATION   Other Domains
Cross-cutting every domain:
Authentication
Authorization
Tenant Context
Entitlement
Audit
Events
Files
Notifications
Search
Background Jobs
Configuration
Reporting

20.54 Foundation Status
At this point, the platform foundation plus major domain boundaries are sufficiently mature that we should avoid continuously adding architecture abstractions.
The next modules can now follow the same template.
Recommended remaining domain sequence:
20  Cross-Domain Standards       ← current
21  Communication / Notifications
22  Timetable
23  Library
24  Leave / Staff Operations
25  Parent / Guardian Portal
26  User & Role Administration
27  Reports / Analytics
28  System Settings / Configuration
29  Integrations
30  Final Domain Dependency Map
31  Detailed Core Database Design
32  Detailed API Architecture
33  Implementation Roadmap
One important point: User & Role Administration was part of the original platform requirements and should eventually receive a detailed domain design rather than being treated merely as infrastructure.
Before detailed database/API design, we should finish the major domain boundaries and then create one final dependency graph. That will let us catch circular dependencies before implementation begins.
