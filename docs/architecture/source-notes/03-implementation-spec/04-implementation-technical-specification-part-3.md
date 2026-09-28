<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 3

Subscription, Billing, Invoicing & Payments
This module covers platform commercial billing only.
It must remain separate from the later School Fees module.
Platform Commercial Billing
School
  ↓
Subscription
  ↓
Subscription Items
  ↓
Invoice
  ↓
Payment
  ↓
Entitlement
School fee collection will use a separate financial model.

87. Commercial Module Boundaries
Subscription owns
subscription lifecycle
billing cycle
renewal
cancellation
trial
expiry
subscription items
Billing owns
invoices
invoice lines
commercial amounts
taxes/adjustments where applicable
payment obligations
Payment owns
payment attempts
payment status
provider references
offline payment recording
verification
refunds
Entitlement owns
whether the school can use a capability
Payment does not directly enable features.

88. Commercial Data Model
Tenant
  │
  └── Subscription
        │
        ├── Subscription Item
        │       └── Product / Plan Version / Add-on
        │
        └── Invoice
              │
              ├── Invoice Lines
              └── Payments
A subscription can have multiple items.

89. Subscription Table
subscriptions
-------------
id
tenant_id
status
billing_cycle
starts_at
trial_ends_at
current_period_start
current_period_end
next_billing_at
auto_renew
cancel_at_period_end
cancelled_at
cancel_reason
expired_at
created_at
updated_at
version
Billing cycle
MONTHLY
ANNUAL
CUSTOM
CUSTOM is available for negotiated contracts.

90. Subscription Lifecycle
PENDING
  ↓
TRIAL
  ↓
ACTIVE
  ↓
PAST_DUE
  ↓
ACTIVE
Failure path:
PAST_DUE
   ↓
Recovery
   ↓
EXPIRED
Cancellation:
ACTIVE
   ↓
CANCELLED
Cancellation and expiry remain distinct.

91. Subscription State Rules
PENDING
Commercial agreement exists but activation requirements are incomplete.
TRIAL
Temporary access under trial terms.
ACTIVE
Subscription is operational.
PAST_DUE
Payment obligation exists but payment has not successfully completed.
EXPIRED
Subscription period/recovery has ended.
CANCELLED
Subscription intentionally terminated.

92. Subscription Items
subscription_items
------------------
id
subscription_id
product_id
plan_version_id
item_type
quantity
standard_price
discount_amount
custom_price
final_price
price_source
effective_from
effective_until
status
created_at
updated_at
item_type:
BASE_PLAN
ADD_ON
SERVICE

93. Historical Commercial Values
When a subscription item is created, capture the commercial values at that point.
Do not calculate historical invoices from today's product catalog.
For example:
Catalog price today:       120,000
Original subscription:      90,000
Historical invoice:         90,000
Changing the catalog later must not rewrite history.

94. Pricing Model
Store monetary values using MySQL DECIMAL.
Recommended:
DECIMAL(19,4)
Do not use floating-point values for money.
Every monetary amount must have a defined currency.

95. Invoice
invoices
--------
id
tenant_id
subscription_id
invoice_number
status
currency
subtotal
discount_total
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

96. Invoice Status
DRAFT
ISSUED
PARTIALLY_PAID
PAID
OVERDUE
VOID
CANCELLED
A paid invoice should not be casually edited.
Financial history is append-oriented.

97. Invoice Number
Invoice number is a human/business identifier.
It must be:
unique within the applicable billing/legal scope
generated server-side
immutable after issuance
never based solely on database auto-increment IDs
Example:
INV-2026-000012
The exact numbering format can be configurable later.

98. Invoice Lines
invoice_lines
-------------
id
invoice_id
subscription_item_id
description
quantity
unit_price
discount_amount
tax_amount
line_total
period_start
period_end
metadata
created_at
Invoice lines are historical snapshots.
They should not dynamically read current product pricing.

99. Invoice Calculation
Conceptually:
Line Amount
  ↓
Line Discount
  ↓
Tax
  ↓
Line Total
  ↓
Invoice Subtotal
  ↓
Invoice Adjustments
  ↓
Grand Total
All calculations must use decimal arithmetic.

100. Invoice Immutability
After issuance:
commercial values are not silently changed
paid invoice amounts are not overwritten
corrections use explicit adjustment/credit/debit mechanisms
void/cancellation is explicit
audit records the change
This is particularly important because platform billing is financial data.

101. Payment Model
Payment is separate from invoice.
payments
--------
id
tenant_id
invoice_id
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
failure_code
failure_reason
created_at
updated_at

102. Payment Methods
Support:
ONLINE_GATEWAY
BANK_TRANSFER
CASH
CHEQUE
MANUAL_ADJUSTMENT
OTHER
The payment abstraction must not assume every payment has a gateway transaction.

103. Payment Status
PENDING
PROCESSING
SUCCEEDED
FAILED
CANCELLED
REFUNDED
PARTIALLY_REFUNDED
UNKNOWN
UNKNOWN is important for gateway timeout/reconciliation scenarios.
Never assume a timeout means failure.

104. Online Payment Flow
Create Payment
      ↓
PENDING
      ↓
Gateway
      ↓
Provider Result
      ↓
Webhook / Verification
      ↓
SUCCEEDED
      ↓
Invoice Updated
      ↓
Subscription Updated
      ↓
Entitlement Recalculated
The payment provider is not allowed to directly change subscription or feature state.

105. Payment Webhooks
Webhook processing:
Webhook
 ↓
Authenticate Signature
 ↓
Deduplicate
 ↓
Persist Receipt
 ↓
Resolve Payment
 ↓
Validate Provider State
 ↓
Update Payment
 ↓
Update Invoice
 ↓
Update Subscription
 ↓
Entitlement
Webhook processing is idempotent.

106. Webhook Receipt
payment_webhook_receipts
-----------------------
id
provider
provider_event_id
event_type
payload_hash
received_at
processed_at
processing_status
failure_reason
Unique constraint:
UNIQUE(provider, provider_event_id)
This prevents duplicate provider notifications from producing duplicate effects.

107. Payment Idempotency
Payment creation accepts an idempotency key.
Conceptually:
tenant + actor + operation + idempotency_key
Repeated request:
First request
 ↓
Payment created

Duplicate request
 ↓
Original result returned
No duplicate financial transaction should be created.

108. Offline Payment
Offline payments follow:
Payment Recorded
      ↓
PENDING VERIFICATION
      ↓
Authorized Staff Verification
      ↓
SUCCEEDED
Depending on policy, trusted platform/billing users may record and verify in a single controlled operation, but the audit trail must remain.
Offline payment records should capture:
method
amount
reference/receipt
received date
verifier
reason/notes where required

109. Payment Allocation
For platform billing, an invoice normally receives payment directly.
However, the architecture should support allocations:
payment
   ↓
payment_allocations
   ↓
invoice
This makes partial payments and future multi-invoice payment handling possible.
payment_allocations
-------------------
id
payment_id
invoice_id
allocated_amount
created_at

110. Partial Payment
Example:
Invoice = ₹100,000
Payment = ₹60,000
Invoice:
PARTIALLY_PAID
amount_paid = 60,000
amount_due  = 40,000
A second payment can complete the invoice.
Never mark an invoice paid until its remaining balance reaches zero according to the defined financial precision.

111. Overpayment
Do not silently discard or incorrectly allocate excess money.
Possible states:
Payment
 ↓
Allocated amount
 ↓
Unallocated balance
The platform can later support:
credit balance
refund
allocation to another invoice
The accounting behavior should be explicitly configured before production use.

112. Refund
Refund is its own entity:
refunds
-------
id
payment_id
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
Refund does not delete the original payment.

113. Payment Concurrency
Financial operations require transaction/locking protection.
Examples:
Payment allocation
Invoice balance
Refund
Subscription renewal
The implementation must prevent two concurrent requests from both consuming the same outstanding balance.

114. Renewal
Automatic renewal:
Current Period Ending
       ↓
Generate Renewal Invoice
       ↓
Payment Attempt
       ↓
SUCCESS → New Period
FAILURE → PAST_DUE
The new subscription period must only become active after the required commercial conditions are satisfied.

115. Failed Renewal
Renewal Payment Failed
       ↓
PAST_DUE
       ↓
Retry / Recovery
       ↓
SUCCESS → ACTIVE
       ↓
Recovery Exhausted → EXPIRED
Retry policy is configurable.
Do not hard-code a fixed number of retries into domain logic.

116. Manual Renewal
Manual/offline renewal follows the same commercial state model.
Invoice
 ↓
Offline Payment
 ↓
Verification
 ↓
Subscription Renewal
 ↓
Entitlement
Payment success still does not directly toggle features.

117. Subscription Upgrade
Example:
Basic
 ↓
Upgrade
 ↓
Pro
Do not mutate the old commercial history.
Create appropriate new subscription item/period records.
The commercial calculation may support:
immediate upgrade
prorated charge
next-period upgrade
The exact pricing policy belongs to Billing configuration.

118. Subscription Downgrade
Downgrades should normally become effective at the next valid commercial boundary unless a specific contract allows immediate change.
Existing historical data remains intact.
Potentially impacted entitlements should be identified before the downgrade becomes effective.

119. Cancellation
Support:
cancel immediately
cancel at period end
Cancellation should not automatically mean immediate operational lock unless the commercial terms require it.
Example:
ACTIVE
cancel_at_period_end = true
The subscription remains active until the defined end date.

120. Entitlement Update After Billing Change
Billing emits events.
PaymentSucceeded
      ↓
InvoicePaid
      ↓
SubscriptionActivated/Renewed
      ↓
Entitlement Recalculation
Likewise:
SubscriptionExpired
      ↓
Entitlement Recalculation
      ↓
Operational Access Restricted
The Billing module does not directly manipulate domain permissions.

121. Commercial Audit
Audit all important commercial operations:
subscription creation
subscription activation
plan/add-on changes
custom pricing
discounts
invoice issuance
invoice void/cancellation
payment recording
payment verification
payment failure
refunds
renewal
cancellation
entitlement-impacting changes
Capture reason/approval where applicable.

122. Billing APIs
Initial structure:
/api/v1/subscriptions
/api/v1/subscriptions/:id
/api/v1/subscriptions/:id/items

/api/v1/invoices
/api/v1/invoices/:id

/api/v1/payments
/api/v1/payments/:id
/api/v1/payments/:id/refund

/api/v1/payment-webhooks/:provider
Administrative endpoints for:
manual payment
verification
commercial adjustment
subscription transition
must require explicit platform permissions.

123. Commercial Events
Important internal events:
SubscriptionCreated
SubscriptionActivated
SubscriptionRenewed
SubscriptionPastDue
SubscriptionExpired
SubscriptionCancelled

InvoiceIssued
InvoicePaid
InvoiceOverdue
InvoiceVoided

PaymentCreated
PaymentSucceeded
PaymentFailed
PaymentUnknown
PaymentRefunded

EntitlementRecalculationRequested
External integrations receive only explicitly defined versioned integration events.

124. Critical Commercial Rule
The following shortcut is prohibited:
Payment SUCCESS
     ↓
Feature = ON
Correct:
Payment SUCCESS
     ↓
Invoice
     ↓
Subscription
     ↓
Entitlement Resolver
     ↓
Effective Entitlement
     ↓
Feature Available
This preserves a clean commercial model.

125. Platform Billing vs School Fees
The boundary is now explicit:
PLATFORM
School
 ↓
Subscription
 ↓
Platform Invoice
 ↓
Platform Payment
 ↓
Entitlement


SCHOOL
Student/Guardian
 ↓
Fee Structure
 ↓
Student Fee Assignment
 ↓
Fee Demand
 ↓
School Payment
 ↓
Receipt
Neither billing system should reuse the other's business entities merely for convenience.
They may reuse shared financial primitives/utilities where appropriate.

126. Next Domain: Student Management
The next implementation specification will begin the first major school domain:
Student Management
It will cover:
Student
Admission
Enrollment
Guardian
Student–Guardian relationships
Student documents
student numbering
lifecycle
bulk import
duplicate handling
authorization/scopes
database schema
APIs
events
audit
concurrency
integration with Academic/Class
This will establish the pattern that the remaining school domains will follow.
