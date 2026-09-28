<!-- Source: Apple Notes, folder 'Notes' -->
# Part 17 — Examination Management Domain Foundation

Examination is the next major academic domain.
Its responsibility is to manage assessment structure, exams, schedules, marks/results, grading, publication, and result history.
It should consume the foundations already designed:
Student
Enrollment
Academic Year
Class / Section
Subject Offering
Teacher Assignment
It should not own those entities.

17.1 Domain Purpose
Conceptually:
Examination
│
├── Assessment Configuration
├── Exam / Assessment
├── Exam Schedule
├── Subjects / Papers
├── Mark Entry
├── Evaluation
├── Grades
├── Results
├── Result Publication
└── Result History
Potential future capabilities:
├── Report Cards
├── Transcripts
├── Rank / Position
├── Online Exams
├── Question Banks
├── Digital Evaluation
└── Certificates
These should not all be part of V1.

17.2 Examination Does Not Own Students
The relationship remains:
Student Management
       ↓
Student

Examination
       ↓
references Student / Enrollment
This means deleting or changing examination data must never mean deleting the underlying student.

17.3 Examination Does Not Own Academic Structure
Academic Management owns:
Academic Year
Class
Section
Subject
Subject Offering
Examination references these.
For example:
Exam
 ↓
Academic Year: 2026–27
 ↓
Grade 6A
 ↓
Mathematics

17.4 Assessment vs Examination
We should make a conceptual distinction between:
Assessment
and:
Examination
An examination is one type of assessment.
Future schools may need:
Unit Test
Class Test
Midterm
Final Exam
Assignment
Project
Practical
Oral
Quiz
Therefore a flexible model should treat:
Assessment
   ↓
Assessment Type
rather than hardcoding everything as "Exam".

17.5 Assessment Structure
A school may define:
Academic Year
  ↓
Assessment Period
  ↓
Assessment
  ↓
Subject/Paper
For example:
2026–27
   ↓
Term 1
   ↓
Midterm Examination
   ↓
Mathematics
This creates a reusable academic assessment structure.

17.6 Assessment Period
An academic year can contain multiple periods:
2026–27
├── Term 1
├── Term 2
└── Final
Or:
2026–27
├── Unit Test 1
├── Unit Test 2
├── Midterm
└── Final
The structure must be configurable.

17.7 Exam Lifecycle
An assessment should have an explicit lifecycle.
For example:
Draft
 ↓
Scheduled
 ↓
Open
 ↓
Mark Entry
 ↓
Evaluation Complete
 ↓
Ready for Publication
 ↓
Published
 ↓
Locked / Archived
The exact states can be simplified depending on requirements.

17.8 Why Lifecycle Matters
Once results are published:
Published Result
should not be casually editable.
Changes after publication should follow a controlled correction process.
This is particularly important because results may be used for:
report cards,
student promotion,
transcripts,
parent portals,
certificates.

17.9 Exam Schedule
An exam schedule should be distinct from the exam definition.
For example:
Midterm Examination
      ↓
Schedule
├── Mathematics → 10 Oct
├── English     → 12 Oct
└── Science     → 14 Oct
Schedule information may include:
Date
Start Time
End Time
Subject
Class/Section
Room
Instructions
Room management can later integrate with a facilities/room domain.

17.10 Exam Paper / Subject
An examination may contain multiple papers:
Midterm
│
├── Mathematics
├── English
├── Science
└── Hindi
Each paper should have its own assessment configuration.
For example:
Mathematics
Maximum Marks = 100
Passing Marks = 40
Duration = 2 hours

17.11 Maximum Marks vs Obtained Marks
These should be separate concepts.
Maximum Marks = 100
Obtained Marks = 82
Do not store only a percentage.
Percentage can be derived:
82 / 100 × 100 = 82%
Keeping the raw values preserves the source of truth.

17.12 Multiple Components
Some assessments may have:
Theory = 70
Practical = 30
Total = 100
Therefore an assessment may eventually contain components:
Assessment
├── Theory
├── Practical
├── Internal
└── Project
This should be supported conceptually, even if V1 starts with a simpler structure.

17.13 Mark Entry
A typical workflow:
Teacher
 ↓
Select Exam
 ↓
Select Subject
 ↓
Select Class/Section
 ↓
Load Eligible Students
 ↓
Enter Marks
 ↓
Validate
 ↓
Save Draft
 ↓
Submit
The backend validates:
student belongs to the correct enrollment,
subject belongs to the assessment,
teacher is authorized,
marks are within valid range.

17.14 Teacher Authorization
A teacher should not automatically be able to enter marks for every subject.
For example:
Teacher A
  ↓
Mathematics
  ↓
Grade 6A
should permit mark entry for that relevant context.
The authorization chain remains:
Permission
+
Teaching Assignment
+
Assessment Scope

17.15 Marks Validation
The system should validate:
Obtained Marks >= 0
Obtained Marks <= Maximum Marks
and any configured rules such as:
decimal precision
absent status
exempt status
withheld result
These are domain rules, not UI-only validation.

17.16 Absent vs Zero
This distinction is important.
A student who is absent should not necessarily be represented as:
marks = 0
Instead:
Result Status = Absent
Marks = null
Similarly:
Exempt
Withheld
Not Applicable
may need distinct states.

17.17 Result Status
A mark/result entry can conceptually have:
Present
Absent
Exempt
Withheld
Not Evaluated
This prevents invalid interpretations of zero/null values.

17.18 Grading System
Schools may use different systems:
Marks
82 / 100
Letter Grades
A
B+
C
Grade + Percentage
82% → A
GPA/Points
8.5
Therefore grading should be configurable rather than embedded directly into the result table.

17.19 Grade Scale
Conceptually:
Grade Scale
│
├── A+ → 90–100
├── A  → 80–89
├── B+ → 70–79
└── ...
The actual ranges should be configurable per school/academic context.
Some schools may use:
A1
A2
B1
B2
or completely different scales.

17.20 Grading Rule Versioning
A subtle but important future-proofing requirement:
If a school changes its grading rules in 2027, historical 2026 results must not suddenly recalculate under the new rules.
Therefore grading configurations should be versionable or otherwise historically preserved.
Conceptually:
Grade Scale v1
Grade Scale v2
Results retain the grading configuration applicable at the time.

17.21 Result Calculation
The result engine may calculate:
Subject Total
Overall Total
Percentage
Grade
Pass/Fail
GPA
But these are derived from configured rules.
Avoid hardcoding:
percentage > 40 = pass
because schools can have different rules.

17.22 Result vs Mark Entry
Keep:
Raw Evaluation
separate conceptually from:
Published Result
For example:
Mark Entry
   ↓
Validation
   ↓
Calculation
   ↓
Result
   ↓
Publication
This allows corrections and recalculation without confusing draft marks with officially published results.

17.23 Result Publication
Possible workflow:
Marks Submitted
      ↓
Validated
      ↓
Calculated
      ↓
Reviewed
      ↓
Published
      ↓
Locked
Once published, changes should require a controlled process.

17.24 Result Correction
If an error is discovered:
Published Result
       ↓
Correction Request
       ↓
Authorization
       ↓
Change
       ↓
Recalculation
       ↓
Republish
The old result should remain auditable.
Audit should capture:
Before
After
Actor
Reason
Timestamp
Approval

17.25 Report Cards
A report card can be treated as a presentation/read model of examination results.
Conceptually:
Student
 ↓
Assessment Results
 ↓
Report Card
The report card should not become the primary source of marks.
Source of truth:
Assessment Results
Report card:
Generated representation
This makes regeneration possible.

17.26 Student Result History
Historical results should remain accessible even after:
student class changes,
academic year completes,
teacher leaves,
exam configuration changes.
The result must preserve enough references/version information to remain historically meaningful.

17.27 Promotion Dependency
Examination may eventually influence promotion:
Results
   ↓
Promotion Eligibility
But Examination should not directly perform promotion.
Instead:
Examination
   ↓
Result / Eligibility Information
   ↓
Academic Promotion Workflow
This keeps responsibilities separate.

17.28 Rank / Position
Ranking is potentially sensitive and varies greatly between schools.
If supported, it should be configuration-driven:
Ranking Enabled?
Ranking Scope?
Tie Handling?
Subjects Included?
It should not be assumed that every school wants ranking.

17.29 Exam Permissions
Initial permissions:
exam.view
exam.create
exam.update
exam.archive
exam.schedule
exam.publish
exam.lock
Marks:
exam_marks.view
exam_marks.create
exam_marks.update
exam_marks.submit
exam_marks.correct
Results:
result.view
result.calculate
result.review
result.publish
result.correct
result.export
Configuration:
grading.manage
assessment_configuration.manage

17.30 Feature Structure
Initial feature:
Examination Management
│
├── Assessments
├── Exam Scheduling
├── Mark Entry
├── Grading
├── Results
└── Report Cards
Potential future:
├── Online Exams
├── Question Bank
├── Digital Evaluation
├── Ranking
└── Certificates
These can become independent sub-features if commercially necessary.

17.31 Examination Dependencies
Conceptually:
Student Management
        +
Academic Structure
        +
Teacher Management
        ↓
Examination
More specifically:
Student
 ↓
Enrollment
 ↓
Academic Context
 ↓
Subject Offering
 ↓
Assessment
 ↓
Result
Teacher assignment determines who may perform certain operations.

17.32 Attendance Relationship
Attendance and Examination are separate domains.
Attendance:
Student presence
Examination:
Student assessment
They may be used together in future analytics, but one should not own the other's data.

17.33 Fees Relationship
Fees should not be embedded into examination.
Potential future rule:
"Student must clear fees before exam"
would be a cross-domain business rule.
We should not hardcode this into Examination.
A future eligibility/policy layer could evaluate:
Academic Eligibility
+
Financial Eligibility
if the product actually requires such a policy.

17.34 Exam Configuration
School-level configuration might include:
Assessment types
Grading scales
Pass rules
Result publication workflow
Decimal precision
Ranking policy
Report-card layout
Keep this separate from the actual assessment/result records.

17.35 Exam Schedule Conflicts
Later, scheduling may need to detect:
Same class
Same time
Two exams
or:
Same room
Same time
Multiple exams
The Examination domain can expose scheduling constraints.
A sophisticated scheduling engine can be introduced later.

17.36 Bulk Mark Entry
Mark entry naturally operates in batches:
Class
+
Subject
+
Exam
+
All Eligible Students
It should have:
validation,
transaction boundaries,
draft state,
submission,
idempotency,
audit.
Partial corruption of a mark-entry batch should be avoided.

17.37 Import Marks
Future imports may support:
CSV / Excel
 ↓
Validation
 ↓
Preview
 ↓
Confirm
 ↓
Import
The import must validate:
Tenant
Exam
Subject
Enrollment
Student
Maximum marks
Status
and must not accept arbitrary cross-tenant references.

17.38 Events
Useful events:
AssessmentCreated
AssessmentScheduled

MarksSubmitted
MarksCorrected

ResultsCalculated
ResultsReviewed
ResultsPublished
ResultsCorrected

ReportCardGenerated
Potential consumers:
Notifications
Student Portal
Parent Portal
Reporting
Promotion

17.39 Audit Requirements
Audit:
Assessment creation/update
Schedule changes

Mark creation/update
Mark submission
Mark correction

Grade configuration changes

Result calculation
Result publication
Result correction

Report-card generation
Bulk imports/exports
Published-result corrections should have especially strong audit requirements.

17.40 Security Model
A teacher should only be able to enter marks when:
Authenticated
AND
Tenant Membership valid
AND
School active/recoverable
AND
Examination feature entitled
AND
Permission granted
AND
Teaching scope allows subject/class
AND
Assessment is in a writable state
That is significantly stronger than:
if user.role == teacher

17.41 Examination Conceptual Model
School
  │
  └── Academic Year
        │
        └── Assessment Period
              │
              └── Assessment
                    │
                    ├── Schedule
                    │
                    └── Assessment Subjects
                           │
                           ↓
                      Mark Entries
                           │
                           ↓
                    Result Calculation
                           │
                           ↓
                       Results
                           │
                           ↓
                       Publication
Student relationship:
Student
   ↓
Enrollment
   ↓
Assessment Eligibility
   ↓
Mark Entry
   ↓
Result
Teacher relationship:
Teacher
   ↓
Teaching Assignment
   ↓
Assessment Subject
   ↓
Mark Entry Permission

17.42 What We Should Not Finalize Yet
Intentionally deferred:
❌ Complete examination database schema
❌ Exact grading algorithms
❌ Exact pass/fail rules
❌ Ranking implementation
❌ Report-card template engine
❌ Online examination
❌ Question bank
❌ Digital evaluation
❌ Certificate generation
❌ Detailed promotion integration
❌ Country-specific grading rules

17.43 Current Architecture Map
We now have five major domain foundations:
                         PLATFORM CORE
                              │
                              ↓
                         SCHOOL/TENANT
                              │
        ┌─────────────────────┼─────────────────────┐
        ↓                     ↓                     ↓
  ACADEMIC                STUDENT                TEACHER
  STRUCTURE               MANAGEMENT             MANAGEMENT
        │                     │                     │
        └──────────────┬──────┴───────────┬────────┘
                       ↓                  ↓
                  ATTENDANCE        EXAMINATION
                       │                  │
                       └────────┬─────────┘
                                ↓
                         FUTURE DOMAINS
The next major domain should be Fee & Billing Management at the school level.
This is intentionally distinct from the platform subscription/billing system we already designed.
We will need two clearly separated financial concepts:
Platform Commercial Billing
        ↓
School pays SaaS/platform

School Fee Management
        ↓
Students/guardians pay school fees
Keeping those two financial domains separate is critical to avoid contaminating the platform's subscription architecture with school-level student fee logic.
