<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 7

Examination & Results Management
Examination is one of the more complex domains because it combines scheduling, marks, grading, calculation, review, publication, corrections and historical locking.
The design therefore separates:
Assessment Definition
        ↓
Assessment Paper / Components
        ↓
Schedule
        ↓
Student Assessment
        ↓
Mark Entry
        ↓
Calculation
        ↓
Result
        ↓
Publication
        ↓
Lock
This keeps raw marks, derived results and published results distinct. The separation also aligns with the broader domain-boundary approach: aggregates should protect their own consistency boundaries, while cross-domain effects can be handled through events rather than coupling everything into one transaction. Microsoft Learn

263. Examination Module Boundary
Examination owns:
assessment periods
assessments
papers
components
schedules
student assessment participation
mark entries
mark corrections
grading schemes
grading rules
result calculation
paper results
overall results
publication
result locking
evaluators
It does not own:
students
academic classes/sections
teachers
attendance
timetable

264. Assessment Hierarchy
Assessment Period
       ↓
Assessment
       ↓
Assessment Paper
       ↓
Assessment Component
Example:
Term 1 Examination
 ├── Mathematics
 │    ├── Theory
 │    └── Practical
 │
 ├── Science
 │    ├── Theory
 │    └── Practical
 │
 └── English
      └── Theory
This structure supports simple and complex examination models without hardcoding a particular curriculum.

265. Assessment Period
An assessment period groups assessments.
Examples:
Term 1
Mid-Year
Final Examination
Unit Test Period

266. assessment_periods
assessment_periods
------------------
id
tenant_id
academic_year_id
name
code
start_date
end_date
status
created_at
updated_at
version
Status:
DRAFT
OPEN
CLOSED
ARCHIVED

267. Assessment
Assessment represents an examination/assessment event.
assessments
-----------
id
tenant_id
assessment_period_id
name
code
assessment_type
status
start_date
end_date
grading_scheme_id
created_at
updated_at
version
Examples:
Unit Test 1
Mid Term
Final Examination
Practical Examination
Project Assessment
Assessment types should be configurable.

268. Assessment Lifecycle
DRAFT
  ↓
SCHEDULED
  ↓
OPEN
  ↓
MARK_ENTRY
  ↓
EVALUATION_COMPLETE
  ↓
READY_FOR_PUBLICATION
  ↓
PUBLISHED
  ↓
LOCKED
  ↓
ARCHIVED
Not every assessment must use every stage, but the transition model prevents arbitrary status manipulation.

269. Assessment Paper
A paper connects an assessment to an academic subject offering.
assessment_papers
-----------------
id
tenant_id
assessment_id
subject_offering_id
name
code
maximum_marks
passing_marks
weight
status
created_at
updated_at
version
Example:
Final Examination
 ↓
Mathematics Paper
 ↓
Grade 5A Mathematics

270. Assessment Components
A paper may contain components.
assessment_components
--------------------
id
tenant_id
assessment_paper_id
name
code
maximum_marks
weight
sequence
status
created_at
updated_at
Example:
Mathematics
 ├── Theory: 80
 └── Practical: 20

271. Raw Marks vs Result
These must remain separate.
Raw Mark
   ↓
Calculation
   ↓
Paper Result
   ↓
Overall Result
A raw mark is what the evaluator entered.
A result is derived from marks, grading rules and configuration.
Never overwrite raw marks with calculated grades.

272. Assessment Schedule
Scheduling belongs to Examination, although it may integrate with Timetable.
assessment_schedules
--------------------
id
tenant_id
assessment_paper_id
scheduled_date
start_time
end_time
room_id
status
created_at
updated_at
A future implementation can support multiple rooms/invigilators through separate assignment tables.

273. Schedule Rules
Prevent conflicts such as:
same paper scheduled twice unintentionally
invalid date outside assessment period
overlapping assessment where prohibited
invalid room assignment
Teacher/class/student conflict checks may use Academic/Timetable interfaces.
Examination owns the assessment schedule, not the school's general timetable.

274. Student Assessment
This records a student's participation in a particular assessment paper.
student_assessments
-------------------
id
tenant_id
assessment_paper_id
student_id
enrollment_id
participation_status
maximum_marks_snapshot
created_at
updated_at
version
Participation:
REGISTERED
PRESENT
ABSENT
EXEMPT
WITHHELD
CANCELLED

275. Why Student Assessment Exists
Do not infer participation solely from enrollment.
A student can be:
enrolled
absent
exempt
withheld
excluded from a paper
The assessment participation record explicitly represents that state.

276. Absent Is Not Zero
This is a critical rule.
ABSENT
≠
0 marks
Likewise:
EXEMPT
≠
0 marks
Calculation rules determine how these states affect results.

277. Mark Entry
mark_entries
------------
id
tenant_id
student_assessment_id
assessment_component_id
marks
status
entered_by
entered_at
updated_at
version
Status:
DRAFT
SUBMITTED
ACCEPTED
REJECTED

278. Mark Precision
Use configurable decimal precision where required.
Example:
DECIMAL(10,4)
The system must validate:
marks >= 0
marks <= component.maximum_marks
unless the mark state is something such as absent/exempt/withheld.

279. Mark Correction
Finalized marks should not be silently overwritten.
mark_corrections
----------------
id
tenant_id
mark_entry_id
old_marks
new_marks
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
APPLIED
CANCELLED

280. Mark Correction Flow
Final Mark
   ↓
Correction Request
   ↓
Review
   ↓
Approval
   ↓
Apply
   ↓
Recalculate Results
The old value remains auditable.

281. Evaluators
Teacher evaluators are separate from mark entries.
assessment_evaluators
---------------------
id
tenant_id
assessment_paper_id
teacher_id
role
status
effective_from
effective_until
created_at
updated_at
Roles can include:
PRIMARY
SECONDARY
REVIEWER
MODERATOR
The Examination domain owns evaluator assignment; Teacher Management owns the teacher.

282. Evaluator Authorization
A teacher may enter marks only when:
Teacher
 ↓
Active evaluator assignment
 ↓
Assessment Paper
 ↓
Student Assessment
 ↓
Permission
Teaching assignment alone does not automatically grant examination marking rights.

283. Grading Scheme
Grading rules must be versioned.
grading_schemes
---------------
id
tenant_id
name
code
version
status
effective_from
effective_until
created_at
updated_at
Status:
DRAFT
ACTIVE
RETIRED

284. Grading Rules
grading_rules
-------------
id
tenant_id
grading_scheme_id
min_percentage
max_percentage
grade
grade_point
description
sequence
created_at
updated_at
Example:
90–100 → A+
80–89  → A
70–79  → B
...
Actual grading ranges are configurable.

285. Grading Version Integrity
When a result is calculated, the applicable grading scheme/version must be identifiable.
Do not calculate a 2026 historical result using a grading rule introduced in 2028.
Therefore results should reference the grading scheme/version used.

286. Paper Result
paper_results
-------------
id
tenant_id
student_assessment_id
raw_marks
percentage
grade
grade_point
result_status
grading_scheme_id
calculated_at
version
Result status:
PASS
FAIL
ABSENT
EXEMPT
WITHHELD
INCOMPLETE

287. Overall Result
results
-------
id
tenant_id
assessment_id
student_id
enrollment_id
total_marks
maximum_marks
percentage
grade
grade_point
result_status
grading_scheme_id
calculated_at
version
This represents the student's overall assessment result.

288. Result Calculation
Calculation should be deterministic.
Conceptually:
Raw Marks
 ↓
Component Calculation
 ↓
Paper Total
 ↓
Paper Weight
 ↓
Assessment Aggregate
 ↓
Percentage
 ↓
Grading Scheme
 ↓
Overall Result
All inputs used for the calculation must be identifiable.

289. Calculation Snapshot
For published/locked results, preserve enough information to explain the outcome later.
At minimum retain:
grading_scheme_id
grading_scheme_version
calculation_timestamp
raw/derived values
For especially complex calculations, preserve a calculation snapshot/version.

290. Result Calculation Service
Use a dedicated application/domain service:
calculateAssessmentResult({
  assessmentId,
  studentId
})
The calculation engine should not depend on HTTP.
This allows:
API calculation
background recalculation
correction-triggered recalculation
bulk recalculation
to use the same logic.

291. Result Recalculation
If a mark changes before publication:
Mark Changed
 ↓
Invalidate Derived Result
 ↓
Recalculate
 ↓
Review
If a result is already published/locked, the correction workflow controls whether recalculation is allowed.

292. Result Publication
Publication is separate from calculation.
Calculated
 ↓
Reviewed
 ↓
Published
A calculated result is not automatically visible to parents/students.

293. Result Publication
result_publications
-------------------
id
tenant_id
assessment_id
publication_version
status
published_at
published_by
unpublished_at
unpublished_by
created_at
Status:
DRAFT
PUBLISHED
UNPUBLISHED
LOCKED

294. Published Results
Parent Portal and other external consumers should see only results whose publication rules allow visibility.
Calculated
  ≠
Published
This is essential for examination workflows.

295. Result Locking
After locking:
Result
 ↓
LOCKED
ordinary updates are prohibited.
Changes require:
authorized correction
+
reason
+
audit

296. Result Locking Strategy
Recommended:
raw mark locking
paper result locking
overall result locking
publication locking
depending on the assessment workflow.
The lock state should be explicit rather than inferred from publication alone.

297. Examination Permissions
Initial permissions:
assessment.view
assessment.create
assessment.update
assessment.schedule
assessment.open
assessment.close

mark.view
mark.enter
mark.submit
mark.correct
mark.approve

result.view
result.calculate
result.review
result.publish
result.unpublish
result.lock
result.correct

grading_scheme.view
grading_scheme.manage

evaluator.view
evaluator.manage

assessment.export
result.export

298. Assessment Scope
Teachers should generally operate within:
ASSIGNED_SUBJECTS
through evaluator assignment.
Administrators can operate with:
TENANT_WIDE
or appropriate administrative scope.

299. Examination APIs
Assessment periods:
/api/v1/assessment-periods
/api/v1/assessment-periods/:id
Assessments:
/api/v1/assessments
/api/v1/assessments/:id
Papers:
/api/v1/assessments/:id/papers
/api/v1/assessment-papers/:id
Schedules:
/api/v1/assessment-papers/:id/schedule
Marks:
/api/v1/assessment-papers/:id/student-assessments
/api/v1/student-assessments/:id/marks
/api/v1/student-assessments/:id/marks/bulk
Results:
/api/v1/assessments/:id/results
/api/v1/results/:id
Publication:
POST /api/v1/assessments/:id/results/publish
POST /api/v1/assessments/:id/results/unpublish
POST /api/v1/assessments/:id/results/lock

300. Examination Application Services
CreateAssessmentPeriod
CreateAssessment
CreateAssessmentPaper
CreateAssessmentComponent

ScheduleAssessmentPaper
OpenAssessment
StartMarkEntry

RegisterStudents
RecordParticipation

EnterMarks
SubmitMarks
CorrectMarks
ApproveMarks

CalculateResults
RecalculateResults
ReviewResults

PublishResults
UnpublishResults
LockResults

CreateGradingScheme
CreateGradingRule
AssignEvaluator
RemoveEvaluator

301. Examination Events
AssessmentCreated
AssessmentScheduled
AssessmentOpened
AssessmentMarkEntryStarted
AssessmentEvaluationCompleted
AssessmentReadyForPublication

StudentAssessmentRegistered
StudentAssessmentMarked
StudentAssessmentAbsent
StudentAssessmentExempted

MarkEntered
MarksSubmitted
MarkCorrected

ResultsCalculated
ResultsRecalculated
ResultsPublished
ResultsUnpublished
ResultsLocked

302. Bulk Mark Entry
Bulk mark entry is a first-class workflow.
Load student roster
 ↓
Enter marks
 ↓
Validate
 ↓
Preview errors
 ↓
Submit
 ↓
Background processing where necessary
Validation includes:
student belongs to paper
evaluator authorized
component valid
marks within range
student participation state permits marking
assessment state permits marking

303. Marking Idempotency
Bulk mark submission supports an idempotency key.
Repeated submission must not:
duplicate marks
create duplicate corrections
trigger duplicate result calculations

304. Examination Concurrency
Mark Entry
Optimistic locking.
Result Calculation
Calculation jobs use version checks.
Publication
Transactionally verify:
all required marks complete
+
calculation complete
+
review complete
+
assessment not already published
before publication.
Lock
Lock operation must be atomic.

305. Examination Result Integrity
Before publication:
Required marks complete
+
exceptions resolved
+
calculation successful
+
grading scheme valid
+
result review complete
Then:
READY_FOR_PUBLICATION
Only authorized publication changes it to:
PUBLISHED

306. Examination Corrections After Publication
Published/locked results require a dedicated correction workflow.
Published Result
      ↓
Correction Request
      ↓
Review
      ↓
Approval
      ↓
Unlock / Correct
      ↓
Recalculate
      ↓
Republish
      ↓
Relock
This preserves the publication history.

307. Student Integration
Examination references:
student_id
enrollment_id
The enrollment snapshot provides the relevant academic context.
Historical assessment results should remain associated with the enrollment under which the assessment occurred.

308. Academic Integration
Examination references:
academic_year
class
section
subject offering
primarily through subject_offering_id and enrollment context.
It does not duplicate Academic definitions unnecessarily.

309. Teacher Integration
Evaluator assignment references:
teacher_id
Teacher Management remains authoritative for teacher identity.
Examination determines whether that teacher is an authorized evaluator for a paper.

310. Attendance Integration
Attendance may provide contextual information such as:
attendance eligibility
absence patterns
examination eligibility
But Examination should not directly modify Attendance.
If examination eligibility depends on attendance, implement an explicit application/domain rule or read interface.

311. Parent Portal Integration
Parent Portal can expose:
published results
but never:
draft marks
unpublished results
internal evaluator comments
unless explicitly permitted by a future product requirement.

312. Reporting Integration
Reporting can consume:
ResultsPublished
ResultsLocked
and build read models for:
student report cards
class performance
subject performance
grade distributions
pass/fail statistics
The Examination database remains authoritative.

313. Examination Audit
Audit:
assessment creation/modification
schedule changes
evaluator assignment
mark entry
mark submission
mark corrections
grading scheme changes
result calculation/recalculation
publication
unpublication
locking
post-publication correction
For mark corrections always retain:
old mark
new mark
reason
requester
approver
timestamp

314. Examination Database Summary
Core tables:
assessment_periods
assessments
assessment_papers
assessment_components
assessment_schedules
student_assessments
mark_entries
mark_corrections
grading_schemes
grading_rules
paper_results
results
result_publications
assessment_evaluators
Potential future tables:
result_calculation_runs
result_correction_requests
report_card_templates
Only add them when the corresponding workflow requires them.

315. Examination Aggregate Boundaries
Keep aggregates reasonably small.
Recommended consistency boundaries:
Assessment
Assessment Paper
Student Assessment
Mark Entry
Result
Publication
Do not create one giant aggregate containing the entire examination.
This keeps concurrent marking and calculation manageable and follows the principle that an aggregate should contain the state that must remain consistent within one transaction. GitHub

316. Examination Module Contract
Examination
│
├── Assessment Periods
├── Assessments
├── Papers
├── Components
├── Schedules
├── Student Assessments
├── Mark Entries
├── Corrections
├── Grading
├── Results
├── Publication
└── Evaluators
Core lifecycle:
Assessment
 ↓
Schedule
 ↓
Open
 ↓
Mark Entry
 ↓
Evaluation Complete
 ↓
Calculate
 ↓
Review
 ↓
Publish
 ↓
Lock
That gives the platform a controlled examination lifecycle without coupling raw marks, calculated results and published results into the same state model.
Next Domain
The next implementation specification will cover Fee Management for schools: fee structures, components, student fee assignments, demands/invoices, payments, allocations, receipts, discounts, concessions, waivers and refunds.
