<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 4

Student Management
Student Management is the system of record for the student lifecycle and student-school relationship.
It does not own academic structures, attendance, examinations, fees, transport, library circulation, or communication.

127. Student Module Boundary
Student Management owns:
Student
Admission
Enrollment
Guardian
Student ↔ Guardian relationship
Student Documents
Student History
Student Number
Other domains reference students by stable ID.
Student Management
       │
       ├── Academic
       ├── Attendance
       ├── Examination
       ├── Fees
       ├── Transportation
       ├── Library
       └── Parent Portal
Those domains do not modify Student records directly.

128. Student vs User
These are different concepts.
Student
   ≠
User
A student may:
have no login
later receive a login
be linked to a User
remain only a school-domain identity
The User belongs to Identity.
Student belongs to Student Management.

129. Student Lifecycle
Use:
PROSPECTIVE
    ↓
ADMISSION_PENDING
    ↓
ADMITTED
    ↓
ACTIVE
    ↓
 ┌──────────────┬─────────────┐
 ↓              ↓             ↓
TRANSFERRED   WITHDRAWN    GRADUATED
    \            |             /
             ARCHIVED
Not every transition is mandatory.
For example:
PROSPECTIVE → WITHDRAWN
may be valid depending on the admission process.

130. students
Recommended schema:
students
--------
id
tenant_id
student_number
admission_number
first_name
middle_name
last_name
preferred_name
date_of_birth
gender
status
primary_email
primary_phone
nationality
photo_file_id
user_id
notes
created_at
updated_at
version
Important
user_id is nullable.
A student account is optional.

131. Student Number
Student number is a school-facing identifier.
Constraint:
UNIQUE(tenant_id, student_number)
Do not use student number as the primary key.
Internal references use student.id.
This allows the school to change its numbering policy later without breaking relationships.

132. Admission Number
Admission number is distinct from student number.
This allows:
Admission Number
      ↓
Admission process identity

Student Number
      ↓
Long-term student identity
The exact numbering policy can be configured per school.

133. Student Status
Student status must be controlled through domain transitions.
Do not allow arbitrary:
PUT /students/:id
{
  "status": "GRADUATED"
}
Instead use explicit application commands.
Examples:
admitStudent()
activateStudent()
transferStudent()
withdrawStudent()
graduateStudent()
archiveStudent()
This ensures required validations and audit records are executed.

134. Student Lifecycle Transition Rules
Examples:
Admit
ADMISSION_PENDING
        ↓
ADMITTED
Requires:
valid admission
required student data
authorized actor
Activate
ADMITTED
   ↓
ACTIVE
Usually requires an active enrollment.
Graduate
ACTIVE
   ↓
GRADUATED
Requires applicable academic/business validation.
Transfer
ACTIVE
   ↓
TRANSFERRED
Historical enrollment remains intact.

135. Student History
Important lifecycle changes should produce history.
student_history
--------------
id
tenant_id
student_id
event_type
from_status
to_status
effective_date
reason
actor_id
created_at
This is domain history, not a replacement for platform audit.

136. Admission
Admission is a separate entity from Student.
admissions
----------
id
tenant_id
student_id
admission_number
application_date
status
admission_date
source
notes
created_at
updated_at
Status:
DRAFT
SUBMITTED
UNDER_REVIEW
APPROVED
REJECTED
CANCELLED

137. Admission Workflow
Prospective Student
       ↓
Admission Created
       ↓
Submitted
       ↓
Review
       ↓
Approved
       ↓
Student Admitted
Admission approval does not necessarily activate the student immediately.

138. Enrollment
Enrollment connects a student to an academic structure.
Student Management owns the enrollment relationship, while Academic owns the referenced academic entities.
Student
   ↓
Enrollment
   ├── Academic Year
   ├── Class
   └── Section
This prevents the Student table from becoming tightly coupled to a single academic year/class.

139. enrollments
enrollments
-----------
id
tenant_id
student_id
academic_year_id
class_id
section_id
status
start_date
end_date
enrollment_type
created_at
updated_at
version
Enrollment type may include:
NEW
PROMOTION
TRANSFER_IN
REJOIN
OTHER

140. Enrollment Status
PENDING
ACTIVE
COMPLETED
CANCELLED
TRANSFERRED
WITHDRAWN
The exact lifecycle can be refined with Academic Management, but the important principle is:
Enrollment is historical and effective-dated.

141. Enrollment Uniqueness
Prevent conflicting active enrollment.
Conceptually:
One student
+
One academic year
+
One active enrollment
The database should enforce as much of this as MySQL allows through appropriate constraints/indexing, with application-level transaction validation for state-dependent rules.

142. Enrollment History
Do not overwrite:
Class 5 → Section A
with:
Class 6 → Section B
Create a new enrollment for the new academic period.
This preserves historical academic context.

143. Guardians
Guardian is a domain entity, not automatically a User.
guardian
   ≠
user
A guardian may exist without portal access.

144. guardians
guardians
---------
id
tenant_id
first_name
middle_name
last_name
relationship_label
email
phone
address
occupation
status
user_id
created_at
updated_at
user_id is nullable.
If the guardian later receives Parent Portal access, it can be linked to the global User.

145. Student–Guardian Relationship
Use a join entity rather than placing one guardian ID on Student.
student_guardians
-----------------
id
tenant_id
student_id
guardian_id
relationship_type
is_primary
is_emergency_contact
can_pick_up
portal_access_allowed
effective_from
effective_until
created_at
updated_at
This supports:
multiple guardians
multiple relationships
historical changes
different access rights

146. Guardian Relationship Types
Do not hard-code only:
Mother
Use configurable relationship types.
Examples:
PARENT
GUARDIAN
GRANDPARENT
SIBLING
OTHER
A display label can be tenant-configured.

147. Primary Guardian
A student can have one active primary guardian under the configured rule.
The application must validate this.
Database constraints should support the invariant where practical.
Changing primary guardian must be audited.

148. Guardian Portal Access
portal_access_allowed is a relationship-level access boundary.
The Parent Portal later evaluates:
Authenticated User
 ↓
Guardian
 ↓
Student-Guardian Relationship
 ↓
Access allowed?
 ↓
Student
A guardian cannot simply provide a student ID to obtain access.

149. Student Documents
Student Management owns document meaning.
Storage itself belongs to File Service.
student_documents
-----------------
id
tenant_id
student_id
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
BIRTH_CERTIFICATE
IDENTITY_DOCUMENT
TRANSFER_CERTIFICATE
ADMISSION_DOCUMENT
OTHER
Document types should be configurable.

150. Document Lifecycle
UPLOADED
VERIFIED
REJECTED
EXPIRED
ARCHIVED
The file itself remains in File Service.
Student Management owns whether the document is valid for the student workflow.

151. Student Photo
Student photo should use the common File Service.
Student stores:
photo_file_id
Not the binary content.
Replacing a photo should preserve audit/history where required.

152. Student Account Linking
If a student eventually receives a platform account:
Student
   ↓
user_id
   ↓
User
This relationship must not automatically grant Parent Portal or school permissions.
Identity and authorization remain separate.

153. Duplicate Student Detection
V1 should provide duplicate warnings, not automatic merging.
Potential matching signals:
student number
admission number
name
date of birth
guardian information
The system can flag:
Possible duplicate
but should not automatically merge records.

154. Student Merge
Full merge is deferred.
Reason:
Student records may already be referenced by:
attendance
examinations
fees
transport
library
reports
portal history
A future merge workflow must therefore be an explicit cross-domain operation.

155. Bulk Student Import
Use the standard bulk workflow:
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
Result
Validation includes:
required fields
student number uniqueness
date formats
valid academic references
guardian data
duplicate warnings

156. Bulk Import Result
Each row should have a result:
SUCCESS
FAILED
SKIPPED
WARNING
Example:
Row 42
Status: FAILED
Errors:
- Duplicate student number
Import jobs are tenant-scoped.

157. Student Authorization
Example permissions:
student.view
student.create
student.update
student.delete
student.export

student.admission.view
student.admission.create
student.admission.approve

student.enrollment.view
student.enrollment.create
student.enrollment.update

student.guardian.view
student.guardian.create
student.guardian.update

student.document.view
student.document.upload
student.document.verify
Exact catalog can grow without changing the authorization architecture.

158. Student Scope
Typical roles:
School Admin
TENANT_WIDE
Academic/Sub Admin
Potentially:
ASSIGNED_CLASSES
Teacher
Potentially:
ASSIGNED_CLASSES
or domain-specific resource scope.
Student Management should ask the authorization layer to resolve whether the actor may operate on the particular student.

159. Resource-Level Authorization
Example:
teacher.updateStudent(studentId)
must resolve:
Student
 ↓
Current enrollment
 ↓
Class/section
 ↓
Teacher assignment
 ↓
Scope
The client cannot supply:
class_id = permitted_class
to manufacture authorization.

160. Student APIs
Base routes:
/api/v1/students
/api/v1/students/:id
Admission:
/api/v1/admissions
/api/v1/admissions/:id
/api/v1/admissions/:id/submit
/api/v1/admissions/:id/approve
/api/v1/admissions/:id/reject
Enrollment:
/api/v1/students/:id/enrollments
/api/v1/enrollments/:id
Guardians:
/api/v1/students/:id/guardians
/api/v1/guardians/:id
Documents:
/api/v1/students/:id/documents
/api/v1/student-documents/:id
Bulk:
/api/v1/students/imports
/api/v1/students/imports/:id
/api/v1/students/imports/:id/preview
/api/v1/students/imports/:id/confirm

161. Student Application Services
Recommended use cases:
CreateStudent
UpdateStudent
GetStudent
ListStudents
ArchiveStudent

CreateAdmission
SubmitAdmission
ApproveAdmission
RejectAdmission

EnrollStudent
ChangeEnrollment
CompleteEnrollment
TransferEnrollment
WithdrawEnrollment

AddGuardian
UpdateGuardianRelationship
RemoveGuardianRelationship

UploadStudentDocument
VerifyStudentDocument
ArchiveStudentDocument

ImportStudents
PreviewStudentImport
ExecuteStudentImport
Lifecycle commands remain explicit.

162. Student Domain Events
Important events:
StudentCreated
StudentUpdated
StudentAdmitted
StudentActivated
StudentTransferred
StudentWithdrawn
StudentGraduated
StudentArchived

AdmissionCreated
AdmissionSubmitted
AdmissionApproved
AdmissionRejected

EnrollmentCreated
EnrollmentActivated
EnrollmentCompleted
EnrollmentTransferred

GuardianLinked
GuardianUnlinked
GuardianRelationshipChanged

StudentDocumentUploaded
StudentDocumentVerified
StudentDocumentExpired

163. Cross-Domain Event Consumers
Academic
Consumes enrollment changes to support:
class rosters
academic reporting
Attendance
Consumes relevant enrollment/student lifecycle changes.
Examination
Uses student/enrollment identity for assessments.
Fees
Creates/updates fee assignments based on student enrollment where configured.
Transportation
Uses student identity and transport assignment.
Library
Can create/manage library membership based on student eligibility.
Parent Portal
Consumes student/guardian relationship changes.
No consumer should directly modify Student tables.

164. Cross-Domain Reads
If another domain needs current student information:
Domain
 ↓
Student Application Interface
 ↓
Student Management
For high-volume views:
Student Events
 ↓
Read Model
 ↓
Reporting / Dashboard
No direct SQL access to students.

165. Student Transaction Example
Creating a student:
Request
 ↓
Authenticate
 ↓
Tenant validation
 ↓
Authorization
 ↓
Entitlement: Student Management
 ↓
Validate input
 ↓
Begin transaction
 ↓
Create Student
 ↓
Create Student History
 ↓
Create Audit Record
 ↓
Create Outbox Event
 ↓
Commit
If the transaction fails, student creation does not partially succeed.

166. Student Concurrency
Use optimistic concurrency for administrative updates.
Example:
Student version = 5
Client sends:
expected_version = 5
If current version is 6:
CONFLICT
The client must reload before overwriting another user's changes.

167. Enrollment Concurrency
Enrollment changes require stronger transaction handling.
For example, two administrators must not simultaneously create conflicting active enrollments.
Use:
transaction
appropriate locking
uniqueness constraints
application validation

168. Student Deletion
Physical deletion is not the normal operation.
Use:
Archive
Withdraw
Transfer
depending on business meaning.
If privacy/legal deletion is eventually required, it should be a dedicated platform workflow with cross-domain impact analysis.

169. Student Audit
Audit:
student creation
sensitive profile changes
status transitions
admission decisions
enrollment changes
guardian relationship changes
document verification
archive/withdraw/transfer/graduation
exports
bulk imports
Especially sensitive fields should have appropriate before/after recording.

170. Student Search
V1 can use MySQL-backed search.
Search must always contain:
tenant_id = authenticated tenant
Potential searchable fields:
student number
admission number
name
phone
email
guardian name
Search results still undergo authorization checks.

171. Student Module Final Boundary
The implementation contract is:
Student Management
│
├── Student
├── Admission
├── Enrollment
├── Guardian
├── Student-Guardian Relationship
├── Student Documents
├── Student History
└── Student Number
It does not own:
Class/Section definitions → Academic
Attendance → Attendance
Marks/Results → Examination
Fees → Fees
Transport → Transportation
Library Loans → Library
Notifications → Communication
Login → Identity/Authentication
This keeps the domain boundary clean and allows all later modules to reference Student through stable contracts.

Next Domain
The next specification will cover Academic/Class Management:
Academic Year
Class/Grade
Section
Subject
Subject Offering
academic configuration
lifecycle
teacher/student relationships
conflict/uniqueness rules
APIs
events
authorization
integration with Student and Teacher.
