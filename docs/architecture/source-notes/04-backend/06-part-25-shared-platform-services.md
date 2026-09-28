<!-- Source: Apple Notes, folder 'BAckend' -->
# Part 25 — Shared Platform Services

These services are implemented once and reused by every business module.
Business Modules
       │
       ├── Files
       ├── Notifications
       ├── Audit
       ├── Events
       ├── Jobs
       ├── Search
       ├── Reporting
       └── Configuration

1. File Service
Responsibilities
Uploads
Downloads
Versioning
Metadata
Access control
Virus scanning
Retention
Archiving
Business Module
      ↓
File Service
      ↓
Object Storage
APIs
POST   /api/v1/files/upload-request
POST   /api/v1/files/:id/complete
GET    /api/v1/files/:id
GET    /api/v1/files/:id/download
POST   /api/v1/files/:id/archive
DELETE /api/v1/files/:id
Upload status:
UPLOADING
AVAILABLE
QUARANTINED
FAILED
ARCHIVED
DELETED
Never expose permanent object-storage URLs.

2. Notification Service
Supports:
IN_APP
EMAIL
SMS
PUSH
Architecture:
Domain Event
     ↓
Notification Service
     ↓
Template
     ↓
Recipient Resolver
     ↓
Delivery Queue
     ↓
Provider
APIs
GET  /api/v1/notifications
POST /api/v1/notifications/:id/read
POST /api/v1/notifications/read-all
GET  /api/v1/notification-preferences
PATCH /api/v1/notification-preferences
Business modules should request notifications, not directly call SMS/email providers.

3. Notification Templates
notification_templates
notification_preferences
notification_deliveries
Template variables:
{{student_name}}
{{school_name}}
{{amount}}
{{due_date}}
{{event_name}}
Templates are tenant-aware and support localization.

4. Event / Outbox Service
Every important business transaction can produce an event.
Database Transaction
 ├── Business Changes
 └── Outbox Event
          ↓
       Worker
          ↓
      Event Handler
Event fields
event_id
event_type
version
tenant_id
aggregate_type
aggregate_id
payload
occurred_at
processed_at
Events must be idempotent.

5. Event Categories
student.created
student.enrolled

attendance.marked
attendance.corrected

exam.created
result.published

invoice.created
payment.completed
payment.refunded

leave.approved

book.issued
book.returned

transport.assigned

stock.changed
asset.assigned

staff.onboarded
staff.offboarded

event.published

6. Background Job Service
Use:
Redis
+
BullMQ
Queues:
notifications
email
sms
push
files
reports
exports
imports
events
scheduled
Each job includes:
job_id
tenant_id
type
payload
attempt
created_at
Jobs must be retry-safe.

7. Job Retry Policy
Recommended:
Attempt 1 → immediate
Attempt 2 → short delay
Attempt 3 → longer delay
Attempt 4 → exponential backoff
After repeated failure:
Dead Letter / Failed Queue
Do not retry permanent business errors indefinitely.

8. Audit Service
Central table:
audit_logs
Record:
tenant_id
actor_id
action
entity_type
entity_id
before
after
request_id
ip_address
user_agent
created_at
Audit important operations across every module.
Examples:
STUDENT_UPDATED
FEE_PAYMENT_CREATED
RESULT_PUBLISHED
ROLE_CHANGED
DOCUMENT_DOWNLOADED
STOCK_ADJUSTED
STAFF_OFFBOARDED
Audit logs should be append-only.

9. Search Service
Start with MySQL indexes/full-text capabilities.
Common searchable resources:
Students
Staff
Teachers
Books
Inventory Items
Assets
Announcements
Standard interface:
search(
    tenant,
    resource,
    query,
    filters
)
Only introduce Elasticsearch/OpenSearch if scale requires it.

10. Reporting Service
Separate reporting from transactional business logic.
Transactional DB
       ↓
Events / ETL
       ↓
Reporting Read Models
       ↓
Reports
Initial reporting can use MySQL read queries/views.
Examples:
Student attendance report
Fee collection report
Outstanding fees
Exam results
Library circulation
Transport usage
Inventory report
HR report
Heavy report generation should run asynchronously.

11. Export Service
Common formats:
CSV
XLSX
PDF
Flow:
User
 ↓
Create Export Job
 ↓
Background Worker
 ↓
Generate File
 ↓
Store File
 ↓
Short-lived Download URL
Large exports should never block an HTTP request.

12. Import Service
Support controlled imports for:
Students
Staff
Subjects
Fee structures
Inventory
Books
Flow:
Upload
 ↓
Validate
 ↓
Preview Errors
 ↓
Confirm
 ↓
Process
 ↓
Import Report
Never partially import silently.
Every import should produce a result:
total
successful
failed
skipped
errors

13. Configuration Service
Separate configuration into:
Platform configuration
system limits
provider settings
global features
Tenant configuration
school name
branding
timezone
locale
academic defaults
notification defaults
financial settings
User preferences
language
timezone
notification preferences
dashboard preferences
Configuration precedence:
Platform
   ↓
Tenant
   ↓
User

14. Storage Service
Object storage should use keys such as:
tenants/{tenant_id}/files/{file_id}
Additional separation:
tenants/{tenant_id}/documents/
tenants/{tenant_id}/exports/
tenants/{tenant_id}/reports/
Access must always pass through authorization.

15. Cache Service
Redis cache abstraction:
get()
set()
delete()
invalidate()
remember()
Good cache candidates:
permissions
entitlements
tenant settings
reference data
dashboard projections
Never cache authoritative financial or transactional state without a clear invalidation strategy.

16. Rate Limiting
Apply different limits by category.
Authentication
Strict:
login
password reset
MFA
General API
Tenant/user-aware rate limits.
Public endpoints
IP-based limits.
Webhooks
Provider-specific validation and replay protection.

17. Idempotency Service
Support:
Idempotency-Key
for:
payments
webhooks
imports
exports
bulk operations
financial operations
Store:
key
tenant_id
request_hash
response
status
expires_at
Same request repeated with the same key should not create duplicate business records.

18. External Provider Abstraction
Never tightly couple business modules to vendors.
Example:
PaymentProvider
 ├── ProviderA
 └── ProviderB

EmailProvider
 ├── ProviderA
 └── ProviderB

SmsProvider
 ├── ProviderA
 └── ProviderB

StorageProvider
 ├── S3
 └── CompatibleStorage
Business code depends on interfaces.

19. Shared Reference Data
Centralize stable reference data where appropriate:
countries
states
cities
currencies
languages
timezones
document_types
notification_channels
Tenant-specific reference data remains owned by the relevant domain.

20. Observability
Three pillars:
Logs
Metrics
Traces
Track:
API latency
API errors
DB latency
queue failures
job duration
notification delivery
file processing
external provider failures
Every request/job should be traceable using:
request_id
trace_id
tenant_id

21. Security Across Shared Services
Mandatory:
Tenant isolation
Authorization
Encryption in transit
Secrets management
Signed file URLs
Audit logging
Rate limiting
Input validation
Webhook verification
Sensitive-data redaction
Never trust identifiers coming from external clients without validating ownership.

22. Shared Service Dependency Graph
                    ┌─────────────┐
                    │   Identity  │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │    Tenant   │
                    └──────┬──────┘
                           │
        ┌──────────────────┼──────────────────┐
        ↓                  ↓                  ↓
 Authorization       Entitlements        Configuration
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ↓
                    Business Modules
                           │
        ┌──────────┬───────┼───────┬──────────┐
        ↓          ↓       ↓       ↓          ↓
      Events      Files   Audit  Jobs    Notifications
        │                                  │
        └───────────────┬──────────────────┘
                        ↓
                   Reporting

23. Shared Services Definition of Done
✓ File service
✓ Object storage
✓ Signed URLs
✓ File scanning lifecycle
✓ Notification service
✓ Email/SMS/Push abstraction
✓ Notification templates
✓ Event bus
✓ Outbox
✓ Background jobs
✓ Retry/dead-letter handling
✓ Audit logging
✓ Search abstraction
✓ Reporting foundation
✓ Import/export
✓ Configuration
✓ Cache
✓ Rate limiting
✓ Idempotency
✓ External provider abstraction
✓ Logging/metrics/tracing
✓ Security controls
✓ Integration tests
Platform foundation is now complete
The architecture is now:
Identity
   ↓
Tenant
   ↓
RBAC + Entitlements
   ↓
Shared Services
   ↓
Business Modules
   ↓
Portal / Web / Flutter
The next step is to define Part 26 — All Business Modules Implementation Blueprint in one pass, covering Students through Portal with their exact module boundaries, services, repositories, workflows, APIs, events, jobs, permissions, and implementation order—without repeating the database/API architecture already established.
