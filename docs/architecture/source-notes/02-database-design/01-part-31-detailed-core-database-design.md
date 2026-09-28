<!-- Source: Apple Notes, folder 'Core Database design system' -->
# Part 31 — Detailed Core Database Design

We now move from architecture into the database foundation. The goal is still not to create the complete schema for every module. First we establish the tables and invariants that every domain will depend on.

31.1 Database Strategy
For V1:
Single Database
      │
      ├── Shared Platform Tables
      │
      └── Tenant-Owned Domain Tables
              │
              └── tenant_id
Recommended approach:
Shared database.
Explicit tenant_id on tenant-owned business tables.
Application-level tenant enforcement.
Repository/query layer must automatically apply tenant scope.
Database constraints should reinforce important isolation rules.
No domain should depend on a separate database per school in V1.
Architecture should leave physical tenant isolation possible later.
The database should optimize for correctness and maintainability first, not premature sharding.

31.2 ID Strategy
Use stable opaque IDs for primary identifiers.
Conceptually:
id
rather than:
student_number
teacher_number
invoice_number
as the primary key.
Business identifiers remain separate.
Example:
student
---------
id
student_number
tenant_id
...
This allows:
business identifiers to change if necessary,
tenant-scoped numbering,
external references without exposing internal sequencing,
future distributed operations.
UUID/UUIDv7-style identifiers are a reasonable choice.
The exact database type can be finalized with the technology stack.

31.3 Common Timestamp Convention
Most persistent entities should have:
created_at
updated_at
Lifecycle-specific entities can additionally have:
activated_at
suspended_at
archived_at
cancelled_at
published_at
Do not add every possible timestamp to every table.
A timestamp should exist when it represents meaningful domain history.

31.4 Soft Delete Strategy
Do not introduce generic soft deletion everywhere.
Different concepts mean different things:
Archive
Deactivate
Cancel
Retire
Withdraw
Delete
For example:
Student → Archived
Subscription → Cancelled
Vehicle → Retired
Book Copy → Withdrawn
User → Disabled
These are domain states, not interchangeable delete flags.
For important historical entities, prefer explicit lifecycle states.

31.5 Core Platform Database Groups
The initial database foundation can be grouped into:
PLATFORM
├── users
├── memberships
├── roles
├── permissions
├── role_assignments
│
├── schools
├── school_settings
│
├── plans
├── plan_versions
├── products/features
├── subscriptions
├── subscription_items
├── invoices
├── payments
│
├── entitlements
│
├── audit_records
├── outbox_events
├── jobs
└── files
This is conceptual. We will refine names and relationships before implementation.

31.6 School/Tenant Core
The school is the V1 tenant.
Conceptually:
schools
---------
id
name
code
status
timezone
locale
currency
created_at
updated_at
...
But keep profile and configuration concerns separate.
For example:
School
School Profile
School Settings
should not become one enormous record.

31.7 School Lifecycle
The school record needs an explicit lifecycle.
Initial concept:
REQUESTED
UNDER_REVIEW
APPROVED
PROVISIONING
ACTIVE
SUSPENDED
ARCHIVED
However, a key distinction is required:
School lifecycle
answers:
Is this school operationally active?
Subscription lifecycle
answers:
Is this school's commercial access currently valid?
They must remain separate.

31.8 School Status vs Subscription Status
Do not create something like:
school.status = "subscription_expired"
Instead:
School
  status = ACTIVE

Subscription
  status = EXPIRED
The effective access layer combines both.
This prevents commercial state from corrupting tenant lifecycle semantics.

31.9 School Request
A school request is not the school itself.
Conceptually:
school_requests
----------------
id
requested_name
requested_contact
status
reviewed_by
reviewed_at
created_at
updated_at
Flow:
School Request
      ↓
Review
      ↓
Approval
      ↓
School Creation
      ↓
Provisioning
This avoids creating half-configured tenant records simply because someone submitted a form.

31.10 School Settings
School-level configuration should not become a giant untyped JSON blob.
Conceptually:
school_settings
---------------
school_id
timezone
locale
currency
date_format
working_days
...
For strongly structured settings, typed columns are preferable.
Domain-specific settings remain with their domains.
For example:
school_settings
should not contain:
attendance_late_threshold
library_max_books
exam_passing_percentage
fee_late_fee_rule
Those belong to their respective domains.

31.11 User
The fundamental user identity:
users
-----
id
status
email
phone
password_hash / identity_reference
last_login_at
created_at
updated_at
Important:
users.school_id
should not exist.
A user can potentially belong to:
School A
School B
Platform
through memberships.

31.12 User Identity vs Profile
Keep the authentication identity separate from domain-specific people.
For example:
User
 ├── authentication identity
 └── memberships
while:
Teacher
Student
Guardian
Driver
are domain entities.
This avoids forcing every human in the system into one giant "person" table prematurely.

31.13 Membership
Membership is the tenant boundary.
Conceptually:
memberships
-----------
id
user_id
tenant_id
status
joined_at
ended_at
created_at
updated_at
Relationship:
User
  │
  ├── Membership → School A
  ├── Membership → School B
  └── Platform Membership
The membership determines whether the user may enter a particular tenant context.

31.14 Membership Status
Example:
INVITED
ACTIVE
SUSPENDED
REVOKED
Account status and membership status remain separate.
For example:
User = ACTIVE
Membership = REVOKED
means the user account still exists but cannot access that school.

31.15 Roles
Roles are reusable permission bundles.
Conceptually:
roles
-----
id
name
role_type
scope_type
tenant_id nullable
status
created_at
updated_at
Potential distinction:
SYSTEM_ROLE
CUSTOM_ROLE
A system role may be:
School Admin
Teacher
Parent
while a school can create:
Admission Officer
Transport Coordinator
Fee Clerk
Librarian
depending on configuration.

31.16 Role Ownership
A role may be:
Platform role
tenant_id = NULL
School-specific custom role
tenant_id = School X
This allows:
School A → Custom Role "Junior Coordinator"
School B → Custom Role "Junior Coordinator"
without confusing the two.

31.17 Permissions
Permissions should be first-class records.
Conceptually:
permissions
-----------
id
code
name
domain
action
status
description
Example:
student.view
student.create
student.update
student.archive
student.export

fee.payment.create
fee.payment.verify
fee.payment.refund

exam.result.publish
The permission code becomes a stable authorization contract.

31.18 Role Permissions
Many-to-many relationship:
role_permissions
----------------
role_id
permission_id
So:
School Admin
   ↓
many permissions
and:
Teacher
   ↓
different permission set
No permissions should be hardcoded directly into role names.

31.19 Role Assignments
A user can have multiple roles.
Conceptually:
role_assignments
----------------
id
membership_id
role_id
scope
status
starts_at
ends_at
created_at
updated_at
Example:
User
 ├── Teacher
 ├── Exam Coordinator
 └── Class Coordinator
This is more flexible than one role_id column on membership.

31.20 Scope
Scope is a separate concept from permission.
For example:
permission = attendance.update
scope = ASSIGNED_SECTION
Potential scope types:
ALL_TENANT
ASSIGNED_CLASS
ASSIGNED_SECTION
ASSIGNED_SUBJECT
OWN_RECORD
SELECTED_RESOURCE
Do not attempt to encode all of this inside permission names.

31.21 Invitation
Invitations should be persistent objects rather than temporary controller logic.
Conceptually:
invitations
-----------
id
membership_id
token_reference
status
expires_at
accepted_at
created_by
created_at
Invitation flow:
Created
 ↓
Sent
 ↓
Accepted
 ↓
Membership Active
Expired or revoked invitations cannot be reused.

31.22 Commercial Database Foundation
Commercial architecture:
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
This separation is important for historical accuracy.

31.23 Plan
A plan describes a commercial offering.
Conceptually:
plans
-----
id
code
name
status
description
created_at
updated_at
Avoid putting changing prices directly on the plan.

31.24 Plan Version
A plan version captures commercial terms at a point in time.
plan_versions
-------------
id
plan_id
version
status
effective_from
effective_to
...
This means:
School A purchased Plan v1
and later:
Plan v2
can exist without rewriting history.

31.25 Pricing
Pricing should remain conceptually separate from feature definition.
A product/capability may have:
standard price
billing interval
currency
effective period
while subscription items preserve the actual commercial agreement.

31.26 Subscription
Conceptually:
subscriptions
-------------
id
tenant_id
status
starts_at
trial_ends_at
current_period_start
current_period_end
cancelled_at
auto_renew
created_at
updated_at
A school can have multiple subscription records historically.
Only appropriate active subscriptions contribute to entitlement.

31.27 Subscription Items
Subscription items allow:
Base Plan
+
Add-on A
+
Add-on B
Conceptually:
subscription_items
------------------
id
subscription_id
product_id
quantity
standard_price
discount
final_price
pricing_source
starts_at
ends_at
created_at
This is where commercial history becomes explicit.

31.28 Custom Pricing
Do not overwrite catalog pricing.
Instead preserve:
standard_price
custom_price
discount
final_price
pricing_source
approved_by
reason
This supports negotiated school contracts without corrupting the standard catalog.

31.29 Invoice
Invoice answers:
What amount is formally being billed?
Conceptually:
invoices
--------
id
tenant_id
subscription_id
invoice_number
status
subtotal
discount
tax
total
currency
due_at
issued_at
paid_at
The exact tax/accounting structure can be expanded later.

31.30 Payment
Payment answers:
What money/payment transaction was actually received or processed?
Conceptually:
payments
--------
id
tenant_id
invoice_id
payment_reference
method
status
amount
currency
provider
provider_reference
received_at
verified_at
created_at
Payment must not directly activate features.

31.31 Payment Idempotency
A payment provider reference should have appropriate uniqueness.
Conceptually:
(provider, provider_reference)
should prevent duplicate processing where applicable.
Also support an application-level idempotency key for operations such as:
payment creation
refund
renewal
webhook processing

31.32 Feature Catalog
Features should be represented independently from plans.
Conceptually:
features
--------
id
code
name
parent_feature_id nullable
status
Examples:
student
 ├── student.admissions
 ├── student.guardians
 └── student.documents

attendance
 ├── attendance.daily
 └── attendance.subject
Keep hierarchy shallow.

31.33 Feature Dependencies
Dependencies should be data-driven.
Conceptually:
feature_dependencies
--------------------
feature_id
depends_on_feature_id
dependency_type
Example:
Subject Attendance
        ↓
   Attendance
This prevents dependency rules from being buried inside application code.

31.34 Entitlement
Effective entitlement should be represented separately from the source.
Conceptually:
entitlements
------------
id
tenant_id
feature_id
source_type
source_reference
status
starts_at
ends_at
created_at
updated_at
Possible sources:
PLAN
ADD_ON
CUSTOM_CONTRACT
ADMIN_OVERRIDE
The actual resolver determines effective access.

31.35 Entitlement Is Not Permission
This distinction must remain visible in the database design:
Entitlement
"What can this school access?"

Permission
"What can this user do?"

Scope
"Where can this user do it?"
Therefore:
School has Attendance
        +
User has attendance.update
        +
User scope allows section
        =
Potentially allowed

31.36 Audit Foundation
Audit should be append-oriented.
Conceptually:
audit_records
-------------
id
tenant_id nullable
actor_user_id nullable
actor_type
action
entity_type
entity_id
before_data
after_data
reason
request_id
correlation_id
created_at
Platform actions may have:
tenant_id = NULL
when genuinely platform-wide.

31.37 Audit Storage
Do not make audit records behave like normal mutable business entities.
Prefer:
INSERT
rather than normal CRUD.
Important audit records should remain historically trustworthy.
Retention/archival strategy can be decided later.

31.38 Outbox
Reliable events need an outbox.
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
retry_count
last_error
created_at
Business transaction:
Business Data Change
+
Outbox Event
should commit atomically.

31.39 Why Outbox Matters
Without outbox:
DB transaction succeeds
        ↓
Event publish fails
Now the database says something happened but downstream systems never learn about it.
With outbox:
Transaction
 ├── Business Change
 └── Outbox Event
        ↓
     Commit
        ↓
  Background Publisher
This is sufficient for the V1 architecture.

31.40 Jobs
Background jobs need persistent state.
Conceptually:
jobs
----
id
tenant_id
actor_id nullable
job_type
status
payload
attempts
available_at
started_at
completed_at
failed_at
last_error
created_at
This supports:
imports,
exports,
notifications,
report generation,
reconciliation,
subscription processing,
integration synchronization.

31.41 Files
Common file metadata:
files
-----
id
tenant_id
owner_type
owner_id
storage_key
original_name
mime_type
size
visibility
status
created_by
created_at
The domain determines what the file means.
Example:
Teacher
  → qualification document
while:
Student
  → birth certificate
The File Service only manages storage/access metadata.

31.42 Tenant Isolation Rule
Every tenant-owned table should have an explicit tenant boundary.
Conceptually:
students.tenant_id
teachers.tenant_id
attendance_sessions.tenant_id
fee_demands.tenant_id
vehicles.tenant_id
books.tenant_id
Even if the parent relationship technically implies the tenant, explicit tenant ownership is useful for:
query enforcement,
indexing,
security checks,
reporting,
debugging,
future physical isolation.

31.43 Cross-Tenant Foreign Keys
A major rule:
Tenant A record
      ↓
must never reference
      ↓
Tenant B record
For example:
Student A
 ↓
Guardian B
must be impossible.
This should be reinforced with application validation and, where practical, database constraints/design.

31.44 Tenant-Scoped Uniqueness
Business identifiers should normally be unique within a tenant.
Example:
(student.tenant_id, student_number)
rather than globally:
student_number
Similarly:
(tenant_id, teacher_number)
(tenant_id, invoice_number)
(tenant_id, vehicle_number)
depending on the domain.

31.45 Indexing Principle
Most tenant-owned tables will frequently query:
WHERE tenant_id = ?
Therefore tenant-aware indexes are fundamental.
Common patterns:
(tenant_id, status)
(tenant_id, created_at)
(tenant_id, business_identifier)
(tenant_id, foreign_key)
Exact indexes should be derived from actual access patterns rather than blindly added everywhere.

31.46 Composite Tenant Relationships
Where possible, relationships should make tenant consistency explicit.
Conceptually:
student
-------
id
tenant_id

enrollment
----------
id
tenant_id
student_id
academic_year_id
This gives the application/database enough information to validate:
enrollment.tenant_id
=
student.tenant_id

31.47 What We Should Not Do Yet
Do not create the complete schema for:
Attendance
Examination
Fees
Transportation
Library
Leave
Timetable
Portal
Reporting
Integrations
all at once.
The platform foundation should be validated first.
Then each domain can be designed using the ownership map from Part 30.

31.48 Proposed Database Design Sequence
The remaining database work should follow:
31 — Core Platform
      ↓
32 — Student + Academic
      ↓
33 — Teacher + Attendance
      ↓
34 — Examination
      ↓
35 — Fees
      ↓
36 — Transportation
      ↓
37 — Timetable
      ↓
38 — Library
      ↓
39 — Leave / Staff Operations
      ↓
40 — Communication / Portal
      ↓
41 — Reporting / Integrations
      ↓
42 — Global constraints, indexes, transactions
This keeps each domain understandable while preserving cross-domain consistency.

31.49 Foundation Relationship Diagram
The core database relationship is now approximately:
                    ┌─────────────┐
                    │    Users    │
                    └──────┬──────┘
                           │
                           ↓
                    ┌─────────────┐
                    │ Memberships │
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              ↓                         ↓
        ┌───────────┐             ┌──────────┐
        │  Schools  │             │  Roles   │
        └─────┬─────┘             └────┬─────┘
              │                        │
              │                   ┌────┴─────┐
              │                   │Permissions│
              │                   └──────────┘
              │
              ↓
       ┌──────────────┐
       │Subscriptions │
       └──────┬───────┘
              ↓
      ┌───────────────┐
      │Subscription   │
      │    Items      │
      └──────┬────────┘
             ↓
       ┌────────────┐
       │ Entitlement│
       └─────┬──────┘
             ↓
        Domain Access

Users/Roles ───────────────→ Authorization
All Important Operations ──→ Audit
Domain Transactions ────────→ Outbox
Background Work ────────────→ Jobs
Domain Files ───────────────→ Files
This is the foundation on which the detailed domain schemas should be built.
Next: Part 32 — Student + Academic database design, where we can define the first substantial business-domain tables and, importantly, how enrollment, academic years, classes, sections, subjects, and historical relationships fit together.
