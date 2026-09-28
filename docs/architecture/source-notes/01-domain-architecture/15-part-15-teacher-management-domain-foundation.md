<!-- Source: Apple Notes, folder 'Notes' -->
# Part 15 — Teacher Management Domain Foundation

Teacher Management should now be designed against the two foundations already established:
Platform Core
      ↓
School / Tenant
      ↓
Academic Structure
      ↓
Teacher Management
The central distinction is:
Teacher Management owns the teacher/personnel relationship with the school. Academic Management owns the academic structure. Teaching Assignment connects the two.

15.1 Domain Purpose
Teacher Management covers:
Teacher Management
│
├── Teacher Profile
├── Employment / Staff Information
├── Teacher Status
├── Teacher Documents
├── Teacher Qualifications
├── Teacher Contacts
└── Teaching Assignments
It should not own:
Students
Classes / Sections
Subjects
Attendance
Examinations
Timetable
Payroll
Those belong to other domains.

15.2 Teacher vs User
This distinction is important.
A teacher is a domain entity:
Teacher
A system login is:
User
They should not be the same object.
Conceptually:
Teacher
   │
   └── optional User Account
A teacher can exist without having portal access.
Later, a teacher can receive a login:
Teacher
   ↓
User Account
   ↓
School Membership
   ↓
Teacher Role
This follows the same pattern used for guardians.

15.3 Teacher Is Tenant-Owned
A teacher belongs to a school tenant in V1:
School A
 ├── Teacher A
 ├── Teacher B
 └── Teacher C
Tenant isolation applies to:
teacher profiles,
documents,
qualifications,
assignments,
searches,
exports,
imports.

15.4 Teacher Identity
Conceptually:
Teacher
├── Internal ID
├── Teacher Number
├── Name
├── Contact Information
├── Date of Birth
├── Gender
├── Address
└── Identification information
The exact fields should remain configurable enough for different school requirements.
Again:
Internal ID
≠
Teacher Number

15.5 Teacher Number
The school may use identifiers such as:
TCH-2026-001
EMP-00125
STAFF-045
The system should support school-specific numbering rules.
The identifier should not be used as the underlying database primary key.

15.6 Teacher Lifecycle
Teacher status needs explicit states.
A reasonable conceptual lifecycle:
Prospective
   ↓
Onboarding
   ↓
Active
   ↓
Inactive / On Leave
   ↓
Resigned / Terminated
   ↓
Archived
Exact statuses can be refined later.
The key principle is avoiding:
is_active = true/false
as the only representation.

15.7 Employment Information
Teacher Management may eventually include:
Employment
├── Employee/Teacher Number
├── Joining Date
├── Employment Type
├── Department
├── Designation
├── Status
└── Exit Information
But this should remain distinct from payroll.
For example:
Teacher Management
       ↓
Employment information

Payroll
       ↓
Salary / payroll processing
Teacher Management should not become a hidden payroll system.

15.8 Qualifications
Teachers may have:
Qualifications
├── Degree
├── Certification
├── Specialization
├── Institution
├── Completion Year
└── Supporting Documents
This can support future requirements such as:
subject specialization,
qualification verification,
staff profiles.

15.9 Teacher Documents
Use the common platform file service:
Teacher
   ↓
Document Metadata
   ↓
Platform File Service
   ↓
Private Storage
Examples:
Identity document
Qualification certificate
Employment document
Contract
Other school document
Actual file storage should not be implemented independently inside Teacher Management.

15.10 Teaching Assignment
This is the most important cross-domain concept.
Academic Management owns:
Subject
Class
Section
Academic Year
Subject Offering
Teacher Management owns:
Teacher
The connection is:
Teacher
   ↓
Teaching Assignment
   ↓
Academic Offering
For example:
Teacher A
    ↓
Mathematics
    ↓
Grade 6A
    ↓
2026–27

15.11 Why Teaching Assignment Should Be Explicit
Avoid storing:
teacher.subject = "Mathematics"
teacher.class = "6A"
That fails when a teacher:
teaches multiple subjects,
teaches multiple sections,
changes classes,
teaches in multiple academic years,
temporarily covers another teacher.
Instead:
Teacher
 ├── Assignment 1 → Grade 6A / Mathematics
 ├── Assignment 2 → Grade 7A / Mathematics
 └── Assignment 3 → Grade 8B / Mathematics

15.12 Assignment Lifecycle
Teaching assignments need their own lifecycle.
For example:
Draft
 ↓
Assigned
 ↓
Active
 ↓
Ended
 ↓
Cancelled
This preserves history.
If Teacher A taught Grade 6A in 2025–26 and Teacher B teaches it in 2026–27, we don't overwrite Teacher A's historical assignment.

15.13 Assignment Ownership
There is an important architectural choice here.
The clean model is:
Teacher Management
    owns Teacher
    owns Teaching Assignment

Academic Management
    owns Academic Offering
Teaching Assignment references the academic offering.
This means Teacher Management knows who is assigned, while Academic Management knows what academic structure exists.

15.14 Teacher Portal Access
If a teacher receives a login:
Teacher
   ↓
User
   ↓
Membership
   ↓
Teacher Role
Permissions might include:
student.view
attendance.view
attendance.mark
exam.view
exam.enter_marks
timetable.view
But the teacher's access is still constrained by assignment/scope.
For example:
Teacher A
assigned to
Grade 6A Mathematics
should not automatically give them:
Grade 9C Mathematics
access.
This is where the future scope mechanism becomes valuable.

15.15 Teacher Permission vs Assignment
These are separate:
Permission
"What may this type of user do?"

Assignment
"Which academic entities is this teacher associated with?"
For example:
Teacher has:
attendance.mark

Assignment:
Grade 6A
Result:
Teacher can mark attendance
for Grade 6A
not every class in the school.

15.16 Teacher Management Feature Structure
Initial feature:
Teacher Management
│
├── Teacher Profiles
├── Teacher Employment
├── Qualifications
├── Documents
└── Teaching Assignments
Possible future additions:
Teacher Management
├── Profiles
├── Employment
├── Qualifications
├── Documents
├── Teaching Assignments
├── Leave
└── Performance
Leave and performance should remain separate domains/capabilities if they become substantial.

15.17 Permissions
Initial permissions:
teacher.view
teacher.create
teacher.update
teacher.archive
teacher.restore
teacher.import
teacher.export
Documents:
teacher_document.view
teacher_document.upload
teacher_document.update
teacher_document.delete
teacher_document.download
Assignments:
teacher_assignment.view
teacher_assignment.create
teacher_assignment.update
teacher_assignment.end
teacher_assignment.cancel
Sensitive employment operations can later receive stronger controls.

15.18 Teacher Feature Entitlement
As always:
Teacher Permission
        AND
School Entitlement
are both required.
A user cannot access Teacher Management merely because their role contains:
teacher.view
if the school's plan doesn't provide the capability.

15.19 Teacher Creation
A teacher may be created directly:
Create Teacher
   ↓
Teacher Active
or through an onboarding workflow:
Staff Candidate
   ↓
Review
   ↓
Approved
   ↓
Teacher Created
   ↓
Onboarding
   ↓
Active
The domain should not make the teacher entity dependent on one particular onboarding workflow.

15.20 Teacher Account Invitation
Creating a teacher does not necessarily create a login.
Possible flow:
Teacher Created
      ↓
Invite to Portal?
      ↓
Yes
      ↓
Create/Link User
      ↓
Membership
      ↓
Assign Role
      ↓
Invitation
Invitation failure should not invalidate the teacher record.

15.21 Teacher Deactivation
If a teacher leaves:
Teacher → Inactive
should not delete:
historical assignments,
attendance records,
examination records,
audit records,
documents.
Instead:
Teacher no longer available for new assignments
while historical relationships remain.

15.22 What Happens to Portal Access?
Teacher lifecycle and user lifecycle are related but separate.
If a teacher becomes inactive:
Teacher Status
     ↓
Access Policy
     ↓
Membership/User access restricted
The platform identity system should handle session/access revocation.
Teacher Management should not implement its own authentication mechanism.

15.23 Teacher Transfer Between Schools
Because users and memberships are separate, future scenarios can be supported.
For example:
Teacher
   ↓
School A Membership
   ↓
School B Membership
However, V1 may restrict a teacher to one school membership if desired.
The architecture should not make multiple-school identity impossible.

15.24 Teacher Documents and Security
Teacher documents may contain sensitive personal information.
Therefore:
Teacher Document
   ↓
Tenant ownership
   ↓
Permission check
   ↓
Controlled file access
Never expose raw storage locations directly to unauthorized users.
Downloads should be permission-controlled.

15.25 Import / Bulk Teacher Creation
Similar to students:
Upload
 ↓
Validate
 ↓
Preview
 ↓
Confirm
 ↓
Background Import
 ↓
Results
Tenant context must accompany the job.
Potential duplicate detection can use:
Teacher Number
Email
Phone
Name
Other school identifier
but duplicate detection should warn before merging or replacing anything.

15.26 Audit Requirements
Audit:
Teacher creation
Teacher updates
Teacher archive/restore
Teacher status changes

Employment changes
Qualification changes

Document operations

Teaching assignment creation
Teaching assignment changes
Teaching assignment termination

Bulk imports
Bulk exports

Portal access/role changes
Especially sensitive employment operations should include a reason where appropriate.

15.27 Events
Useful events:
TeacherCreated
TeacherUpdated
TeacherActivated
TeacherDeactivated
TeacherArchived

TeacherAssignmentCreated
TeacherAssignmentChanged
TeacherAssignmentEnded

TeacherDocumentAdded
TeacherDocumentRemoved

TeacherPortalAccessGranted
TeacherPortalAccessRevoked
Other modules can subscribe without directly modifying Teacher Management data.

15.28 Cross-Domain Relationships
The emerging architecture is:
                    ACADEMIC STRUCTURE
                           │
                 ┌─────────┴─────────┐
                 ↓                   ↓
             Subjects           Class/Section
                 │                   │
                 └─────────┬─────────┘
                           ↓
                  Academic Offering
                           ↑
                           │
                  Teaching Assignment
                           ↑
                           │
                       Teacher
Student:
Student
   ↓
Enrollment
   ↓
Class / Section
This provides the connection between students and teachers without making either domain own the other's records.

15.29 Future Attendance
Attendance can later use:
Student
Enrollment
Academic Context
Teacher
For example:
Teacher
  ↓
Assigned Section
  ↓
Attendance
  ↓
Students in Enrollment
Teacher Management therefore provides the assignment foundation but does not own attendance records.

15.30 Future Examination
Examination may use:
Teacher
   ↓
Teaching Assignment
   ↓
Subject Offering
   ↓
Exam
A teacher may have permission to:
exam.enter_marks
only for assigned subjects/sections.
Again, this is authorization + assignment scope, not a special hardcoded teacher rule.

15.31 Future Timetable
Timetable will connect:
Teacher
+
Subject
+
Section
+
Time
+
Room
Teacher Management owns the teacher.
Academic Management owns the academic entities.
Timetable owns the scheduling relationship.

15.32 Payroll Boundary
Do not put:
Salary
Payroll
Payslip
Tax
Deductions
into Teacher Management merely because teachers are employees.
Instead:
Teacher Management
       │
       ↓
Employment Reference
       │
       ↓
Future Payroll Domain
This prevents the Teacher module from becoming an oversized employee-management system.

15.33 Teacher Domain Conceptual Model
School
  │
  └── Teacher
        │
        ├── Profile
        ├── Employment
        ├── Qualifications
        ├── Documents
        │
        └── Teaching Assignments
                │
                ↓
          Academic Offering
                │
          ┌─────┴─────┐
          ↓           ↓
       Subject     Section
Optional:
Teacher
   ↓
User Account
   ↓
School Membership
   ↓
Permissions + Scope

15.34 What We Should Not Finalize Yet
Still intentionally deferred:
❌ Complete teacher database schema
❌ Payroll
❌ Leave management
❌ Performance management
❌ Detailed staff HR
❌ Teacher appraisal
❌ Teacher substitution engine
❌ Complete timetable engine
❌ Detailed teacher workload calculation
❌ Advanced scope engine
Those should be designed only when their domains are reached.

15.35 Current Foundation Map
We now have three connected domain foundations:
                    PLATFORM CORE
                         │
                         ↓
                    SCHOOL/TENANT
                         │
          ┌──────────────┼──────────────┐
          ↓              ↓              ↓
     ACADEMIC         STUDENT        TEACHER
     STRUCTURE        MANAGEMENT     MANAGEMENT
          │              │              │
          │              └──────┬───────┘
          │                     │
          └──────────┬──────────┘
                     ↓
              FUTURE DOMAINS
                     │
        ┌────────────┼────────────┐
        ↓            ↓            ↓
    Attendance     Exams        Timetable
        │            │            │
        └────────────┼────────────┘
                     ↓
                 Fees / Other
The next major domain should be Attendance, because we now have the three critical references it needs:
Student
+
Enrollment / Academic Structure
+
Teacher / Teaching Assignment
That lets us design attendance without making it responsible for student identity, academic structure, or teacher identity.
