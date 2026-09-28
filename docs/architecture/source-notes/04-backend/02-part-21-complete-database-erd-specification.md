<!-- Source: Apple Notes, folder 'BAckend' -->
# Part 21 — Complete Database & ERD Specification

This will be the single database blueprint for the entire platform, rather than separate ERDs for each feature.
1. Database Standard
Database: MySQL 8+
Standard columns
Most tenant-owned tables:
id
tenant_id
created_at
updated_at
created_by
updated_by
Use:
UUIDv7 for IDs
UTC timestamps
BIGINT/integer minor units for money
DECIMAL for quantities where fractional values are required
JSON only for genuinely flexible metadata
foreign keys wherever practical
composite tenant-aware indexes

2. Core Platform Tables
tenants
tenant_settings
tenant_domains
tenant_status_history

plans
plan_features
subscriptions
subscription_items
subscription_history
entitlements

users
user_sessions
user_mfa_methods
user_memberships

roles
permissions
role_permissions
user_roles

audit_logs
outbox_events
job_records
Key relationships
Tenant
 ├── Users
 ├── Memberships
 ├── Roles
 ├── Settings
 ├── Subscription
 └── All tenant business data

3. School Structure
academic_years
academic_terms
campuses
buildings
rooms

departments
classes
sections
subjects

class_subjects
class_section_subjects
Relationships:
Academic Year
 └── Terms

Class
 └── Sections
      └── Students

Class
 └── Subjects

4. Student Management
students
student_identifiers
student_addresses
student_contacts
student_guardians
guardians

student_enrollments
student_class_assignments
student_status_history

student_documents
student_notes
student_tags
student_tag_assignments
Core relationship:
Student
 ├── Guardians
 ├── Enrollments
 ├── Class Assignments
 ├── Documents
 └── Status History
Guardian relationships should support:
guardian ↔ multiple students
student ↔ multiple guardians
with relationship metadata such as:
relationship_type
is_primary
is_emergency_contact
can_pickup
can_receive_communications

5. Teacher & Staff
HR
staff
staff_identifiers
departments
positions
employment_records
employment_contracts
staff_documents
staff_emergency_contacts
staff_onboarding
staff_offboarding
Teaching
teachers
teacher_subjects
teacher_class_assignments
teacher_availability
teacher_qualifications
Architecture:
User
 ↓
Staff
 ↓
Teacher
These remain separate concepts.

6. Attendance
attendance_sessions
attendance_records
attendance_corrections
attendance_correction_requests
attendance_summaries
Relationships:
Attendance Session
 ├── Class/Section
 ├── Date
 └── Attendance Records
       └── Student
Unique constraint should prevent duplicate attendance for the same student/session.

7. Academic / Examination
assessment_types
examinations
examination_subjects
examination_schedules

assessment_components
assessment_marks
assessment_results
result_publications
result_publication_items

grading_systems
grading_rules
Flow:
Examination
 ↓
Subjects
 ↓
Assessment
 ↓
Marks
 ↓
Result
 ↓
Publication
Published results should remain historically reproducible.

8. Fees & Finance
fee_categories
fee_structures
fee_structure_items
fee_assignments

student_fee_accounts
fee_invoices
fee_invoice_items

payments
payment_transactions
payment_allocations
payment_refunds

financial_adjustments
receipts
fee_waivers
fee_discounts

payment_methods
payment_providers
Financial flow:
Fee Structure
      ↓
Student Assignment
      ↓
Invoice
      ↓
Payment
      ↓
Allocation
      ↓
Receipt
Important rule
Payment records are never silently deleted or overwritten.
Corrections use:
refund
reversal
adjustment

9. Timetable
timetable_versions
timetable_entries
periods
rooms
teacher_assignments
class_timetable_assignments
A timetable entry can reference:
academic period
class
section
subject
teacher
room
day
Published timetable versions should remain reproducible.

10. Leave & Availability
leave_types
leave_policies
leave_balances
leave_requests
leave_approvals

staff_availability
teacher_availability
Leave workflow:
Request
 ↓
Approval
 ↓
Balance Update
 ↓
Calendar / Availability Impact

11. Communication
notification_templates
notification_preferences

notifications
notification_recipients
notification_deliveries

communication_messages
communication_recipients

announcements
announcement_targets
Delivery channels:
IN_APP
EMAIL
SMS
PUSH
Delivery status is tracked independently from the business event.

12. Files & Documents
files
file_links
document_types
document_versions
Generic relationship:
File
 ↓
File Link
 ↓
Business Entity
Example:
Student → Passport Document → File
Staff   → Contract Document → File
Asset   → Warranty Document → File
Physical storage information belongs to files; business meaning belongs to the owning domain.

13. Library
library_branches
library_categories
library_authors
library_publishers

library_titles
library_title_authors
library_copies

library_members
library_loans
library_returns
library_reservations

library_fines
library_lost_items
Important distinction:
Book Title
     ↓
Physical Copies
     ↓
Loan
A title is not the same as a physical copy.

14. Transport
vehicles
drivers

transport_routes
transport_stops
route_stops
route_schedules

student_transport_assignments

transport_trips
transport_trip_students
transport_boarding_records

transport_incidents
vehicle_maintenance
Historical trips must retain the actual:
vehicle
driver
route
students
used at that time.

15. Inventory & Assets
Inventory
inventory_categories
inventory_items
inventory_units

stores
stock_balances
stock_movements

purchase_receipts
purchase_receipt_items

stock_issues
stock_issue_items

stock_returns
stock_return_items

stock_transfers
stock_transfer_items

stock_adjustments
stock_counts
stock_count_items

suppliers
Assets
assets
asset_categories
asset_assignments
asset_maintenance
asset_disposals
asset_depreciation_records
Inventory:
Item → Quantity → Stock Movement
Asset:
Asset → Individual Identity → Assignment History

16. Calendar & Events
school_calendars
calendar_periods
calendar_days
calendar_holidays
calendar_exceptions

events
event_locations
event_audiences
event_participants
event_registrations
event_reminders
Calendar owns:
working days
holidays
academic temporal context
school events
Other modules reference it rather than duplicating calendar rules.

17. Portal
Keep portal-owned data intentionally small:
portal_preferences
portal_consents
portal_dashboard_preferences
The portal does not duplicate:
students
fees
attendance
results
library
transport
Those remain owned by their respective domains.
Optional read models:
portal_dashboard_snapshots
portal_notification_summaries
These are projections/cache data, never authoritative.

18. Important Relationship Map
The overall ERD concept is:
                         ┌──────────────┐
                         │    TENANT    │
                         └──────┬───────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
     Identity                School                  Billing
        │                       │                       │
     Users                  Classes                Subscription
        │                       │
   Memberships             Sections
        │                       │
      Roles                 Students
                                │
       ┌───────────────┬────────┼───────────────┐
       │               │        │               │
   Attendance       Exams     Fees          Guardians
       │               │        │               │
       │             Results  Payments          │
       │                        │                │
       └──────────────┬─────────┘                │
                      │                          │
                   Portal ◄──────────────────────┘

School
 ├── Teachers
 ├── Timetable
 ├── Leave
 ├── Calendar
 ├── Library
 ├── Transport
 ├── Inventory
 ├── HR
 ├── Communication
 └── Files

19. Tenant Isolation
Every tenant-owned business table should include:
tenant_id
Example:
students
-------------
id
tenant_id
admission_number
first_name
last_name
...
Tenant-aware uniqueness:
UNIQUE(tenant_id, admission_number)
rather than globally:
UNIQUE(admission_number)
This principle applies throughout the database.

20. Index Strategy
Every major table should have:
INDEX(tenant_id)
INDEX(tenant_id, status)
INDEX(tenant_id, created_at)
Additional indexes depend on access patterns.
Examples:
students:
  tenant_id + admission_number
  tenant_id + name/search fields
  tenant_id + status

attendance:
  tenant_id + student_id + date
  tenant_id + session_id

fees:
  tenant_id + student_id
  tenant_id + invoice_number
  tenant_id + status

payments:
  tenant_id + transaction_reference
  tenant_id + student_id
  tenant_id + payment_date
Do not blindly create indexes on every column.

21. Delete Strategy
Hard delete
Use for temporary/non-business data where safe.
Soft delete/archive
Use where historical traceability matters.
Examples:
students
staff
fee structures
library titles
inventory items
assets
calendar events
Never casually delete
payments
payment allocations
attendance history
published results
audit logs
stock movements
employment history
Use reversal, archival, or correction workflows.

22. Concurrency Rules
The database must protect critical operations even if two requests arrive simultaneously.
Examples:
Fee payment allocation
Inventory stock issue
Transport capacity
Library checkout
Attendance submission
Unique admission number
Unique invoice number
Use:
transactions
unique constraints
row locks
optimistic versioning
as appropriate.

23. Migration Strategy
All schema changes must be migration-based:
migration_001_initial
migration_002_identity
migration_003_students
...
Never modify production schema manually.
Migration process:
Developer
 ↓
Migration
 ↓
CI validation
 ↓
Staging
 ↓
Production
Destructive migrations require a controlled migration process.

24. Seed Data
Create deterministic seed data for:
permissions
system roles
feature definitions
subscription plans
default settings
reference statuses
Tenant-specific data must never be accidentally seeded into production tenants.

25. Final Database Ownership Rule
The most important architectural rule:
One domain owns its data; other domains reference it but do not directly modify it.
For example:
Fees → owns payments
Transport → does not create payments directly

Student → owns student identity
Portal → does not create duplicate students

HR → owns employment
Teacher → does not own employment

Library → owns book circulation
Inventory → does not own library copies

Calendar → owns school calendar
Attendance → consumes calendar context
This prevents the database from becoming a tightly coupled collection of feature-specific tables.

Result
With this specification, the database architecture is now defined once for the entire platform rather than repeatedly for each feature.
The next implementation artifact should therefore be:
Part 22 — Complete API Contract Specification, covering all modules in one standardized format: endpoints, HTTP methods, request DTOs, responses, validation, permissions, pagination, errors, and events.
