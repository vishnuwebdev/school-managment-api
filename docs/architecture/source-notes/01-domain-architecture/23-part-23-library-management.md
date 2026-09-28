<!-- Source: Apple Notes, folder 'Notes' -->
# Part 23 — Library Management

Library Management should be treated as an independent operational domain.
The core principle is:
Library owns library resources and circulation. It does not own students, teachers, fees, or communication.
It references those domains when needed.

23.1 Domain Purpose
Library
├── Library Configuration
├── Library Branch / Location
├── Shelves / Sections
├── Books / Resources
├── Authors / Publishers
├── Book Copies
├── Members
├── Circulation
├── Reservations
├── Returns
├── Fines
└── Library History
Future extensions:
├── Digital Resources
├── E-Books
├── Barcode / RFID
├── Acquisition
├── Supplier Management
└── Advanced Library Analytics

23.2 Ownership
Library owns:
Library resources/catalog
Physical copies
Library locations
Shelves/categories
Library membership
Loans
Returns
Reservations
Library fines
Library circulation history
It references:
Students
Teachers
Staff/users
Academic structure
School settings
It does not own:
Student profiles
Teacher profiles
School fees
User accounts
Communication
Payments

23.3 Book vs Book Copy
This distinction is foundational.
A book/resource represents the intellectual/catalog item:
Book
Title: Mathematics Fundamentals
ISBN: ...
Publisher: ...
Author: ...
A copy represents a physical item:
Copy
Copy Number: LIB-000231
Barcode: ...
Location: Shelf A3
Status: Available
One book can have many copies.
Book
 ├── Copy 1
 ├── Copy 2
 ├── Copy 3
 └── Copy 4
Do not store circulation directly against the abstract book.

23.4 Resource Types
The architecture should not assume everything is a printed book.
Potential resource types:
Book
Magazine
Journal
Reference Material
Newspaper
DVD / Media
Digital Resource
Other
Initially, the system can support primarily books while keeping the model extensible.

23.5 Catalog Information
A library resource may contain:
Title
Subtitle
ISBN
Edition
Language
Publisher
Publication Year
Authors
Categories
Description
Classification
Exact metadata requirements can be refined later.

23.6 Authors and Publishers
Authors and publishers should be reusable catalog entities.
Example:
Author
    ↓
Book A
Book B
Book C
rather than duplicating author text in every record.
However, historical circulation does not depend on modifying author metadata.

23.7 Library Locations
A school may have:
Library
├── Main Library
├── Primary Library
└── Reference Room
V1 can support one library location while remaining structurally capable of multiple locations later.

23.8 Shelves / Sections
A physical organization structure might be:
Library
 ↓
Section
 ↓
Shelf
 ↓
Book Copy
Example:
Science
 ├── Physics
 ├── Chemistry
 └── Biology
This is operational organization, not the same thing as Academic Management's subjects.

23.9 Library Membership
A student or teacher may be eligible to borrow resources.
Membership should be separate from the person's identity.
Student
   ↓
Library Membership
   ↓
Library Circulation
Likewise:
Teacher
   ↓
Library Membership
This allows library-specific rules without modifying Student or Teacher Management.

23.10 Membership Status
Example lifecycle:
Pending
 ↓
Active
 ↓
Suspended
 ↓
Expired / Closed
Suspension could occur because of:
overdue items,
administrative action,
lost items,
school policy.

23.11 Borrowing / Loan
The central library transaction is:
Member
 ↓
Loan
 ↓
Book Copy
A loan should record:
Copy
Member
Issue Date
Due Date
Return Date
Issued By
Returned By
Status

23.12 Loan Lifecycle
Recommended:
Issued
 ↓
Due
 ↓
Overdue
 ↓
Returned
Potential additional states:
Lost
Damaged
Cancelled
The exact state model can be refined later.

23.13 Return
Returning a book should update the copy's operational availability.
Example:
Loan
   ↓
Return
   ↓
Book Copy = Available
If the book is damaged or lost:
Return
 ↓
Condition Assessment
 ↓
Damaged / Lost

23.14 Book Copy Lifecycle
A copy needs its own lifecycle.
For example:
Available
 ↓
Issued
 ↓
Available
Other states:
Reserved
Lost
Damaged
Under Repair
Withdrawn
Retired
A copy being lost should not be treated as deleting it from history.

23.15 Reservations
A member may reserve a resource when all copies are unavailable.
Member
 ↓
Reservation
 ↓
Book
Important distinction:
A reservation is normally against the catalog resource, while a loan is against a specific physical copy.

23.16 Reservation Lifecycle
Requested
 ↓
Queued
 ↓
Available
 ↓
Fulfilled
Alternative:
Cancelled
Expired

23.17 Reservation Queue
If several people reserve the same book:
Book
 ↓
Reservation Queue
 ├── Member A
 ├── Member B
 └── Member C
The queue should have deterministic ordering.
Usually:
Created At
with appropriate handling for cancellations and priority rules.

23.18 Borrowing Rules
Schools may configure rules such as:
Maximum active loans
Default loan duration
Maximum renewal count
Maximum reservation count
Fine policy
Member-specific limits
These belong to Library configuration.

23.19 Different Member Rules
For example:
Student
Maximum Loans: 3

Teacher
Maximum Loans: 10
Do not hardcode these differences into application logic.
They should be configurable policy.

23.20 Renewals
A loan may be renewed if policy permits.
Loan
 ↓
Renew
 ↓
New Due Date
The original issue history should remain preserved.
Potential restrictions:
Cannot renew if:
- Reservation exists
- Maximum renewals reached
- Member suspended
- Item already overdue beyond threshold

23.21 Fines
Library may calculate a fine for:
Overdue
Lost
Damaged
But there is an important domain boundary:
Library owns the library fine/assessment; Fee Management owns financial collection.
Therefore:
Library
 ↓
Library Fine
 ↓
Fee Management
 ↓
Payment
Library should not create its own duplicate payment system.

23.22 Library Fine vs Fee Demand
A library fine can become a financial obligation.
Example:
Book overdue
 ↓
Library calculates ₹50 fine
 ↓
Library Fine
 ↓
Fee Management creates/records applicable charge
 ↓
Payment
The exact integration mechanism can be designed later.

23.23 Fine Adjustments
Library may allow:
Waive
Reduce
Cancel
But if the financial obligation has already entered Fee Management, the corresponding financial adjustment should be handled by the Fees domain.
This prevents two domains from modifying the same financial record.

23.24 Payment Boundary
Library:
"₹50 library fine exists."
Fees:
"₹50 is financially owed and ₹50 was paid."
This preserves the domain boundary established earlier.

23.25 Lost Book
Lost resources require special treatment.
Example:
Copy
 ↓
Lost
 ↓
Replacement Cost
 ↓
Library Fine / Charge
 ↓
Fee Management
The copy remains historically visible.

23.26 Damaged Book
Similarly:
Copy
 ↓
Damaged
 ↓
Assessment
 ↓
Repair / Replacement
The library may retain the copy but change its availability.

23.27 Student Integration
Library should access students through references:
Library
   ↓
Student ID
It should not duplicate:
Student Name
Student Address
Guardian Details
as authoritative student data.
A historical snapshot may be appropriate in reports or transaction records when required.

23.28 Teacher Integration
Same principle:
Teacher
 ↓
Library Membership
Library does not own employment information.

23.29 User Account Integration
A librarian may be:
User
 ↓
Membership
 ↓
Role
 ↓
Library Permissions
This follows the central identity architecture.

23.30 Librarian Role
Potential permissions:
library.view
library.manage
library.catalog.manage
library.copy.manage
library.member.manage
library.issue
library.return
library.renew
library.reserve
library.fine.manage
library.report.export
A teacher should not automatically receive these permissions merely because they are a teacher.

23.31 Student/Teacher Access
Possible scoped capabilities:
Student
→ View own loans
→ View own reservations
→ Request reservation

Teacher
→ View own loans
→ Reserve resources
The actual permissions depend on school configuration.

23.32 Search
Library search is a major usability requirement.
Search fields could include:
Title
ISBN
Author
Publisher
Category
Barcode
Copy Number
Classification
Search results must remain tenant-scoped.

23.33 Barcode / RFID
The architecture should allow:
Book Copy
 ↓
Barcode
and later:
Book Copy
 ↓
RFID Tag
Do not make RFID a core dependency for V1.

23.34 Bulk Import
Libraries often already have catalogs.
Support:
Catalog Import
 ↓
Validation
 ↓
Duplicate Detection
 ↓
Preview
 ↓
Confirm
 ↓
Background Import
Potential duplicate keys:
ISBN
Barcode
Copy Number
depending on resource type.

23.35 Library Reports
Initial reports:
Catalog
Available Copies
Currently Issued
Overdue Items
Lost Items
Damaged Items
Member Activity
Borrowing History
Reservation Queue
Fine Summary
Financial collection reports remain in Fee Management.

23.36 Communication Integration
Library can emit events:
LoanDueSoon
LoanOverdue
ReservationAvailable
BookLost
Communication can consume them:
Library Event
 ↓
Communication
 ↓
Email / SMS / Push / In-App
Library should not directly call communication providers.

23.37 Events
Library may emit:
BookCreated
BookUpdated
BookCopyCreated
BookCopyStatusChanged

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
Event payloads should contain references rather than unnecessary duplicated personal information.

23.38 Audit
Audit important operations:
Catalog created/updated
Copy added/removed
Copy status changed
Membership changed
Book issued
Book returned
Loan renewed
Reservation changed
Fine adjusted
Fine waived
Especially:
Fine adjustment
Fine waiver
Lost-book handling
because these may have financial consequences.

23.39 Configuration
Library configuration should be separate from circulation data.
Library Configuration
├── Loan Limits
├── Loan Duration
├── Renewal Rules
├── Fine Rules
├── Reservation Rules
└── Member Policies
Changing a policy should not rewrite historical loans.

23.40 Historical Integrity
Suppose:
2026:
Loan duration = 14 days
Later:
2027:
Loan duration = 21 days
The old loan should still show its original due date.
Therefore, applicable policy/configuration should be captured or versioned when necessary.

23.41 Feature Structure
Initial:
Library
├── Catalog
├── Book Copies
├── Members
├── Circulation
├── Reservations
├── Fines
└── Reports
Future:
├── Digital Library
├── Barcode/RFID
├── Acquisition
├── Suppliers
└── Advanced Analytics

23.42 Entitlement
Core capability:
library
Potential future capabilities:
library.digital
library.rfid
library.advanced
Again, commercial separation should only be introduced where useful to the product model.

23.43 Tenant Boundary
Every library entity is tenant-owned.
For example:
Book
Book Copy
Library Member
Loan
Reservation
Fine
must never be accessible across schools.
A barcode or ISBN is not sufficient to establish tenant ownership.

23.44 Concurrency
Library circulation has an important concurrency problem.
Two librarians could attempt:
Issue same copy
simultaneously.
The system must ensure only one succeeds.
Use appropriate:
database constraints,
transactions,
row/version locking,
state validation.
This is a business correctness requirement, not merely an API concern.

23.45 Example Circulation Transaction
Issue Copy
   ↓
Validate Member
   ↓
Validate Member Limits
   ↓
Validate Copy Available
   ↓
Validate Reservation Rules
   ↓
Create Loan
   ↓
Change Copy → Issued
   ↓
Commit
   ↓
Emit BookIssued
The copy and loan state should change atomically.

23.46 Reservation Race Condition
If a copy becomes available:
Return
 ↓
Available
 ↓
Reservation Queue
 ↓
Fulfill first eligible reservation
This should happen transactionally enough to avoid multiple users being promised the same copy.

23.47 Architecture Position
The resulting dependency direction is:
Student ──────────┐
Teacher ──────────┤
Academic ─────────┤
                  ↓
              LIBRARY
                  │
             ┌────┴────┐
             ↓         ↓
       Circulation   Reservations
             │
             ↓
        Library Fine
             │
             ↓
       Fee Management
Communication consumes Library events independently:
Library
   ↓
Domain Events
   ↓
Communication

23.48 What We Should Not Finalize Yet
Defer:
❌ Exact catalog metadata standard
❌ RFID vendor
❌ Barcode hardware
❌ Digital library provider
❌ Supplier/procurement system
❌ Advanced acquisition workflow
❌ Complex inter-library loans
❌ Full accounting integration
These can be added without changing the fundamental circulation model.

23.49 Final Library Model
                    LIBRARY
                       │
          ┌────────────┼────────────┐
          ↓            ↓            ↓
       Catalog       Members      Configuration
          │            │
          ↓            │
     Book Copies       │
          │            │
          └──────┬─────┘
                 ↓
              Loans
                 │
       ┌─────────┼─────────┐
       ↓         ↓         ↓
   Returns   Renewals  Reservations
       │
       ↓
   Lost/Damaged
       │
       ↓
  Library Fine
       │
       ↓
 Fee Management
       │
       ↓
    Payment
This gives us a clean boundary: Library determines what happened to the library resource; Fees determines what money is owed or paid.
Next: Part 24 — Leave & Staff Operations, where we need to carefully separate staff leave, teacher availability, timetable substitutions, and future HR/payroll concerns.
