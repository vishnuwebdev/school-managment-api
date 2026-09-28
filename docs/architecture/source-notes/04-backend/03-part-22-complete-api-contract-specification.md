<!-- Source: Apple Notes, folder 'BAckend' -->
# Part 22 — Complete API Contract Specification

This defines the single API standard for the entire platform. Every feature follows these conventions, so individual modules do not need separate API architecture decisions.
1. API Foundation
/api/v1
Standard structure:
/api/v1/{domain}/{resource}
Examples:
GET    /api/v1/students
POST   /api/v1/students
GET    /api/v1/students/:id
PATCH  /api/v1/students/:id
DELETE /api/v1/students/:id
Use REST for normal CRUD and workflow endpoints for business actions.

2. Authentication
POST /api/v1/auth/login
POST /api/v1/auth/logout
POST /api/v1/auth/refresh
POST /api/v1/auth/forgot-password
POST /api/v1/auth/reset-password
POST /api/v1/auth/change-password
POST /api/v1/auth/mfa/verify
GET  /api/v1/auth/me
Authentication establishes:
user_id
tenant_id
membership
roles
permissions
entitlements

3. Tenant & School
GET   /tenants/current
PATCH /tenants/current
GET   /tenants/current/settings
PATCH /tenants/current/settings

GET   /campuses
POST  /campuses
GET   /campuses/:id
PATCH /campuses/:id

GET   /academic-years
POST  /academic-years
GET   /academic-years/:id
PATCH /academic-years/:id

GET   /academic-terms
POST  /academic-terms
PATCH /academic-terms/:id

4. Users, Roles & Permissions
GET   /users
POST  /users
GET   /users/:id
PATCH /users/:id

GET   /roles
POST  /roles
PATCH /roles/:id

GET   /permissions

POST  /users/:id/roles
DELETE /users/:id/roles/:roleId
Permissions are checked server-side for every protected operation.

5. Students
GET   /students
POST  /students
GET   /students/:id
PATCH /students/:id
DELETE /students/:id

GET   /students/:id/guardians
POST  /students/:id/guardians
PATCH /students/:id/guardians/:guardianId

GET   /students/:id/enrollments
POST  /students/:id/enrollments

GET   /students/:id/documents
POST  /students/:id/documents

GET   /students/:id/history
Student creation should be transactional when enrollment/class assignment is included.

6. Academic Structure
GET   /classes
POST  /classes
PATCH /classes/:id

GET   /sections
POST  /sections
PATCH /sections/:id

GET   /subjects
POST  /subjects
PATCH /subjects/:id

POST  /classes/:id/subjects
DELETE /classes/:id/subjects/:subjectId

7. Teachers & HR
Teachers
GET   /teachers
POST  /teachers
GET   /teachers/:id
PATCH /teachers/:id

GET   /teachers/:id/subjects
GET   /teachers/:id/classes
GET   /teachers/:id/availability
HR
GET   /staff
POST  /staff
GET   /staff/:id
PATCH /staff/:id

GET   /staff/:id/employment
GET   /staff/:id/documents

POST  /staff/:id/onboarding
POST  /staff/:id/offboarding

8. Attendance
GET  /attendance/sessions
POST /attendance/sessions

GET  /attendance/sessions/:id
POST /attendance/sessions/:id/records

PATCH /attendance/records/:id

GET  /attendance/students/:studentId
GET  /attendance/sections/:sectionId
Correction workflow:
POST  /attendance/corrections
GET   /attendance/corrections
POST  /attendance/corrections/:id/approve
POST  /attendance/corrections/:id/reject
Portal users create correction requests rather than directly changing records.

9. Examinations & Results
GET   /examinations
POST  /examinations
GET   /examinations/:id
PATCH /examinations/:id

POST  /examinations/:id/subjects
POST  /examinations/:id/schedule

POST  /assessments/:id/marks
PATCH /assessment-marks/:id

GET   /students/:studentId/results
GET   /examinations/:id/results

POST  /examinations/:id/publish
POST  /examinations/:id/unpublish
Published results require elevated permission.

10. Fees
GET  /fee-structures
POST /fee-structures
GET  /fee-structures/:id
PATCH /fee-structures/:id

POST /fee-assignments
GET  /students/:studentId/fees

GET  /invoices
POST /invoices
GET  /invoices/:id

POST /payments
GET  /payments/:id

POST /payments/:id/refund
GET  /receipts/:id
Payment flow:
POST /payments
      ↓
Payment Intent
      ↓
Payment Provider
      ↓
Webhook
      ↓
Payment Confirmation
      ↓
Allocation
      ↓
Receipt
The browser is never the authoritative source for successful payment.

11. Payment Webhooks
Provider callbacks:
POST /webhooks/payments/:provider
Webhook processing must be:
authenticated
idempotent
transaction-safe
auditable
Duplicate webhook delivery must not create duplicate payments.

12. Timetable
GET   /periods
POST  /periods
PATCH /periods/:id

GET   /timetables
POST  /timetables

POST  /timetables/:id/entries
PATCH /timetable-entries/:id
DELETE /timetable-entries/:id

POST  /timetables/:id/publish
Published timetable versions remain historically accessible.

13. Leave
GET  /leave/types
POST /leave/types

GET  /leave/balances
GET  /leave/requests
POST /leave/requests

GET  /leave/requests/:id
POST /leave/requests/:id/approve
POST /leave/requests/:id/reject
POST /leave/requests/:id/cancel

14. Communication
GET  /notifications
GET  /notifications/:id
POST /notifications/:id/read
POST /notifications/read-all

GET   /announcements
POST  /announcements
GET   /announcements/:id
PATCH /announcements/:id
POST  /announcements/:id/publish
Bulk communication:
POST /communications/messages
The communication service determines delivery channels and tracks delivery status.

15. Files & Documents
POST /files/upload-request
POST /files/:id/complete
GET  /files/:id
GET  /files/:id/download
DELETE /files/:id
Upload:
1. Request upload
2. Authorization
3. Signed URL
4. Object storage upload
5. Scan/process
6. File becomes AVAILABLE
Business document APIs reference the file rather than handling storage directly.

16. Library
GET  /library/titles
POST /library/titles
GET  /library/titles/:id
PATCH /library/titles/:id

GET  /library/copies
POST /library/copies

POST /library/loans
POST /library/loans/:id/return

POST /library/reservations
DELETE /library/reservations/:id

GET  /library/fines
POST /library/fines/:id/waive

17. Transport
GET  /transport/routes
POST /transport/routes
PATCH /transport/routes/:id

GET  /transport/stops
POST /transport/stops

GET  /transport/vehicles
POST /transport/vehicles
PATCH /transport/vehicles/:id

GET  /transport/drivers
POST /transport/drivers

POST /transport/student-assignments
PATCH /transport/student-assignments/:id

GET  /transport/trips
POST /transport/trips
POST /transport/trips/:id/boarding

18. Inventory & Assets
Inventory
GET  /inventory/items
POST /inventory/items
PATCH /inventory/items/:id

GET  /inventory/stores
POST /inventory/stores

POST /inventory/receipts
POST /inventory/issues
POST /inventory/returns
POST /inventory/transfers
POST /inventory/adjustments

GET  /inventory/stock
POST /inventory/stock-counts
Assets
GET  /assets
POST /assets
GET  /assets/:id
PATCH /assets/:id

POST /assets/:id/assign
POST /assets/:id/return
POST /assets/:id/maintenance
POST /assets/:id/dispose
Stock movement remains authoritative for inventory quantities.

19. Calendar & Events
GET  /calendars
POST /calendars

GET  /calendar-days
GET  /holidays
POST /holidays

GET  /events
POST /events
GET  /events/:id
PATCH /events/:id

POST /events/:id/publish
POST /events/:id/cancel

POST /events/:id/register
DELETE /events/:id/register

20. Portal API
Portal APIs are experience-oriented but call the underlying domain services.
GET /portal/dashboard
GET /portal/profile
PATCH /portal/profile

GET /portal/students
GET /portal/students/:id

GET /portal/students/:id/attendance
GET /portal/students/:id/results
GET /portal/students/:id/fees
GET /portal/students/:id/library
GET /portal/students/:id/transport

GET  /portal/notifications
GET  /portal/calendar

POST /portal/attendance-corrections
POST /portal/fees/payments
POST /portal/events/:id/register
Every student ID must be checked against the authenticated guardian/student relationship.

21. Standard List Response
{
  "data": [],
  "meta": {
    "page": 1,
    "page_size": 25,
    "total": 120
  }
}
For cursor pagination:
{
  "data": [],
  "meta": {
    "next_cursor": "..."
  }
}

22. Standard Single Resource Response
{
  "data": {
    "id": "...",
    "name": "...",
    "status": "ACTIVE"
  }
}

23. Standard Error Contract
{
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "You do not have permission to perform this operation",
    "details": null,
    "request_id": "..."
  }
}
Common codes:
AUTHENTICATION_REQUIRED
INVALID_TOKEN
PERMISSION_DENIED
FEATURE_NOT_ENABLED
TENANT_NOT_FOUND
RESOURCE_NOT_FOUND
VALIDATION_ERROR
DUPLICATE_RESOURCE
CONFLICT
INVALID_STATE
OPERATION_NOT_ALLOWED
RATE_LIMITED
EXTERNAL_SERVICE_ERROR
INTERNAL_ERROR
Domain-specific errors use stable prefixes:
STUDENT_NOT_FOUND
FEE_ALREADY_PAID
ATTENDANCE_ALREADY_SUBMITTED
BOOK_ALREADY_LOANED
INSUFFICIENT_STOCK
TRANSPORT_CAPACITY_EXCEEDED
RESULT_ALREADY_PUBLISHED

24. Standard Query Parameters
All suitable collection APIs support:
?page=1
&page_size=25
&search=
&sort=
&order=asc
&status=
Domain-specific filters are added as needed:
/students?class_id=...&status=ACTIVE
/attendance?date_from=...&date_to=...
/fees?status=OVERDUE

25. API Security Pipeline
Every protected request follows:
Request
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
This ordering becomes the standard across the platform.

26. API Idempotency
Required for operations where retries can cause duplication:
payments
webhooks
bulk operations
imports
notifications
stock operations
event processing
Use:
Idempotency-Key
where appropriate.

27. API Versioning
Current:
/api/v1
Breaking changes create:
/api/v2
Do not silently change the meaning of an existing endpoint.

28. OpenAPI
Generate a complete OpenAPI specification from the API contracts.
It should document:
endpoints
authentication
request schemas
response schemas
errors
permissions
pagination
examples
The OpenAPI document becomes the shared contract between backend, web, Flutter, QA, and external integrations.

29. Event Contracts
API operations that change important business state emit versioned events.
Example:
{
  "event_id": "...",
  "event_type": "student.created",
  "version": 1,
  "tenant_id": "...",
  "occurred_at": "...",
  "actor_id": "...",
  "data": {
    "student_id": "..."
  }
}
Examples:
student.created
student.enrolled
student.status_changed

attendance.marked
attendance.corrected

exam.created
result.published

fee.invoice.created
payment.completed
payment.refunded

leave.approved

library.book.issued
library.book.returned

transport.assignment.changed

inventory.stock.changed
asset.assigned

staff.onboarded
staff.offboarded

event.published
notification.sent

30. API Implementation Rule
For every endpoint, implementation follows:
Route
 ↓
Controller
 ↓
Request DTO
 ↓
Validation
 ↓
Authorization
 ↓
Application Service
 ↓
Domain Rules
 ↓
Transaction
 ↓
Repository
 ↓
Event / Outbox
 ↓
Response DTO
No endpoint should bypass this pattern without a documented architectural reason.

31. Complete Platform Flow
The resulting system is now:
                 ┌───────────────┐
                 │ Flutter / Web │
                 └───────┬───────┘
                         │
                    REST API
                         │
              ┌──────────▼──────────┐
              │ Authentication       │
              │ Tenant Context       │
              │ Authorization        │
              │ Entitlements         │
              └──────────┬──────────┘
                         │
                 Application Layer
                         │
        ┌────────────────┼────────────────┐
        │                │                │
     Students         Academics         Finance
        │                │                │
     Attendance       Exams/Results      Fees
        │                │                │
     Transport        Timetable        Payments
        │                │                │
     Library            HR             Billing
        └────────────────┼────────────────┘
                         │
                Shared Infrastructure
        ┌──────────┬──────┼──────┬──────────┐
        │          │      │      │          │
      MySQL      Redis  Events  Files   Notifications
Implementation contract now established
We have now standardized, in one pass:
Database architecture
ERD/domain ownership
Multi-tenancy
API structure
DTO conventions
Validation
Authorization
Entitlements
Transactions
Events
Background jobs
Files
Notifications
Errors
Pagination
Security
Flutter integration
Next step: Part 23 — Backend Foundation & Project Skeleton, where the actual Express/TypeScript project structure, modules, middleware, configuration, database layer, authentication foundation, error handling, event/outbox infrastructure, and testing foundation are defined once for the entire platform.
