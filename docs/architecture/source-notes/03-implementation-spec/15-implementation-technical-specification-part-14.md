<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 14

Library Management
Library Management should model catalogue records separately from physical copies.
The core distinction is:
Book Title
   ↓
Physical Copy
   ↓
Library Circulation
   ↓
Issue / Return / Renewal
This prevents problems when a school owns multiple copies of the same book.

555. Domain Boundary
Library owns:
library catalogue
authors
publishers
categories
book copies
library members
circulation
loans
renewals
reservations
fines
lost/damaged processing
library configuration
library reports
It does not own:
students
teachers
academic classes
fee accounts
payment processing
files
It references those domains through application interfaces.

556. Catalogue vs Copy
Catalogue item
Represents the intellectual work.
Mathematics for Grade 5
ISBN ...
Author ...
Publisher ...
Copy
Represents one physical item.
Copy #001
Copy #002
Copy #003
Each copy has its own:
barcode/accession number
condition
status
location
circulation history

557. Book Catalogue
library_books
------------
id
tenant_id
isbn
title
subtitle
edition
publication_year
publisher_id
language
description
category_id
status
created_at
updated_at
version
Status:
ACTIVE
INACTIVE
ARCHIVED
ISBN is not necessarily mandatory because schools may catalogue older/local material without an ISBN.

558. Authors
library_authors
---------------
id
tenant_id
name
description
status
created_at
updated_at
Many-to-many:
library_book_authors
--------------------
book_id
author_id
sequence
This supports multiple authors.

559. Publishers
library_publishers
------------------
id
tenant_id
name
contact_details
status
created_at
updated_at
Contact information can be extended later without changing book records.

560. Categories
library_categories
-----------------
id
tenant_id
name
code
parent_category_id
status
created_at
updated_at
A shallow hierarchy is sufficient initially.
Example:
Science
 ├── Physics
 ├── Chemistry
 └── Biology

561. Physical Copies
library_copies
-------------
id
tenant_id
book_id
accession_number
barcode
location_id
acquisition_date
acquisition_cost
condition
status
created_at
updated_at
version
Status:
AVAILABLE
ISSUED
RESERVED
LOST
DAMAGED
UNDER_REPAIR
WITHDRAWN

562. Copy Identity
Each physical copy must have a unique accession number.
UNIQUE(tenant_id, accession_number)
Barcode can also be unique per tenant.

563. Library Locations
library_locations
-----------------
id
tenant_id
code
name
description
status
created_at
updated_at
Examples:
MAIN_LIBRARY
SCIENCE_SECTION
REFERENCE
STORAGE

564. Library Members
A member is a library participant, but should not duplicate User/Student/Teacher identity.
library_members
--------------
id
tenant_id
member_type
student_id
teacher_id
user_id
membership_number
status
joined_at
expires_at
created_at
updated_at
version
Member types:
STUDENT
TEACHER
STAFF
OTHER
Exactly one primary identity should normally be associated with a membership.

565. Membership Number
Unique per tenant:
tenant_id + membership_number
Do not use a student's student number as the library membership number automatically.
The library may have independent numbering requirements.

566. Library Configuration
library_settings
----------------
id
tenant_id
default_loan_days
maximum_renewals
maximum_active_loans
fine_per_day
lost_book_policy
reservation_enabled
status
created_at
updated_at
version
Configuration must remain tenant-specific.

567. Loan Policy
Different member groups may have different limits.
library_loan_policies
---------------------
id
tenant_id
member_type
loan_duration_days
max_active_loans
max_renewals
fine_per_day
status
created_at
updated_at
Example:
Student → 14 days / 3 books
Teacher → 30 days / 10 books

568. Library Loan
A loan represents one circulation transaction.
library_loans
-------------
id
tenant_id
copy_id
member_id
issued_at
due_at
returned_at
status
renewal_count
issued_by
returned_by
created_at
updated_at
version
Status:
ISSUED
OVERDUE
RETURNED
LOST
CANCELLED

569. Issue Flow
Scan Member
 ↓
Validate Membership
 ↓
Validate Loan Eligibility
 ↓
Scan Book Copy
 ↓
Validate Copy Available
 ↓
Calculate Due Date
 ↓
Create Loan
 ↓
Copy → ISSUED
The issue operation must be transactional.

570. Issue Eligibility
Before issuing:
member active
+
membership not expired
+
loan limit not exceeded
+
no blocking restriction
+
copy available
Optional future policies:
outstanding fines
overdue loan limit
class restrictions

571. Return Flow
Scan Copy
 ↓
Find Active Loan
 ↓
Record Return
 ↓
Calculate Overdue
 ↓
Calculate Fine
 ↓
Copy → AVAILABLE
The return operation should be atomic.

572. Due Date
Due date is calculated when the loan is issued.
Do not recalculate historical due dates when library policy changes later.
Store:
issued_at
due_at

573. Overdue Status
An active loan becomes overdue when:
current business date > due_date
and:
status = ISSUED
A scheduled job may update status, but queries should not depend exclusively on the job.

574. Renewal
library_renewals
----------------
id
tenant_id
loan_id
renewal_number
old_due_at
new_due_at
renewed_by
reason
created_at
Renewal is transactional.
The system checks:
renewal limit
active loan
member eligibility
reservation status
overdue restrictions

575. Renewal Count
Store renewal_count on the loan for efficient reads, but preserve each renewal in the renewal history table.
This follows the same source-of-truth/derived-state principle used elsewhere.

576. Reservations
library_reservations
--------------------
id
tenant_id
book_id
member_id
requested_at
status
expires_at
fulfilled_at
cancelled_at
created_at
updated_at
version
Status:
REQUESTED
READY
FULFILLED
EXPIRED
CANCELLED
Reservations should be made against the book title, not necessarily a specific physical copy.

577. Reservation Queue
Multiple members may reserve the same book.
Ordering:
requested_at
determines the queue unless the tenant configures another policy.
A copy becoming available can trigger:
Book Available
 ↓
Next Reservation
 ↓
READY
 ↓
Notification

578. Reservation Expiry
A READY reservation should have a configurable pickup window.
If not fulfilled:
READY
 ↓
EXPIRED
 ↓
Next Reservation
This can be handled asynchronously.

579. Fines
Fine calculation should be explicit.
library_fines
------------
id
tenant_id
loan_id
member_id
fine_type
calculated_amount
waived_amount
outstanding_amount
status
created_at
updated_at
version
Fine types:
OVERDUE
LOST
DAMAGED
OTHER

580. Fine Calculation
For overdue:
overdue_days
×
fine_per_day
=
calculated_fine
But preserve the rate used.
fine_rate_snapshot
This prevents future policy changes from altering historical fines.

581. Fine Waiver
Fine waiver should be explicit.
fine_waivers
-----------
id
tenant_id
fine_id
amount
reason
requested_by
approved_by
status
created_at
approved_at
Status:
REQUESTED
APPROVED
REJECTED
APPLIED

582. Library Fee Integration
Library should not directly manipulate Fee Management's payment tables.
Instead:
Library Fine
 ↓
Fee Integration Request
 ↓
Fee Demand
 ↓
Payment
If the school wants library fines collected through its fee system, Fee Management owns the receivable.

583. Lost Book
A lost copy transitions:
ISSUED
 ↓
LOST
The loan remains historically intact.
A replacement charge can be created through Fee Management.

584. Damaged Book
ISSUED
 ↓
DAMAGED
The library can record:
damage_type
damage_description
assessed_cost

585. Book Condition
Recommended values:
NEW
GOOD
FAIR
DAMAGED
UNUSABLE
Condition changes should be audited.

586. Acquisition
V1 can support basic acquisition metadata:
acquisition_date
acquisition_cost
supplier
A full procurement domain is unnecessary unless procurement becomes a product requirement.

587. Withdrawal
A physical copy can be withdrawn:
AVAILABLE
 ↓
WITHDRAWN
Withdrawal requires:
reason
actor
timestamp
A withdrawn copy must never be issued.

588. Library Permissions
library.view
library.manage_catalogue

library.copy.view
library.copy.manage

library.member.view
library.member.manage

library.loan.view
library.loan.issue
library.loan.return
library.loan.renew

library.reservation.view
library.reservation.create
library.reservation.manage

library.fine.view
library.fine.waive

library.report.view
library.export

589. APIs
Catalogue:
/api/v1/library/books
/api/v1/library/books/:id
/api/v1/library/authors
/api/v1/library/publishers
/api/v1/library/categories
Copies:
/api/v1/library/books/:id/copies
/api/v1/library/copies/:id
Members:
/api/v1/library/members
/api/v1/library/members/:id
Loans:
/api/v1/library/loans
/api/v1/library/loans/:id
/api/v1/library/loans/:id/renew
/api/v1/library/loans/:id/return
Reservations:
/api/v1/library/reservations
/api/v1/library/reservations/:id
Fines:
/api/v1/library/fines
/api/v1/library/fines/:id

590. Library Application Services
CreateBook
CreateBookCopy
UpdateBook
ArchiveBook

CreateLibraryMember
ActivateLibraryMember
SuspendLibraryMember

IssueBook
ReturnBook
RenewLoan

ReserveBook
CancelReservation
FulfillReservation

CalculateFine
WaiveFine
MarkCopyLost
MarkCopyDamaged
WithdrawCopy

591. Circulation Concurrency
Book issue/return is concurrency-sensitive.
Example:
Copy = AVAILABLE

Operator A → Issue
Operator B → Issue
Only one can succeed.
Use:
transaction
row locking or optimistic versioning
copy status revalidation
The same applies to competing reservation fulfillment.

592. Issue Transaction
The issue transaction should atomically:
validate member
+
validate copy
+
validate limits
+
create loan
+
change copy status
+
write audit
+
write outbox event

593. Return Transaction
Return should atomically:
validate active loan
+
record returned_at
+
change loan status
+
change copy status
+
calculate applicable fine
+
write audit
+
write outbox event

594. Library Events
BookCreated
BookCopyCreated
BookCopyWithdrawn

LibraryMemberCreated
LibraryMemberSuspended

BookIssued
BookReturned
BookRenewed

BookReserved
ReservationReady
ReservationExpired

FineCreated
FineWaived

BookMarkedLost
BookMarkedDamaged

595. Notifications
Library events may trigger Communication:
Book due soon
Book overdue
Reservation ready
Reservation expired
Fine created
Communication remains responsible for actual delivery.

596. Student/Teacher Integration
Library member records reference:
student_id
teacher_id
The Student/Teacher domains remain authoritative.
If a student or teacher becomes inactive, Library can react to an event rather than directly changing the source entity.

597. Library Reports
Initial reports:
Catalogue Report
Available Books
Issued Books
Overdue Books
Member Loan Report
Fine Report
Lost/Damaged Books
Reservation Queue
Daily Circulation
Large exports should use the common background export mechanism.

598. Library Database Indexes
library_books:
  tenant_id, isbn
  tenant_id, title

library_copies:
  tenant_id, accession_number UNIQUE
  tenant_id, barcode UNIQUE
  tenant_id, book_id, status

library_members:
  tenant_id, membership_number UNIQUE
  tenant_id, student_id
  tenant_id, teacher_id

library_loans:
  tenant_id, copy_id, status
  tenant_id, member_id, status
  tenant_id, due_at, status

library_reservations:
  tenant_id, book_id, status
  tenant_id, member_id, status

library_fines:
  tenant_id, member_id, status
  tenant_id, loan_id

599. Library Tenant Isolation
Every library table is tenant-scoped.
A barcode such as:
BK-001
may exist in multiple schools.
Therefore uniqueness is:
tenant_id + barcode
not globally across the platform.

600. Library Audit
Audit:
catalogue modifications
copy creation/withdrawal
condition changes
membership changes
issue
return
renewal
reservation
fine creation
fine waiver
lost/damaged status
exports

601. Library Module Contract
Library
│
├── Catalogue
├── Authors
├── Publishers
├── Categories
├── Copies
├── Locations
├── Members
├── Loans
├── Renewals
├── Reservations
├── Fines
└── Library Configuration
Core lifecycle:
Book Catalogue
 ↓
Physical Copy
 ↓
Available
 ↓
Issued
 ↓
Returned
 ↓
Available
Exception paths:
Issued → Lost
Issued → Damaged
Available → Withdrawn
The critical architectural rule is:
Catalogue data describes what the school owns; copy data describes the physical item; circulation data describes what happened to that physical item.

Next Domain
The next specification will cover Transport Management, including routes, stops, vehicles, drivers, student transport assignments, pickup/drop-off points, transport fees integration, vehicle capacity and route scheduling.
