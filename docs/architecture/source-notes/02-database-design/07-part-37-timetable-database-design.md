<!-- Source: Apple Notes, folder 'Core Database design system' -->
# Part 37 — Timetable Database Design

Timetable is a scheduling domain, not a teacher, attendance, or academic domain.
Its central rule is:
The base timetable describes the planned schedule. Operational changes modify the day's execution without destroying the original plan.
The model is:
Academic
   ↓
Teaching Assignment
   ↓
Timetable Definition
   ↓
Timetable Entries
   ↓
Published Version
   ↓
Operational Changes
   ├── Substitution
   ├── Room Change
   └── Cancellation

37.1 Timetable Ownership
Timetable owns:
Time Slots
Academic Periods
Rooms / Locations
Timetable Definitions
Timetable Entries
Timetable Versions
Substitutions
Operational Overrides
It references:
Academic Year
Class
Section
Subject Offering
Teacher
Teaching Assignment
Leave / Availability
It does not own:
Student
Teacher identity
Subject
Attendance
Examination
Leave

37.2 Time Slot
A time slot defines a reusable period of the school day.
time_slots
----------
id
tenant_id
name
code
start_time
end_time
slot_type
display_order
status
created_at
updated_at
Examples:
Period 1   08:00–08:45
Period 2   08:45–09:30
Break      09:30–09:45
Period 3   09:45–10:30

37.3 Slot Type
Potential types:
TEACHING
BREAK
ASSEMBLY
ACTIVITY
LUNCH
OTHER
A timetable entry for a break should not require a subject or teacher.

37.4 Academic Period
Schools may organize their timetable differently across academic periods.
Conceptually:
academic_periods
----------------
id
tenant_id
academic_year_id
name
start_date
end_date
status
Example:
Term 1
Term 2
This is distinct from Examination's Assessment Period.

37.5 Room / Location
Timetable owns scheduling locations.
rooms
-----
id
tenant_id
name
code
room_type
capacity
status
created_at
updated_at
Examples:
Room 101
Physics Lab
Computer Lab
Auditorium
Ground
A more advanced future architecture could separate Facilities/Rooms into its own domain.
For V1, keeping scheduling locations within Timetable is reasonable.

37.6 Room Capacity
Capacity can be used for conflict validation:
Room capacity = 40
Class size = 55
The system may flag or reject the schedule depending on configuration.
This is a scheduling rule, not a Student rule.

37.7 Timetable Definition
A timetable definition represents a schedule being constructed for a particular context.
timetables
----------
id
tenant_id
academic_year_id
academic_period_id
name
status
version
effective_from
effective_to
created_at
updated_at
Example:
2026–27 Term 1 Main Timetable

37.8 Timetable Lifecycle
Recommended:
DRAFT
   ↓
UNDER_REVIEW
   ↓
PUBLISHED
   ↓
ACTIVE
   ↓
SUPERSEDED
   ↓
ARCHIVED
A school may use fewer states operationally.
The important distinction is:
Draft ≠ Published
Published ≠ Archived

37.9 Timetable Versioning
This is one of the most important decisions.
Suppose:
Version 1
Mathematics → Period 2
is replaced by:
Version 2
Mathematics → Period 4
Historical reports should still be able to determine what the published timetable was at the time.
Therefore, timetable versions should be immutable after publication, or changes should create a new version.

37.10 Timetable Entries
An entry represents one scheduled teaching activity.
timetable_entries
-----------------
id
tenant_id
timetable_id
academic_year_id
academic_period_id
class_id
section_id
subject_offering_id
teaching_assignment_id
teacher_id
time_slot_id
day_of_week
room_id
entry_type
status
effective_from
effective_to
created_at
updated_at
Some fields may become derivable and need not all be physically duplicated.
The final schema should avoid unnecessary duplication.

37.11 Entry Type
Potential types:
TEACHING
ACTIVITY
ASSEMBLY
OTHER
A break is usually represented by the Time Slot rather than a normal teaching entry.

37.12 Teacher Reference
The entry should normally reference the relevant Teaching Assignment.
Conceptually:
Timetable Entry
      ↓
Teaching Assignment
      ↓
Teacher + Subject Offering
This prevents arbitrary teacher/subject combinations.

37.13 Why Teaching Assignment Matters
Without it, someone could create:
Teacher A
Mathematics
Grade 8
even if Teacher A is not actually assigned to teach Mathematics for Grade 8.
The Teaching Assignment becomes the authoritative relationship.

37.14 Day of Week
A timetable entry can have:
day_of_week
for recurring schedules:
MONDAY
TUESDAY
...
The actual implementation can use a constrained numeric representation or database enum.

37.15 Recurring vs Specific Dates
A normal timetable is recurring:
Every Monday, Period 2
Operational changes are date-specific:
Monday, 28 September
These should not be modeled as the same concept.

37.16 Effective Dates
A timetable version may apply:
01-Apr → 31-Aug
while another version applies:
01-Sep → 31-Mar
This supports mid-year timetable changes without rewriting history.

37.17 Timetable Conflict Types
At minimum:
Teacher Conflict
Class/Section Conflict
Room Conflict
Example:
Teacher A
Period 3
Monday
cannot simultaneously teach:
Class 8A
and:
Class 9B
unless the school explicitly supports a shared/co-teaching arrangement.

37.18 Conflict Constraints
A timetable entry normally cannot conflict with another entry sharing:
same teacher
+
same day
+
same time slot
Similarly:
same class/section
+
same day
+
same time slot
and:
same room
+
same day
+
same time slot

37.19 Hard vs Soft Constraints
The scheduling engine can later distinguish:
Hard
Teacher cannot teach two classes simultaneously.
Soft
Teacher prefers not to have Period 1.
V1 should implement hard constraints first.
Soft optimization can come later.

37.20 Publishing
Publishing should validate:
No blocking teacher conflicts
No blocking class conflicts
No blocking room conflicts
Required assignments valid
Required time slots valid
Effective dates valid
Only then:
DRAFT → PUBLISHED

37.21 Published Timetable Immutability
Once published, avoid arbitrary updates to the same version.
Prefer:
Published Version 1
        ↓
New Draft Version 2
        ↓
Publish Version 2
This gives clear historical meaning.

37.22 Operational Override
Published timetable changes happen in the real world:
Teacher absent
Room unavailable
Class cancelled
One-time schedule change
Do not mutate the published base timetable for these.
Instead use an operational override.

37.23 Operational Overrides
Conceptually:
timetable_overrides
-------------------
id
tenant_id
timetable_entry_id
date
override_type
status
reason
created_by
created_at
updated_at
Types:
TEACHER_CHANGE
ROOM_CHANGE
TIME_CHANGE
CANCELLATION
ADDITIONAL_SESSION

37.24 Teacher Substitution
A substitution is a specialized operational override.
substitutions
-------------
id
tenant_id
timetable_entry_id
date
original_teacher_id
replacement_teacher_id
reason
status
created_by
approved_by
created_at
updated_at
The original teacher remains historically visible.

37.25 Why Store Original Teacher?
Suppose:
Normal Teacher = Teacher A
but on September 28:
Replacement = Teacher B
The record should clearly say:
planned → Teacher A
actual → Teacher B
This is useful for:
attendance,
teacher workload,
reporting,
audit,
later dispute resolution.

37.26 Room Change
Similarly:
Normal Room = Room 101
Actual Room = Lab 2
should be an override rather than an update to the published timetable.

37.27 Cancellation
A class can be cancelled for a particular date:
Monday 28 Sept
Period 3
Mathematics
→ Cancelled
The recurring timetable remains unchanged.

37.28 Additional Session
Sometimes an extra class is needed.
For example:
Saturday
Extra Mathematics Session
This should be represented as an operational/additional session rather than modifying the recurring timetable.

37.29 Actual Operational Session
This raises an important future design point.
Attendance needs an actual operational context.
Therefore, eventually:
Base Timetable Entry
        ↓
Operational Session
        ↓
Attendance
The Operational Session may be generated only when needed.
For V1, the Attendance session can reference the timetable entry plus date/override information without requiring a separate full operational-session domain.

37.30 Timetable and Attendance
The relationship becomes:
Timetable Entry
       ↓
Date + Effective Version
       ↓
Operational Context
       ↓
Attendance Session
Attendance owns the attendance record.
Timetable owns the schedule.

37.31 Timetable and Leave
Leave creates availability information:
Leave
 ↓
Staff Unavailable
 ↓
Timetable
 ↓
Affected Entries
Timetable then determines whether substitution is required.
Leave does not directly edit timetable entries.

37.32 Substitution Workflow
Recommended:
Teacher Unavailable
       ↓
Affected Timetable Entries
       ↓
Find Eligible Replacement
       ↓
Create Substitution
       ↓
Approve / Confirm
       ↓
Notify
       ↓
Operational Session Uses Replacement
Teacher eligibility should respect:
assignment,
permissions,
availability,
scope.

37.33 Teacher Availability
Timetable can consume availability from:
Leave
Staff Operations
But it should not own the reason for unavailability.
For example:
Leave Approved
is Leave data.
Timetable only consumes the operational consequence:
Teacher unavailable

37.34 Timetable Permissions
Examples:
timetable.view
timetable.create
timetable.update
timetable.delete
timetable.publish
timetable.archive
timetable.export

timetable.substitution.view
timetable.substitution.create
timetable.substitution.approve
timetable.substitution.cancel

37.35 Teacher Access
A teacher should normally see:
Own Timetable
Assigned Classes
Assigned Subjects
Relevant Substitutions
rather than the entire school's timetable unless permission allows it.

37.36 Class/Section Access
A class coordinator might have:
timetable.view
scope = ASSIGNED_SECTION
while a School Admin could have:
timetable.manage
scope = ALL_TENANT
Authorization remains separate from timetable data.

37.37 Timetable Events
Core events:
TimetableCreated
TimetableSubmittedForReview
TimetablePublished
TimetableActivated
TimetableSuperseded
TimetableEntryCreated
TimetableEntryChanged
SubstitutionCreated
SubstitutionApproved
SubstitutionCancelled
ClassScheduleCancelled
RoomScheduleChanged
Consumers:
Attendance
Communication
Reporting

37.38 Audit
Audit should cover:
Timetable publication
Timetable version changes
Entry changes
Substitution creation/approval
Room changes
Teacher changes
Schedule cancellation
Publishing is particularly important because it changes operational expectations for the school.

37.39 Timetable Database Structure
Conceptually:
TIMETABLE
────────────────────────
time_slots
academic_periods
rooms

timetables
timetable_entries

timetable_overrides
substitutions
Future optimization can introduce additional read models.

37.40 Relationship Diagram
Academic Year
      │
      ↓
Academic Period
      │
      ↓
Timetable
      │
      ↓
Timetable Entry
   ┌──┼───────────────┐
   ↓  ↓               ↓
Class Section    Teaching Assignment
                      │
                      ↓
                    Teacher

Timetable Entry
      │
      ├──→ Time Slot
      └──→ Room

Timetable Entry
      ↓
Operational Override
      ├── Teacher Substitution
      ├── Room Change
      └── Cancellation

37.41 Historical Model
The important historical relationship is:
Published Timetable Version
        ↓
Timetable Entry
        ↓
Operational Override
        ↓
Actual Session
This allows reports to distinguish:
What was planned?
from:
What actually happened?
That distinction will become valuable for Attendance and Reporting.

37.42 Timetable vs Examination
Keep separate:
Teaching Timetable
and:
Examination Schedule
Both can use:
rooms,
teachers,
time,
academic context,
but their business rules are different.
Do not make Examination depend on the normal timetable for scheduling exams.

37.43 Room Ownership Decision
For V1:
Timetable owns Rooms / Locations
because the immediate purpose is scheduling.
If the platform later develops:
facility management,
maintenance,
asset management,
room booking,
campus management,
then Room/Facilities can become its own domain.
The current architecture does not block that extraction.

37.44 Tenant Isolation
All Timetable-owned entities are tenant-scoped:
time_slots.tenant_id
academic_periods.tenant_id
rooms.tenant_id
timetables.tenant_id
timetable_entries.tenant_id
timetable_overrides.tenant_id
substitutions.tenant_id
A teacher from one school must never be assignable to another school's timetable.

37.45 Important Constraints
Examples:
UNIQUE(tenant_id, time_slot.code)

UNIQUE(tenant_id, room.code)

UNIQUE(
    tenant_id,
    timetable_id,
    day_of_week,
    time_slot_id,
    class_id,
    section_id
)
The exact uniqueness rule for timetable entries must account for:
co-teaching,
shared classes,
activities,
rooms,
multiple groups.
Therefore this should be finalized after the first implementation use cases are defined.

37.46 Conflict Detection
Not all conflicts should necessarily be database uniqueness constraints.
For example:
Teacher conflict
Class conflict
Room conflict
are business rules requiring validation.
The database should provide the underlying data integrity, while the application/domain layer performs scheduling conflict detection.

37.47 Bulk Timetable Creation
Timetable construction is naturally bulk-oriented:
100 entries
 ↓
Validate
 ↓
Show conflicts
 ↓
Fix
 ↓
Preview
 ↓
Publish
Do not require administrators to save every entry as an isolated business operation.

37.48 Draft Concurrency
Two administrators could edit the same draft.
Use appropriate optimistic concurrency:
version
updated_at
or another concurrency mechanism.
A stale editor should receive a conflict rather than silently overwriting another administrator's changes.

37.49 Feature Dependencies
Timetable should require:
Academic
+
Teacher / Teaching Assignments
Some capabilities may additionally depend on:
Rooms
but room scheduling can potentially be disabled if the school does not need room management.
This fits the Entitlement Engine.

37.50 Current Dependency Graph
The system now looks like:
Academic
 ├──→ Student → Attendance
 │              ↓
 │          Examination
 │
 └──→ Teacher
       ↓
 Teaching Assignment
       ↓
   Timetable
       │
       ├──→ Attendance context
       ├──→ Communication
       └──→ Reporting

Leave
  ↓
Teacher Availability
  ↓
Timetable
  ↓
Substitution

Transportation ──→ Fees
Library ──────────→ Fees
No circular dependency has been introduced.

37.51 Key Decisions Locked
✓ Timetable owns scheduling
✓ Teaching Assignment remains teacher/academic relationship
✓ Published versions are historically preserved
✓ Operational changes do not mutate the base timetable
✓ Substitution is separate from base schedule
✓ Room changes are operational overrides
✓ Cancellations are date-specific
✓ Leave informs availability but does not own scheduling
✓ Attendance may consume timetable context
✓ Examination schedule remains separate
✓ Conflict detection belongs to domain logic
✓ Timetable supports recurring schedules
✓ Historical versions remain queryable

37.52 What This Enables
The model supports:
recurring class schedules,
configurable periods,
rooms,
teacher assignments,
class/section schedules,
teacher schedules,
published timetable versions,
substitutions,
room changes,
cancelled sessions,
extra sessions,
future automatic scheduling,
future availability optimization.
without turning Timetable into an overly complex scheduling engine.

Next: Part 38 — Library Database Design
The next domain will model:
Library
├── Catalog / Resources
├── Authors / Publishers
├── Book Copies
├── Locations / Shelves
├── Library Membership
├── Loans
├── Returns
├── Reservations
└── Fines
The most important boundary will be:
Library Fine
      ↓
Fee Management
      ↓
Payment
while keeping the book, copy, loan, return, reservation, and fine calculation entirely owned by Library.
