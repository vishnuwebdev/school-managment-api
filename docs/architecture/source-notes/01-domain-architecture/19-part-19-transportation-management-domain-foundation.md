<!-- Source: Apple Notes, folder 'Notes' -->
# Part 19 — Transportation Management Domain Foundation

Transportation is a good next domain because it introduces an important pattern:
An operational service can have its own domain model while other domains, such as Fees, consume its outcomes without owning its operational data.
The architecture becomes:
Transportation
      ↓
Operational Assignment
      ↓
Student uses transportation
      ↓
Fee Management may calculate applicable charges
Transportation owns the transport operation. Fee Management owns the financial obligation.

19.1 Domain Purpose
Transportation Management can cover:
Transportation
│
├── Vehicles
├── Drivers
├── Routes
├── Stops
├── Trips
├── Transport Services
├── Student Transport Assignments
├── Pickup / Drop Configuration
└── Transport Operations
Potential future capabilities:
├── GPS Tracking
├── Live Vehicle Location
├── RFID / Smart Card
├── Driver Attendance
├── Transport Notifications
├── Route Optimization
└── Vehicle Maintenance
These should remain future capabilities unless required.

19.2 Transportation Does Not Own Students
The relationship is:
Student Management
       ↓
Student

Transportation
       ↓
references Student
A transportation assignment says:
This student uses this transport service.
It does not create another student record.

19.3 Transportation Does Not Own Fees
Similarly:
Transportation
    ↓
Applicable Transport Charge
    ↓
Fee Management
Transportation may determine:
Route = Route A
Transport Plan = Monthly
Charge = ₹2,000
But Fee Management creates the actual financial obligation.

19.4 Core Transportation Entities
Conceptually:
Transportation
│
├── Vehicle
├── Driver
├── Route
├── Stop
├── Trip
├── Transport Service
└── Student Transport Assignment
Each has its own lifecycle.

19.5 Vehicle
A vehicle may have:
Vehicle
├── Vehicle Number
├── Registration
├── Type
├── Capacity
├── Status
└── Operational Information
Example:
BUS-01
Capacity: 40
Status: Active
Avoid putting student assignments directly on the vehicle.
The vehicle participates in trips/routes.

19.6 Vehicle Lifecycle
Possible lifecycle:
Available
 ↓
Assigned
 ↓
In Service
 ↓
Maintenance
 ↓
Unavailable
 ↓
Retired
The exact lifecycle can be refined later.
Historical trips must remain valid even after a vehicle is retired.

19.7 Driver
Transportation owns the operational driver relationship.
Conceptually:
Driver
├── Identity Reference
├── License Information
├── Contact
├── Status
└── Documents
There is an important decision here:
A driver may or may not be a school employee.
Therefore don't assume:
Driver = Teacher
or even:
Driver = School User
A driver can be an operational person with no system login.

19.8 Driver vs User
Same principle as Teacher:
Driver
   ↓ optional
User Account
Only create a platform user if the driver needs system access.
For example:
Driver
   ↓
Mobile App Account
can be introduced later.

19.9 Driver Documents
Potential documents:
Driving License
Identity Document
Vehicle Authorization
Other Required Document
Use the platform file service.
Transportation should store document metadata, not implement its own storage mechanism.

19.10 Route
A route represents an operational path.
Example:
Route A
 ↓
Stop 1
 ↓
Stop 2
 ↓
Stop 3
 ↓
School
A route should not simply be a string:
route = "Jaipur North Route"
because stops and ordering matter operationally.

19.11 Stop
A stop can contain:
Stop
├── Name
├── Location
├── Sequence
├── Pickup Time
└── Drop Time
Exact geographic representation can later support coordinates.

19.12 Route vs Trip
A route describes:
Where the vehicle normally travels.
A trip describes:
A specific operational journey.
For example:
Route A
   ↓
Morning Trip — 2026-09-28
   ↓
Vehicle BUS-01
   ↓
Driver X
This distinction becomes important for tracking and historical reporting.

19.13 Transport Service
A school may offer:
Morning Pickup
Afternoon Drop
Both
One-way
Special Route
A transport service defines what is being offered.
The route and trip provide operational implementation.

19.14 Student Transport Assignment
This is the central relationship:
Student
   ↓
Transport Assignment
   ↓
Transport Service
   ↓
Route
   ↓
Stop
Example:
Student A
 ↓
Morning + Afternoon
 ↓
Route A
 ↓
Stop 3

19.15 Assignment Must Be Historical
A student may change:
Route A
 ↓
Route B
The system should preserve:
Assignment 1
Effective: Jan–Jun

Assignment 2
Effective: Jul onward
Do not overwrite the old assignment.

19.16 Assignment Lifecycle
Possible:
Requested
 ↓
Approved
 ↓
Active
 ↓
Suspended
 ↓
Ended
A simpler model can be used initially.

19.17 Transport Eligibility
The system may eventually support eligibility rules:
Grade
Area
Distance
Transport Availability
Special Requirements
But these should be configurable rather than hardcoded.

19.18 Route Capacity
A route/vehicle can have capacity constraints.
For example:
Vehicle Capacity = 40
Assigned Students = 38
Remaining = 2
Assignment should validate capacity.
But capacity should not necessarily be treated as a static number if seating arrangements or special requirements later affect capacity.

19.19 Capacity Validation
When assigning a student:
Request Assignment
       ↓
Check Route/Trip Capacity
       ↓
Available?
   ├── Yes → Continue
   └── No  → Reject / Alternate Route
This should be a domain rule, not merely a UI warning.

19.20 Transportation and Fees
Transportation can expose a charge configuration:
Transport Service
   ↓
Pricing/Charge Information
Fee Management consumes it:
Student Transport Assignment
        ↓
Applicable Transport Charge
        ↓
Fee Management
        ↓
Student Fee Demand
Transportation should not create the student's invoice itself.

19.21 Transport Pricing
Possible models:
Flat monthly fee
Distance-based
Route-based
Zone-based
One-way vs two-way
Custom student rate
We should not implement all of these initially.
The architecture should allow a transport service to expose an applicable charge without forcing Fee Management to understand route calculations.

19.22 Custom Transport Charges
A particular student might have:
Standard = ₹2,000
Approved concession = ₹500
Final = ₹1,500
The commercial adjustment remains in Fee Management.
Transportation provides the base applicability.

19.23 Pickup and Drop Configuration
A student may have:
Morning Pickup → Stop A
Afternoon Drop → Stop B
Although often they are the same stop, the model should not assume they must be.
This supports students whose arrangements differ by direction.

19.24 Transport Attendance
Transportation may eventually track:
Student boarded
Student absent
Student dropped
This is transport attendance, not school attendance.
It should remain a Transportation capability rather than being mixed into the general Attendance domain.
Potential future event:
StudentBoarded
StudentAbsentForTrip
StudentDropped

19.25 Transportation and School Attendance
A student may be:
Absent from school
but still appear in a transport trip record.
These are different operational concepts.
Do not automatically equate:
School Attendance = Transport Attendance
without an explicit business rule.

19.26 Vehicle Tracking
GPS can eventually integrate:
Vehicle
 ↓
GPS Provider
 ↓
Location Events
 ↓
Transportation
But live location should not be embedded into the core Vehicle entity.
Tracking is a separate operational stream.

19.27 External GPS Integration
If a school later uses a GPS provider:
External GPS
      ↓
Integration Adapter
      ↓
Transportation Domain
The core domain should not become tightly coupled to one GPS vendor.

19.28 Route Changes
Changing a route can impact:
Students
Stops
Trips
Vehicles
Fees
Notifications
Therefore route changes should be controlled.
Potential workflow:
Edit Route
   ↓
Check Active Assignments
   ↓
Show Impact
   ↓
Confirm
   ↓
Create New Effective Version
Avoid rewriting historical route information.

19.29 Route Versioning
For historical accuracy:
Route A v1
   ↓
Route A v2
may be better than mutating the same route when major operational changes occur.
The exact implementation can be determined later.

19.30 Transportation Permissions
Initial permissions:
transport.view
transport.manage
transport.export
Vehicles:
vehicle.view
vehicle.create
vehicle.update
vehicle.archive
Drivers:
driver.view
driver.create
driver.update
driver.archive
Routes:
route.view
route.create
route.update
route.archive
Assignments:
transport_assignment.view
transport_assignment.create
transport_assignment.update
transport_assignment.end
Trips:
trip.view
trip.create
trip.update
trip.cancel

19.31 Feature Structure
Initial:
Transportation Management
│
├── Vehicles
├── Drivers
├── Routes & Stops
├── Trips
├── Transport Services
└── Student Transport Assignments
Potential future:
├── GPS Tracking
├── Transport Attendance
├── Notifications
├── Vehicle Maintenance
└── Route Optimization

19.32 Transportation Dependencies
Transportation depends on:
Student Management
and may reference:
Academic Structure
for grade/class-related rules.
Fee Management consumes transportation pricing/assignment information.
Therefore:
Student
    ↓
Transport Assignment
    ↓
Route / Stop / Service
    ↓
Applicable Charge
    ↓
Fee Management

19.33 Transportation Does Not Need Teacher Management
Unlike Attendance or Examination, Transportation does not fundamentally depend on teachers.
A driver is a transportation entity.
A school staff member may manage transportation, but that is a user/permission relationship, not a Teacher dependency.

19.34 Transport Operations
A future operational workflow might be:
Daily Trip
 ↓
Vehicle Assigned
 ↓
Driver Assigned
 ↓
Route Loaded
 ↓
Student List Loaded
 ↓
Trip Started
 ↓
Stops Completed
 ↓
Trip Completed
This gives us a clean basis for future GPS/transport attendance integrations.

19.35 Trip Lifecycle
Possible:
Scheduled
 ↓
Ready
 ↓
Started
 ↓
Completed
Alternative outcomes:
Cancelled
Delayed
Failed
Historical trips should remain preserved.

19.36 Notifications
Transportation can produce events such as:
TripStarted
TripDelayed
TripCancelled
StudentBoarded
StudentNotBoarded
Notification service can then deliver:
Push
SMS
Email
Parent App
Transportation does not directly own the notification channels.

19.37 Audit Requirements
Audit:
Vehicle creation/update/archive
Driver creation/update/archive

Route changes
Stop changes
Trip changes

Student transport assignment
Assignment changes

Transport pricing configuration

Manual operational corrections
Bulk operations
Exports
High-impact route/assignment changes should capture reasons where appropriate.

19.38 Events
Useful events:
VehicleCreated
VehicleRetired

DriverCreated
DriverDeactivated

RouteCreated
RouteChanged
RouteArchived

TransportAssignmentCreated
TransportAssignmentChanged
TransportAssignmentEnded

TripScheduled
TripStarted
TripCompleted
TripCancelled
Potential future:
StudentBoarded
StudentMissedTrip

19.39 Security Model
A transport operator should only access:
Authentication
+
Tenant Membership
+
School State
+
Transportation Entitlement
+
Permission
+
Operational Scope
A driver with limited portal access should not automatically receive access to:
Fee Management
Student Financial Information
Examination
Teacher Records
This follows our central RBAC model.

19.40 Sensitive Student Information
Transportation users may need limited student information:
Student Name
Pickup Stop
Drop Stop
Emergency Contact
They should not automatically receive:
Academic Results
Fee Balance
Medical/other sensitive information
unless explicitly authorized and required.
This reinforces the value of domain-specific permissions and scopes.

19.41 Transportation Reports
Transportation can own:
Vehicle Report
Driver Report
Route Report
Student Assignment Report
Capacity Report
Trip Report
Transport Collection Reference Report
But financial collection reports belong to Fee Management.

19.42 Transportation Conceptual Model
School
  │
  └── Transportation
        │
        ├── Vehicles
        │
        ├── Drivers
        │
        ├── Routes
        │    └── Stops
        │
        ├── Transport Services
        │
        ├── Trips
        │
        └── Student Assignments
                 │
                 ↓
               Student
Financial relationship:
Student Transport Assignment
          ↓
Applicable Transport Charge
          ↓
Fee Management

19.43 What We Should Not Finalize Yet
Intentionally deferred:
❌ Complete transportation database schema
❌ GPS vendor
❌ GPS architecture
❌ Live tracking
❌ Route optimization algorithms
❌ Driver mobile application
❌ Transport attendance implementation
❌ Vehicle maintenance domain
❌ Advanced pricing engine
❌ Emergency transport workflows

19.44 Current Domain Architecture
Our system is now becoming:
                         PLATFORM CORE
                              │
                              ↓
                         SCHOOL/TENANT
                              │
      ┌───────────────────────┼────────────────────────┐
      ↓                       ↓                        ↓
 ACADEMIC                 STUDENT                  TEACHER
 STRUCTURE                MANAGEMENT               MANAGEMENT
      │                       │                        │
      └──────────────┬────────┴─────────────┬──────────┘
                     ↓                      ↓
                ATTENDANCE             EXAMINATION
                     │                      │
                     └──────────┬───────────┘
                                ↓
                          FEE MANAGEMENT
                                │
                                ↓
                     TRANSPORTATION
One correction to the visual dependency interpretation: Transportation is not dependent on Fee Management. Both are independent tenant domains; Transportation can provide charge information to Fee Management.
The more accurate relationship is:
                    SCHOOL / TENANT
                           │
        ┌──────────────────┼──────────────────┐
        ↓                  ↓                  ↓
 Transportation       Fee Management       Student
        │                  ↑                  │
        └────── charge ────┘                  │
                                              │
        ┌─────────────────────────────────────┘
        ↓
 Transport Assignment
That separation is important for future changes.

19.45 Next Domain
The next logical domain is Communication / Notification Management.
Before that, however, there is one architectural area worth addressing because the number of domains is growing:
Student
Teacher
Attendance
Examination
Fees
Transportation
We should define the common domain conventions and cross-domain contract rules before designing many more modules.
That will prevent each future module from inventing its own patterns for:
IDs,
lifecycle states,
tenant references,
audit,
events,
files,
notifications,
configuration,
imports/exports,
permissions,
reporting.
So the next step should be Part 20 — Cross-Domain Standards & Shared Platform Contracts, followed by Communication, Library, Timetable, and the remaining domains.
