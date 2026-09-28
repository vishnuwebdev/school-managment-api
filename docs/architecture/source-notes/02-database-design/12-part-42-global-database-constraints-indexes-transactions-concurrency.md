<!-- Source: Apple Notes, folder 'Core Database design system' -->
# Part 42 — Global Database Constraints, Indexes, Transactions & Concurrency

This is the final database-foundation checkpoint.
The purpose is not to add more tables. It is to make sure all domains follow the same integrity and concurrency rules.

42.1 Global Database Principles
The V1 database should follow these rules:
Tenant isolation
+
Referential integrity
+
Domain ownership
+
Historical preservation
+
Transactional consistency
+
Idempotency
+
Controlled concurrency
+
Auditable changes
The database should enforce what it can.
The application/domain layer should enforce business rules that cannot reasonably be expressed as database constraints.

42.2 Tenant Boundary — Most Important Rule
For tenant-owned data:
tenant_id
is mandatory.
Conceptually:
School
 ├── Student
 ├── Teacher
 ├── Fee
 ├── Attendance
 ├── Exam
 ├── Library
 └── Timetable
Every one of those records carries the school's tenant identity.

42.3 Why Application-Only Tenant Filtering Is Insufficient
This is unsafe:
SELECT *
FROM students
WHERE id = :student_id;
The query does not prove that the student belongs to the current tenant.
Instead:
SELECT *
FROM students
WHERE tenant_id = :tenant_id
  AND id = :student_id;
Tenant scope must be part of the repository/data-access contract.

42.4 Cross-Tenant Foreign Keys
Consider:
School A
  Student A1

School B
  Fee Demand B1
The database must never allow:
Fee Demand B1 → Student A1
even if both IDs are technically valid.

42.5 Composite Tenant-Aware References
Where practical, use tenant-aware foreign-key relationships.
Conceptually:
students
---------
id
tenant_id
and:
fee_demands
-----------
id
tenant_id
student_id
The relationship can enforce:
(student_id, tenant_id)
        ↓
students(id, tenant_id)
This is stronger than relying solely on application validation.

42.6 When Composite FKs Are Practical
They are particularly useful for critical tenant-owned relationships:
Student → Enrollment
Student → Fee
Student → Attendance
Student → Library
Teacher → Teaching Assignment
Teacher → Attendance
Not every relationship needs maximum database complexity, but tenant boundaries deserve strong protection.

42.7 Platform-Level Tables
Some tables are intentionally not tenant-owned:
Users
Permissions
Platform Plans
Feature Catalog
Platform Configuration
Others may support both platform and tenant scope:
Roles
Integrations
Report Definitions
Notification Templates
The scope must be explicit.

42.8 Never Use NULL Tenant ID Accidentally
A nullable tenant_id should mean something intentional, such as:
Platform-level record
It must never mean:
tenant forgotten
Schema conventions should make that distinction obvious.

42.9 ID Strategy
Use stable opaque identifiers.
A UUID/UUIDv7-style strategy is appropriate.
Example:
student.id
enrollment.id
fee_demand.id
loan.id
should not encode:
school
year
class

42.10 Business Identifiers
Keep business identifiers separate:
Student:
 internal ID → UUID
 student_number → STU-2026-0012

Teacher:
 internal ID → UUID
 teacher_number → TCH-0042

Library:
 internal ID → UUID
 membership_number → LIB-10042
This allows business numbering rules to change without changing primary keys.

42.11 UUIDs and Indexes
UUID-style IDs can create indexing considerations.
Using time-ordered UUIDs where supported can reduce index fragmentation compared with completely random identifiers.
The exact UUID implementation is an implementation detail, but the architectural requirement is:
IDs must remain opaque and stable.

42.12 Timestamp Standard
Common fields:
created_at
updated_at
Use explicit lifecycle timestamps where meaningful:
published_at
approved_at
cancelled_at
returned_at
paid_at
archived_at
Do not rely on one updated_at field to reconstruct history.

42.13 Timezone
Store timestamps consistently, preferably in UTC.
Tenant configuration provides:
school timezone
Business operations interpret local dates/times using the school's timezone.
This is particularly important for:
Attendance
Timetable
Examinations
Fees due dates
Library due dates
Leave
Notifications
Scheduled jobs

42.14 Date vs Timestamp
Use a date when the concept is genuinely date-based:
academic_year.start_date
student.date_of_birth
attendance.date
leave.start_date
Use timestamp when time-of-day matters:
payment.received_at
loan.issued_at
notification.sent_at
audit.created_at
Avoid storing everything as timestamps simply for consistency.

42.15 Delete Strategy
Do not implement a universal:
deleted = true
pattern for every table.
Different business concepts need different lifecycle states.
Examples:
Student → Archived
Teacher → Terminated/Archived
Fee Demand → Cancelled/Written Off
Payment → Refunded
Book Copy → Retired
Vehicle → Retired
Role → Disabled/Archived

42.16 Physical DELETE
Physical deletion should be rare.
Generally appropriate for things like:
temporary job artifacts
expired technical records
staging/import data
subject to retention policy.
Important business records should normally remain historically available.

42.17 Referential Integrity
Foreign keys should be used where they provide meaningful protection.
Examples:
Enrollment → Student
Enrollment → Academic Year
Attendance Record → Attendance Session
Payment Allocation → Payment
Payment Allocation → Fee Demand
Loan → Library Copy
Loan → Library Member

42.18 Don't Overuse Database Cascades
Avoid broad:
ON DELETE CASCADE
on important business relationships.
For example:
Delete Student
   ↓
Delete Attendance
Delete Exams
Delete Fees
Delete Library Loans
would destroy historical information.
Business deletion should instead be prevented or handled explicitly.

42.19 Reference vs Ownership
A foreign key does not necessarily mean ownership.
For example:
attendance_records.student_id
means Attendance references Student.
Student Management still owns the Student.
This distinction remains important when deciding who may update the record.

42.20 Unique Constraints
Important tenant-scoped uniqueness examples:
UNIQUE(tenant_id, student_number)

UNIQUE(tenant_id, teacher_number)

UNIQUE(tenant_id, membership_number)

UNIQUE(tenant_id, barcode)

UNIQUE(tenant_id, fee_code)

UNIQUE(tenant_id, academic_year_code)
The exact uniqueness requirements should be confirmed per domain.

42.21 Status Codes
Statuses should normally be constrained.
Avoid allowing arbitrary strings such as:
"active"
"Active"
"ACTIVE"
"enabled"
for the same concept.
Use:
controlled enum/value set,
reference table where tenant-configurable,
or a domain-specific status type.

42.22 Configurable Statuses
Some domains legitimately need configurable values:
Attendance Status
Fee Category
Leave Type
Library Fine Type
Assessment Type
These belong in domain configuration tables.
Do not turn every status into a generic global lookup table.

42.23 Indexing Strategy
Indexes should generally begin with:
tenant_id
for tenant-owned operational queries.
Example:
(tenant_id, student_number)
(tenant_id, status)
(tenant_id, created_at)
depending on access patterns.

42.24 Don't Index Every Column
Excessive indexing causes:
slower writes,
larger database size,
more maintenance,
unnecessary complexity.
Index based on:
frequent filters
joins
sorting
uniqueness
foreign-key lookups
range queries

42.25 Foreign-Key Indexes
Frequently referenced foreign keys should normally be indexed.
For example:
enrollments.student_id
attendance_records.attendance_session_id
attendance_records.student_id
fee_demands.student_id
payment_allocations.payment_id
payment_allocations.fee_demand_id
library_loans.copy_id
library_loans.member_id
Usually tenant should participate in the composite index.

42.26 Partial / Conditional Unique Indexes
Some rules concern only active records.
Example:
One active loan per copy
Conceptually:
UNIQUE(copy_id)
WHERE loan is active
The exact syntax depends on the database engine.
This is a good place for the database to enforce a critical business invariant.

42.27 Enrollment Uniqueness
Do not blindly define:
UNIQUE(student_id, academic_year_id)
because future requirements may allow:
class changes,
section changes,
transfer,
multiple enrollment periods.
The model must preserve historical movement.

42.28 Academic Historical Integrity
An enrollment record should preserve:
Academic Year
Class
Section
Start Date
End Date
Status
so future reporting does not depend on today's class assignment.

42.29 Effective-Dated Data
Several domains need effective dating:
Enrollment
Teaching Assignment
Student Transport Assignment
Leave
Fee Structure
Grading Scheme
Timetable
Library Policy
Historical records must not silently inherit today's configuration.

42.30 Versioning vs Effective Dating
Use versioning where a complete configuration snapshot matters:
Plan Version
Grading Scheme
Timetable Version
Fee Structure Version
Use effective dates where the same entity has time-bounded applicability:
Teaching Assignment
Leave Policy
Transport Assignment
Sometimes both are appropriate.

42.31 Optimistic Concurrency
Use optimistic concurrency for records where simultaneous editing is possible but conflicts are relatively uncommon.
Example:
timetable version = 8
User A edits:
version 8 → 9
User B still has:
version 8
User B's update should fail with:
CONFLICT
rather than silently overwriting User A.

42.32 Good Optimistic-Locking Candidates
Timetable
Fee Structure
Assessment
Grading Scheme
School Settings
Roles
Feature Configuration
Library Catalog
Leave Policies
The exact list can evolve.

42.33 Pessimistic/Transactional Locking
Use stronger locking where simultaneous operations can create financial or physical-resource conflicts.
Examples:
Payment allocation
Fee balance
Library copy issuance
Transport capacity
Leave balance approval

42.34 Library Example
Two librarians issue the same copy:
Copy = AVAILABLE
Transaction A:
lock copy
verify available
issue
Transaction B:
wait
lock copy
verify now ISSUED
reject
Only one loan succeeds.

42.35 Transport Capacity
Suppose:
Vehicle capacity = 40
Current assignments = 39
Two administrators simultaneously assign another student.
Both see:
39 < 40
Without transactional protection, both may succeed.
The capacity operation needs appropriate concurrency control.

42.36 Leave Balance
Likewise:
Remaining leave = 2
Two requests of 2 days must not both be approved if negative balance is disallowed.
Approval requires a transactional balance check.

42.37 Fee Payment Allocation
Payment allocation is financially sensitive.
Example:
Demand = ₹10,000
Payment A = ₹7,000
Payment B = ₹5,000
Both cannot allocate independently against the same remaining balance.
Allocation must use transactional protection.

42.38 Financial Idempotency
Payment operations should accept an idempotency key.
Conceptually:
idempotency_key
tenant_id
operation_type
request_hash
result_reference
created_at
A retry with the same key must not create a second payment.

42.39 Webhook Idempotency
External payment events also require deduplication:
provider
+
connection
+
external_event_id
must identify the same webhook event.

42.40 Bulk Operation Idempotency
Bulk imports/submissions need protection against repeated confirmation.
Example:
Bulk Attendance Job #123
should not create duplicate attendance records if the worker retries.
Unique business keys and job-level idempotency should work together.

42.41 Outbox Pattern
Important domain events should be committed atomically with the business transaction.
Example:
BEGIN
  Create Payment
  Create Payment Allocation
  Create Receipt
  Create Outbox Event
COMMIT
If the transaction succeeds, the event exists.
If it fails, neither business data nor event is committed.

42.42 Outbox Structure
Conceptually:
outbox_events
-------------
id
tenant_id nullable
event_type
aggregate_type
aggregate_id
payload
schema_version
occurred_at
published_at
status
attempt_count
last_error
correlation_id

42.43 Outbox Processing
Database Transaction
       ↓
Outbox
       ↓
Worker
       ↓
Event Consumer
If the worker crashes:
Outbox remains
   ↓
Retry

42.44 Event Delivery Is At-Least-Once
Consumers should assume events may be delivered more than once.
Therefore:
Event Consumer
      ↓
Idempotent processing
is required.
Do not design around an assumption of exactly-once delivery.

42.45 Jobs
Background jobs should include:
job_id
tenant_id
job_type
status
attempt_count
payload
created_at
started_at
completed_at
last_error
Where appropriate:
actor_id
correlation_id
must also be carried.

42.46 Tenant Context in Jobs
This is critical.
A job must not merely say:
Generate Fee Report
It should carry enough context to establish:
tenant_id
actor/schedule identity
scope
parameters
Otherwise a background worker can accidentally cross tenant boundaries.

42.47 Scheduled Jobs
For scheduled reports, notifications, renewals, etc.:
Scheduler
 ↓
Create Job
 ↓
Job contains tenant context
 ↓
Worker
 ↓
Domain operation
Authorization-sensitive jobs should revalidate access when appropriate.

42.48 Audit Consistency
Important operations should create audit records within the same logical transaction where possible.
For example:
Disable Feature
+
Audit Record
should not leave the system in a state where the feature was disabled but the required audit entry disappeared.

42.49 Audit Does Not Replace History
Audit answers:
Who changed what?
Domain history answers:
What happened over the lifetime of the business entity?
Example:
Enrollment History
should not be reconstructed solely from generic audit records.

42.50 Audit Does Not Replace Events
Similarly:
Audit
is not an event bus.
Do not make Communication consume audit records to send notifications.
Use:
Domain Event
for that purpose.

42.51 Transaction Boundaries
A transaction should normally cover one coherent business operation.
Example:
Create Fee Demand
 ├── Demand
 ├── Adjustments
 └── Outbox Event
should be atomic.
But:
Fee Demand
 ↓
External Email Provider
should not be one database transaction.

42.52 External Provider Operations
Use:
Internal Transaction
 ↓
Pending/Queued State
 ↓
External Call
 ↓
Verified Result
 ↓
Internal Transaction
rather than trying to hold a DB transaction open while waiting for a provider.

42.53 Payment Gateway Timeout
Correct state:
Payment
= PENDING / UNKNOWN
not automatically:
FAILED
because the gateway may have accepted the transaction even though the response timed out.
Reconciliation/webhook verification resolves the state.

42.54 Feature Disable Transaction
When disabling a feature:
BEGIN
 ↓
Check dependencies/impact
 ↓
Update entitlement
 ↓
Record audit
 ↓
Create event
COMMIT
The system should not partially disable a feature while leaving entitlement/audit/event state inconsistent.

42.55 Subscription Expiry
Subscription expiry should not physically delete:
Student
Fees
Attendance
Exams
Library
Instead:
Subscription State
      ↓
Entitlement Resolution
      ↓
Operational Access Restriction
Data remains preserved.

42.56 Archive vs Disable
A record can become unavailable for new use while remaining historically valid.
Examples:
Archived Student
Retired Vehicle
Withdrawn Book Copy
Disabled Role
Archived Academic Year
Completed Subscription
The database should not confuse these with deletion.

42.57 Cross-Domain Update Rule
A domain should not directly modify another domain's tables.
Bad:
Leave
 ↓
UPDATE timetable_entries
Good:
Leave
 ↓
LeaveApproved Event
 ↓
Timetable Application Service
 ↓
Timetable Change

42.58 Cross-Domain Read Rule
Three options:
1. Synchronous domain service
2. Read model
3. Event-driven projection
Choose based on consistency and performance requirements.
Avoid arbitrary SQL joins across domain ownership boundaries.

42.59 Search
Search indexes must include tenant context.
Conceptually:
search_index:
  tenant_id
  entity_type
  entity_id
  searchable_content
Queries must always filter:
tenant_id = current_tenant

42.60 Cache
Same rule for cache:
tenant:{tenant_id}:...
Examples:
tenant:A:permissions:user:123
tenant:A:entitlements
tenant:A:student:456
tenant:A:report:attendance:...
Never allow a generic cache key to return another school's data.

42.61 Files
File metadata should contain:
tenant_id
owner_type
owner_id
storage_reference
visibility
Actual object storage paths should also have tenant-aware namespaces.
Example:
tenant/{tenant_id}/...

42.62 Private Files
Student documents, payment documents, leave attachments, etc. should not be publicly accessible by URL.
Use controlled access/signed URLs where appropriate.
Authorization happens before access is granted.

42.63 Bulk Operations
Every bulk operation should follow:
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
Result
Examples:
Student import
Attendance upload
Mark import
Fee assignment
Library catalog import
User import

42.64 Bulk Result
A bulk operation should provide:
total
successful
failed
skipped
warnings
error details
The result should remain associated with:
tenant
actor
job

42.65 Partial Failure
Bulk operations should not silently hide partial failure.
For example:
100 students
95 imported
5 rejected
must produce a clear result.
Whether the operation is all-or-nothing or partially successful should be defined per domain.

42.66 Security-Sensitive Changes
For:
Role assignment
Permission changes
Feature overrides
Pricing overrides
Payment verification
Fine waivers
Fee write-offs
consider:
transaction
+
audit
+
reason
+
actor
and later:
re-authentication
second approval
where required.

42.67 Unique Constraints Are Business Safety Nets
Important uniqueness should be enforced at DB level.
For example:
student_number
teacher_number
membership_number
barcode
external_event_id
payment_provider_reference
Application validation alone is insufficient because concurrent requests can bypass it.

42.68 Check Constraints
Use DB checks for simple invariants where supported.
Examples:
amount >= 0
start_date <= end_date
capacity > 0
max_marks >= 0
passing_marks <= max_marks
Complex business rules remain in application/domain logic.

42.69 Monetary Values
Money must use fixed-precision decimal/numeric types.
Avoid floating point for:
Fee
Payment
Discount
Concession
Refund
Fine
Price
Subscription
Store currency explicitly where multi-currency is possible.

42.70 Historical Money
When an amount is determined, preserve the relevant commercial context.
For example:
Fee Demand
 ├── original_amount
 ├── discount
 ├── concession
 ├── waiver
 └── final_amount
Do not recalculate historical financial records from today's fee configuration.

42.71 Subscription Historical Pricing
Likewise:
Subscription Item
 ├── standard_price
 ├── custom_price/discount
 └── final_price
must preserve what the school actually purchased.
The current plan catalog cannot be used to reconstruct historical billing.

42.72 Entitlement Cache
Entitlements may be cached for performance.
But when any of these change:
Subscription
Plan
Add-on
Override
Feature dependency
the relevant cache must be invalidated/recalculated.
Never let stale entitlement state silently grant access indefinitely.

42.73 Authorization Cache
Role/permission changes similarly require:
cache invalidation
or another mechanism ensuring newly revoked permissions become ineffective promptly.

42.74 Fail-Closed Rules
For security-critical checks:
Authorization unavailable
      ↓
DENY
and:
Entitlement cannot be established
      ↓
Do not grant new privileged capability
Cached state may be used selectively for resilience, but not as an excuse to bypass authorization.

42.75 Database Constraint Layers
The final model has three levels:
Database
 ├── Types
 ├── NOT NULL
 ├── Foreign Keys
 ├── Unique Constraints
 ├── Check Constraints
 └── Indexes

Application
 ├── Validation
 ├── Authorization
 ├── Tenant Context
 └── Transaction Coordination

Domain
 ├── Business Rules
 ├── Lifecycles
 ├── State Transitions
 └── Cross-entity Decisions
No single layer should be expected to do everything.

42.76 Final Transaction Model
A typical operation becomes:
Request
 ↓
Authentication
 ↓
Tenant Context
 ↓
Authorization
 ↓
Entitlement
 ↓
Domain Validation
 ↓
BEGIN TRANSACTION
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

42.77 Final Failure Model
Validation Failure
 → Roll back

Authorization Failure
 → Deny

Entitlement Failure
 → Deny

Business Rule Failure
 → Roll back

DB Conflict
 → CONFLICT / Retry where appropriate

External Provider Failure
 → Pending / Retry / Reconciliation

Notification Failure
 → Retry asynchronously

Reporting Failure
 → Retry projection

Integration Failure
 → Retry / Reconciliation

42.78 Global Integrity Checklist
Before considering the V1 foundation ready, every domain should answer:
✓ Does every tenant-owned record have tenant context?
✓ Are cross-tenant references prevented?
✓ Are business identifiers tenant-scoped?
✓ Are historical records preserved?
✓ Are lifecycle states explicit?
✓ Are important foreign keys protected?
✓ Are critical uniqueness rules DB-enforced?
✓ Are money fields fixed precision?
✓ Are effective dates/versioning handled?
✓ Are important concurrent operations protected?
✓ Are external operations idempotent?
✓ Are domain events delivered through outbox?
✓ Are background jobs tenant-aware?
✓ Are cache keys tenant-aware?
✓ Are search indexes tenant-aware?
✓ Are files tenant-scoped?
✓ Are sensitive changes audited?
✓ Are bulk operations safe to retry?
✓ Do external failures avoid corrupting internal state?
✓ Do protected operations fail closed?

42.79 Final V1 Database Architecture
The complete conceptual database now looks like:
                         PLATFORM
                            │
        ┌───────────────────┼────────────────────┐
        │                   │                    │
     Identity            Commercial           Platform
     / RBAC              / Billing             Services
        │                   │                    │
        │                   │          ┌─────────┼─────────┐
        │                   │          │         │         │
        │                   │       Audit      Files    Jobs/Outbox
        │                   │          │         │         │
        └───────────────────┴──────────┴─────────┴─────────┘
                            │
                         TENANT
                            │
       ┌────────────────────┼─────────────────────┐
       │                    │                     │
    Academic             People               Operations
       │                    │                     │
       │          ┌─────────┼─────────┐     ┌─────┼────────────┐
       │          │         │         │     │     │            │
       │       Student    Teacher   Leave  Fees  Exam      Attendance
       │          │         │         │     │     │            │
       │          └─────────┼─────────┘     │     │            │
       │                    │               │     │            │
       └────────────────────┼───────────────┼─────┼────────────┘
                            │               │     │
                     ┌──────┴──────┐       │     │
                     │             │       │     │
                 Timetable      Library    │     │
                     │             │       │     │
                     └──────┬──────┴───────┴─────┘
                            │
                     Domain Events
                            │
                 ┌──────────┴──────────┐
                 │                     │
           Communication          Reporting
                 │                     │
                 ↓                     ↓
             Guardians             Analytics
                 │
                 ↓
            Parent Portal

                 Integrations
                      ↑
              Domain Events /
              Application Services

42.80 The Core Architecture Is Now Stable
The major architectural layers are now separated cleanly:
ENTITLEMENT
    ↓
AUTHORIZATION
    ↓
DOMAIN
    ↓
DATABASE
    ↓
EVENTS
    ↓
ASYNC SERVICES
And the most important boundaries are established:
Identity ≠ Membership ≠ Role ≠ Permission

Plan ≠ Subscription ≠ Entitlement

Student ≠ Enrollment

Teacher ≠ User

Book ≠ Book Copy

Fee Demand ≠ Payment ≠ Receipt

Leave ≠ Attendance ≠ Timetable

Timetable ≠ Substitution

Domain Data ≠ Reporting

Domain Event ≠ Audit

Portal ≠ Domain Ownership

Integration ≠ Source of Truth
V1 Foundation Status
At this point, the architecture has enough definition to move into implementation-level design without redesigning the core model.
The sensible next phase is no longer another domain. It is to produce the Master V1 Architecture Specification from Parts 1–42, consolidating:
system architecture,
module boundaries,
ownership matrix,
dependency graph,
database entities,
RBAC/authorization model,
entitlement model,
API conventions,
event/outbox model,
security model,
transaction/concurrency rules,
tenant-isolation rules,
implementation phases.
Only after that consolidated specification should individual tables be converted into exact SQL/ORM schemas and APIs.
