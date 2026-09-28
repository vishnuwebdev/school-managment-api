<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Remaining Architecture Foundation

The following decisions are now adopted as the recommended V1 defaults.
99. Background Jobs
Use a persistent database-backed job model initially.
Application Service
      ↓
Business Transaction
      ↓
Job Record / Outbox
      ↓
Worker
      ↓
Job Handler
      ↓
Result / Retry / Failure
Rules:
Jobs are persisted; never rely on in-memory jobs.
Every job has:
job_id
job type
tenant context where applicable
actor/context metadata
status
attempt count
scheduled time
started/completed time
correlation ID
error information
Jobs are at-least-once.
Handlers must be idempotent.
Exponential retry with bounded attempts.
Permanent failures move to a recoverable failed/dead-letter state.
Jobs can be retried manually by authorized platform operations.
Tenant context is mandatory for tenant-owned jobs.
Platform jobs explicitly use platform context.
Long-running workflows maintain explicit workflow state rather than relying on a single long-running job.
No external job platform is required for V1; the abstraction must allow one later.

100. Bulk Operations
Bulk operations are first-class workflows.
Request
 ↓
Validate
 ↓
Preview
 ↓
Confirm
 ↓
Background Job
 ↓
Process
 ↓
Result
Rules:
Never perform large bulk mutations synchronously through an HTTP request.
Preview identifies validation errors before execution.
Confirmation is explicit.
Each operation has an idempotency key.
Partial success is supported where domain rules permit it.
Results identify successful, failed, skipped, and invalid records.
Authorization is revalidated when the job executes.
Tenant context is immutable throughout the operation.
Bulk exports use the same controlled workflow.

101. Audit Architecture
Use three distinct records:
Application Logs
      ≠
Security Events
      ≠
Business Audit
Business Audit
For important administrative/business actions:
actor
actor type
tenant/context
action
entity type
entity ID
before state where appropriate
after state where appropriate
reason
request/correlation ID
timestamp
Security Events
For:
login/logout
failed authentication
OTP abuse
refresh-token reuse
session revocation
privilege changes
membership changes
suspicious authorization events
Application Logs
For diagnostics and engineering operations.
Sensitive information such as passwords, OTPs, refresh tokens and payment secrets is never logged.
Audit records are append-oriented and protected from normal business-user modification.

102. Audit Retention
Use configurable retention policies.
Different categories may have different retention periods:
security events
administrative audit
financial audit
operational logs
integration logs
Financial and legally significant records should be retained according to applicable business/legal requirements.
Audit history is not treated as an ordinary CRUD table.

103. File Architecture
Use one centralized File Service.
Domain
  ↓
File Service
  ↓
Private Object Storage
Domains own the meaning of the document; File Service owns storage/security mechanics.
Each file has:
tenant ownership
owner entity/type
storage key
MIME type
size
checksum
upload status
visibility/access policy
created/updated metadata
Rules:
Files are private by default.
No direct public storage URLs.
Access requires authorization.
Signed/time-limited download URLs may be generated.
Storage paths are tenant-isolated.
File metadata remains in MySQL; binary content remains in object storage.
Deleting a business record does not automatically physically delete files unless explicitly defined.
Virus/malware scanning can be added behind the File Service.
File replacement preserves historical references where required.
This supports student documents, teacher documents, leave attachments, reports, receipts, portal documents, etc. without every domain creating its own storage system.

104. Notifications
Communication remains the centralized notification system.
Domain Event
    ↓
Notification Request
    ↓
Communication
    ↓
Template Version
    ↓
Channel Provider
    ↓
Delivery / Retry / History
Rules:
Business transaction does not depend on successful notification delivery.
Notification delivery is asynchronous.
Delivery is at-least-once and idempotent.
Provider failures are retryable.
Templates are versioned.
Recipient resolution comes from authoritative domain data.
Important deliveries retain a destination snapshot for historical traceability.
User notification preferences are respected where applicable.
Mandatory/security notifications may override ordinary preferences.
Email, SMS, WhatsApp and push remain provider-adapter based.

105. Search
Use a centralized search abstraction but do not make a search engine mandatory for V1.
Domain Database
      ↓
Search Abstraction
      ↓
MySQL search initially
      ↓
Dedicated Search Engine later if needed
Rules:
Search is always tenant-scoped.
Search results never become the source of truth.
Authorization is still checked against authoritative data.
Search indexes may be rebuilt.
Large/high-volume domains can later move to Elasticsearch/OpenSearch or equivalent without changing domain APIs.

106. Reporting
Reporting remains downstream from operational domains.
Operational Domains
       ↓
Events / Read Models
       ↓
Reporting
       ↓
Reports / Dashboards / Exports
Rules:
Reporting never becomes the source of truth.
Complex reports should use reporting read models rather than expensive transactional queries.
Large exports run asynchronously.
Export authorization is separate from normal viewing permission.
Tenant isolation applies to every report.
Platform cross-tenant reports require explicit platform scope.
No full data warehouse is required for V1.

107. Configuration
Separate three concepts:
System Configuration
Platform-controlled technical/business defaults.
Tenant Configuration
School-specific settings.
Entitlement
Whether a capability is commercially available.
Feature Flag
Temporary technical rollout/control.
Therefore:
Feature Flag ≠ Entitlement ≠ Configuration
A school cannot gain a paid capability simply because a feature flag is enabled.
Feature flags are primarily an engineering/platform mechanism, not the commercial authorization system.

108. Observability
Use centralized structured observability.
Every important request/job/event carries:
request ID
correlation ID
tenant ID where applicable
actor ID where applicable
session ID where appropriate
operation name
duration
outcome
Three primary observability streams:
Logs
Metrics
Traces
Do not put sensitive authentication/payment information into telemetry.
Important metrics include:
API latency/error rate
authentication failures
job success/failure/retry
event delivery failures
notification failures
integration failures
payment failures
authorization failures
database health
storage health

109. Error Handling
Use standardized application errors internally and stable API errors externally.
Domain/Application Error
        ↓
Error Mapping Layer
        ↓
Stable API Error Contract
Clients should not receive:
SQL errors
stack traces
internal service details
authorization internals
secret/provider information
Expected errors include:
AUTHENTICATION_REQUIRED
TENANT_ACCESS_DENIED
PERMISSION_DENIED
ENTITLEMENT_REQUIRED
FEATURE_DISABLED
RESOURCE_NOT_FOUND
VALIDATION_ERROR
BUSINESS_RULE_VIOLATION
CONFLICT
SUBSCRIPTION_EXPIRED
SCHOOL_SUSPENDED
RATE_LIMITED
SYSTEM_ERROR

110. Idempotency
Idempotency is a platform-wide architectural capability.
Required for operations such as:
payments
payment webhooks
event consumers
external integrations
bulk operations
notification delivery
provisioning
important retryable commands
Where appropriate:
Idempotency Key
      ↓
Operation Record
      ↓
First execution → Result stored
      ↓
Duplicate → Original result / safe no-op

111. Concurrency
Use the simplest correct mechanism per domain:
optimistic versioning for ordinary administrative editing
unique constraints for uniqueness
transactions for atomic state changes
row locks for financial/resource allocation
state-transition validation for lifecycle operations
Examples requiring stronger concurrency controls:
payment allocation
receipt numbering
library copy issue
transport capacity
leave balance
subscription transitions
provisioning
other scarce-resource operations

112. Database Migration Strategy
MySQL remains the V1 source of truth.
Database changes use controlled migrations.
Rules:
schema changes are versioned
destructive migrations are carefully staged
application and schema compatibility considered during deployment
historical data is preserved where required
indexes/constraints are part of migration design
no runtime-generated schema changes
The domain/repository abstraction remains sufficient to permit a future persistence technology change without weakening the current relational model.

113. Deployment Architecture
V1 remains a modular monolith, deployable as multiple application instances when needed.
Flutter
   ↓
Load Balancer / API Gateway
   ↓
Node.js Express Instances
   ├── Application Modules
   └── Background Worker Processes
          ↓
       MySQL
          ↓
    Object Storage
API and workers share domain/application code but have different execution responsibilities.
No microservices are required initially.
The architecture allows later extraction of independently scalable modules where justified.

114. Multi-Tenant Isolation Strategy
V1:
Shared MySQL database + explicit tenant isolation.
Every tenant-owned entity has an explicit tenant boundary.
Tenant
 ↓
Domain Record
 ↓
Tenant-aware Repository
 ↓
Tenant-constrained Query
Additional safeguards:
tenant-aware foreign keys where practical
tenant-scoped unique constraints
repository enforcement
authorization enforcement
resource-level checks
tenant-aware cache/search/files/jobs
platform cross-tenant access explicitly declared
Future physical database/schema isolation can be introduced without changing the domain ownership model.

115. Backup & Recovery
V1 architecture requires:
automated database backups
tested restore procedures
object-storage durability/versioning strategy
recovery documentation
defined RPO/RTO targets before production launch
Exact infrastructure/provider choices do not need to be architectural decisions now.
The important architectural rule is:
Backup is not considered complete until restoration has been tested.

116. Security Baseline
The platform follows defense-in-depth:
Authentication
 ↓
Session Security
 ↓
Tenant Context
 ↓
Tenant Access
 ↓
Entitlement
 ↓
RBAC
 ↓
Scope
 ↓
Domain Authorization
 ↓
Tenant-aware Repository
 ↓
Database Constraints
No single layer is treated as sufficient by itself.

117. Architectural Dependency Rule
The final dependency rule is:
Platform Core
      ↓
Domain Modules
      ↓
Application Workflows
      ↓
Reporting / Integrations / Portal consumers
Domains:
cannot directly query another domain's tables
cannot directly modify another domain's data
communicate through contracts/interfaces/events/read models
may synchronously request authoritative information through application interfaces
may asynchronously react through events
Circular domain dependencies are prohibited.

118. Final Event Architecture
The complete event model is now:
Domain Transaction
       │
       ├── Business State
       │
       └── Outbox Record
                ↓
          Event Dispatcher
                ↓
       ┌────────┴────────┐
       ↓                 ↓
Internal Event     External Event
       ↓                 ↓
Internal Consumers  Integration Layer
Properties:
at-least-once delivery
idempotent consumers
per-aggregate ordering
parallelism across aggregates
operational retention is finite/configurable
business-significant history retained appropriately
internal and external contracts separated
external events versioned
tenant context included where applicable
correlation/causation information supported
failed events retryable
permanent failures recoverable/observable

Architecture Foundation Status
At this point, the major foundation is sufficiently defined to freeze the architecture.
Frozen V1 architecture
Flutter
   ↓
Express API
   ↓
Application Services
   ↓
Domain Modules
   ↓
Tenant-aware Repositories
   ↓
MySQL
Cross-cutting platform:
Identity / Authentication
Membership / RBAC
Tenant Management
Entitlements / Feature Management
Billing / Subscription
Audit / Security Events
Files
Notifications
Jobs
Events / Outbox
Search
Reporting
Integrations
Configuration
Observability
Core principles now fixed:
Modular monolith
Multi-tenant shared database
Strong tenant isolation
Server-authoritative authorization
Membership separate from identity
RBAC + scoped permissions
Entitlements separate from permissions
Domain ownership boundaries
No cross-domain database access
Strong consistency within domains
Asynchronous communication between domains
At-least-once events
Per-aggregate event ordering
Idempotent processing
Persistent background jobs
Centralized files/notifications/audit
Explicit workflows for long-running operations
Defense-in-depth authorization
Historical state preservation
Future extraction/isolation without prematurely adopting microservices
The architecture foundation is now ready to freeze.
The next phase should therefore stop asking broad infrastructure questions and move into the implementation-level technical specification, domain by domain, starting with the platform/core modules and then the business domains.
