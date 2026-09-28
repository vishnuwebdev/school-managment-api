<!-- Source: Apple Notes, folder 'BAckend' -->
# Part 24 — Identity, Tenant, RBAC & Entitlements

This is the core security and tenancy layer used by every other module.
1. Core Model
User
 │
 ├── Sessions
 ├── MFA
 └── Tenant Membership
          │
          ├── Roles
          │     └── Permissions
          │
          └── Tenant
                 │
                 └── Entitlements
Important distinction:
User       = authentication identity
Membership = user's relationship with a school/tenant
Role       = permission grouping
Permission = specific capability
Entitlement = feature available to tenant

2. Identity
Tables
users
user_sessions
user_mfa_methods
password_reset_tokens
email_verification_tokens
User:
id
email
phone
password_hash
first_name
last_name
status
email_verified_at
last_login_at
created_at
updated_at
Passwords are stored only as strong password hashes.

3. Sessions
user_sessions
Contains:
id
user_id
refresh_token_hash
device_name
device_type
ip_address
user_agent
expires_at
revoked_at
created_at
Never store raw refresh tokens.

4. Authentication APIs
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/logout
POST /api/v1/auth/refresh

POST /api/v1/auth/forgot-password
POST /api/v1/auth/reset-password

POST /api/v1/auth/verify-email

POST /api/v1/auth/mfa/setup
POST /api/v1/auth/mfa/verify
POST /api/v1/auth/mfa/disable

GET  /api/v1/auth/me
GET  /api/v1/auth/sessions
DELETE /api/v1/auth/sessions/:id

5. Authentication Flow
Login
 ↓
Validate credentials
 ↓
Validate user status
 ↓
MFA if required
 ↓
Load memberships
 ↓
Select tenant context
 ↓
Issue access token
 ↓
Create refresh session
Access token contains minimal identity information.
Do not place large permission/feature payloads into the token.

6. Tenant Model
tenants
tenant_settings
tenant_domains
tenant_status_history
Tenant represents the school/organization boundary.
Example:
Tenant A
 ├── Users
 ├── Students
 ├── Teachers
 ├── Fees
 └── Everything belonging to School A

Tenant B
 ├── Users
 ├── Students
 ├── Teachers
 ├── Fees
 └── Everything belonging to School B
Data cannot cross this boundary.

7. Tenant APIs
GET   /api/v1/tenants/current
PATCH /api/v1/tenants/current

GET   /api/v1/tenants/current/settings
PATCH /api/v1/tenants/current/settings

GET   /api/v1/tenants/current/members
POST  /api/v1/tenants/current/members
PATCH /api/v1/tenants/current/members/:id
DELETE /api/v1/tenants/current/members/:id
Platform administrators have separate tenant-management APIs.

8. Tenant Context
Every authenticated request establishes:
tenantId
userId
membershipId
roles
permissions
entitlements
Example:
Authorization
      ↓
User
      ↓
Membership
      ↓
Tenant
      ↓
Tenant Context
Every repository query automatically receives tenant scope.

9. Tenant Isolation
This is mandatory:
WHERE tenant_id = authenticatedTenantId
Never:
WHERE tenant_id = request.body.tenant_id
The client cannot choose an arbitrary tenant.
Also validate resource ownership:
Student A
belongs to Tenant A

User from Tenant B
→ cannot access Student A

10. Roles
System roles:
PLATFORM_ADMIN
SCHOOL_ADMIN
PRINCIPAL
TEACHER
ACCOUNTANT
HR_MANAGER
LIBRARIAN
TRANSPORT_MANAGER
STAFF
PARENT
STUDENT
These are initial roles, not permanent limitations.
Tenants can have custom roles.

11. Permissions
Permissions follow:
domain.resource.action
Examples:
students.read
students.create
students.update
students.delete

attendance.read
attendance.mark
attendance.correct
attendance.approve

fees.read
fees.create
fees.payment.create
fees.payment.refund

results.read
results.enter
results.publish

library.read
library.issue
library.return

transport.read
transport.assign

inventory.read
inventory.issue
inventory.adjust

staff.read
staff.create
staff.update
staff.offboard

12. RBAC Tables
roles
permissions
role_permissions
user_roles
Relationship:
User
 ↓
Role
 ↓
Permission
Users may have multiple roles.

13. Authorization
Central service:
AuthorizationService.can(
    user,
    permission,
    resource?
)
Examples:
can(user, "students.read")
can(user, "fees.payment.create")
can(user, "results.publish")
For resource-level authorization:
can(
    user,
    "students.read",
    student
)
This allows rules such as:
Parent → linked students only
Teacher → assigned students/classes
School Admin → entire tenant

14. Entitlements
Entitlements answer:
Is this feature available to this tenant?
Example:
attendance
examinations
fees
library
transport
inventory
hr
advanced_reports
sms
Tables:
features
plans
plan_features
subscriptions
subscription_items
entitlements

15. Entitlement Evaluation
Permission
     +
Tenant Entitlement
     ↓
Access
Example:
User has:
fees.payment.create

Tenant has:
fees = enabled

Result:
ALLOW
If the user has permission but the tenant does not have the feature:
FEATURE_NOT_ENABLED

16. Plan Independence
Never write business logic such as:
if plan === "PRO"
Instead:
if entitlement("advanced_reports")
This allows plans to change without rewriting application logic.

17. Entitlement Lifecycle
Plan
 ↓
Subscription
 ↓
Entitlements
 ↓
Feature Access
Subscription changes should update effective entitlements.
Historical subscription data remains preserved.

18. Authorization Middleware
Standard route:
authenticate()
   ↓
tenantContext()
   ↓
authorize("students.read")
   ↓
entitlement("students")
   ↓
controller()
Example:
GET /students
requires:
students.read
+
students feature enabled

19. Platform vs Tenant Administration
Separate authority levels.
Platform
Can manage:
tenants
plans
subscriptions
platform billing
system features
platform users
Tenant
Can manage:
school settings
users
roles
students
teachers
school operations
A school administrator must never gain platform-level permissions merely by receiving a custom tenant role.

20. Parent / Student Access
Parent access is relationship-based.
Parent User
 ↓
Guardian Membership
 ↓
Student Relationship
 ↓
Student
Every request must verify the relationship.
Example:
GET /portal/students/123/fees
must verify:
student 123
belongs to tenant
AND
student 123
is accessible to current guardian

21. Security Events
Record security-sensitive events:
LOGIN_SUCCESS
LOGIN_FAILED
LOGOUT
PASSWORD_CHANGED
PASSWORD_RESET
MFA_ENABLED
MFA_DISABLED
SESSION_REVOKED

ROLE_ASSIGNED
ROLE_REMOVED
PERMISSION_CHANGED

TENANT_MEMBERSHIP_CREATED
TENANT_MEMBERSHIP_REVOKED

ENTITLEMENT_CHANGED
These go into the central audit system.

22. Account Lifecycle
INVITED
 ↓
ACTIVE
 ↓
SUSPENDED
 ↓
DEACTIVATED
Deactivated users:
cannot authenticate
cannot refresh sessions
retain historical audit references
Existing sessions should be revoked when appropriate.

23. Invitation Flow
Admin
 ↓
Create Membership
 ↓
Invitation
 ↓
Email / Notification
 ↓
User Accepts
 ↓
Account Created/Linked
 ↓
Role Assigned
 ↓
Tenant Access
Invitation tokens are:
random
short-lived
single-use
hashed in storage

24. Core Security Rules
The implementation must enforce:
✓ Authentication before protected operations
✓ Tenant isolation
✓ Permission checks
✓ Entitlement checks
✓ Resource ownership
✓ Server-side validation
✓ Audit logging
✓ Session revocation
✓ MFA support
✓ Rate limiting
✓ Secure password hashing
✓ No raw secrets in logs
✓ No client-controlled tenant authorization

25. Definition of Done
Identity/Tenant/RBAC/Entitlement is complete when:
✓ Registration
✓ Login
✓ Logout
✓ Refresh
✓ Password reset
✓ Email verification
✓ MFA
✓ Session management
✓ Tenant creation
✓ Tenant settings
✓ Memberships
✓ Invitations
✓ Roles
✓ Permissions
✓ Custom roles
✓ Tenant isolation
✓ Resource authorization
✓ Entitlements
✓ Subscription → entitlement propagation
✓ Security audit events
✓ Rate limiting
✓ Unit tests
✓ Integration tests
✓ E2E authentication tests

Platform Core Now Established
The dependency chain is:
Identity
   ↓
Tenant
   ↓
Membership
   ↓
RBAC
   ↓
Permissions
   ↓
Entitlements
   ↓
All Business Modules
Next: Part 25 — Shared Platform Services, covering Files, Notifications, Audit, Events/Outbox, Background Jobs, Storage, Reporting infrastructure, Search, and shared configuration in one pass.
