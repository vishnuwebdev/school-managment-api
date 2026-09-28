<!-- Source: Apple Notes, folder 'Core Database design system' -->
# Part 41 — Reporting & Integrations Database Design

These are both downstream platform capabilities, but they solve different problems.
Operational Domains
        │
        ├──────────────→ Reporting
        │
        └──────────────→ Integrations
The core rules remain:
Reporting reads and aggregates business truth. It does not own business transactions.
Integrations translate between internal contracts and external systems. External systems do not become the school's source of truth by default.

41.1 Reporting Ownership
Reporting owns:
Report Definitions
Report Runs
Report Parameters
Dashboards
Dashboard Widgets
Metrics / KPI Definitions
Reporting Read Models
Exports
Scheduled Reports
It does not own:
Students
Attendance
Fees
Payments
Examinations
Library Loans
Transport Assignments
Timetable
Teachers
Those remain in their respective domains.

41.2 Report Definition
A predefined report can be represented conceptually as:
report_definitions
------------------
id
tenant_id nullable
report_key
name
description
domain
report_type
status
configuration
created_at
updated_at
tenant_id can be nullable for platform-level report definitions.
For example:
student.directory
attendance.summary
fee.outstanding
fee.collection
exam.performance
library.overdue
transport.assignments

41.3 Platform vs School Reports
There are two important scopes:
Platform Report
    ↓
Potentially cross-tenant

School Report
    ↓
Single tenant
A platform report must require explicit platform-level authorization.
A school report must always execute within tenant context.

41.4 Report Type
Useful categories:
OPERATIONAL
AGGREGATED
ANALYTICAL
FINANCIAL
ADMINISTRATIVE
The category is primarily organizational; authorization remains permission-based.

41.5 Report Parameters
A report should define allowed filters.
Example:
Attendance Report
 ├── Academic Year
 ├── Class
 ├── Section
 ├── Date From
 └── Date To
Parameters should be validated server-side.
The client must never be able to bypass scope by submitting arbitrary IDs.

41.6 Report Run
A report execution can be recorded:
report_runs
-----------
id
tenant_id
report_definition_id
requested_by
status
parameters
started_at
completed_at
result_reference
error_code
created_at
Lifecycle:
QUEUED
   ↓
RUNNING
   ↓
COMPLETED
or:
FAILED
CANCELLED

41.7 Small vs Large Reports
Not every report needs a background job.
Use:
Small / fast report
→ synchronous response
For large reports:
Report Request
      ↓
Background Job
      ↓
Generate
      ↓
Private File
      ↓
Download
This prevents long-running HTTP requests.

41.8 Export
Exports are separate from viewing.
report_exports
-------------
id
tenant_id
report_run_id
format
file_id
status
requested_by
created_at
expires_at
Formats may include:
CSV
XLSX
PDF
depending on the product requirements.

41.9 Export Authorization
A user having:
report.view
does not automatically mean they have:
report.export
Export can expose significantly more data and should be independently permissioned.

41.10 Sensitive Exports
Financial or personally sensitive exports should generate an audit record:
User
 ↓
Export
 ↓
Audit
The audit should capture:
actor,
tenant,
report,
filters,
timestamp,
request/correlation ID.

41.11 Scheduled Reports
Conceptually:
scheduled_reports
----------------
id
tenant_id
report_definition_id
schedule
parameters
recipient_configuration
status
next_run_at
last_run_at
created_by
created_at
updated_at
The scheduler creates a report job rather than executing the report directly.

41.12 Scheduled Report Security
Authorization should be revalidated when the scheduled job runs.
Do not assume:
User had permission when schedule was created
means:
User still has permission today
If the user is disabled or access is revoked, the scheduled report should not continue delivering protected information.

41.13 Dashboard
Dashboards are presentation definitions:
dashboards
----------
id
tenant_id
name
dashboard_type
status
created_by
created_at
updated_at
Examples:
School Admin Dashboard
Finance Dashboard
Attendance Dashboard
Library Dashboard
Teacher Dashboard

41.14 Dashboard Widgets
dashboard_widgets
-----------------
id
tenant_id
dashboard_id
widget_type
report_definition_id nullable
position
configuration
status
The widget references a report/metric/read model rather than owning the underlying business data.

41.15 Metrics
A metric must have a precise definition.
Conceptually:
metric_definitions
------------------
id
tenant_id nullable
metric_key
name
description
domain
calculation_definition
unit
status
created_at
updated_at
Examples:
student_count
attendance_rate
fee_collection_amount
fee_outstanding_amount
library_active_loans
transport_utilization

41.16 Metric Definition Matters
For example:
Attendance Rate
must define:
Population
Time period
Included statuses
Excluded statuses
Calculation
Otherwise two reports can calculate different "attendance rates."
The domain that owns the business meaning should define the semantics.

41.17 Reporting Read Models
Complex reports should not repeatedly perform expensive joins across operational tables.
Example:
attendance_reporting_daily
--------------------------
tenant_id
date
academic_year_id
class_id
section_id
student_count
present_count
absent_count
late_count
...
This is derived data.

41.18 Read Model Updates
Recommended:
Operational Transaction
        ↓
Outbox Event
        ↓
Reporting Worker
        ↓
Read Model
This keeps reporting work outside the core transaction.

41.19 Read Model Failure
If projection fails:
Fee Payment
   ↓
Successful

Reporting Projection
   ↓
Failed
The payment remains successful.
The reporting projection retries.

41.20 Reporting Consistency
Two kinds of reporting can exist:
Operational
Needs highly current data.
Fee Demand Detail
Current Payment Status
Current Student List
These can query authoritative operational data/read-optimized views.
Analytical
Can tolerate eventual consistency.
Monthly Attendance Trend
Fee Collection Trend
Library Utilization
These are good candidates for reporting read models.

41.21 Historical Reporting
Reports must respect historical data.
For example:
Student was in Section A in April
Student moved to Section B in May
An April report must not retroactively show Section B.
Therefore reporting consumes the historical/effective-dated information established by operational domains.

41.22 Tenant-Aware Reporting
Every school report executes with:
tenant_id
actor_id
membership_id
scope
The reporting query must enforce the same tenant and scope boundaries as operational APIs.

41.23 Platform Reporting
Platform reporting may intentionally aggregate:
School A
School B
School C
...
but only through explicitly privileged platform permissions.
Examples:
platform.report.view
platform.report.export
A normal School Admin cannot reach this context.

41.24 Reporting Cache
Cache keys should include:
tenant
report
parameters
scope
time range
definition version
Never use:
"attendance-dashboard"
as a global cache key.

41.25 Reporting Database Structure
Conceptually:
Reporting
├── report_definitions
├── report_runs
├── report_exports
├── scheduled_reports
├── dashboards
├── dashboard_widgets
├── metric_definitions
└── reporting_read_models
The exact physical read models will be added as reporting requirements become concrete.

41.26 Integrations Ownership
Integrations owns:
Integration Registry
Provider Connections
External References
Webhook Receipts
Sync Jobs
Integration Failures
Integration Health
Integration Logs
It does not own the business meaning of:
Payment
Student
Attendance
Fee
Exam Result

41.27 Integration Registry
Conceptually:
integrations
------------
id
tenant_id nullable
integration_type
provider
name
status
configuration
created_at
updated_at
Examples:
Payment Gateway
Email Provider
SMS Provider
Accounting System
SSO Provider
GPS Provider
Calendar Provider

41.28 Platform vs Tenant Integration
Some integrations may be platform-level:
Platform
 └── Payment Gateway
Others may be school-specific:
School A
 └── Accounting System

School B
 └── Accounting System
Therefore the integration registry should support both scopes.

41.29 Provider Connection
A connection represents an actual configured connection.
integration_connections
-----------------------
id
tenant_id
integration_id
status
credentials_reference
configuration
last_health_check_at
created_at
updated_at
Credentials should be references to secure secret storage, not plaintext secrets.

41.30 Credential Rotation
The model should allow:
Credential Version A
       ↓
Credential Version B
without exposing secrets in ordinary database records or logs.
Rotation should be auditable.

41.31 Integration Lifecycle
Recommended:
CONFIGURED
   ↓
VALIDATING
   ↓
ACTIVE
Failure states:
DEGRADED
DISCONNECTED
FAILED
The exact states can vary by integration type.

41.32 External References
Internal entities should retain external IDs where synchronization requires them.
Conceptually:
external_references
-------------------
id
tenant_id
integration_connection_id
entity_type
entity_id
external_entity_type
external_id
created_at
updated_at
Example:
Internal Payment
     ↓
External Gateway Transaction
     ↓
provider_transaction_987
The internal ID remains authoritative.

41.33 Why External IDs Need Their Own Model
Avoid putting:
stripe_id
quickbooks_id
provider_x_id
provider_y_id
directly on every domain table.
That would tightly couple business domains to provider choices.
Instead:
Domain Entity
      ↓
External Reference
      ↓
Integration
      ↓
Provider

41.34 Payment Integration
The recommended flow remains:
Fees
 ↓
Payment Service
 ↓
Payment Gateway Adapter
 ↓
External Gateway
The gateway transaction ID is stored as an external reference.
The internal Payment remains authoritative.

41.35 Payment Webhook
Webhook flow:
Gateway
 ↓
Webhook
 ↓
Authenticate / Verify
 ↓
Deduplicate
 ↓
Translate
 ↓
Internal Payment Command/Event
 ↓
Fees
The webhook endpoint should not directly mutate arbitrary payment tables without domain validation.

41.36 Webhook Receipt
Conceptually:
webhook_receipts
----------------
id
tenant_id nullable
integration_connection_id
provider
external_event_id
event_type
payload_reference
signature_valid
status
received_at
processed_at
The raw payload may need secure storage depending on retention requirements.

41.37 Webhook Idempotency
Provider event IDs should be deduplicated.
Conceptually:
UNIQUE(
  integration_connection_id,
  external_event_id
)
This prevents processing the same webhook multiple times.

41.38 Integration Jobs
Scheduled or asynchronous synchronization:
integration_jobs
---------------
id
tenant_id
integration_connection_id
job_type
status
attempt_count
scheduled_at
started_at
completed_at
last_error
created_at
updated_at
Examples:
PAYMENT_RECONCILIATION
ACCOUNTING_EXPORT
STUDENT_SYNC
GPS_SYNC
CALENDAR_SYNC

41.39 Integration Job Lifecycle
QUEUED
 ↓
RUNNING
 ↓
COMPLETED
or:
FAILED
 ↓
RETRYING
 ↓
COMPLETED
Non-retryable errors should move to a state requiring intervention.

41.40 Retry Strategy
Transient errors:
Network timeout
Provider unavailable
Rate limit
Temporary gateway failure
should be retryable.
Permanent errors:
Invalid credentials
Invalid payload
Unsupported operation
Invalid external reference
should not retry indefinitely.

41.41 Integration Health
Useful fields:
last_success_at
last_failure_at
last_health_check_at
consecutive_failures
status
This supports an operational integration-health screen.

41.42 Integration Logs
Integration logs should capture technical information such as:
Request/response metadata
Provider
Operation
Status
Latency
External reference
Error category
Correlation ID
But should avoid:
Passwords
API secrets
Payment credentials
Unnecessary sensitive PII

41.43 Integration Audit
Integration configuration changes belong in Audit:
Integration enabled
Integration disabled
Credentials rotated
Provider changed
Connection tested
Connection reconnected
Integration logs are not a substitute for audit.

41.44 Accounting Integration
If accounting is added later:
Fees
 ↓
Accounting Adapter
 ↓
Accounting System
The accounting system does not automatically become the source of truth for:
Student Fee Demand
School Payment
Receipt
The internal Fees domain remains authoritative unless a deliberate architecture decision changes that.

41.45 SSO Integration
SSO should provide authentication information.
But after authentication:
SSO Identity
   ↓
Internal User
   ↓
Membership
   ↓
Role
   ↓
Permission
The external identity provider does not determine tenant authorization by itself.

41.46 GPS Integration
Transportation may eventually consume:
Vehicle Location
Trip Status
Location Timestamp
The GPS provider remains an external source for location telemetry.
Transportation still owns:
Vehicle
Trip
Route
Student Assignment

41.47 Calendar Integration
Calendar integration may expose timetable events externally:
Timetable
 ↓
Calendar Adapter
 ↓
External Calendar
The external calendar should not become the authoritative timetable.

41.48 File Storage Integration
The common File Service can use:
Object Storage Provider
but domain records reference:
file_id
rather than provider-specific bucket/object structures.

41.49 Two-Way Synchronization
Two-way sync is substantially more complex.
For example:
Internal Student
      ↕
External Student
The system must define:
ownership,
conflict rules,
versioning,
deletion behavior,
retry behavior.
Do not assume:

without explicitly deciding it.

41.50 External Import
External data should flow through domain validation:
External File/API
      ↓
Integration Adapter
      ↓
Normalized Internal Command
      ↓
Domain Validation
      ↓
Domain Transaction
Never:
External API
      ↓
Direct DB INSERT

41.51 Integration Events
Useful platform events:
IntegrationConnected
IntegrationDisconnected
IntegrationValidationFailed
IntegrationRecovered
IntegrationSyncStarted
IntegrationSyncCompleted
IntegrationSyncFailed
WebhookReceived
WebhookProcessingFailed
ExternalPaymentConfirmed

41.52 Reporting Integration Data
Reporting can consume integration events to report:
Active integrations
Failed integrations
Webhook failures
Pending synchronization
Provider health
Reconciliation status
This is operational reporting, not integration ownership.

41.53 Integration Permissions
Examples:
integration.view
integration.create
integration.update
integration.test
integration.enable
integration.disable
integration.reconnect
integration.view_logs
Sensitive credential operations should be separately protected.

41.54 Tenant Isolation
Tenant-specific integration data must carry:
tenant_id
Platform integrations may intentionally have no tenant context.
The system must never accidentally use:

for:


41.55 Integration Database Structure
Integrations
├── integrations
├── integration_connections
├── external_references
├── webhook_receipts
├── integration_jobs
└── integration_logs
Credentials themselves live outside ordinary application data storage.

41.56 Reporting + Integrations Relationship
The clean relationship is:
Operational Domains
       │
       ├────────→ Reporting
       │
       └────────→ Integrations
They should not become dependent on one another.
For example:
Fees
 ├──→ Reporting
 └──→ Payment Integration
not:
Fees → Reporting → Payment Integration

41.57 Failure Model
The system now has clear failure boundaries.
Reporting failure
Business transaction
      ↓
SUCCESS
      ↓
Reporting projection fails
      ↓
Retry
Integration failure
Business transaction
      ↓
SUCCESS
      ↓
External provider unavailable
      ↓
Pending / Retry / Reconciliation
Authorization failure
Authorization unavailable
      ↓
FAIL CLOSED
These should not be treated as one generic error model.

41.58 Final Reporting/Integration Boundary
BUSINESS DOMAINS
      │
      │ authoritative facts
      ↓
 ┌───────────────┐
 │               │
 ↓               ↓
REPORTING     INTEGRATIONS
 │               │
 ↓               ↓
Read Models    External Systems
Dashboards     Providers
Exports        Webhooks
Analytics      Sync

41.59 Key Decisions Locked
✓ Operational domains remain source of truth
✓ Reports are derived
✓ Large reports run asynchronously
✓ Export is separately permissioned
✓ Scheduled reports revalidate authorization
✓ Read models are eventually consistent
✓ Platform reporting requires explicit privilege
✓ Reporting cache keys are tenant-aware

✓ Integrations use adapters
✓ External IDs are separate from internal IDs
✓ Credentials are stored as secure references
✓ Webhooks are authenticated and idempotent
✓ Integration jobs are retryable
✓ Transient and permanent failures differ
✓ Two-way sync requires explicit conflict rules
✓ External systems do not automatically become sources of truth
✓ Integration logs differ from audit
✓ Tenant-specific provider connections are isolated

Architecture Checkpoint — Parts 31–41 Complete
At this point, the detailed conceptual database design covers:
31  Core Platform
32  Student + Academic
33  Teacher + Attendance
34  Examination
35  Fees
36  Transportation
37  Timetable
38  Library
39  Leave / Staff Operations
40  Communication + Parent Portal
41  Reporting + Integrations
The remaining database-design step is now Part 42 — Global Database Constraints, Indexes, Transactions & Concurrency.
That final pass should not introduce new domains. It should validate the entire model for:
Tenant isolation
Foreign-key integrity
Cross-tenant prevention
Unique constraints
Indexes
Soft archive/lifecycle rules
Transactions
Optimistic locking
Pessimistic locking where necessary
Idempotency
Outbox consistency
Background-job safety
Financial concurrency
Bulk-operation safety
Historical data preservation
Audit consistency
That is the appropriate point to turn the conceptual model into a coherent V1 database architecture specification, without prematurely writing every column/type for every table.
