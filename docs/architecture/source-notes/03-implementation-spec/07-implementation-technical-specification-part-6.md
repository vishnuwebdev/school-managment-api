<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 6

Teacher Management
Teacher Management owns the school's teacher/staff teaching identity and teaching assignments.
The key boundary is:
Teacher
  ≠
User
  ≠
Teaching Assignment
Teacher = school-domain person who teaches.
User = platform identity/login.
Teaching Assignment = what the teacher teaches and where.

211. Teacher Module Boundary
Teacher Management owns:
Teacher
Teacher Qualifications
Teacher Documents
Employment Information
Teaching Assignments
Teacher History
It does not own:
users/authentication
academic years/classes/subjects
attendance
examinations
timetable
leave
payroll

212. teachers
teachers
--------
id
tenant_id
teacher_number
employee_number
user_id
first_name
middle_name
last_name
preferred_name
date_of_birth
gender
email
phone
status
join_date
employment_type
department
photo_file_id
created_at
updated_at
version
user_id is nullable.
A teacher does not require a platform login.

213. Teacher Identity
Use two identifiers:
Internal ID
teacher.id
Opaque system identifier.
Teacher Number
School-facing identifier:
teacher_number
Constraint:
UNIQUE(tenant_id, teacher_number)
If the school already has an employee-number system, employee_number can be separately maintained.

214. Teacher Lifecycle
PROSPECTIVE
    ↓
ONBOARDING
    ↓
ACTIVE
    ↓
INACTIVE
    ↓
RESIGNED / TERMINATED
    ↓
ARCHIVED
Additional operational state:
ON_LEAVE
However, leave should normally be represented by the Leave module rather than permanently changing the teacher's lifecycle status.
Therefore:
ON_LEAVE is preferably an operational availability state, not the primary employment status.

215. Teacher Status
Use:
PROSPECTIVE
ONBOARDING
ACTIVE
INACTIVE
RESIGNED
TERMINATED
ARCHIVED
Employment lifecycle commands are explicit.
Do not allow arbitrary status mutation through generic update APIs.

216. Teacher Employment Information
For V1, keep basic employment information with the Teacher domain.
Examples:
employment_type
join_date
employee_number
department
designation
Potential future payroll/HR functionality should not force Teacher Management to become Payroll.

217. Employment Types
Make configurable rather than hardcoded.
Examples:
FULL_TIME
PART_TIME
CONTRACT
TEMPORARY
VISITING
OTHER

218. Teacher Qualifications
teacher_qualifications
----------------------
id
tenant_id
teacher_id
qualification_type
title
institution
specialization
issue_date
document_file_id
status
created_at
updated_at
Examples:
B.Ed
M.Ed
B.Sc
M.Sc
Diploma
Certification
Qualification types can be configured.

219. Qualification Status
ACTIVE
EXPIRED
REVOKED
ARCHIVED
Not every qualification requires an expiry date.

220. Teacher Documents
teacher_documents
-----------------
id
tenant_id
teacher_id
file_id
document_type
document_number
issued_date
expiry_date
status
uploaded_by
created_at
updated_at
Examples:
IDENTITY_DOCUMENT
QUALIFICATION_CERTIFICATE
EMPLOYMENT_DOCUMENT
BACKGROUND_CHECK
OTHER
Actual files are stored by the common File Service.

221. Teacher User Account
If a teacher receives a login:
Teacher
   ↓
user_id
   ↓
User
Creating a teacher must not automatically create a User unless the workflow explicitly requests account creation.
Likewise, disabling a teacher account does not necessarily delete the global User.

222. Teaching Assignment
Teaching Assignment is the core relationship:
Teacher
   ↓
Teaching Assignment
   ↓
Subject Offering
This provides the connection to:
academic year
class
section
subject

223. teaching_assignments
teaching_assignments
--------------------
id
tenant_id
teacher_id
subject_offering_id
assignment_type
status
effective_from
effective_until
is_primary
created_at
updated_at
version

224. Assignment Types
Initial configurable types:
PRIMARY
CO_TEACHER
ASSISTANT
SUBSTITUTE
OTHER
The domain can later expand these without changing the underlying relationship.

225. Assignment Status
ACTIVE
SUSPENDED
ENDED
CANCELLED
Use effective dates for historical accuracy.

226. Teaching Assignment History
Do not overwrite:
Teacher A
 → Mathematics
 → Grade 5A
with:
Teacher A
 → Mathematics
 → Grade 6A
Create a new assignment.
This preserves:
attendance authorization history
examination evaluation history
timetable history
reporting history

227. Assignment Uniqueness
Prevent accidental duplicate active assignments.
The application should enforce appropriate uniqueness such as:
teacher
+
subject offering
+
active assignment
The exact rule depends on whether multiple teachers are allowed for one offering.
Because co-teaching is supported, the system must not enforce only one teacher per offering globally.

228. Primary Teacher
If the business rule allows one primary teacher:
Subject Offering
      ↓
one PRIMARY teacher
      +
zero or more CO_TEACHERS
This should be enforced transactionally.

229. Teacher Authorization
Typical permissions:
teacher.view
teacher.create
teacher.update
teacher.archive
teacher.export

teacher.qualification.view
teacher.qualification.manage

teacher.document.view
teacher.document.upload
teacher.document.verify

teaching_assignment.view
teaching_assignment.create
teaching_assignment.update
teaching_assignment.end

230. Teacher Scope
School Admin:
TENANT_WIDE
Academic/Sub Admin may have:
ASSIGNED_CLASSES
Teachers may operate against their own assignment-derived resources.
For example:
Teacher
 ↓
Teaching Assignment
 ↓
Subject Offering
 ↓
Grade 5A
This becomes the authorization source for Attendance and Examination.

231. Resource Authorization
A teacher attempting to modify attendance should not simply receive:
teacher.view
and be allowed to modify any student.
The authorization chain becomes:
Teacher User
 ↓
Teacher Identity
 ↓
Active Teaching Assignment
 ↓
Subject/Class/Section
 ↓
Student Enrollment
 ↓
Requested Operation
The Attendance domain performs the final domain-specific authorization.

232. Teacher APIs
Base:
/api/v1/teachers
/api/v1/teachers/:id
Qualifications:
/api/v1/teachers/:id/qualifications
/api/v1/teacher-qualifications/:id
Documents:
/api/v1/teachers/:id/documents
/api/v1/teacher-documents/:id
Assignments:
/api/v1/teachers/:id/teaching-assignments
/api/v1/teaching-assignments/:id
Lifecycle:
POST /teachers/:id/activate
POST /teachers/:id/inactivate
POST /teachers/:id/resign
POST /teachers/:id/terminate
POST /teachers/:id/archive

233. Teacher Application Services
CreateTeacher
UpdateTeacher
GetTeacher
ListTeachers
ArchiveTeacher

ActivateTeacher
InactivateTeacher
ResignTeacher
TerminateTeacher

AddQualification
UpdateQualification
ArchiveQualification

UploadTeacherDocument
VerifyTeacherDocument

CreateTeachingAssignment
UpdateTeachingAssignment
EndTeachingAssignment

234. Teacher Domain Events
TeacherCreated
TeacherUpdated
TeacherActivated
TeacherInactivated
TeacherResigned
TeacherTerminated
TeacherArchived

TeacherQualificationAdded
TeacherQualificationUpdated
TeacherQualificationArchived

TeacherDocumentUploaded
TeacherDocumentVerified

TeachingAssignmentCreated
TeachingAssignmentUpdated
TeachingAssignmentEnded

235. Academic Integration
Teacher Management references:
subject_offering_id
It does not duplicate:
subject name
class name
section name
academic year name
When displaying these, resolve them through Academic application interfaces or appropriate read models.

236. Attendance Integration
Attendance can determine teacher authorization through:
Teaching Assignment
       ↓
Subject Offering
       ↓
Attendance Session
A teacher may mark attendance only where the assignment and attendance rules permit.
Teacher Management does not own attendance records.

237. Examination Integration
Examination can associate an evaluator with a teacher:
Assessment
 ↓
Evaluator
 ↓
Teacher
Teacher Management provides teacher identity/status.
Examination owns evaluator workflow.

238. Timetable Integration
Timetable references Teacher through stable ID.
Timetable Entry
 ├── Teacher
 ├── Subject Offering
 ├── Section
 └── Room
Timetable owns scheduling.
Teacher owns the teacher.

239. Leave Integration
Leave Management references Teacher:
Teacher
 ↓
Leave Request
 ↓
Approved Leave
 ↓
Staff Availability
Leave does not directly edit teaching assignments.
Timetable determines operational impact.

240. Teacher Account Revocation
If a teacher leaves:
Teacher → RESIGNED/TERMINATED
the system should:
stop new teaching assignments
end applicable active assignments
prevent new operational actions
revoke/suspend the associated school membership where applicable
preserve historical teacher references
The global User may remain because it is an identity record.

241. Teacher Deletion
Normal physical deletion is prohibited once the teacher has:
assignments
attendance references
examination references
timetable references
leave history
audit records
Use lifecycle states instead.

242. Teacher Search
Searchable:
teacher number
employee number
name
email
phone
department
designation
Always tenant-scoped.

243. Teacher Bulk Import
Use standard bulk workflow:
Upload
 ↓
Validate
 ↓
Preview
 ↓
Confirm
 ↓
Background Job
 ↓
Import Result
Validate:
teacher number uniqueness
employee number rules
required fields
qualification data
assignment references
Do not automatically create User accounts unless explicitly requested.

244. Teacher Audit
Audit:
creation
sensitive profile changes
employment status changes
qualification verification
document verification
teaching assignments
primary teacher changes
termination/resignation
archive
exports
bulk imports

245. Concurrency
Important operations:
Primary teacher assignment
Use transaction protection so two concurrent requests cannot both become primary.
Assignment changes
Use optimistic versioning.
Termination
Transactionally end applicable active assignments and record lifecycle state.

246. Teacher Domain Contract
Teacher Management
│
├── Teacher
├── Employment Information
├── Qualifications
├── Documents
├── Teaching Assignments
└── Teacher History
Dependencies:
Teacher
   ↓
references Academic Subject Offering

Teacher
   ↓
referenced by Attendance

Teacher
   ↓
referenced by Examination

Teacher
   ↓
referenced by Timetable

Teacher
   ↓
referenced by Leave
Teacher Management remains the source of truth for teacher identity and assignment relationships.

Next Domain
The next specification is Attendance Management, including:
daily attendance
subject/period attendance
attendance sessions
attendance statuses
teacher authorization
corrections
approval/finalization
bulk marking
attendance history
Student + Academic + Teacher integration
APIs, schema, events, concurrency and audit.
