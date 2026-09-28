<!-- Source: Apple Notes, folder 'Notes' -->
# Part 30 — Final Domain Dependency Map

This is the final architectural checkpoint before database/API design.
The objective is to answer:
Who owns each piece of business data?
Which domains may depend on which others?
Which dependencies are synchronous?
Which should use events?
Where could circular dependencies appear?
Which concepts must remain platform-wide?
What should be deferred rather than modeled now?

30.1 Complete Domain Inventory
The platform now contains:
PLATFORM
├── Identity
├── User & Role Administration
├── Tenant Management
├── Plans / Pricing / Billing
├── Feature Catalog
├── Entitlement
├── System Settings
├── Audit
├── Communication
├── Files
├── Background Jobs
├── Reporting
└── Integrations

SCHOOL DOMAINS
├── Student
├── Academic
├── Teacher
├── Attendance
├── Examination
├── Fees
├── Transportation
├── Timetable
├── Library
├── Leave / Staff Operations
└── Parent / Guardian Portal

30.2 Core Ownership Matrix
￼
This ownership matrix should become one of the strongest constraints during implementation.

30.3 Platform Core
The platform core sits underneath every school domain:
                  PLATFORM CORE
                       │
       ┌───────────────┼────────────────┐
       ↓               ↓                ↓
   Identity          Tenant         Commercial
       │               │                │
       └───────────────┼────────────────┘
                       ↓
                 Entitlement
                       │
                       ↓
                  Authorization
                       │
                       ↓
              School Domain Access
Supporting services:
Files
Notifications
Jobs
Audit
Reporting
Integrations
These should remain reusable platform capabilities.

30.4 Identity Dependency
Identity is foundational:
Identity
   ↓
Membership
   ↓
Authorization
   ↓
Every Protected Domain
No business domain should implement its own authentication system.

30.5 Tenant Dependency
Every school-owned domain depends conceptually on Tenant Management:
Tenant
  ↓
Student
Academic
Teacher
Attendance
Examination
Fees
Transport
Timetable
Library
Leave
Communication
This does not mean every domain needs a direct database foreign key to a school table in every implementation detail.
It means tenant ownership is fundamental.

30.6 Commercial Dependency
Commercial Billing provides:
Subscription
    ↓
Entitlement
    ↓
Feature Access
School domains should not directly inspect:
plan.name
subscription.price
invoice.status
Instead they ask:
"Is capability X enabled for this tenant?"

30.7 Authorization Dependency
Every protected operation follows:
Authentication
 ↓
Membership
 ↓
Permission
 ↓
Scope
 ↓
Entitlement
 ↓
Domain Rule
This is a cross-cutting execution pipeline rather than a domain dependency graph.

30.8 Academic as a Foundation Domain
Academic structure is referenced by several domains:
             ACADEMIC
                │
     ┌──────────┼───────────┐
     ↓          ↓           ↓
 Student     Teacher     Timetable
     │          │           │
     ↓          ↓           ↓
 Attendance   Teaching   Scheduling
             Assignment
     │
     ↓
 Examination
Academic should remain relatively foundational.

30.9 Student Dependency
Student is another major reference domain:
                  STUDENT
                     │
       ┌─────────────┼──────────────┐
       ↓             ↓              ↓
 Attendance      Examination       Fees
       │             │              │
       ↓             ↓              ↓
 Transportation   Results        Payments
       │
       ↓
 Library
Student owns the student's identity within the school.
Other domains reference it.

30.10 Teacher Dependency
Teacher Management provides teaching identity and assignments:
Teacher
   ↓
Teaching Assignment
   ↓
Timetable
   ↓
Attendance
and:
Teacher
   ↓
Teaching Assignment
   ↓
Examination
Teacher does not depend on Attendance or Examination merely because those domains use teachers.

30.11 Student ↔ Teacher
There should not be a generic direct relationship such as:
Student.teacher_id
because teaching relationships vary by:
class,
section,
subject,
academic year,
assignment.
Instead:
Student
 ↓
Enrollment
 ↓
Class/Section

Teacher
 ↓
Teaching Assignment
 ↓
Subject/Class/Section
Timetable/academic relationships connect them operationally.

30.12 Attendance Dependency
Attendance consumes:
Student
Enrollment
Academic Structure
Teacher
Timetable context where applicable
But Attendance owns:
Attendance Session
Attendance Record
Attendance Status
Corrections
Dependency direction:
Student ───────┐
Academic ──────┤
Teacher ───────┤
Timetable ─────┤
               ↓
           Attendance
Attendance should not become a parent of Student or Teacher.

30.13 Examination Dependency
Examination consumes:
Academic
Student
Enrollment
Teacher / Evaluator
Timetable/calendar context
and owns:
Assessment
Schedule
Marks
Evaluation
Grades
Results
Publication
Dependency:
Academic
Student
Teacher
   │
   └──────→ Examination

30.14 Fees Dependency
Fees references:
Student
Guardian
Enrollment
Academic Year
Class/Section
and optionally receives charge applicability from:
Transportation
Library may also produce:
Library Fine
which can become a financial obligation.
Fees owns:
Demand
Payment
Receipt
Refund
Concession
Waiver

30.15 Important Financial Boundary
There are two completely different financial systems:
PLATFORM COMMERCIAL
School
 ↓
Subscription
 ↓
Platform Invoice
 ↓
Platform Payment
and:
SCHOOL FEES
Student/Guardian
 ↓
Fee Demand
 ↓
School Payment
 ↓
Receipt
They may share infrastructure but must not share domain ownership.

30.16 Transportation Dependency
Transportation consumes:
Student
Academic context where needed
and may provide:
Transport Charge Applicability
to Fees.
Therefore:
Student
   ↓
Transportation
   ↓
Charge Information
   ↓
Fees
Transportation must not create the actual financial payment record.

30.17 Timetable Dependency
Timetable depends on:
Academic
Teacher
Teaching Assignment
and potentially:
Leave / Staff Availability
Timetable owns:
Time Slots
Timetable Entries
Substitutions
Schedule Overrides

30.18 Timetable ↔ Leave
This relationship can easily become circular if designed incorrectly.
Correct direction:
Leave
 ↓
Staff Unavailable
 ↓
Timetable
 ↓
Affected Sessions
 ↓
Substitution
Not:
Timetable
 ↔
Leave
The Timetable domain can query availability, but Leave remains the owner of leave.

30.19 Library Dependency
Library consumes:
Student
Teacher
User/Membership
and produces:
Library Fine
which Fees may consume.
Therefore:
Student ──→ Library ──→ Fees
Teacher ──→ Library
Library should not call Fees to determine whether a book can be issued unless there is an explicit policy requiring it.

30.20 Communication Dependency
Communication is primarily downstream:
Student Events ─────┐
Fee Events ─────────┤
Exam Events ────────┤
Library Events ─────┤
Transport Events ───┤
Leave Events ───────┤
User Events ────────┤
                    ↓
              Communication
This is one of the best candidates for asynchronous event processing.

30.21 Communication Must Not Become a Dependency Hub
Avoid:
Fee → Communication
Exam → Communication
Student → Communication
Transport → Communication
as synchronous business dependencies.
Instead:
Domain
 ↓
Domain Event
 ↓
Communication
This prevents notification failures from breaking core operations.

30.22 Parent/Guardian Portal
The Portal is primarily a consumer:
Student
Attendance
Examination
Fees
Timetable
Library
Transportation
Communication
       │
       ↓
Guardian Portal
It should not become an upstream dependency of those domains.

30.23 Portal Requests
The exception is user-initiated workflows:
Guardian Portal
 ↓
Request
 ↓
Owning Domain
Example:
Portal
 ↓
Fee Query
 ↓
Fees
or:
Portal
 ↓
Student Update Request
 ↓
Student
The portal owns the request interaction; the domain owns the actual business decision/data change.

30.24 Reporting Dependency
Reporting is downstream from almost everything:
Student
Academic
Teacher
Attendance
Examination
Fees
Transportation
Timetable
Library
Leave
Communication
       │
       ↓
   Reporting
Reporting must never become a prerequisite for a business transaction.

30.25 Reporting and Events
For analytical workloads:
Domain Transaction
 ↓
Outbox
 ↓
Domain Event
 ↓
Reporting Read Model
This gives us reliable asynchronous reporting updates.

30.26 Integrations Dependency
Integrations are generally downstream:
Domain
 ↓
Internal Contract/Event
 ↓
Integration
 ↓
External System
Incoming:
External System
 ↓
Integration
 ↓
Validated Internal Command/Event
 ↓
Domain
This keeps provider-specific logic outside domains.

30.27 Audit Dependency
Audit receives important operations from everywhere:
Student ───────┐
Fees ──────────┤
Exam ──────────┤
Users ─────────┤
Settings ──────┤
Subscriptions ─┤
               ↓
             Audit
Business domains do not query Audit to determine whether an action is allowed.
Audit records what happened.

30.28 Files Dependency
Files are a platform service:
Student Documents ──┐
Teacher Documents ──┤
Exam Reports ───────┤
Leave Attachments ──┤
School Branding ────┤
                    ↓
                File Service
The owning domain defines what the file means.
File Service manages:
storage,
metadata,
access,
lifecycle,
tenant isolation.

30.29 Background Jobs
Jobs are infrastructure supporting many domains:
Fees
Communication
Reports
Imports
Exports
Integrations
Subscriptions
 ↓
Background Jobs
Jobs must preserve:
tenant_id
actor_id where applicable
job_id
job_type
payload
status

30.30 Dependency Direction
The broad dependency direction should look approximately like:
             PLATFORM FOUNDATION
                    │
        ┌───────────┼───────────┐
        ↓           ↓           ↓
     Identity     Tenant     Commercial
        │           │           │
        └───────────┼───────────┘
                    ↓
              Authorization
                    │
                    ↓
              SCHOOL DOMAINS
                    │
        ┌───────────┼──────────────┐
        ↓           ↓              ↓
    Academic      Student        Teacher
        │           │              │
        ├───────────┼──────────────┤
        ↓           ↓              ↓
   Timetable    Attendance     Examination
        │           │              │
        └───────────┼──────────────┘
                    ↓
             Fees / Transport /
             Library / Leave
                    │
                    ↓
              Communication
                    │
                    ↓
                Reporting
                    │
                    ↓
              Integrations
This is conceptual rather than a requirement that every call follow a single strict vertical sequence.

30.31 Synchronous vs Event-Based Dependencies
A useful rule:
Synchronous
Use when the caller needs an authoritative answer immediately.
Examples:
Student → verify enrollment
Fees → verify student
Timetable → verify teaching assignment
Portal → retrieve current attendance
Events
Use for:
Notifications
Analytics
External integrations
Search indexing
Audit side effects
Non-critical downstream processing

30.32 Direct Database Access
Avoid:
Fees
 ↓
SELECT directly from Examination tables
Instead use:
Fees
 ↓
Domain contract / read model
 ↓
Examination
or an appropriate event-derived model.
Direct database access creates hidden coupling.

30.33 Cross-Domain Read Patterns
There are three approved patterns:
1. Synchronous domain query
A → B
when current authoritative information is required.
2. Read model
A/B/C
 ↓
Reporting/Read Model
when repeated aggregation is required.
3. Event
A
 ↓
Event
 ↓
B
when the dependency is asynchronous.

30.34 Circular Dependency Check
We should explicitly avoid:
Student ↔ Fees
Instead:
Student → Fees
Fees references Student.
Student does not need to understand Fee business rules.

30.35 Another Circular Dependency
Avoid:
Attendance ↔ Timetable
Prefer:
Timetable
 ↓
Session Context
 ↓
Attendance
Attendance can consume timetable information but remains independent enough to support daily attendance without timetable.

30.36 Examination and Fees
Avoid:
Examination ↔ Fees
Exam should not directly own financial eligibility.
If the school eventually requires:
"Student cannot receive result until fees are cleared."
then use an explicit eligibility/policy mechanism:
Fees
 ↓
Eligibility Fact
 ↓
Examination
rather than embedding fee queries throughout Examination.

30.37 Library and Fees
Use:
Library
 ↓
Library Fine / Charge
 ↓
Fees
not:
Fees
 ↔
Library
Library determines the charge context.
Fees determines the financial obligation and payment.

30.38 Transportation and Fees
Similarly:
Transportation
 ↓
Charge Applicability
 ↓
Fees
Transportation does not own financial collection.

30.39 Leave and Attendance
Avoid:
Leave ↔ Attendance
Instead:
Leave
 ↓
Approved Leave
 ↓
Attendance
Attendance can use approved leave as contextual information when recording/reporting attendance.

30.40 Teacher and Leave
Avoid making Teacher dependent on Leave for its fundamental identity.
Instead:
Teacher
   ↑
Leave references Teacher
and:
Leave
 ↓
Availability Event
 ↓
Timetable

30.41 Portal Circularity
Avoid:
Student ↔ Portal
Portal is a consumer/request layer.
Correct:
Student → Portal
and:
Portal → Student
only for explicit user-initiated requests.
That distinction prevents the portal from becoming part of core business logic.

30.42 Dependency Classification
We can now classify domains.
Foundational
Identity
Tenant
Academic
Student
Teacher
Operational
Attendance
Examination
Fees
Transportation
Timetable
Library
Leave
Cross-Cutting
Communication
Files
Audit
Jobs
Settings
Access / Presentation
Parent Portal
Reporting
External Boundary
Integrations

30.43 Domain Dependency Matrix
Legend:
D = direct/reference dependency
E = event/async dependency
R = read-model/reporting dependency
— = no normal dependency
￼
* means the dependency should remain limited and contextual rather than becoming ownership.
This matrix is intentionally directional even where the business relationship appears bidirectional.

30.44 The Most Important Dependency Rules
We should lock these rules before implementation:
Rule 1
Domain A may reference Domain B's stable identifiers.
Rule 2
Domain A may not directly modify Domain B's business data.
Rule 3
Cross-domain business changes go through the owning domain.
Rule 4
Events handle asynchronous side effects.
Rule 5
Reporting does not become source of truth.
Rule 6
Integrations do not become source of truth.
Rule 7
Communication failures do not roll back business transactions.

30.45 The Full Event Flow
A typical school operation can now look like:
User
 ↓
Membership
 ↓
Authorization
 ↓
Entitlement
 ↓
Domain Command
 ↓
Domain Transaction
 ↓
Database
 ↓
Outbox
 ↓
Domain Event
 ├────────→ Communication
 ├────────→ Reporting
 ├────────→ Search
 └────────→ Integration
This is the backbone of the system.

30.46 Example — Fee Payment
Guardian
 ↓
Portal
 ↓
Fees
 ↓
Payment
 ↓
Database Commit
 ↓
Outbox
 ↓
PaymentReceived
 ├──→ Communication → Receipt Notification
 ├──→ Reporting → Collection Metrics
 └──→ Integration → Accounting
None of those downstream systems should determine whether the payment itself succeeded.

30.47 Example — Teacher Leave
Teacher
 ↓
Leave Request
 ↓
Approval
 ↓
Leave Approved
 ↓
Event
 ├──→ Timetable → Identify affected sessions
 ├──→ Communication → Notify relevant users
 └──→ Staff Availability
Timetable then creates substitution records if required.

30.48 Example — Exam Publication
Exam Coordinator
 ↓
Examination
 ↓
Result Published
 ↓
Event
 ├──→ Parent Portal → Result available
 ├──→ Communication → Notify guardians
 └──→ Reporting → Update analytics

30.49 Example — Transport Assignment
Transport Admin
 ↓
Transportation
 ↓
Student Assignment
 ↓
Event
 ├──→ Communication → Notify guardian
 ├──→ Fees → Charge applicability
 └──→ Reporting → Transport metrics
Again, Transportation does not create the fee payment.

30.50 Dependency Rule for Future Domains
When adding a new module, ask:
1. What does it own?
2. What does it reference?
3. Who references it?
4. Which dependencies are synchronous?
5. Which are event-based?
6. Does it create a circular dependency?
7. Does it duplicate another domain's data?
8. Does it need configuration?
9. Does it produce financial facts?
10. Does it need reporting?
This becomes the architectural gate for future modules.

30.51 Final Architecture
The entire system can now be represented as:
                         PLATFORM
                            │
        ┌───────────────────┼───────────────────┐
        ↓                   ↓                   ↓
     Identity             Tenant          Commercial
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ↓
                     Authorization
                            │
                     Entitlement
                            │
                            ↓
                    SCHOOL DOMAINS
                            │
       ┌────────────────────┼────────────────────┐
       ↓                    ↓                    ↓
    Academic             Student              Teacher
       │                    │                    │
       ├──────────────┬─────┼──────────────┬─────┤
       ↓              ↓     ↓              ↓     ↓
   Timetable      Attendance Exam         Leave  Library
       │              │      │              │      │
       └──────────────┼──────┼──────────────┼──────┘
                      ↓      ↓              ↓
                     Fees  Transport
                      │      │
                      └──┬───┘
                         ↓
                  DOMAIN EVENTS
                         │
          ┌──────────────┼───────────────┐
          ↓              ↓               ↓
   Communication      Reporting     Integrations
          │
          ↓
   Email/SMS/Push

              Parent/Guardian Portal
                       ↑
                       │
              Reads / Requests
                       │
                 School Domains

30.52 Architectural Foundation Is Now Complete
At this point we have established:
✓ Multi-tenancy
✓ Tenant isolation
✓ Identity
✓ Memberships
✓ RBAC
✓ Permission model
✓ Scope model
✓ Entitlements
✓ Plans/subscriptions
✓ Platform billing
✓ School lifecycle
✓ Domain ownership
✓ Domain boundaries
✓ Cross-domain dependencies
✓ Events
✓ Outbox
✓ Audit
✓ Files
✓ Notifications
✓ Background jobs
✓ Bulk operations
✓ Reporting
✓ Integrations
✓ Configuration
✓ Parent portal
✓ Failure handling
✓ Security boundaries
The major domain boundaries are now sufficiently stable to move toward detailed technical design.

30.53 What Comes Next
The next phase should finally become more concrete.
Part 31 — Detailed Core Database Design
But we should not immediately design every table in the system.
The better sequence is:
31A — Database principles
        ↓
31B — Core platform entities
        ↓
31C — Tenant / School
        ↓
31D — Identity / Membership / RBAC
        ↓
31E — Plans / Subscription / Entitlement
        ↓
31F — Audit / Events / Outbox
        ↓
31G — Shared platform tables
        ↓
31H — First business domains
        ↓
31I — Cross-domain relationships
        ↓
31J — Indexing / constraints / tenant isolation
Only after that should we expand the remaining domain schemas.
The first database-design pass should therefore focus on the platform foundation, because if those tables are wrong, every school domain inherits the problem.
