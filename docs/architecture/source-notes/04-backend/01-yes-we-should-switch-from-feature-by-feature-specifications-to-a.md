<!-- Source: Apple Notes, folder 'BAckend' -->
# Yes. We should switch from feature-by-feature specifications to a…

Part 20 — Master Implementation Blueprint
1. Scope
This blueprint applies to all modules already designed:
Identity & Authentication
Tenant / School Management
Plans, Subscriptions & Entitlements
Platform Billing
Students
Academics
Teachers
Attendance
Examinations & Results
Fees
Timetable
Leave & Availability
Communication
Files & Documents
Library
Transport
Inventory & Assets
HR
Calendar & Events
Parent / Student Portal
No separate architecture decisions should be required for each module unless a genuinely domain-specific exception exists.

2. Repository Structure
school-management/
├── apps/
│   ├── api/                    # Express backend
│   ├── web/                    # Admin web application
│   └── mobile/                 # Flutter application
│
├── packages/
│   ├── contracts/              # API/event contracts
│   ├── database/               # DB client, migrations
│   ├── auth/                   # authentication
│   ├── authorization/          # RBAC + permissions
│   ├── tenancy/                # tenant context
│   ├── files/                  # object storage
│   ├── notifications/          # email/SMS/push
│   ├── events/                 # domain events/outbox
│   └── shared/                 # common primitives
│
├── infrastructure/
│   ├── docker/
│   ├── nginx/
│   ├── monitoring/
│   └── deployment/
│
└── docs/
    ├── architecture/
    ├── api/
    ├── database/
    └── operations/

3. Backend Architecture
Use the same structure for every business domain:
HTTP Request
    ↓
Middleware
    ↓
Controller
    ↓
Application Service
    ↓
Domain Logic
    ↓
Repository Interface
    ↓
Repository Implementation
    ↓
MySQL
Each module follows:
modules/
└── students/
    ├── domain/
    ├── application/
    ├── infrastructure/
    ├── presentation/
    └── index.ts
Responsibilities
￼
Controllers must not contain business logic.

4. Technology Baseline
Backend
Node.js
TypeScript
Express
MySQL
Prisma
Redis
BullMQ
Zod
JWT/session-based authentication
S3-compatible object storage
Flutter
Flutter
Dart
Riverpod
go_router
Dio
Freezed
json_serializable
Infrastructure
Docker
Nginx/API gateway
MySQL
Redis
Object storage
Background workers
Centralized logging
Error monitoring

5. Multi-Tenant Architecture
Every tenant-owned request must establish:
User
 ↓
Identity
 ↓
Tenant Membership
 ↓
Tenant Context
 ↓
Authorization
 ↓
Business Operation
Every tenant-owned table contains:
tenant_id
Repositories automatically enforce tenant scope.
Never trust:
tenant_id
coming directly from the client.
It must come from the authenticated tenant context.

6. Authorization Model
Use three layers:
Authentication
      ↓
Role / Permission
      ↓
Entitlement
Example:
Can user perform "fees.payment.create"?
        ↓
Does user's role have permission?
        ↓
Is the feature enabled for this tenant?
        ↓
Allow / Deny
Use permissions rather than hard-coded role checks:
students.read
students.create
students.update

fees.read
fees.create
fees.payment.create

attendance.read
attendance.mark
attendance.correction.approve
UI visibility is never considered authorization.

7. Database Standards
All tables follow consistent conventions.
Primary keys
Use UUID/UUIDv7 identifiers.
Common fields
id
tenant_id
created_at
updated_at
created_by
updated_by
Where appropriate:
deleted_at
version
status
Rules
Foreign keys enforced.
Unique constraints enforced at DB level.
Tenant-aware unique indexes.
Appropriate composite indexes.
UTC timestamps.
Money stored as integer minor units.
Never use floating point for financial amounts.
Historical business records are preserved.
Avoid unnecessary soft deletion.

8. Standard API
Base path:
/api/v1
Examples:
/api/v1/students
/api/v1/teachers
/api/v1/attendance
/api/v1/examinations
/api/v1/fees
/api/v1/library
/api/v1/transport
/api/v1/inventory
/api/v1/hr
/api/v1/events
/api/v1/portal
Response
{
  "data": {},
  "meta": {}
}
Error
{
  "error": {
    "code": "STUDENT_NOT_FOUND",
    "message": "Student was not found",
    "details": {}
  }
}
Errors use stable machine-readable codes.

9. Pagination
Standardize list APIs:
?page=1&page_size=25
For very large/high-volume datasets, use cursor pagination.
All list APIs should support where appropriate:
search
filter
sort
pagination
Example:
GET /students?status=active&search=rahul&page=1&page_size=25

10. Validation
All external input is validated before reaching application services.
Use schemas such as:
CreateStudentSchema
UpdateStudentSchema
CreateFeeStructureSchema
MarkAttendanceSchema
CreateExamSchema
Validation occurs at the API boundary.
Domain rules are still validated inside the application/domain layer.

11. Transactions & Concurrency
Use database transactions for operations that modify multiple related records.
Examples:
Fee payment
Payment
 → Allocation
 → Receipt
 → Ledger
 → Outbox Event
Attendance submission
Attendance
 → Summary
 → Audit
 → Outbox Event
Inventory issue
Stock Movement
 → Balance Update
 → Validation
 → Audit
Enrollment
Student enrollment
 → class assignment
 → section assignment
 → related records
Use optimistic locking/versioning or row locks where required.

12. Event Architecture
Use the Outbox Pattern.
Business Transaction
       ↓
Database transaction
       ↓
Business records + Outbox event
       ↓
Worker
       ↓
Event consumers
Example:
StudentCreated
FeePaymentCompleted
AttendanceMarked
ExamPublished
LeaveApproved
DocumentUploaded
TransportAssignmentChanged
StaffOffboarded
EventPublished
Events must be:
tenant-scoped
versioned
idempotent
traceable

13. Background Jobs
Use Redis + BullMQ for:
Email
SMS
Push notifications
Report generation
File processing
Document scanning
Recurring fee operations
Reminder notifications
Event reminders
Data exports
Scheduled academic operations
Jobs must be idempotent.

14. File Architecture
All modules use the central File Management service.
Business Module
      ↓
File Service
      ↓
Object Storage
Never store large binaries in MySQL.
Use:
short-lived signed upload URL
short-lived signed download URL
All downloads require authorization before generating the URL.

15. Notifications
Central notification service:
Domain Event
      ↓
Notification Service
      ↓
Email / SMS / Push / In-App
Templates should support:
tenant
language
event type
recipient
variables
Business modules should not directly implement SMS/email delivery.

16. Audit Logging
Audit sensitive operations across the entire platform.
Record:
tenant
actor
action
entity
entity_id
timestamp
before
after
IP/device where appropriate
request_id
Examples:
STUDENT_UPDATED
FEE_PAYMENT_CREATED
RESULT_PUBLISHED
ATTENDANCE_CORRECTED
DOCUMENT_DOWNLOADED
STAFF_OFFBOARDED
PERMISSION_CHANGED

17. Observability
Every request gets:
request_id
Logs should include:
request_id
tenant_id
user_id
module
operation
duration
result
error
Monitor:
API errors
slow queries
failed jobs
queue depth
database health
storage failures
external provider failures

18. Caching
Use Redis selectively.
Good candidates:
permissions
entitlements
school configuration
reference data
frequently accessed dashboard data
published calendar information
Do not make Redis the source of truth.
MySQL remains authoritative.

19. Search
Start with MySQL search/indexing.
Search should support fields appropriate to each domain:
students → name, admission number
staff → name, employee number
books → title, ISBN
assets → asset number
inventory → item name/code
Introduce Elasticsearch/OpenSearch only if actual scale requires it.

20. Flutter Architecture
Use feature-first architecture:
lib/
├── core/
│   ├── networking/
│   ├── auth/
│   ├── routing/
│   ├── permissions/
│   ├── storage/
│   └── theme/
│
├── features/
│   ├── dashboard/
│   ├── students/
│   ├── attendance/
│   ├── academics/
│   ├── fees/
│   ├── library/
│   ├── transport/
│   ├── notifications/
│   └── portal/
│
└── shared/
    ├── widgets/
    ├── models/
    └── utils/
Each feature:
presentation/
application/
domain/
data/
Use Riverpod for state management and dependency injection.

21. Flutter Navigation & Security
Use route guards for:
authentication
tenant selection
permission
entitlement
persona
But server-side authorization remains authoritative.
Support personas such as:
Platform Admin
School Admin
Teacher
Staff
Parent
Student

22. UI Design System
Create one shared design system:
Colors
Typography
Spacing
Radius
Elevation
Icons
Buttons
Inputs
Tables
Dialogs
Cards
Tabs
Navigation
Empty states
Loading states
Error states
Every feature consumes these shared components.
No feature-specific visual system unless genuinely necessary.

23. Testing Strategy
Unit tests
Business/domain rules.
Integration tests
API + MySQL
API + Redis
API + Object Storage
Contract tests
Validate:
Frontend ↔ API
API ↔ Events
API ↔ External providers
E2E tests
Critical workflows:
Login
Create school
Create student
Enroll student
Mark attendance
Create examination
Publish result
Generate fee
Make payment
Issue library book
Assign transport
Manage staff
Portal access

24. Security Baseline
Mandatory:
Password hashing
MFA support
Secure session/token handling
Rate limiting
Request validation
SQL injection protection
XSS protection
CSRF protection where applicable
Secure headers
Encryption in transit
Secrets outside source control
Tenant isolation
Permission checks
Signed file URLs
Audit logging
Backup and recovery
Dependency vulnerability scanning
Never expose internal database IDs or sensitive data unnecessarily.

25. Deployment Environments
Use:
Development
     ↓
Staging
     ↓
Production
Production should have:
API
Worker
MySQL
Redis
Object Storage
Reverse Proxy
Monitoring
Backup
API and workers should be independently scalable.

26. Backup & Recovery
MySQL:
automated backups
point-in-time recovery where available
tested restoration
Object storage:
versioning where appropriate
backup/replication policy
Critical requirement:
A backup that has never been restored successfully is not considered a verified backup.

27. Domain Dependency Rules
The dependency direction should remain:
Platform
   ↓
Identity / Tenant / Billing / Shared Infrastructure
   ↓
Core School Data
   ↓
Operational Modules
   ↓
Portal / Reporting / Experience
Important ownership boundaries:
Student → student identity/enrollment
HR → employment
Teacher → teaching capability
Fees → financial obligations/payments
Library → circulation
Transport → transportation
Inventory → stock/assets
Calendar → school temporal context
Communication → message delivery
Files → physical file management
Portal → user experience/orchestration
No module should directly modify another module's tables.

28. Implementation Order
The entire system should now be implemented in this order:
1. Repository / infrastructure foundation
2. Database conventions + migrations
3. Identity + authentication
4. Tenant management
5. Authorization + entitlements
6. Shared services
   ├── files
   ├── notifications
   ├── events
   ├── audit
   └── jobs
7. Core school modules
8. Academic modules
9. Operational modules
10. Billing / financial workflows
11. Portal
12. Reporting
13. Flutter/mobile experience
14. Testing
15. Deployment

29. Definition of Done for Every Feature
A feature is not complete until it has:
✓ Domain model
✓ Database tables
✓ Migrations
✓ Constraints/indexes
✓ Repository
✓ Application service
✓ API endpoints
✓ DTOs
✓ Validation
✓ Authorization
✓ Tenant isolation
✓ Audit events
✓ Domain events where required
✓ Background jobs where required
✓ Error codes
✓ Unit tests
✓ Integration tests
✓ API documentation
✓ Flutter/web UI
✓ Loading/error/empty states
✓ Permission handling
✓ Entitlement handling
This becomes the single checklist for every feature, so we do not need to repeat the architecture discussion for each module.

30. Next Step
With this blueprint established, the next major artifact should be the complete database/ERD specification for the entire platform in one pass:
Master Blueprint
       ↓
Complete Database Schema / ERD
       ↓
API Contract Specification
       ↓
Backend Foundation
       ↓
Module Implementation
The database specification should cover all modules together, including tables, columns, relationships, indexes, constraints, enums, tenant isolation, audit fields, and migration conventions.
