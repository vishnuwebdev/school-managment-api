<!-- Source: Apple Notes, folder 'Core Database design system' -->
# Part 39 — Leave & Staff Operations Database Design

Leave & Staff Operations introduces a time-based availability model.
The key rule is:
Leave explains why a staff member is unavailable. Timetable decides what operational schedule is affected.
The core flow:
Staff / Teacher
      ↓
Leave Request
      ↓
Approval
      ↓
Leave Period
      ↓
Staff Unavailable
      ↓
Timetable Impact
      ↓
Substitution
Leave does not own teacher identity, timetable entries, or staff attendance.

39.1 Domain Ownership
Leave & Staff Operations owns:
Leave Types
Leave Policies
Leave Requests
Leave Approvals
Leave Allocations
Leave Adjustments
Leave Periods
Staff Availability
Operational Staff Status
It references:
Teacher / Staff
User / Membership
Academic Calendar
Timetable
It does not own:
Teacher
Payroll
Staff Attendance
Timetable
Substitution

39.2 Leave Type
A leave type describes what kind of leave is being requested.
leave_types
-----------
id
tenant_id
name
code
description
is_paid
requires_attachment
status
created_at
updated_at
Examples:
CASUAL
SICK
ANNUAL
MATERNITY
UNPAID
EMERGENCY
OTHER
These should be configurable.

39.3 Leave Policy
A policy determines how a leave type behaves.
leave_policies
--------------
id
tenant_id
leave_type_id
name
eligibility_rule
allocation_amount
allocation_period
carry_forward_rule
max_consecutive_days
notice_period
approval_required
effective_from
effective_to
status
created_at
updated_at
Do not put every possible rule into one generic JSON object.
Common rules should be structured.

39.4 Policy Versioning
Leave rules can change.
For example:
2026:
Annual Leave = 24 days

2027:
Annual Leave = 26 days
Historical leave should continue to reflect the policy under which it was approved.
Therefore policies should be effective-dated or versioned.

39.5 Leave Allocation
An allocation represents leave granted to a staff member.
leave_allocations
-----------------
id
tenant_id
staff_reference
leave_policy_id
period_start
period_end
allocated_units
created_at
updated_at
staff_reference may ultimately point to Teacher or another Staff entity depending on how broader Staff Management evolves.

39.6 Why Allocation Should Not Be Just a Balance
Avoid:
remaining_days = 12
as the only source of truth.
Instead:
Allocation
+
Adjustments
-
Approved/Taken Leave
=
Effective Balance
This preserves history.

39.7 Leave Adjustments
Manual corrections should be explicit.
leave_adjustments
-----------------
id
tenant_id
allocation_id
units
adjustment_type
reason
created_by
approved_by
created_at
Examples:
CARRY_FORWARD
MANUAL_GRANT
MANUAL_DEDUCTION
CORRECTION
EXPIRY

39.8 Leave Request
The request is the employee's workflow record.
leave_requests
--------------
id
tenant_id
staff_reference
leave_type_id
leave_policy_id
reason
status
requested_at
start_date
end_date
requested_units
created_at
updated_at
The request references the policy applicable at the time.

39.9 Partial-Day Leave
The model should support:
FULL_DAY
HALF_DAY
PARTIAL_DAY
For partial-day leave, the request may contain:
start_time
end_time
or an explicit unit value.
The exact representation should be finalized based on the school's attendance/calendar requirements.

39.10 Leave Request Lifecycle
Recommended:
DRAFT
   ↓
SUBMITTED
   ↓
UNDER_REVIEW
   ↓
APPROVED
Alternative outcomes:
REJECTED
CANCELLED
WITHDRAWN
Potentially:
TAKEN
if the school needs a distinction between approved future leave and leave that has actually occurred.

39.11 Approval
Approval should be a distinct business action.
Conceptually:
leave_approvals
---------------
id
tenant_id
leave_request_id
approver_id
decision
reason
approved_at
created_at
This provides an explicit history of who approved/rejected the request.

39.12 Multiple Approval Levels
The design should not prevent:
Teacher
 ↓
Department Head
 ↓
School Admin
if the school later requires multi-level approval.
For V1, a simple approval flow is sufficient.

39.13 Self-Approval
A fundamental business rule:
Requester
≠
Approver
unless an explicit administrative override is permitted.
This is an authorization/business rule, not merely a database constraint.

39.14 Leave Period
Once approved, the actual unavailable period should be represented clearly.
Conceptually:
leave_periods
-------------
id
tenant_id
leave_request_id
staff_reference
start_at
end_at
units
status
created_at
This separates:
request workflow
from:
actual availability consequence.

39.15 Why Leave Period Is Useful
A request can be:
Approved
while the leave period may be:
Future
The timetable needs to know:
Will this staff member be unavailable on September 28?
The Leave Period provides that operational answer.

39.16 Staff Availability
Availability should not simply be:
available = true/false
because availability may vary by:
date,
time,
reason,
assignment,
leave,
operational status.
Conceptually:
staff_availability
------------------
id
tenant_id
staff_reference
availability_type
start_at
end_at
source_type
source_reference
status
created_at

39.17 Availability Sources
Potential sources:
LEAVE
MANUAL
SCHEDULE
OTHER
Example:
Staff unavailable
Source = LEAVE
Reference = Leave Period #123
This is useful because Timetable should know why a person is unavailable when troubleshooting.

39.18 Leave Does Not Directly Modify Timetable
The correct relationship is:
Leave Approved
      ↓
Availability Event
      ↓
Timetable
      ↓
Affected Schedule
Not:
Leave Approved
      ↓
UPDATE timetable_entries
The published timetable remains intact.

39.19 Timetable Substitution
Timetable then handles:
Teacher A unavailable
      ↓
Affected entry
      ↓
Replacement Teacher B
      ↓
Substitution
Leave does not own the substitution.

39.20 Staff Operational Status
A teacher can be:
ACTIVE
and temporarily:
UNAVAILABLE
These are different concepts.
Likewise:
Teacher = TERMINATED
is not the same as:
Teacher = ACTIVE
Leave = APPROVED

39.21 Leave Balance
A balance is derived from allocation and usage.
Conceptually:
Allocated
+ Adjustments
- Approved/Taken
= Effective Balance
A materialized balance can be cached for performance, but the underlying allocation/usage history remains authoritative.

39.22 Balance Concurrency
Two leave requests may be submitted simultaneously.
Example:
Remaining = 2 days

Request A = 2 days
Request B = 2 days
The system must not approve both if policy prohibits over-allocation.
Approval should perform a transactional balance check.

39.23 Over-Allocation Policy
Some schools may allow:
negative balance
while others reject it.
Therefore:
allow_negative_balance
can be a policy/configuration rule rather than a universal assumption.

39.24 Calendar-Aware Leave
Leave duration should consider school calendar rules where appropriate.
For example:
Monday → Friday
may represent:

but only:

if Wednesday/Thursday are school holidays.
The exact calculation service should use the school's applicable calendar/configuration.

39.25 Academic Calendar Reference
Leave can reference school calendar configuration but should not own the calendar.
Conceptually:
School Calendar
      ↓
Working/Non-working Days
      ↓
Leave Duration Calculation
A future dedicated Academic Calendar domain can own the detailed calendar.

39.26 Attachments
Leave requests may require supporting documents.
Use:
leave_request
     ↓
file_id
     ↓
File Service
Do not store document binaries in the Leave table.

39.27 Leave Permissions
Examples:
leave.view
leave.create
leave.update
leave.submit
leave.cancel
leave.withdraw

leave.approve
leave.reject

leave.balance.view
leave.balance.adjust

leave.policy.view
leave.policy.manage

leave.type.view
leave.type.manage

leave.export
Self-service and administrative permissions can be separated.

39.28 Teacher Self-Service
A teacher may have:
leave.create
leave.view_own
leave.submit
leave.cancel_own
but not:
leave.approve
unless the organization explicitly allows it.

39.29 Manager Scope
A coordinator might have:
leave.view
leave.approve
scope = ASSIGNED_STAFF
while School Admin may have:
leave.manage
scope = ALL_TENANT
Scope remains separate from permission.

39.30 Events
Important events:
LeaveRequested
LeaveSubmitted
LeaveApproved
LeaveRejected
LeaveCancelled
LeaveWithdrawn
LeaveBalanceAdjusted
StaffUnavailable
StaffAvailable
Consumers:
Timetable
Communication
Reporting
Future Staff Attendance
Future Payroll

39.31 Communication Integration
After approval:
LeaveApproved
      ↓
Communication
      ↓
Requester notification
      +
Relevant administrator notification
The Leave transaction should not depend on successful SMS/email delivery.

39.32 Timetable Integration
After approval:
LeaveApproved
      ↓
StaffUnavailable
      ↓
Timetable
      ↓
Affected Entries
      ↓
Substitution Workflow
This should be asynchronous where possible.
The Leave approval itself should not need to wait for substitution processing.

39.33 Staff Attendance — Future
Future Staff Attendance can consume:
Approved Leave
to distinguish:
Absent
from:
On Approved Leave
But Staff Attendance remains a separate domain.

39.34 Payroll — Future
Payroll can consume:
Approved leave
Leave type
Paid/unpaid classification
Effective leave units
but Leave does not calculate payroll.

39.35 Leave Audit
Audit strongly recommended for:
Policy changes
Leave allocation changes
Leave approval/rejection
Manual balance adjustments
Leave cancellation
Administrative changes
Reasons should be captured for manual adjustments and overrides.

39.36 Leave Database Structure
Conceptually:
LEAVE / STAFF OPERATIONS
──────────────────────────
leave_types
leave_policies

leave_allocations
leave_adjustments

leave_requests
leave_approvals
leave_periods

staff_availability

39.37 Relationship Diagram
Leave Type
    │
    ↓
Leave Policy
    │
    ├────────→ Allocation
    │              │
    │              ↓
    │          Adjustments
    │
    ↓
Leave Request
    │
    ↓
Approval
    │
    ↓
Leave Period
    │
    ↓
Staff Unavailable
    │
    ↓
Timetable
    │
    ↓
Substitution

39.38 Staff Reference
One remaining architectural consideration is the broader Staff model.
Currently we have:
Teacher
Driver
Platform User
but future modules may introduce:
Accountant
Receptionist
Counselor
Librarian
Coordinator
Principal
Support Staff
Do not prematurely create a giant universal staff table.
For now, Leave should use an abstraction that can reference the appropriate staff entity without forcing all staff types into one domain.
The exact polymorphic/reference implementation can be finalized when broader HR is designed.

39.39 Avoid Generic Polymorphic Foreign Keys Where Possible
We should be cautious about simply creating:
staff_type
staff_id
everywhere.
That weakens database referential integrity.
A stronger future model may introduce a dedicated staff identity abstraction if HR becomes substantial.
For V1, Teacher can be the primary Leave participant, while the architecture remains extensible.

39.40 Teacher Leave in V1
The simplest safe implementation is:
leave_requests.teacher_id
if Teacher is the only staff population supported initially.
When broader Staff Management is introduced, we can extract a common staff identity layer.
This avoids over-engineering now.

39.41 Historical Leave
Approved leave must remain historical even if:
Teacher
→ Resigned
or:
Leave Policy
→ Changed
Therefore leave records retain their applicable policy/context references.

39.42 Effective Policy
When a request is submitted:
Find applicable policy
       ↓
Store policy reference/version
       ↓
Calculate request
       ↓
Approval
Do not recalculate an old approved request using today's policy.

39.43 Tenant Isolation
All Leave-owned records are tenant-scoped:
leave_types.tenant_id
leave_policies.tenant_id
leave_allocations.tenant_id
leave_adjustments.tenant_id
leave_requests.tenant_id
leave_approvals.tenant_id
leave_periods.tenant_id
staff_availability.tenant_id
A teacher from School A cannot consume or affect School B leave records.

39.44 Important Constraints
Potential constraints:
UNIQUE(tenant_id, leave_type.code)

UNIQUE(tenant_id, leave_policy.code)
For allocations, uniqueness should account for:
staff
+
policy
+
allocation period
For availability, overlapping records may be allowed if they have different sources, but contradictory overlapping availability should be detected.

39.45 Indexing
Likely high-value indexes:
leave_requests:
  (tenant_id, staff_id, status)
  (tenant_id, start_date, end_date)
  (tenant_id, status)

leave_periods:
  (tenant_id, staff_id, start_at, end_at)
  (tenant_id, status)

leave_allocations:
  (tenant_id, staff_id, period_start, period_end)

staff_availability:
  (tenant_id, staff_id, start_at, end_at)

39.46 Overlap Detection
Leave periods should be checked for conflicts.
For example:
Approved:
Sep 10–Sep 15

New request:
Sep 12–Sep 14
The system must determine whether overlapping leave is allowed.
This is a business rule rather than a simple uniqueness constraint.

39.47 Partial-Day Overlap
Similarly:
09:00–12:00
and:
11:00–14:00
may conflict even though they occur on the same date.
The application should use proper interval-overlap validation.

39.48 Leave vs Timetable
The relationship remains:
Leave
 ↓
Availability
 ↓
Timetable
Never:
Leave
 ↓
Owns Timetable Entry
This preserves the domain boundary.

39.49 Leave vs Attendance
Similarly:
Leave
 ↓
Approved Leave
 ↓
Staff Attendance
Staff Attendance is a future consumer.
Leave does not record whether the staff member actually checked in.

39.50 Leave vs Payroll
Leave
 ↓
Paid/Unpaid Classification
 ↓
Payroll
Leave does not calculate salary deductions.

39.51 Current Dependency Graph
After Leave:
Teacher
   │
   ├──→ Teaching Assignment
   │       ↓
   │    Timetable
   │
   └──→ Leave
           ↓
      Availability
           ↓
       Timetable
           ↓
      Substitution

Leave
 ├──→ Communication
 ├──→ Reporting
 └──→ Future Staff Attendance / Payroll
There is no ownership cycle.

39.52 Key Decisions Locked
✓ Leave Type is configurable
✓ Leave Policy is effective-dated/versioned
✓ Allocation is separate from balance
✓ Adjustments are explicit
✓ Leave Request is a workflow entity
✓ Approval is separate
✓ Approved Leave produces availability
✓ Timetable consumes availability
✓ Leave does not modify timetable directly
✓ Staff Attendance remains separate
✓ Payroll remains separate
✓ Leave history survives policy changes
✓ Partial-day leave is supported
✓ Attachments use File Service
✓ Financial effects are not owned by Leave

39.53 What This Enables
The model supports:
configurable leave types,
annual allocations,
carry-forward,
manual adjustments,
approval workflows,
partial-day leave,
attachments,
balance tracking,
teacher self-service,
administrator approval,
timetable impact,
future staff attendance,
future payroll integration.
without turning Leave into a full HR/payroll system.

Next: Part 40 — Communication + Parent Portal Database Design
This phase will cover two closely related but distinct layers:
Communication
├── Templates
├── Preferences
├── Notification Requests
├── Deliveries
├── In-App Notifications
├── Announcements
└── Communication History

Parent Portal
├── Portal Access
├── Guardian Scope
├── Portal Requests
└── Portal Read Models
The critical boundary will remain:
Business Domains
      ↓
Events
      ↓
Communication
      ↓
Delivery

Guardian
      ↓
Portal
      ↓
Existing Domain Data
The Portal will not become the owner of Student, Fees, Attendance, Examination, Library, or Transportation data.
