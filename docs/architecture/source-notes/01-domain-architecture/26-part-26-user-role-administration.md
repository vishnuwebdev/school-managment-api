<!-- Source: Apple Notes, folder 'Notes' -->
# Part 26 — User & Role Administration

This domain is one of the most important platform foundations because nearly every other domain depends on it for controlled access.
The central rule is:
Identity answers who the user is. User & Role Administration answers what that user is allowed to do, where, and under which scope.
It must remain separate from individual business domains.

26.1 Domain Purpose
User & Role Administration
├── User Administration
├── Memberships
├── Roles
├── Permissions
├── Role Assignments
├── Access Scopes
├── Invitations
├── Account Status
├── Access Reviews
└── User Access History
It works closely with:
Identity
Tenant Management
Feature / Entitlement
Audit

26.2 Identity vs Authorization
These must remain distinct.
Identity
Answers:
Who is this?
User
├── Identity
├── Credentials / authentication references
├── Contact information
└── Account status
Authorization
Answers:
What can this user do?
Membership
 ↓
Role Assignment
 ↓
Permission
 ↓
Scope
A successful login does not mean the user can access every school function.

26.3 Core Model
The conceptual model is:
USER
 ↓
MEMBERSHIP
 ↓
SCHOOL / PLATFORM CONTEXT
 ↓
ROLE ASSIGNMENT
 ↓
ROLE
 ↓
PERMISSION
 ↓
SCOPE
And separately:
USER
 ↓
AUTHENTICATION
Authentication establishes identity; authorization establishes access.

26.4 User
A User represents a human/system identity.
It should not contain:
school_id
role_id
as fundamental ownership fields.
Instead:
User
 ├── Membership A → School A
 ├── Membership B → School B
 └── Platform Membership
This preserves multi-tenant flexibility.

26.5 Membership
Membership connects a user to a context.
Membership
├── User
├── Tenant / School
├── Status
├── Joined At
└── Context Metadata
Examples:
User X
 ├── School A → Active
 └── School B → Suspended

26.6 Platform Membership
Platform users may have no school context.
For example:
Super Admin
Platform Admin
Billing Admin
Support Admin
Sales Admin
Operations Admin
Their membership context can be platform-wide.

26.7 School Membership
Normal school users generally have:
User
 ↓
School Membership
 ↓
School
The same user can still belong to multiple schools if the business requires it.

26.8 Membership Lifecycle
Recommended:
Invited
 ↓
Active
 ↓
Suspended
 ↓
Revoked
Potentially:
Expired
Archived
Revoking membership should immediately affect authorization.

26.9 Account Status vs Membership Status
These are different.
User account:
Active
Suspended
Disabled
Membership:
School A → Active
School B → Suspended
A user could therefore have:
User Account = Active
School A Membership = Active
School B Membership = Suspended
This is why access cannot be determined solely from account status.

26.10 Role
A Role is a reusable permission bundle.
Examples:
School Admin
Teacher
Librarian
Accountant
Attendance Officer
Exam Coordinator
Transport Manager
Roles should not be treated as hardcoded authorization logic.

26.11 System Roles vs Custom Roles
Support both:
System Roles
Custom Roles
Example:
System:
School Admin

Custom:
Junior Academic Coordinator
The custom role may contain selected permissions.

26.12 Role Lifecycle
Draft
 ↓
Active
 ↓
Disabled
 ↓
Archived
System roles may have additional restrictions.

26.13 Permission
Permissions are the stable authorization contracts.
Examples:
student.view
student.create
student.update

attendance.view
attendance.create
attendance.approve

fee.view
fee.payment.create
fee.refund.approve

exam.result.publish
Permissions should represent actions, not UI pages.

26.14 Permission Naming
A consistent convention is useful:
<domain>.<resource>.<action>
Examples:
student.profile.view
student.profile.update

exam.result.publish
exam.mark.correct

library.book.issue
library.book.return
The exact naming convention should be standardized before implementation.

26.15 Avoid Page Permissions
Avoid:
can_access_student_page
Prefer:
student.view
student.update
student.export
A page may require multiple permissions.

26.16 Role Assignment
A user can have multiple roles.
Example:
User
 ├── Teacher
 └── Exam Coordinator
Effective permissions become the union of permitted role permissions, subject to restrictions.

26.17 Role Assignment Scope
A role can have a scope.
Examples:
Teacher
Scope: Assigned Classes

Attendance Officer
Scope: Entire School

Subject Coordinator
Scope: Mathematics
This allows granular authorization without creating hundreds of roles.

26.18 Scope Types
Initial architecture can support:
ALL_TENANT
ASSIGNED_CLASS
ASSIGNED_SECTION
ASSIGNED_SUBJECT
OWN_RECORD
SELECTED_RESOURCE
Not all need to be implemented immediately.

26.19 Platform Scopes
Platform roles can use:
ALL_TENANTS
SELECTED_TENANTS
NO_TENANT
Example:
Support Admin
Scope:
Selected Schools
This prevents a support employee from automatically seeing every tenant.

26.20 School Admin
School Admin is a role, not a special hardcoded user type.
It may have broad permissions such as:
user.manage
role.manage
student.manage
academic.manage
teacher.manage
attendance.manage
exam.manage
fee.manage
transport.manage
library.manage
communication.manage
But:
School Admin permissions do not bypass entitlement.
If the school has no Library feature:
Library permission = granted
Library entitlement = absent
access is still denied.

26.21 Sub Admin
A Sub Admin is not a fundamentally different identity.
It is a user with selected administrative permissions.
Example:
Sub Admin
 ├── student.view
 ├── student.update
 ├── attendance.view
 └── attendance.approve
This is much more flexible than creating:
SubAdminTypeA
SubAdminTypeB
SubAdminTypeC

26.22 Teacher Access
A teacher may have:
teacher.view_own
attendance.create
attendance.update
exam.mark.create
timetable.view_own
with scope determined by teaching assignments.
The teacher should not automatically get:
student.export
fee.view
unless explicitly granted.

26.23 Role Templates
Schools may benefit from templates:
Teacher
Librarian
Accountant
Transport Manager
Receptionist
Academic Coordinator
A template creates an initial role configuration that the school can customize where permitted.

26.24 Direct Permission Overrides
The architecture can support:
Role
 ↓
Permissions
plus exceptional:
User
 ↓
Direct Permission Override
However:
Direct user-level overrides should be exceptional, audited, and not the normal administration mechanism.
Otherwise authorization becomes difficult to reason about.

26.25 Permission Evaluation
The authorization engine conceptually evaluates:
Authenticated User
      ↓
Membership
      ↓
Role Assignments
      ↓
Permissions
      ↓
Scope
      ↓
Tenant Context
      ↓
Resource
      ↓
ALLOW / DENY
And then the entitlement check remains separate:
Permission
+
Scope
+
Entitlement
+
Lifecycle
=
Effective Access

26.26 Authorization Is Not Entitlement
These are different questions.
Authorization
"Can this user perform fee.refund?"
Entitlement
"Does this school have Fee Management?"
Both must be satisfied.

26.27 Authorization Is Not Approval
Another distinction:
Permission
means:
Can this user perform this action?
Approval means:
Has this particular business operation been approved?
Example:
User has fee.refund.approve
does not mean:
Every refund is automatically approved.

26.28 User Invitation
School Admin may invite users.
Flow:
Create Invitation
 ↓
Assign Membership
 ↓
Assign Initial Role
 ↓
Send Invitation
 ↓
User Activates Account
 ↓
Membership Active
Communication sends the invitation.
Identity handles activation/authentication.

26.29 Invitation Security
Invitation links should:
expire,
be single-use,
be securely generated,
not expose unnecessary tenant information,
be invalidated after activation/revocation.

26.30 User Creation
Creating a user and granting access should be treated as related but distinct operations.
Conceptually:
Create User
 ↓
Create Membership
 ↓
Assign Role
If role assignment fails, the system should not leave the user with unintended privileged access.

26.31 Role Changes
Example:
Teacher
 ↓
Academic Coordinator
The old role assignment should have historical information.
Avoid overwriting history with:
role = Academic Coordinator
without retaining what changed and when.

26.32 Access Revocation
When a membership is revoked:
Membership Revoked
 ↓
Authorization Denied
 ↓
Permission Cache Invalidated
 ↓
Sessions/Tokens handled according to security policy
Access should stop promptly.

26.33 Suspension
Suspension is different from revocation.
Suspended
can mean temporary restriction.
The user may later be restored.
Revocation can represent permanent termination of that membership.

26.34 School-Level User Administration
School Admin should be able to:
View Users
Invite User
Activate User
Suspend User
Revoke Membership
Assign Role
Remove Role
Configure Scope
Review Access
subject to their permissions.

26.35 Platform-Level User Administration
Platform administrators may manage:
Platform Users
Platform Roles
School Memberships
Cross-Tenant Support Access
with stronger restrictions and auditing.

26.36 Cross-Tenant Access
A platform user with:
ALL_TENANTS
may perform authorized platform operations across schools.
A user with:
SELECTED_TENANTS
must be limited to those tenants.
A school user must never obtain cross-tenant access simply by modifying a request parameter.

26.37 Explicit Context Switching
For platform users:
Platform Context
      ↓
Select Authorized School
      ↓
School Context
      ↓
Perform Operation
The selected school must be validated against the user's platform scope.

26.38 Impersonation
Do not make impersonation part of the normal V1 model.
If introduced later:
Support User
 ↓
Explicit Support Session
 ↓
Target User
must preserve:
Real Actor
Target User
Tenant
Reason
Start
End
Actions
A support session must never make audit logs appear as if the target user performed the action.

26.39 Access Review
Schools may eventually need:
"Who currently has access to Fees?"
The system should be able to derive:
Users
 ↓
Roles
 ↓
Permissions
 ↓
Scopes
This becomes especially valuable as custom roles grow.

26.40 Permission Dependency
Some permissions may require others.
Example:
student.delete
may implicitly require:
student.view
Rather than relying on UI assumptions, such dependencies should be defined at authorization level if necessary.

26.41 Permission Lifecycle
Permissions should be version-safe.
ACTIVE
DEPRECATED
If a permission is retired, existing roles should be handled explicitly.
Do not silently reinterpret:
fee.refund
into a completely different action.

26.42 Role Deletion
Avoid physically deleting roles that have historical assignments.
Prefer:
Role
 ↓
Disabled / Archived
Historical assignments remain understandable.

26.43 Custom Role Editing
If a custom role changes:
Role
 ↓
Permissions Changed
the affected users should immediately receive the new effective permissions after cache/session invalidation.
Sensitive changes should be audited.

26.44 Permission Cache
Authorization may require caching for performance.
But cache invalidation must happen when:
Role permissions change
Role assignment changes
Membership revoked
Scope changes
User suspended
Security correctness takes priority over cache performance.

26.45 Authorization Failure
Protected operations fail closed.
For example:
Permission service unavailable
        ↓
Do NOT assume permission
        ↓
DENY protected operation
This follows the security architecture already established.

26.46 User Status and School Status
Authorization should consider both:
User Status
+
Membership Status
+
School Lifecycle
Example:
User = Active
Membership = Active
School = Suspended
School operational access should still be restricted according to school lifecycle policy.

26.47 Subscription Interaction
Likewise:
User
 ↓
Membership
 ↓
Permission
 ↓
School
 ↓
Subscription
 ↓
Entitlement
A valid user with valid permission does not override an expired/unentitled feature.

26.48 Sensitive Permissions
Some permissions deserve additional protection:
user.suspend
role.manage
permission.override
fee.refund.approve
fee.writeoff.approve
school.suspend
subscription.override
The architecture can later support:
Reason Required
Re-authentication Required
Second Approval Required
without changing the basic RBAC model.

26.49 Audit
User/RBAC changes are highly auditable.
Audit:
User Created
User Invited
Membership Created
Membership Suspended
Membership Revoked

Role Created
Role Updated
Role Disabled

Role Assigned
Role Removed

Permission Added
Permission Removed

Scope Changed
Direct Permission Override
Important audit information:
Actor
Tenant
Target User
Target Role
Action
Before
After
Reason
Timestamp
Request ID

26.50 Events
Potential events:
UserCreated
UserInvited
UserActivated
UserSuspended
UserRestored

MembershipCreated
MembershipSuspended
MembershipRevoked

RoleCreated
RoleUpdated
RoleDisabled

RoleAssigned
RoleRemoved

PermissionSetChanged
ScopeChanged
Other platform services can consume them.

26.51 Notifications
Examples:
User invited
Role changed
Access revoked
Account suspended
Flow:
User/RBAC Event
 ↓
Communication
 ↓
Email / SMS / In-App

26.52 Reports
Useful administrative reports:
Users
Users by Role
Users by Feature Access
Role Assignments
Inactive Users
Suspended Users
Pending Invitations
Access Review
Permission Matrix
A permission matrix can be especially useful:
Role              Student  Fees  Exams  Library
------------------------------------------------
Teacher             View     -    Edit     -
Accountant           -      Edit    -      -
Librarian            -       -      -     Edit
This is a derived administrative view.

26.53 Bulk User Administration
Schools may need to onboard many users.
Support:
Bulk Import
 ↓
Validation
 ↓
Duplicate Detection
 ↓
Preview
 ↓
Confirm
 ↓
Background Processing
 ↓
Results
Bulk role assignment can use the same mechanism.

26.54 User Import Safety
An import should not silently grant broad access.
For example:
CSV:
Name
Email
Role
must validate that:
Role exists
Role is assignable
Permissions are allowed
Scope is valid
before activation.

26.55 School Admin Boundaries
A School Admin can only administer their own tenant.
They cannot:
Create another school
Modify platform roles
Modify another school's users
Change platform billing
Grant themselves platform permissions
unless explicitly authorized through platform-level access—which should not normally be possible for a school account.

26.56 Feature Visibility
UI can hide unavailable features:
No Library entitlement
→ Hide Library menu
But backend authorization must still enforce:
Permission
+
Entitlement
UI hiding is never security.

26.57 Domain Permission Ownership
Each domain defines its own permissions.
For example:
Student domain defines:
student.view
student.create
student.update
student.archive
Fees defines:
fee.view
fee.payment.create
fee.refund.approve
User & Role Administration manages assignment.
This prevents the central RBAC module from becoming responsible for every domain's business rules.

26.58 Final Authorization Model
The complete decision becomes:
                 USER
                   │
             Authentication
                   │
                   ↓
              MEMBERSHIP
                   │
             Tenant Context
                   │
                   ↓
            ROLE ASSIGNMENTS
                   │
                   ↓
               PERMISSIONS
                   │
                   ↓
                 SCOPE
                   │
                   ↓
          SCHOOL LIFECYCLE
                   │
                   ↓
             ENTITLEMENT
                   │
                   ↓
          DOMAIN BUSINESS RULES
                   │
                   ↓
              ALLOW / DENY
This is the foundation that all previous domains should use.

26.59 What We Should Not Finalize Yet
Defer:
❌ Exact database schema
❌ Exact permission catalogue
❌ Full UI for role management
❌ Complex policy engine
❌ Attribute-based authorization
❌ Organization-wide SSO
❌ Advanced delegated administration
❌ Full approval/workflow engine
The architecture should support these later without requiring them now.

26.60 Final Domain Boundary
                 IDENTITY
                    │
                    ↓
                   USER
                    │
                    ↓
               MEMBERSHIP
                    │
                    ↓
             USER & ROLE ADMIN
                    │
         ┌──────────┼──────────┐
         ↓          ↓          ↓
       Roles    Permissions   Scopes
         │          │          │
         └──────────┼──────────┘
                    ↓
              AUTHORIZATION
                    │
       ┌────────────┼─────────────┐
       ↓            ↓             ↓
    Student       Fees         Examination
       ↓            ↓             ↓
       └────────────┼─────────────┘
                    ↓
                ENTITLEMENT
The most important outcome is that RBAC remains generic and reusable, while individual domains continue to own their own business permissions.

Updated Domain Map
Platform
├── Identity / User & Role Administration
├── Tenant Management
├── Plans / Pricing / Billing
├── Feature Catalog / Entitlements
├── Audit
└── Platform Services

School Domains
├── Student
├── Academic
├── Teacher
├── Attendance
├── Examination
├── Fees
├── Transportation
├── Communication
├── Timetable
├── Library
├── Leave / Staff Operations
└── Parent / Guardian Portal
Next: Part 27 — Reports & Analytics. This will establish how reporting can span multiple domains without allowing the Reporting domain to take ownership of everyone else's business data.
