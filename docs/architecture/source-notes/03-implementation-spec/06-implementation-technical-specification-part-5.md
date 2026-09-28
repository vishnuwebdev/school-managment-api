<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 5

Academic / Class Management
Academic Management owns the school's academic structure and configuration.
Academic Year
    ↓
Class / Grade
    ↓
Section

Subject
    ↓
Subject Offering
    ↓
Academic Year + Class + Section
It does not own students, teachers, attendance, examinations, or timetable records.

172. Academic Module Boundary
Owns:
academic years
classes/grades
sections
subjects
subject offerings
academic configuration
academic structure history
References:
Students from Student Management
Teachers from Teacher Management
Consumed by:
Attendance
Examination
Timetable
Reporting
Parent Portal

173. Academic Year
Academic year is a tenant-owned business period.
Example:
2026–2027
It should not be represented merely by a string.

174. academic_years
academic_years
--------------
id
tenant_id
code
name
start_date
end_date
status
is_current
created_at
updated_at
version
Example:
code = "2026-2027"
name = "Academic Year 2026-2027"

175. Academic Year Lifecycle
DRAFT
  ↓
UPCOMING
  ↓
ACTIVE
  ↓
COMPLETED
  ↓
ARCHIVED
Rules:
Only an appropriate future year can become UPCOMING.
ACTIVE means operational academic activity can occur.
Completed years remain queryable.
Archived years are historical and normally immutable.

176. Current Academic Year
A tenant may have at most one:
ACTIVE + is_current = true
The database/application must protect this invariant.
A new year becoming active should happen through a controlled transition rather than manually changing multiple rows.

177. Academic Year Validation
Require:
start_date < end_date
Prevent overlapping active operational years unless the school's configuration explicitly supports that scenario.
For V1:
one active academic year at a time is the default.

178. Classes / Grades
Do not hardcode:
Grade 1
Grade 2
...
Grade 12
Schools may have:
Kindergarten
Pre-primary
Grade 1–12
Year 1–6
Form 1–5
university-style structures
custom levels

179. academic_classes
academic_classes
----------------
id
tenant_id
code
name
display_name
sequence
status
created_at
updated_at
Example:
code = "GRADE_01"
name = "Grade 1"
sequence = 1
sequence controls display/order, not identity.

180. Class Status
ACTIVE
INACTIVE
ARCHIVED
A class definition can be reused across academic years.
The actual academic-year placement belongs to the section/academic structure.

181. Sections
A section represents a class grouping within an academic year.
academic_sections
-----------------
id
tenant_id
academic_year_id
class_id
code
name
capacity
status
created_at
updated_at
version
Example:
Grade 5
 ├── Section A
 ├── Section B
 └── Section C

182. Section Uniqueness
Within an academic year:
UNIQUE(
  tenant_id,
  academic_year_id,
  class_id,
  code
)
This prevents duplicate Section A under the same class/year.

183. Section Capacity
Capacity is optional but useful.
capacity
If configured:
active enrollments <= capacity
Capacity validation occurs during enrollment.
This is a transactional business rule, not merely a UI check.

184. Section Lifecycle
DRAFT
 ↓
ACTIVE
 ↓
CLOSED
 ↓
ARCHIVED
A section should not be physically deleted after students or historical records reference it.

185. Subjects
Subject is an independent academic concept.
subjects
--------
id
tenant_id
code
name
description
subject_type
status
created_at
updated_at
Examples:
MATHEMATICS
ENGLISH
SCIENCE
HISTORY
COMPUTER_SCIENCE

186. Subject Types
Avoid hardcoding too much.
Initial configurable classification:
CORE
ELECTIVE
OPTIONAL
EXTRACURRICULAR
OTHER
The exact categories can be tenant-configured.

187. Subject Offering
A subject is not automatically taught to every class.
Subject Offering represents:
This subject is offered to this academic group during this academic year.
subject_offerings
-----------------
id
tenant_id
academic_year_id
subject_id
class_id
section_id
code
status
created_at
updated_at
This becomes the central academic relationship used by later domains.

188. Subject Offering Examples
2026-2027
Grade 5
Section A
Mathematics
and separately:
2026-2027
Grade 6
Section A
Mathematics
Same subject, different offering.

189. Section-Level vs Class-Level Offerings
The architecture should support both:
Class-level
Grade 5
Mathematics
applies to all sections.
Section-level
Grade 5 / Section A
Mathematics
applies only to that section.
Represent this using nullable:
section_id
with application rules determining whether the offering is class-wide or section-specific.

190. Subject Offering Constraints
Prevent duplicates such as:
same academic year
+
same subject
+
same class
+
same section
creating multiple active offerings unintentionally.
Use database uniqueness where possible and transaction validation for status-sensitive cases.

191. Academic Configuration
Academic settings should be tenant-owned.
Examples:
academic_configuration
----------------------
tenant_id
grading_model
academic_year_pattern
section_capacity_policy
promotion_policy
attendance_mode
...
Do not put every future academic setting into this table as columns.
For flexible settings, use typed configuration records or a controlled configuration model.

192. Academic Year APIs
/api/v1/academic-years
/api/v1/academic-years/:id

POST /academic-years/:id/open
POST /academic-years/:id/activate
POST /academic-years/:id/complete
POST /academic-years/:id/archive
Transitions are commands, not arbitrary status updates.

193. Class APIs
/api/v1/academic-classes
/api/v1/academic-classes/:id
Sections:
/api/v1/academic-years/:yearId/sections
/api/v1/sections/:id
Subjects:
/api/v1/subjects
/api/v1/subjects/:id
Subject offerings:
/api/v1/subject-offerings
/api/v1/subject-offerings/:id

194. Academic Application Services
CreateAcademicYear
UpdateAcademicYear
ActivateAcademicYear
CompleteAcademicYear
ArchiveAcademicYear

CreateClass
UpdateClass
ArchiveClass

CreateSection
UpdateSection
CloseSection
ArchiveSection

CreateSubject
UpdateSubject
ArchiveSubject

CreateSubjectOffering
UpdateSubjectOffering
DeactivateSubjectOffering

195. Student Integration
Academic Management does not own enrollment.
Student Management creates/changes:
Enrollment
 ↓
Academic Year
Class
Section
Academic validates that referenced academic structures are valid.
This is a controlled cross-domain application interface.

196. Teacher Integration
Teacher Management owns:
Teacher
Teaching Assignment
The teaching assignment references:
Subject Offering
Academic Management does not store teacher ownership information in Subject.

197. Teaching Assignment Relationship
Conceptually:
Teacher
   ↓
Teaching Assignment
   ↓
Subject Offering
   ↓
Academic Year + Class + Section + Subject
This becomes the foundation for:
attendance
examination evaluation
timetable
teacher class scope

198. Academic Authorization
Permissions:
academic_year.view
academic_year.create
academic_year.update
academic_year.activate
academic_year.complete
academic_year.archive

class.view
class.create
class.update
class.archive

section.view
section.create
section.update
section.close

subject.view
subject.create
subject.update
subject.archive

subject_offering.view
subject_offering.create
subject_offering.update
subject_offering.archive

199. Academic Scopes
Administrative academic configuration normally uses:
TENANT_WIDE
Some users may receive:
ASSIGNED_CLASSES
But resource-level scope should be resolved through the authorization layer.

200. Academic Events
Important events:
AcademicYearCreated
AcademicYearActivated
AcademicYearCompleted
AcademicYearArchived

ClassCreated
ClassUpdated
ClassArchived

SectionCreated
SectionActivated
SectionClosed
SectionArchived

SubjectCreated
SubjectUpdated
SubjectArchived

SubjectOfferingCreated
SubjectOfferingUpdated
SubjectOfferingDeactivated

201. Student Events Consumed
Academic-related processes may consume:
StudentAdmitted
EnrollmentCreated
EnrollmentActivated
EnrollmentTransferred
EnrollmentWithdrawn
StudentGraduated
The purpose is to update read models, validate workflows, or trigger downstream processes.
Academic tables should not be modified directly by event consumers outside the Academic module.

202. Academic Read Models
For common views such as:
"Show all students in Grade 5A with their subjects and teachers"
do not create a massive cross-domain SQL query.
Use:
Student
+
Academic
+
Teacher events
        ↓
Academic read model
when query volume or complexity justifies it.
The source domains remain authoritative.

203. Academic Concurrency
Important operations:
Activate academic year
Ensure only one active year.
Create section
Prevent duplicate section codes.
Enroll student
Validate capacity with appropriate transaction locking.
Create offering
Prevent duplicate active offerings.
Close section
Validate outstanding operational dependencies as defined by business rules.

204. Academic Year Transition
A future operational workflow can support:
Current Year
     ↓
Create Next Year
     ↓
Configure Classes
     ↓
Create Sections
     ↓
Create Subject Offerings
     ↓
Student Promotion / New Enrollment
     ↓
Activate Next Year
     ↓
Complete Previous Year
Promotion is not part of the basic Academic entity model; it is an application workflow spanning Student + Academic.

205. Promotion
Promotion should be treated as a controlled workflow:
Current Enrollment
       ↓
Eligibility / Review
       ↓
Next Academic Year
       ↓
New Enrollment
Do not update the old enrollment's class/section.
The old enrollment remains historical.

206. Historical Integrity
Once an academic year is completed:
historical class definitions remain
historical sections remain
historical subject offerings remain
historical enrollments remain
historical teacher assignments remain
reporting can reconstruct the past state
Do not repurpose an old section to represent a completely different historical structure.

207. Academic Delete Rules
Normal physical deletion is discouraged.
Use:
Subject → ARCHIVED
Section → ARCHIVED/CLOSED
Class → ARCHIVED
Academic Year → ARCHIVED
If a draft object has never been referenced, physical deletion may be permitted according to repository rules.

208. Academic Audit
Audit:
academic year creation/activation/completion
class changes
section creation/capacity changes
subject changes
subject offering changes
academic configuration changes
promotion workflows
archive/close operations
Especially important:
capacity changes
academic-year transitions
subject-offering changes
because they can affect downstream domains.

209. Academic Domain Contract
The module now provides other domains with stable interfaces such as:
academicYearService.getActive(tenantId)

classService.getById(tenantId, classId)

sectionService.getById(tenantId, sectionId)

subjectService.getById(tenantId, subjectId)

subjectOfferingService.getById(
  tenantId,
  offeringId
)
Other domains should not import Academic repositories.

210. Academic Module Final Structure
Academic Management
│
├── Academic Year
│
├── Class / Grade
│
├── Section
│
├── Subject
│
├── Subject Offering
│
└── Academic Configuration
Relationships:
Academic Year
 ├── Sections
 │     └── Class
 │
 └── Subject Offerings
       ├── Subject
       ├── Class
       └── optional Section
Student enrollment and Teacher teaching assignments remain separate modules.

Next Domain
The next implementation specification will cover Teacher Management, including:
Teacher
qualifications
documents
employment information
teacher lifecycle
teaching assignments
class/subject scope
authorization
APIs
events
integration with Academic, Attendance, Examination and Timetable.
