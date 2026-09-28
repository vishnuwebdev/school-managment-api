<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 7

Attendance Management
Attendance is a domain of its own.
Student
   ↓
Enrollment
   ↓
Attendance Session
   ↓
Attendance Record
For subject attendance:
Teacher
   ↓
Teaching Assignment
   ↓
Subject Offering
   ↓
Attendance Session
   ↓
Student Attendance
Attendance owns attendance state, correction and finalization—not student, teacher or timetable data.

220. Attendance Module Boundary
Owns:
attendance sessions
attendance records
attendance statuses
attendance corrections
attendance approval/finalization
attendance configuration
attendance history
References:
Student
Enrollment
Academic Year/Class/Section
Subject Offering
Teacher
Does not own:
student lifecycle
academic structure
teacher assignment
timetable
leave
examination

221. Attendance Modes
V1 supports:
DAILY
SUBJECT
PERIOD
DAILY
One attendance session for a class/section/date.
SUBJECT
Attendance associated with a subject offering.
PERIOD
Attendance associated with a specific academic period/time slot.
The underlying model should support all three without separate unrelated tables.

222. attendance_sessions
attendance_sessions
-------------------
id
tenant_id
academic_year_id
section_id
subject_offering_id
attendance_date
mode
status
taken_by_teacher_id
submitted_at
approved_at
approved_by
finalized_at
created_at
updated_at
version
Nullable fields:
subject_offering_id
for daily attendance.
A period-specific implementation can additionally reference an academic period/time slot.

223. Attendance Session Status
Use:
DRAFT
SUBMITTED
APPROVED
FINAL
CANCELLED
Recommended workflow:
DRAFT
 ↓
SUBMITTED
 ↓
APPROVED
 ↓
FINAL
Depending on school policy, approval may be skipped for trusted workflows:
DRAFT → FINAL
The application configuration determines the permitted transition.

224. Attendance Session Identity
Prevent accidental duplicate sessions.
For example, subject attendance should normally have one session for:
tenant
+
academic year
+
section
+
subject offering
+
date
+
period (if applicable)
The exact uniqueness key varies by attendance mode.
The database and application layer together enforce it.

225. Attendance Records
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
version
Each record represents the student's attendance for that session.

226. Attendance Status
Do not use:
present = true/false
Use configurable statuses.
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
is_active
sort_order
created_at
updated_at
Examples:
PRESENT
ABSENT
LATE
EXCUSED
LEAVE
MEDICAL
OTHER

227. Status Categories
The reporting system should not need to understand every custom status.
Use categories such as:
PRESENT
ABSENT
EXCUSED
OTHER
A tenant can define:
LATE
with its own reporting behavior.

228. Attendance Status Configuration
Tenant administrators can configure status behavior subject to permissions.
For example:
LATE
counts_as_present = true
counts_as_absent = false
Changing status semantics should be audited because it can change historical reporting.
For strong historical integrity, status configuration should be effective-dated or snapshotted where necessary.

229. Student Eligibility
When creating attendance records, determine eligible students from authoritative enrollment.
Attendance Session
 ↓
Section
 ↓
Active Enrollment on attendance date
 ↓
Eligible Students
Do not trust a client-provided student list as the authoritative roster.

230. Attendance Authorization
Teacher marking:
Authenticated User
 ↓
Teacher
 ↓
Active Teaching Assignment
 ↓
Subject Offering / Section
 ↓
Attendance Session
 ↓
Permission
A teacher must not be able to mark attendance for an unrelated section merely by supplying its ID.

231. Daily Attendance Authorization
For daily attendance, authorization can be based on:
assigned class/section
designated attendance responsibility
School Admin privilege
authorized attendance role
The exact resource scope is resolved by the authorization/domain layer.

232. Attendance Permissions
Initial permission set:
attendance.view
attendance.create
attendance.mark
attendance.update
attendance.submit
attendance.approve
attendance.finalize
attendance.correct
attendance.export
attendance.configure
Correction is intentionally separate from normal marking.

233. Attendance Session Creation
Application flow:
Create Session
 ↓
Validate academic context
 ↓
Validate section
 ↓
Validate subject offering if applicable
 ↓
Validate teacher assignment
 ↓
Resolve eligible students
 ↓
Create session
 ↓
Create initial records if configured
For large classes, records can be generated asynchronously where appropriate.

234. Default Record Generation
Recommended V1 behavior:
Create an attendance record for every eligible student when the session is initialized.
This makes the session explicit:
30 students
 ↓
30 attendance records
Unmarked state can be represented temporarily as:
UNMARKED
UNMARKED is not a final attendance status.

235. Marking Attendance
Bulk marking should be optimized.
Example:
Mark all Present
 ↓
Change selected students
 ↓
Save
The API should support batch updates rather than requiring one HTTP request per student.

236. Bulk Attendance API
Conceptually:
{
  "records": [
    {
      "student_id": "...",
      "status": "PRESENT"
    },
    {
      "student_id": "...",
      "status": "ABSENT"
    }
  ]
}
Server validates:
student belongs to session roster
teacher is authorized
status is valid
session is editable
student enrollment is valid

237. Attendance Submission
DRAFT
 ↓
SUBMITTED
Submission means:
Teacher has completed marking and submitted the session for the next workflow stage.
Submission should be audited.

238. Approval
If approval is enabled:
SUBMITTED
 ↓
APPROVED
Approver should normally be different from the original marker where policy requires separation of duties.
Self-approval should be prohibited by default.

239. Finalization
APPROVED
 ↓
FINAL
Final attendance becomes immutable through ordinary APIs.
Corrections require a separate correction workflow.

240. Attendance Corrections
Use a separate entity:
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
requested_at
approved_at
applied_at
created_at
Status:
REQUESTED
APPROVED
REJECTED
CANCELLED
APPLIED

241. Correction Workflow
FINAL Record
      ↓
Correction Request
      ↓
Review
      ↓
Approved
      ↓
Apply Change
The original attendance remains historically visible through the audit/correction record.
Do not simply overwrite history.

242. Correction Permissions
Separate:
attendance.mark
from:
attendance.correct
A teacher who can mark attendance today should not automatically be able to rewrite finalized historical attendance.

243. Attendance Finalization
Once final:
normal update blocked
normal delete blocked
status changes require correction
corrections audited
reports can trust finalized records

244. Attendance Cancellation
A session may be cancelled if:
created incorrectly
class/session did not occur
duplicate session
Cancellation should preserve the record.
DRAFT/SUBMITTED → CANCELLED
Final sessions should generally require controlled correction/administrative workflow rather than direct cancellation.

245. Attendance Date Rules
Attendance date is a business date.
Store:
attendance_date DATE
rather than treating it as an arbitrary UTC timestamp.
Creation timestamps remain UTC.

246. Attendance History
Attendance records should support:
student
date
session
status
teacher
section
subject
efficiently.
Indexes should include tenant-aware access patterns such as:
(tenant_id, student_id, attendance_date)
(tenant_id, section_id, attendance_date)
(tenant_id, attendance_session_id)

247. Attendance Reporting
Common metrics:
daily attendance percentage
present days
absent days
late count
excused absence count
subject attendance
section attendance
student attendance history
Reporting should derive from attendance records rather than storing duplicated aggregate values as the primary source of truth.

248. Attendance Percentage
The reporting layer must use configured status semantics.
For example:
Attendance Percentage =
qualifying present attendance
/
qualifying attendance opportunities
× 100
The definition of “qualifying” must come from attendance status/configuration.
Do not hardcode:
absent = 0
across the system.

249. Attendance APIs
Sessions:
/api/v1/attendance/sessions
/api/v1/attendance/sessions/:id
Commands:
POST /attendance/sessions/:id/submit
POST /attendance/sessions/:id/approve
POST /attendance/sessions/:id/finalize
POST /attendance/sessions/:id/cancel
Records:
/api/v1/attendance/sessions/:id/records
POST /api/v1/attendance/sessions/:id/records/bulk
Corrections:
/api/v1/attendance/corrections
/api/v1/attendance/corrections/:id
POST /attendance/corrections/:id/approve
POST /attendance/corrections/:id/reject
Reports:
/api/v1/attendance/reports/student
/api/v1/attendance/reports/section
/api/v1/attendance/reports/subject

250. Attendance Application Services
CreateAttendanceSession
GetAttendanceSession
ListAttendanceSessions

InitializeAttendanceRoster

MarkAttendance
BulkMarkAttendance

SubmitAttendance
ApproveAttendance
FinalizeAttendance
CancelAttendance

RequestAttendanceCorrection
ApproveAttendanceCorrection
RejectAttendanceCorrection
ApplyAttendanceCorrection

GetStudentAttendance
GetSectionAttendance
GetSubjectAttendance

251. Attendance Events
AttendanceSessionCreated
AttendanceSessionSubmitted
AttendanceSessionApproved
AttendanceSessionFinalized
AttendanceSessionCancelled

AttendanceMarked
AttendanceBulkMarked

AttendanceCorrectionRequested
AttendanceCorrectionApproved
AttendanceCorrectionRejected
AttendanceCorrected
AttendanceMarked should not generate excessive downstream work if a bulk operation modifies dozens of records; event granularity can be chosen based on consumers.

252. Bulk Event Strategy
For bulk marking:
AttendanceBulkMarked
can be the primary integration event containing the relevant session/operation information.
Individual record events should only be emitted where a downstream consumer genuinely requires per-record semantics.
This avoids unnecessary event volume.

253. Student Integration
Attendance references:
student_id
enrollment_id
Enrollment provides the academic context.
If a student changes sections:
Old Attendance
 ↓
remains linked to old enrollment/section
Future attendance uses the new enrollment.
Historical attendance is never rewritten.

254. Academic Integration
Attendance validates:
academic year
section
subject offering
attendance mode
It does not copy academic definitions into attendance tables unless a historical snapshot is explicitly needed.

255. Teacher Integration
Attendance uses Teaching Assignment to determine whether a teacher can mark subject attendance.
Teacher identity is not duplicated.

256. Timetable Integration
For period-based attendance:
Timetable Entry
 ↓
Subject Offering
 ↓
Teacher
 ↓
Section
 ↓
Attendance Session
Timetable can provide the expected period context.
Attendance remains the owner of attendance state.

257. Leave Integration
Teacher leave does not directly modify attendance.
Instead:
Approved Leave
 ↓
Teacher unavailable
 ↓
Substitution / timetable handling
 ↓
Actual attendance marker
The actual attendance session remains owned by Attendance.

258. Concurrency
Important operations:
Attendance marking
Use optimistic versioning for sessions/records.
Finalization
Transactionally verify:
session editable
+
records valid
+
actor authorized
then finalize.
Correction
Transactionally verify current record state before applying the correction.

259. Attendance Idempotency
Bulk marking should support an idempotency key.
Example:
tenant
+
attendance_session
+
operation
+
idempotency_key
Repeated requests must not create duplicate records or duplicate downstream effects.

260. Attendance Audit
Audit:
session creation
bulk marking
submission
approval
finalization
cancellation
corrections
status configuration changes
attendance exports
For corrections:
old value
+
new value
+
reason
+
actor
+
approver
must remain traceable.

261. Attendance Database Summary
Core tables:
attendance_sessions
attendance_records
attendance_statuses
attendance_corrections
Potential future configuration:
attendance_policies
if tenant-specific policy becomes complex enough.

262. Attendance Domain Contract
Attendance
│
├── Sessions
├── Records
├── Statuses
├── Corrections
└── Finalization/Approval
Dependencies:
Student Management
Academic Management
Teacher Management
       ↓
   Attendance
Downstream:
Attendance
 ↓
Reporting
 ↓
Parent Portal
 ↓
Communication
Attendance remains the authoritative source for attendance records.

Next Domain
The next implementation specification will cover Examination & Results, including assessment structure, papers/components, schedules, marks, grading schemes, evaluation, result calculation, publication/locking, corrections, teacher evaluators, and integration with Student + Academic.
