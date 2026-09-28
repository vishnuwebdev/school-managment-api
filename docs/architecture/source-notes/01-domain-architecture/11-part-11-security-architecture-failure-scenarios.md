<!-- Source: Apple Notes, folder 'Notes' -->
# Part 11 — Security Architecture & Failure Scenarios

Security should be designed into the platform core rather than added later to individual modules.
For this SaaS, the most important security boundary is:
USER
 ↓
IDENTITY
 ↓
MEMBERSHIP
 ↓
TENANT
 ↓
ENTITLEMENT
 ↓
PERMISSION
 ↓
ACTION
A failure at any layer must not accidentally grant access.

11.1 Security Layers
The platform should use defense in depth:
                    REQUEST
                       │
                ┌──────▼──────┐
                │ Authentication│
                └──────┬──────┘
                       ↓
                Identity Validation
                       ↓
                Tenant Validation
                       ↓
                Authorization
                       ↓
                Entitlement
                       ↓
                Domain Validation
                       ↓
                Tenant-aware Data Access
                       ↓
                Audit / Monitoring
No single layer should be trusted to provide all protection.

11.2 Authentication
Authentication answers:
Who is this user?
Possible mechanisms can include:
Password
Email verification
MFA
SSO/OIDC
Social/enterprise identity providers
We don't need to implement every mechanism in V1.
But the architecture should isolate authentication from authorization.
Authentication
    ≠
Authorization
A valid login does not mean the user can access a school.

11.3 Password Security
If password authentication is used, passwords must never be stored directly.
Conceptually:
Password
   ↓
Strong password hashing
   ↓
Stored credential
Use a modern password-hashing mechanism rather than encryption or plain hashing.
Also support:
Password reset
Password change
Account lock/rate limiting
Credential revocation

11.4 Sessions
Sessions should be revocable.
Conceptually:
User
 ├── Session A
 ├── Session B
 └── Session C
The system should be able to invalidate:
One session
All sessions
Sessions after security-sensitive changes
Examples:
Password reset
Account disabled
MFA reset
Suspicious login
User removed from school

11.5 Session Context
A session should not permanently assume a tenant merely because the user logged into the platform.
For school users:
Session
 ↓
School Membership
 ↓
Tenant Context
For platform users:
Session
 ↓
Platform Context
 ↓
Optional selected tenant context
The selected tenant must still be authorized server-side.

11.6 Tenant Isolation — Critical Rule
Never trust:
tenant_id
school_id
user_id
role_id
from arbitrary client input as proof of authorization.
The server should derive or validate these values from trusted identity/context.
For example, this request:
GET /students/123
must resolve:
student 123
AND
tenant = current authorized tenant
not simply:
student 123

11.7 Cross-Tenant Attack Scenario
Suppose:
Student 100 → School A
Student 200 → School B
A School A user changes:
/student/100
to:
/student/200
The backend must return no accessible resource rather than School B's student.
This is one of the most important security tests in the entire platform.

11.8 Tenant Isolation Tests
Before production, automated tests should specifically attempt:
School A → School B student
School A → School B teacher
School A → School B fee
School A → School B invoice
School A → School B files
School A → School B reports
and verify they are rejected.
Also test:
School A Admin
→ platform-only endpoint
and:
Platform user without School B scope
→ School B

11.9 Authorization Bypass
Never rely only on UI visibility.
For example, hiding:
Delete Student
from the UI does not provide security.
A malicious client could directly call:
DELETE /students/123
The backend must independently evaluate:
student.delete
plus tenant and entitlement checks.

11.10 Feature Bypass
Likewise, hiding an unavailable feature in the UI isn't enough.
If Transportation isn't entitled:
POST /transport/routes
must still be rejected.
The backend must check entitlement.

11.11 Subscription Bypass
Avoid scattered logic such as:
if subscription.status == ACTIVE
throughout the system.
Use the central entitlement mechanism.
Otherwise, one module might correctly lock itself after expiry while another accidentally remains usable.

11.12 School State Bypass
Likewise:
School = SUSPENDED
should be evaluated centrally.
A suspended school's user should not be able to bypass suspension by calling a domain API directly.

11.13 Sensitive Operations
Certain operations deserve additional controls.
Examples:
school.suspend
school.archive
subscription.cancel
payment.refund
pricing.override
entitlement.override
role.permission.update
user.disable
At minimum:
Authentication
+
Permission
+
Tenant/scope
+
Audit
For particularly sensitive operations, we can later add:
Reason required
Re-authentication
Second approval

11.14 Re-authentication
For very sensitive actions, the platform could require the administrator to authenticate again.
For example:
Change password
Change MFA
Payment refund
High-value pricing override
Platform role modification
This is an optional layer for later, but the architecture should not prevent it.

11.15 Audit Integrity
Audit records are security evidence.
Therefore normal application users should not be able to:
Edit audit record
Delete audit record
Change actor
Change timestamp
The application should treat audit as append-oriented.
For example:
Audit:
User A
changed
Role X

Before:
fee.view

After:
fee.view + fee.refund

11.16 Audit the Actor, Not Just the User
For platform operations, distinguish:
Actor
Context
Target
Example:
Actor:
Platform Admin #17

Context:
School A

Target:
Subscription #123

Action:
SUBSCRIPTION_UPDATED
For automated operations:
Actor:
SYSTEM

Context:
School A

Action:
SUBSCRIPTION_EXPIRED
This is much more useful than simply storing:
user_id

11.17 Sensitive Data
The platform will eventually contain:
Personal information
Student information
Contact information
Financial records
Documents
Authentication information
We should classify data so security controls can be applied appropriately.
Conceptually:
Public
Internal
Sensitive
Highly Sensitive
The exact classification can be refined later.

11.18 Encryption
Use encryption in two major areas:
In transit
Client
 ↓
HTTPS/TLS
 ↓
Application
At rest
Database/storage infrastructure should use appropriate encryption.
Particularly sensitive secrets should never be stored as ordinary application data.

11.19 Secrets
Things like:
Database credentials
Payment gateway secrets
Encryption keys
Email provider credentials
OAuth secrets
API credentials
should be managed through a proper secret-management mechanism.
Never place production secrets in:
Source code
Git repositories
Frontend code
Plain configuration committed to version control

11.20 API Security
The API should have controls for:
Authentication
Authorization
Input validation
Rate limiting
Request size limits
Content validation
Secure headers
Logging
Endpoints that are particularly sensitive should receive stricter rate limits.
Examples:
Login
Password reset
OTP
Payment
Invitation
Bulk import
Export

11.21 Rate Limiting
Rate limiting should be applied at several levels.
For example:
IP
User
Tenant
Endpoint
Authentication identity
The exact strategy depends on the infrastructure.
The important point is that a single school or malicious user should not be able to consume unlimited platform resources.

11.22 Bulk Operations
Bulk imports and exports can be dangerous because they combine:
Large volume
Sensitive data
Long processing time
Potential resource exhaustion
Therefore:
Upload
 ↓
Validate
 ↓
Queue
 ↓
Process
 ↓
Generate result
 ↓
Notify
rather than processing huge files directly in a normal request.
Tenant context must travel with the job.

11.23 File Security
Files need:
Tenant ownership
Authorization
Access expiration
File type validation
Size limits
Malware scanning where appropriate
Private storage
Don't expose predictable permanent URLs such as:
/files/student123.pdf
Use controlled access mechanisms.

11.24 File Ownership
Every file should have a relationship similar to:
File
 ├── tenant_id
 ├── owner_type
 ├── owner_id
 ├── storage_reference
 └── metadata
Before serving the file:
User
 ↓
Tenant
 ↓
Permission
 ↓
Entity ownership
 ↓
File access

11.25 Data Export
Exports can create a major data-leak path.
For example:
Export all students
should verify:
Tenant
+
Permission
+
Feature entitlement
+
Scope
The resulting file must also remain tenant-protected.

11.26 Platform Exports
A platform admin may have permission to export data across schools.
That must be an explicitly privileged operation:
platform.data.export
rather than:
student.export
This distinction is useful because tenant-level and platform-level exports have very different security implications.

11.27 Backup Architecture
Backups should preserve the tenant data even when a subscription expires.
Remember:
Subscription expired
≠
Data deleted
Backups should be:
Encrypted
Access controlled
Monitored
Tested through restoration
The exact retention period can be defined based on business and regulatory requirements.

11.28 Disaster Recovery
We should establish two concepts:
RPO
How much data can potentially be lost after a catastrophic failure?
RTO
How quickly should the platform be restored?
These values should be business decisions rather than guessed during implementation.
For example:
RPO → X hours
RTO → Y hours
The infrastructure design can then be chosen accordingly.

11.29 Restore Testing
A backup that has never been restored is not enough.
We should eventually have a controlled process to test:
Backup
 ↓
Restore
 ↓
Verify
 ↓
Tenant data integrity
 ↓
Application functionality
This is especially important for a multi-tenant SaaS because a restoration failure could affect many schools simultaneously.

11.30 Failure: Entitlement Service Unavailable
Suppose:
Entitlement service
      ↓
temporarily unavailable
We should avoid automatically granting access.
For security:
Cannot verify entitlement
        ↓
Do not grant new privileged access
But blindly denying every request could make the platform unusable.
Therefore a cached/read-only entitlement snapshot may be useful.
Conceptually:
Primary entitlement state
        ↓
Cache
        ↓
Short-lived fallback
The exact fail-open/fail-closed behavior should depend on operation sensitivity.
For example:
Read dashboard
→ cached state may be acceptable

Financial/admin operation
→ require authoritative authorization

11.31 Failure: Authorization Service Unavailable
This is more sensitive.
For authorization failure:
Fail closed for protected operations.
Do not interpret:
authorization unavailable
as:
authorization approved
Otherwise an infrastructure problem becomes a security vulnerability.

11.32 Failure: Database Unavailable
Normal behavior:
Database unavailable
 ↓
Request fails safely
Don't return fabricated success.
Write operations should be atomic where possible.

11.33 Failure: Notification Service Unavailable
Notification failure should generally not roll back the primary business operation.
Example:
Subscription renewed
 ↓
Database success
 ↓
Notification service unavailable
The renewal should remain successful.
The notification can be retried asynchronously.

11.34 Failure: Payment Gateway Timeout
This requires special care.
Suppose:
Payment initiated
 ↓
Gateway timeout
We must not assume:
Payment failed
because the gateway may have processed it.
Use an intermediate state such as:
PENDING / UNKNOWN
until the payment status is verified.
This prevents duplicate charges and incorrect subscription states.

11.35 Payment Idempotency
Payment operations must be idempotent.
If the same gateway callback arrives twice:
Payment Event #123
Payment Event #123
the system must not record two payments.
Use a unique provider transaction/reference identifier.

11.36 Subscription Renewal Idempotency
The same principle applies to renewal.
If a renewal event is delivered twice:
SubscriptionRenewed
SubscriptionRenewed
the platform must not:
extend subscription twice
or:
create duplicate invoices
Operations involving external systems should be designed for retries.

11.37 Feature Disable Failure
Suppose:
Feature disable requested
 ↓
Dependency analysis
 ↓
Failure before commit
The system should remain in the previous consistent state.
Avoid partially disabling:
Student Management = OFF
Examination = ON
if Examination requires Student Management, unless the system explicitly supports a blocked state.

11.38 Provisioning Failure
School provisioning:
School Approved
 ↓
Create tenant
 ↓
Create admin
 ↓
Create subscription
If step 3 fails, don't mark the school fully active.
Use:
PROVISIONING
until all required initialization succeeds.
Retries should be safe.

11.39 Concurrency
Two administrators may change the same thing simultaneously.
Example:
Admin A disables Fees
Admin B upgrades subscription
The system needs consistency controls.
Potential mechanisms include:
Optimistic locking
Version fields
Database transactions
Unique constraints
We don't need to decide the exact implementation yet, but concurrency must be part of the design.

11.40 Race Condition Example
Suppose a subscription is expired at:
10:00
and renewed at:
09:59:59
while an expiration job executes at:
10:00
The system must not incorrectly leave the subscription expired after successful renewal.
The subscription state transition should be transactionally validated against the current state/version.

11.41 Security Around Role Changes
Suppose a School Admin changes a user's role from:
Teacher
to:
Finance Admin
The permission change should take effect predictably.
If active sessions/cache contain old permissions, we need a mechanism to invalidate or refresh authorization state.
Conceptually:
Role Changed
 ↓
Permission version changes
 ↓
Cached authorization invalidated
 ↓
New requests use updated permissions

11.42 Security Around User Removal
If a user is removed from School A:
Membership = REVOKED
their active sessions should not continue granting School A access indefinitely.
The platform should have a session/membership validation mechanism.

11.43 Security Around Platform Employees
Platform accounts deserve stronger security because compromise could affect multiple tenants.
Potential controls:
MFA
Strong authentication policy
Session restrictions
Detailed audit
Privileged-action logging
Optional re-authentication
The architecture should allow stricter policies for:
PLATFORM
than ordinary school users.

11.44 Tenant Data Leak Through Logs
Be careful with application logs.
Don't accidentally log:
Student full personal data
Passwords
Payment credentials
Tokens
Sensitive documents
Logs should generally contain identifiers and diagnostic information, not unnecessary sensitive payloads.
For example:
GOOD:
tenant_id=123 student_id=456 action=CREATE

BAD:
tenant_id=123 student={
    full personal record...
}

11.45 Error Messages
Errors should provide enough information for legitimate users but not leak internal details.
Avoid exposing:
SQL queries
stack traces
internal service credentials
database structure
other tenant identifiers
in production responses.

11.46 Monitoring
We should monitor security-relevant events such as:
Repeated failed login
Account lock
Permission changes
Role changes
Tenant access denied
Suspicious cross-tenant access attempts
Payment anomalies
Repeated API failures
Unusual export activity
This is different from the business audit log, although the two systems can integrate.

11.47 Audit vs Application Logs
Keep these conceptually separate.
Audit
Business/security action:
User A changed User B's role.
Application log
Technical event:
Authorization cache miss.
Security event
Potential security concern:
25 failed login attempts from same source.
One event may appear in more than one system, but their purposes differ.

11.48 Data Retention
We should define retention policies for:
Audit
Invoices
Payments
Subscriptions
School data
User accounts
Files
Logs
Backups
Don't automatically delete tenant data merely because the subscription expires.
Retention and subscription status are separate concerns.

11.49 Security Principles to Lock In
The following should be considered architectural rules:
Never trust client-provided tenant identity.
Never rely on UI restrictions for authorization.
All tenant-owned data is tenant-scoped.
Protected operations fail closed when authorization cannot be established.
Billing/payment operations are idempotent.
Audit records are append-oriented and protected.
Expired subscriptions don't delete data.
Platform users require explicit tenant scope where applicable.
Sensitive actions require stronger auditing and potentially additional verification.
Background jobs carry tenant context.
Caches and files are tenant-isolated.
Backups and restoration are part of the security architecture.

11.50 Failure-Handling Model
The platform should generally follow:
EXPECTED FAILURE
       ↓
Controlled State
       ↓
Retry / Recovery
       ↓
Audit
       ↓
Notification if required
Not:
Unexpected failure
       ↓
Partial database state
       ↓
Incorrect access

11.51 The Complete Security Boundary
We can now describe a request as:
                         REQUEST
                            │
                     Authentication
                            │
                     Identity Verified
                            │
                     Membership Valid
                            │
                      Tenant Context
                            │
                  School Lifecycle Check
                            │
                     Entitlement Check
                            │
                     Permission Check
                            │
                       Scope Check
                            │
                    Domain Validation
                            │
                  Tenant-aware Database
                            │
                  Audit + Domain Event
                            │
                         RESPONSE
That is the security foundation future modules inherit.

Architecture Status
At this point, the platform foundation is substantially complete:
┌───────────────────────────────────────────┐
│              PLATFORM CORE               │
├───────────────────────────────────────────┤
│ Identity & Authentication                 │
│ Tenant / School Management                │
│ RBAC / Permissions                        │
│ Feature Catalog                           │
│ Feature Dependencies                      │
│ Plans & Pricing                           │
│ Subscription & Billing                    │
│ Entitlement Engine                        │
│ Platform Administration                   │
│ Audit                                     │
│ Notifications                             │
│ Files                                     │
│ Events / Background Jobs                  │
│ Security / Data Isolation                 │
└─────────────────────┬─────────────────────┘
                      │
              DOMAIN MODULES
                      │
       ┌──────────────┼──────────────┐
       │              │              │
    Students       Teachers         Fees
       │              │              │
    Examination   Attendance    Transportation
       │              │              │
       └──────────────┴──────────────┘
The next useful step is Part 12 — Architecture Decision Record (ADR) & Final Foundation Blueprint.
That will consolidate all the decisions we've made into one reference architecture, identify the decisions that are locked, those that are intentionally deferred, and the few remaining decisions we should settle before beginning the Phase 2 domain design.
