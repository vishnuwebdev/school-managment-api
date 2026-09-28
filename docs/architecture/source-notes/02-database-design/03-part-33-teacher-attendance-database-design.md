<!-- Source: Apple Notes, folder 'Core Database design system' -->
# Part 33 — Teacher + Attendance Database Design

This phase connects the academic/student foundation to the first operational domain.
The key relationship is:
Academic
   │
   ├── Subject Offering
   │
   └── Class / Section
          │
          ↓
       Teacher
          │
          ↓
   Teaching Assignment
          │
          ↓
      Timetable
          │
          ↓
     Attendance
Attendance must also remain usable for schools that take simple daily attendance without a detailed timetable.

33.1 Teacher Database
Teacher Management owns:
teachers
teacher_documents
teacher_qualifications
teaching_assignments
The important distinction is:
Teacher ≠ User
A teacher may have a login, but the teacher record exists independently.

33.2 Teacher
Conceptually:
teachers
--------
id
tenant_id
teacher_number
status
first_name
middle_name
last_name
date_of_birth
...
created_at
updated_at
As with Student:
teacher_number ≠ id
Teacher number should generally be unique within a school:
UNIQUE(tenant_id, teacher_number)

33.3 Teacher Status
Initial lifecycle:
PROSPECTIVE
    ↓
ONBOARDING
    ↓
ACTIVE
    ↓
INACTIVE / ON_LEAVE
    ↓
RESIGNED / TERMINATED
    ↓
ARCHIVED
Exact HR semantics remain outside Teacher Management.

33.4 Teacher User Account
Do not put authentication fields directly into teachers.
Instead:
Teacher
   ↓
optional user_id / identity association
   ↓
User
   ↓
Membership
   ↓
Role
This allows a teacher to exist before receiving system access.
It also keeps authentication concerns in Identity.

33.5 Teacher Documents
Conceptually:
teacher_documents
-----------------
id
tenant_id
teacher_id
document_type
file_id
status
issued_at
expires_at
created_at
updated_at
The actual file remains owned by File Service.

33.6 Teacher Qualifications
Qualifications are business data owned by Teacher Management.
teacher_qualifications
----------------------
id
tenant_id
teacher_id
qualification_type
institution
field_of_study
completion_date
status
...
The exact academic/professional fields can be expanded later.

33.7 Teaching Assignment
This is the critical cross-domain entity.
Teacher Management owns:
teaching_assignments
--------------------
id
tenant_id
teacher_id
subject_offering_id
academic_year_id
class_id
section_id nullable
status
start_date
end_date
created_at
updated_at
However, there is an important modeling question:
Should class_id and section_id be duplicated here if they can already be obtained through subject_offering_id?
For the initial design, do not duplicate them unless the domain needs them independently.
Prefer:
Teacher
   ↓
Teaching Assignment
   ↓
Subject Offering
   ↓
Academic context
This reduces inconsistent relationships.

33.8 Why Teaching Assignment Exists
A Subject Offering says:
Mathematics is offered for Grade 8 during 2026–27.
A Teaching Assignment says:
Teacher X is assigned to teach that offering.
These are different facts.
Subject Offering
       ↓
Teaching Assignment
       ↓
Teacher

33.9 Multiple Teachers
The model should allow:
Mathematics / Grade 8
      │
      ├── Teacher A
      └── Teacher B
This supports:
co-teaching,
subject specialization,
multiple instructors,
temporary assignments.
Do not enforce one teacher per subject offering unless a specific school configuration requires it.

33.10 Assignment History
Teaching assignments should be effective-dated.
Example:
Teacher A
  ↓
Mathematics
  ↓
Jan–Jun

Teacher B
  ↓
Mathematics
  ↓
Jul–Mar
Historical attendance and exam records should continue pointing to the appropriate historical context.

33.11 Assignment Status
Potential states:
DRAFT
ACTIVE
SUSPENDED
ENDED
CANCELLED
A simple V1 implementation can use fewer states if the workflow does not require all of them.

33.12 Teacher Scope
Teacher authorization should be derived from assignments.
Example:
Teacher A
 ↓
Teaching Assignment
 ↓
Grade 8 / Section B / Mathematics
Then:
attendance.create
+
ASSIGNED_SUBJECT
can authorize Teacher A to record attendance for that context.
This is preferable to manually assigning arbitrary student IDs to teachers.

33.13 Attendance Database
Attendance owns:
attendance_sessions
attendance_records
attendance_statuses
attendance_corrections
The core model should support:
Daily Attendance
and:
Subject / Period Attendance
without requiring two unrelated schemas.

33.14 Attendance Session
The session establishes context.
Conceptually:
attendance_sessions
-------------------
id
tenant_id
attendance_type
academic_year_id
date
class_id
section_id
subject_offering_id nullable
teacher_id nullable
timetable_entry_id nullable
status
started_at
submitted_at
approved_at
created_at
updated_at
Some fields are optional depending on attendance type.

33.15 Daily Attendance
For daily attendance:
attendance_type = DAILY
Typical context:
Academic Year
Class
Section
Date
Teacher/Recorder
No subject is required.

33.16 Subject Attendance
For period attendance:
attendance_type = SUBJECT
Context can include:
Academic Year
Class
Section
Subject Offering
Teacher
Timetable Entry
Date
Period
This allows:
08:00 Mathematics
09:00 English
10:00 Physics
attendance.

33.17 Why Session Is Important
Without a session, records become ambiguous.
For example:
student_id
date
status
cannot distinguish:
Daily attendance
from:
Mathematics period 1
The session supplies the business context.

33.18 Attendance Record
The individual student's attendance:
attendance_records
------------------
id
tenant_id
attendance_session_id
student_id
enrollment_id
status_id
marked_at
marked_by
remarks
created_at
updated_at
The inclusion of enrollment_id is important.
It preserves the academic context under which the attendance was recorded.

33.19 Why Store Enrollment ID?
Suppose a student changes from:
Grade 8A
to:
Grade 8B
If historical attendance only contains:
student_id
then later reporting has to reconstruct the student's class from current or historical enrollment data.
Storing the relevant enrollment reference makes the historical context explicit.

33.20 Tenant Consistency
An attendance record must satisfy:
attendance_record.tenant_id
=
attendance_session.tenant_id
=
student.tenant_id
=
enrollment.tenant_id
This is an important cross-tenant integrity rule.

33.21 Attendance Status
Statuses should be configurable.
Conceptually:
attendance_statuses
-------------------
id
tenant_id
code
name
category
counts_as_present
counts_as_absent
requires_reason
active
Examples:
PRESENT
ABSENT
LATE
HALF_DAY
EXCUSED
LEAVE
The exact classification should remain configurable.

33.22 Do Not Encode Attendance as Boolean
Avoid:
present = true/false
because it cannot adequately represent:
late,
half day,
excused,
leave,
other school-defined statuses.
A status entity gives the model room to evolve.

33.23 Attendance Status History
Changing the definition of a status should not silently rewrite historical attendance.
For important configuration, consider versioning/effective dating.
For example:
LATE
effective from 2026-04-01
rather than modifying historical meaning retroactively.

33.24 Attendance Lifecycle
A session can use:
DRAFT
  ↓
SUBMITTED
  ↓
APPROVED
or:
DRAFT
  ↓
FINAL
depending on school configuration.
The database should support the concept without forcing an overly complex workflow in V1.

33.25 Attendance Correction
Do not silently overwrite important attendance changes.
Conceptually:
attendance_corrections
----------------------
id
tenant_id
attendance_record_id
old_status_id
new_status_id
reason
requested_by
approved_by
status
created_at
approved_at
This provides a controlled history for sensitive corrections.

33.26 Correction vs Audit
They serve different purposes.
Correction
Business record:
Attendance was changed from Absent to Present.
Audit
Security/history record:
User X performed this operation at time Y from request Z.
Both may exist.

33.27 Bulk Attendance
Attendance entry will commonly be bulk:
30 students
→ one attendance session
→ 30 attendance records
This should be treated as a transaction/workflow rather than 30 unrelated API operations where possible.
The system should validate:
student belongs to tenant,
enrollment belongs to tenant,
enrollment matches session context,
student is eligible for session,
status is valid,
duplicate record does not exist.

33.28 Attendance Uniqueness
A student should normally have only one record per attendance session.
Conceptually:
UNIQUE(
    tenant_id,
    attendance_session_id,
    student_id
)
This prevents duplicate attendance records.

33.29 Daily Attendance Uniqueness
For daily attendance, the session itself should represent:
tenant
+
date
+
academic context
+
attendance type
so the system does not accidentally create multiple competing daily sessions for the same class/section/date unless explicitly supported.

33.30 Subject Attendance Uniqueness
Subject attendance may require:
session
+
student
rather than merely:
date + student
because one student can have several subject sessions on the same day.

33.31 Timetable Relationship
Attendance may reference a timetable entry:
attendance_session
        ↓
timetable_entry_id
But this should remain optional.
Why?
Because:
Daily Attendance
may not use a timetable at all.
Therefore Timetable is an optional operational context, not a hard prerequisite for Attendance.

33.32 Teacher Relationship
Attendance can store:
teacher_id
for the responsible teacher/recorder.
But authorization should still verify that the teacher actually has the relevant assignment.
The stored teacher is historical context, not a substitute for authorization.

33.33 Enrollment and Attendance
The relationship should be:
Attendance Record
      │
      ├── student_id
      └── enrollment_id
This provides both:
direct student identity,
historical enrollment context.

33.34 Enrollment Change — Important Decision
With Attendance now considered, a strong approach is emerging:
Enrollment
   ↓
effective dates
   ↓
Enrollment changes
For example:
Enrollment
2026-04-01 → 2026-08-15
Grade 8A

Enrollment
2026-08-16 → 2027-03-31
Grade 8B
Attendance records can point to the applicable enrollment.
This is more robust than rewriting one enrollment record repeatedly.
We should validate this further against Examination and promotion before making it an absolute rule.

33.35 Teaching Assignment and Attendance
Teacher authorization can follow:
User
 ↓
Membership
 ↓
Role
 ↓
Permission
 ↓
Scope
 ↓
Teaching Assignment
 ↓
Attendance Session
Therefore:
Having the Teacher role alone does not automatically give access to every student's attendance.

33.36 Attendance Scope Example
Suppose:
Teacher A
is assigned:
Grade 8
Section B
Mathematics
Then:
attendance.view
may be permitted for that context.
But:
Grade 10
Section A
Physics
should be denied unless another role/assignment grants access.

33.37 Attendance Reports
Attendance reports should not create duplicate business data.
Examples:
Daily Register
Student Attendance History
Class Attendance Percentage
Student Attendance Percentage
Subject Attendance
Monthly Attendance
These should derive from Attendance records.
Reporting may later create read models for expensive aggregation.

33.38 Teacher + Attendance Relationship
The resulting structure:
Teacher
  │
  ↓
Teaching Assignment
  │
  ↓
Subject Offering
  │
  ├────────→ Academic Year
  ├────────→ Class
  └────────→ Section/context
            │
            ↓
       Attendance Session
            │
            ↓
       Attendance Record
            │
            ↓
          Student

33.39 Database Conceptual Schema
TEACHER
──────────────
teachers
teacher_documents
teacher_qualifications
teaching_assignments


ATTENDANCE
──────────────
attendance_statuses
attendance_sessions
attendance_records
attendance_corrections


REFERENCES
──────────────
Academic Year
Class
Section
Subject Offering
Student
Enrollment
Teacher
Timetable Entry (optional)

33.40 Ownership Boundary
Teacher Management owns:
Teacher
Qualification
Document
Teaching Assignment
Academic owns:
Academic Year
Class
Section
Subject
Subject Offering
Attendance owns:
Attendance Session
Attendance Record
Attendance Status
Attendance Correction
This boundary should remain intact.

33.41 Events
Teacher events:
TeacherCreated
TeacherUpdated
TeacherStatusChanged
TeachingAssignmentCreated
TeachingAssignmentChanged
TeachingAssignmentEnded
Attendance events:
AttendanceSessionCreated
AttendanceSubmitted
AttendanceApproved
AttendanceRecorded
AttendanceCorrected
AttendanceFinalized
These can feed Communication, Reporting, and other downstream services.

33.42 Audit
Important operations:
Teacher creation/update
Teaching assignment changes
Attendance creation
Attendance bulk submission
Attendance correction
Attendance approval/finalization
Attendance status configuration changes
Attendance corrections should always have particularly strong audit coverage.

33.43 Configuration
Teacher domain configuration:
teacher numbering
teacher statuses
qualification types
Attendance configuration:
attendance types
attendance statuses
approval rules
late rules
working-day behavior
Attendance configuration should remain owned by Attendance.

33.44 Future Extensions
This model leaves room for:
Teacher
 ├── Leave
 ├── Staff Attendance
 ├── Payroll
 └── Performance
and:
Attendance
 ├── Mobile Entry
 ├── Offline Sync
 ├── Biometric Integration
 ├── Parent Alerts
 └── Advanced Analytics
without redesigning the foundation.

33.45 Current Cross-Domain Graph
We now have:
                 ACADEMIC
                    │
          ┌─────────┴─────────┐
          ↓                   ↓
      Subject            Class/Section
          │                   │
          ↓                   │
 Subject Offering             │
          │                   │
          ↓                   │
 Teaching Assignment          │
          ↑                   │
          │                   │
       Teacher                │
                              │
Student ──→ Enrollment ───────┘
   │
   └──────────────────────→ Attendance
                              ↑
                              │
                    Subject/Period Context
                              ↑
                           Timetable
The important thing is that Attendance does not own any of these upstream entities.

33.46 Final Design Decision for This Phase
The strongest foundation at this point is:
Student
   ↓
Enrollment
   ↓
Academic Context

Teacher
   ↓
Teaching Assignment
   ↓
Subject Offering
   ↓
Academic Context

Attendance
   ↓
Session
   ↓
Student + Enrollment
This gives us historical context without duplicating ownership.
The next phase should test this model against Examination, because Examination introduces marks, grading, assessment components, publication, and historical academic context.
Next: Part 34 — Examination Database Design
That will establish how:
assessments,
assessment periods,
papers/components,
student assessment entries,
marks,
grading rules,
calculated results,
publication,
locking,
and historical enrollment context
fit into the existing Student + Academic foundation without creating circular dependencies.
