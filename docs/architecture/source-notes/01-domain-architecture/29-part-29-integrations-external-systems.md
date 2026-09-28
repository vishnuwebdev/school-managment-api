<!-- Source: Apple Notes, folder 'Notes' -->
# Part 29 — Integrations & External Systems

Integrations are where a clean internal architecture can easily become coupled to vendors.
The central rule is:
External systems are adapters around our domain model, not the domain model itself.
For example, Fees should understand:
Payment
Payment Status
Payment Reference
It should not understand the internal API model of a particular payment provider.

29.1 Integration Domain Purpose
Integrations
├── Integration Registry
├── Provider Configuration
├── Credentials / Secrets References
├── External Connections
├── Webhooks
├── External Sync
├── Integration Jobs
├── Retry / Failure Handling
└── Integration Logs
Potential future integrations:
├── Payment Gateways
├── SMS Providers
├── Email Providers
├── WhatsApp
├── Accounting
├── GPS / Transport
├── Identity / SSO
├── Cloud Storage
├── Calendar
└── Education Platforms

29.2 Integration Boundary
The architecture should look like:
                DOMAIN
                  │
                  ↓
          Internal Contract
                  │
                  ↓
           Integration Layer
                  │
                  ↓
             Provider API
Not:
Fees
 ↓
Stripe-specific objects
 ↓
Stripe API
The domain should remain provider-neutral.

29.3 Why This Matters
Suppose the school initially uses:
Payment Provider A
and later changes to:
Payment Provider B
The Fees domain should not need a redesign.
Only the integration adapter should change.

29.4 Integration Types
We can broadly classify integrations as:
Synchronous API
Webhook
File Import/Export
Scheduled Sync
Event-Based Integration
Each has different reliability requirements.

29.5 Synchronous API
Used when an immediate response is required.
Example:
Create Payment
 ↓
Payment Gateway
 ↓
Payment Session
 ↓
Return URL / Transaction Reference
The business operation can continue based on the authoritative provider response.

29.6 Webhooks
External systems may notify us asynchronously.
Example:
Payment Gateway
 ↓
Webhook
 ↓
Integration Layer
 ↓
Verify
 ↓
Fees
The webhook should not directly mutate domain data without validation.

29.7 Webhook Security
Every webhook should be:
Authenticated / Signature Verified
 ↓
Parsed
 ↓
Validated
 ↓
Deduplicated
 ↓
Mapped to Internal Event
 ↓
Processed
Never trust arbitrary incoming webhook data.

29.8 Webhook Idempotency
External providers may send the same webhook multiple times.
Example:
PaymentSucceeded
Webhook #1
Webhook #2
Webhook #3
The system must process it effectively once.
Use:
Provider
+
Event ID / Transaction Reference
as an idempotency mechanism where appropriate.

29.9 Payment Gateway Integration
Payment architecture:
Fees
 ↓
Payment Service
 ↓
Payment Gateway Adapter
 ↓
Provider
The provider might return:
External Transaction ID
Status
Amount
Currency
Timestamp
The Fees domain maps this into its own payment model.

29.10 Payment Status
Never assume:
"User returned from gateway"
=
"Payment successful"
Instead:
Initiated
 ↓
Pending
 ↓
Provider Confirmation
 ↓
Successful / Failed / Unknown
Unknown states must be reconciled.

29.11 Payment Reconciliation
If the gateway says:
Payment successful
but our system did not receive the expected webhook:
Reconciliation Job
 ↓
Provider API
 ↓
Verify Transaction
 ↓
Update Payment
This is why integration jobs are important.

29.12 Offline Payments
Offline payment methods:
Cash
Bank Transfer
Cheque
Manual Adjustment
do not require an external gateway.
The same internal Payment model should still be used.
This preserves:
Domain Payment
as the source of truth.

29.13 Email Integration
Communication should depend on an internal contract:
Email Service
 ↓
Provider Adapter
The Communication domain should not directly depend on a specific email provider.

29.14 SMS Integration
Same approach:
SMS Service
 ↓
Provider Adapter
 ↓
SMS Provider
Provider failures remain integration failures, not business transaction failures.

29.15 WhatsApp
If added later:
Communication
 ↓
WhatsApp Adapter
 ↓
Provider
WhatsApp-specific concepts should remain inside the adapter/integration boundary as much as possible.

29.16 File Storage
The platform already has a common File Service.
External storage might be:
Cloud Object Storage
The rest of the platform should interact with:
File Service
not directly with a vendor SDK.

29.17 File Ownership
For example:
Student Document
 ↓
File Service
 ↓
Object Storage
The Student domain owns the document meaning.
File infrastructure owns:
Storage
Metadata
Access
Retention

29.18 GPS / Transportation Integration
Transportation may later integrate with GPS providers:
GPS Provider
 ↓
Integration
 ↓
Transport Tracking
The Transportation domain should not embed a vendor-specific tracking model.

29.19 GPS Data
Potential external data:
Vehicle
Latitude
Longitude
Timestamp
Speed
Status
The integration layer maps provider data into an internal transport tracking contract.

29.20 Accounting Integration
Fees may eventually integrate with accounting software:
Fees
 ↓
Accounting Integration
 ↓
External Accounting System
Important:
Accounting integration should export financial facts; it should not make the external accounting system the source of truth for school fee transactions.

29.21 Example Accounting Flow
PaymentReceived
      ↓
Integration Event
      ↓
Accounting Adapter
      ↓
External Accounting System
If the external system is unavailable:
Payment remains successful
Integration remains pending/retryable

29.22 Identity / SSO Integration
Future schools may want:
Google Workspace
Microsoft Entra ID
Other SSO
Architecture:
External Identity Provider
          ↓
       Identity
          ↓
       User
          ↓
Membership
The external provider authenticates.
Our platform still determines:
Tenant
Membership
Roles
Permissions

29.23 Authentication vs Authorization
An SSO provider saying:
"This is user X"
does not mean:
"User X is School Admin."
Our authorization system remains authoritative.

29.24 Calendar Integration
Future integration could expose:
Timetable
 ↓
Calendar Adapter
 ↓
External Calendar
For example:
Google Calendar
Microsoft Outlook
But timetable remains the source of truth for school scheduling.

29.25 External Integration Registry
The platform should conceptually know:
Integration
├── Type
├── Provider
├── Tenant
├── Status
├── Configuration Reference
├── Created At
└── Last Health Check
Example:
School A
SMS
Provider X
Active
Another school:
School B
SMS
Provider Y
Active
This allows tenant-specific providers where required.

29.26 Platform vs Tenant Integrations
Some integrations are platform-wide:
Platform Email Provider
Others may be school-specific:
School A SMS Provider
School B SMS Provider
The architecture should support both.

29.27 Integration Status
Example:
Configured
 ↓
Validating
 ↓
Active
Failure:
Active
 ↓
Degraded
 ↓
Disconnected
Exact lifecycle can vary by integration type.

29.28 Credentials
Credentials should not live as ordinary configuration values.
Instead:
Integration
 ↓
Secret Reference
 ↓
Secure Secret Store
Examples:
API Key
Client Secret
Webhook Secret
Private Credential
The application receives secrets only when required.

29.29 Credential Rotation
The design should support:
Old Credential
      ↓
New Credential
      ↓
Validation
      ↓
Activate New
      ↓
Retire Old
without changing the domain model.

29.30 Integration Health
Each integration can expose:
Connection Status
Last Successful Call
Last Failure
Failure Count
Provider Status
This is useful for platform operations/support.

29.31 Retry
Transient external failures should be retryable.
Example:
API Call
 ↓
Timeout
 ↓
Retry
 ↓
Retry
 ↓
Success
Use bounded retry and backoff.
Do not retry indefinitely.

29.32 Non-Retryable Errors
For example:
Invalid API credentials
Invalid request
Permission denied
Unsupported operation
These should generally become:
Failed / Needs Intervention
rather than endlessly retrying.

29.33 Integration Queue
For asynchronous operations:
Domain Event
 ↓
Outbox
 ↓
Integration Job
 ↓
Provider
This gives reliable delivery.

29.34 Outbox Relationship
The earlier Outbox pattern now becomes especially useful.
Example:
Payment Transaction
      │
      ├── Database Commit
      │
      └── Outbox Event
               ↓
        Integration Worker
               ↓
        Accounting Provider
The payment transaction does not depend on the external provider being online.

29.35 Integration Logs
Integration logs should record:
Integration
Request ID
Provider
Operation
Timestamp
Status
Latency
External Reference
Error Category
But do not log:
Passwords
API Secrets
Full payment credentials
Sensitive personal information

29.36 Integration Audit vs Logs
They remain distinct.
Integration log
SMS Provider request failed
Audit
Admin changed SMS provider configuration
Security event
Invalid webhook signature detected
Three different purposes.

29.37 External IDs
Whenever integrating with an external system, preserve:
Internal ID
External Provider ID
Example:
Internal Payment:
P-12345

Provider Transaction:
TXN-ABC-987
Never make the provider ID the primary internal identity.

29.38 External Reference Mapping
A generic mapping may be useful:
Internal Entity
 ↔
External Entity
But the mapping should remain contextual.
For example:
Payment P-12345
Provider X → TXN-100
Provider Y → TXN-900

29.39 Data Synchronization
Some integrations are two-way:
Our System
 ↔
External System
These require:
synchronization direction,
conflict handling,
timestamps/versioning,
reconciliation.
Do not assume "last write wins" is always safe.

29.40 Import Integrations
Some external systems provide files:
CSV
Excel
JSON
XML
Flow:
External File
 ↓
Integration Parser
 ↓
Validation
 ↓
Internal Command
 ↓
Domain
Do not directly insert imported records into domain tables.

29.41 Integration Ownership
The rule should be:
Domain owns business meaning.
Integration owns translation.
Example:
Fees:
PaymentReceived

Integration:
How PaymentReceived becomes an accounting transaction.

29.42 Integration Permissions
Initial permissions:
integration.view
integration.manage
integration.test
integration.enable
integration.disable
integration.reconnect
Sensitive credential changes may require:
Re-authentication
Reason
Additional approval
depending on security policy.

29.43 Tenant Integration Permissions
A School Admin may manage:
Their school's
SMS integration
Email integration
Payment integration
only if those capabilities are delegated to them.
Platform-level integrations remain platform-admin controlled.

29.44 Feature Entitlement
Integrations may depend on feature entitlements.
Example:
Online Payments
requires:
Fee Management
+
Online Payment entitlement
+
Configured payment provider
All three are different.

29.45 Integration Readiness
A feature requiring an external provider should distinguish:
Entitled
from:
Configured
and:
Operational
Example:
Online Payment
├── Entitled ✓
├── Provider Configured ✓
└── Provider Healthy ✗
The feature exists commercially, but payment operations should not pretend the provider is available.

29.46 Integration Failure and Business Transactions
The general rule:
Internal authoritative transaction
        ↓
External side effect
not:
External provider
        ↓
Required for internal database transaction
unless the business operation genuinely requires an immediate external authorization.
Even then, the state model must represent uncertainty.

29.47 Example: Online Payment
Create Payment Attempt
        ↓
Provider
        ↓
Pending
        ↓
Provider Confirmation
        ↓
Successful
If the provider times out:
Payment = Pending / Unknown
not:
Payment = Failed
without verification.

29.48 Example: Notification
Fee Demand Issued
 ↓
Notification Event
 ↓
SMS Provider Timeout
Fee demand remains:
Issued
Notification:
Retrying

29.49 Integration Events
The integration layer can emit:
IntegrationConnected
IntegrationDisconnected
IntegrationFailed
IntegrationRecovered

ExternalPaymentConfirmed
ExternalSyncCompleted
ExternalSyncFailed
These are integration facts, not domain business facts.

29.50 Integration Reports
Useful platform reports:
Active Integrations
Failed Integrations
Provider Health
Webhook Failures
Sync Status
Pending Integration Jobs
Payment Reconciliation
Notification Delivery

29.51 Future Integration Marketplace
The architecture could eventually support:
Integration Catalog
     ↓
Select Provider
     ↓
Configure
     ↓
Test
     ↓
Activate
But this is not required for V1.

29.52 What We Should Not Finalize Yet
Defer:
❌ Specific vendors
❌ Provider-specific database models
❌ Integration marketplace
❌ Full iPaaS platform
❌ Complex two-way synchronization framework
❌ Enterprise SSO implementation
❌ Full accounting integration
❌ GPS provider selection
We need the abstraction now; provider choices can come later.

29.53 Final Integration Architecture
                 INTERNAL DOMAINS
                       │
                       ↓
              Internal Contracts
                       │
                       ↓
                INTEGRATION LAYER
                       │
          ┌────────────┼────────────┐
          ↓            ↓            ↓
       Payments      Messaging    Storage
          ↓            ↓            ↓
      Provider A    Provider B   Provider C
And incoming:
External Provider
       ↓
Webhook / Sync
       ↓
Integration Layer
       ↓
Validation + Idempotency
       ↓
Internal Command/Event
       ↓
Domain

29.54 Overall Architecture After Part 29
We now have almost the complete conceptual platform:
                         PLATFORM
                            │
       ┌────────────────────┼────────────────────┐
       ↓                    ↓                    ↓
 Identity / RBAC       Tenant Management    Commercial
                                              Billing
       │                    │                    │
       └────────────────────┼────────────────────┘
                            ↓
                     Entitlement Engine
                            │
                            ↓
                    SCHOOL / TENANT
                            │
      ┌─────────────────────┼──────────────────────┐
      ↓                     ↓                      ↓
   Academic             Students                Teachers
      │                     │                      │
      ├──────→ Timetable ←──┼───────────────┐      │
      │                     │               │      │
      ↓                     ↓               ↓      ↓
 Attendance             Examination       Fees   Leave
      │                     │               │      │
      └──────────────┬──────┴───────────────┘      │
                     ↓                              │
               Reports / Analytics                  │
                     │                              │
                     └──────────────┬───────────────┘
                                    ↓
                              Communication
                                    │
                       ┌────────────┼────────────┐
                       ↓            ↓            ↓
                    Email          SMS          Push

Other Domains:
Transportation
Library
Parent / Guardian Portal

External Systems:
Payments
Messaging Providers
Storage
Accounting
GPS
SSO
Other Integrations
The next step should not be database design yet.
Part 30 — Final Domain Dependency Map should come first. We'll map every domain's ownership, dependencies, allowed direction of communication, events, and potential circular dependencies. That is the final architectural checkpoint before moving into the detailed database design.
