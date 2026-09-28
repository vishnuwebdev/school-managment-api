<!-- Source: Apple Notes, folder 'Core Database design system' -->
# Part 38 — Library Database Design

Library Management introduces another important pattern:
The catalog describes what the school owns; circulation records what happened to a particular physical copy.
The core model is:
Resource
   ↓
Book Copy
   ↓
Library Loan
   ↓
Return

Resource
   ↓
Reservation

Loan / Return
   ↓
Fine
   ↓
Optional financial obligation
   ↓
Fees

38.1 Library Ownership
Library owns:
Library Configuration
Library Locations
Shelves / Sections
Resources / Books
Authors
Publishers
Book Copies
Library Members
Loans
Returns
Reservations
Library Fines
Circulation History
It references:
Student
Teacher
Staff/User
Academic context
It does not own:
Student
Teacher
Fees
Payment
Communication

38.2 Resource vs Physical Copy
This is the most important Library modeling decision.
A catalog resource is:
What is the publication/resource?
A copy is:
Which physical item does the school actually own?
Example:
Book
"The Science of Physics"
       │
       ├── Copy 001
       ├── Copy 002
       ├── Copy 003
       └── Copy 004
Never put loan status directly on the catalog-level Book.

38.3 Library Resource
Use a broader resources concept rather than permanently assuming everything is a book.
library_resources
-----------------
id
tenant_id
resource_type
title
subtitle
isbn
edition
publication_year
language
classification
description
status
created_at
updated_at
resource_type could eventually support:
BOOK
MAGAZINE
JOURNAL
REFERENCE
OTHER

38.4 Why Resource Instead of Book
This leaves room for future:
Digital Resource
Periodical
Reference Material
Audio/Video
without redesigning circulation around the assumption that everything is a book.

38.5 Authors
Authors are catalog entities:
library_authors
--------------
id
tenant_id
name
status
created_at
updated_at
A resource can have multiple authors.

38.6 Resource–Author Relationship
resource_authors
----------------
resource_id
author_id
display_order
This supports:
Book
 ├── Author A
 ├── Author B
 └── Author C

38.7 Publishers
Publishers can be modeled separately:
publishers
----------
id
tenant_id
name
status
created_at
updated_at
A resource can reference a publisher.

38.8 Categories / Classification
Library should support configurable classification.
Conceptually:
library_categories
------------------
id
tenant_id
name
code
parent_id nullable
status
A shallow hierarchy is enough initially.

38.9 Library Location
A school may have:
Main Library
Secondary Library
Reference Room
Conceptually:
library_locations
-----------------
id
tenant_id
name
code
status
created_at
updated_at

38.10 Shelves / Sections
Within a location:
library_shelves
--------------
id
tenant_id
location_id
name
code
status
Example:
Main Library
 ├── Science
 ├── Mathematics
 ├── Literature
 └── Reference

38.11 Physical Copy
A physical copy represents an actual item.
library_copies
--------------
id
tenant_id
resource_id
copy_number
barcode
location_id
shelf_id
status
acquired_at
retired_at
created_at
updated_at
Example:
Science Book
 ├── Copy 001 → Available
 ├── Copy 002 → Issued
 └── Copy 003 → Damaged

38.12 Copy Lifecycle
Initial states:
AVAILABLE
   ↓
ISSUED
   ↓
AVAILABLE
Other states:
RESERVED
LOST
DAMAGED
UNDER_REPAIR
WITHDRAWN
RETIRED
The actual lifecycle should prevent invalid transitions.

38.13 Barcode
A copy may have a barcode:
barcode
It should normally be unique within the tenant:
UNIQUE(tenant_id, barcode)
The barcode is a business identifier, not the database primary key.

38.14 Library Member
Library membership should be separate from the underlying person's identity.
library_members
---------------
id
tenant_id
member_type
student_id nullable
teacher_id nullable
user_id nullable
membership_number
status
joined_at
ended_at
created_at
updated_at
This allows:
Student
Teacher
Staff
to participate in library operations without making Library responsible for their identity.

38.15 Why Library Membership Exists
A person may be:
Teacher
but not currently have library access.
Or:
Student
may have a suspended library membership.
Therefore:
Student ≠ Library Member

38.16 Membership Number
Library membership numbers should be tenant-scoped:
UNIQUE(tenant_id, membership_number)

38.17 Loan
A loan represents a copy being issued to a member.
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
issued_by
returned_by
created_at
updated_at
The loan points to the physical copy, not merely the resource.

38.18 Loan Lifecycle
Recommended:
ISSUED
   ↓
DUE
   ↓
OVERDUE
   ↓
RETURNED
Other outcomes:
LOST
DAMAGED
CANCELLED

38.19 Why Loan Must Reference Copy
If a library has:
Resource = Physics Book
Copies = 001, 002, 003
and Copy 002 is issued, the system needs to know exactly which physical item is outside the library.
Therefore:
Loan → Copy
not:
Loan → Resource

38.20 Return
A return is part of circulation history.
For simple V1, returned_at and returned_by can be recorded directly on Loan.
If the workflow becomes more complex, a separate return record can be introduced.
For now:
Loan
 ├── issued_at
 ├── due_at
 ├── returned_at
 └── returned_by
is sufficient.

38.21 Renewals
Renewals should preserve history.
Do not simply overwrite:
due_at
without knowing the previous due date.
A future loan_renewals table can record:
loan_id
old_due_at
new_due_at
renewed_by
reason
created_at
This should be included if renewal history is a V1 requirement.

38.22 Reservation
Reservations apply to a resource rather than necessarily to a specific copy.
library_reservations
--------------------
id
tenant_id
resource_id
member_id
status
requested_at
expires_at
fulfilled_at
cancelled_at
created_at
updated_at
Example:
Resource
"The Science of Physics"
       ↓
Reservation Queue
 ├── Student A
 ├── Student B
 └── Student C

38.23 Reservation vs Loan
Important distinction:
Reservation → Resource
Loan        → Copy
A reservation can be fulfilled when any suitable copy becomes available.

38.24 Reservation Lifecycle
REQUESTED
   ↓
QUEUED
   ↓
AVAILABLE
   ↓
FULFILLED
or:
CANCELLED
EXPIRED

38.25 Fine
Library owns the fine calculation.
library_fines
------------
id
tenant_id
loan_id
member_id
fine_type
amount
reason
status
created_at
updated_at
Examples:
OVERDUE
LOST
DAMAGED
OTHER

38.26 Fine vs Payment
Library Fine:
The library determines that the member owes an amount.
Fee Management:
The school records and collects the financial obligation.
Therefore:
Library Fine
      ↓
Fee Charge / Financial Obligation
      ↓
Fee Payment

38.27 Fine Adjustment
A librarian may have permission to reduce a fine.
That should be a business action:
Fine
 ↓
Adjustment
 ↓
Audit
rather than silently changing:
amount

38.28 Fine Status
Potential states:
CALCULATED
ADJUSTED
REFERRED_TO_FEES
WAIVED
PAID
CANCELLED
The exact relationship to Fees can be refined when the integration is implemented.

38.29 Library → Fees Integration
A clean boundary is:
Library
   ↓
Library Fine
   ↓
Fee Obligation
   ↓
Fee Demand
   ↓
Payment
The Library does not need to know:
how payment was made,
receipt numbering,
gateway processing,
refunds.

38.30 Copy Availability
Issuing a copy requires concurrency protection.
Example:
Copy 001 = AVAILABLE
Two librarians simultaneously attempt to issue it.
Only one transaction should succeed.
The database/application should use:
transaction,
row lock or equivalent,
state validation.

38.31 Copy Issuance Transaction
Conceptually:
BEGIN
 ↓
Lock Copy
 ↓
Verify AVAILABLE
 ↓
Create Loan
 ↓
Set Copy = ISSUED
 ↓
COMMIT
This prevents double issuance.

38.32 Return Transaction
Similarly:
BEGIN
 ↓
Lock Loan/Copy
 ↓
Verify active loan
 ↓
Record Return
 ↓
Set Copy = AVAILABLE
 ↓
Calculate Fine if applicable
 ↓
COMMIT
Notification/communication should happen asynchronously after the transaction.

38.33 Loan Policy
Library configuration may define:
max_active_loans
loan_duration_days
max_renewals
reservation_limit
fine_rule
member eligibility
These should belong to Library configuration.

38.34 Loan Policy Versioning
If a school changes:
loan period = 14 days
to:
loan period = 21 days
existing loans should not automatically receive the new due date.
The issued loan should preserve its actual due date.

38.35 Student Eligibility
Library can reference Student status/enrollment to determine eligibility, but it should not own Student rules.
For example:
Student = Archived
may prevent a new library loan.
That is a Library business rule using Student information.

38.36 Teacher Eligibility
Likewise:
Teacher = Active
may be required for borrowing.
Library should not modify the Teacher record.

38.37 Library Search
The catalog should support tenant-scoped search by:
Title
ISBN
Author
Publisher
Category
Barcode
Copy Number
Classification
Search indexes must remain tenant-isolated.

38.38 Library Permissions
Examples:
library.view
library.catalog.create
library.catalog.update
library.catalog.archive

library.copy.create
library.copy.update
library.copy.status

library.member.view
library.member.manage

library.loan.issue
library.loan.return
library.loan.renew

library.reservation.create
library.reservation.cancel

library.fine.view
library.fine.adjust
library.fine.waive

library.export

38.39 Library Events
Important events:
LibraryResourceCreated
LibraryResourceUpdated
LibraryCopyCreated
LibraryCopyStatusChanged
LibraryMemberCreated
LibraryMemberSuspended
BookIssued
BookReturned
BookRenewed
BookReserved
ReservationFulfilled
ReservationCancelled
LibraryFineCreated
LibraryFineAdjusted

38.40 Communication Integration
Communication can consume:
LoanDueSoon
LoanOverdue
ReservationAvailable
BookIssued
BookReturned
Library does not send email/SMS directly.

38.41 Reporting Integration
Reporting can consume:
BookIssued
BookReturned
ReservationFulfilled
LibraryFineCreated
to produce:
Circulation statistics
Overdue statistics
Popular resources
Member activity
Fine statistics
Copy utilization

38.42 Library Audit
Audit should cover:
Catalog changes
Copy status changes
Loan issue
Loan return
Renewal
Reservation changes
Fine adjustments
Fine waivers
Fine adjustments and waivers should be especially controlled.

38.43 Bulk Catalog Import
Library is a natural bulk-import domain.
Workflow:
File
 ↓
Parse
 ↓
Validate
 ↓
Preview
 ↓
Confirm
 ↓
Background Import
 ↓
Result
Duplicate detection can use:
ISBN
+
title
+
edition
but should not automatically merge records without explicit rules.

38.44 Resource vs Copy Import
Bulk import should distinguish:
Catalog resources
from:
Physical copies
For example:
1 catalog record
+
20 physical copies
should not create 20 separate book titles.

38.45 Tenant Isolation
Every Library-owned table should be tenant-scoped:
library_resources.tenant_id
library_authors.tenant_id
publishers.tenant_id
library_copies.tenant_id
library_locations.tenant_id
library_shelves.tenant_id
library_members.tenant_id
library_loans.tenant_id
library_reservations.tenant_id
library_fines.tenant_id
Cross-tenant circulation must be impossible.

38.46 Important Constraints
Examples:
UNIQUE(tenant_id, barcode)

UNIQUE(tenant_id, membership_number)

UNIQUE(tenant_id, copy_number)
The exact copy-number uniqueness may be scoped to a resource:
UNIQUE(tenant_id, resource_id, copy_number)
depending on how the school labels copies.

38.47 Loan Constraints
A copy should not have multiple active loans.
Conceptually:
one active loan
per copy
This can be enforced through an appropriate unique/partial index or equivalent database mechanism.

38.48 Reservation Constraints
A member should not create unlimited duplicate active reservations for the same resource unless the policy explicitly permits it.
A useful constraint is conceptually:
one active reservation
per member + resource

38.49 Indexing
Likely high-value indexes:
resources:
  (tenant_id, title)
  (tenant_id, isbn)
  (tenant_id, status)

copies:
  (tenant_id, resource_id, status)
  (tenant_id, barcode)

loans:
  (tenant_id, member_id, status)
  (tenant_id, copy_id, status)
  (tenant_id, due_at, status)

reservations:
  (tenant_id, resource_id, status)
  (tenant_id, member_id, status)

fines:
  (tenant_id, member_id, status)
  (tenant_id, loan_id)

38.50 Library Relationship Diagram
Resource
  │
  ├── Authors
  ├── Publisher
  └── Copies
        │
        ↓
      Loan
        │
        ├── Member
        ├── Due Date
        └── Return
              │
              ↓
             Fine
              │
              ↓
             Fees

Resource
   ↓
Reservation
   ↓
Member

38.51 Library Member Relationship
Student ────────┐
Teacher ────────┼──→ Library Member
Staff/User ─────┘
                      │
                      ↓
                    Loan
Library Member is the Library domain's participation record.

38.52 Historical Integrity
Suppose:
Copy 001
Resource = Book A
is later:
Withdrawn
Historical loans still reference Copy 001.
Do not delete or repurpose the copy identifier.

38.53 Copy Status vs Loan Status
Keep these separate.
Copy Status
= physical item's current condition/location

Loan Status
= circulation transaction's current state
For example:
Copy = DAMAGED
Loan = RETURNED
This is perfectly valid.

38.54 Resource Status vs Copy Status
Similarly:
Resource = ACTIVE
Copy 001 = RETIRED
Copy 002 = AVAILABLE
The catalog resource can remain active even when individual copies are retired.

38.55 Digital Library — Deferred
The resource abstraction allows a future:
DIGITAL_RESOURCE
but V1 does not need to design:
digital licensing,
DRM,
streaming,
ebook providers.
The physical circulation model remains clean.

38.56 Acquisition — Deferred
Future Library functionality may add:
Suppliers
Purchase Orders
Acquisitions
Donations
Stock Verification
These should be separate capabilities rather than being forced into the initial circulation schema.

38.57 RFID / Barcode Scanning — Deferred
Barcode is supported as a copy identifier.
RFID can later become an operational integration without changing:
Resource
Copy
Loan
Return
ownership.

38.58 Current Dependency Graph
Student ────────┐
Teacher ────────┼──→ Library
Academic ───────┘      │
                       ├──→ Loan
                       ├──→ Reservation
                       └──→ Fine
                              │
                              ↓
                             Fees
                              │
                    ┌─────────┴─────────┐
                    ↓                   ↓
              Communication        Reporting
The graph remains directional.

38.59 Key Decisions Locked
✓ Resource ≠ Physical Copy
✓ Loan references Copy
✓ Reservation references Resource
✓ Library Member ≠ Student/Teacher/User
✓ Copy lifecycle is separate from Loan lifecycle
✓ Fine belongs to Library
✓ Fee collection belongs to Fees
✓ Historical loans remain intact
✓ Copy issuance is concurrency-safe
✓ Loan policy is configuration
✓ Catalog supports future resource types
✓ Communication is event-driven
✓ Reporting is downstream
✓ Tenant isolation applies throughout

38.60 What This Enables
The design supports:
catalog management,
multiple physical copies,
barcode-based circulation,
multiple library locations,
shelves,
student/teacher borrowing,
due dates,
overdue loans,
renewals,
reservations,
fines,
fine-to-fee integration,
future RFID,
future digital resources,
future acquisition management.
without making Library dependent on Fees or Student Management for ownership.

Next: Part 39 — Leave & Staff Operations Database Design
The next phase will model:
Leave Types
Leave Policies
Leave Balances
Leave Requests
Approvals
Leave Periods
Staff Availability
The most important relationship will be:
Teacher / Staff
      ↓
Leave Request
      ↓
Approval
      ↓
Staff Unavailable
      ↓
Timetable
      ↓
Substitution
while keeping leave, attendance, payroll, and timetable ownership separate.
