<!-- Source: Apple Notes, folder 'Notes' -->
# Part 24 — Leave & Staff Operations

This domain handles operational staff availability, leave, and related workflows.
The key boundary is:
Leave & Staff Operations owns staff availability and leave workflows. It does not own teacher identity, payroll, timetable, or attendance.
This distinction becomes important because several existing domains will consume staff availability.

24.1 Domain Purpose
Leave & Staff Operations
├── Staff Leave
├── Leave Types
├── Leave Policies
├── Leave Balances
├── Leave Requests
├── Leave Approvals
├── Staff Availability
├── Staff Calendar
└── Staff Operational Status
Potential future extensions:
├── Staff Attendance
├── HR Documents
├── Performance
├── Recruitment
├── Payroll Integration
└── Workforce Planning
These should remain separate capabilities.

24.2 Staff vs Teacher
The existing Teacher domain represents teaching personnel.
But schools may have:
Teacher
Administrative Staff
Librarian
Accountant
Support Staff
Driver
Other Staff
Therefore, the architecture should eventually distinguish:
Person / User
      ↓
Staff Record
      ├── Teacher
      ├── Librarian
      ├── Accountant
      └── Other Staff
However, we should not prematurely redesign Teacher Management into a generic HR system.
For V1, Teacher Management can remain the primary staff domain, while Leave supports staff identities through stable references.

24.3 What Leave Owns
Leave owns:
Leave types
Leave policies/configuration
Leave requests
Leave approvals
Leave balances
Leave periods
Staff availability resulting from approved leave
It references:
Teacher/staff
User/membership
Academic calendar
Timetable
It does not own:
Teacher profile
Employment contract
Salary
Payroll
Timetable entries
Attendance records

24.4 Leave Types
Examples:
Casual Leave
Sick Leave
Annual Leave
Maternity Leave
Emergency Leave
Unpaid Leave
Other
Do not hardcode these.
Each school may have different policies.

24.5 Leave Policy
A leave policy may define:
Leave Type
Eligibility
Annual Allocation
Carry Forward
Maximum Consecutive Days
Minimum Notice
Approval Requirement
Attachment Requirement
Policies should be configurable.

24.6 Leave Balance
A staff member may have:
Annual Leave
Allocated: 20
Used: 8
Pending: 2
Available: 10
But balance should not simply be a manually editable number.
A useful conceptual model is:
Opening / Allocation
+
Adjustments
-
Approved Usage
=
Effective Balance
This provides history.

24.7 Leave Request
A request represents the employee's intent.
Leave Request
├── Staff
├── Leave Type
├── Start Date
├── End Date
├── Duration
├── Reason
├── Attachment
├── Status
└── Approval History

24.8 Leave Request Lifecycle
Recommended:
Draft
 ↓
Submitted
 ↓
Under Review
 ↓
Approved
Alternative paths:
Rejected
Cancelled
Withdrawn
Potentially:
Approved
 ↓
Taken
depending on how the organization wants leave accounting represented.

24.9 Approval
Approval is separate from permission.
A user may have:
leave.request.create
without having:
leave.request.approve
This follows the platform's general authorization model.

24.10 Approval Hierarchy
Schools may eventually configure:
Teacher
 ↓
Section/Class Coordinator
 ↓
School Admin
or:
Teacher
 ↓
Principal
Do not hardcode one hierarchy.
The workflow should support configurable approval rules.

24.11 Self-Approval Prevention
A user should generally not approve their own leave request unless an explicitly configured policy allows it.
At minimum:
Requester ≠ Approver
for standard approval workflows.

24.12 Date-Based Leave
Example:
Start: 2026-08-10
End:   2026-08-12
The system needs a school-calendar-aware duration calculation.
If weekends/holidays are excluded by policy:
Requested: 3 calendar days
Working leave days: 2
The exact rule should be configurable.

24.13 Partial-Day Leave
Some schools need:
Half Day
First Half
Second Half
Specific Hours
Do not assume every leave request is a whole number of days.
The data model should support duration semantics without forcing all schools to use them.

24.14 Leave Attachments
Some leave types may require supporting documentation.
Files should use the existing:
Common File Service
rather than a leave-specific storage system.
Files remain:
Private
Tenant-scoped
Permission-controlled
Audited

24.15 Leave and Timetable
This is one of the most important cross-domain relationships.
When:
Teacher A
Approved Leave
Monday
the Leave domain should not modify the timetable.
Instead:
Leave
 ↓
Staff Unavailable Event
 ↓
Timetable / Operations
 ↓
Identify affected classes
 ↓
Substitution workflow
This preserves ownership.

24.16 Example
Normal timetable:
Monday 10:00
Class 8A
Mathematics
Teacher A
Teacher A gets approved leave.
The resulting flow:
Leave Approved
      ↓
Teacher Unavailable
      ↓
Timetable identifies conflict
      ↓
Substitute Teacher B
      ↓
Substitution Record
Leave owns the absence.
Timetable owns the replacement schedule.

24.17 Leave Does Not Automatically Create Substitution
This is an important boundary.
An approved leave should not automatically change the timetable.
Instead, the school can have:
Automatic impact detection
followed by:
Substitution planning
This allows schools to decide how substitutions are handled.

24.18 Staff Availability
Leave is one source of unavailability.
The broader concept is:
Staff Availability
Possible reasons:
Leave
Other Assignment
Training
Meeting
Unavailable
Working
This gives future scheduling systems a more useful abstraction.

24.19 Availability vs Leave
They are not identical.
Leave:
Why is the employee absent?
Availability:
Can this person be scheduled at this time?
Therefore:
Leave
  ↓
Availability Impact
but availability can also have other sources.

24.20 Teacher Availability
Timetable may eventually ask:
Is Teacher A available
Monday 10:00–11:00?
The Leave domain can answer based on approved leave.
It should not require Timetable to know leave policy internals.

24.21 Staff Operational Status
Leave should also distinguish temporary availability from employment status.
For example:
Teacher Status:
Active
while:
Availability:
On Leave
The teacher is still an active employee.
Do not change Teacher status to Inactive merely because someone takes leave.

24.22 Long-Term Leave
For extended leave:
Teacher
 ↓
Approved Leave
 ↓
Unavailable Period
Timetable may need to identify all affected sessions.
This should be an impact-analysis workflow rather than a hidden side effect.

24.23 Leave Conflict Detection
Before approval, the system may validate:
Overlapping leave
Insufficient balance
Policy violation
Invalid dates
Required attachment missing
Existing conflicting status
Depending on school policy, some may be blocking and some warning-only.

24.24 Leave Balance Concurrency
Two approvals happening simultaneously must not allow:
Available balance = 1 day

Request A = 1 day
Request B = 1 day

Both approved
The balance transaction must be concurrency-safe.
Use:
transaction,
versioning,
appropriate database constraints/locking.

24.25 Leave Adjustment
Authorized administrators may need to correct balances.
Example:
+2 days
Reason: Administrative correction
Approved By: Admin
Adjustments should never silently rewrite historical usage.

24.26 Leave Carry Forward
A policy may define:
2026 balance
 ↓
Carry Forward
 ↓
2027 allocation
The exact rules should remain configuration-driven.

24.27 Expiry of Leave Balance
Some leave may expire at the end of:
Academic Year
Calendar Year
Employment Year
Again, policy-driven.

24.28 Leave Permissions
Initial permissions:
leave.view
leave.create
leave.update
leave.cancel
leave.submit
leave.approve
leave.reject
leave.export
Configuration:
leave_policy.view
leave_policy.manage
leave_type.manage
leave_balance.view
leave_balance.adjust
Sensitive actions:
leave_balance.adjust
leave.approve
should be strongly audited.

24.29 Self-Service
A teacher may have:
leave.view_own
leave.create_own
leave.cancel_own
leave.view_balance_own
while administrators have broader permissions.
This is a good example of why:
+
Permission
+
Scope
is better than hardcoded role checks.

24.30 Feature Structure
Initial:
Leave & Staff Operations
├── Leave Types
├── Leave Policies
├── Leave Requests
├── Leave Approvals
├── Leave Balances
└── Staff Availability
Future:
├── Staff Attendance
├── Staff Calendar
├── Performance
├── Recruitment
└── HR Documents

24.31 Staff Attendance Is Separate
Do not merge:
Staff Leave
with:
Staff Attendance
They answer different questions.
Leave:
"Was the person authorized to be absent?"
Attendance:
"Was the person present?"
A future Staff Attendance domain can consume leave information.

24.32 Payroll Boundary
Payroll should remain separate.
Leave may provide:
Approved unpaid leave days
Payroll may consume that information.
But Leave should not calculate:
Salary
Deduction
Tax
Net Pay
Those belong to Payroll/Finance.

24.33 HR Boundary
Likewise, HR may eventually own:
Employment Contract
Position
Department
Compensation
Career History
Leave only references the staff identity/employment context required for its rules.

24.34 Events
Leave may emit:
LeaveRequested
LeaveSubmitted
LeaveApproved
LeaveRejected
LeaveCancelled

LeaveBalanceAdjusted

StaffUnavailable
StaffAvailable
The exact event set can be refined later.

24.35 Event Consumers
For example:
LeaveApproved
      │
      ├──→ Timetable
      │      └── Identify affected classes
      │
      ├──→ Communication
      │      └── Notify relevant people
      │
      └──→ Staff Attendance
             └── Apply approved leave context
This is a clean dependency pattern.

24.36 Audit
Audit:
Leave created
Leave submitted
Leave approved/rejected
Leave cancelled
Policy changed
Balance adjusted
Approval authority changed
For balance adjustments:
Before
After
Reason
Actor
Approver
Timestamp
should be retained.

24.37 Reports
Initial reports:
Leave Summary
Leave by Type
Staff Currently on Leave
Leave Balance
Pending Approvals
Leave History
Department/Staff Leave Trends
These are operational reports.
Payroll reports remain outside this domain.

24.38 Tenant Isolation
All leave information is tenant-owned:
Leave Policy
Leave Type
Leave Request
Leave Balance
Leave Approval
Availability
Cross-tenant access is prohibited.

24.39 Configuration Versioning
Leave policies can change.
Example:
2026 Policy
Annual Leave = 20 days

2027 Policy
Annual Leave = 24 days
Historical leave should retain the policy context necessary to explain how its balance/duration was determined.
Do not retroactively recalculate historical approved leave merely because configuration changed.

24.40 Failure Scenarios
Approval conflict
Two administrators attempt to approve the same request:
First approval → succeeds
Second approval → conflict / already processed
Balance race
Two requests consume the same balance:
Transaction prevents over-allocation
Timetable impact
Leave approved while timetable is active:
Leave approved
 ↓
Impact event
 ↓
Affected sessions identified
 ↓
Substitution workflow
No silent timetable mutation.

24.41 Entitlement
Core capability:
staff.leave
Potential future:
staff.attendance
staff.hr
staff.performance
These should remain separate if commercially useful.

24.42 Final Domain Relationship
             TEACHER / STAFF
                   │
                   ↓
             LEAVE DOMAIN
                   │
        ┌──────────┼──────────┐
        ↓          ↓          ↓
     Balance    Approval   Availability
                              │
                              ↓
                         TIMETABLE
                              │
                              ↓
                         Substitution
And separately:
Leave
  ↓
Staff Attendance
and:
Leave
  ↓
Payroll
when those domains are eventually introduced.

24.43 Important Architectural Decision
The most important decision from this domain is:
LEAVE
  ≠
TIMETABLE
  ≠
STAFF ATTENDANCE
  ≠
PAYROLL
  ≠
HR
They interact, but they should not become one large "Staff Management" domain.
This keeps future HR/payroll expansion possible without destabilizing Teacher Management.

Updated Domain Map
We now have:
Platform
├── Identity / RBAC
├── Tenant Management
├── Plans / Billing / Entitlements
├── Audit
└── Platform Services

School Domains
├── Student
├── Academic
├── Teacher
├── Attendance
├── Examination
├── Fees
├── Transportation
├── Communication
├── Timetable
├── Library
└── Leave / Staff Operations
Next: Part 25 — Parent / Guardian Portal.
