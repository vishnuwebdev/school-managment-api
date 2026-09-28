<!-- Source: Apple Notes, folder 'Core Database design system' -->
# Part 32 — Student + Academic Database Design

This is the first substantial business-domain database layer.
The key design decision is to keep Student Management and Academic Management as separate ownership boundaries while allowing them to connect through enrollment.
Academic
├── Academic Year
├── Class / Grade
├── Section
├── Subject
└── Subject Offering

Student
├── Student
├── Admission
├── Enrollment
├── Guardian
├── Student-Guardian Relationship
└── Documents
The central relationship is:
Student
   ↓
Enrollment
   ↓
Academic Year
   ↓
Class / Section
   ↓
Subject / Subject Offering

32.1 Academic Database
The academic foundation should support schools that do not necessarily follow a fixed "Grade 1–12" model.
Core entities:
academic_years
academic_classes
academic_sections
subjects
subject_offerings

32.2 Academic Year
Conceptually:
academic_years
-------------
id
tenant_id
name
code
start_date
end_date
status
created_at
updated_at
Example:
2026–2027
But the system should not depend on the year being represented by a particular numeric pattern.
name is presentation.
start_date and end_date define the actual period.

32.3 Academic Year Lifecycle
Recommended:
DRAFT
  ↓
UPCOMING
  ↓
ACTIVE
  ↓
COMPLETED
  ↓
ARCHIVED
Important rules:
Only appropriate years can be activated.
Two overlapping active academic years should normally be prevented unless explicitly supported.
Completing a year does not delete students or enrollments.
Historical enrollments remain valid after the year is completed.

32.4 Academic Class / Grade
Do not hardcode:
Grade 1
Grade 2
...
Grade 12
Instead:
academic_classes
---------------
id
tenant_id
name
code
display_order
status
created_at
updated_at
A school could therefore configure:
Nursery
LKG
UKG
Grade 1
Grade 2
...
Grade 12
or:
Primary
Middle School
Secondary
if its academic model requires it.

32.5 Class vs Section
Keep these separate.
Academic Class
      │
      ├── Section A
      ├── Section B
      └── Section C
Therefore:
academic_classes
academic_sections
should not be collapsed into one table.

32.6 Section
Conceptually:
academic_sections
-----------------
id
tenant_id
academic_class_id
name
code
status
created_at
updated_at
Examples:
A
B
C
Red
Blue
Science
Commerce
The section name remains school-configurable.

32.7 Section History
A section belongs to an academic class, but its historical meaning should remain clear.
For example:
2025–26
Grade 7 / Section A

2026–27
Grade 8 / Section B
A student moving between years should not overwrite the previous association.
That is why Enrollment is critical.

32.8 Subject
Subject is a reusable academic concept.
subjects
--------
id
tenant_id
name
code
status
description
created_at
updated_at
Examples:
Mathematics
English
Physics
Computer Science
Hindi
Art
Subject itself does not mean:
Mathematics taught to Grade 8A by Teacher X.
That belongs to an offering/assignment context.

32.9 Subject Offering
A subject offering represents the subject in a specific academic context.
Conceptually:
subject_offerings
-----------------
id
tenant_id
academic_year_id
academic_class_id
subject_id
status
created_at
updated_at
Depending on the school's model, it may later include section or group information.
This entity becomes an important cross-domain reference.

32.10 Why Subject Offering Matters
Without an offering, other modules end up storing combinations such as:
subject_id
class_id
academic_year_id
teacher_id
in many different places.
Instead:
Subject Offering
      │
      ├── Teacher Assignment
      ├── Timetable Entry
      ├── Attendance Session
      └── Examination Paper
Each domain still owns its own relationship records.

32.11 Student Entity
Now the Student domain:
students
--------
id
tenant_id
student_number
status
first_name
middle_name
last_name
date_of_birth
gender
...
created_at
updated_at
The exact personal-information fields should be finalized separately based on requirements and privacy considerations.
Important:
student_number ≠ id

32.12 Student Number
Student number should normally be unique per school:
UNIQUE (
    tenant_id,
    student_number
)
Do not assume student numbers are globally unique across the SaaS platform.

32.13 Student Lifecycle
Conceptually:
PROSPECTIVE
    ↓
ADMISSION_PENDING
    ↓
ADMITTED
    ↓
ACTIVE
    ↓
WITHDRAWN / TRANSFERRED / GRADUATED
    ↓
ARCHIVED
Not every school needs every intermediate state, so the exact workflow can be configurable later.

32.14 Student Status vs Enrollment
Do not use:
student.status = "Grade 8"
Instead:
Student
  status = ACTIVE

Enrollment
  academic_year = 2026–27
  class = Grade 8
  section = B
This is one of the most important modeling decisions in the system.

32.15 Admission
Admission is a separate business process from the student identity.
Conceptually:
admissions
----------
id
tenant_id
student_id
application_number
status
applied_at
approved_at
rejected_at
created_at
updated_at
A student can exist before admission is completed.

32.16 Admission vs Student Creation
These are different events:
Student Created
and:
Admission Approved
For example, a school may create a prospective student before deciding admission.
This separation supports future admission workflows without corrupting the Student entity.

32.17 Enrollment
Enrollment is the key bridge between Student and Academic.
Conceptually:
enrollments
-----------
id
tenant_id
student_id
academic_year_id
academic_class_id
academic_section_id
status
enrolled_at
start_date
end_date
created_at
updated_at
This preserves the student's academic placement historically.

32.18 Enrollment Ownership
Enrollment belongs to Student Management because it describes:
This student is enrolled in this academic context.
Academic owns the things being referenced:
Academic Year
Class
Section
This is a cross-domain relationship without transferring ownership.

32.19 Enrollment History
Example:
Student
 │
 ├── Enrollment 2024–25 → Grade 6 A
 │
 ├── Enrollment 2025–26 → Grade 7 B
 │
 └── Enrollment 2026–27 → Grade 8 A
Never overwrite the old enrollment to represent promotion.
Historical records are important for:
attendance,
exams,
reports,
certificates,
transcripts,
analytics.

32.20 Enrollment Status
Possible:
ACTIVE
COMPLETED
TRANSFERRED
WITHDRAWN
CANCELLED
The exact state machine can be refined later.

32.21 Enrollment Uniqueness
A useful initial invariant:
A student should normally have one active enrollment
for a given academic year.
However, do not immediately enforce an overly restrictive database rule if future scenarios might include:
mid-year transfers,
class changes,
section changes,
repeated academic year,
multiple concurrent programs.
A history model can accommodate these cases.

32.22 Enrollment Changes
Suppose:
Grade 8 / Section A
changes to:
Grade 8 / Section B
Do not simply destroy the previous record.
The design should support either:
Enrollment
 + effective dates
or:
Enrollment
 +
Enrollment History / Change records
We can choose the exact strategy after reviewing Attendance and Examination requirements.
This is intentionally left open for now.

32.23 Guardian
Guardian is not automatically a User.
Conceptually:
guardians
---------
id
tenant_id
first_name
last_name
relationship/contact information
status
created_at
updated_at
A guardian may exist without portal access.

32.24 Student–Guardian Relationship
Do not put:
student.guardian_id
because a student may have multiple guardians.
Instead:
student_guardians
-----------------
id
tenant_id
student_id
guardian_id
relationship_type
is_primary
status
created_at
updated_at
This supports:
Student
 ├── Father
 ├── Mother
 ├── Guardian
 └── Other authorized relationship

32.25 Guardian Scope
This relationship becomes important later for the Parent Portal.
For example:
Guardian A
  ↓
Student 1
Student 2
The portal should derive access from these relationships.
The client should never be trusted simply because it supplies:


32.26 Guardian Relationship History
Relationship records may need:
start_date
end_date
status
This becomes useful if:
guardianship changes,
a guardian loses access,
a relationship becomes inactive.
The exact legal/relationship model can remain configurable.

32.27 Student Documents
Documents should not be stored as binary data directly inside the Student record.
Instead:
Student
  ↓
Student Document Metadata
  ↓
File Service
Conceptually:
student_documents
-----------------
id
tenant_id
student_id
document_type
file_id
status
issued_at
expires_at
created_at
updated_at
The actual storage location belongs to the File Service.

32.28 Student Document Ownership
Student owns:
What is this document and why does it belong to this student?
File Service owns:
Where is the file stored and how is it retrieved securely?
This keeps the boundary clean.

32.29 Student History
Do not create an enormous generic:

table that attempts to duplicate every change.
Instead use:
domain audit for field-level important changes,
lifecycle timestamps,
enrollment history,
admission history,
relationship history,
other domain-specific historical records.
This is more meaningful than a generic historical copy of the Student row.

32.30 Academic–Student Relationship
The overall model becomes:
School
 │
 ├── Academic Year
 │      │
 │      ├── Class
 │      │     └── Section
 │      │
 │      └── Subject Offering
 │
 └── Student
        │
        ├── Admission
        │
        ├── Enrollment ─────────→ Academic Year
        │                         Class
        │                         Section
        │
        ├── Guardians
        │
        └── Documents

32.31 Subject Offering Relationship
Then:
Subject
   ↓
Subject Offering
   ├── Academic Year
   ├── Class
   └── potentially Section
Later:
Subject Offering
   ├── Teaching Assignment
   ├── Timetable Entry
   ├── Attendance Session
   └── Examination Paper
Each consuming domain owns its own relationship.

32.32 Tenant Isolation
Every major table here is tenant-owned:
academic_years.tenant_id
academic_classes.tenant_id
academic_sections.tenant_id
subjects.tenant_id
subject_offerings.tenant_id

students.tenant_id
admissions.tenant_id
enrollments.tenant_id
guardians.tenant_id
student_guardians.tenant_id
student_documents.tenant_id
This is intentional.

32.33 Cross-Tenant Protection
For example, this must never be possible:
School A
  Student A
      ↓
School B
  Academic Year B
Application validation and database-level relationship strategy should enforce that the referenced entities belong to the same tenant.

32.34 Recommended Composite Relationships
For relationships such as Enrollment:
enrollments
-----------
tenant_id
student_id
academic_year_id
academic_class_id
academic_section_id
The tenant context should participate in integrity validation.
This will become increasingly important as the schema grows.

32.35 Core Constraints
Initial constraints should include concepts such as:
UNIQUE(tenant_id, student_number)

UNIQUE(tenant_id, academic_year.code)

UNIQUE(tenant_id, academic_class.code)

UNIQUE(tenant_id, subject.code)
Exact uniqueness rules for sections and offerings need to account for their parent relationships.
For example:
UNIQUE(
    tenant_id,
    academic_class_id,
    code
)
for sections.

32.36 Important Indexes
Likely high-value indexes:
students:
  (tenant_id, student_number)
  (tenant_id, status)
  (tenant_id, last_name)

enrollments:
  (tenant_id, academic_year_id)
  (tenant_id, student_id)
  (tenant_id, academic_class_id, academic_section_id)

student_guardians:
  (tenant_id, student_id)
  (tenant_id, guardian_id)

subject_offerings:
  (tenant_id, academic_year_id)
  (tenant_id, academic_class_id)
  (tenant_id, subject_id)
These are starting points, not a final indexing prescription.

32.37 What Belongs in Student
Student owns:
✓ Student identity within school
✓ Student number
✓ Admission
✓ Enrollment
✓ Guardian relationship
✓ Student documents
✓ Student lifecycle
It does not own:
✗ Attendance records
✗ Exam marks
✗ Fee demands
✗ Transport assignments
✗ Library loans
✗ Timetable entries

32.38 What Belongs in Academic
Academic owns:
✓ Academic years
✓ Classes
✓ Sections
✓ Subjects
✓ Subject offerings
✓ Academic configuration
It does not own:
✗ Student identity
✗ Enrollment
✗ Teacher identity
✗ Attendance
✗ Exam results
✗ Timetable

32.39 Why This Boundary Matters
Consider:
"Which class was this student in during 2025–26?"
Student owns the enrollment.
Academic owns the class.
So the query crosses the boundary:
Student
 ↓
Enrollment
 ↓
Academic Class
Neither domain needs to absorb the other's ownership.

32.40 Initial Domain Schema
The conceptual database now looks like:
ACADEMIC
──────────────
academic_years
academic_classes
academic_sections
subjects
subject_offerings


STUDENT
──────────────
students
admissions
enrollments
guardians
student_guardians
student_documents


PLATFORM
──────────────
schools
users
memberships
roles
permissions
role_assignments
subscriptions
entitlements
files
audit_records
outbox_events
jobs
This is enough foundation to proceed without prematurely defining every field.

32.41 One Important Design Question Deferred
There is one issue we should not lock prematurely:
How should class/section changes during an academic year be modeled?
There are two reasonable approaches:
A)
One Enrollment
+
effective-dated enrollment history
or:
B)
Multiple Enrollment records
+
strict lifecycle rules
Because Attendance, Examination, Timetable, Promotion, and reporting all depend on this decision, it should be settled when we design the next domains rather than guessing now.

32.42 Current Database Foundation
At this point the core relationship is:
School
 │
 ├── Users / Memberships / Roles
 │
 ├── Subscription / Entitlement
 │
 ├── Academic
 │    ├── Academic Year
 │    ├── Class
 │    ├── Section
 │    ├── Subject
 │    └── Subject Offering
 │
 └── Student
      ├── Student
      ├── Admission
      ├── Enrollment ──→ Academic
      ├── Guardian
      ├── Student-Guardian
      └── Documents ──→ File Service
This gives us a clean base for the next domains.
Next: Part 33 — Teacher + Attendance Database Design
That phase will resolve several currently deferred questions, especially:
Teaching Assignment
Teacher ↔ Subject Offering
Teacher ↔ Class/Section
Attendance Session
Daily vs subject attendance
Historical roster/context
Attendance corrections
How enrollment changes should be represented so historical attendance remains correct.
