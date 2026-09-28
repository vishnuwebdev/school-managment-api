<!-- Source: Apple Notes, folder 'Notes' -->
# Part 10 — API, Service Boundaries & Request Flow

Now that the domain model is established, we need to define how the pieces communicate.
The objective is to avoid two common problems:
Problem A:
Everything depends on everything else.

Problem B:
Every module independently implements authentication,
tenant checks, permissions, subscriptions, billing, etc.
Instead, we want a stable platform-core contract that future modules consume.

10.1 Recommended Starting Architecture
For V1, I recommend a:
Modular monolith with strong domain boundaries.
Not a distributed microservice architecture yet.
Conceptually:
                    APPLICATION
                         │
             ┌───────────┴───────────┐
             │                       │
        PLATFORM CORE           DOMAIN MODULES
             │                       │
      ┌──────┼──────┐          ┌─────┼─────┐
      ↓      ↓      ↓          ↓     ↓     ↓
 Identity Tenant Commercial  Student Teacher Fees
      │      │      │
      └──────┴──────┘
             │
          Database
The modules are logically separated even if they initially run in the same application/database.

10.2 Why Not Microservices Yet?
Microservices introduce additional complexity:
Network calls
Service discovery
Distributed transactions
Message delivery
Deployment coordination
Observability
Retries
Version compatibility
Data synchronization
We don't yet have enough domain complexity to justify that operational overhead.
The architecture should therefore be:
Modular internally
Monolithic operationally
with boundaries strong enough that individual modules could be extracted later if there is a real reason.

10.3 The Request Pipeline
Every authenticated school API request should conceptually follow:
HTTP Request
      ↓
Authentication
      ↓
Identity Resolution
      ↓
Tenant Context
      ↓
School Lifecycle Check
      ↓
Authorization
      ↓
Entitlement
      ↓
Domain Service
      ↓
Business Rules
      ↓
Tenant-aware Persistence
      ↓
Audit / Events
      ↓
Response
This becomes the standard application pipeline.

10.4 Example: Create Student
Eventually, when the Student module exists:
POST /students
The system performs:
Authenticate user
       ↓
Resolve School A
       ↓
Is School A accessible?
       ↓
Does School A have Student Management?
       ↓
Does user have student.create?
       ↓
Student Service
       ↓
Validate student data
       ↓
Create Student for School A
       ↓
Audit
       ↓
StudentCreated event
       ↓
Response
The Student service does not need to inspect the subscription plan itself.

10.5 Authentication Layer
Authentication answers:
Who are you?
Examples:
Session
JWT
OAuth/OIDC
SSO
The exact mechanism can be selected later.
Authentication should produce a trusted identity:
AuthenticatedPrincipal
 ├── user_id
 └── authentication metadata
It should not itself decide whether the user can access a school.

10.6 Tenant Resolution
After authentication:
AuthenticatedPrincipal
        ↓
Membership Resolver
        ↓
TenantContext
Example:
TenantContext
 ├── tenant_id = School A
 ├── membership_id
 └── access scope
For a normal school user, this may be straightforward.
For a platform user, the requested/selected tenant must be validated.

10.7 No Arbitrary Tenant IDs
Avoid allowing a client to simply specify:
{
  "tenantId": "school-b"
}
and assuming that is sufficient.
The server should determine:
Does this authenticated principal
have authorized access to School B?
Only then should:
TenantContext = School B
be established.

10.8 Authorization Service
After tenant resolution:
AuthorizationService
can evaluate:
Can user perform:
student.create
It should not need to know every domain business rule.
It consumes:
Identity
Membership
Role
Permission
Scope
and returns a decision.

10.9 Entitlement Service
Authorization should be able to ask the entitlement layer:
Is tenant entitled to:
student.management?
or:
Is capability available:
fee.collection?
The Entitlement Service handles:
Plan
Add-ons
Overrides
Subscription state
Validity
Dependencies
The domain module doesn't need to know those details.

10.10 Two Different Authorization Checks
There should be a distinction between:
Capability check
tenantCan("fee.collection")
and:
User action check
userCan("fee.collect")
The final decision may require both.

10.11 Domain Service
Once the platform checks pass:
StudentService
FeeService
ExamService
can execute domain-specific business logic.
For example:
FeeService.collectPayment(...)
should focus on:
Fee business rules
Payment allocation
Receipt generation
Validation
Domain events
not:
How subscription pricing works
How roles are stored
How tenant membership is resolved

10.12 Repository / Data Access Boundary
The persistence layer should enforce tenant ownership.
Conceptually:
Domain Service
      ↓
Repository
      ↓
Tenant-aware query
      ↓
Database
For example:
studentRepository.findById(
    tenantContext,
    studentId
)
The repository ensures:
tenant_id = currentTenant

10.13 Avoid Direct Cross-Domain Database Access
Suppose the Fee module needs student information.
Avoid:
FeeService
   ↓
SELECT * FROM students
Instead:
FeeService
   ↓
Student domain contract
or a well-defined reference/read model where appropriate.
The exact mechanism can vary, but ownership must remain clear.

10.14 Domain Contracts
Each module should expose a limited application contract.
For example, Student could expose:
StudentService
 ├── create
 ├── update
 ├── get
 ├── search
 └── validateReference
Fees shouldn't depend on the Student module's internal database structure.
This makes future extraction possible.

10.15 Synchronous vs Asynchronous Communication
Use synchronous calls when the caller needs an immediate result.
Example:
FeeService
   ↓
Student reference validation
   ↓
Immediate result
Use events for things that don't need to block the request.
Example:
StudentCreated
    ↓
Notification
    ↓
Audit enrichment
    ↓
Search indexing
This distinction keeps request flows simple.

10.16 Domain Events
Events represent something that already happened.
Examples:
SchoolCreated
SubscriptionActivated
PaymentReceived
EntitlementChanged
UserCreated
RoleAssigned
FeatureEnabled
FeatureDisabled
Future:
StudentCreated
TeacherCreated
FeeCollected
ExamPublished
Events should not be used merely as another way to call methods.
They communicate state changes.

10.17 Event Example
Suppose a payment succeeds.
The billing domain performs:
PaymentReceived
Then consumers can react:
PaymentReceived
      ├── Subscription service
      ├── Entitlement resolver
      ├── Notification service
      └── Audit
This avoids the Billing module directly calling every downstream system.

10.18 Event Reliability
We should not assume:
database transaction succeeds
AND
event delivery always succeeds
Those are separate concerns.
The architecture should leave room for a reliable event-delivery mechanism, such as an outbox pattern.
Conceptually:
Database Transaction
 ├── Business Data
 └── Outbox Event
          ↓
      Event Worker
          ↓
      Subscribers
This is a strong pattern for future reliability.
We don't necessarily need a sophisticated message broker in V1.

10.19 Transaction Boundaries
A domain operation should have a clear transaction boundary.
For example:
Create Student
 ├── validate
 ├── create student
 └── write audit/event record
should ideally be one atomic business transaction where appropriate.
But don't create giant transactions spanning:
Student
+ Billing
+ Notifications
+ Search
+ External API
Instead:
Core transaction
      ↓
Event
      ↓
Asynchronous side effects

10.20 Background Jobs
Background jobs should handle operations that don't need to block a user request.
Examples:
Send email
Generate large report
Process import
Generate invoice
Retry payment
Recalculate entitlements
Index search data
Process notification
Each tenant-specific job carries tenant context:
Job
 ├── tenant_id
 ├── type
 └── payload
Platform jobs may have:
tenant_id = null
scope = PLATFORM

10.21 Scheduled Jobs
Examples:
Check subscriptions nearing expiry
Process subscription renewals
Generate recurring invoices
Send payment reminders
Expire trials
Expire entitlements
These jobs should use the same domain services as normal requests.
Avoid creating a second implementation of business rules specifically for cron jobs.

10.22 API Versioning
Because this platform is intended to evolve for years, API versioning should be considered from the beginning.
For example:
 /api/v1/...
Later:
/api/v2/...
But don't create versions merely for every small change.
Version when the public contract requires a breaking change.

10.23 API Layer Should Not Contain Business Logic
Avoid:
Controller
 ├── check subscription
 ├── calculate entitlement
 ├── validate role
 ├── create student
 ├── calculate fee
 └── send email
Instead:
Controller
   ↓
Application Service
   ↓
Domain Service
   ↓
Repositories / Platform Services
The controller should primarily handle:
HTTP
Input
Output
Authentication context
Error mapping

10.24 Application Service
Application services coordinate a use case.
Example:
CreateStudentUseCase
could coordinate:
TenantContext
Authorization
Student Domain
Audit
Event
while the Student domain owns student-specific rules.

10.25 Error Model
We should establish standard categories.
For example:
AUTHENTICATION_REQUIRED
TENANT_ACCESS_DENIED
PERMISSION_DENIED
ENTITLEMENT_REQUIRED
FEATURE_DISABLED
RESOURCE_NOT_FOUND
VALIDATION_ERROR
BUSINESS_RULE_VIOLATION
CONFLICT
SUBSCRIPTION_EXPIRED
SCHOOL_SUSPENDED
SYSTEM_ERROR
This is better than every module inventing unrelated error semantics.

10.26 Important Security Detail: 403 vs 404
For some tenant-sensitive resources, we need to decide whether to reveal that a record exists.
Example:
School A tries to access School B's student ID
The system should generally avoid revealing:
"Student exists, but you don't have access."
A tenant-isolated data access layer can treat it as not found from the user's perspective where appropriate.
The exact policy can be established during security implementation.

10.27 Cache Architecture
Cache should exist below the domain services but above expensive persistence operations.
Examples:
Tenant entitlement cache
Permission cache
Feature catalog cache
Plan cache
School configuration cache
Tenant-sensitive cache keys must include tenant identity.
Example:
tenant:{tenantId}:entitlements
tenant:{tenantId}:permissions
tenant:{tenantId}:settings
Platform-global catalog caches don't need tenant IDs.

10.28 Configuration
Separate:
Platform Configuration
from:
Tenant Configuration
and from:
Feature Configuration
This prevents one giant configuration object from becoming an unmaintainable dumping ground.

10.29 File Storage
The file service should provide a domain-neutral interface.
For example:
FileStorage
 ├── upload
 ├── download
 ├── delete/archive
 └── generateAccessUrl
The domain provides ownership information:
tenant
entity type
entity id
The storage layer enforces the tenant boundary.

10.30 Notification Service
Domains should request notifications through a common service.
Example:
NotificationService
 ├── email
 ├── SMS
 ├── push
 └── in-app
The subscription module can emit:
SubscriptionExpiring
The notification system determines how it is delivered.
This keeps communication channels separate from business logic.

10.31 Search Service
Search should also have a domain-neutral interface.
Future modules can publish searchable records:
Student
Teacher
Fee
Exam
Book
Each indexed record carries:
tenant_id
entity_type
entity_id
This keeps search isolated from the source-of-truth domain database.

10.32 Reporting
Reporting deserves special treatment.
Operational domain queries:
"Show this student's fees"
can use normal domain services.
Large reports:
"Generate annual fee collection report for 20,000 students"
may need:
Background job
    ↓
Report generation
    ↓
File storage
    ↓
Notification
The report job must preserve tenant context.

10.33 Platform Reporting
Platform reporting is different.
For example:
Total schools
Active subscriptions
Revenue
Feature adoption
This is a platform-level operation.
It should require explicit platform permissions and should not accidentally run under a school tenant context.

10.34 Future Domain Module Integration
When we eventually add Students:
Student Module
      │
      ├── Tenant Context
      ├── Authorization
      ├── Entitlement
      ├── Audit
      ├── Events
      └── Persistence
Teachers:
Teacher Module
      │
      ├── Tenant Context
      ├── Authorization
      ├── Entitlement
      ├── Audit
      └── Events
Fees:
Fee Module
      │
      ├── Tenant Context
      ├── Authorization
      ├── Entitlement
      ├── Billing references where needed
      ├── Audit
      └── Events
The architecture stays consistent.

10.35 The Module Dependency Rule
A domain module can depend on:
Identity
Tenant
Authorization
Entitlement
Audit
Platform Services
and carefully defined contracts from other domain modules.
But it should not depend on another module's internal tables or implementation details.
Conceptually:
GOOD

Fee
 ↓
StudentService contract
Not:
BAD

Fee
 ↓
Student database table
 ↓
Student internal implementation

10.36 The Resulting Architecture
We now have a strong modular-monolith foundation:
                         API
                          │
                    Application Layer
                          │
             ┌────────────┴────────────┐
             │                         │
        PLATFORM CORE             DOMAIN MODULES
             │                         │
     ┌───────┼────────┐          ┌─────┼─────┐
     │       │        │          │     │     │
 Identity Tenant Commercial   Student Teacher Fees
     │       │        │
     └───────┼────────┘
             │
       Authorization
       Entitlement
             │
        Data Access
             │
          Database

       Cross-cutting:
    Audit / Events / Cache /
 Notifications / Files / Search /
       Background Jobs

10.37 One Request, End to End
Let's put everything together with a future operation:
School Admin creates a student.
HTTP Request
     ↓
Authentication
     ↓
User identified
     ↓
Membership resolved
     ↓
Tenant = School A
     ↓
School lifecycle = ACTIVE
     ↓
Entitlement:
Student Management = YES
     ↓
Permission:
student.create = YES
     ↓
Student Application Service
     ↓
Student Domain Validation
     ↓
Tenant-aware Repository
     ↓
Database
     ↓
Audit: STUDENT_CREATED
     ↓
Event: StudentCreated
     ↓
Notification/Search/etc. asynchronously
     ↓
HTTP Response
No individual layer is responsible for everything.
That separation is the foundation we want.

10.38 One Commercial Event, End to End
Now:
School renews its subscription.
Payment
   ↓
Payment Verified
   ↓
Invoice Updated
   ↓
Subscription Renewed
   ↓
Entitlement Recalculated
   ↓
Student / Fee / Exam capabilities restored
   ↓
Audit
   ↓
SubscriptionRenewed Event
   ↓
Notification
Again, no domain module needs to understand the complete billing workflow.

10.39 One Feature Disable, End to End
Suppose an administrator disables Student Management:
Admin Request
    ↓
Authorization
    ↓
Feature Dependency Analysis
    ↓
Impacted Features Found
    ↓
Confirmation
    ↓
Feature Disabled
    ↓
Dependent Features Recalculated
    ↓
Entitlements Updated
    ↓
Audit
    ↓
FeatureDisabled Event
Data remains untouched.

10.40 Architecture Principle to Lock In
At this point, I would formally adopt:
Domain modules own business rules. Platform core owns cross-cutting platform capabilities.
And:
Commercial state determines what the tenant can use; authorization determines what the user can do; domain services determine whether the requested business operation itself is valid.
That gives us three separate layers:
CAN THE TENANT USE IT?
        ↓
Entitlement

CAN THIS USER DO IT?
        ↓
Authorization

IS THE OPERATION VALID?
        ↓
Domain Business Rules
This is the separation that will keep the system maintainable as requirements grow.

Current Architecture
We now have the complete conceptual foundation:
                    PLATFORM
                       │
          ┌────────────┴────────────┐
          │                         │
       CONTROL PLANE           DOMAIN MODULES
          │                         │
 ┌────────┼────────┐         ┌──────┼───────┐
 │        │        │         │      │       │
Identity Product Commercial Student Teacher Fees
 │        │        │
Tenant   Feature  Subscription
RBAC     Catalog  Billing
 │        │        │
 └────────┴────────┘
          │
     Entitlement
          │
     Authorization
          │
       Tenant
          │
      Data Access
The next step should be Part 11 — Security Architecture & Failure Scenarios.
That should cover the areas we have not yet formally locked down: authentication/session security, tenant-isolation failure prevention, authorization bypass prevention, sensitive operations, audit integrity, secrets, API security, rate limiting, backups/recovery, data retention, and what happens when individual platform components fail.
