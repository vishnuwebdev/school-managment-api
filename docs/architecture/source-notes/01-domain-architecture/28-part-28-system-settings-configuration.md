<!-- Source: Apple Notes, folder 'Notes' -->
# Part 28 — System Settings & Configuration

Configuration is a cross-cutting concern, but it needs a clear ownership model.
The central rule is:
Configuration controls how the system behaves; business data records what actually happened.
For example:
Fee Policy
    ↓
defines how fees should be calculated

Fee Demand
    ↓
records what was actually charged
Changing the policy must not rewrite historical fee demands.

28.1 Configuration Layers
We should establish four levels:
Platform Configuration
        ↓
Tenant / School Configuration
        ↓
Domain Configuration
        ↓
User Preferences
They have different ownership and access rules.

28.2 Platform Configuration
Platform-level configuration affects the SaaS itself.
Examples:
Platform
├── Supported Languages
├── Supported Currencies
├── System Defaults
├── Security Policies
├── File Limits
├── Notification Defaults
├── Feature Catalog Settings
└── Operational Limits
Platform configuration is controlled by authorized platform administrators.

28.3 School Configuration
School-level configuration controls the school's environment.
Examples:
School
├── School Name / Branding
├── Timezone
├── Locale
├── Currency
├── Academic Defaults
├── Communication Defaults
├── Numbering Preferences
├── Working Days
└── General Preferences
Some of these overlap with domain configuration, so ownership must remain explicit.

28.4 Domain Configuration
Each domain owns its business-specific configuration.
Examples:
Attendance
→ Attendance statuses

Fees
→ Fee policies

Library
→ Loan rules

Leave
→ Leave policies

Examination
→ Grading configuration

Timetable
→ Period configuration
The Settings domain should not become the owner of these rules.

28.5 User Preferences
User-specific preferences include:
Language
Timezone preference
Notification preferences
Display preferences
Dashboard preferences
These belong to the user/preferences layer rather than school business configuration.

28.6 Configuration vs Business Data
This distinction is critical.
Example:
Configuration:
Default library loan duration = 14 days
versus:
Business Data:
Student X borrowed Book Y
Due date = 2026-09-14
If the configuration changes to:
21 days
the existing loan should not automatically become 21 days.

28.7 Effective Dating
Where historical behavior matters:
Configuration
├── Effective From
└── Effective To
Example:
Fee Policy
Jan–Jun → Policy A
Jul–Dec → Policy B
Historical transactions use the applicable policy.

28.8 Configuration Versioning
For more complex rules:
Configuration
 ├── Version 1
 ├── Version 2
 └── Version 3
A domain can associate a transaction with the applicable configuration version.

28.9 Configuration Changes
A configuration change should follow:
Draft
 ↓
Validate
 ↓
Approve / Publish if required
 ↓
Active
Not every configuration needs an approval workflow.
Sensitive configurations may.

28.10 Configuration Audit
Configuration changes are important because they can alter future system behavior.
Audit:
Who changed it
What changed
Before
After
Reason
Effective date
Timestamp
Tenant
Examples:
Changed fee late-payment rule

Changed attendance status

Changed grading scale

Changed library loan duration

28.11 Configuration Ownership
A useful rule:
The domain that owns the business rule owns the configuration for that rule.
Examples:
Attendance
→ attendance statuses

Examination
→ grading rules

Fees
→ fee calculation rules

Library
→ circulation rules

Leave
→ leave policies

Timetable
→ time-slot configuration
System Settings provides the framework for configuration management, but does not absorb these domains.

28.12 School Profile vs School Settings
These should remain separate.
School Profile
Describes the school:
School Name
Address
Contact Information
Logo
Registration Details
School Settings
Controls behavior:
Timezone
Locale
Default Academic Year
Working Days
General Preferences
This prevents configuration and identity/profile information from becoming one large record.

28.13 School Branding
Branding may include:
Logo
Primary branding assets
Report header
Contact details
Files should use the common File Service.
Branding assets remain tenant-scoped.

28.14 Locale
A school may configure:
Language
Date Format
Number Format
Timezone
Currency
The system should distinguish:
Stored timestamp
from:
Displayed local time
Timestamps should remain unambiguous internally.

28.15 Timezone
Timezone is particularly important for:
scheduled notifications,
reports,
subscriptions,
background jobs,
academic calendars,
attendance,
timetable.
A school should have an explicit timezone.
User preferences may override display timezone where appropriate.

28.16 Currency
The school's currency should be explicit.
Fees and reporting should not infer currency from location.
Platform billing may have its own currency configuration.
This reinforces the separation:
Platform Billing Currency
≠
School Fee Currency
unless intentionally configured to be the same.

28.17 Numbering Configuration
Schools may want business identifiers such as:
Student:
STU-2026-00001

Teacher:
TCH-00001

Receipt:
REC-2026-00001
Numbering configuration should be separate from the underlying internal IDs.

28.18 Internal IDs vs Business Numbers
Never use:
STU-2026-00001
as the fundamental database identity.
Instead:
Internal ID → stable, opaque

Student Number → configurable business identifier
This principle applies across domains.

28.19 Feature Configuration
Feature enablement is not ordinary settings.
The entitlement engine owns:
Plan
Add-on
Override
Subscription
Effective Entitlement
System Settings may display configuration, but must not directly bypass entitlement.

28.20 Security Settings
Platform-level security configuration may include:
Password policy
Session lifetime
Login attempt limits
MFA policy
Invitation expiry
Security event retention
Some may be global.
Others may eventually be configurable by school.

28.21 Security Configuration Hierarchy
Potential model:
Platform Default
      ↓
School Override
      ↓
Effective Security Policy
But sensitive security policies should have safe minimums.
A school should not be able to configure itself into an insecure state if the platform requires stronger controls.

28.22 Notification Defaults
Communication configuration may include:
Default channel
Default language
Notification timing
School contact information
But actual notification policies remain owned by Communication.

28.23 Academic Configuration
Academic Management may own:
Academic year rules
Class/grade configuration
Section configuration
Subject configuration
Promotion-related settings
The Settings domain should not duplicate these.

28.24 Attendance Configuration
Attendance owns:
Attendance modes
Attendance statuses
Correction policy
Approval workflow
System Settings should provide generic configuration infrastructure, not redefine these.

28.25 Examination Configuration
Examination owns:
Assessment types
Grading scales
Pass criteria
Marking rules
Publication configuration
These are domain-specific.

28.26 Fee Configuration
Fees owns:
Fee policies
Late fee rules
Payment methods
Discount/concession rules
Receipt numbering
Again, historical financial data must remain stable.

28.27 Library Configuration
Library owns:
Loan limits
Loan duration
Renewal limits
Fine rules
Reservation rules

28.28 Leave Configuration
Leave owns:
Leave types
Leave allocation
Carry-forward rules
Approval rules
Working-day calculations

28.29 Timetable Configuration
Timetable owns:
Working days
Time slots
Period definitions
Breaks
Scheduling constraints
School-level working-day configuration may influence it, but Timetable owns the scheduling-specific interpretation.

28.30 Configuration Precedence
When multiple levels exist, precedence must be explicit.
For example:
Platform Default
       ↓
School Setting
       ↓
Domain Setting
       ↓
User Preference
But not every setting should support all four levels.
Each setting should declare its supported scope.

28.31 Avoid Generic "Settings JSON"
A tempting design is:
school.settings = {
   ...
}
This becomes difficult to validate, query, migrate, and audit.
Instead, configuration should have typed ownership and contracts.
A small amount of flexible metadata may still be appropriate.

28.32 Configuration Registry
The platform can conceptually maintain:
Configuration Key
├── Name
├── Scope
├── Type
├── Default
├── Validation
├── Sensitive?
└── Owner Domain
Example:
library.default_loan_days
Type: integer
Owner: Library
Scope: Tenant
Default: 14
This is a framework concept, not necessarily one giant database table.

28.33 Typed Configuration
Values should have known types:
Boolean
Integer
Decimal
String
Enum
Date
Duration
JSON/Object
Use structured configuration where possible.

28.34 Validation
Configuration must be validated before activation.
Example:
Maximum loans = -5
should fail.
Likewise:
Start time >= End time
should fail for a timetable period.
Domain-specific validation belongs to the owning domain.

28.35 Sensitive Configuration
Some settings contain secrets or sensitive values.
Examples:
External API credentials
Provider secrets
Encryption-related configuration
These should not be treated like ordinary configuration values.
Use secure secret storage.
Never expose secrets through:
Admin UI
Logs
Audit before/after
API responses

28.36 Configuration Audit and Secrets
For sensitive settings, audit should say:
Payment provider credential changed
rather than:
before = "secret123"
after = "secret456"

28.37 Configuration API
Conceptually:
GET    /api/v1/settings
PUT    /api/v1/settings/{key}
But domain-specific configuration APIs may be preferable:
Attendance Configuration
Fee Configuration
Library Configuration
The generic Settings framework should not force every domain through a generic API.

28.38 Configuration Cache
Configuration can be cached for frequently accessed values.
Cache invalidation must happen when configuration changes.
Cache keys must include:
Tenant
Configuration Key
Version
where appropriate.

28.39 Configuration in Background Jobs
Jobs must use the configuration applicable to the operation.
Example:
Fee reminder job
 ↓
Determine applicable policy
 ↓
Calculate using effective configuration
Do not assume today's configuration always applies to historical work.

28.40 Configuration in Events
Domain events should not depend on mutable configuration being available later to interpret historical facts.
For example:
FeeDemandIssued
should carry the business result necessary to understand the issued demand, rather than requiring future systems to recalculate it using the current fee policy.

28.41 Configuration and Subscriptions
Commercial entitlements determine:
What capability exists.
Configuration determines:
How that capability behaves.
Example:
Entitlement:
Library = enabled

Configuration:
Maximum loans = 5
They are separate.

28.42 Configuration and Permissions
Likewise:
Permission:
library.fine.manage
means:
Who can manage fines?
while:
Fine policy:
₹5/day
means:
How are fines calculated?
These should never be merged.

28.43 Configuration Lifecycle
A useful generic lifecycle:
Draft
 ↓
Validated
 ↓
Active
 ↓
Superseded
 ↓
Archived
Simple settings may use only:
Active
Do not introduce unnecessary lifecycle complexity where it provides no value.

28.44 Configuration Import/Export
Future capability:
Export School Configuration
 ↓
Import into another School
This can help school onboarding.
But secrets, tenant-specific identifiers, and protected platform configuration must not be blindly copied.

28.45 Configuration Templates
Platform could offer defaults:
School Template
├── Default attendance statuses
├── Default fee categories
├── Default library rules
└── Default communication settings
These are starting configurations.
After provisioning, the school owns its configuration.
Changing the platform template later should not silently rewrite existing schools.

28.46 Provisioning Relationship
Recall school provisioning:
School Approved
 ↓
Provisioning
 ↓
Create Tenant
 ↓
Create Default Configuration
 ↓
Create Default Roles
 ↓
Create Initial Admin
 ↓
Apply Entitlements
 ↓
Active
Configuration therefore becomes one of the provisioning steps.

28.47 School Deactivation
When a school is suspended or archived:
Configuration
should remain preserved.
Archiving a school must not require deleting settings.

28.48 Reporting
Configuration may be relevant to reports.
Example:
Attendance report
must know which attendance statuses were considered present/absent under the applicable configuration.
Reports should not blindly use today's configuration for historical periods.

28.49 Permissions
Initial platform settings permissions:
settings.view
settings.update
settings.export
settings.import
Domain-specific configuration permissions remain domain-owned:
attendance_config.manage
fee_config.manage
library_config.manage
leave_policy.manage

28.50 Audit
Important events:
ConfigurationCreated
ConfigurationUpdated
ConfigurationActivated
ConfigurationSuperseded
ConfigurationArchived
Sensitive configuration changes receive stronger audit treatment.

28.51 Final Configuration Architecture
                  PLATFORM
                     │
             Platform Defaults
                     │
                     ↓
                  SCHOOL
                     │
             School Settings
                     │
       ┌─────────────┼─────────────┐
       ↓             ↓             ↓
   Attendance       Fees        Examination
   Configuration   Config        Config
       │             │             │
       └─────────────┼─────────────┘
                     ↓
              Effective Behavior
                     │
                     ↓
              Business Transactions
And separately:
Entitlement
→ What is available

Permission
→ Who can use it

Configuration
→ How it behaves

Business Data
→ What actually happened
This four-way separation is extremely important for the long-term architecture.

28.52 What We Should Not Finalize Yet
Defer:
❌ Exact configuration storage schema
❌ Generic configuration DSL
❌ Universal settings table design
❌ Full secret-management implementation
❌ Configuration UI
❌ Advanced configuration inheritance
❌ Configuration migration framework
We have the architectural contract; detailed implementation comes later.

Updated Domain Map
Platform
├── Identity / User & Role Administration
├── Tenant Management
├── Plans / Pricing / Billing
├── Feature Catalog / Entitlements
├── System Settings / Configuration
├── Audit
├── Communication
└── Platform Services

School Domains
├── Student
├── Academic
├── Teacher
├── Attendance
├── Examination
├── Fees
├── Transportation
├── Timetable
├── Library
├── Leave / Staff Operations
├── Parent / Guardian Portal
└── Reports & Analytics
We are now very close to completing the architectural domain map.
Next: Part 29 — Integrations & External Systems, covering payment gateways, SMS/email providers, identity providers, document/file services, future GPS, accounting, and other external systems without allowing third-party integrations to leak into the core domain model.
