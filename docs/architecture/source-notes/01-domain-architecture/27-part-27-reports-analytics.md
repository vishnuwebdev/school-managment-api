<!-- Source: Apple Notes, folder 'Notes' -->
# Part 27 — Reports & Analytics

Reporting is different from the operational domains we've designed so far.
The key principle is:
Operational domains own business truth. Reporting owns derived views, aggregation, analytics, and presentation of that truth.
Reporting must never become a second source of truth.

27.1 Domain Purpose
Reports & Analytics
├── Report Definitions
├── Report Execution
├── Operational Reports
├── Aggregated Reports
├── Dashboards
├── Metrics / KPIs
├── Exports
├── Scheduled Reports
└── Reporting Read Models
Future:
├── Advanced Analytics
├── Data Warehouse
├── Predictive Analytics
├── Custom Report Builder
└── BI Integrations

27.2 Why Reporting Needs Its Own Boundary
Consider:
Fees
→ owns payments

Attendance
→ owns attendance records

Examination
→ owns marks/results

Student
→ owns students
A report may combine them:
Student
+
Attendance
+
Results
+
Fees
=
Student Performance Report
But the report does not own any of those records.

27.3 Source of Truth
The ownership model remains:
Student → Student data
Academic → Academic structure
Attendance → Attendance
Examination → Results
Fees → Financial transactions
Library → Circulation
Transportation → Transport
Reporting consumes those domains.

27.4 Reporting Architecture
For simple reports:
Report Request
 ↓
Reporting Service
 ↓
Domain Read APIs / Queries
 ↓
Report
For complex/high-volume reports:
Operational Domains
        ↓
Domain Events / CDC / ETL
        ↓
Reporting Read Models
        ↓
Reports / Dashboards
V1 should not require a full enterprise data warehouse.

27.5 Operational Reports
These are reports close to current transactional data.
Examples:
Student List
Attendance Register
Fee Collection
Outstanding Fees
Library Overdues
Teacher List
Transport Assignments
These can often use optimized read queries against operational data.

27.6 Analytical Reports
These combine and aggregate data.
Examples:
Attendance by Class
Fee Collection by Month
Exam Performance by Class
Student Attendance vs Results
Library Usage Trends
Transport Utilization
These may eventually benefit from reporting-specific read models.

27.7 Dashboard
A dashboard is a presentation of multiple metrics.
Example:
School Dashboard
├── Total Students
├── Attendance Today
├── Fee Collection
├── Outstanding Fees
├── Upcoming Exams
├── Active Teachers
└── Transport Assignments
The dashboard does not own any of these numbers.

27.8 Metric Definition
A metric should have a clear definition.
Example:
Attendance Rate
=
Present Student Attendance
÷
Applicable Attendance Records
× 100
Avoid ambiguous labels such as:
"Attendance %"
without defining exactly what population and time period it represents.

27.9 Reporting Time Context
Every report should clearly define its period.
Examples:
Today
This Week
This Month
Academic Year 2026–27
Term 1
Custom Date Range
Academic and calendar periods should not be silently mixed.

27.10 Historical Accuracy
Reports should respect historical domain state.
Example:
Student was in Class 7-A in June.
Student moved to Class 7-B in July.
A June report should still show:
Class 7-A
not the student's current class.
This is why the earlier domains preserve historical enrollment and effective-dated information.

27.11 Snapshot vs Current State
Reports sometimes require historical snapshots.
For example:
Published Result
may need to remain unchanged even if configuration later changes.
Reporting should consume the authoritative historical result rather than recalculate it using today's configuration.

27.12 Report Filters
Common filters:
Academic Year
Class
Section
Subject
Teacher
Date Range
Student Status
Fee Status
Attendance Status
Filters must be validated against the user's authorized scope.

27.13 Reporting Authorization
A user with:
report.view
does not automatically get access to every report.
A report can require additional permissions:
report.student
report.attendance
report.exam
report.fee
report.payroll
and appropriate scopes.

27.14 Financial Report Protection
Financial reports may contain sensitive information.
For example:
Fee Collection Report
Payment History
Refund Report
Outstanding Receivables
These require explicit financial permissions.
A teacher should not gain access merely because they can view student information.

27.15 Sensitive Student Reports
Likewise:
Student Personal Information
Guardian Details
Medical/other sensitive records if introduced
should require appropriate permissions.
Reporting must not bypass the security rules of the underlying domain.

27.16 Tenant Isolation
Every report request must execute within:
Tenant Context
unless it is an explicitly privileged platform report.
A school report must never accidentally aggregate:
School A + School B
because a query omitted tenant_id.

27.17 Platform Reports
Platform users may need cross-school reports:
Active Schools
Subscription Revenue
Feature Adoption
School Growth
Platform Usage
These are different from school reports.
Conceptually:
School Reporting
→ Single Tenant

Platform Reporting
→ Multiple Tenants
→ Explicit Platform Authorization
Cross-tenant reporting must be deliberate.

27.18 Cross-Tenant Aggregation
For example:
Platform Admin
 ↓
Platform Report Permission
 ↓
All Authorized Tenants
 ↓
Aggregated Result
Tenant data must remain logically separated even when aggregated.

27.19 Report Definitions
A report definition can conceptually specify:
Report
├── Name
├── Description
├── Source
├── Columns
├── Filters
├── Permissions
├── Default Sorting
└── Output Formats
But avoid building a completely generic SQL/report builder in V1.

27.20 Predefined Reports First
V1 should prioritize known reports.
For example:
Student
├── Student Directory
├── Enrollment Report

Attendance
├── Daily Attendance
├── Attendance Summary
├── Absentee Report

Examination
├── Result Summary
├── Subject Performance

Fees
├── Collection
├── Outstanding
├── Payment History

Library
├── Circulation
├── Overdue

Transportation
├── Assignments
├── Route Utilization
This is easier to secure and maintain.

27.21 Custom Report Builder
A generic report builder can become extremely complex.
Potential future:
Select Domain
 ↓
Select Fields
 ↓
Join Data
 ↓
Filters
 ↓
Grouping
 ↓
Calculated Fields
 ↓
Save Report
This should be deferred until real requirements justify it.

27.22 Export
Reports may support:
CSV
Excel
PDF
depending on product requirements.
Export must be treated as an authorized action:
report.view
≠
report.export
because exports create a persistent copy of potentially sensitive data.

27.23 Large Exports
Large exports should use the bulk-job infrastructure.
Export Request
 ↓
Authorization
 ↓
Background Job
 ↓
Generate File
 ↓
Private File Storage
 ↓
Controlled Download
Not:
HTTP Request
 ↓
Generate 500 MB file
 ↓
Wait

27.24 Export Audit
Sensitive exports should be auditable.
Record:
Actor
Tenant
Report
Filters
Timestamp
Result/File
Potentially:
Reason
for especially sensitive reports.

27.25 Scheduled Reports
Schools may want:
Every Monday at 8 AM
→ Attendance Summary
or:
First day of every month
→ Fee Collection Report
The scheduler creates a reporting job.

27.26 Scheduled Report Security
A scheduled report must retain its authorization context.
Do not allow:
Admin creates report
 ↓
Admin loses access
 ↓
Scheduled job continues indefinitely
The system should validate authorization appropriately when executing scheduled reports.

27.27 Report Delivery
Possible:
Generate Report
 ↓
Private File
 ↓
Email Notification
Communication handles delivery.
Reporting owns generation.

27.28 Dashboard Read Models
For dashboards with many metrics:
Operational Data
      ↓
Events / Aggregation
      ↓
Dashboard Read Model
      ↓
Fast Dashboard Query
This prevents repeatedly running expensive joins.

27.29 Event-Driven Analytics
Example:
PaymentReceived
      ↓
Reporting Read Model
      ↓
Daily Collection Metric Updated
Likewise:
AttendanceRecorded
      ↓
Attendance Analytics
This is where the Outbox/Event architecture established earlier becomes useful.

27.30 Eventual Consistency
Reporting read models may be slightly behind transactional data.
Therefore:
Operational Screen
→ Authoritative current state

Analytics Dashboard
→ Potentially eventually consistent
The UI should communicate freshness where it matters.

27.31 Real-Time Reports
Not every report needs a read model.
For example:
Student Directory
can likely query current operational data.
While:
Five-year attendance trend
is better suited to analytical storage/read models.
Use the simplest appropriate approach.

27.32 Report Caching
Some expensive reports can be cached.
Cache keys must include:
Tenant
Report
Filters
Scope
Time Period
Relevant Version
Never allow one tenant's cached report to be returned to another tenant.

27.33 Report Versioning
Report definitions may change.
For important published reports:
Attendance Report v1
Attendance Report v2
Historical exports already generated should not change.

27.34 Academic Reporting
Academic reports may combine:
Academic Structure
+
Students
+
Enrollment
+
Teachers
+
Examinations
+
Attendance
The Reporting domain coordinates these views.
No domain becomes subordinate to Reporting.

27.35 Student Performance
Potential report:
Student
 ├── Attendance
 ├── Assessment Results
 ├── Enrollment
 └── Academic Context
The report can show correlations, but it should not automatically claim causation.
Reporting presents documented measurements.

27.36 Fee Analytics
Examples:
Total billed
Total collected
Outstanding
Overdue
Collection by payment method
Collection by fee category
Refunds
Concessions
Financial definitions must come from Fees.
Reporting aggregates them.

27.37 Operational KPIs
Possible school dashboard metrics:
Students
Teachers
Attendance
Fee Collection
Outstanding Fees
Upcoming Exams
Active Library Loans
Transport Assignments
Each KPI should have:
definition,
source,
time period,
population,
calculation.

27.38 Reporting Permissions
Initial permissions:
report.view
report.export
report.schedule
report.manage
dashboard.view
Domain-specific:
report.student.view
report.attendance.view
report.exam.view
report.fee.view
report.library.view
report.transport.view
Platform:
platform_report.view
platform_report.export

27.39 Report Ownership
Each domain should define its reportable concepts.
For example:
Fees
→ defines fee-related metrics

Attendance
→ defines attendance metrics

Examination
→ defines result metrics
Reporting combines and presents them.
This avoids putting business calculations exclusively into a generic reporting layer.

27.40 Audit
Audit:
Report Created
Report Definition Changed
Report Scheduled
Report Schedule Changed
Sensitive Report Exported
Cross-Tenant Report Generated
Ordinary report viewing may not need an audit record for every request, depending on sensitivity.

27.41 Events
Reporting generally consumes many events:
StudentCreated
EnrollmentChanged
AttendanceRecorded
ResultPublished
FeeDemandIssued
PaymentReceived
BookIssued
TransportAssignmentChanged
It may emit:
ReportGenerated
ReportExported
if other platform components need them.

27.42 Failure Handling
If reporting infrastructure is unavailable:
Core Transaction
→ Must continue
For example:
PaymentReceived
 ↓
Reporting unavailable
 ↓
Payment still succeeds
The reporting update can be retried asynchronously.
Reporting must not become a critical dependency of operational transactions.

27.43 Data Freshness
Every analytical model should have an understood freshness target.
Examples:
Operational report → near real-time
Dashboard → seconds/minutes
Daily analytics → hourly/daily
Historical analytics → batch
Exact targets belong in non-functional requirements later.

27.44 Future Data Warehouse
The architecture should leave room for:
Operational DB
      ↓
Events / ETL
      ↓
Analytics Store / Warehouse
      ↓
BI / Advanced Analytics
But V1 does not need to introduce a separate warehouse unless scale or reporting complexity requires it.

27.45 Feature Structure
Initial:
Reports & Analytics
├── Standard Reports
├── Dashboards
├── Exports
└── Scheduled Reports
Future:
├── Custom Report Builder
├── Advanced Analytics
├── Data Warehouse
└── BI Integration

27.46 Entitlement
Possible capabilities:
reporting
reporting.advanced
reporting.custom
reporting.bi
The core reporting feature should not be unnecessarily fragmented.

27.47 Final Architecture
             DOMAIN SOURCES
                   │
       ┌───────────┼────────────┐
       ↓           ↓            ↓
    Student     Attendance     Fees
       ↓           ↓            ↓
    Academic     Exams       Library
       │           │            │
       └───────────┼────────────┘
                   ↓
            REPORTING LAYER
                   │
        ┌──────────┼───────────┐
        ↓          ↓           ↓
     Reports    Dashboards   Exports
        │          │           │
        └──────────┼───────────┘
                   ↓
             Communication
The central architectural rule remains:
Operational Domains
       ↓
Source of Truth

Reporting
       ↓
Derived Views

27.48 Updated Domain Map
Platform
├── Identity / User & Role Administration
├── Tenant Management
├── Plans / Pricing / Billing
├── Feature Catalog / Entitlements
├── Audit
├── Communication
└── Platform Services

School Domains
├── Student
├── Academic
├── Teacher
├── Attendance
├── Examination
├── Fees
├── Transportation
├── Timetable
├── Library
├── Leave / Staff Operations
├── Parent / Guardian Portal
└── Reports & Analytics
Next: Part 28 — System Settings & Configuration. This will define the difference between platform configuration, school configuration, domain configuration, and actual business data so configuration changes do not accidentally rewrite historical records.
