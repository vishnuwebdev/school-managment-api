<!-- Source: Apple Notes, folder 'Core Database design system' -->
# Part 34 — Examination Database Design

Examination is the first domain where the system must distinguish very carefully between:
what was scheduled,
what was assessed,
what was entered,
what was calculated,
what was published,
and what was historically true.
The core flow is:
Academic
   ↓
Assessment Period
   ↓
Assessment
   ↓
Assessment Paper / Component
   ↓
Student Assessment
   ↓
Marks
   ↓
Calculation
   ↓
Result
   ↓
Publication
Student and Enrollment remain upstream references.

34.1 Examination Ownership
Examination owns:
Assessment
Assessment Period
Assessment Paper
Assessment Components
Mark Entries
Evaluation
Grading Rules
Results
Result Publication
Result History
It does not own:
Student
Enrollment
Subject
Teacher
Class
Section
Fees
Timetable
Those remain external references.

34.2 Assessment Period
An assessment period groups assessments within an academic context.
Conceptually:
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
Examples:
Term 1
Mid-Term
Term 2
Final Term
Semester 1
Semester 2
The school should not be forced into a single term/semester model.

34.3 Assessment
Use Assessment rather than hardcoding everything as "Exam".
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
created_at
updated_at
Possible assessment types:
UNIT_TEST
CLASS_TEST
MIDTERM
FINAL
ASSIGNMENT
PROJECT
PRACTICAL
ORAL
QUIZ
These should be configurable rather than hardcoded into application logic.

34.4 Assessment Lifecycle
Recommended:
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
Not every school needs every intermediate state operationally, but the data model should support the important transitions.

34.5 Assessment vs Schedule
Do not make the Assessment record itself the complete schedule.
An assessment describes:
What assessment exists?
A schedule describes:
When and where does this paper happen?
Therefore:
Assessment
   ↓
Assessment Paper
   ↓
Assessment Schedule

34.6 Assessment Paper
A paper represents a subject/component being assessed.
Conceptually:
assessment_papers
-----------------
id
tenant_id
assessment_id
subject_offering_id
name
code
max_marks
passing_marks
duration_minutes
status
created_at
updated_at
Example:
Final Examination
  ├── Mathematics
  ├── English
  ├── Science
  └── Computer Science
Each is a separate paper.

34.7 Subject Offering Reference
The paper should normally reference:
subject_offering_id
rather than only:
subject_id
class_id
because the offering already establishes the academic context.
This prevents different modules from inventing slightly different meanings for:
Mathematics for Grade 8 in 2026–27.

34.8 Assessment Components
Some assessments contain multiple components.
Example:
Science
 ├── Theory — 70
 ├── Practical — 20
 └── Internal — 10
Therefore:
assessment_components
---------------------
id
tenant_id
assessment_paper_id
name
component_type
max_marks
passing_marks
weight
display_order
status
A simple paper may have one component.
A complex paper may have several.

34.9 Raw Marks vs Calculated Marks
This distinction is essential.
Store the original entered value separately from derived calculations.
Conceptually:
Raw Marks
   ↓
Validation
   ↓
Component Calculation
   ↓
Paper Total
   ↓
Percentage
   ↓
Grade
Never replace raw marks with a calculated value.

34.10 Student Assessment
There needs to be an explicit student-level assessment record.
Conceptually:
student_assessments
-------------------
id
tenant_id
assessment_paper_id
student_id
enrollment_id
status
created_at
updated_at
This creates the historical connection:
Student
 +
Enrollment
 +
Assessment Paper

34.11 Why Store Enrollment
Exactly as with Attendance:
student_id
enrollment_id
should be retained.
If the student later moves from:
Grade 8A
to:
Grade 8B
the result still knows which enrollment context existed when the assessment occurred.

34.12 Assessment Participation Status
Do not represent every situation as a zero mark.
Use a status such as:
PRESENT
ABSENT
EXEMPT
WITHHELD
NOT_APPLICABLE
This is separate from the numeric mark.
Example:
status = ABSENT
marks = NULL
rather than:
marks = 0
unless the school explicitly treats absence as zero.

34.13 Mark Entry
Marks should have their own record where component-level tracking is required.
mark_entries
------------
id
tenant_id
student_assessment_id
assessment_component_id
raw_marks
status
entered_by
entered_at
updated_at
Example:
Student X
Science
Theory
68 / 70
and:
Student X
Science
Practical
18 / 20

34.14 Mark Validation
Before accepting marks:
0 ≤ raw_marks ≤ max_marks
unless the assessment configuration explicitly supports another model.
Marks should never silently exceed the component maximum.

34.15 Decimal Marks
The database should support decimal values.
For example:
17.5 / 20
Do not use an integer-only representation unless the business requirements explicitly prohibit fractional marks.

34.16 Mark Correction
Important mark changes should be controlled.
Conceptually:
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
created_at
approved_at
Depending on the school's workflow, the correction can be immediate with an audit trail or require approval.

34.17 Grading Rules
Grades should not be hardcoded.
Conceptually:
grading_schemes
---------------
id
tenant_id
name
version
status
effective_from
effective_to
Then:
grading_rules
-------------
id
tenant_id
grading_scheme_id
min_percentage
max_percentage
grade
grade_point
remark
display_order
Example:
90–100 → A+
80–89  → A
70–79  → B
...
The exact scheme belongs to the school.

34.18 Why Grading Must Be Versioned
Suppose a school changes:
A = 80–100
to:
A = 85–100
A previously published result must not silently change.
Therefore:
Result
 ↓
Grading Scheme Version
must remain historically identifiable.

34.19 Result Calculation
Results are derived from marks.
Conceptually:
Mark Entries
    ↓
Component Totals
    ↓
Paper Result
    ↓
Assessment Result
    ↓
Overall Result
The exact aggregation model should remain flexible.

34.20 Paper Result
A paper-level result might contain:
paper_results
-------------
id
tenant_id
student_assessment_id
total_marks
percentage
grade
grade_point
result_status
calculated_at
grading_scheme_id
However, we should distinguish between:
calculation snapshot,
authoritative published result.
The next layer handles that.

34.21 Result Snapshot
Once a result is ready for publication, preserve the calculated outcome.
Conceptually:
results
-------
id
tenant_id
student_id
enrollment_id
assessment_id
result_version
status
total_marks
percentage
grade
grade_point
grading_scheme_id
calculated_at
published_at
locked_at
This gives the system a stable result representation.

34.22 Why Result Should Be Separate from Marks
Marks are source inputs.
Results are derived outputs.
Therefore:
Marks
  ↓
Calculation
  ↓
Result
If calculation rules change later, the system can distinguish:

from:

instead of treating the result as raw data.

34.23 Result Versioning
A result may need a version when corrections are formally published.
Example:
Result v1 → Published
Result v2 → Corrected and Published
The exact versioning implementation can use either:
result revisions,
publication snapshots,
or immutable result records.
For now, the important requirement is:
A published result must remain historically reproducible.

34.24 Publication
Publication should be a distinct business action.
Conceptually:
result_publications
-------------------
id
tenant_id
assessment_id
version
status
published_by
published_at
locked_at
created_at
The Parent Portal should only expose results that are officially published.

34.25 Result Visibility
This creates a clean boundary:
Calculated
   ↓
Reviewed
   ↓
Published
   ↓
Portal-visible
A result existing in the database does not automatically mean a guardian can see it.

34.26 Result Locking
After publication, the result may become:
LOCKED
Corrections should then require an explicit correction workflow.
Do not allow arbitrary updates to published results.

34.27 Examination Schedule
Scheduling can be represented separately:
assessment_schedules
--------------------
id
tenant_id
assessment_paper_id
date
start_time
end_time
room_id nullable
status
created_at
updated_at
The room/location may later integrate with a dedicated Room domain.

34.28 Examination Schedule vs Timetable
Ordinary teaching timetable:
Timetable
Examination scheduling:
Examination Schedule
These should remain separate.
They may share:
time,
room,
teacher,
class,
subject references,
but they represent different business concepts.

34.29 Teacher in Examination
Teachers may be associated with:
mark entry,
evaluation,
supervision.
Do not automatically use teacher_id on every examination table.
Instead create explicit relationships where necessary.
For example:
assessment_evaluators
---------------------
id
tenant_id
assessment_paper_id
teacher_id
role
starts_at
ends_at
This leaves room for:
PRIMARY_EVALUATOR
SECOND_EVALUATOR
MODERATOR
SUPERVISOR
without overloading the Teacher entity.

34.30 Examination Permissions
Permissions remain separate from data relationships.
Examples:
exam.view
exam.create
exam.update
exam.schedule
exam.publish
exam.lock

marks.view
marks.create
marks.update
marks.submit
marks.correct

result.view
result.calculate
result.review
result.publish
result.correct
result.export
A teacher's assignment scope determines which records they may operate on.

34.31 Examination Authorization
Example:
Teacher A
 +
marks.create
 +
Assigned Subject Offering
 =
Can enter marks
But:
Teacher A
 +
marks.create
 +
Different Subject Offering
 =
DENIED
The database relationship and authorization scope work together.

34.32 Examination + Fees
Do not add:
fee_status
to Examination.
If a school eventually requires financial eligibility before publication, introduce an explicit eligibility mechanism rather than coupling the domains.

34.33 Examination + Attendance
Do not make Examination depend on Attendance for its core operation.
Attendance may be used later for:
eligibility,
analytics,
report cards,
but this should be an explicit policy rather than a fundamental foreign-key dependency.

34.34 Examination + Student
The direct business relationship is:
Student
   ↓
Enrollment
   ↓
Student Assessment
   ↓
Mark Entries
   ↓
Result
This preserves academic context.

34.35 Historical Integrity
Suppose:
2026 Final Exam
Grade 8A
Student X
Student X later moves to:
Grade 9A
The old result must still represent:
2026
Grade 8A
not the student's current class.
That is why enrollment context and/or appropriate result snapshots matter.

34.36 Result Snapshot Principle
For published results, preserve enough information to reproduce the published outcome even if configuration changes later.
At minimum, the result should retain references to:
Student
Enrollment
Assessment
Grading Scheme Version
Calculation version
and the published derived values.

34.37 Report Card
Report cards should be treated as a presentation/derived artifact.
Do not make:
report_cards
the source of truth for marks.
Instead:
Marks
 ↓
Results
 ↓
Report Card
A generated PDF/report can be stored through File Service if required.

34.38 Examination Configuration
Domain-owned configuration includes:
assessment types
grading schemes
grade rules
marking policies
publication rules
result calculation rules
Configuration changes should be audited.
Historical results must remain tied to the applicable configuration/version.

34.39 Examination Events
Core events:
AssessmentCreated
AssessmentScheduled
AssessmentOpened
MarksEntryStarted
MarksSubmitted
MarksCorrected
AssessmentEvaluated
ResultCalculated
ResultReviewed
ResultPublished
ResultCorrected
ResultLocked
These can feed:
Communication
Reporting
Parent Portal
Audit
Integrations

34.40 Examination Audit
Strong audit coverage is required for:
Mark entry
Mark correction
Grade rule changes
Result calculation
Result publication
Result correction
Result locking
A published result correction should always have an identifiable actor and reason.

34.41 Bulk Mark Entry
Mark entry is a natural bulk operation:
Paper
 ↓
30 students
 ↓
Bulk marks submission
The workflow should support:
Validate
 ↓
Preview
 ↓
Confirm
 ↓
Transactional/background processing
 ↓
Result summary
For smaller mark-entry operations, synchronous transaction processing is sufficient.

34.42 Idempotency
Bulk mark submission should support idempotency.
For example:
same request
+
same idempotency key
=
same operation
This prevents accidental duplicate processing when a client retries after a timeout.

34.43 Examination Database Structure
Conceptually:
EXAMINATION
────────────────────
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
Some of these may later be consolidated if actual workflow proves simpler, but the ownership boundaries should remain.

34.44 Relationship Diagram
Academic Year
      │
      ↓
Assessment Period
      │
      ↓
Assessment
      │
      ↓
Assessment Paper ─────→ Subject Offering
      │
      ├──→ Assessment Components
      │
      └──→ Assessment Schedule
                │
                ↓
        Student Assessment
                │
         ┌──────┴──────┐
         ↓             ↓
   Mark Entries     Enrollment
         │             │
         └──────┬──────┘
                ↓
             Result
                │
                ↓
          Publication
                │
                ↓
          Parent Portal

34.45 Result Calculation Architecture
The application flow should be:
Mark Entries
    ↓
Validation
    ↓
Calculation Service
    ↓
Grading Scheme
    ↓
Calculated Result
    ↓
Review
    ↓
Publication
    ↓
Lock
The calculation engine should not be embedded in database triggers.
Business calculation belongs in application/domain logic.

34.46 Database vs Application Responsibilities
Database should enforce
tenant integrity
foreign-key integrity
unique constraints
not-null requirements
valid basic data types
Application/domain should enforce
assessment lifecycle
marking rules
grading calculations
publication rules
correction workflow
teacher scope
entitlement
authorization
Do not turn the database into the application's business-rule engine.

34.47 Cross-Domain Dependency
The current architecture is now:
Academic
   ↓
Student / Enrollment
   ↓
Examination
   ↑
Teacher / Teaching Assignment
with:
Timetable ──→ optional exam scheduling context
Fees ───────→ no core dependency
Attendance ─→ no core dependency
Communication ← Examination events
Reporting ←──── Examination events
Portal ←─────── Published Results
This keeps the domain graph acyclic.

34.48 Important Design Decision
We now have a strong rule:
Marks are source inputs. Results are calculated/published outputs.
Therefore:
Do not allow:
Published Result → arbitrary mark mutation
Instead:
Correction Request
 ↓
Mark Correction
 ↓
Recalculation
 ↓
Result Revision
 ↓
Re-publication
This preserves academic history.

34.49 Current Database Foundation
After Part 34:
PLATFORM
   ↓
ACADEMIC
   ↓
STUDENT / ENROLLMENT
   ↓
TEACHER / TEACHING ASSIGNMENT
   ↓
ATTENDANCE
   ↓
EXAMINATION
Not every arrow means a mandatory runtime dependency; it represents the established ownership/reference flow.

34.50 What This Enables
The architecture now supports:
multiple academic years,
configurable classes and sections,
multiple subjects,
teacher assignments,
daily attendance,
subject attendance,
assessment periods,
multiple assessment types,
component-based marks,
configurable grading,
historical results,
publication/locking,
teacher-scoped mark entry,
guardian-visible published results.
Without hardcoding:
grades,
terms,
grading scales,
assessment types,
one teacher per subject,
one assessment component,
one attendance mode.

Next: Part 35 — Fee Management Database Design
The next domain is especially important because it introduces a second financial system inside the school while keeping it completely separate from SaaS subscription billing.
We will design:
Fee Categories
Fee Structures
Fee Components
Student Fee Assignments
Fee Demands
Payments
Receipts
Discounts
Concessions
Waivers
Refunds
and resolve how:
Student
Enrollment
Academic Year
Transportation
Library
        ↓
     Fees
connect without allowing Fees to take ownership of those domains.
