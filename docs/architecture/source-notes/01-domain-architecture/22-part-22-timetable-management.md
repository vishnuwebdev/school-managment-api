<!-- Source: Apple Notes, folder 'Notes' -->
# Part 22 — Timetable Management

Timetable Management defines when and where academic teaching is scheduled.
The key architectural rule is:
Timetable owns scheduling. It does not own teachers, subjects, students, or attendance.
Those domains provide references and constraints.

22.1 Domain Purpose
Timetable
├── Timetable Configuration
├── Academic Periods
├── Time Slots
├── Rooms / Locations
├── Timetable
├── Timetable Entries
├── Teacher Schedule
├── Class/Section Schedule
├── Substitutions
└── Timetable History
Future extensions:
├── Teacher Availability
├── Room Availability
├── Automatic Scheduling
├── Conflict Optimization
├── Free Periods
└── Mobile Timetable

22.2 Ownership
Timetable owns:
Time slots
Period definitions
Rooms/locations
Timetable definitions
Timetable entries
Scheduling constraints/configuration
Teacher/class/room schedule views
Substitution records
It references:
Academic Year
Class
Section
Subject
Subject Offering
Teacher
Teaching Assignment
It does not own those entities.

22.3 Basic Scheduling Relationship
The fundamental relationship is:
Academic Year
      ↓
Class / Section
      ↓
Subject / Offering
      ↓
Teacher Assignment
      ↓
Timetable Entry
      ↓
Day + Time + Room
Example:
Monday
09:00–09:45
Class 8-A
Mathematics
Teacher: T001
Room: R204

22.4 Timetable vs Actual Class Session
This distinction is important.
A timetable says:
"Class 8-A normally has Mathematics on Monday at 9:00."
An actual scheduled session says:
"Class 8-A's Mathematics session occurred/scheduled for
Monday, 9:00, with Teacher X."
Therefore:
Recurring Timetable
        ↓
Scheduled/Actual Session
The first describes the planned structure.
The second represents an actual operational occurrence.
This separation becomes important for:
substitutions,
cancellations,
holidays,
attendance,
room changes.

22.5 Timetable Configuration
Schools need configurable scheduling structures.
Examples:
School Day
├── Monday
├── Tuesday
├── Wednesday
├── Thursday
└── Friday
Time slots:
Period 1   08:30–09:15
Period 2   09:15–10:00
Break      10:00–10:15
Period 3   10:15–11:00
Do not hardcode "Period 1–8".

22.6 Time Slots
A time slot should represent scheduling time.
Conceptually:
Time Slot
├── Name
├── Start Time
├── End Time
├── Sequence
├── Type
└── Status
Types could include:
Teaching
Break
Assembly
Activity
Other
Not every slot must represent teaching.

22.7 Academic Calendar vs Timetable
These are different concepts.
Academic calendar:
School holiday
Exam period
Working day
Academic year dates
Timetable:
What happens during a normal teaching day.
The timetable may reference calendar information, but should not become the owner of school holidays.

22.8 Timetable Entry
A timetable entry can conceptually contain:
Timetable Entry
├── Academic Year
├── Class
├── Section
├── Subject Offering
├── Teacher
├── Day
├── Time Slot
├── Room
└── Status
Potentially:
Effective From
Effective To
for historical changes.

22.9 Teacher Assignment
Timetable should normally schedule an existing teaching assignment.
Teacher Management
      ↓
Teaching Assignment
      ↓
Timetable
This prevents arbitrary scheduling of a teacher against an unrelated subject/class.

22.10 Conflict Detection
Timetable's central business responsibility is conflict detection.
At minimum:
Teacher conflict
Teacher X
Monday 10:00
Class 7-A
cannot simultaneously be:
Teacher X
Monday 10:00
Class 8-B
Class conflict
Class 7-A
Monday 10:00
Mathematics
cannot simultaneously have:
Class 7-A
Monday 10:00
Science
Room conflict
If a room is exclusive:
Room R101
Monday 10:00
cannot be assigned to two simultaneous sessions.

22.11 Conflict Types
The system should distinguish:
Teacher Conflict
Class/Section Conflict
Room Conflict
Time Slot Conflict
Assignment Conflict
Configuration Conflict
Rather than returning a generic "timetable invalid" message.

22.12 Hard vs Soft Constraints
Future scheduling should distinguish:
Hard constraint
Must never be violated.
Example:
Teacher cannot teach two classes simultaneously.
Soft constraint
May be violated with warning/approval.
Example:
Teacher prefers not to have first period.
This distinction allows future automatic scheduling without redesigning the model.

22.13 Timetable Lifecycle
A timetable should not immediately become active when someone starts editing it.
Recommended:
Draft
  ↓
Under Review
  ↓
Published
  ↓
Active
  ↓
Superseded / Archived
Depending on implementation, Published and Active may eventually be combined.

22.14 Why Draft Timetables Matter
Administrators need to construct the timetable incrementally.
Example:
Draft
├── Monday complete
├── Tuesday incomplete
├── Teacher conflicts remaining
└── Room conflicts remaining
The system can show validation results before publication.

22.15 Publishing
Publishing should validate important constraints.
Draft
 ↓
Validate
 ↓
No blocking conflicts
 ↓
Publish
 ↓
Active Timetable
Warnings may be allowed depending on policy.
Blocking conflicts should not be silently ignored.

22.16 Timetable Versioning
Timetable changes should preserve history.
Example:
2026 Term 1 Timetable
        ↓
Version 1
        ↓
Version 2
        ↓
Version 3
If a teacher changes later, historical scheduling should remain understandable.

22.17 Effective Dating
A change can be:
Effective From: August 1
rather than rewriting all historical records.
Example:
July
Teacher A → Mathematics

August
Teacher B → Mathematics
This is especially important once attendance and reporting depend on schedules.

22.18 Substitution
Substitution should be part of timetable operations, but it should not mutate the original timetable.
Example:
Normal:
Monday 10:00
Math
Teacher A
Teacher A is absent.
Substitution:
Monday 10:00
Math
Teacher B
The original timetable remains:
Teacher A
The substitution represents an operational override.

22.19 Substitution Model
Conceptually:
Substitution
├── Original Timetable Entry
├── Date
├── Original Teacher
├── Substitute Teacher
├── Reason
├── Status
└── Created By
This will later integrate naturally with Leave/Staff Operations.

22.20 Cancellation
A scheduled class may be cancelled.
Again:
Timetable Entry
       ↓
Cancellation
rather than deleting the timetable entry.
Reason examples:
Holiday
Exam
Teacher unavailable
School event
Emergency
Other

22.21 Room Changes
A particular occurrence may move rooms.
Do not modify the permanent timetable merely because one day's class moved.
Conceptually:
Normal Room: R101

Actual Date:
Override Room: R205
This follows the same principle as substitutions.

22.22 Operational Override Layer
The architecture therefore benefits from:
Base Timetable
      ↓
Operational Overrides
├── Teacher substitution
├── Room change
├── Cancellation
└── Schedule adjustment
      ↓
Effective Session
This will become useful when Attendance consumes timetable sessions.

22.23 Teacher Timetable
Teacher-facing view:
Monday
09:00  Mathematics — 8A
10:00  Science — 9B
11:15  Free
12:00  English — 7A
This is a read model/view, not a separate source of truth.

22.24 Class Timetable
Class-facing view:
8A

Monday
Math
English
Science
Break
History
Again, it is derived from timetable entries.

22.25 Room Timetable
Room schedule:
Room R101

09:00  8A Mathematics
10:00  9A Science
11:00  Free
Useful for labs, halls, activity rooms, etc.

22.26 Student Timetable
Initially this can be derived from:
Student
 ↓
Enrollment
 ↓
Class/Section
 ↓
Timetable
Timetable should not duplicate timetable entries per student unless a genuine business requirement appears.

22.27 Subject Allocation
A subject should generally come through Academic Management:
Academic Subject
      ↓
Subject Offering
      ↓
Class/Section
      ↓
Teacher Assignment
      ↓
Timetable
This preserves domain ownership.

22.28 Timetable and Attendance
Attendance should be able to consume timetable context.
Timetable
     ↓
Scheduled Session
     ↓
Attendance
But:
Timetable should not own attendance records.
This allows attendance to support both timetable-based and non-timetable attendance models.

22.29 Timetable and Examination
Examination scheduling is separate.
Exam:
Mathematics Exam
10:00–12:00
Room A
should not be represented as an ordinary Mathematics teaching timetable entry.
Examination owns the exam schedule.
Timetable may need to consume exam/calendar information to avoid conflicts.

22.30 Permissions
Initial permissions:
timetable.view
timetable.create
timetable.update
timetable.delete
timetable.publish
timetable.archive
timetable.export
Configuration:
timetable_config.view
timetable_config.manage
Operations:
timetable.substitution.create
timetable.substitution.update
timetable.substitution.cancel

timetable.cancellation.create
timetable.override.create

22.31 Scope-Based Access
A teacher should normally see:
Their timetable
rather than automatically seeing every school's timetable-management data.
A timetable administrator may see:
Entire school timetable
This uses the existing RBAC + scope model.

22.32 Feature Structure
Initial:
Timetable
├── Time Slots
├── Timetable Builder
├── Class Timetables
├── Teacher Timetables
├── Room Timetables
├── Publishing
└── Substitutions
Future:
├── Automatic Scheduling
├── Teacher Availability
├── Room Management
├── Advanced Constraints
└── Optimization

22.33 Entitlement
The core timetable capability could be:
timetable
Optional future capabilities:
timetable.advanced
timetable.auto_schedule
timetable.room_management
Do not unnecessarily split these into commercial features until the pricing model requires it.

22.34 Events
Timetable may emit:
TimetableCreated
TimetablePublished
TimetableActivated
TimetableSuperseded

TimetableEntryCreated
TimetableEntryChanged

SubstitutionCreated
SubstitutionCancelled

ClassScheduleCancelled
RoomScheduleChanged
Other domains may consume these.

22.35 Audit
Audit important actions:
Timetable created
Timetable published
Timetable entry changed
Timetable published version replaced
Substitution created
Substitution changed
Class cancelled
Room changed
For important changes:
before
after
reason
actor
timestamp
tenant

22.36 Reports
Initial reports/views:
Class Timetable
Teacher Timetable
Room Schedule
Free Periods
Teacher Workload View
Scheduling Conflicts
Substitution Report
Teacher workload reporting should remain a derived view rather than creating another ownership domain.

22.37 Bulk Operations
Timetable creation may involve hundreds of entries.
Therefore:
Import Timetable
      ↓
Validate
      ↓
Preview Conflicts
      ↓
Confirm
      ↓
Background Processing
      ↓
Result
This follows the platform-wide bulk-operation standard.

22.38 Critical Architectural Boundary
The dependency direction should remain:
Academic
   ↓
Teacher Assignment
   ↓
Timetable
   ↓
Operational Session
   ↓
Attendance
Not:
Attendance → Timetable → Teacher → Student
where every domain starts depending on the others.

22.39 Failure Scenarios
Examples:
Conflict during creation
Create entry
 ↓
Conflict detected
 ↓
Reject
Conflict during bulk import
Import
 ↓
Validate
 ↓
Some entries conflict
 ↓
Preview errors
 ↓
User fixes
 ↓
Confirm
Provider-independent operation
Timetable itself has no external-provider dependency, so core scheduling remains transactional.

22.40 Final Timetable Model
                    ACADEMIC
                       │
             ┌─────────┴─────────┐
             ↓                   ↓
        SUBJECT OFFERING    TEACHING ASSIGNMENT
             │                   │
             └─────────┬─────────┘
                       ↓
                 BASE TIMETABLE
                       │
             ┌─────────┼──────────┐
             ↓         ↓          ↓
          Teacher     Room       Section
             │         │          │
             └─────────┼──────────┘
                       ↓
              OPERATIONAL OVERRIDES
              ├── Substitution
              ├── Room Change
              └── Cancellation
                       ↓
                EFFECTIVE SESSION
                       │
                       ↓
                  ATTENDANCE
The important foundation is the separation between planned timetable, operational changes, and actual sessions. That prevents later attendance, substitution, and schedule changes from corrupting the original timetable.
Next: Part 23 — Library Management.
