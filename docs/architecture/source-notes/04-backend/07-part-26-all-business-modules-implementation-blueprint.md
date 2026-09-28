<!-- Source: Apple Notes, folder 'BAckend' -->
# Part 26 — All Business Modules Implementation Blueprint

This is the single implementation blueprint for all business modules. The shared infrastructure from Parts 23–25 applies everywhere.
1. Standard Module Pattern
Every module follows:
Routes
  ↓
Controller
  ↓
DTO + Validation
  ↓
Authorization
  ↓
Application Service
  ↓
Domain Rules
  ↓
Repository
  ↓
MySQL
  ↓
Outbox Event
Each module contains:
domain/
application/
infrastructure/
presentation/

2. Student Management
Owns
Student identity
Admission
Enrollment
Guardian relationships
Student status
Student history
Student documents/metadata
Services
StudentService
EnrollmentService
GuardianService
StudentDocumentService
StudentHistoryService
Key workflows
Create Student
 → Admission Number
 → Guardian
 → Enrollment

Transfer
 → Previous Assignment
 → New Assignment

Withdraw
 → Status Change
 → History
 → Related Events
Events
student.created
student.enrolled
student.transferred
student.status_changed
student.withdrawn
Permissions
students.read
students.create
students.update
students.delete
students.enroll
students.transfer

3. Academic Management
Owns
Academic years
Terms
Classes
Sections
Subjects
Class-subject assignments
Services
AcademicYearService
TermService
ClassService
SectionService
SubjectService
CurriculumService
Events
academic_year.opened
academic_year.closed
section.created
subject.assigned

4. Teacher Management
Owns
Teacher profile
Subjects taught
Class assignments
Teaching availability
Qualifications
HR remains owner of employment.
Services
TeacherService
TeacherAssignmentService
TeacherAvailabilityService
Events
teacher.created
teacher.assigned
teacher.assignment_changed
teacher.availability_changed

5. Attendance
Owns
Attendance sessions
Attendance records
Correction workflows
Attendance summaries
Services
AttendanceSessionService
AttendanceService
AttendanceCorrectionService
AttendanceSummaryService
Workflow
Create Session
 ↓
Mark Records
 ↓
Submit
 ↓
Lock
 ↓
Summary
Correction:
Request
 ↓
Review
 ↓
Approve/Reject
 ↓
Audit
Events
attendance.marked
attendance.submitted
attendance.corrected

6. Examination & Results
Owns
Exams
Exam subjects
Assessments
Marks
Grading
Results
Publication
Services
ExaminationService
AssessmentService
MarksService
GradingService
ResultService
PublicationService
Workflow
Exam
 ↓
Schedule
 ↓
Assessment
 ↓
Marks
 ↓
Validation
 ↓
Result
 ↓
Publish
Once published, results should be versioned/auditable.
Events
exam.created
marks.submitted
result.generated
result.published

7. Fee Management
Owns
Fee structures
Student charges
Invoices
Payments
Allocations
Refunds
Receipts
Waivers/discounts
Services
FeeStructureService
FeeAssignmentService
InvoiceService
PaymentService
AllocationService
RefundService
ReceiptService
Workflow
Charge
 ↓
Invoice
 ↓
Payment Intent
 ↓
Provider
 ↓
Webhook
 ↓
Payment
 ↓
Allocation
 ↓
Receipt
Events
invoice.created
payment.initiated
payment.completed
payment.refunded
fee.overdue
Transport, library, etc. may produce chargeable facts, but Fee Management owns financial records.

8. Timetable
Owns
Periods
Timetable versions
Timetable entries
Teacher/class/room assignments
Services
PeriodService
TimetableService
TimetableValidationService
TimetablePublicationService
Validation
Prevent:
Teacher conflicts
Room conflicts
Class conflicts
Section conflicts
Invalid periods
Events
timetable.published
timetable.changed

9. Leave & Availability
Owns
Leave types
Leave policies
Leave balances
Leave requests
Approval workflow
Availability
Services
LeavePolicyService
LeaveBalanceService
LeaveRequestService
LeaveApprovalService
AvailabilityService
Workflow
Request
 ↓
Validation
 ↓
Approval
 ↓
Balance Update
 ↓
Availability Update
Events
leave.requested
leave.approved
leave.rejected
leave.cancelled

10. Communication
Owns
Announcements
Notifications
Delivery
Notification preferences
Templates
Services
AnnouncementService
NotificationService
DeliveryService
TemplateService
PreferenceService
Communication consumes events from other domains.
Example:
fee.overdue
   ↓
Notification Service
   ↓
Parent
   ↓
Push + Email

11. File & Document Management
Owns
Files
Versions
Document metadata
Upload lifecycle
Access
Services
FileService
DocumentService
FileAccessService
FileProcessingService
Business domains retain document meaning.

12. Library
Owns
Catalogue
Titles
Authors
Physical copies
Loans
Returns
Reservations
Fines
Services
CatalogueService
CopyService
LoanService
ReturnService
ReservationService
LibraryFineService
Workflow
Reservation
 ↓
Issue
 ↓
Loan
 ↓
Return
 ↓
Fine if required
Events
library.book.issued
library.book.returned
library.book.overdue

13. Transport
Owns
Routes
Stops
Vehicles
Drivers
Schedules
Student assignments
Trips
Boarding
Incidents
Services
RouteService
VehicleService
DriverService
TransportAssignmentService
TripService
BoardingService
TransportIncidentService
Critical rules
Capacity validation
Effective-dated student assignments
Historical trip preservation
Driver/vehicle availability validation
Events
transport.assigned
transport.unassigned
transport.trip.started
transport.boarding.recorded
transport.incident.created

14. Inventory & Assets
Owns
Items
Stores
Stock
Movements
Suppliers
Assets
Assignments
Maintenance
Disposal
Services
InventoryItemService
StockService
ReceiptService
IssueService
TransferService
StockCountService

AssetService
AssetAssignmentService
AssetMaintenanceService
AssetDisposalService
Inventory rule
Stock Ledger
     ↓
Stock Balance
The movement ledger is authoritative.
Events
stock.received
stock.issued
stock.transferred
stock.adjusted
asset.assigned
asset.returned
asset.disposed

15. HR / Staff
Owns
Staff
Employment
Contracts
Departments
Positions
Onboarding
Offboarding
Staff documents
Services
StaffService
EmploymentService
ContractService
OnboardingService
OffboardingService
StaffDocumentService
Offboarding
Offboarding
 ↓
Revoke Access
 ↓
End Employment
 ↓
Return Assets
 ↓
Update Teacher Assignment
 ↓
Update Availability
 ↓
Audit
Events
staff.hired
staff.onboarded
staff.offboarded
employment.changed

16. Calendar & Events
Owns
School calendar
Working days
Holidays
Exceptions
Events
Registrations
Reminders
Services
CalendarService
HolidayService
EventService
EventRegistrationService
ReminderService
Calendar is the shared temporal authority.

17. Portal
The Portal is not another business-data owner.
It orchestrates:
Identity
 ↓
Relationship
 ↓
Authorization
 ↓
Domain APIs
 ↓
Portal Response
Services
PortalDashboardService
PortalProfileService
PortalStudentService
PortalFeeService
PortalAttendanceService
PortalResultService
PortalNotificationService
Dashboard
Student
Attendance
Fees
Results
Library
Transport
Calendar
Notifications
The dashboard may use read projections for performance.

18. Cross-Domain Workflow Rules
Student admission
Student
 ↓
Enrollment
 ↓
Class/Section
 ↓
Guardian
 ↓
Optional Transport/Library
 ↓
Events
Student transfer
Current Assignment
 ↓
Close
 ↓
New Assignment
 ↓
Timetable/Attendance Context
 ↓
Event
Staff offboarding
HR
 ↓
Identity
 ↓
Teacher
 ↓
Leave
 ↓
Assets
 ↓
Timetable
Fee payment
Fees
 ↓
Payment Provider
 ↓
Webhook
 ↓
Payment
 ↓
Allocation
 ↓
Receipt
 ↓
Notification

19. Cross-Domain Communication
Preferred:
Application Interfaces
+
Domain Events
Avoid:
Direct database writes
Cross-module SQL updates
Circular dependencies
Example:
HR
 ──staff.offboarded──→ Identity
                     → Teacher
                     → Assets
                     → Timetable
Each consumer handles its own state.

20. Module Dependency Rules
Identity
   ↓
Tenant
   ↓
Academic / Student / HR
   ↓
Attendance / Exams / Fees / Timetable
   ↓
Library / Transport / Inventory / Communication
   ↓
Portal / Reporting
Shared infrastructure can be consumed by all modules.
Business modules must not become dependent on Portal.

21. Standard Module Definition of Done
Every module must contain:
✓ Domain entities
✓ Business rules
✓ Application services
✓ Repository interfaces
✓ Repository implementations
✓ DTOs
✓ Validators
✓ Controllers
✓ Routes
✓ Permissions
✓ Entitlements
✓ Transactions
✓ Events
✓ Background jobs where needed
✓ Audit logging
✓ Error codes
✓ API documentation
✓ Unit tests
✓ Integration tests
✓ E2E tests

22. Recommended Implementation Sequence
Now that all modules are defined, implementation should proceed in dependency order:
PHASE 1
Identity
Tenant
RBAC
Entitlements
        ↓
PHASE 2
Academic Structure
Students
Guardians
Staff / Teachers
        ↓
PHASE 3
Attendance
Timetable
Leave
        ↓
PHASE 4
Examinations
Results
        ↓
PHASE 5
Fees
Payments
Billing
        ↓
PHASE 6
Library
Transport
Inventory
Assets
        ↓
PHASE 7
Communication
Calendar
Files
        ↓
PHASE 8
Portal
Dashboard
Reports
        ↓
PHASE 9
Integration
Testing
Security
Performance
        ↓
PHASE 10
Production Deployment
This ordering minimizes circular dependencies and allows each completed layer to support the next.

Overall Architecture Is Now Locked
                 ┌──────────────────────┐
                 │     Flutter / Web    │
                 └──────────┬───────────┘
                            ↓
                     API / Application
                            ↓
             ┌──────────────┴──────────────┐
             │                             │
        Identity/Tenant               Shared Services
             │                             │
        RBAC/Entitlements       Files / Events / Jobs
             │                  Notifications / Audit
             └──────────────┬──────────────┘
                            ↓
                  Business Domains
                            ↓
                         MySQL
At this point, the architecture, database, API standards, security model, shared infrastructure, and all business-module boundaries are defined in one consistent system.
Next: Part 27 — Complete Flutter/Web Application Architecture, covering navigation, state management, API integration, authentication, role/permission-driven UI, design system, offline behavior, forms, tables, dashboards, portal experiences, and shared frontend architecture in one pass.
