<!-- Source: Apple Notes, folder 'Core Database design system' -->
# Part 35 — Fee Management Database Design

Fee Management is the second major financial boundary in the system.
The most important rule remains:
PLATFORM BILLING
School → Subscription → Invoice → Platform Payment

SCHOOL FEES
Student/Guardian → Fee Demand → School Payment → Receipt
These must remain separate domains.

35.1 Fee Domain Ownership
Fee Management owns:
Fee Categories
Fee Structures
Fee Components
Student Fee Assignments
Fee Demands
Payments
Receipts
Discounts
Concessions
Waivers
Refunds
It references:
School
Student
Guardian
Enrollment
Academic Year
Class / Section
Transportation
Library
It does not own those entities.

35.2 Core Fee Flow
The conceptual lifecycle is:
Fee Category
     ↓
Fee Structure
     ↓
Fee Component
     ↓
Student Fee Assignment
     ↓
Fee Demand
     ↓
Payment
     ↓
Receipt
Adjustments can enter at several points:
Discount
Concession
Waiver
Late Fee
Refund

35.3 Fee Category
A category describes the business type of a fee.
fee_categories
--------------
id
tenant_id
name
code
description
status
created_at
updated_at
Examples:
Tuition
Transport
Library
Laboratory
Examination
Admission
Activity
Categories are configurable.

35.4 Fee Structure
A fee structure defines what a school intends to charge for a particular academic context.
fee_structures
--------------
id
tenant_id
name
code
academic_year_id
academic_class_id nullable
status
effective_from
effective_to
created_at
updated_at
Example:
2026–27
Grade 8
Standard Fee Structure

35.5 Fee Structure vs Student Charge
This distinction is critical.
A fee structure says:
Students matching this configuration normally have these charges.
A student fee assignment says:
This specific student actually has these obligations.
Therefore:
Fee Structure
      ↓
Student Fee Assignment
Do not directly generate every payment obligation from a mutable structure at payment time.

35.6 Fee Components
A structure contains individual components.
fee_components
--------------
id
tenant_id
fee_structure_id
fee_category_id
name
amount
frequency
due_rule
display_order
status
created_at
updated_at
Example:
Grade 8 Fee Structure
 ├── Tuition       ₹40,000
 ├── Laboratory     ₹5,000
 ├── Library        ₹2,000
 └── Activity       ₹1,500

35.7 Frequency
A component may be:
ONE_TIME
MONTHLY
QUARTERLY
HALF_YEARLY
ANNUAL
CUSTOM
Do not hardcode only annual fees.

35.8 Due Rules
A component can have:
due_date
due_day
due_period
installment rule
The exact recurring schedule model can be expanded later.
The important point is that the fee structure defines the intended charging rule, while the generated demand records the actual obligation.

35.9 Versioning Fee Structures
Fee structures must be historically safe.
Suppose:
Tuition = ₹40,000
is changed to:
Tuition = ₹45,000
Existing issued demands should not silently become ₹45,000.
Therefore prefer:
Fee Structure Version
or effective-dated structure records.
This is analogous to:
Plan Version
Grading Scheme Version

35.10 Student Fee Assignment
This creates the actual student's financial obligation context.
student_fee_assignments
-----------------------
id
tenant_id
student_id
enrollment_id
fee_structure_id
assigned_at
status
created_at
updated_at
This lets the school override the normal structure for a particular student.

35.11 Why Enrollment Reference Matters
Example:
Student
 ↓
Enrollment 2026–27
 ↓
Grade 8
 ↓
Fee Structure
If the student later moves classes, historical fee assignments remain associated with the correct academic context.

35.12 Assignment Adjustments
A student may have:
Standard fee = ₹50,000
Concession = ₹10,000
Final obligation = ₹40,000
Do not simply overwrite:
amount = 40000
Instead preserve the calculation components.

35.13 Fee Demand
Fee Demand represents the actual amount currently owed.
Conceptually:
fee_demands
-----------
id
tenant_id
student_id
enrollment_id
student_fee_assignment_id
fee_component_id
demand_number
original_amount
discount_amount
concession_amount
waiver_amount
late_fee_amount
final_amount
due_date
status
issued_at
cancelled_at
created_at
updated_at
The exact adjustment breakdown can later be normalized into separate records if needed.

35.14 Demand vs Invoice
For V1, calling this a Fee Demand keeps the domain concept clear:
The school is demanding payment from the student/guardian.
It does not need to be identical to an accounting invoice.
If formal tax/accounting requirements later require invoices, that can be introduced without redefining the entire fee model.

35.15 Demand Lifecycle
Recommended:
DRAFT
  ↓
ISSUED
  ↓
PARTIALLY_PAID
  ↓
PAID
Additional states:
OVERDUE
CANCELLED
WRITTEN_OFF
The actual transitions should be explicit.

35.16 Partial Payments
Suppose:
Demand = ₹10,000
Payment 1:
₹4,000
Payment 2:
₹6,000
The demand becomes:
PAID
Do not store only a mutable paid_amount without preserving the individual payment records.

35.17 Payment Allocation
A payment and a demand should not necessarily be modeled as one-to-one.
For example:
Payment ₹10,000
       ↓
₹6,000 Demand A
₹4,000 Demand B
Therefore use an allocation entity:
payment_allocations
-------------------
id
tenant_id
payment_id
fee_demand_id
allocated_amount
created_at
This provides flexibility for real-world payment behavior.

35.18 School Payment
This payment is completely different from SaaS platform payment.
Conceptually:
school_payments
--------------
id
tenant_id
payment_number
payer_type
payer_reference
amount
currency
method
status
provider
provider_reference
received_at
verified_at
created_at
updated_at
Payment methods may include:
CASH
BANK_TRANSFER
CHEQUE
CARD
UPI
ONLINE_GATEWAY
OTHER

35.19 Payment Status
Potential states:
PENDING
RECEIVED
VERIFIED
FAILED
CANCELLED
REFUNDED
PARTIALLY_REFUNDED
For offline payments, verification can be a separate step.

35.20 Receipt
A receipt represents confirmation of payment received.
receipts
--------
id
tenant_id
payment_id
receipt_number
issued_at
issued_by
status
created_at
A payment and receipt are related but not identical.
For example:
Payment Received
      ↓
Verification
      ↓
Receipt Issued

35.21 Receipt Number
Receipt numbers should generally be tenant-scoped:
UNIQUE(tenant_id, receipt_number)
The actual numbering strategy can be configurable.

35.22 Discounts
A discount is generally a pricing adjustment.
Conceptually:
discounts
---------
id
tenant_id
name
type
value
reason
status
But the actual application of a discount should be represented against the relevant fee assignment/demand.
Do not let a generic discount definition mutate historical demands.

35.23 Concession
A concession is a business decision granting a student a reduced fee.
Conceptually:
concessions
-----------
id
tenant_id
student_id
fee_demand_id nullable
type
value
reason
status
requested_by
approved_by
approved_at
created_at
updated_at
It may require approval.

35.24 Waiver
A waiver means an amount is intentionally forgiven.
That is different from an ordinary discount.
Example:
Demand = ₹10,000
Waiver = ₹10,000
Outstanding = ₹0
The waiver should remain historically visible.

35.25 Adjustment Principle
For financial history, preserve:
Original Amount
- Discount
- Concession
- Waiver
+ Late Fee
= Final Amount
The exact formula can be expanded later.
Do not simply overwrite the original amount.

35.26 Refund
Refund is a separate financial operation.
refunds
-------
id
tenant_id
payment_id
refund_number
amount
reason
status
provider_reference
requested_by
approved_by
processed_at
created_at
updated_at
A refund should never delete the original payment.

35.27 Refund Lifecycle
Example:
REQUESTED
   ↓
APPROVED
   ↓
PROCESSING
   ↓
COMPLETED
or:
FAILED
CANCELLED
depending on the mechanism.

35.28 Payment Idempotency
Online payment processing must support:
idempotency_key
provider_reference
to prevent:
₹5,000
+
₹5,000 duplicate payment
from being recorded because a gateway response was retried.

35.29 Online Payment Flow
For a gateway:
Guardian
 ↓
Portal
 ↓
Fees
 ↓
Payment Initiated
 ↓
Gateway
 ↓
Pending
 ↓
Webhook / Verification
 ↓
Payment Received
 ↓
Allocation
 ↓
Receipt
The portal never directly marks a payment as successful.

35.30 Payment Gateway Boundary
The integration layer handles:
Gateway API
Webhook
Provider transaction ID
Signature verification
Retry
Reconciliation
Fees owns:
Payment
Allocation
Receipt
Refund

35.31 Transportation → Fees
Transportation may produce:
Student transport assignment
        ↓
Charge applicability
        ↓
Fee assignment/demand
Transportation does not create:
payment
receipt
refund
Those remain Fee Management responsibilities.

35.32 Library → Fees
Library may produce:
Library Fine
       ↓
Financial obligation
       ↓
Fees
But the Library still owns:
Book
Loan
Return
Fine calculation
Fees owns the financial collection once the obligation enters the fee system.

35.33 Library Fine Boundary
A useful model:
Library
 └── Library Fine
        │
        ↓
     Fee Charge
        │
        ↓
     Payment
The exact integration can be finalized when Library is designed.

35.34 Family Billing — Deferred
A guardian may have multiple children.
For V1:
Payment
 ↓
Allocation
 ↓
One or more demands
This already leaves room for:
Family Account
 ↓
Multiple Students
later.
Do not introduce a full family billing account model unless required.

35.35 Fee Assignment and Multiple Components
Example:
Student Fee Assignment
       │
       ├── Tuition
       ├── Library
       ├── Transport
       └── Activity
Each actual financial obligation becomes one or more Fee Demands.
This gives reporting flexibility.

35.36 Due Dates
A demand should preserve its actual due date:
fee_demands.due_date
Even if the underlying fee structure changes later.
Historical demands must not start following the new structure's due date.

35.37 Late Fees
Late fees should be calculated by Fee Management.
Conceptually:
Demand
 ↓
Past Due
 ↓
Late Fee Rule
 ↓
Late Fee
The original demand amount should remain distinguishable from the late fee.

35.38 Write-Off
A written-off demand is not the same as paid.
PAID
means:
Money was received.
WRITTEN_OFF
means:
The school decided not to collect the outstanding amount.
This distinction matters for financial reporting.

35.39 Financial Precision
Monetary amounts should use a fixed-precision decimal type rather than floating-point.
Conceptually:
DECIMAL(precision, scale)
The exact precision depends on the chosen database and supported currencies.
Never use binary floating-point for money.

35.40 Currency
Each financial transaction should preserve its currency where appropriate:
currency
Even if V1 schools generally use one configured school currency.
This avoids assuming that currency can never change.

35.41 Fee Structure Example
A concrete conceptual example:
2026–27 Grade 8 Fee Structure
│
├── Tuition
│    └── ₹40,000 annual
│
├── Library
│    └── ₹2,000 annual
│
├── Activity
│    └── ₹1,500 annual
│
└── Transport
     └── determined by transport assignment
Student A might receive:
Tuition          ₹40,000
Library           ₹2,000
Activity          ₹1,500
Concession       -₹5,000
------------------------
Outstanding       ₹38,500
The underlying values remain traceable.

35.42 Financial History
Never mutate a historical financial fact simply because the configuration changed.
For example:
Fee Structure v1
       ↓
Demand issued
       ↓
₹40,000
Later:
Fee Structure v2
       ↓
₹45,000
The existing demand remains ₹40,000 unless an explicit business adjustment is performed.

35.43 Fee Permissions
Permissions should include:
fee.view
fee.create
fee.update
fee.issue
fee.cancel
fee.export

fee.payment.view
fee.payment.create
fee.payment.verify
fee.payment.allocate
fee.payment.refund

fee.adjustment.view
fee.adjustment.create
fee.adjustment.approve
fee.adjustment.cancel

fee.structure.view
fee.structure.create
fee.structure.update
fee.structure.publish
fee.structure.archive
Financially sensitive operations should receive stronger audit controls.

35.44 Approval Separation
Where appropriate:
Create Concession
        ↓
Approve Concession
        ↓
Apply
The same user should not automatically be allowed to perform every step merely because they have access to the Fee module.
Permission granularity can enforce separation of duties.

35.45 Fee Events
Important events:
FeeStructurePublished
StudentFeeAssigned
FeeDemandIssued
FeeDemandCancelled
FeeDemandOverdue
PaymentInitiated
PaymentReceived
PaymentVerified
PaymentAllocated
ReceiptIssued
ConcessionApproved
WaiverApproved
RefundCreated
RefundCompleted
FeeWrittenOff
Downstream consumers may include:
Communication
Reporting
Parent Portal
Integrations

35.46 Fee Audit
Audit strongly recommended for:
Fee structure changes
Demand cancellation
Concessions
Waivers
Write-offs
Payment verification
Payment allocation changes
Refunds
Manual adjustments
The actor and reason should be retained for sensitive financial operations.

35.47 Fee Reports
Source data can support:
Collection Report
Outstanding Report
Student Ledger
Daily Collection
Payment Method Report
Concession Report
Refund Report
Overdue Report
Fee Structure Report
Reporting remains downstream.

35.48 Fee Database Structure
Conceptually:
FEE MANAGEMENT
────────────────────────
fee_categories
fee_structures
fee_components

student_fee_assignments

fee_demands

school_payments
payment_allocations
receipts

discounts
concessions
waivers
refunds
Some adjustment models may later be normalized further, but the ownership boundaries should remain.

35.49 Relationship Diagram
Academic Year
      │
      ↓
Fee Structure
      │
      ↓
Fee Components
      │
      ↓
Student Fee Assignment
      │
      ↓
Fee Demand
      │
      ├───────────────┐
      ↓               ↓
   Payment       Adjustments
      │
      ↓
Allocation
      │
      ↓
Receipt
External references:
Student
Enrollment
Guardian
Transportation
Library

35.50 Financial Dependency Direction
The preferred dependency graph is:
Student ────────────→ Fees
Academic ───────────→ Fees
Transportation ─────→ Fees
Library ────────────→ Fees
Guardian ────────────→ Fees

Fees
 ↓
Payment
 ↓
Communication / Reporting / Integration
Fees should not become a prerequisite for Student, Academic, Transportation, or Library core operations.

35.51 Platform Billing Remains Separate
The complete picture is:
                  PLATFORM
                     │
             Subscription
                     │
                 Invoice
                     │
              Platform Payment


                   SCHOOL
                     │
                  Student
                     │
               Fee Demand
                     │
               School Payment
                     │
                  Receipt
They can share:
payment infrastructure,
gateway adapters,
currency utilities,
audit,
notifications,
but not financial ownership.

35.52 Tenant Isolation
All Fee-owned tables are tenant-scoped:
fee_categories.tenant_id
fee_structures.tenant_id
fee_components.tenant_id
student_fee_assignments.tenant_id
fee_demands.tenant_id
school_payments.tenant_id
payment_allocations.tenant_id
receipts.tenant_id
concessions.tenant_id
refunds.tenant_id
A payment from School A must never be allocatable to a demand belonging to School B.

35.53 Critical Cross-Tenant Constraint
For allocation:
payment.tenant_id
=
fee_demand.tenant_id
must always hold.
Similarly:
payment_allocation.tenant_id
=
payment.tenant_id
=
fee_demand.tenant_id
This is a high-priority integrity rule.

35.54 Indexing
Likely high-value indexes:
fee_demands:
  (tenant_id, student_id, status)
  (tenant_id, due_date, status)
  (tenant_id, demand_number)

payments:
  (tenant_id, payment_number)
  (tenant_id, status)
  (tenant_id, received_at)
  (tenant_id, provider_reference)

payment_allocations:
  (tenant_id, payment_id)
  (tenant_id, fee_demand_id)

student_fee_assignments:
  (tenant_id, student_id)
  (tenant_id, enrollment_id)
Exact indexes should follow real query patterns.

35.55 Concurrency
Financial operations need strong transaction handling.
For example:
Payment
 ↓
Allocate
 ↓
Update Demand Balance
must prevent two simultaneous requests from allocating more than the outstanding amount.
Use appropriate:
transactions,
row locking,
optimistic concurrency,
database constraints.

35.56 Payment Example
Suppose:
Demand = ₹10,000
Outstanding = ₹10,000
Two requests simultaneously attempt:
₹7,000
₹7,000
The system must not end with:
Allocated = ₹14,000
The allocation transaction must protect the outstanding balance.

35.57 Current Domain Graph
After Part 35:
ACADEMIC
    │
    ├────────→ STUDENT
    │              │
    │              ↓
    │          ENROLLMENT
    │              │
    │              ↓
    │            FEES
    │
    └────────→ EXAMINATION

TEACHER
    ↓
TEACHING ASSIGNMENT
    ↓
EXAMINATION / ATTENDANCE

TRANSPORTATION ──→ FEES
LIBRARY ──────────→ FEES

FEES
 ├──→ Communication
 ├──→ Reporting
 ├──→ Portal
 └──→ Integrations
The graph remains directional and avoids circular ownership.

35.58 Key Design Decisions Locked
At this stage, the following are now clear:
✓ Fee structures define intended charges
✓ Student assignments create actual applicability
✓ Fee demands represent obligations
✓ Payments represent money received
✓ Allocations connect payments to demands
✓ Receipts confirm payment
✓ Adjustments preserve financial history
✓ Refunds do not delete payments
✓ Transportation can feed fee applicability
✓ Library can feed financial obligations
✓ Platform billing remains separate
✓ Financial amounts use decimal precision
✓ Payment processing is idempotent
✓ Financial operations are heavily audited
✓ Tenant isolation applies to every financial record

35.59 What This Enables
The model supports:
annual fees,
recurring fees,
installments later,
partial payments,
multiple demands per student,
one payment covering multiple demands,
concessions,
waivers,
discounts,
late fees,
refunds,
transport charges,
library fines,
online payment gateways,
manual/offline payments,
financial reporting.
without turning Fee Management into an accounting/ERP system prematurely.

Next: Part 36 — Transportation Database Design
The next phase will design:
Vehicles
Drivers
Routes
Stops
Trips
Transport Services
Student Transport Assignments
Pickup / Drop Configuration
The key question will be how to model historical transport assignments and route changes so that changing a student's route tomorrow does not rewrite where they were transported last month.
