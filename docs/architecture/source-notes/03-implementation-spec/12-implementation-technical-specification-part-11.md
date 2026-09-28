<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 11

Leave & Staff Availability Management
Leave Management covers staff absence and availability. It should remain separate from Teacher Management because employment identity and leave transactions have different lifecycles.
The core relationship is:
Teacher
   ↓
Leave Policy
   ↓
Leave Balance
   ↓
Leave Application
   ↓
Approval
   ↓
Approved Absence
   ↓
Timetable / Substitution

421. Domain Boundary
Leave & Staff Availability owns:
leave types
leave policies
leave entitlements
leave balances
leave applications
leave approvals
leave cancellations
holidays
staff availability
availability exceptions
It does not own:
teacher identity
employment records
timetable entries
substitutions
attendance records
payroll

422. Leave Types
leave_types
-----------
id
tenant_id
code
name
description
unit
is_paid
requires_approval
requires_document
allow_half_day
status
created_at
updated_at
version
Units:
DAY
HALF_DAY
HOUR
Initial V1 should primarily use DAY and HALF_DAY; hourly leave can be enabled where needed.

423. Leave Type Examples
CASUAL
SICK
ANNUAL
MATERNITY
PATERNITY
UNPAID
OTHER
These are configurable rather than hardcoded system behavior.

424. Leave Policies
A policy determines how a leave type behaves for a group of staff.
leave_policies
--------------
id
tenant_id
name
code
academic_year_id
status
effective_from
effective_until
created_at
updated_at
version
A policy contains one or more rules.

425. Leave Policy Rules
leave_policy_rules
------------------
id
tenant_id
leave_policy_id
leave_type_id
annual_entitlement
accrual_type
carry_forward_allowed
maximum_carry_forward
allow_negative_balance
minimum_notice_days
maximum_consecutive_days
requires_document_after_days
created_at
updated_at
Accrual:
ANNUAL
MONTHLY
PERIODIC
MANUAL
NONE

426. Policy Assignment
Different staff may have different policies.
staff_leave_policy_assignments
------------------------------
id
tenant_id
teacher_id
leave_policy_id
effective_from
effective_until
status
created_at
updated_at
The domain references Teacher Management but does not own teacher identity.

427. Leave Entitlement
An entitlement represents what a teacher is allowed to use.
leave_entitlements
------------------
id
tenant_id
teacher_id
leave_type_id
policy_id
period_start
period_end
entitled_units
carried_forward_units
adjusted_units
used_units
available_units
status
created_at
updated_at
version
available_units can be maintained as a derived/read-optimized value.

428. Leave Balance Integrity
Conceptually:
Available
=
Entitled
+
Carry Forward
+
Adjustments
-
Approved Used
Pending applications must not normally reduce the permanent balance unless the tenant explicitly enables reservation behavior.

429. Leave Balance Reservation
For high-concurrency environments, an approved application consumes balance transactionally.
Two simultaneous approvals must not both consume the same remaining entitlement.
Use:
transaction
row lock or optimistic version
final balance revalidation

430. Leave Application
leave_applications
------------------
id
tenant_id
teacher_id
leave_type_id
period_start
period_end
requested_units
reason
status
submitted_at
created_at
updated_at
version
Status:
DRAFT
SUBMITTED
UNDER_REVIEW
APPROVED
REJECTED
CANCELLED
WITHDRAWN

431. Half-Day Leave
Do not represent half-day as a decimal date range alone.
Use explicit fields:
start_date
end_date
start_part
end_part
requested_units
Parts:
FULL_DAY
FIRST_HALF
SECOND_HALF
This avoids ambiguity around dates and timezone.

432. Leave Documents
Documents are handled through the common File Service.
leave_application_documents
---------------------------
id
tenant_id
leave_application_id
file_id
document_type
created_at
The Leave domain stores metadata/references, not file contents.

433. Leave Approval Workflow
Draft
 ↓
Submitted
 ↓
Under Review
 ↓
Approved / Rejected
Approval authority should be permission-driven.
Possible scope:
OWN_REQUEST
DEPARTMENT
ASSIGNED_STAFF
TENANT_WIDE

434. Approval Chain
V1 should support a simple approval model:
Requester
 ↓
Authorized Approver
The data model should allow future multi-level approval without requiring a redesign.
leave_approval_steps
--------------------
id
tenant_id
leave_application_id
sequence
approver_user_id
status
acted_at
remarks

435. Leave Cancellation
An approved leave should not simply be deleted.
APPROVED
   ↓
CANCELLATION_REQUESTED
   ↓
CANCELLED
Whether cancellation requires approval should be configurable.
The consumed balance is restored transactionally.

436. Leave Application Amendment
Once submitted, significant changes should create an amendment workflow rather than silently modifying the request.
Examples:
changed dates
changed leave type
changed duration
Recommended:
Original Application
       ↓
Amendment Request
       ↓
Approval

437. Holiday Calendar
Holiday configuration is separate from leave.
holiday_calendars
-----------------
id
tenant_id
academic_year_id
name
code
status
created_at
updated_at

438. Holidays
holidays
--------
id
tenant_id
holiday_calendar_id
holiday_date
name
holiday_type
status
created_at
updated_at
Types:
PUBLIC
SCHOOL
OPTIONAL
OTHER

439. Holiday Rules
Whether a holiday counts toward leave duration must be configurable.
For example:
Leave:
Friday → Monday

Saturday/Sunday
↓
Excluded

Monday
↓
Included
The calculation service determines requested leave units.

440. Leave Calculation Service
Use a dedicated service:
calculateLeaveUnits({
  teacherId,
  leaveTypeId,
  startDate,
  endDate,
  startPart,
  endPart
})
It evaluates:
holidays
configured working days
half days
policy rules
effective dates

441. Working Calendar
A tenant may configure working days.
working_calendars
-----------------
id
tenant_id
academic_year_id
name
status
working_calendar_days
--------------------
id
tenant_id
working_calendar_id
day_of_week
is_working_day

442. Teacher Availability
Leave alone is not sufficient to represent availability.
Introduce:
staff_availability
------------------
id
tenant_id
teacher_id
date
availability_status
source_type
source_id
reason
created_at
updated_at
Status:
AVAILABLE
UNAVAILABLE
PARTIALLY_AVAILABLE

443. Availability Sources
Examples:
APPROVED_LEAVE
HOLIDAY
MANUAL_OVERRIDE
TRAINING
MEETING
OTHER
Approved leave automatically contributes an unavailable period.

444. Manual Availability Override
An administrator may override availability where permitted.
Example:
Teacher on approved leave
but
called in for a specific event
This should be explicit and audited.
Do not modify the original leave application to represent the exception.

445. Timetable Integration
When leave becomes approved:
Leave Approved
      ↓
Teacher Availability Updated
      ↓
Affected Timetable Entries Identified
      ↓
Substitution Workflow
Leave does not directly rewrite timetable entries.

446. Substitution Integration
Timetable owns substitution.
Leave emits an event:
TeacherAvailabilityChanged
Timetable can then identify:
affected classes
affected periods
potential substitute teachers

447. Substitute Eligibility
Candidate substitutes can be filtered by:
active teacher
availability
relevant subject assignment
timetable conflict
class assignment rules
tenant permissions
Teacher Management remains authoritative for teacher qualifications/assignments.

448. Leave and Attendance
Teacher attendance should not be implemented inside this domain unless Staff Attendance is later introduced.
Leave provides absence context.
If Staff Attendance is added later:
Leave
 ↓
Staff Attendance
through a domain interface/event.

449. Leave Permissions
leave.view
leave.apply
leave.update_own
leave.cancel_own

leave.review
leave.approve
leave.reject
leave.cancel_any

leave_type.view
leave_type.manage

leave_policy.view
leave_policy.manage

leave_balance.view
leave_balance.adjust

holiday.view
holiday.manage

staff_availability.view
staff_availability.manage

450. Self-Service Scope
A teacher should normally be able to:
create own application
view own applications
cancel own eligible applications
view own balance
view own approved leave
A teacher should not automatically be able to:
approve own leave
adjust own balance
modify policy
override availability

451. Leave APIs
Leave types:
/api/v1/leave-types
/api/v1/leave-types/:id
Policies:
/api/v1/leave-policies
/api/v1/leave-policies/:id
Applications:
/api/v1/leave-applications
/api/v1/leave-applications/:id
/api/v1/leave-applications/:id/submit
/api/v1/leave-applications/:id/approve
/api/v1/leave-applications/:id/reject
/api/v1/leave-applications/:id/cancel
Balances:
/api/v1/teachers/:teacherId/leave-balances
Holidays:
/api/v1/holiday-calendars
/api/v1/holidays
Availability:
/api/v1/staff-availability
/api/v1/teachers/:teacherId/availability

452. Leave Application Services
CreateLeaveApplication
SubmitLeaveApplication
ReviewLeaveApplication
ApproveLeaveApplication
RejectLeaveApplication
CancelLeaveApplication

CalculateLeaveBalance
AdjustLeaveBalance

CreateLeaveType
CreateLeavePolicy
AssignLeavePolicy

CreateHoliday
UpdateHoliday

SetAvailabilityOverride

453. Leave Events
LeaveApplicationCreated
LeaveApplicationSubmitted
LeaveApplicationApproved
LeaveApplicationRejected
LeaveApplicationCancelled

LeaveBalanceAdjusted
LeaveBalanceConsumed
LeaveBalanceRestored

HolidayCreated
HolidayUpdated

TeacherAvailabilityChanged

454. Approval Transaction
Approval should atomically perform:
validate application
+
revalidate balance
+
consume balance
+
approve application
+
update availability
+
write audit
+
write outbox event
This prevents a partially approved leave.

455. Rejection
Rejection does not consume balance.
SUBMITTED
 ↓
REJECTED
Reason should be retained.

456. Leave Balance Adjustment
Manual adjustments require:
amount
reason
actor
timestamp
Never directly edit available_units.
Use an adjustment record:
leave_balance_adjustments
-------------------------
id
tenant_id
teacher_id
leave_type_id
units
reason
adjustment_type
created_by
approved_by
created_at

457. Leave Balance Ledger
For stronger financial-style integrity, treat leave balances as a ledger.
ENTITLEMENT
CARRY_FORWARD
ADJUSTMENT
CONSUMPTION
RESTORATION
EXPIRY
The current balance becomes a derived value.
This provides much better historical explainability than repeatedly overwriting a balance field.

458. Leave Concurrency
Example:
Remaining = 2 days

Request A = 2 days
Request B = 2 days
Both cannot be approved.
The approval transaction must re-read/revalidate the balance under appropriate locking/version control.

459. Leave Audit
Audit:
policy changes
entitlement changes
manual balance adjustments
application submission
approval/rejection
cancellation
availability overrides
holiday changes
Especially sensitive:
balance adjustment
approval override
manual availability override

460. Leave Database Indexes
leave_types:
  tenant_id, code UNIQUE

leave_policies:
  tenant_id, code UNIQUE

leave_policy_rules:
  tenant_id, leave_policy_id, leave_type_id UNIQUE

staff_leave_policy_assignments:
  tenant_id, teacher_id, effective_from

leave_entitlements:
  tenant_id, teacher_id, leave_type_id, period_start

leave_applications:
  tenant_id, teacher_id, status
  tenant_id, start_date, end_date

holidays:
  tenant_id, holiday_calendar_id, holiday_date UNIQUE

staff_availability:
  tenant_id, teacher_id, date

461. Leave Overlap Detection
A teacher should not normally have overlapping approved leave.
For two intervals:
existing_start <= new_end
AND
existing_end >= new_start
indicates an overlap.
Half-day logic must also be considered when dates are the same.

462. Leave History
Never delete historical leave.
Use:
CANCELLED
REJECTED
WITHDRAWN
states as appropriate.
Historical approvals remain auditable.

463. Tenant Isolation
All leave tables are tenant-owned.
Every repository operation requires:
TenantContext
Teacher IDs supplied by clients must be checked against the current tenant through authoritative domain/application interfaces.

464. Leave Module Contract
Leave & Availability
│
├── Leave Types
├── Leave Policies
├── Entitlements
├── Leave Balances
├── Applications
├── Approvals
├── Holidays
├── Working Calendars
└── Staff Availability
Core lifecycle:
Leave Request
 ↓
Validation
 ↓
Approval
 ↓
Balance Consumption
 ↓
Availability Change
 ↓
Timetable/Substitution Reaction
The important architectural boundary is:
Leave determines that a teacher is unavailable; Timetable determines what scheduled work is affected and how substitution is handled.

Next Domain
The next implementation specification will cover Communication & Notifications: notification templates, channels, recipients, announcements, parent/student/teacher messaging, delivery tracking, retries, preferences, and tenant-safe asynchronous notification processing.
