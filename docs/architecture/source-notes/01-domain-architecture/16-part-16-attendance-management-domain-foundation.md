<!-- Source: Apple Notes, folder 'Notes' -->
# Part 16 — Attendance Management Domain Foundation

Attendance is the first domain where the previously designed pieces start interacting heavily:
Student
   +
Enrollment
   +
Academic Structure
   +
Teacher Assignment
   ↓
Attendance
The key principle is:
Attendance records an attendance event/status for a student within an explicit academic context. It does not own the student, class, teacher, or academic structure.

16.1 Domain Purpose
Attendance Management should handle:
Attendance
│
├── Attendance Configuration
├── Attendance Sessions
├── Student Attendance
├── Attendance Statuses
├── Attendance Corrections
├── Attendance Approval
└── Attendance Reports
Potential future capabilities:
├── Leave Integration
├── Late/Arrival Tracking
├── Biometric Integration
├── Device Integration
└── Parent Notifications
These should not be forced into V1.

16.2 Attendance Ownership
Attendance owns:
Attendance Session
Attendance Record
Attendance Status
Attendance Correction
It references:
Student
Enrollment
Academic Year
Class / Section
Subject/Offering where applicable
Teacher
It does not own those entities.

16.3 Attendance Must Have Context
Avoid an ambiguous record such as:
student_id
date
present
because the same student could have:
multiple classes,
multiple sessions,
multiple subjects,
different academic years.
Instead, attendance should have an explicit context.
Conceptually:
Attendance Session
├── Tenant
├── Academic Year
├── Date
├── Session Type
├── Class / Section
├── Subject / Offering (if applicable)
├── Recorded By
└── Status
Then:
Attendance Record
├── Session
├── Student / Enrollment
├── Attendance Status
└── Metadata

16.4 Two Major Attendance Models
Schools commonly need different attendance models.
Daily Attendance
Student
 ↓
School Day
 ↓
Present / Absent / Late / etc.
Period / Subject Attendance
Student
 ↓
Period
 ↓
Subject
 ↓
Present / Absent / etc.
We should support both conceptually without forcing every school to use period-level attendance.

16.5 Attendance Configuration
A school should be able to configure its attendance model.
For example:
Attendance Mode
├── Daily
├── Period
└── Both
This belongs to school/domain configuration, not hardcoded application logic.

16.6 Attendance Status
Do not hardcode only:
present = true/false
Instead, use configurable attendance statuses.
Examples:
Present
Absent
Late
Half Day
Excused
Leave
Each status can have semantic properties such as:
Counts as Present?
Counts as Absent?
Requires Reason?
Requires Approval?
The exact status catalog can be configured later.

16.7 Status vs Reason
Keep these separate.
Example:
Status = Absent
Reason = Medical Leave
or:
Status = Late
Reason = Transport Delay
The status describes the attendance outcome.
The reason describes why.

16.8 Attendance Session
A session provides the context in which attendance is recorded.
Example:
2026-09-28
Grade 6A
Morning Attendance
Recorded By Teacher A
For subject attendance:
2026-09-28
Grade 6A
Mathematics
Period 2
Teacher A
This gives us a clear audit boundary.

16.9 Who Can Create an Attendance Session?
The system should authorize based on permissions and scope.
Examples:
Attendance Admin
    → Any authorized class

Class Coordinator
    → Assigned classes

Teacher
    → Assigned sections/subjects
The teacher should not gain school-wide attendance access simply because they have:
attendance.mark
Their teaching assignment provides the contextual scope.

16.10 Attendance Permission Model
Initial permissions:
attendance.view
attendance.create
attendance.update
attendance.delete
attendance.submit
attendance.approve
attendance.correct
attendance.export
Potentially:
attendance.manage_statuses
attendance.manage_configuration
These should be restricted to appropriate administrative roles.

16.11 Marking Attendance
A normal workflow:
Teacher
 ↓
Select Academic Context
 ↓
Select Class / Section
 ↓
Select Date / Session
 ↓
System loads enrolled students
 ↓
Mark attendance
 ↓
Validate
 ↓
Submit
The system should not allow arbitrary student IDs to be submitted without checking that the student belongs to the selected enrollment/context.

16.12 Default Attendance
For usability, the UI can default students to:
Present
and let the teacher mark exceptions.
But the backend must still explicitly create/validate the resulting attendance state.
UI defaults are not business rules.

16.13 Attendance Submission
Attendance can have a workflow:
Draft
 ↓
Submitted
 ↓
Approved
or for simpler schools:
Draft
 ↓
Final
The actual workflow can be configurable.
This is useful because some schools may allow teachers to finalize attendance directly while others require approval.

16.14 Attendance Corrections
Attendance errors are inevitable.
We should not simply allow unrestricted editing forever.
A controlled workflow:
Final Attendance
       ↓
Correction Requested
       ↓
Review
       ↓
Approved
       ↓
Attendance Updated
For simpler configurations:
Authorized User
       ↓
Edit
       ↓
Audit
The architecture should support both without forcing a complex approval process on every school.

16.15 Never Lose the Original Change History
Suppose:
Present
is changed to:
Absent
The system should retain audit information:
Before: Present
After: Absent
Actor: User X
Time: ...
Reason: ...
For sensitive corrections, the reason should be mandatory.

16.16 Attendance and Enrollment
Attendance should reference the student's enrollment/context, not merely a global student record.
Conceptually:
Student
   ↓
Enrollment
   ↓
Attendance
This prevents historical ambiguity.
For example:
Student A
2025–26 → Grade 5A
2026–27 → Grade 6B
Attendance for 2025–26 remains tied to the correct academic enrollment.

16.17 Attendance and Class Changes
If a student moves:
Grade 6A
    ↓
Grade 6B
future attendance uses the new enrollment.
Historical attendance remains associated with the old enrollment.
We should never rewrite historical attendance merely because the student's current class changed.

16.18 Attendance and Teacher Assignment
For subject/period attendance:
Teacher
 ↓
Teaching Assignment
 ↓
Subject Offering
 ↓
Attendance Session
The backend can verify:
Is this teacher authorized to record attendance for this session?
This should use the common authorization + scope mechanism rather than hardcoded teacher checks.

16.19 Attendance and Daily School Attendance
Daily attendance may not require a specific teacher/subject.
For example:
Morning Attendance
Grade 6A
Teacher/Staff X
Therefore:
Teacher Assignment
should not be a universal mandatory relationship.
Attendance context must support different session types.

16.20 Attendance Configuration by School
Schools may differ in:
Daily vs period attendance
Attendance statuses
Approval workflow
Late rules
Correction policy
Who can mark attendance
Who can approve
These belong in configuration rather than application-level constants.

16.21 Late Attendance
If late tracking is required, avoid turning it into an unrelated boolean.
Conceptually:
Status = Late
Arrival Time = 08:17
or:
Status = Present
Late = true
Arrival Time = 08:17
Which model is correct depends on how the school wants reporting to work.
We should finalize this during detailed Attendance requirements rather than prematurely locking the database representation.

16.22 Leave Integration
Attendance should not necessarily own leave requests.
A future Leave domain might own:
Leave Request
Leave Approval
Leave Balance
Attendance consumes the result:
Approved Leave
      ↓
Attendance
      ↓
Excused / Leave
This prevents Attendance from becoming a leave-management system.

16.23 Parent Notifications
Attendance events may later trigger:
Student absent
       ↓
Domain Event
       ↓
Notification
       ↓
Parent
Attendance should not directly implement:
WhatsApp
SMS
Email
Push
Instead:
Attendance
 ↓
Event
 ↓
Notification Service

16.24 Attendance Reports
Attendance Management can own reports such as:
Daily Attendance
Student Attendance History
Class Attendance
Section Attendance
Monthly Attendance
Attendance Percentage
Absence Report
Late Report
Cross-domain reports can later use the reporting layer.
For example:
Attendance + Fees + Academic Performance
should not become a responsibility of Attendance itself.

16.25 Attendance Percentage
A conceptual calculation:
Attendance %
=
Eligible Attendance Units
/
Expected Attendance Units
× 100
But the definition of an "attendance unit" depends on the school's mode.
Daily:
1 school day = 1 unit
Period-based:
1 period = 1 unit
Therefore the calculation engine should use the configured attendance model.

16.26 Attendance Eligibility
Not every student necessarily belongs in every attendance session.
For example:
Student A
enrolled in Grade 6A
should appear in Grade 6A attendance.
But:
Student B
enrolled in Grade 7A
must not appear.
The system should derive the expected roster from enrollment/context rather than accepting arbitrary student lists from the client.

16.27 Attendance Roster Snapshot
There is an important historical question.
Suppose the roster is:
10 students
and later one student transfers.
Should historical attendance change?
No.
Therefore attendance should preserve enough context to ensure historical records remain meaningful even when enrollment changes later.
The exact snapshot strategy can be finalized during database design.

16.28 Bulk Attendance
For a class:
Grade 6A
35 students
attendance is naturally a bulk operation.
It should be treated as one business transaction where practical:
Load roster
 ↓
Validate
 ↓
Submit attendance
 ↓
Commit
We should avoid a partially saved attendance session where half the students are updated and the other half silently fail.

16.29 Idempotency
Attendance submission can be retried due to:
network failure,
browser retry,
mobile retry,
API timeout.
Therefore a submission should have a clear idempotency strategy.
Example:
Same session
+
Same submission token
=
One logical submission
This prevents duplicate attendance records.

16.30 Mobile / Offline Consideration
Teacher attendance will likely eventually be used heavily on mobile devices.
The architecture should not prevent:
Mobile App
   ↓
Attendance API
and potentially:
Offline
 ↓
Local pending attendance
 ↓
Sync
 ↓
Server validation
But offline synchronization should be deferred until the core attendance model is stable.

16.31 Attendance Feature Structure
Initial feature:
Attendance Management
│
├── Daily Attendance
├── Subject / Period Attendance
├── Attendance Records
├── Attendance Corrections
└── Attendance Reports
Potential later sub-features:
├── Late Tracking
├── Leave Integration
├── Notifications
├── Biometric Integration
└── Offline Attendance
Commercial independence of these sub-features should only be introduced if the pricing model requires it.

16.32 Attendance Dependencies
Attendance depends conceptually on:
Student Management
Academic Structure
and optionally:
Teacher Management
for teacher-recorded attendance.
So:
Student
   +
Academic Context
   +
Optional Teacher Assignment
   ↓
Attendance

16.33 Audit Requirements
Audit:
Attendance session creation
Attendance submission
Attendance modification
Attendance finalization
Attendance approval
Attendance correction
Attendance deletion/cancellation
Bulk attendance operations
Configuration changes
Status changes
For corrections:
Original
New Value
Actor
Reason
Timestamp
should be available.

16.34 Events
Useful domain events:
AttendanceSessionCreated
AttendanceSubmitted
AttendanceFinalized
AttendanceApproved
AttendanceCorrected
AttendanceCancelled
Potential future event:
StudentMarkedAbsent
This could trigger notifications.

16.35 Attendance Security
A user must not be able to submit:
tenant_id = School B
while operating in School A.
Likewise, a teacher cannot simply submit:
class_id = arbitrary class
and bypass assignment scope.
The backend verifies:
Authentication
+
Membership
+
Tenant
+
Feature Entitlement
+
Permission
+
Academic Scope
+
Enrollment Validity

16.36 Attendance Conceptual Model
School
  │
  └── Academic Year
        │
        └── Class / Section
               │
               └── Enrollment
                     │
                     └── Student
                            │
                            ↓
                    Attendance Session
                            │
                            ↓
                    Attendance Records
                            │
                     ┌──────┴──────┐
                     ↓             ↓
                  Status        Metadata
For subject attendance:
Teacher
   ↓
Teaching Assignment
   ↓
Subject Offering
   ↓
Attendance Session

16.37 What We Should Not Finalize Yet
Intentionally deferred:
❌ Complete attendance database schema
❌ Exact attendance status catalog
❌ Exact late calculation
❌ Leave management
❌ Biometric integration
❌ Offline synchronization
❌ Parent notification rules
❌ Attendance percentage policy
❌ Country-specific attendance regulations
❌ Detailed approval workflow
These should be finalized during the detailed Attendance design phase.

16.38 Current Domain Map
We now have:
                       PLATFORM CORE
                            │
                            ↓
                       SCHOOL/TENANT
                            │
              ┌─────────────┼─────────────┐
              ↓             ↓             ↓
         ACADEMIC        STUDENT        TEACHER
         STRUCTURE       MANAGEMENT     MANAGEMENT
              │             │             │
              └─────────────┼─────────────┘
                            ↓
                       ATTENDANCE
                            │
                 ┌──────────┼──────────┐
                 ↓          ↓          ↓
              Reports    Events    Notifications
And the next major domain is Examination Management, because it can build directly on:
Student
Enrollment
Academic Year
Class / Section
Subject Offering
Teacher Assignment
That will also force us to define an important architectural concept: academic assessment structure and results/history, without mixing it into Student or Academic Management.
