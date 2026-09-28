<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 9

Fee Management
Fee Management is intentionally separate from Platform Billing.
Platform Billing = what the school pays the SaaS provider.
Fee Management = what the school charges students/parents.
The same tenant, money, audit, payment and idempotency infrastructure can be reused, but the domains remain independent.

317. Fee Management Boundary
Fee Management owns:
fee heads/components
fee structures
academic-year fee configurations
student fee assignments
discounts/concessions
fee demands
invoices
invoice lines
payments
payment allocations
receipts
waivers
refunds
outstanding balances
collection status
fee adjustments
fee reports
It does not own:
students
enrollments
academic classes
academic years
platform subscriptions
platform invoices

318. Core Fee Model
Use this separation:
Fee Structure
      ↓
Student Fee Assignment
      ↓
Fee Demand / Invoice
      ↓
Payment
      ↓
Payment Allocation
      ↓
Outstanding Balance
Do not directly attach a payment to a fee head without an allocation record.
This allows one payment to settle multiple dues and one invoice to receive multiple payments.

319. Fee Head
A fee head identifies what money is being charged for.
Examples:
Tuition Fee
Admission Fee
Transport Fee
Library Fee
Laboratory Fee
Examination Fee
Activity Fee
Hostel Fee
Fee heads should be configurable per tenant.
fee_heads
id
tenant_id
code
name
description
category
status
is_refundable
created_at
updated_at
version
Status:
ACTIVE
INACTIVE
ARCHIVED
A fee head must not be physically deleted once financial transactions reference it.

320. Fee Head Categories
Recommended initial categories:
TUITION
ADMISSION
ACADEMIC
TRANSPORT
HOSTEL
EXAMINATION
LIBRARY
ACTIVITY
OTHER
These are classification values, not hardcoded business behavior.

321. Fee Structure
A fee structure defines what should be charged under a particular academic configuration.
fee_structures
-------------
id
tenant_id
academic_year_id
name
code
status
effective_from
effective_until
created_at
updated_at
version
Example:
2026–27
Grade 5
Annual Fee Structure

322. Fee Structure Lines
fee_structure_lines
-------------------
id
tenant_id
fee_structure_id
fee_head_id
amount
frequency
due_day
sequence
is_mandatory
status
created_at
updated_at
Frequency:
ONE_TIME
MONTHLY
QUARTERLY
HALF_YEARLY
ANNUAL
CUSTOM

323. Money Rules
All monetary values use:
DECIMAL(19,4)
Never use floating-point values for financial amounts.
Every financial entity carries an explicit:
currency
even when the tenant's default currency is known.

324. Student Fee Assignment
A fee structure is not itself a student's debt.
The assignment converts the structure into an obligation for a student.
student_fee_assignments
-----------------------
id
tenant_id
student_id
enrollment_id
fee_structure_id
status
effective_from
effective_until
created_at
updated_at
version
Status:
DRAFT
ACTIVE
SUSPENDED
CANCELLED
COMPLETED

325. Assignment Snapshot
When assigning a fee structure, important commercial values should be snapshotted.
Do not rely indefinitely on the current fee structure.
For example, if tuition changes from 50,000 to 60,000, existing assignments should not silently change.
The generated demand/invoice should contain the actual charged amount.

326. Fee Demand
A demand represents an amount that becomes payable.
fee_demands
-----------
id
tenant_id
student_id
enrollment_id
fee_structure_line_id
fee_head_id
academic_year_id
reference_number
description
amount
discount_amount
waiver_amount
net_amount
due_date
status
created_at
updated_at
version
Status:
DRAFT
ISSUED
PARTIALLY_PAID
PAID
OVERDUE
WAIVED
CANCELLED

327. Invoice vs Demand
For V1, treat a demand as the school's receivable obligation.
A student-facing invoice can group multiple demands.
Fee Structure
      ↓
Demand(s)
      ↓
Invoice
This allows the school to generate monthly/quarterly invoices without losing the underlying fee obligation.

328. Fee Invoice
fee_invoices
------------
id
tenant_id
student_id
enrollment_id
invoice_number
status
currency
subtotal
discount_total
waiver_total
tax_total
adjustment_total
grand_total
amount_paid
amount_due
issued_at
due_at
paid_at
cancelled_at
created_at
updated_at
version
Status:
DRAFT
ISSUED
PARTIALLY_PAID
PAID
OVERDUE
VOID
CANCELLED

329. Fee Invoice Lines
fee_invoice_lines
-----------------
id
tenant_id
invoice_id
fee_demand_id
fee_head_id
description
quantity
unit_price
gross_amount
discount_amount
waiver_amount
tax_amount
line_total
created_at
Issued invoice values should be treated as historical financial facts.
Do not recalculate an old invoice from the current fee structure.

330. Discounts
Discounts should be explicit.
fee_discounts
-------------
id
tenant_id
name
code
discount_type
value
status
effective_from
effective_until
created_at
updated_at
Types:
FIXED_AMOUNT
PERCENTAGE

331. Student Discount Assignment
student_fee_discounts
---------------------
id
tenant_id
student_id
fee_head_id
discount_id
amount_or_percentage
reason
effective_from
effective_until
status
approved_by
created_at
updated_at
Discounts should not silently alter previously issued invoices.
They affect eligible future demands unless an explicit adjustment workflow is used.

332. Concessions
Concession is a business concept distinct from generic discount.
Examples:
sibling concession
staff-child concession
scholarship
merit concession
financial assistance
Represent the reason explicitly.
concession_type
concession_reason
approved_by
The actual financial impact is still represented as a monetary adjustment.

333. Waiver
A waiver removes an existing obligation.
fee_waivers
-----------
id
tenant_id
fee_demand_id
amount
reason
requested_by
approved_by
status
requested_at
approved_at
applied_at
Status:
REQUESTED
APPROVED
REJECTED
APPLIED
CANCELLED
A waiver must be audited because it changes an amount receivable.

334. Fee Adjustment
Do not edit an issued financial transaction directly.
Use adjustments for corrections.
fee_adjustments
---------------
id
tenant_id
student_id
fee_invoice_id
adjustment_type
amount
reason
status
created_by
approved_by
created_at
applied_at
Examples:
CREDIT
DEBIT
REVERSAL
CORRECTION

335. Payment
fee_payments
------------
id
tenant_id
student_id
payment_number
payment_method
status
currency
amount
provider
provider_reference
external_transaction_id
received_at
verified_at
verified_by
failure_reason
created_at
updated_at
version
Payment methods:
ONLINE_GATEWAY
BANK_TRANSFER
CASH
CHEQUE
CARD
UPI
OTHER
The exact online methods remain provider/configuration dependent.

336. Payment Status
PENDING
PROCESSING
SUCCEEDED
FAILED
CANCELLED
UNKNOWN
REFUNDED
PARTIALLY_REFUNDED
Do not consider a payment successful merely because a frontend request succeeded.
The authoritative payment state comes from the payment workflow/provider.

337. Payment Allocation
This is one of the most important tables.
fee_payment_allocations
-----------------------
id
tenant_id
payment_id
fee_invoice_id
fee_demand_id
allocated_amount
allocated_at
created_at
Example:
Payment = ₹20,000

Invoice A = ₹12,000
Invoice B = ₹8,000

Allocation:
₹12,000 → A
₹8,000  → B

338. Partial Payments
Supported natively.
Invoice = ₹50,000
Payment 1 = ₹20,000
Payment 2 = ₹15,000
Payment 3 = ₹15,000
The invoice becomes:
PAID
only after allocated payments reach the collectible amount.

339. Unallocated Payments
A payment may temporarily remain unallocated.
Example:
Bank transfer received
       ↓
Payment verified
       ↓
No invoice identified
       ↓
UNALLOCATED
The payment remains a financial record until staff allocates it.
Do not discard or automatically assign it to arbitrary dues.

340. Payment Allocation Rules
Before allocation:
payment.status = SUCCEEDED
and:
allocated_amount <= payment amount - already allocated
Likewise:
allocation <= invoice outstanding amount
unless the system explicitly supports overpayment.

341. Overpayments
Support an explicit policy.
Recommended V1:
OVERPAYMENT
is retained as an unallocated student credit rather than silently creating a new fee payment.
Future use:
Student Credit
 ↓
Future Invoice Allocation

342. Student Credit
Optional but useful:
student_credits
--------------
id
tenant_id
student_id
source_payment_id
amount
remaining_amount
status
created_at
updated_at
This avoids losing excess payments.

343. Receipt
A successful payment should generate a receipt.
fee_receipts
------------
id
tenant_id
payment_id
receipt_number
receipt_date
status
issued_at
cancelled_at
created_at
Receipt numbers must be unique within the tenant.

344. Receipt Cancellation
Do not delete receipts.
ISSUED
  ↓
CANCELLED
Cancellation requires:
reason
actor
timestamp
audit entry
The underlying payment remains historically visible.

345. Refunds
Refunds are separate entities.
fee_refunds
-----------
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
Status:
REQUESTED
APPROVED
PROCESSING
SUCCEEDED
FAILED
CANCELLED
Never change the original payment amount to simulate a refund.

346. Refund Integrity
For a payment:
total_refunded <= payment.amount
unless a controlled adjustment workflow explicitly allows otherwise.
The original payment remains immutable.

347. Outstanding Balance
Do not maintain a manually editable student.outstanding_amount.
Calculate from financial facts or maintain a derived balance/read model.
Conceptually:
Outstanding
=
Issued Collectible Amount
-
Applied Payments
-
Applied Credits
-
Approved Waivers
-
Approved Credits/Adjustments

348. Balance Read Model
For performance, maintain:
student_fee_balances
--------------------
tenant_id
student_id
total_billed
total_discount
total_waived
total_paid
total_refunded
total_outstanding
updated_at
version
This is a derived model, not the financial source of truth.

349. Due-Date Handling
Overdue status should be derived from:
amount_due > 0
AND due_date < current_business_date
AND invoice.status in collectible states
A scheduled job may update status/read models.
Do not depend solely on a nightly job to determine whether a bill is overdue.

350. Academic-Year Relationship
Fee records reference:
academic_year_id
through the fee structure/demand context.
Historical fee transactions must remain valid even after the academic year becomes archived.

351. Student Withdrawal
Withdrawal does not automatically erase outstanding fees.
The system should initiate a controlled settlement process:
Student Withdrawal
       ↓
Calculate Outstanding
       ↓
Review Applicable Waivers/Adjustments
       ↓
Final Settlement
Any refund is a separate workflow.

352. Student Transfer
Internal transfer should preserve:
previous fee obligations
previous payments
previous receipts
previous concessions
New enrollment-specific fee assignments can then be created.

353. Fee Generation
Generating recurring demands should be idempotent.
Example key:
tenant_id
student_id
enrollment_id
fee_structure_line_id
billing_period
A retry must not generate duplicate charges.

354. Bulk Fee Assignment
Use the standard bulk workflow:
REQUEST
 ↓
VALIDATE
 ↓
PREVIEW
 ↓
CONFIRM
 ↓
BACKGROUND JOB
 ↓
RESULT
Validation includes:
active student
valid enrollment
valid fee structure
no duplicate assignment
effective dates
valid fee configuration

355. Bulk Invoice Generation
Likewise:
Generate Invoice Batch
 ↓
Validate eligible students
 ↓
Create batch
 ↓
Background job
 ↓
Generate demands/invoices
 ↓
Produce result
Include:
batch_id
processed_count
success_count
failure_count
and per-record errors.

356. Fee Permissions
Initial permissions:
fee_head.view
fee_head.manage

fee_structure.view
fee_structure.manage

fee_assignment.view
fee_assignment.create
fee_assignment.update
fee_assignment.cancel

fee_demand.view
fee_demand.generate
fee_demand.adjust
fee_demand.waive

fee_invoice.view
fee_invoice.create
fee_invoice.issue
fee_invoice.void

fee_payment.view
fee_payment.record
fee_payment.verify
fee_payment.allocate

fee_receipt.view
fee_receipt.issue
fee_receipt.cancel

fee_refund.view
fee_refund.request
fee_refund.approve
fee_refund.process

fee_report.view
fee_export

357. Financial Authorization
Sensitive actions should require stronger permissions:
Payment Verification
Waiver Approval
Invoice Void
Refund Approval
Receipt Cancellation
Large Adjustment
Future step-up authentication can be applied to these actions without changing the domain model.

358. Fee APIs
Fee heads:
/api/v1/fee-heads
/api/v1/fee-heads/:id
Fee structures:
/api/v1/fee-structures
/api/v1/fee-structures/:id
/api/v1/fee-structures/:id/lines
Assignments:
/api/v1/student-fee-assignments
/api/v1/students/:studentId/fee-assignments
Demands:
/api/v1/fee-demands
/api/v1/fee-demands/:id
Invoices:
/api/v1/fee-invoices
/api/v1/fee-invoices/:id
Payments:
/api/v1/fee-payments
/api/v1/fee-payments/:id
/api/v1/fee-payments/:id/allocations
Receipts:
/api/v1/fee-receipts/:id
Refunds:
/api/v1/fee-refunds
/api/v1/fee-refunds/:id

359. Fee Application Services
CreateFeeHead
CreateFeeStructure
AssignFeeStructure
GenerateFeeDemand
GenerateFeeInvoices

ApplyDiscount
ApplyConcession
RequestWaiver
ApproveWaiver

RecordPayment
VerifyPayment
AllocatePayment

IssueReceipt
CancelReceipt

RequestRefund
ApproveRefund
ProcessRefund

ApplyAdjustment
RecalculateStudentBalance

360. Payment Processing Boundary
External payment providers must never be called inside a long database transaction.
Use:
Create Payment Intent
        ↓
External Provider
        ↓
Webhook / Confirmation
        ↓
Verify / Deduplicate
        ↓
Update Payment
        ↓
Allocate
        ↓
Update Invoice
Provider integration belongs behind an integration/payment-provider abstraction.

361. Payment Webhooks
Use:
fee_payment_webhook_receipts
----------------------------
id
provider
provider_event_id
event_type
payload_hash
received_at
processed_at
status
error_code
Unique:
(provider, provider_event_id)
Webhook handling must be idempotent.

362. Fee Events
Important domain events:
FeeStructureCreated
FeeAssignmentCreated
FeeDemandGenerated
FeeInvoiceIssued
FeeInvoiceCancelled

PaymentRecorded
PaymentVerified
PaymentAllocated
PaymentFailed

ReceiptIssued
ReceiptCancelled

WaiverApproved
AdjustmentApplied

RefundRequested
RefundProcessed

StudentFeeBalanceChanged
Events carry:
event_id
event_type
occurred_at
tenant_id
actor
entity_type
entity_id
correlation_id
schema_version
payload

363. Fee Audit
Audit:
fee structure changes
amount changes
student assignments
discounts
concessions
waivers
invoice issuance
invoice voiding
payments
payment verification
payment allocation
receipt cancellation
refunds
financial adjustments
exports
Financial audit records should be retained according to the platform's financial retention policy.

364. Fee Database Indexes
Important indexes:
fee_heads:
  tenant_id, code UNIQUE

fee_structures:
  tenant_id, academic_year_id, code

fee_structure_lines:
  tenant_id, fee_structure_id

student_fee_assignments:
  tenant_id, student_id, status
  tenant_id, enrollment_id

fee_demands:
  tenant_id, student_id, status
  tenant_id, due_date, status
  tenant_id, reference_number UNIQUE

fee_invoices:
  tenant_id, invoice_number UNIQUE
  tenant_id, student_id, status
  tenant_id, due_at, status

fee_payments:
  tenant_id, payment_number UNIQUE
  tenant_id, student_id, status
  provider, external_transaction_id

fee_payment_allocations:
  tenant_id, payment_id
  tenant_id, fee_invoice_id
  tenant_id, fee_demand_id

fee_receipts:
  tenant_id, receipt_number UNIQUE

365. Tenant Isolation
Every tenant-owned financial table contains:
tenant_id
Repository methods require trusted TenantContext.
For example:
feeInvoiceRepository.findById(
  tenantContext,
  invoiceId
)
The repository must not trust a tenant ID supplied in the request body.

366. Financial Transactions
The following should normally be transactional:
Issue Invoice
Apply Waiver
Apply Adjustment
Allocate Payment
Cancel Receipt
Apply Refund
For example, payment allocation should atomically:
Payment allocation
+
invoice amount_paid update
+
invoice status update
+
demand status update
+
outbox event
+
audit

367. Financial Concurrency
Payment allocation is concurrency-sensitive.
Two operators must not be able to allocate more than the outstanding amount.
Use:
database transactions
row locking where necessary
optimistic version checks
unique/idempotency constraints
Example:
Invoice outstanding = ₹10,000

Operator A allocates ₹8,000
Operator B allocates ₹8,000

Only one allocation can consume the available balance without revalidation.

368. Reporting
Initial reports:
Student Fee Statement
Outstanding Fees
Collection Report
Daily Collection
Fee Head Collection
Class-wise Outstanding
Due / Overdue Report
Payment Method Report
Discount/Concession Report
Waiver Report
Refund Report
Large exports should use background jobs.

369. Student Fee Statement
The statement should derive from financial transactions:
Date
Reference
Description
Debit
Credit
Balance
Example:
Opening Balance
+ Tuition Demand
- Discount
- Payment
+ Transport Demand
- Payment
= Closing Balance
The statement must be tenant-scoped and student-scoped.

370. Parent/Student Portal
Parents/students can eventually see:
current outstanding
invoices
due dates
payment history
receipts
published fee notices
online payment options
They must not see:
internal approval notes
staff-only adjustment reasons unless explicitly exposed
internal payment-provider details
other students' financial information

371. Fee Domain Integration
Student
   ↓
Enrollment
   ↓
Fee Assignment
   ↓
Fee Demand
   ↓
Invoice
   ↓
Payment
   ↓
Receipt
Academic Management supplies:
Academic Year
Class
Section
Student Management remains authoritative for student identity/enrollment.
Payment providers are accessed through the Integration layer.

372. Platform Billing Separation
Never reuse:
subscriptions
invoices
payments
from Platform Billing directly for school fees.
Both domains may use common infrastructure and patterns, but they have different ownership and lifecycle.
Platform Billing
School → SaaS Provider

Fee Management
Parent/Student → School
This distinction is fundamental to avoiding accounting and authorization confusion.

373. Fee Module Contract
Fee Management
│
├── Fee Heads
├── Fee Structures
├── Student Assignments
├── Demands
├── Invoices
├── Discounts / Concessions
├── Waivers
├── Payments
├── Allocations
├── Receipts
├── Refunds
├── Adjustments
└── Balances / Reporting
Primary lifecycle:
Fee Structure
 ↓
Assignment
 ↓
Demand
 ↓
Invoice
 ↓
Payment
 ↓
Allocation
 ↓
Receipt
 ↓
Balance
The next domain is Timetable & Scheduling, covering periods, rooms, teacher/class/subject schedules, conflict detection, substitutions, and timetable publication.
