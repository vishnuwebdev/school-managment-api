<!-- Source: Apple Notes, folder 'Notes' -->
# Part 13 — Student Management Domain Foundation

We can now design the Student Management domain on top of the platform foundation.
The important constraint remains: we are not designing the complete database schema yet. First we define ownership, concepts, lifecycle, boundaries, dependencies, permissions, and workflows. Database design comes after those are stable.

13.1 Purpose
Student Management is responsible for the school's student lifecycle and student-related master information.
At a high level:
Student Management
│
├── Student Profile
├── Student Identity
├── Admission
├── Enrollment
├── Academic Association
├── Guardian / Parent Association
├── Student Documents
├── Student Status
└── Student History
It should not own:
Fees
Attendance
Examinations
Transportation
Library
Communication
Those domains can reference the student.

13.2 Student Domain Boundary
The Student domain owns:
Student
Admission
Enrollment
Student Status
Student-Guardian relationship
Student documents
Student academic association
Student history
Other domains consume student information through defined contracts.
For example:
Fee Management
      ↓
needs → Student identity

Attendance
      ↓
needs → Student + academic enrollment

Examination
      ↓
needs → Student + academic enrollment

Transportation
      ↓
needs → Student + transport assignment
The Student module remains the source of truth for student identity and enrollment.

13.3 Student Is Tenant-Owned
Every student belongs to exactly one school tenant in V1.
Conceptually:
School
  │
  ├── Student A
  ├── Student B
  └── Student C
A student cannot belong to School A while being referenced by School B.
Tenant isolation applies to:
student records,
guardians,
documents,
enrollment,
student history,
imports,
exports,
searches,
background jobs.

13.4 Student Identity vs Enrollment
These should be treated as different concepts.
A student is a person/record:
Student
Their relationship with the school's academic structure is:
Enrollment
This distinction is important.
For example:
Student
  ↓
Enrollment
  ↓
Academic Year
  ↓
Class / Section
A student can move between academic years or classes without creating a completely new student identity.

13.5 Recommended Student Lifecycle
A student should have an explicit lifecycle.
For example:
Prospective
    ↓
Admission Pending
    ↓
Admitted
    ↓
Active
    ↓
Transferred / Withdrawn / Graduated
The exact states can be refined later.
We should avoid a single:
is_active = true/false
because it cannot properly represent student history.

13.6 Admission vs Student Creation
These are related but should not necessarily be identical.
Possible flow:
Admission Application
        ↓
Review
        ↓
Approved
        ↓
Student Created
        ↓
Enrollment
        ↓
Active
However, an authorized School Admin may also need to create a student directly.
Therefore the system should support both:
Admission workflow
and:
Direct student creation
without making the student entity dependent on one particular creation workflow.

13.7 Student Number
The platform should support a school-defined student identifier.
Examples:
STU-2026-00125
2026/00125
ADM-2026-045
Important distinction:
Internal ID
≠
Student Number
The internal ID should be system-generated and immutable.
The student number is a business identifier and can follow school-specific numbering rules.

13.8 Student Identity Information
The initial domain can conceptually support:
Personal Information
├── Name
├── Date of Birth
├── Gender
├── Contact information
├── Address
└── Identification information
But we should not finalize every field yet.
Different countries and schools may require different identity information.
Therefore the architecture should allow configurable/custom fields later rather than making every possible country's requirements part of the core student model.

13.9 Guardian / Parent Model
Guardian information should not simply be embedded as:
student.father_name
student.mother_name
Instead, conceptually:
Student
   │
   ├── Guardian A
   ├── Guardian B
   └── Guardian C
with a relationship describing:
Relationship
Contact priority
Primary guardian
Emergency contact
Financial responsibility
Portal access
This supports situations such as:
one parent,
two parents,
legal guardian,
multiple guardians,
emergency contact,
separated parents,
other authorized relationships.

13.10 Guardian Identity
We should also distinguish:
Guardian
from:
User
A guardian may simply exist as a contact record.
They become a system User only if they are later given portal/app access.
Therefore:
Guardian
   ↓ optional
User Account
rather than requiring every guardian to have a login.

13.11 Academic Association
Student Management should maintain the student's academic association, but should not own every academic concept.
For example:
Student
  ↓
Enrollment
  ↓
Academic Year
  ↓
Class
  ↓
Section
The eventual Academic/Class Management domain should own:
academic years,
classes,
sections,
subjects,
academic structures.
Student Management references those structures.

13.12 Avoid Embedding Class Information Directly
Avoid designing the student as:
student.class_name
student.section_name
Instead:
Student
   ↓
Enrollment
   ↓
Class/Section
This preserves history.
For example:
2024–25 → Class 5A
2025–26 → Class 6B
2026–27 → Class 7A
The student record remains the same.

13.13 Enrollment Is Historically Important
Enrollment should allow historical records.
Conceptually:
Student
│
├── Enrollment 2024-25
├── Enrollment 2025-26
└── Enrollment 2026-27
This becomes critical later for:
attendance,
examinations,
fees,
reports,
transcripts,
promotion,
transfer,
graduation.

13.14 Student Status vs Enrollment Status
Keep these separate.
Student status:
ACTIVE
WITHDRAWN
TRANSFERRED
GRADUATED
Enrollment status might be:
ACTIVE
COMPLETED
TRANSFERRED
CANCELLED
They represent different concepts.
A student can have a completed enrollment for one academic year while remaining an active student in the school.

13.15 Feature Structure
The Student Management feature can initially be:
Student Management
│
├── Student Profiles
├── Admissions
├── Enrollment
├── Guardians
├── Documents
└── Student History
These can later become independently configurable sub-features if commercial requirements justify it.
For example:
student.management
student.admission
student.enrollment
student.documents
But we should avoid creating dozens of tiny commercial features without a real requirement.

13.16 Dependencies
Student Management should become one of the foundational school domains.
Potential relationship:
Student Management
        ↓
Academic/Class Management
or depending on the eventual design:
Academic Structure
        ↓
Student Enrollment
The exact dependency direction should be finalized when we design the academic/class domain.
The key point is that we should not hardcode dependencies prematurely before both domains are designed.

13.17 Permissions
Initial permissions could follow the established action-based model:
student.view
student.create
student.update
student.delete
student.import
student.export
student.archive
student.restore
Admission:
admission.view
admission.create
admission.update
admission.approve
admission.reject
Enrollment:
enrollment.view
enrollment.create
enrollment.update
enrollment.transfer
enrollment.complete
Guardians:
guardian.view
guardian.create
guardian.update
guardian.delete
Documents:
student_document.view
student_document.upload
student_document.delete
student_document.download
The final permission catalog should be created after workflows are finalized.

13.18 Sub Admin Examples
The platform should be capable of configurations such as:
Admission Sub Admin
admission.view
admission.create
admission.update
but:
student.delete = denied
Student Records Sub Admin
student.view
student.create
student.update
student.export
Read-only Staff
student.view
guardian.view
This demonstrates why roles and permissions must remain independent from feature entitlement.

13.19 Feature Entitlement Still Applies
Even if a user has:
student.create
the operation is denied if the school does not have the Student Management entitlement.
Therefore:
School Entitlement
        AND
User Permission
are both required.

13.20 Student Documents
Documents should use the platform file service rather than embedding file storage logic directly in Student Management.
Conceptually:
Student
   ↓
Student Document Metadata
   ↓
File Service
   ↓
Private Storage
The document metadata can include:
document type
owner
file reference
uploaded by
uploaded at
verification status
Actual storage remains the responsibility of the platform file service.

13.21 Import / Bulk Creation
Student import will likely become an important capability.
Possible workflow:
Upload CSV/Excel
       ↓
Validate
       ↓
Preview Errors
       ↓
Confirm Import
       ↓
Background Job
       ↓
Create Students
       ↓
Import Summary
Important:
The import job must carry:
tenant_id
actor
job_id
and every imported record must remain within that tenant.

13.22 Duplicate Detection
Student creation should consider duplicate detection.
Potential matching signals:
Student number
Name
Date of birth
Guardian/contact
School-specific identifiers
But we should not make fuzzy matching an automatic destructive action.
A safer workflow:
Potential Duplicate
        ↓
Warn User
        ↓
User Reviews
        ↓
Create / Merge / Cancel
The actual merge capability can be deferred until requirements justify it.

13.23 Student Merge
This is a potentially dangerous operation.
If eventually supported:
Student A
Student B
   ↓
Merge
   ↓
Canonical Student
we must consider dependencies from:
fees,
attendance,
examinations,
transportation,
documents,
audit,
communications.
Therefore student merge should not be part of the initial implementation unless required.
The architecture should simply avoid making future correction impossible.

13.24 Transfer
A student may leave one school.
Within this tenant:
Active
 ↓
Transfer Requested
 ↓
Transfer Approved
 ↓
Transferred
But we should distinguish:
Student transferred out
from:
Student moved from Class 5 to Class 6
The first is a student lifecycle event.
The second is an academic enrollment change.

13.25 Student History
Important changes should be historically visible.
For example:
Student Created
Admission Approved
Enrollment Created
Class Changed
Guardian Changed
Status Changed
Document Added
Transferred
The detailed audit trail belongs to the platform audit system.
Student Management can additionally maintain domain-specific history where it improves reporting or business functionality.

13.26 Audit Requirements
Student operations requiring audit should include:
Student creation
Student update
Student deletion/archive
Student restoration

Admission approval/rejection

Enrollment creation
Enrollment change
Enrollment transfer

Guardian changes

Sensitive document operations

Bulk imports
Exports

Student merge, if introduced
The audit record should identify:
Who
Which school
What changed
When
Why, where required

13.27 Events
Useful Student domain events:
StudentCreated
StudentUpdated
StudentArchived
StudentRestored

AdmissionCreated
AdmissionApproved
AdmissionRejected

EnrollmentCreated
EnrollmentChanged
EnrollmentTransferred
EnrollmentCompleted

GuardianAdded
GuardianUpdated
GuardianRemoved
These events can later be consumed by:
Fees
Attendance
Examination
Notifications
Reporting
Transportation
without tightly coupling those modules to Student internals.

13.28 Example Cross-Domain Flow
When a student is enrolled:
Student Module
      ↓
EnrollmentCreated
      ↓
┌─────┼─────────────┐
↓     ↓             ↓
Fees  Attendance    Examination
Each domain reacts according to its own business rules.
Student Management does not directly call all three modules.

13.29 Reporting Boundary
Student Management can own student-oriented reports such as:
Student List
Student Profile
Enrollment History
Admission Report
Student Status Report
Guardian Directory
But reports involving multiple domains should eventually belong to a reporting/read-model layer.
For example:
Student + Fee + Attendance + Exam
should not force the Student domain to own financial or examination logic.

13.30 Initial Student Domain Boundary
The current recommendation is:
                    STUDENT DOMAIN
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
   Identity          Admission         Enrollment
       │                 │                 │
   Profile           Application      Academic Link
       │
   Guardians
       │
   Documents
       │
   History
Outside its boundary:
Fees
Attendance
Exams
Transportation
Library
Communication
Those will reference Student contracts.

13.31 What We Should NOT Design Yet
For now, deliberately avoid finalizing:
❌ Complete student database schema
❌ Every student field
❌ Fee/student financial relationship
❌ Attendance tables
❌ Exam tables
❌ Transportation tables
❌ Parent portal architecture
❌ Advanced admission workflow
❌ Student merge implementation
❌ Multi-campus student ownership
Those decisions need the surrounding domains.

13.32 Student Domain Foundation
So the conceptual model becomes:
School / Tenant
       │
       └── Student
             │
             ├── Profile
             ├── Guardians
             ├── Documents
             ├── Admissions
             │
             └── Enrollments
                    │
                    ├── Academic Year
                    ├── Class
                    └── Section
with:
Student
   ↓
Events / Contracts
   ↓
Fees
Attendance
Examination
Transportation
Communication
Reporting
This gives us a clean boundary without prematurely designing the entire school-management database.
The next logical domain is Academic/Class Management, because Student Enrollment needs a stable academic structure for academic year, class, section, and eventually subjects.
