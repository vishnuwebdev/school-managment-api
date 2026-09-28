<!-- Source: Apple Notes, folder 'Notes' -->
# Part 14 — Academic / Class Management Domain Foundation

The next foundational domain is Academic Structure, because Student Enrollment, Attendance, Examination, Timetable, and several future modules will depend on it.
The key design principle is:
Academic Structure defines the school's academic organization; Student Management defines the student's relationship to that structure.
We should keep those responsibilities separate.

14.1 Domain Purpose
Academic/Class Management defines:
Academic Structure
│
├── Academic Years
├── Classes / Grades
├── Sections
├── Subjects
├── Class-Section Organization
├── Subject Assignments
└── Academic Configuration
It should not own:
Students
Teachers
Attendance
Examinations
Fees
Timetable
Those domains consume the academic structure.

14.2 The Core Hierarchy
A useful conceptual hierarchy is:
School
  │
  └── Academic Year
        │
        └── Class / Grade
              │
              └── Section
For example:
2026–27
│
├── Grade 5
│    ├── Section A
│    └── Section B
│
├── Grade 6
│    ├── Section A
│    └── Section B
│
└── Grade 7
     ├── Section A
     └── Section B

14.3 Academic Year
Academic Year should be an explicit entity rather than just two dates scattered across tables.
Conceptually:
Academic Year
├── Name
├── Start Date
├── End Date
├── Status
└── Configuration
Lifecycle could be:
Draft
 ↓
Upcoming
 ↓
Active
 ↓
Completed
 ↓
Archived
Only one or a controlled number of academic years should normally be considered active according to school configuration.

14.4 Academic Year Is Tenant-Owned
Academic years belong to the school:
School A
 ├── 2025–26
 └── 2026–27

School B
 ├── 2025–26
 └── 2026–27
Even if both schools use the same calendar naming convention, they are independent tenant data.

14.5 Class / Grade
We should distinguish the academic level from a specific section.
For example:
Grade 6
is different from:
Grade 6 - Section A
The class/grade represents the academic level.
The section represents an organizational subdivision.

14.6 Section
A section belongs to a class/grade within an academic context.
Example:
Grade 6
 ├── A
 ├── B
 └── C
But avoid assuming every school uses the same naming model.
A school might use:
A
B
C
or:
Red
Blue
Green
or custom names.
Therefore section names should be configurable.

14.7 Academic Structure vs Student Enrollment
This distinction is critical.
Academic domain:
Grade 6
Section A
Student domain:
Student X
   ↓
Enrollment
   ↓
Grade 6 / Section A
The Academic domain doesn't own Student X.
The Student domain owns the enrollment relationship.

14.8 Historical Academic Structure
Academic structures should not be casually overwritten.
For example:
2025–26
Grade 6
 ├── A
 └── B

2026–27
Grade 6
 ├── A
 ├── B
 └── C
The school can change its structure between academic years without destroying historical relationships.

14.9 Subject Management
Subjects should also belong to the academic structure domain, at least initially.
Example:
Mathematics
English
Science
Social Studies
Hindi
Computer Science
But we should distinguish:
Subject
from:
Subject offered to Grade 6
The first is a reusable subject definition.
The second is an academic offering/assignment.

14.10 Subject Assignment
Conceptually:
Academic Year
   ↓
Grade / Section
   ↓
Subject Offering
Example:
Grade 6A
│
├── Mathematics
├── English
├── Science
└── Hindi
This becomes important later for:
examination,
timetable,
teacher assignment,
attendance,
curriculum.

14.11 Don't Put Teacher Ownership Here
Academic Structure may define:
Mathematics is taught to Grade 6A
But Teacher Management should determine:
Teacher X
   ↓
assigned to
   ↓
Mathematics / Grade 6A
The academic domain defines the academic structure.
The Teacher domain owns teacher identity and employment information.

14.12 Class vs Section vs Academic Offering
We should maintain three conceptual levels:
Class / Grade
      ↓
Section
      ↓
Academic Offering
Example:
Grade 6
  ↓
Section A
  ↓
Mathematics
This prevents a common design problem where one table tries to represent class, section, subject, and teaching assignment simultaneously.

14.13 Optional Curriculum Concept
Eventually we may need:
Curriculum
  ↓
Subject
  ↓
Grade
  ↓
Topics / Units
But this should not be made part of the initial Academic Structure unless the product actually requires curriculum management.
Curriculum can become a separate domain later.

14.14 Academic Configuration
Schools may have different structures.
Examples:
School A
Primary / Middle / Secondary

School B
Grade 1–12

School C
Nursery / LKG / UKG / Grade 1...
Therefore the platform should avoid hardcoded assumptions such as:
Grades = 1 to 12
The school configures its academic structure.

14.15 Academic Year Configuration
The school may need settings such as:
Default academic year
Promotion enabled
Section structure
Grading configuration reference
Working calendar reference
But configuration should remain separate from the core academic entities.

14.16 Permissions
Initial action-level permissions could include:
academic_year.view
academic_year.create
academic_year.update
academic_year.archive
academic_year.activate
Class:
class.view
class.create
class.update
class.archive
Section:
section.view
section.create
section.update
section.archive
Subject:
subject.view
subject.create
subject.update
subject.archive
Assignments:
academic_offering.view
academic_offering.create
academic_offering.update
academic_offering.delete
These can later be refined.

14.17 Feature Structure
Initially:
Academic Management
│
├── Academic Years
├── Classes
├── Sections
└── Subjects
Potentially later:
Academic Management
├── Academic Years
├── Classes & Sections
├── Subjects
├── Curriculum
├── Promotion
└── Academic Configuration
Again, we shouldn't make every future concept a V1 feature.

14.18 Dependencies
The relationship should be approximately:
Academic Structure
       ↑
Student Enrollment
Meaning Student enrollment references academic structure.
Then:
Academic Structure
       ↓
┌──────┼─────────┬──────────┐
↓      ↓         ↓          ↓
Exam  Attendance Timetable Teacher Assignment
The academic structure becomes a shared reference foundation.

14.19 Promotion
Promotion deserves special treatment.
Conceptually:
2025–26
Grade 5A
   ↓
Promotion
   ↓
2026–27
Grade 6A
But promotion is not simply an update to the student's class.
It is a business operation involving:
current enrollment,
target academic year,
target class,
target section,
eligibility,
approval,
exceptions,
audit.
Therefore promotion should eventually be its own workflow/capability.

14.20 Bulk Promotion
A school may want:
Grade 5A
  35 students
       ↓
Promote
       ↓
Grade 6A
This should be treated as a controlled bulk operation.
Workflow:
Select Students
      ↓
Validate
      ↓
Preview
      ↓
Confirm
      ↓
Background Processing
      ↓
Results
Every affected student's enrollment history must remain preserved.

14.21 Section Reassignment
Moving:
Student X
Grade 6A
    ↓
Grade 6B
is different from promotion.
It should update enrollment/assignment appropriately while preserving history.

14.22 Academic Structure Changes
If an administrator wants to deactivate:
Grade 6B
the system should first determine whether active enrollments or other dependencies exist.
It should not silently destroy the structure.
Potential workflow:
Deactivate Section
       ↓
Check Dependencies
       ↓
Show Impact
       ↓
Resolve / Confirm
       ↓
Deactivate
This follows the same dependency philosophy used by platform features.

14.23 Cross-Domain References
Other domains should reference stable identifiers.
For example:
Attendance
  → student_id
  → enrollment_id
  → subject/offering reference
Examination:
Exam
  → academic_year
  → class/section
  → subject offering
Timetable:
Timetable
  → academic structure
  → subject
  → teacher
  → section
The exact persistence relationships will be designed later.

14.24 Academic Context Must Be Explicit
Future requests should not depend on ambiguous global values.
For example, this is dangerous:
GET /students
without knowing which academic context is relevant.
The system should be able to explicitly resolve:
Tenant
+
Academic Year
+
Relevant Class/Section
where the operation requires it.

14.25 Permissions and Scope
Later, school administrators may need:
Academic Admin
  → all classes

Class Coordinator
  → assigned classes

Teacher
  → assigned sections
The permission system already supports this evolution through scopes.
We don't need a complicated scope engine now.

14.26 Audit Requirements
Audit important academic changes:
Academic year creation
Academic year activation/completion

Class creation/update/archive
Section creation/update/archive

Subject creation/update/archive

Academic offering changes

Bulk promotion

Student academic reassignment
For high-impact bulk operations, the audit should identify:
Actor
Tenant
Operation
Affected scope
Number of records
Before/after where practical
Reason
Timestamp

14.27 Events
Useful events:
AcademicYearCreated
AcademicYearActivated
AcademicYearCompleted

ClassCreated
ClassUpdated
ClassArchived

SectionCreated
SectionUpdated
SectionArchived

SubjectCreated
SubjectUpdated
SubjectArchived

AcademicOfferingCreated
AcademicOfferingChanged

PromotionCompleted
Student-specific consequences should be handled through events/contracts rather than tightly coupling Academic Management to Student internals.

14.28 Important Boundary: Promotion Ownership
A subtle architectural question is:
Who owns promotion?
The cleanest approach is likely:
Academic Management
       +
Student Enrollment
with the promotion workflow coordinating both.
Why?
Because promotion involves both:
academic structure,
student enrollment.
We should not force either domain to own concepts belonging entirely to the other.
This may eventually justify a dedicated Academic Operations capability.
We can defer that exact boundary until we design promotion in detail.

14.29 Academic Management Conceptual Model
Current model:
School
  │
  └── Academic Year
        │
        ├── Class / Grade
        │      │
        │      └── Sections
        │
        └── Subject Offerings
                │
                └── Subjects
Student domain:
Student
   ↓
Enrollment
   ↓
Academic Year
   ↓
Class
   ↓
Section
Teacher domain later:
Teacher
   ↓
Teaching Assignment
   ↓
Subject Offering
   ↓
Class / Section
Examination later:
Exam
   ↓
Academic Context
   ↓
Subject Offering
Timetable later:
Timetable
   ↓
Section
   ↓
Subject
   ↓
Teacher
This is the foundation that allows the later domains to connect without owning each other's data.

14.30 What We Should Not Finalize Yet
Still intentionally deferred:
❌ Full database schema
❌ Exact class/section table structure
❌ Curriculum
❌ Grading system
❌ Exam structure
❌ Attendance structure
❌ Timetable structure
❌ Teacher assignment implementation
❌ Promotion algorithm
❌ Multi-campus academic structure
❌ Country-specific education rules
Those belong to later domain design.

14.31 Current Dependency Map
We now have:
                    PLATFORM CORE
                         │
                         ↓
                   SCHOOL / TENANT
                         │
              ┌──────────┴──────────┐
              ↓                     ↓
       ACADEMIC STRUCTURE       STUDENT
              │                     │
              │              ┌──────┴──────┐
              │              ↓             ↓
              │         Admissions     Enrollment
              │                             │
              └──────────────┬──────────────┘
                             ↓
                     FUTURE DOMAINS
                             │
          ┌──────────┬───────┼────────┬─────────┐
          ↓          ↓       ↓        ↓         ↓
      Attendance   Exams    Fees   Timetable  Transport
The next domain to design should be Teacher Management, because we now have the academic structure to which teachers can be assigned, and Teacher Management will establish the foundation needed for Timetable, Attendance, and Examination.
