<!-- Source: Apple Notes, folder 'BAckend' -->
# Part 23 — Backend Foundation & Project Skeleton

This establishes the actual backend foundation once, so every feature can be implemented on top of the same structure.
1. Backend Stack
Node.js
TypeScript
Express
MySQL
Prisma
Redis
BullMQ
Zod
JWT + refresh sessions
OpenAPI

2. Project Structure
apps/api/
├── src/
│   ├── app.ts
│   ├── server.ts
│   │
│   ├── config/
│   │   ├── env.ts
│   │   ├── database.ts
│   │   ├── redis.ts
│   │   └── storage.ts
│   │
│   ├── middleware/
│   │   ├── request-id.ts
│   │   ├── authentication.ts
│   │   ├── tenant-context.ts
│   │   ├── authorization.ts
│   │   ├── entitlement.ts
│   │   ├── validation.ts
│   │   ├── rate-limit.ts
│   │   └── error-handler.ts
│   │
│   ├── shared/
│   │   ├── errors/
│   │   ├── pagination/
│   │   ├── result/
│   │   ├── constants/
│   │   └── types/
│   │
│   ├── infrastructure/
│   │   ├── database/
│   │   ├── redis/
│   │   ├── queue/
│   │   ├── storage/
│   │   ├── mail/
│   │   ├── sms/
│   │   └── push/
│   │
│   ├── events/
│   │   ├── event-bus.ts
│   │   ├── outbox.ts
│   │   └── handlers/
│   │
│   ├── jobs/
│   │   ├── worker.ts
│   │   └── processors/
│   │
│   └── modules/
│       ├── identity/
│       ├── tenants/
│       ├── billing/
│       ├── students/
│       ├── academics/
│       ├── teachers/
│       ├── attendance/
│       ├── examinations/
│       ├── fees/
│       ├── timetable/
│       ├── leave/
│       ├── communication/
│       ├── files/
│       ├── library/
│       ├── transport/
│       ├── inventory/
│       ├── hr/
│       ├── calendar/
│       └── portal/
│
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/
│
└── package.json

3. Module Structure
Every domain uses the same pattern:
students/
├── domain/
│   ├── entities/
│   ├── value-objects/
│   ├── rules/
│   └── events/
│
├── application/
│   ├── commands/
│   ├── queries/
│   └── services/
│
├── infrastructure/
│   ├── repositories/
│   └── mappers/
│
├── presentation/
│   ├── controllers/
│   ├── dto/
│   └── routes/
│
└── index.ts
This structure is repeated for every domain.

4. Application Layer
Commands represent state changes:
CreateStudent
UpdateStudent
EnrollStudent
MarkAttendance
CreateInvoice
RecordPayment
PublishResult
IssueLibraryBook
AssignTransport
Queries represent reads:
GetStudent
ListStudents
GetAttendance
GetStudentFees
GetExamResults
GetDashboard
This separation keeps business operations predictable.

5. Request Lifecycle
Every request follows:
HTTP
 ↓
Request ID
 ↓
Rate Limit
 ↓
Authentication
 ↓
Tenant Context
 ↓
Permission
 ↓
Entitlement
 ↓
Validation
 ↓
Controller
 ↓
Application Service
 ↓
Transaction
 ↓
Repository
 ↓
Outbox
 ↓
Response
No module should bypass this pipeline.

6. Tenant Context
After authentication:
context = {
  userId,
  tenantId,
  membershipId,
  roles,
  permissions,
  entitlements
}
Application services receive tenant context from the authenticated request.
They should never trust a client-provided tenant ID.

7. Authentication Foundation
Use:
Access Token
+
Refresh Session
Access tokens should be short-lived.
Refresh sessions should be:
revocable
device-aware
auditable
securely stored
Authentication supports:
password
MFA
password reset
session management
logout

8. Authorization Foundation
Central authorization service:
authorize(
    user,
    tenant,
    permission,
    resource
)
Examples:
students.read
students.create
students.update

attendance.mark
attendance.correct

fees.read
fees.payment.create

results.publish

staff.update
Resource-level checks are supported where required.
Example:
Parent → only their linked students
Teacher → assigned classes
School Admin → tenant-wide

9. Entitlement Foundation
Feature access is evaluated separately:
hasPermission(user, permission)
AND
hasEntitlement(tenant, feature)
Never write:
if plan === "PREMIUM"
Instead:
if entitlementService.enabled(
    tenant,
    "transport"
)
This keeps plans configurable.

10. Error System
Create a central error hierarchy:
AppError
├── ValidationError
├── AuthenticationError
├── AuthorizationError
├── NotFoundError
├── ConflictError
├── BusinessRuleError
├── ExternalServiceError
└── InfrastructureError
Every error maps to:
HTTP status
error code
message
details
request ID

11. Database Layer
Prisma is the persistence implementation.
Repositories expose domain-level interfaces:
StudentRepository
FeeRepository
AttendanceRepository
TeacherRepository
Domain/application code depends on the interface, not Prisma directly.
Application
    ↓
Repository Interface
    ↓
Prisma Repository
    ↓
MySQL

12. Transaction Manager
Central transaction abstraction:
transaction(async tx => {
    ...
})
Used for:
enrollment
payment
stock operations
attendance submission
result publication
leave approval
library checkout
transport assignment

13. Outbox
Every important domain event is written inside the same DB transaction.
Transaction
 ├── Business Data
 └── Outbox Event
A worker then publishes/processes the event.
This prevents:
database succeeded
BUT
event was lost

14. Queue Architecture
API
 ↓
Redis / BullMQ
 ↓
Worker
 ↓
Processor
Queues:
email
sms
push
notifications
files
reports
exports
imports
events
scheduled-jobs
Each job includes:
job_id
tenant_id
payload
attempt
created_at

15. Scheduled Jobs
Examples:
Generate recurring invoices
Send fee reminders
Send event reminders
Process expired files
Process pending notifications
Generate reports
Clean expired sessions
All scheduled jobs are tenant-aware and idempotent.

16. Configuration
Environment variables:
NODE_ENV
PORT

DATABASE_URL

REDIS_URL

JWT_SECRET
JWT_ACCESS_TTL
JWT_REFRESH_TTL

STORAGE_ENDPOINT
STORAGE_BUCKET
STORAGE_ACCESS_KEY
STORAGE_SECRET_KEY

EMAIL_PROVIDER_KEY
SMS_PROVIDER_KEY
PUSH_PROVIDER_KEY

PAYMENT_PROVIDER_KEY
Secrets never belong in source control.

17. API Documentation
Generate OpenAPI from the API contracts.
Expose documentation only according to environment/security requirements.
/api/v1/...
/docs
/openapi.json
The OpenAPI definition becomes the contract consumed by:
Flutter
Web
QA
external integrations

18. Logging
Use structured JSON logs.
Example:
{
  "level": "info",
  "request_id": "...",
  "tenant_id": "...",
  "user_id": "...",
  "module": "students",
  "operation": "create",
  "duration_ms": 42
}
Never log:
passwords
access tokens
refresh tokens
payment secrets
sensitive personal data unnecessarily

19. Testing Foundation
Unit
domain rules
services
validators
authorization
Integration
API
MySQL
Redis
repositories
transactions
E2E
login
student creation
enrollment
attendance
fees
payment
results
portal
Tests must verify tenant isolation explicitly.

20. Health Checks
Provide:
GET /health
GET /health/live
GET /health/ready
Readiness checks:
MySQL
Redis
required infrastructure
Liveness should remain lightweight.

21. Graceful Shutdown
On shutdown:
Stop accepting requests
 ↓
Finish active requests
 ↓
Stop workers
 ↓
Close Redis
 ↓
Close DB
 ↓
Exit
This prevents partially processed operations.

22. CI Pipeline
Every pull request:
Install
 ↓
Lint
 ↓
Type Check
 ↓
Unit Tests
 ↓
Integration Tests
 ↓
Build
 ↓
Migration Validation
 ↓
Security Scan
Production deployment additionally requires:
Database migration
 ↓
Deploy API
 ↓
Deploy workers
 ↓
Health check
 ↓
Smoke test

23. Backend Foundation Definition of Done
The foundation is complete when:
✓ Express application
✓ TypeScript
✓ Environment configuration
✓ Prisma/MySQL
✓ Redis
✓ Authentication
✓ Tenant context
✓ Authorization
✓ Entitlements
✓ Validation
✓ Error handling
✓ Logging
✓ Request IDs
✓ Rate limiting
✓ Transactions
✓ Outbox
✓ Event processing
✓ BullMQ workers
✓ File infrastructure
✓ Notification infrastructure
✓ OpenAPI
✓ Health checks
✓ Graceful shutdown
✓ Unit testing
✓ Integration testing
✓ E2E framework
✓ CI pipeline
Implementation sequence from here
Part 23  Backend Foundation          ← current
   ↓
Part 24  Identity + Tenant + Access
   ↓
Part 25  Shared Platform Services
   ↓
Part 26  All Business Modules
   ↓
Part 27  Flutter Architecture
   ↓
Part 28  Testing & QA
   ↓
Part 29  Deployment & DevOps
The next part should therefore consolidate Identity, Tenant Management, RBAC, Permissions, and Entitlements into the first production-ready core module, before implementing the business domains.
