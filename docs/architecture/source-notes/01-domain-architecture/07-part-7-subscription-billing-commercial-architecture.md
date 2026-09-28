<!-- Source: Apple Notes, folder 'Notes' -->
# Part 7 — Subscription, Billing & Commercial Architecture

This layer answers:
What has the school purchased, at what commercial terms, for what period, and has it been paid for?
It should remain separate from both RBAC and the feature catalog.
The relationship is:
Feature Catalog
      ↓
Plan / Add-on
      ↓
Commercial Terms
      ↓
Subscription
      ↓
Invoice / Payment
      ↓
Entitlement

7.1 The Core Separation
We should keep these concepts distinct:
￼
For example:
Professional Plan
     ↓
contains
     ↓
Student + Teacher + Fees + Exams
A school purchasing that plan creates:
Subscription
which then produces:
Entitlements

7.2 Plans
A plan is a reusable commercial package.
Example:
Basic
Professional
Enterprise
But the plan should not directly contain pricing logic.
Conceptually:
Plan
 ├── Plan Version
 │     ├── Features
 │     └── Commercial Terms
 │
 └── Status

7.3 Plan Versioning
This is important for long-term stability.
Suppose:
Professional v1
contains:
Students
Teachers
Fees
Later the platform changes Professional to:
Professional v2
with:
Students
Teachers
Fees
Exams
Existing customers should not unexpectedly change simply because the platform edited the plan.
Therefore:
Plan
 ├── Version 1
 ├── Version 2
 └── Version 3
A subscription references the specific commercial version it purchased.

7.4 Example
Professional
      │
      ├── v1
      │    ├── Student Management
      │    ├── Teacher Management
      │    └── Fee Management
      │
      └── v2
           ├── Student Management
           ├── Teacher Management
           ├── Fee Management
           └── Examination
A customer on v1 doesn't automatically become v2 unless the business rules explicitly migrate them.

7.5 Pricing
Pricing should be modeled independently enough to support:
Monthly
Annual
Free Trial
Add-on
Discount
Custom Price
Negotiated Contract
A simplified commercial model:
Plan
 ↓
Price
 ├── Billing Period
 ├── Currency
 ├── Amount
 └── Validity
Later, pricing can support more sophisticated dimensions without restructuring the subscription model.

7.6 Monthly and Annual
A plan could have:
Professional
 ├── Monthly → ₹X
 └── Annual  → ₹Y
The subscription records which billing frequency was actually purchased.
Subscription
 ├── Plan Version
 ├── Billing Frequency = MONTHLY
 └── Price = ₹X
or:
Subscription
 ├── Plan Version
 ├── Billing Frequency = ANNUAL
 └── Price = ₹Y

7.7 Trial
Trial should be a subscription state/period, not a separate product.
Example:
Subscription
 ├── Status = TRIAL
 ├── Starts At
 └── Trial Ends At
At trial completion:
TRIAL
  ↓
ACTIVE
if payment/subscription requirements are satisfied.
Otherwise:
TRIAL
  ↓
EXPIRED

7.8 Free Trial With Selected Features
A trial can potentially provide:
Trial
 ↓
Plan Version
 ↓
Trial Entitlements
or a restricted subset:
Trial
 ├── Student Management
 ├── Teacher Management
 └── Basic Fees
This should be configurable rather than hardcoded.

7.9 Add-ons
We already decided that schools may have multiple active subscriptions/add-ons.
Example:
School A
 ├── Professional Plan
 ├── Transportation Add-on
 └── Advanced Examination Add-on
This is why a single:
subscription.plan_id
is insufficient.
Instead:
Subscription
     │
     ├── Subscription Item
     │       └── Professional Plan
     │
     ├── Subscription Item
     │       └── Transportation
     │
     └── Subscription Item
             └── Advanced Examination

7.10 Subscription Item
Conceptually:
SubscriptionItem
 ├── subscription_id
 ├── product_type
 ├── product_reference
 ├── quantity
 ├── standard_price
 ├── discount
 ├── final_price
 ├── starts_at
 └── ends_at
This lets one subscription contain multiple commercial components.

7.11 Why Quantity Matters
We don't necessarily need quantity-based pricing in V1, but the model should not make it impossible.
Potential future examples:
100 students
500 students
Unlimited students
10 buses
5 campuses
We shouldn't implement these pricing rules prematurely, but quantity or a pricing dimension can be accommodated later.

7.12 Custom / Negotiated Pricing
This was one of your explicit requirements.
Suppose:
Professional standard price:
₹100,000/year
but a school negotiates:
Final price:
₹75,000/year
The subscription should retain the commercial history.
Conceptually:
Subscription Item
 ├── Standard Price = ₹100,000
 ├── Discount = ₹25,000
 ├── Final Price = ₹75,000
 ├── Pricing Type = CUSTOM
 ├── Approved By = Platform Admin
 └── Reason
Do not simply overwrite the standard price with ₹75,000.
The original commercial reference is useful for auditing and future pricing analysis.

7.13 Discounts
Discounts should also be explicit.
For example:
Standard Price
      ↓
Discount
      ↓
Net Price
      ↓
Tax
      ↓
Total
Depending on the jurisdiction and eventual accounting requirements, taxes should be modeled separately rather than embedded permanently into the base price.

7.14 Subscription Lifecycle
A useful lifecycle is:
PENDING
   ↓
TRIAL
   ↓
ACTIVE
   ↓
PAST_DUE
   ↓
EXPIRED
   ↓
CANCELLED
Not every subscription must pass through every state.
For example:
PENDING → ACTIVE
for a manually activated paid subscription.

7.15 Cancellation vs Expiration
These should be different.
Expiration
The commercial term reached its end.
ACTIVE
 ↓
EXPIRED
Cancellation
Someone explicitly terminated the subscription.
ACTIVE
 ↓
CANCELLED
The platform should retain the reason and actor where applicable.

7.16 Auto-Renewal
A subscription can contain:
auto_renew = true
or:
auto_renew = false
For auto-renew:
Current Period
      ↓
Renewal Attempt
      ↓
Payment
      ↓
New Billing Period
If payment fails:
Renewal Attempt
      ↓
Payment Failed
      ↓
PAST_DUE
      ↓
Retry / Recovery
The exact retry schedule can be configured later.

7.17 Manual / Offline Payment
This is important for your platform.
Not every payment needs to come from an online gateway.
Possible methods:
Online Gateway
Bank Transfer
Cash
Cheque
Manual Adjustment
Other Offline Method
For manual payment:
Invoice
   ↓
Payment Recorded Manually
   ↓
Verified
   ↓
Invoice Paid
   ↓
Subscription Activated/Renewed
   ↓
Entitlement Updated
A manual payment should require appropriate permissions and auditing.

7.18 Payment Is Not the Same as Invoice
Keep these separate.
Invoice
 ├── amount_due
 ├── issued_at
 ├── due_at
 └── status
Payment
 ├── amount
 ├── method
 ├── reference
 ├── received_at
 └── status
An invoice may have:
₹100,000 due
with:
₹50,000 paid
So eventually:
Invoice
 ├── Total = ₹100,000
 ├── Paid = ₹50,000
 └── Balance = ₹50,000

7.19 Invoice Lifecycle
Conceptually:
DRAFT
  ↓
ISSUED
  ↓
PARTIALLY_PAID
  ↓
PAID
or:
ISSUED
  ↓
OVERDUE
and potentially:
VOID
depending on accounting requirements.

7.20 Payment Verification
For online payments:
Payment Gateway
      ↓
Payment Event
      ↓
Verify
      ↓
Record Payment
      ↓
Update Invoice
      ↓
Update Subscription
      ↓
Update Entitlement
For offline payments:
Staff records payment
      ↓
Verification
      ↓
Approve
      ↓
Update billing state
The important point:
Payment data should not directly modify feature access without passing through the subscription/entitlement workflow.

7.21 Subscription → Entitlement Activation
This is the commercial-to-access bridge.
Example:
Payment Successful
       ↓
Subscription Active
       ↓
Subscription Items Active
       ↓
Entitlement Resolver
       ↓
Effective Entitlements
       ↓
Feature Available
So the Fees module doesn't care whether the customer paid:
Online
Bank Transfer
Negotiated Contract
It simply sees:
fee.collection = entitled

7.22 Failed Payment
Suppose automatic renewal fails.
ACTIVE
   ↓
Renewal Payment Failed
   ↓
PAST_DUE
The platform can notify:
School Admin
Billing contacts
Platform Billing Admin
Depending on policy, the school can remain operational temporarily.
Eventually:
PAST_DUE
   ↓
EXPIRED
which triggers the 30-day recovery process we already defined.

7.23 Grace Period vs Recovery Period
We should distinguish terminology.
A billing grace period could mean:
The school remains operational after a failed renewal/payment.
The previously established 30-day recovery period means:
The school has expired operational access but School Admin can still log in to renew.
These are not necessarily the same thing.
A possible future policy:
Renewal failure
 ↓
Billing grace period
 ↓
Subscription expires
 ↓
30-day recovery
 ↓
Access locked
The exact number of days for billing grace can be configured later.

7.24 Feature Request → Commercial Flow
Now connect the earlier feature-request design.
School Admin
    ↓
Request Feature
    ↓
Platform Review
    ↓
Approved
    ↓
Price Agreed
    ↓
Subscription Item Added
    ↓
Invoice
    ↓
Payment
    ↓
Subscription Item Active
    ↓
Entitlement
    ↓
Feature Available
This means:
Approval ≠ entitlement
unless the platform explicitly grants it as a free override.

7.25 Subscription Changes
Suppose School A currently has:
Basic
and wants:
Professional
We should not simply mutate:
subscription.plan = Professional
because we need historical commercial information.
Instead, conceptually:
Existing Subscription
       ↓
Plan Change
       ↓
Commercial Event / New Period
       ↓
New Subscription Item or Version
       ↓
Entitlement Recalculation
The precise proration rules can be defined later.

7.26 Entitlement Changes During Upgrade
Suppose:
Basic
 ├── Students
 └── Teachers
becomes:
Professional
 ├── Students
 ├── Teachers
 ├── Fees
 └── Exams
After successful upgrade:
Fees = ENABLED
Exams = ENABLED
Existing data doesn't need to be recreated.
The entitlement layer simply changes the effective capability set.

7.27 Downgrades Need More Care
Suppose:
Professional
is downgraded to:
Basic
and Basic doesn't include:
Examination
We should not delete examination data.
Instead:
Examination entitlement
      ↓
Inactive
while:
Historical examination data
      ↓
Retained
If the school upgrades again:
Examination entitlement
      ↓
Active
and the data can become operational again, subject to the product rules.

7.28 Commercial History
We should preserve important historical facts.
For example:
School A

2026:
Professional v3
₹80,000/year

2027:
Professional v4
₹95,000/year

Customer negotiated price:
₹82,000/year
Historical invoices and subscription terms should not change merely because the catalog later changes.

7.29 Recommended Commercial Entities
At the conceptual level:
Plan
PlanVersion
PlanFeature
Price
PricingRule
Discount
Subscription
SubscriptionItem
Invoice
InvoiceItem
Payment
PaymentMethod
FeatureRequest
CommercialApproval
Some of these may eventually be combined or simplified, but this gives us the right conceptual boundaries.

7.30 Relationship Model
                        PLAN
                         │
                    PLAN VERSION
                         │
                ┌────────┴────────┐
                ↓                 ↓
             FEATURES           PRICES
                                   │
                                   ↓
                              SUBSCRIPTION
                                   │
                         ┌─────────┴─────────┐
                         ↓                   ↓
                SUBSCRIPTION ITEMS       INVOICES
                         │                   │
                         ↓                   ↓
                     ENTITLEMENT          PAYMENTS
                         │
                         ↓
                 EFFECTIVE ACCESS
Add-ons fit naturally:
Subscription
 ├── Base Plan Item
 ├── Add-on Item
 └── Add-on Item

7.31 Commercial Audit
The following should always be auditable:
Plan created
Plan version changed
Price changed
Custom price approved
Discount applied
Subscription created
Subscription upgraded
Subscription downgraded
Subscription cancelled
Manual payment recorded
Payment verified
Refund issued
Feature add-on approved
Entitlement manually overridden
For financial operations, the audit trail should capture:
Actor
Tenant
Amount
Currency
Before
After
Reason
Timestamp
Reference

7.32 One Important Design Principle
Don't let the billing module directly contain business authorization logic like:
if invoice.status == "paid":
    allow fee collection
Instead:
Billing
   ↓
Subscription State
   ↓
Entitlement Resolver
   ↓
Authorization
This prevents billing rules from leaking throughout the application.

7.33 Complete Commercial Flow
The platform now has a clean end-to-end flow:
FEATURE CATALOG
      ↓
PLAN / ADD-ON
      ↓
PRICING
      ↓
COMMERCIAL AGREEMENT
      ↓
SUBSCRIPTION
      ↓
INVOICE
      ↓
PAYMENT
      ↓
SUBSCRIPTION ACTIVE
      ↓
ENTITLEMENT RESOLUTION
      ↓
FEATURE AVAILABLE
      ↓
RBAC PERMISSION
      ↓
USER ACTION
And on expiration:
SUBSCRIPTION EXPIRES
      ↓
ENTITLEMENTS BECOME INACTIVE
      ↓
OPERATIONAL ACCESS LOCKED
      ↓
30-DAY RECOVERY
      ↓
RENEWAL
      ↓
ENTITLEMENTS RESTORED

Foundation Status
At this point the platform core has five major areas:
1. Tenant Architecture
2. RBAC / Permissions
3. Feature & Entitlement Engine
4. School Lifecycle
5. Subscription / Billing / Commercial
The next piece should be Part 8 — Platform Administration Architecture, covering the actual responsibilities and boundaries of:
Super Admin
Platform Admin
Billing Admin
Support Admin
Sales Admin
Operations Admin
including how platform-level RBAC, tenant-scoped access, approval workflows, and sensitive operations fit together.
