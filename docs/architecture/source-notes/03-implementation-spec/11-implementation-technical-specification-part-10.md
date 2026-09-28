<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 10

Timetable & Scheduling Management
Timetable should be treated as a scheduling domain rather than a simple CRUD table. Its core responsibility is assigning academic activities to time slots, sections, teachers, rooms and subject offerings while preventing conflicts.
The key distinction is:
Academic
   → What is taught

Teacher
   → Who can teach it

Timetable
   → When and where it is taught

Attendance
   → Whether it actually happened / who attended

374. Timetable Domain Boundary
Timetable owns:
timetable periods
bell schedules
timetable versions
timetable entries
room/resource allocation
teacher schedule
section schedule
subject schedule
substitutions
timetable publication
conflict detection
schedule exceptions
It does not own:
students
teachers
subjects
subject offerings
attendance records
leave records
Those are referenced through domain interfaces.

375. Scheduling Hierarchy
Academic Year
      ↓
Bell Schedule
      ↓
Timetable
      ↓
Timetable Entry
      ↓
Teacher / Section / Subject / Room
Example:
Monday
 ├── Period 1
 │     └── Grade 5A Mathematics
 │           ├── Teacher: T001
 │           └── Room: R12
 │
 ├── Period 2
 │     └── Grade 5A Science
 │
 └── Period 3
       └── Grade 5A English

376. Bell Schedule
A bell schedule defines the time structure for a school.
bell_schedules
-------------
id
tenant_id
academic_year_id
name
code
status
effective_from
effective_until
created_at
updated_at
version
Status:
DRAFT
ACTIVE
INACTIVE
ARCHIVED

377. Bell Schedule Periods
bell_schedule_periods
---------------------
id
tenant_id
bell_schedule_id
period_number
name
start_time
end_time
period_type
sequence
status
created_at
updated_at
Period types:
TEACHING
BREAK
LUNCH
ASSEMBLY
ACTIVITY
OTHER
Breaks are represented explicitly rather than being inferred from missing periods.

378. Time Representation
School operating times use the tenant's configured local timezone.
Store actual timestamps in UTC when a timestamp is required.
For recurring timetable definitions:
day_of_week
local start_time
local end_time
The timetable is interpreted using the tenant timezone.
Do not store recurring schedule times as UTC.

379. Timetable
A timetable is a versioned schedule.
timetables
----------
id
tenant_id
academic_year_id
name
code
version_number
status
effective_from
effective_until
published_at
published_by
created_at
updated_at
version
Status:
DRAFT
REVIEW
PUBLISHED
SUPERSEDED
ARCHIVED

380. Why Timetable Versions Matter
Do not mutate the currently published timetable without preserving history.
Example:
Version 1
   ↓
Published

Version 2
   ↓
Draft changes

Version 2
   ↓
Published

Version 1
   ↓
Superseded
This allows historical attendance and operational records to remain explainable.

381. Timetable Entry
timetable_entries
-----------------
id
tenant_id
timetable_id
academic_year_id
section_id
subject_offering_id
teacher_id
room_id
bell_schedule_period_id
day_of_week
start_time
end_time
entry_type
status
effective_from
effective_until
created_at
updated_at
version
teacher_id, section_id, and subject_offering_id are references to other domains.

382. Entry Types
Initial types:
REGULAR_CLASS
PRACTICAL
LAB
ACTIVITY
ASSEMBLY
EXAM
OTHER
Examinations can have their own detailed scheduling while optionally integrating with Timetable.

383. Teacher Assignment Validation
A timetable entry should normally require:
Teacher
   ↓
Valid Teaching Assignment
   ↓
Subject Offering
Timetable should call Teacher Management/Application interfaces to verify this.
It should not directly query Teacher tables.

384. Section Validation
The section must belong to the relevant academic year.
Similarly:
Subject Offering
      ↓
Academic Year
      ↓
Class / Section
must be compatible with the timetable entry.

385. Room Management
Rooms are timetable-owned resources.
rooms
-----
id
tenant_id
code
name
room_type
capacity
location
status
created_at
updated_at
version
Room types:
CLASSROOM
LABORATORY
LIBRARY
AUDITORIUM
SPORTS
OFFICE
OTHER

386. Room Capacity
When configured:
section/student count <= room.capacity
can produce a conflict/warning.
This should initially be a configurable validation rule rather than an absolute global constraint because schools may intentionally exceed nominal room capacity.

387. Resource Model
Future scheduling may require resources beyond rooms.
Instead of hardcoding every resource type into timetable entries, the architecture can support:
schedule_resources
------------------
id
tenant_id
resource_type
resource_id
V1 can keep room_id directly for simplicity.

388. Recurring Schedule
A normal timetable entry represents a recurring weekly pattern.
Example:
Monday
Period 2
Mathematics
Grade 5A
Teacher T01
Room R12
It applies to the timetable's effective period.

389. Schedule Exceptions
Real schools need exceptions.
Examples:
holiday
special event
room unavailable
teacher unavailable
examination
school closure
one-day timetable change
Use:
timetable_exceptions
--------------------
id
tenant_id
timetable_id
exception_date
exception_type
reason
status
created_at
updated_at

390. Schedule Exception Entries
For replacing a normal class:
timetable_exception_entries
---------------------------
id
tenant_id
timetable_exception_id
original_entry_id
replacement_teacher_id
replacement_room_id
replacement_start_time
replacement_end_time
replacement_period_id
status
This prevents modifying the recurring timetable simply to handle a one-day exception.

391. Teacher Substitution
Substitution is a scheduling operation, not a teacher employment change.
substitutions
-------------
id
tenant_id
timetable_entry_id
substitute_teacher_id
date
reason
status
created_by
approved_by
created_at
updated_at
Status:
REQUESTED
ASSIGNED
CONFIRMED
CANCELLED
COMPLETED

392. Leave Integration
Leave Management, when implemented, owns teacher availability.
Timetable can query:
Is teacher available?
If unavailable, timetable can identify affected entries and create substitution work.
It must not modify teacher leave records.

393. Conflict Types
At minimum detect:
Teacher conflict
Teacher A
Period 2
Class 5A

AND

Teacher A
Period 2
Class 6A
Section conflict
Section 5A
Period 2
Math

AND

Section 5A
Period 2
Science
Room conflict
Room R12
Period 2
Math

AND

Room R12
Period 2
Science

394. Conflict Detection
Do not rely exclusively on application-level checks.
Use both:
Application validation
+
database constraints/index strategy
Some temporal overlap rules cannot be represented by a simple MySQL unique constraint, so application/database transactional locking is required.

395. Conflict Detection Algorithm
For a proposed entry:
same tenant
+
same timetable
+
same day
+
overlapping time
+
same teacher/section/room
means conflict.
Overlap:
existing_start < new_end
AND
existing_end > new_start

396. Conflict Severity
Return structured conflicts:
ERROR
WARNING
INFO
Examples:
teacher double-booked → ERROR
room capacity exceeded → WARNING
teacher assignment nearing expiry → WARNING
The rules should be configurable where appropriate.

397. Timetable Draft Workflow
Create Draft
 ↓
Add / Modify Entries
 ↓
Validate
 ↓
Resolve Conflicts
 ↓
Review
 ↓
Publish
Do not allow a timetable with blocking conflicts to become published.

398. Timetable Publication
Publication should atomically establish:
new timetable version = PUBLISHED
previous published version = SUPERSEDED
The operation must be concurrency-safe.

399. Publication Preconditions
Before publishing:
Academic year valid
+
bell schedule valid
+
entries valid
+
no blocking conflicts
+
referenced teachers valid
+
referenced subject offerings valid
+
required rooms valid

400. Timetable Permissions
Initial permissions:
timetable.view
timetable.create
timetable.update
timetable.delete_draft
timetable.validate
timetable.publish
timetable.unpublish

timetable_entry.view
timetable_entry.create
timetable_entry.update
timetable_entry.delete

room.view
room.manage

substitution.view
substitution.create
substitution.assign
substitution.approve
substitution.cancel

timetable.export

401. Teacher Access
Teachers should generally see:
their timetable
their substitutions
their assigned classes
They should not automatically receive tenant-wide timetable modification rights.

402. Student/Parent Access
Student/parent-facing timetable should expose only published schedule data.
Drafts and internal conflicts are not exposed.

403. Timetable APIs
Bell schedules:
/api/v1/bell-schedules
/api/v1/bell-schedules/:id
/api/v1/bell-schedules/:id/periods
Timetables:
/api/v1/timetables
/api/v1/timetables/:id
/api/v1/timetables/:id/validate
/api/v1/timetables/:id/publish
Entries:
/api/v1/timetables/:id/entries
/api/v1/timetable-entries/:id
Rooms:
/api/v1/rooms
/api/v1/rooms/:id
Substitutions:
/api/v1/substitutions
/api/v1/substitutions/:id

404. Timetable Application Services
CreateBellSchedule
CreateBellSchedulePeriod

CreateTimetable
CreateTimetableEntry
UpdateTimetableEntry
DeleteTimetableEntry

ValidateTimetable
DetectConflicts

PublishTimetable
SupersedeTimetable

CreateRoom
UpdateRoom
ArchiveRoom

CreateSubstitution
AssignSubstitute
ConfirmSubstitution
CancelSubstitution

405. Schedule Query Services
Because timetable is read-heavy, expose optimized query operations:
getSectionTimetable()
getTeacherTimetable()
getRoomSchedule()
getDaySchedule()
getCurrentSchedule()
getSubstitutionSchedule()
These can use read models later without changing the domain contract.

406. Timetable Events
Important events:
BellScheduleCreated
BellScheduleUpdated

TimetableCreated
TimetableEntryCreated
TimetableEntryUpdated
TimetableEntryRemoved

TimetableValidated
TimetablePublished
TimetableSuperseded

TimetableExceptionCreated

SubstitutionRequested
SubstitutionAssigned
SubstitutionConfirmed
SubstitutionCancelled

407. Attendance Integration
Attendance can resolve a scheduled session through:
date
section
subject offering
period
Timetable provides context.
Attendance still owns the actual attendance session and attendance records.
This prevents:


408. Examination Integration
Examination can use timetable infrastructure for:
rooms
schedules
teacher availability
conflict detection
But Examination owns examination-specific schedules.
Therefore:
Regular class schedule
→ Timetable

Examination schedule
→ Examination
Shared scheduling services can be introduced later if duplication becomes significant.

409. Teacher Integration
Teacher Management provides:
teacher identity
active status
teaching assignments
Timetable determines when the teacher is scheduled.

410. Academic Integration
Academic Management provides:
academic year
section
subject offering
Timetable consumes those references.

411. Leave Integration
Future Leave module provides:
Teacher unavailable
Timetable responds by identifying affected schedules.
The replacement workflow is handled through Substitution.

412. Timetable Audit
Audit:
timetable creation
entry creation/change/deletion
conflict overrides
publication
superseding
room changes
substitution assignment
exception creation
manual schedule overrides
For conflict overrides, require:
reason
actor
timestamp

413. Timetable Database Constraints
Important uniqueness constraints:
bell_schedules:
  tenant_id, academic_year_id, code

bell_schedule_periods:
  tenant_id, bell_schedule_id, period_number

timetables:
  tenant_id, academic_year_id, code, version_number

rooms:
  tenant_id, code

substitutions:
  tenant_id, timetable_entry_id, date
Exact uniqueness for timetable entries depends on whether overlapping schedules are allowed by entry type, so blocking temporal conflicts should remain an explicit validation concern.

414. Timetable Indexes
timetable_entries:
  tenant_id, timetable_id, day_of_week
  tenant_id, section_id, day_of_week
  tenant_id, teacher_id, day_of_week
  tenant_id, room_id, day_of_week
  tenant_id, subject_offering_id

timetable_exceptions:
  tenant_id, timetable_id, exception_date

substitutions:
  tenant_id, substitute_teacher_id, date
  tenant_id, timetable_entry_id, date

415. Concurrency
Two administrators editing a timetable must not silently overwrite each other's changes.
Use:
version column
+
optimistic locking
Publication requires an additional transaction-level check.

416. Bulk Timetable Operations
Support:
Bulk Import
Bulk Copy
Bulk Move
Bulk Delete
Example:
Copy Monday schedule
→ Tuesday
All bulk operations use:
validate
→ preview
→ confirm
→ background job
→ result

417. Copying Timetables
Useful operation:
Copy existing timetable
       ↓
Create new draft version
       ↓
Adjust academic/section assignments
       ↓
Validate
       ↓
Publish
Never clone directly into the published timetable.

418. Timetable Export
Support:
PDF
spreadsheet
printable timetable
teacher timetable
section timetable
room timetable
Large exports should run asynchronously.
Generated files go through the common File Service.

419. Timetable Notifications
When a published timetable materially changes, the Notification service may notify:
teachers
students
parents
administrators
Notification delivery is asynchronous and must not roll back timetable publication.

420. Timetable Domain Contract
Timetable
│
├── Bell Schedules
├── Timetable Versions
├── Timetable Entries
├── Rooms
├── Exceptions
├── Substitutions
├── Conflict Detection
└── Publication
Primary lifecycle:
Draft
 ↓
Build
 ↓
Validate
 ↓
Review
 ↓
Publish
 ↓
Supersede
The critical architectural rule is that published schedules are versioned historical records, not mutable configuration.

Next Domain
The next specification will cover Leave & Staff Availability, including leave types, leave policies, balances, applications, approval workflows, holidays, teacher availability and its integration with timetable substitutions.
