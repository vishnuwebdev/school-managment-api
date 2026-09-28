<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 19

Parent / Student Portal & Self-Service
The Portal should be treated primarily as an access and experience layer, not as a new source of business data.
The core rule is:
Portal User
    ↓
Identity
    ↓
Membership / Relationship
    ↓
Authorization
    ↓
Existing Domain APIs
It should not duplicate Student, Teacher, Fee, Attendance, Examination, Library, Transport, or Communication data as authoritative records.

802. Portal Boundary
The Portal owns:
portal access
guardian/student self-service context
portal preferences
dashboard composition
self-service actions
consent where applicable
portal-specific notification state
portal navigation/deep links
It does not own:
student identity
guardian identity
fees
marks
attendance
library loans
transport assignments
leave
academic enrollment
Those remain owned by their respective domains.

803. Portal Personas
Initial portal personas:
Student
Parent / Guardian
A guardian may be associated with multiple students.
A student normally accesses only their own permitted information.

804. Guardian Relationship
Student Management already owns:
student_guardians
Therefore Portal should not create a second parent-student relationship.
Portal resolves access through:
User
 ↓
Guardian User
 ↓
Student Guardian Relationship
 ↓
Student

805. Guardian Access Rules
The existing relationship controls capabilities such as:
portal_access_allowed
A guardian can access a student only when:
Authenticated
AND
Guardian relationship active
AND
portal_access_allowed = true
AND
Student tenant matches
AND
Required permission exists

806. Multi-Student Guardian
A single guardian may have:
Guardian User
 ├── Student A
 ├── Student B
 └── Student C
Portal context should therefore support:
current_student_id
The server validates that the guardian actually has access to that student.
The client must never be trusted merely because it supplied the student ID.

807. Student Portal Context
Student context:
User
 ↓
Student
 ↓
Current Enrollment
 ↓
Tenant
A student can only access records permitted for their own identity/enrollment.

808. Portal Permissions
Initial permissions:
portal.access

portal.student.view

portal.attendance.view
portal.attendance.request_correction

portal.result.view

portal.fee.view
portal.fee.pay

portal.library.view

portal.transport.view

portal.calendar.view

portal.notification.view

portal.profile.view
portal.profile.update

portal.document.view
portal.document.upload

portal.event.view
portal.event.register
Portal permissions remain subject to the underlying domain's authorization rules.

809. Read Access Pattern
The portal should use application services rather than direct database access.
Portal Controller
      ↓
Portal Application Service
      ↓
Domain Application Interface
      ↓
Domain Repository
Do not create portal-specific copies of every domain table.

810. Dashboard
Initial dashboard sections:
Student/Guardian Summary
Upcoming Events
Attendance Summary
Latest Results
Fee Balance
Library Due Items
Transport Information
Recent Notifications
Important Announcements
Only sections for enabled features should appear.
However:
UI hiding is not authorization.
Every underlying API still performs authorization and entitlement checks.

811. Dashboard Aggregation
Dashboard data may come from multiple domains.
Do not make one huge synchronous transaction.
Use a dashboard application service:
DashboardService
 ├── Student
 ├── Attendance
 ├── Results
 ├── Fees
 ├── Library
 ├── Transport
 ├── Calendar
 └── Communication
Each section can fail independently where appropriate.

812. Dashboard Performance
For high-traffic portal dashboards, use read models/cache rather than repeatedly executing expensive cross-domain queries.
Example:
Student Dashboard Read Model
can be updated from domain events.
The read model is never the source of truth.

813. Profile
Portal profile should distinguish:
Identity-controlled fields
Student/Guardian-owned fields
Admin-controlled fields
For example, a student should not directly modify:
student number
admission number
enrollment
class
section
lifecycle status

814. Self-Service Profile Update
Editable fields should be explicitly configured.
Example:
phone
email
address
preferred name
A change to sensitive identity information may require verification.

815. Profile Change Workflow
For verified contact information:
Update Request
 ↓
Verification
 ↓
Apply Change
 ↓
Audit
Do not immediately trust a newly supplied email or phone number.

816. Attendance Portal
Guardian/student can view:
Attendance summary
Attendance by date
Attendance by subject
Absence reasons where permitted
Portal must consume Attendance APIs/read models.
It must never update attendance directly.

817. Attendance Correction Request
If enabled:
Portal
 ↓
Attendance Correction Request
 ↓
Attendance Domain
 ↓
Review
 ↓
Approved / Rejected
The portal does not alter the attendance record.

818. Examination Results
Portal can expose:
Assessment
Subject
Marks
Grade
Percentage
Result status
Published date
Only PUBLISHED results should normally be visible.
Draft/withheld/internal results remain inaccessible unless explicitly permitted.

819. Result Publication Boundary
Mark Entry
 ↓
Calculation
 ↓
Review
 ↓
Publication
 ↓
Portal visibility
Publication remains owned by Examination & Results.
Portal only respects publication state.

820. Fee Portal
Guardian can view:
Outstanding demands
Invoices
Payment history
Receipts
Credits
Due dates
The portal never calculates the authoritative balance itself.

821. Online Fee Payment
Portal
 ↓
Create Payment Intent
 ↓
Payment Provider
 ↓
Webhook
 ↓
Fee Payment
 ↓
Allocation
 ↓
Receipt
Never mark a fee invoice paid solely because the browser reports payment success.
The server/provider webhook is authoritative.

822. Payment Idempotency
Every payment initiation should have an idempotency key:
tenant_id
user_id
idempotency_key
Repeated requests must not create duplicate payments.

823. Fee Receipt
After successful allocation:
Payment
 ↓
Allocation
 ↓
Receipt
Receipt access goes through the File/Document infrastructure if rendered as a document.

824. Library Portal
Users can view:
Currently issued books
Due dates
Overdue books
Fines
Reservations
Reservation status
Portal cannot directly issue/return books.

825. Library Reservation
If enabled:
Portal
 ↓
Reserve Book
 ↓
Library
 ↓
Reservation Queue
Library owns reservation availability and queue ordering.

826. Transport Portal
Guardian can view:
Assigned route
Pickup stop
Drop-off stop
Scheduled times
Transport status
Live GPS should not be assumed for V1.
If future live tracking is introduced, it remains a Transport capability.

827. Transport Change Request
A guardian may request:
Pickup stop change
Drop-off stop change
Transport activation/deactivation
The request should enter Transport workflow rather than directly modifying the assignment.

828. Calendar Portal
Portal displays:
School holidays
Academic events
Parent meetings
Examination dates
Sports/cultural events
Only published calendar/events are exposed.

829. Event Registration
For enabled events:
View Event
 ↓
Register
 ↓
Registration Confirmed / Waitlisted
Calendar remains authoritative.

830. Communication Portal
In-app notifications:
Announcement
Notification
Event reminder
Fee reminder
Result publication
Transport message
Communication owns delivery and notification history.
Portal owns presentation/read state where appropriate.

831. Announcement Visibility
Announcement audience resolution should happen through Communication.
Portal should receive only announcements for which the current user is an authorized recipient.
Never send all tenant announcements to the client and filter them locally.

832. Portal Documents
Examples:
Student documents
Fee receipts
Result reports
Certificates
Consent documents
Download uses File Service authorization.
The portal must not expose raw storage keys.

833. Deep Links
Notifications may contain:
deep_link
Example:
schoolapp://fees/invoices/123
Deep links are navigation hints only.
When opened, the target API still performs full authorization.

834. Parent vs Student Access
Some information may differ.
Example:
Parent:
  Fee information
  Transport
  Attendance
  Results

Student:
  Results
  Attendance
  Library
  Calendar
Do not hardcode this solely in Flutter.
The server determines effective permissions.

835. Guardian Scope
Guardian permissions can depend on the specific relationship.
Existing fields such as:
portal_access_allowed
provide the basic relationship gate.
Future granular relationship permissions can be added without redesigning Portal.

836. Portal APIs
Portal context:
/api/v1/portal/context
/api/v1/portal/students
/api/v1/portal/students/:id
Dashboard:
/api/v1/portal/dashboard
Profile:
/api/v1/portal/profile
/api/v1/portal/profile/change-request

837. Portal Domain APIs
Attendance:
/api/v1/portal/students/:id/attendance
Results:
/api/v1/portal/students/:id/results
Fees:
/api/v1/portal/students/:id/fees
Library:
/api/v1/portal/students/:id/library
Transport:
/api/v1/portal/students/:id/transport
Calendar:
/api/v1/portal/calendar
Notifications:
/api/v1/portal/notifications
These are experience-oriented endpoints backed by the corresponding domain services.

838. Portal Application Services
GetPortalContext
GetPortalDashboard

GetAccessibleStudents
SwitchStudentContext

GetStudentProfile
RequestProfileChange

GetAttendanceSummary
CreateAttendanceCorrectionRequest

GetPublishedResults

GetFeeSummary
CreateFeePaymentIntent

GetLibrarySummary
CreateLibraryReservation

GetTransportSummary

GetCalendar
RegisterForEvent

GetNotifications
MarkNotificationRead

839. Student Context Switching
For a guardian with multiple students:
Guardian
 ↓
Student A
 ↓
Dashboard
Switching:
Student B
 ↓
Server validates relationship
 ↓
New portal context
Do not treat student_id from a request as proof of authorization.

840. Portal Context vs Tenant Context
Portal context is subordinate to tenant context.
Tenant Context
 ↓
Portal User
 ↓
Student/Guardian Context
A guardian cannot switch from one school to another merely by changing a student ID.

841. Cross-Tenant Protection
For every portal request:
authenticated user
AND
tenant context
AND
relationship
AND
permission
AND
resource ownership
must be validated.

842. Portal Feature Entitlements
Portal sections depend on the underlying feature:
Attendance feature disabled
 → Attendance portal section unavailable

Library feature disabled
 → Library section unavailable

Transport feature disabled
 → Transport section unavailable
The portal must use the Entitlement Engine.
It must not inspect subscription plan names.

843. Portal Feature Dependencies
Example:
Examination Results
 ↓
Student
 ↓
Academic
If a dependency is unavailable, the dependent portal capability cannot be exposed.

844. Portal Offline Behavior
Flutter may cache limited non-sensitive presentation data.
Cached data must never bypass authorization.
Sensitive information should have controlled local storage and should not be treated as authoritative.

845. Portal Security
Required controls:
short-lived access tokens
refresh-token security
tenant validation
relationship validation
permission checks
rate limiting
device/session management
audit for sensitive actions
secure file access
payment idempotency
no sensitive data in logs

846. Portal Audit
Audit:
profile changes
document uploads
fee payment initiation
correction requests
event registrations
reservation actions
sensitive document access where required
student-context changes where security-relevant
Routine read operations need not all become business audit records; application/security logs remain separate.

847. Portal Notifications
Notification delivery remains asynchronous:
Domain Event
 ↓
Communication
 ↓
Notification Request
 ↓
Portal In-App Notification
Portal availability should not affect the originating business transaction.

848. Portal Dashboard Read Model
For scale:
Domain Events
 ↓
Portal Read Model
Possible projection:
portal_student_summary
---------------------
tenant_id
student_id
attendance_summary
outstanding_fee_amount
unread_notification_count
library_due_count
latest_result_date
updated_at
This is a projection, not a replacement for source domains.

849. Portal Search
Portal search should be narrow.
A guardian should normally search only their accessible students/events/documents.
Never expose tenant-wide search indexes through the portal.

850. Portal Export
Exports should be limited and audited.
Examples:
Fee receipts
Result report
Attendance report
Large exports use the standard background job/file workflow.

851. Portal Error Handling
Use the standard API errors:
AUTHENTICATION_REQUIRED
TENANT_ACCESS_DENIED
PERMISSION_DENIED
RESOURCE_NOT_FOUND
ENTITLEMENT_REQUIRED
FEATURE_DISABLED
VALIDATION_ERROR
CONFLICT
Avoid revealing whether another student's resource exists.
For inaccessible resources, RESOURCE_NOT_FOUND can be preferable to exposing authorization details.

852. Portal Database
Keep portal-owned tables minimal.
Recommended:
portal_preferences
portal_consents
portal_dashboard_preferences
Do not replicate:
students
fees
attendance
results
library_loans
transport_assignments
inside the Portal domain.

853. Portal Preferences
portal_preferences
------------------
id
tenant_id
user_id
language
timezone
default_student_id
created_at
updated_at
version
default_student_id is only a UX preference.
The server still validates access.

854. Portal Consent
Where required:
portal_consents
--------------
id
tenant_id
user_id
consent_type
version
status
accepted_at
withdrawn_at
created_at
updated_at
Do not use consent records as a generic authorization system.

855. Portal Events
Portal-generated events:
ProfileChangeRequested
AttendanceCorrectionRequested
EventRegistrationCreated
LibraryReservationRequested
PortalConsentAccepted
Domain-specific workflows remain owned by the target domain.

856. Portal Integration Model
                  ┌── Student
                  ├── Attendance
Portal ───────────├── Examination
                  ├── Fees
                  ├── Library
                  ├── Transport
                  ├── Calendar
                  └── Communication
Portal is an orchestration/presentation layer.

857. Portal Lifecycle
User Authenticated
 ↓
Tenant Context
 ↓
Portal Context
 ↓
Student/Guardian Scope
 ↓
Feature/Permission Check
 ↓
Domain Operation
 ↓
Portal Response

858. Portal Module Contract
Parent / Student Portal
│
├── Portal Context
├── Guardian / Student Scope
├── Dashboard
├── Profile
├── Attendance View
├── Results View
├── Fee Self-Service
├── Library Self-Service
├── Transport View
├── Calendar / Events
├── Notifications
├── Documents
└── Self-Service Requests
The central architectural rule is:
Portal owns the user experience and self-service workflows, while every business domain remains authoritative for its own data and rules.
This also gives the Flutter application a stable API boundary without forcing the backend into a portal-specific data model.
