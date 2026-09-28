<!-- Source: Apple Notes, folder 'Frontend' -->
# Part 27 — Complete Flutter & Web Application Architecture

This defines the entire frontend architecture in one pass for the Admin Web, Staff/Teacher experience, and Parent/Student Portal. Individual features should reuse this architecture rather than introducing their own patterns.

1. Frontend Strategy
Use a shared frontend architecture with two primary applications:
apps/
├── web/                 # School administration / staff
└── mobile/              # Flutter parent/student/staff experience
The backend remains the single source of truth.
Flutter / Web
      ↓
API Client
      ↓
Express API
      ↓
Domain Services
      ↓
MySQL
Frontend must never directly access MySQL or business infrastructure.

2. Frontend Technology
Web
TypeScript
React
React Router
TanStack Query
Zod
React Hook Form
Flutter
Flutter
Dart
Riverpod
go_router
Dio
Freezed
json_serializable
Shared principles
Feature-first architecture
Server state separated from UI state
Central API client
Central authentication
Central authorization
Shared design tokens
Consistent error/loading/empty states
Accessibility
Responsive layouts
No duplicated business rules

3. Web Application Structure
apps/web/
├── src/
│   ├── app/
│   │   ├── router/
│   │   ├── providers/
│   │   ├── layouts/
│   │   └── bootstrap/
│   │
│   ├── core/
│   │   ├── api/
│   │   ├── auth/
│   │   ├── permissions/
│   │   ├── entitlements/
│   │   ├── errors/
│   │   ├── storage/
│   │   └── config/
│   │
│   ├── design-system/
│   │   ├── components/
│   │   ├── forms/
│   │   ├── tables/
│   │   ├── dialogs/
│   │   ├── feedback/
│   │   ├── navigation/
│   │   └── theme/
│   │
│   ├── features/
│   │   ├── dashboard/
│   │   ├── students/
│   │   ├── academics/
│   │   ├── teachers/
│   │   ├── attendance/
│   │   ├── examinations/
│   │   ├── fees/
│   │   ├── timetable/
│   │   ├── leave/
│   │   ├── communication/
│   │   ├── files/
│   │   ├── library/
│   │   ├── transport/
│   │   ├── inventory/
│   │   ├── hr/
│   │   ├── calendar/
│   │   ├── users/
│   │   ├── settings/
│   │   └── reports/
│   │
│   └── shared/
│       ├── hooks/
│       ├── utils/
│       ├── types/
│       └── constants/

4. Flutter Structure
apps/mobile/
├── lib/
│   ├── app/
│   │   ├── router/
│   │   ├── bootstrap/
│   │   └── providers/
│   │
│   ├── core/
│   │   ├── api/
│   │   ├── auth/
│   │   ├── permissions/
│   │   ├── entitlements/
│   │   ├── storage/
│   │   ├── notifications/
│   │   ├── connectivity/
│   │   └── errors/
│   │
│   ├── design_system/
│   │   ├── theme/
│   │   ├── components/
│   │   ├── forms/
│   │   ├── cards/
│   │   ├── lists/
│   │   └── feedback/
│   │
│   ├── features/
│   │   ├── auth/
│   │   ├── dashboard/
│   │   ├── students/
│   │   ├── attendance/
│   │   ├── academics/
│   │   ├── examinations/
│   │   ├── fees/
│   │   ├── library/
│   │   ├── transport/
│   │   ├── calendar/
│   │   ├── notifications/
│   │   ├── documents/
│   │   └── profile/
│   │
│   └── shared/
│       ├── models/
│       ├── extensions/
│       └── utilities/

5. Feature Structure
Every feature follows the same pattern.
students/
├── data/
│   ├── datasources/
│   ├── dto/
│   └── repositories/
│
├── domain/
│   ├── entities/
│   ├── repositories/
│   └── services/
│
└── presentation/
    ├── pages/
    ├── widgets/
    ├── controllers/
    └── providers/
The Web version follows the same conceptual separation.

6. State Management
Separate state into three categories.
Server state
Managed by:
TanStack Query
Riverpod
Examples:
students
attendance
fees
results
notifications
calendar
UI state
Examples:
selected tab
dialog open
filter panel
sort order
form visibility
Session state
Examples:
current user
current tenant
permissions
entitlements
authentication state
Do not place the entire API response tree into global application state.

7. API Client
One central HTTP client.
Web:
Axios / fetch abstraction

Flutter:
Dio
Responsibilities:
authentication
headers
request ID
serialization
timeouts
retry
error normalization
token/session handling
Feature code should not independently configure HTTP clients.

8. API Response Mapping
Backend:
{
  "data": {},
  "meta": {}
}
Frontend converts API DTOs into domain models where appropriate.
API DTO
   ↓
Mapper
   ↓
Domain Model
   ↓
UI
Do not expose backend implementation details throughout UI components.

9. Authentication State
Frontend authentication states:
UNKNOWN
AUTHENTICATING
AUTHENTICATED
UNAUTHENTICATED
SESSION_EXPIRED
Startup:
Application
 ↓
Restore Session
 ↓
Validate/Refresh
 ↓
Load User
 ↓
Load Tenant Membership
 ↓
Load Permissions
 ↓
Load Entitlements
 ↓
Application

10. Authentication Navigation
                    App Start
                       │
              ┌────────▼────────┐
              │ Authenticated?  │
              └───────┬─────────┘
                 No   │   Yes
                 ↓    │    ↓
               Login  │  Tenant Context
                      │    ↓
                      │  Permissions
                      │    ↓
                      │  Dashboard
Unauthenticated users cannot reach protected routes.

11. Route Guards
Routes support:
authentication
tenant membership
permission
entitlement
role/persona
Example:
/students
requires:
authenticated
+
students.read
+
students entitlement
But frontend guards are only UX controls.
The backend always performs the actual authorization.

12. Navigation Architecture
Web
Dashboard

School
 ├── Students
 ├── Classes
 ├── Sections
 ├── Subjects
 └── Academic Years

People
 ├── Teachers
 ├── Staff
 └── Guardians

Academics
 ├── Attendance
 ├── Examinations
 ├── Results
 └── Timetable

Finance
 ├── Fee Structures
 ├── Invoices
 ├── Payments
 └── Reports

Operations
 ├── Library
 ├── Transport
 ├── Inventory
 └── Assets

Administration
 ├── Users
 ├── Roles
 ├── Settings
 └── Audit

Calendar
Communication
Reports
The menu is dynamically filtered by permissions and entitlements.

13. Mobile Navigation
Parent/student experience should prioritize high-frequency operations:
Home
Attendance
Fees
Results
Notifications
More
Additional:
Library
Transport
Calendar
Documents
Profile
Staff/teacher mobile navigation can expose additional operational features based on permissions.

14. Multiple Student Support
A guardian may have multiple students.
Provide:
Student Switcher
Example:
┌───────────────────────┐
│ Student: Aarav ▼      │
└───────────────────────┘
Changing the selected student refreshes:
attendance
results
fees
library
transport
calendar
documents
The backend still validates the relationship for every request.

15. Dashboard Architecture
Dashboard should be composed from independent widgets.
Dashboard
├── Attendance Summary
├── Fee Summary
├── Upcoming Events
├── Recent Results
├── Notifications
├── Library Status
└── Transport Status
Each widget has:
loading
success
empty
error
states.
One failing widget should not break the entire dashboard.

16. Admin Dashboard
Typical widgets:
Students
Staff
Attendance
Fees
Outstanding Fees
Upcoming Exams
Events
Notifications
Library
Transport
Inventory
Widgets should use backend reporting/read models where appropriate rather than loading thousands of transactional records.

17. Forms
All forms use:
schema validation
field validation
server validation
dirty state
submit state
error state
success state
Standard states:
IDLE
SUBMITTING
SUCCESS
ERROR
Prevent duplicate submissions.

18. Form Design
Reusable components:
TextField
Select
MultiSelect
DatePicker
TimePicker
DateRangePicker
CurrencyInput
NumberInput
FileUpload
Autocomplete
Checkbox
RadioGroup
Switch
Business forms compose these components instead of creating custom controls for every feature.

19. Tables
Admin web needs a shared data-table component supporting:
sorting
filtering
search
pagination
column visibility
row actions
bulk selection
export
responsive behavior
Example:
Students
────────────────────────────────────────
Name     Admission No.  Class   Status
Aarav    ST-1001        8-A     Active
Table state should be URL-addressable where useful so filters can be shared/bookmarked.

20. Detail Pages
Use a consistent layout:
Header
 ├── Title
 ├── Status
 └── Actions

Summary

Tabs
 ├── Overview
 ├── History
 ├── Documents
 ├── Related Data
 └── Audit
Example:
Student
├── Overview
├── Attendance
├── Results
├── Fees
├── Library
├── Transport
├── Documents
└── History

21. Loading States
Use:
Skeletons
Spinners
Progress indicators
Optimistic UI where safe
Avoid blank screens.
For tables:
Loading skeleton
For actions:
Button → submitting state

22. Empty States
Every list needs an explicit empty state.
Example:
No students found

Try changing your filters or add a new student.
Differentiate:
No data exists
from:
No results match your search

23. Error States
Use centralized error handling.
Examples:
Network unavailable
Session expired
Permission denied
Feature unavailable
Validation error
Server error
Conflict
Users should receive actionable messages without exposing internal errors.

24. Offline Architecture
Mobile should support limited offline capability.
Cache locally
profile
student context
recent notifications
recent attendance/results
reference data
Offline operations
Only explicitly safe operations should support offline queueing.
For example, teacher attendance marking may support:
Offline
 ↓
Local Queue
 ↓
Reconnect
 ↓
Server Sync
 ↓
Conflict Resolution
Financial operations should not be blindly queued offline.

25. Connectivity
Flutter should expose:
Online
Offline
Reconnecting
Offline indicator:
You are offline.
Changes will sync when connection is restored.
Only operations designed for offline synchronization should display that promise.

26. Conflict Resolution
For synchronized data:
Client Version
+
Server Version
If conflict occurs:
SYNC_CONFLICT
The application should never silently overwrite newer server data.
Attendance and similar operational data should have domain-specific conflict rules.

27. File Upload UI
Reusable upload component:
Select File
 ↓
Validate Type/Size
 ↓
Upload
 ↓
Progress
 ↓
Processing
 ↓
Available
Display:
uploading
processing
available
failed
Use the backend's signed upload URL.

28. Notifications UI
Notification center:
All
Unread
Announcements
Payments
Attendance
Academic
System
Notification click should navigate to the relevant resource.
Example:
Fee payment received
       ↓
Open Invoice

29. Permissions in UI
Create shared helpers:
can("students.create")
can("fees.payment.refund")
hasFeature("transport")
Use them for:
navigation
buttons
actions
tabs
pages
bulk actions
Never rely on them for security.

30. Entitlements in UI
Example:
if hasFeature("library")
    show Library
If disabled:
Feature unavailable
or hide it according to product UX rules.
Do not hard-code plan names into the frontend.

31. Role-Based Experience
Different personas get different default experiences.
School Admin
Dashboard
Students
Academics
People
Finance
Operations
Reports
Settings
Teacher
Dashboard
My Classes
Attendance
Timetable
Examinations
Students
Notifications
Parent
Children
Attendance
Fees
Results
Calendar
Library
Transport
Notifications
Student
Attendance
Timetable
Results
Fees
Library
Calendar
Notifications
These are default experiences; actual access still comes from permissions.

32. Design System
Create a central token system.
Tokens
Colors
Typography
Spacing
Radius
Elevation
Motion
Breakpoints
Icon sizes
Control heights
Example spacing scale:
4
8
12
16
24
32
48
64
Do not invent arbitrary spacing inside individual features.

33. Responsive Design
Web breakpoints:
Mobile
Tablet
Desktop
Large Desktop
Desktop:
Sidebar + content
Tablet:
Collapsible sidebar
Mobile:
Bottom navigation / drawer
Tables should become cards or horizontally scrollable layouts where appropriate.

34. Accessibility
Build accessibility into the shared components.
Required:
keyboard navigation
focus states
semantic labels
screen-reader labels
sufficient contrast
touch targets
error announcements
accessible dialogs
Do not solve accessibility separately in every module.

35. Localization
Architecture must support:
language
locale
timezone
currency
date format
number format
Never hard-code user-facing strings throughout components.
Use translation keys:
students.create
students.no_students
fees.payment_success

36. Date & Time
Backend stores timestamps in UTC.
Frontend converts them using the tenant/user timezone.
Calendar-related operations must respect the school's configured timezone.
Avoid manually formatting dates in individual features.
Use one shared date/time utility.

37. Money
Never represent money as floating-point values.
Frontend should receive:
amount
currency
and format it centrally.
Example:
₹25,000.00
Formatting belongs to the UI layer; financial calculation belongs to the backend.

38. Security on Frontend
Never store sensitive credentials in ordinary local storage when a more secure mechanism is available.
Protect:
tokens
session information
personal data
download URLs
Never embed:
database credentials
provider secrets
private API keys
in frontend builds.

39. Web Performance
Use:
route-level code splitting
lazy loading
query caching
pagination
virtualized large lists
image optimization
debounced search
background refresh
Never load thousands of students/books/assets into the browser unnecessarily.

40. Mobile Performance
Use:
lazy lists
pagination
cached images
background synchronization
minimal rebuilds
efficient state providers
Avoid putting large collections into global state.

41. Error Recovery
For recoverable errors:
Retry
For session expiry:
Refresh session
 ↓
If successful → continue
If failed → login
For permission changes during an active session:
403
 ↓
Refresh authorization context
 ↓
Re-evaluate

42. Frontend Analytics
Track product-level technical events where appropriate:
screen_view
feature_opened
action_completed
action_failed
Do not collect sensitive information unnecessarily.
Analytics must not become a source of business truth.

43. Testing
Unit
validators
mappers
formatters
state logic
permission logic
Widget/component
forms
tables
dialogs
cards
navigation
loading/error states
Integration
login
student creation
attendance
fee payment
result viewing
portal
E2E
Critical journeys:
Admin Login
 → Student Creation
 → Enrollment
 → Attendance

Teacher Login
 → Class
 → Attendance
 → Submit

Admin
 → Exam
 → Marks
 → Publish Result

Parent
 → Login
 → Select Child
 → View Attendance
 → View Fees
 → Payment

44. Frontend Project Standards
Every feature must have:
✓ Routes
✓ Pages
✓ API integration
✓ Models/DTOs
✓ State management
✓ Permission checks
✓ Entitlement checks
✓ Loading state
✓ Empty state
✓ Error state
✓ Form validation
✓ Responsive layout
✓ Accessibility
✓ Localization support
✓ Tests

45. Complete Frontend Architecture
                         USER
                           │
                ┌──────────▼──────────┐
                │   Web / Flutter     │
                └──────────┬──────────┘
                           │
                 ┌─────────▼─────────┐
                 │ Router / Guards   │
                 └─────────┬─────────┘
                           │
              ┌────────────▼────────────┐
              │ Auth / Tenant / Access  │
              └────────────┬────────────┘
                           │
                  ┌────────▼────────┐
                  │ Feature Layer   │
                  ├─────────────────┤
                  │ Students        │
                  │ Attendance      │
                  │ Exams           │
                  │ Fees            │
                  │ Library         │
                  │ Transport       │
                  │ Inventory       │
                  │ HR              │
                  │ Calendar        │
                  │ Portal          │
                  └────────┬────────┘
                           │
                    ┌──────▼──────┐
                    │ API Client  │
                    └──────┬──────┘
                           │
                       REST API
                           │
                    ┌──────▼──────┐
                    │  Backend    │
                    └─────────────┘

46. Final Frontend Rule
The most important frontend principle is:
Features compose the shared platform; they do not create their own architecture.
Therefore:
One API client
One auth system
One permission system
One entitlement system
One design system
One error system
One navigation strategy
One state-management strategy
One file-upload system
One notification system
One testing strategy
Only domain-specific UI and workflows change between features.

47. Frontend Definition of Done
The frontend foundation is complete when:
✓ Web application shell
✓ Flutter application shell
✓ Authentication
✓ Tenant selection/context
✓ Permission handling
✓ Entitlement handling
✓ Routing
✓ API client
✓ Error handling
✓ State management
✓ Design system
✓ Forms
✓ Tables
✓ Dashboards
✓ File uploads
✓ Notifications
✓ Responsive layouts
✓ Accessibility
✓ Localization
✓ Timezone handling
✓ Offline foundation
✓ Caching
✓ Testing foundation
✓ E2E framework
✓ CI integration
Complete architecture status
At this stage the major system design is covered end-to-end:
Part 20  Master Implementation Blueprint
Part 21  Complete Database / ERD
Part 22  Complete API Contracts
Part 23  Backend Foundation
Part 24  Identity / Tenant / RBAC / Entitlements
Part 25  Shared Platform Services
Part 26  All Business Modules
Part 27  Web / Flutter Architecture
The remaining implementation-level architecture can now be consolidated into three final parts rather than continuing feature-by-feature:
Part 28 — Complete Testing, QA & Security Strategy
Part 29 — Complete Deployment, DevOps & Infrastructure
Part 30 — Final Implementation Roadmap + Definition of Done
After Part 30, the architecture/specification phase is complete and the project can move directly into implementation without needing a separate architecture document for each feature.
