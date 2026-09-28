<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 1

Platform Core Foundation
This section converts the frozen architecture into implementation-level rules for the Node.js + Express + MySQL system.

1. Backend Module Structure
Use a modular-monolith structure:
src/
├── modules/
│   ├── identity/
│   ├── authentication/
│   ├── membership/
│   ├── authorization/
│   ├── tenant/
│   ├── feature-management/
│   ├── entitlement/
│   ├── subscription/
│   ├── billing/
│   ├── audit/
│   ├── security-events/
│   ├── files/
│   ├── notifications/
│   ├── jobs/
│   ├── events/
│   ├── integrations/
│   └── ...
│
├── shared/
│   ├── database/
│   ├── errors/
│   ├── http/
│   ├── security/
│   ├── validation/
│   ├── ids/
│   ├── time/
│   ├── logging/
│   └── config/
│
└── app/
    ├── middleware/
    ├── routes/
    └── bootstrap/
Each module follows:
module/
├── domain/
├── application/
├── infrastructure/
└── interfaces/
Responsibilities
Domain
Business entities, value objects, state transitions, domain rules.
Application
Use cases, orchestration, authorization invocation, transactions.
Infrastructure
MySQL repositories, providers, external adapters.
Interfaces
HTTP controllers/routes, event handlers, job handlers.
Controllers must remain thin.

2. Shared ID Strategy
Use opaque identifiers throughout the application.
Recommended:
UUIDv7-style identifiers.
Example:
user_id
membership_id
tenant_id
student_id
subscription_id
event_id
audit_id
Do not expose sequential database IDs as public resource identifiers.
Benefits:
non-guessable
distributed-generation friendly
sortable by creation time
suitable for future service extraction

3. Time Standard
Store timestamps in UTC.
Every timestamp field should clearly represent an instant:
created_at
updated_at
deleted_at
effective_from
effective_until
published_at
approved_at
Tenant timezone is stored separately.
Tenant
 ├── timezone
 └── locale/configuration
Business dates such as:
academic year dates
leave dates
examination dates
fee due dates
must be modeled as dates, not automatically converted timestamps.

4. Standard Entity Metadata
Most mutable business entities should have:
id
created_at
updated_at
Where lifecycle/history matters:
status
effective_from
effective_until
Where optimistic concurrency is appropriate:
version
Do not blindly add soft-delete fields to every table.
Use:
archive
deactivate
cancel
retire
revoke
expire
according to the actual business meaning.

5. Tenant Ownership Convention
Every tenant-owned table gets:
tenant_id
Example:
students
---------
id
tenant_id
student_number
...
Repositories require trusted tenant context.
Conceptually:
interface TenantContext {
  tenantId: TenantId;
  actorId: UserId;
  membershipId?: MembershipId;
  scope?: AuthorizationScope;
  contextType: 'TENANT';
}
The caller never supplies an authoritative tenant ID independently of the authenticated context.

6. Repository Convention
A tenant repository should conceptually look like:
studentRepository.findById(
  tenantContext,
  studentId
)
rather than:
studentRepository.findById(studentId)
The repository automatically applies:
WHERE tenant_id = :tenantId
Platform repositories use an explicit platform context.
This prevents accidental cross-tenant queries.

7. Standard Request Pipeline
Every authenticated tenant request follows:
HTTP
 ↓
Request ID
 ↓
Authentication
 ↓
Session Validation
 ↓
Tenant Context Resolution
 ↓
Tenant Lifecycle
 ↓
Authorization
 ↓
Entitlement
 ↓
Application Service
 ↓
Domain Rules
 ↓
Repository
 ↓
Audit/Event
 ↓
Response
The exact order can have controlled variations for endpoints such as login, but this is the standard business-request pipeline.

8. Standard API Response Model
Successful responses should be consistent.
Example:
{
  "data": {},
  "meta": {
    "request_id": "..."
  }
}
Collection:
{
  "data": [],
  "meta": {
    "request_id": "...",
    "pagination": {
      "page": 1,
      "page_size": 25,
      "total": 100
    }
  }
}
For large datasets, cursor pagination can be used instead of offset pagination.

9. Standard Error Model
{
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "You do not have permission to perform this action.",
    "request_id": "..."
  }
}
Internal diagnostics are never exposed directly.
Validation can include structured field errors:
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "fields": {
      "email": [
        "Invalid email format."
      ]
    },
    "request_id": "..."
  }
}

10. Database Naming Convention
Use:
snake_case
plural table names
singular domain concepts in code
foreign keys as <entity>_id
Examples:
users
memberships
roles
permissions
role_assignments
subscriptions
subscription_items
audit_records
security_events
Avoid ambiguous names such as:
data
records
info
settings_data

11. Identity Module
Responsibility
Identity owns the global user identity.
It does not own:
authentication sessions
school membership
roles
subscriptions
permissions
Core relationship:
User
 ├── Email
 ├── Phone
 └── Account Status
A user can belong to multiple schools through Membership.

12. users
Recommended structure:
users
-----
id
email
email_normalized
email_verified_at
phone
phone_normalized
phone_verified_at
first_name
middle_name
last_name
display_name
status
password_hash
password_changed_at
last_login_at
created_at
updated_at
Status
Use explicit account lifecycle:
PENDING
ACTIVE
SUSPENDED
DISABLED
Do not infer account status from email verification or membership.

13. Identity Constraints
Email and phone are globally unique after normalization.
Conceptually:
UNIQUE(email_normalized)
UNIQUE(phone_normalized)
Nullable values require appropriate database handling so multiple users can have no email/phone.
Identity uniqueness is platform-wide, not tenant-scoped.

14. Password Storage
Store only a secure password hash.
Recommended algorithm:
Argon2id
Never store:
password
plaintext_password
temporary_password
Password changes update:
password_hash
password_changed_at
and trigger appropriate session invalidation.

15. Authentication Module
Authentication owns:
password authentication
OTP authentication
email verification
phone verification
password reset
sessions
refresh tokens
authentication challenges
It does not decide school permissions.

16. auth_sessions
Recommended structure:
auth_sessions
-------------
id
user_id
current_context
current_tenant_id
refresh_family_id
created_at
last_activity_at
idle_expires_at
absolute_expires_at
revoked_at
revocation_reason
client_type
device_metadata
ip_metadata
created_by_auth_method
updated_at
current_context
PLATFORM
TENANT
For normal school users:
current_context = TENANT
current_tenant_id = school
For platform users:
current_context = PLATFORM
current_tenant_id = NULL

17. Refresh Tokens
Do not store raw refresh tokens.
Table:
refresh_tokens
--------------
id
session_id
family_id
token_hash
issued_at
expires_at
used_at
revoked_at
revocation_reason
replaced_by_token_id
created_at
The raw token exists only on the client.
Refresh:
old refresh token
        ↓
validate hash
        ↓
mark consumed
        ↓
create new refresh token
        ↓
return access + refresh
Reuse detection revokes the appropriate token family/session.

18. JWT Access Token
Tenant token:
{
  "sub": "user_id",
  "sid": "session_id",
  "context": "TENANT",
  "tenant_id": "tenant_id",
  "membership_id": "membership_id",
  "iat": 0,
  "exp": 0
}
Platform token:
{
  "sub": "user_id",
  "sid": "session_id",
  "context": "PLATFORM",
  "iat": 0,
  "exp": 0
}
Do not put authoritative roles, permissions, subscriptions or feature entitlements in the JWT.

19. Membership Module
Membership represents:
User's relationship with a school.
Table:
memberships
-----------
id
tenant_id
user_id
status
joined_at
effective_from
effective_until
revoked_at
revocation_reason
created_at
updated_at
Constraint:
UNIQUE(user_id, tenant_id)
One global user can therefore have:
User
 ├── Membership → School A
 ├── Membership → School B
 └── Membership → School C

20. Membership Status
Use:
ACTIVE
SUSPENDED
REVOKED
Future-dated membership is supported through:
effective_from
effective_until
Membership status is an authoritative security boundary.

21. Tenant Context Resolution
For tenant requests:
JWT
 ↓
session
 ↓
current context
 ↓
tenant
 ↓
membership
 ↓
tenant lifecycle
A client cannot change:
tenant_id
membership_id
simply by modifying the request.
Tenant switching is a dedicated server-side operation.

22. RBAC Module
Core tables:
roles
permissions
role_permissions
role_assignments
direct_permissions
Relationships:
Membership
    ↓
Role Assignment
    ↓
Role
    ↓
Permissions
Direct permissions are exceptional and separately audited.

23. Roles
roles
-----
id
scope_type
name
description
role_type
status
created_by
created_at
updated_at
Role types:
SYSTEM
CUSTOM
Role scope:
PLATFORM
TENANT
A platform role cannot accidentally become a tenant role.

24. Permissions
permissions
-----------
id
code
name
description
module
status
created_at
updated_at
Example:
student.view
student.create
student.update
student.delete
student.export

attendance.mark
attendance.correct

result.publish

fee.refund
Permission codes are stable API/domain contracts.

25. Role Assignments
role_assignments
----------------
id
membership_id
role_id
scope_type
status
effective_from
effective_until
assigned_by
reason
created_at
updated_at
Scope:
TENANT_WIDE
ASSIGNED_CLASSES
ASSIGNED_SUBJECTS
OWN_RECORDS
OWN_CREATED_RECORDS
Domain-specific scope resolution remains inside the domain.

26. Direct Permissions
direct_permissions
------------------
id
membership_id
permission_id
scope_type
status
effective_from
effective_until
granted_by
reason
created_at
updated_at
Direct grants are unioned with role-derived permissions.
There is no explicit deny model in V1.

27. Authorization Service
Central interface:
authorize({
  actor,
  context,
  permission,
  resource,
  scope
})
Conceptual evaluation:
Authentication
 ↓
Context
 ↓
Tenant Access
 ↓
Lifecycle
 ↓
Entitlement
 ↓
Permission
 ↓
Scope
 ↓
Domain Rules
Authorization must fail closed.

28. Feature / Entitlement Boundary
The authorization system should not contain commercial plan logic.
Instead:
Authorization
       ↓
Entitlement Service
       ↓
Feature / Sub-feature
Example:
student.create
       ↓
Student Management enabled?
       ↓
Admissions enabled?
       ↓
permission granted?
The exact feature dependency belongs to Feature Management/Entitlement.

29. Platform Roles
Initial system roles:
SUPER_ADMIN
PLATFORM_ADMIN
BILLING_ADMIN
SUPPORT_ADMIN
SALES_ADMIN
OPERATIONS_ADMIN
These are capabilities, not tenant access.
Tenant targeting is separately determined by:
platform tenant scope
+
tenant.access permission

30. Platform Tenant Assignments
Table:
platform_tenant_assignments
---------------------------
id
user_id
scope_type
tenant_id
status
effective_from
effective_until
assigned_by
reason
created_at
updated_at
Scope:
ALL_TENANTS
SELECTED_TENANTS
NO_TENANT
For ALL_TENANTS, tenant_id is null.
For SELECTED_TENANTS, explicit tenant records are required.

31. Authorization Cache
V1:
Node instance
   ↓
In-process authorization cache
   ↓
MySQL authoritative state
Cache:
never becomes the security authority
is tenant/context scoped
has configurable TTL
is invalidated where practical
falls back to MySQL when required
sensitive authorization state is freshly validated
No Redis dependency is required for V1.

32. Identity/Auth API Foundation
Initial endpoint structure:
POST /api/v1/auth/login

POST /api/v1/auth/otp/request
POST /api/v1/auth/otp/verify

POST /api/v1/auth/refresh
POST /api/v1/auth/logout

POST /api/v1/auth/password/forgot
POST /api/v1/auth/password/reset

POST /api/v1/auth/email/verify
POST /api/v1/auth/phone/verify

POST /api/v1/auth/switch-tenant
POST /api/v1/auth/leave-tenant
Additional identity/membership/RBAC endpoints belong to their respective modules rather than being placed under /auth.

33. Authentication Flow
Email/password
Identifier
 ↓
Normalize
 ↓
Find User
 ↓
Verify password
 ↓
Check account status
 ↓
Create session
 ↓
Resolve available context
 ↓
Issue token
If multiple schools:
Authenticated
 ↓
Tenant selection
 ↓
Switch tenant
 ↓
Tenant-scoped token

34. OTP Flow
OTP Request
 ↓
Rate Limit
 ↓
Create Challenge
 ↓
Hash OTP
 ↓
Provider Delivery
 ↓
Verify OTP
 ↓
Consume Challenge
 ↓
Authenticate User
Challenge:
otp_challenges
--------------
id
user_id / identifier reference
purpose
channel
destination_hash/reference
code_hash
expires_at
attempt_count
max_attempts
consumed_at
created_at
The OTP itself is never persisted in plaintext.

35. Authentication Challenge Purposes
LOGIN
PHONE_VERIFICATION
PHONE_CHANGE
PASSWORD_RESET
STEP_UP_AUTH
Future purposes can be added without changing the authentication architecture.

36. Email Verification
Invitation and verification are separate concepts.
email exists
      ≠
email verified
      ≠
account active
      ≠
membership active
This prevents lifecycle state from becoming ambiguous.

37. Invitation Model
invitations
-----------
id
tenant_id
email
user_id
membership_id
role/context metadata
token_hash
expires_at
accepted_at
revoked_at
created_by
created_at
Invitation tokens:
single-use
expiring
non-guessable
revocable
hashed server-side
If the user already exists, accepting an invitation creates/reactivates the appropriate membership rather than another user.

38. Transaction Boundaries
A use case owns its transaction.
Example:
Create Student
 ├── validate
 ├── authorize
 ├── create student
 ├── create related records
 ├── audit
 └── outbox event
        ↓
     COMMIT
Business state + required audit/outbox records that must be atomic belong in the same transaction.
External provider calls do not.

39. Platform Core Events
Initial important events:
UserCreated
UserActivated
UserSuspended
UserDisabled

EmailVerified
PhoneVerified

SessionCreated
SessionRevoked
RefreshTokenReuseDetected

MembershipCreated
MembershipActivated
MembershipSuspended
MembershipRevoked

RoleAssigned
RoleAssignmentSuspended
RoleAssignmentRevoked

DirectPermissionGranted
DirectPermissionRevoked

TenantAccessGranted
TenantAccessSuspended
TenantAccessRevoked
These are internal domain events unless explicitly promoted into an external integration contract.

40. Platform Core Audit Events
At minimum audit:
user creation/modification
account status changes
email/phone changes
privileged verification
membership changes
role assignment changes
direct permission changes
platform tenant-scope changes
session/security administration
tenant context entry/exit where relevant
privileged platform actions
Sensitive authentication events also go to Security Events.

41. Immediate Implementation Priority
The platform core implementation sequence should be:
1. Shared infrastructure
       ↓
2. Identity
       ↓
3. Authentication
       ↓
4. Membership
       ↓
5. Tenant Management
       ↓
6. Permissions / Roles
       ↓
7. Authorization
       ↓
8. Feature Catalog
       ↓
9. Entitlement Engine
       ↓
10. Subscription / Billing
       ↓
11. Audit / Security Events
       ↓
12. Files / Notifications / Jobs / Events
This gives every later business domain a stable foundation.
Next Specification
The next section will cover Tenant Management + School lifecycle + Feature Catalog + Entitlement Engine, including their exact MySQL schema, state machines, services, authorization, events, and APIs.
