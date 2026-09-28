<!-- Source: Apple Notes, folder 'Notes' -->
# Part 4 — RBAC & Permission Architecture

The key decision here is to keep commercial access and user authorization separate.
A school may be entitled to a feature, while a particular user may still not have permission to use it.
4.1 The Access Model
A user's ability to perform an action should conceptually be:
Authenticated User
       ↓
Valid Membership
       ↓
Tenant Context
       ↓
School Active / Recoverable
       ↓
Subscription / Entitlement
       ↓
Feature Enabled
       ↓
Sub-feature Enabled
       ↓
Role
       ↓
Permission
       ↓
Action
       ↓
ALLOW
So:
Subscription ≠ Permission
Feature ≠ Role
Role ≠ User
Each has a distinct responsibility.

4.2 Four Different Questions
When someone attempts:
Create Student
the system should answer four separate questions.
Question 1 — Does the school have the capability?
Does School A have Student Management?
Handled by:
Entitlement Engine

Question 2 — Is the specific capability enabled?
Is Student Management → Student Admission enabled?
Handled by:
Feature/Sub-feature configuration

Question 3 — Is this user allowed to perform the action?
Can this user create students?
Handled by:
RBAC / Permission Engine

Question 4 — Is this operation within the user's scope?
For example:
Can this Sub Admin create students
for School A?
Handled by:
Tenant/scope authorization

4.3 Permission Should Be Action-Level
I recommend making permissions relatively granular.
Instead of:
STUDENT_MANAGEMENT
use permissions such as:
student.view
student.create
student.update
student.delete
student.export
student.import
student.approve
Likewise:
teacher.view
teacher.create
teacher.update
teacher.delete
Fees:
fee.view
fee.create
fee.update
fee.delete
fee.collect
fee.refund
fee.export
Examinations:
exam.view
exam.create
exam.update
exam.delete
exam.publish
exam.result.enter
exam.result.approve
This gives the platform much more control.

4.4 Feature vs Permission
Consider:
Student Management
 ├── Student Profile
 ├── Admission
 ├── Import
 └── Reports
The feature hierarchy describes what the product provides.
Permissions describe what a user may do.
For example:
Feature:
Student Management

Sub-feature:
Admission

Permissions:
student.admission.view
student.admission.create
student.admission.update
student.admission.approve
Don't make the permission hierarchy depend too heavily on the feature hierarchy.
That keeps RBAC flexible if the product structure changes later.

4.5 Roles
A role is a reusable collection of permissions.
Example:
School Admin
 ├── student.*
 ├── teacher.*
 ├── class.*
 ├── fee.*
 ├── exam.*
 └── ...
A Sub Admin might have:
Academic Admin
 ├── student.view
 ├── student.update
 ├── teacher.view
 ├── class.*
 └── exam.*
Another:
Finance Admin
 ├── student.view
 ├── fee.*
 ├── payment.*
 └── fee.export
The important part is that roles are data/configuration, not hardcoded application logic.

4.6 Platform Roles
Platform roles should use the same RBAC mechanism.
For example:
Super Admin
Platform Admin
Billing Admin
Support Admin
Sales Admin
Operations Admin
Each is simply a role containing platform permissions.
For example:
billing.subscription.view
billing.subscription.update
billing.invoice.view
billing.payment.record
pricing.override
Support:
school.view
school.suspend
school.restore
user.view
support.ticket.manage
This means the platform can introduce:
Compliance Admin
Regional Admin
Partner Admin
Implementation Admin
later without rewriting authorization logic.

4.7 System Roles vs Custom Roles
We should support two types.
System roles
Created by the platform:
Super Admin
School Admin
Teacher
Their definitions are controlled by the platform.
Custom roles
Created/configured by an authorized administrator:
Academic Coordinator
Finance Manager
Transport Coordinator
Admission Officer
The role contains selected permissions.
This gives schools flexibility without allowing them to alter protected platform roles.

4.8 School Admin
School Admin should have a broad role within their tenant, but still remain subject to platform entitlements.
For example:
School Admin
    ↓
student.create
does not automatically mean access is granted.
The final check is:
School has Student Management
AND
School Admin has student.create
Both must be true.

4.9 Sub Admin
Sub Admin is not a special hardcoded permission model.
It is essentially:
User
 ↓
Membership
 ↓
Role Assignment
 ↓
Permissions
For example:
User: Rahul
Role: Finance Admin
School: School A
Permissions come from the role.
A user could potentially have multiple roles:
Rahul
 ├── Finance Admin
 └── Admission Officer
The effective permission set is the union of the allowed permissions, subject to any explicit restrictions we later decide to support.

4.10 Should Users Have Direct Permissions?
I recommend supporting them architecturally, but not making them the primary administration mechanism.
Primary:
User
 ↓
Role
 ↓
Permissions
Optional advanced capability:
User
 ↓
Permission Override
This allows an exceptional case such as:
Finance Admin
but one specific user additionally needs:
fee.export
without creating another role.
However, direct user overrides should be tightly audited because they make permission management harder to reason about.

4.11 Permission Assignment Model
Conceptually:
Role
 ├── Permission A
 ├── Permission B
 └── Permission C
and:
User
 └── Role Assignment
       ├── Role
       ├── Tenant
       ├── Scope
       └── Status
This is preferable to:
User
 ├── permission1
 ├── permission2
 ├── permission3
 ├── permission4
 └── ...
because roles remain manageable.

4.12 Scope
Permissions may eventually need different scopes.
For example:
student.view
could mean:
ALL_STUDENTS
or:
ONLY_ASSIGNED_CLASSES
or potentially:
ONLY_OWN_RECORDS
I would not build an elaborate scope engine immediately.
But the authorization model should leave room for:
Permission
+
Scope
later.
This avoids painting ourselves into a corner.

4.13 Feature Entitlement + RBAC Example
Suppose School A purchased:
Student Management
Fee Management
but not:
Transportation
School Admin has:
student.*
fee.*
transport.*
The results should be:
student.create
→ ALLOW

fee.collect
→ ALLOW

transport.route.create
→ DENY
Why?
student.create
  entitlement = YES
  permission = YES

fee.collect
  entitlement = YES
  permission = YES

transport.route.create
  entitlement = NO
  permission = YES
The user's role cannot create an entitlement.

4.14 Reverse Case
School A has purchased Transportation:
Transportation = ENABLED
But the Sub Admin has:
transport.view
and not:
transport.route.create
Then:
transport.route.view
→ ALLOW

transport.route.create
→ DENY
The school has the capability, but the user doesn't have the authority.

4.15 Authorization Decision
The authorization engine can conceptually expose one consistent operation:
authorize(
    user,
    tenant,
    action,
    resource
)
Internally:
Authentication
      ↓
Membership
      ↓
Tenant authorization
      ↓
Entitlement
      ↓
Feature
      ↓
Permission
      ↓
Scope
      ↓
Decision
The domain modules shouldn't individually reinvent these checks.

4.16 Don't Hardcode Role Names
Avoid application logic such as:
if user.role == "SUPER_ADMIN"
throughout the codebase.
Instead:
if authorization.hasPermission(
    "school.suspend"
)
This is much more extensible.
Role names are configuration.
Permissions are the stable authorization contract.

4.17 Permission Naming Convention
We should establish a consistent convention now.
A reasonable pattern:
resource.action
Examples:
student.view
student.create
student.update
student.delete

teacher.view
teacher.create
teacher.update
teacher.delete

class.view
class.create
class.update
class.delete

fee.view
fee.collect
fee.refund
fee.export

exam.view
exam.create
exam.publish
exam.result.enter
exam.result.approve
Platform:
school.view
school.create
school.approve
school.suspend
school.archive

subscription.view
subscription.create
subscription.update
subscription.cancel

feature.view
feature.enable
feature.disable

plan.view
plan.create
plan.update

pricing.override
This gives us a stable permission vocabulary.

4.18 Permission Groups
For administration UI, permissions can be grouped for usability:
Student Management
 ├── View
 ├── Create
 ├── Update
 ├── Delete
 ├── Import
 └── Export
But internally they remain individual permissions.
This gives us:
UI grouping
≠
Authorization dependency

4.19 Dangerous Permissions
Some actions should be considered sensitive:
school.archive
school.suspend
subscription.cancel
pricing.override
payment.refund
user.delete
role.permission.update
feature.disable
These should have stronger audit requirements.
Some may eventually require:
reason
confirmation
second approval
depending on the business rules.
We don't need to implement all of those now, but the authorization architecture should support them.

4.20 Permission Changes Must Be Audited
For example:
Actor:
School Admin

Action:
ROLE_PERMISSION_CHANGED

Role:
Finance Admin

Permission:
fee.refund

Before:
DENIED

After:
ALLOWED

Reason:
Finance manager requires refund capability
Likewise:
USER_ROLE_ASSIGNED
USER_ROLE_REMOVED
DIRECT_PERMISSION_GRANTED
DIRECT_PERMISSION_REVOKED
This is particularly important for financial and administrative capabilities.

4.21 Recommended Permission Model
The resulting conceptual model is:
                         USER
                           │
                    Membership
                           │
                         TENANT
                           │
                    Role Assignment
                           │
                          ROLE
                           │
                    ┌──────┴──────┐
                    ↓             ↓
              Permissions     Scope
                    │
                    ↓
                ACTION
Separately:
TENANT
  │
  ↓
SUBSCRIPTION
  │
  ↓
ENTITLEMENT
  │
  ↓
FEATURE
  │
  ↓
SUB-FEATURE
Then authorization combines them:
              USER REQUEST
                   │
        ┌──────────┴──────────┐
        ↓                     ↓
   USER AUTHORITY       PRODUCT ACCESS
        │                     │
   Role/Permission       Entitlement
        │                     │
        └──────────┬──────────┘
                   ↓
              AUTHORIZATION
                   ↓
              ALLOW / DENY
This separation is one of the most important foundations of the platform.

The Core Rules We Should Lock In
Roles are configuration, not hardcoded business logic.
Permissions are action-level.
Features determine product capability.
Entitlements determine whether a tenant owns that capability.
Permissions determine whether a user can use that capability.
Tenant scope determines where the user can operate.
Direct permission overrides are optional and exceptional.
System roles and custom roles are different.
Sensitive authorization changes are audited.
Domain modules use the central authorization mechanism rather than implementing their own RBAC.
The next architectural piece should be the Entitlement Engine + Feature Dependency Engine, because that is what connects the subscription system to this RBAC layer and determines exactly when a feature/sub-feature is actually available to a school.
