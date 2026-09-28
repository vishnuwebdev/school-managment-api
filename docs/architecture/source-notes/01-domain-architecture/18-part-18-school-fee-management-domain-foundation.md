<!-- Source: Apple Notes, folder 'Notes' -->
# Part 18 — School Fee Management Domain Foundation

This domain is deliberately separate from the platform's SaaS billing.
We now have two different financial systems:
PLATFORM COMMERCIAL
School
   ↓
Subscription
   ↓
Platform Invoice
   ↓
Platform Payment
versus:
SCHOOL FEE MANAGEMENT
Student / Guardian
   ↓
Fee Structure
   ↓
Student Fee Assignment
   ↓
Invoice / Demand
   ↓
Payment
   ↓
Receipt
They should never be treated as one billing domain.

18.1 Domain Purpose
School Fee Management handles the school's financial relationship with students/guardians.
Conceptually:
Fee Management
│
├── Fee Categories
├── Fee Structures
├── Fee Components
├── Student Fee Assignment
├── Fee Demand / Invoice
├── Payments
├── Receipts
├── Discounts / Concessions
├── Waivers
├── Refunds
├── Dues / Outstanding
└── Financial Reports
Potential future capabilities:
├── Online Payment Gateway
├── Installments
├── Late Fees
├── Scholarships
├── Automated Reminders
├── Payment Plans
├── Family Billing
└── Advanced Collection Rules

18.2 Critical Boundary
The platform subscription system answers:
What does the school owe the SaaS platform?
School Fee Management answers:
What does the student/guardian owe the school?
These are completely different business contexts.

18.3 Domain Ownership
Fee Management owns:
Fee Category
Fee Structure
Fee Component
Student Fee Assignment
Fee Demand
School Payment
Receipt
Discount
Concession
Waiver
Refund
It references:
School
Student
Guardian
Enrollment
Academic Year
Class / Section
It should not own those master records.

18.4 Fee Category
A school may define:
Tuition Fee
Admission Fee
Transport Fee
Examination Fee
Library Fee
Activity Fee
Uniform Fee
Other Charges
These should be configurable.
Do not hardcode a universal fee list.

18.5 Fee Structure
A fee structure defines what should be charged.
For example:
2026–27
Grade 6
│
├── Tuition       ₹40,000
├── Examination   ₹2,000
└── Activity      ₹1,500
The structure is not itself a student's payment.
It is a pricing/configuration definition.

18.6 Fee Component
A fee structure can contain components:
Fee Structure
├── Tuition
├── Examination
├── Activity
└── Transport
Each component can have its own:
amount,
frequency,
applicability,
due date,
rules.

18.7 Frequency
Fee components may be:
One-time
Monthly
Quarterly
Term-wise
Annual
Custom
This should be configurable.
For example:
Tuition → Monthly
Admission → One-time
Exam → Term-wise

18.8 Fee Structure vs Student Charge
This distinction is fundamental.
Fee Structure
    ↓
defines what should be charged
while:
Student Fee Assignment
    ↓
defines what this specific student is actually responsible for
This allows exceptions.

18.9 Student Fee Assignment
Example:
Standard Tuition = ₹40,000

Student A
Discount = ₹5,000

Final obligation = ₹35,000
We should preserve:
Standard amount
Discount/concession
Final amount
Reason
Approved by
Effective period
Do not overwrite the original fee structure.

18.10 Discounts and Concessions
These are related but conceptually different.
Discount:
Commercial reduction
Concession:
School-approved special reduction
Scholarship:
Potentially a policy-based financial benefit
We can initially model them through a common adjustment concept while preserving the source/type.

18.11 Waiver
A waiver can mean:
Fee component obligation is removed
Example:
Transport Fee = ₹2,000
Waived = ₹2,000
Payable = ₹0
The original fee should remain visible historically.

18.12 Fee Demand / Invoice
The school needs a financial document representing what is currently payable.
Conceptually:
Student Fee Assignment
       ↓
Fee Demand / Invoice
       ↓
Amount Due
       ↓
Payment
For example:
April 2026
Tuition       ₹4,000
Transport     ₹1,000
Late Fee        ₹100
--------------------
Total         ₹5,100

18.13 Invoice vs Receipt
These must remain separate.
Invoice/demand:
What is owed?
Receipt:
What was paid?
Example:
Invoice = ₹5,100
Payment = ₹3,000
Outstanding = ₹2,100
The payment should not mutate the invoice into a receipt.

18.14 Payment
School payment should support multiple methods:
Cash
Bank Transfer
Cheque
Card
UPI
Online Gateway
Other
Payment method is data/configuration, not a separate payment domain for every method.

18.15 Payment Lifecycle
A school payment may have:
Pending
 ↓
Received
 ↓
Verified
 ↓
Allocated
or for online payments:
Initiated
 ↓
Processing
 ↓
Successful
Failed/unknown states may also be required.
The exact state model should follow the payment mechanisms eventually selected.

18.16 Payment Must Be Idempotent
The same principle used by platform billing applies here.
If a payment gateway sends the same callback twice:
Same external transaction
        ↓
One logical payment
Never create duplicate school payments.

18.17 Payment Allocation
A payment may cover multiple charges.
Example:
Payment = ₹10,000

Allocated:
Tuition      ₹7,000
Transport    ₹2,000
Exam         ₹1,000
Therefore payment and fee obligations should be separate concepts.

18.18 Partial Payments
Partial payment should be supported.
Demand = ₹20,000
Payment = ₹8,000
Outstanding = ₹12,000
The system should derive the outstanding amount rather than allowing arbitrary manual balance values.

18.19 Overpayment
Example:
Due = ₹5,000
Paid = ₹6,000
The system needs an explicit policy:
Credit Balance
Refund
Apply to Future Demand
This should be configurable according to school policy.

18.20 Refund
Refund is not deletion.
Payment Received
      ↓
Refund
The original payment remains in history.
The refund is a separate financial event.
It should require:
permission,
reason,
audit,
appropriate approval where necessary.

18.21 Fee Cancellation
Likewise, cancelling a fee demand is not deleting it from history.
Example:
Issued
 ↓
Cancelled
The historical record remains.

18.22 Fee Lifecycle
A demand could follow:
Draft
 ↓
Issued
 ↓
Partially Paid
 ↓
Paid
with alternative states:
Overdue
Cancelled
Written Off
The exact terminology can be refined later.

18.23 Due Dates
Each payable obligation should have a due date.
This allows:
Due
 ↓
Overdue
 ↓
Late Fee
without embedding date calculations in unrelated parts of the system.

18.24 Late Fees
Late fees should be configurable.
Possible policies:
Fixed amount
Percentage
Per day
Per month
Grace period
Maximum cap
Do not hardcode one policy.
A school may choose:
5 days grace
then ₹100
while another uses:
2% monthly

18.25 Fee Structure Versioning
Fee structures should be historically safe.
Suppose:
2026–27 Tuition = ₹40,000
and later the school changes the fee:
2026–27 Tuition = ₹45,000
Existing issued obligations must not silently change.
Therefore fee structures should be versioned/effective-dated or otherwise preserve the commercial snapshot used when the obligation was generated.

18.26 Academic Year Dependency
Fee structures often depend on:
Academic Year
Class / Grade
Example:
2026–27
Grade 6
Tuition = ₹40,000
But fee management should reference Academic Management rather than own academic years/classes.

18.27 Student Enrollment Dependency
A fee may depend on enrollment:
Student
 ↓
Enrollment
 ↓
Grade 6
 ↓
Fee Structure
This is important for historical accuracy.
If a student changes from Grade 6 to Grade 7, future charges may change while previous obligations remain unchanged.

18.28 Transport Fee
Transportation is a good example of domain separation.
Fee Management may contain:
Transport Fee = ₹2,000
but it should not own:
Bus
Route
Stop
Vehicle
Driver
Student Transport Assignment
Those belong to Transportation Management.
Fee Management consumes the applicable transport charge.

18.29 Examination Fee
Likewise:
Examination Fee
can exist in Fee Management.
But:
Exam
Subject
Assessment
Result
belong to Examination.

18.30 Guardian / Family Billing
A future requirement may be:
Parent/Guardian
   ↓
Multiple Students
   ↓
Single Payment
For example:
Guardian
├── Student A → ₹10,000
└── Student B → ₹8,000

Single payment = ₹18,000
Therefore the architecture should not assume:
one payment = one student
even if V1 initially presents payments per student.

18.31 Financial Account Boundary
We should also distinguish:
Fee Management
from a full:
Accounting / General Ledger
Fee Management records school fee obligations and collections.
A future accounting module may consume those transactions for:
ledger entries,
accounts receivable,
reconciliation,
financial statements.
Do not turn Fee Management into a complete accounting system.

18.32 Fee Permissions
Initial permissions:
fee.view
fee.create
fee.update
fee.issue
fee.cancel
fee.export
Payments:
fee_payment.view
fee_payment.create
fee_payment.verify
fee_payment.allocate
fee_payment.refund
Concessions:
fee_adjustment.view
fee_adjustment.create
fee_adjustment.approve
fee_adjustment.cancel
Configuration:
fee_structure.view
fee_structure.create
fee_structure.update
fee_structure.publish
fee_structure.archive

18.33 Sensitive Permissions
Some operations should be treated as higher-risk:
Refund
Write-off
Large concession
Manual adjustment
Payment reversal
Fee cancellation
These should have strong audit requirements and can later require:
Reason
Approval
Re-authentication
Second approval
without changing the underlying domain model.

18.34 Fee Feature Structure
Initial:
Fee Management
│
├── Fee Categories
├── Fee Structures
├── Student Charges
├── Fee Demands
├── Payments
├── Receipts
├── Adjustments
├── Refunds
└── Reports
Potential future:
├── Online Payments
├── Installments
├── Scholarships
├── Family Billing
├── Automated Reminders
└── Payment Plans

18.35 Fee Security Model
A user needs all relevant conditions:
Authentication
AND
Tenant Membership
AND
School Active/Recoverable
AND
Fee Feature Entitled
AND
Permission
AND
Financial Scope
For example, a Sub Admin might have:
fee.view
fee_payment.view
but not:
fee_payment.refund

18.36 Financial Scope
Future scopes may include:
All students
Assigned classes
Specific branch/campus
Specific fee categories
V1 can keep this simple.
The architecture should nevertheless avoid assuming that every fee user has unrestricted school-wide financial access.

18.37 Fee Reports
Fee Management can own:
Fee Collection Report
Outstanding Dues
Daily Collection
Payment Method Report
Student Ledger
Concession Report
Refund Report
Overdue Report
Cross-domain reports can later combine:
Student
+
Attendance
+
Examination
+
Fees
without forcing Fee Management to own the other domains.

18.38 Fee Notifications
Fee events can produce notifications:
Demand Issued
Due Date Approaching
Payment Received
Payment Failed
Fee Overdue
Receipt Generated
Flow:
Fee Domain
   ↓
Domain Event
   ↓
Notification Service
   ↓
Email/SMS/Push/etc.
Fee Management should not directly implement each notification channel.

18.39 Audit Requirements
Audit:
Fee structure changes
Fee issuance
Fee cancellation

Student fee assignment changes
Discount/concession
Waiver

Payment creation
Payment verification
Payment allocation

Refunds
Write-offs
Manual adjustments

Bulk operations
Exports
For financial corrections:
Before
After
Actor
Reason
Timestamp
should be retained.

18.40 Events
Useful events:
FeeStructurePublished
FeeDemandIssued
FeeDemandCancelled

PaymentInitiated
PaymentReceived
PaymentVerified
PaymentAllocated

RefundCreated
ConcessionApproved
FeeWrittenOff

FeeOverdue
These events can drive notifications, reporting, reconciliation, and future accounting integration.

18.41 Fee Conceptual Model
Academic Year
     │
     ↓
Fee Structure
     │
     ├── Fee Components
     │
     ↓
Student Enrollment
     │
     ↓
Student Fee Assignment
     │
     ↓
Fee Demand
     │
     ├──────────────┐
     ↓              ↓
Adjustment       Payment
                    │
                    ↓
                 Receipt
With:
Payment
   ↓
Refund
as a separate financial event.

18.42 Example End-to-End Flow
School configures 2026–27 fee structure
              ↓
Grade 6 tuition = ₹40,000
              ↓
Student enrolled in Grade 6
              ↓
Student fee assignment created
              ↓
Monthly demand = ₹4,000
              ↓
Invoice issued
              ↓
Guardian pays ₹4,000
              ↓
Payment verified
              ↓
Receipt generated
              ↓
Outstanding = ₹0
With a concession:
₹4,000
 - ₹500 concession
 = ₹3,500 payable
The original ₹4,000 standard amount remains historically visible.

18.43 Important Separation From Platform Billing
The final architecture now has:
                 PLATFORM
                    │
             Subscription/Billing
                    │
               School pays
                    │
                    ▼
              SCHOOL TENANT
                    │
              Fee Management
                    │
          Student/Guardian pays
Never reuse platform:
Subscription
Plan
PlanVersion
Platform Invoice
Platform Payment
for school student fees.
They may share infrastructure such as:
Payment Gateway
Currency
Tax utilities
Audit
Notifications
but their domain models remain separate.

18.44 What We Should Not Finalize Yet
Still intentionally deferred:
❌ Complete fee database schema
❌ Exact invoice design
❌ Tax/GST implementation
❌ Accounting ledger
❌ Family billing
❌ Scholarship engine
❌ Installment engine
❌ Payment gateway selection
❌ Reconciliation engine
❌ Advanced late-fee rules
❌ Detailed refund approval workflow
Those can be designed after the core fee lifecycle is stable.

18.45 Current Domain Architecture
We now have:
                         PLATFORM CORE
                              │
                              ↓
                         SCHOOL/TENANT
                              │
       ┌──────────────────────┼──────────────────────┐
       ↓                      ↓                      ↓
  ACADEMIC                STUDENT                 TEACHER
  STRUCTURE               MANAGEMENT              MANAGEMENT
       │                      │                      │
       └──────────────┬───────┴───────────┬──────────┘
                      ↓                   ↓
                 ATTENDANCE          EXAMINATION
                      │                   │
                      └─────────┬─────────┘
                                ↓
                         FEE MANAGEMENT
                                │
                       ┌────────┼────────┐
                       ↓        ↓        ↓
                    Payment   Receipt  Reports
The next domain should be Transportation Management.
That domain will introduce another important architectural pattern: a school service that has its own operational entities—vehicles, routes, stops, drivers, assignments—while Fee Management consumes transportation charges without owning transportation operations.
