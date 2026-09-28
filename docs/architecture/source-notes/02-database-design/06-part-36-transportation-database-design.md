<!-- Source: Apple Notes, folder 'Core Database design system' -->
# Part 36 — Transportation Database Design

Transportation needs to model both long-lived infrastructure and time-bound student assignments.
The central principle is:
A route, vehicle, driver, and student transport assignment can change over time, but historical trips and assignments must remain meaningful.
The domain structure is:
Transportation
├── Vehicles
├── Drivers
├── Routes
├── Stops
├── Transport Services
├── Trips
├── Student Transport Assignments
└── Pickup / Drop Configuration

36.1 Transportation Ownership
Transportation owns:
Vehicle
Driver
Route
Stop
Transport Service
Trip
Student Transport Assignment
Pickup/Drop configuration
It references:
Student
Enrollment
Academic Year
It does not own:
Student identity
Teacher identity
Fees
Payment
Attendance
GPS provider data

36.2 Vehicle
Conceptually:
vehicles
--------
id
tenant_id
vehicle_number
registration_number
vehicle_type
capacity
status
make
model
created_at
updated_at
The exact regulatory/registration fields can be expanded later.

36.3 Vehicle Number vs Registration Number
Keep the internal fleet identifier separate from the government registration identifier.
For example:
vehicle_number = BUS-001
registration_number = RJ-XX-1234
Both are meaningful but serve different purposes.

36.4 Vehicle Lifecycle
Initial model:
AVAILABLE
   ↓
ASSIGNED
   ↓
IN_SERVICE
   ↓
MAINTENANCE
   ↓
AVAILABLE
Additional terminal state:
RETIRED
The vehicle can become unavailable without being deleted.

36.5 Vehicle Capacity
Capacity should be an explicit operational value:
capacity
Later the domain could support:
adult/child capacity,
reserved seats,
accessibility seats,
different seating configurations.
Do not model these now unless required.

36.6 Driver
Driver is a Transportation entity, not automatically a User.
drivers
-------
id
tenant_id
driver_number
first_name
last_name
status
license_reference
license_expiry
phone
created_at
updated_at
A driver may optionally receive a system account:
Driver
 ↓
optional User
 ↓
Membership
Authentication remains in Identity.

36.7 Driver Lifecycle
Possible:
PROSPECTIVE
ACTIVE
INACTIVE
SUSPENDED
ENDED
ARCHIVED
Driver availability is not identical to driver identity/status.
Later, Leave/Staff Operations may provide broader availability information where appropriate.

36.8 Route
A Route represents the normal transport path.
routes
------
id
tenant_id
name
code
description
status
effective_from
effective_to
created_at
updated_at
Example:
Route R01 — City Centre → School

36.9 Route vs Trip
This distinction is essential:
Route
= reusable planned path

Trip
= one specific journey
For example:
Route R01
  ↓
Morning Trip — 2026-09-28
Morning Trip — 2026-09-29
Morning Trip — 2026-09-30
Changing tomorrow's route must not rewrite yesterday's trip.

36.10 Stops
Stops belong to routes through an ordered relationship.
A Stop can be a reusable location:
stops
-----
id
tenant_id
name
code
address
latitude nullable
longitude nullable
status
created_at
updated_at
But route-specific ordering should not be stored directly on Stop.

36.11 Route Stops
Use a separate relationship:
route_stops
-----------
id
tenant_id
route_id
stop_id
sequence
pickup_time
drop_time
status
This allows:
Route A
 ├── Stop 1
 ├── Stop 4
 └── Stop 7

Route B
 ├── Stop 2
 ├── Stop 4
 └── Stop 9
The same physical stop can potentially belong to multiple routes.

36.12 Pickup and Drop Times
A stop can have different operational times for:
pickup
drop
Do not assume a single time is sufficient.
For example:
Stop A
Pickup: 07:20
Drop: 16:15

36.13 Route Versioning
Routes change.
Suppose:
Route R01
Stop A → B → C → School
becomes:
Stop A → D → C → School
Do not simply overwrite the route if historical trips need to retain the previous path.
A strong approach is to make route configuration effective-dated or versioned.
Conceptually:
Route
 ├── Version 1
 └── Version 2

36.14 Route Versions
Possible structure:
route_versions
--------------
id
tenant_id
route_id
version
effective_from
effective_to
status
created_at
Then:
route_version_stops
-------------------
id
tenant_id
route_version_id
stop_id
sequence
pickup_time
drop_time
This gives stronger historical integrity than mutating route_stops.

36.15 Is Route Versioning Necessary?
For the foundation, yes conceptually.
The implementation can be simplified if the school rarely changes routes, but the data model should not make historical transport impossible.

36.16 Transport Service
A Transport Service represents what is offered operationally to students.
For example:
Morning Bus
Evening Bus
One-way Morning
One-way Evening
Full-day Transport
Conceptually:
transport_services
------------------
id
tenant_id
name
code
service_type
status
created_at
updated_at

36.17 Service vs Route
Do not collapse:
Transport Service
and:
Route
A service is the offering.
A route is the path.
A trip is the actual journey.
A student assignment connects the student to the applicable service/path.

36.18 Trip
Trip represents one actual scheduled journey.
trips
-----
id
tenant_id
route_version_id
service_id
trip_date
direction
vehicle_id
driver_id
status
scheduled_start_at
scheduled_end_at
actual_start_at
actual_end_at
created_at
updated_at
Directions might be:
PICKUP
DROP

36.19 Trip Status
Possible:
SCHEDULED
IN_PROGRESS
COMPLETED
CANCELLED
MISSED
The exact operational states can be refined later.

36.20 Vehicle Assignment to Trip
A vehicle can change for a particular trip.
Therefore do not assume:
route.vehicle_id
is sufficient.
Instead:
Trip
 ├── Vehicle
 └── Driver
This supports temporary substitutions.

36.21 Driver Assignment to Trip
Similarly:
Driver A
may normally operate a route but:
Trip on 2026-09-28
 ↓
Driver B
because of leave or operational changes.
The trip should preserve the actual assigned driver.

36.22 Student Transport Assignment
This is the most important student relationship.
student_transport_assignments
-----------------------------
id
tenant_id
student_id
enrollment_id
transport_service_id
route_version_id
pickup_route_stop_id
drop_route_stop_id
status
start_date
end_date
created_at
updated_at
This is the student's transport entitlement/assignment.

36.23 Why Enrollment Reference
Transport may vary by academic year.
Therefore:
Student
 ↓
Enrollment 2026–27
 ↓
Transport Assignment
preserves the academic context.
This also helps when the student's class/section changes.

36.24 Pickup and Drop Stops
Do not assume pickup and drop are identical.
A student may have:
Pickup = Stop A
Drop = Stop D
Therefore both references should be explicit.

36.25 Transport Assignment Lifecycle
Initial states:
REQUESTED
   ↓
APPROVED
   ↓
ACTIVE
   ↓
SUSPENDED
   ↓
ENDED
The portal can later submit a request, but Transportation owns the actual assignment decision.

36.26 Effective Dates
Transport assignments should be effective-dated.
Example:
Student A
Route 1
01-Apr → 31-Aug

Student A
Route 3
01-Sep → 31-Mar
Do not overwrite the original assignment.

36.27 Historical Transport
Suppose a student used:
Route A
in April and:
Route B
in September.
Historical reports should still show:
April → Route A
September → Route B
This is why assignment dates/versioning matter.

36.28 Transport Charge Integration
Transportation can expose a commercial applicability result:
Student Transport Assignment
          ↓
Applicable Transport Charge
Fees then creates the financial demand.
Transportation does not create:
Payment
Receipt
Refund

36.29 Transport Pricing
The domain can eventually support:
FLAT
MONTHLY
ROUTE
ZONE
DISTANCE
ONE_WAY
ROUND_TRIP
But do not create a complex pricing engine now.
For V1, preserve enough information to tell Fees:
Which transport charge applies to this student?
The financial amount should ultimately be owned by Fees.

36.30 Transport Pricing History
If pricing is later managed inside Transportation, preserve effective periods:
Transport Pricing
 ↓
Effective Period
 ↓
Assignment
 ↓
Fee Demand
Once a Fee Demand is issued, changing transport pricing must not alter the existing demand.

36.31 Capacity
A route/trip may have a capacity constraint:
Vehicle Capacity = 40
Assigned Students = 38
The assignment workflow can reject:
Assigned Students = 41
unless an authorized override exists.
Capacity should be validated transactionally to prevent race conditions.

36.32 Transport Capacity vs Route Capacity
Do not assume route capacity equals vehicle capacity.
A route can have:
Route capacity policy
while the assigned vehicle may have:
Actual capacity
For V1, actual vehicle capacity can be the primary constraint.
More advanced route capacity rules can come later.

36.33 Transport Attendance
Transport attendance should remain separate from school attendance.
School attendance:
Student attended class
Transport attendance:
Student boarded / did not board
They are different business facts.
Do not add transport-specific states into the main Attendance domain.

36.34 GPS / Tracking
GPS should not be embedded into the Vehicle entity.
Instead:
Vehicle
   ↓
GPS Integration
   ↓
Location Stream
   ↓
Transport Tracking
The vehicle remains the operational master record.
External tracking data belongs to the Integration/Tracking boundary.

36.35 Driver User Access
If drivers receive access:
Driver
 ↓
User
 ↓
Membership
 ↓
Role
Potential permissions:
transport.trip.view
transport.trip.update
transport.student.view
transport.boarding.record
Driver access should expose only the minimum student information needed operationally.

36.36 Transportation Security
A driver should not automatically receive access to:
Fees
Examination
Attendance
Medical/sensitive student information
Transport scope should determine the student records visible for a trip/route.

36.37 Route Change Workflow
A route change should be treated as an impact-aware operation:
Proposed Route Change
       ↓
Validate
       ↓
Identify affected assignments
       ↓
Review impact
       ↓
Confirm
       ↓
New Route Version
       ↓
Update future assignments
Historical assignments remain untouched.

36.38 Route Change Must Not Cascade Silently
If 35 students are assigned to a route:
Route A
 ↓
35 active assignments
and Route A changes, the system should identify:
35 affected assignments
rather than silently rewriting them.
This follows the same architectural principle used for feature dependencies.

36.39 Transportation Events
Important events:
VehicleCreated
VehicleStatusChanged
DriverCreated
DriverStatusChanged
RouteCreated
RouteVersionPublished
RouteChanged
TransportServiceCreated
TripScheduled
TripStarted
TripCompleted
TripCancelled
StudentTransportRequested
StudentTransportApproved
StudentTransportActivated
StudentTransportChanged
StudentTransportEnded
Downstream consumers:
Fees
Communication
Reporting
Integrations

36.40 Transportation Audit
Audit:
Vehicle changes
Driver changes
Route changes
Route publication
Trip changes
Student assignment changes
Capacity overrides
Transport pricing changes
especially route and assignment modifications.

36.41 Transportation Database Structure
Conceptually:
TRANSPORTATION
────────────────────────
vehicles
drivers

routes
route_versions
route_version_stops
stops

transport_services

trips

student_transport_assignments
This remains intentionally separate from Fees.

36.42 Relationship Diagram
Route
  ↓
Route Version
  ↓
Route Stops
  ↓
Stops

Transport Service
       │
       └──────────┐
                  ↓
               Trip
            ↙         ↘
        Vehicle      Driver

Student
   ↓
Enrollment
   ↓
Student Transport Assignment
   ├── Transport Service
   ├── Route Version
   ├── Pickup Stop
   └── Drop Stop

36.43 Historical Trip
A trip should preserve enough context to explain what actually happened.
At minimum:
Trip
 ├── date
 ├── route version
 ├── service
 ├── vehicle
 └── driver
This prevents later master-data changes from rewriting historical operations.

36.44 Historical Assignment
Similarly:
Student Transport Assignment
 ├── student
 ├── enrollment
 ├── service
 ├── route version
 ├── pickup stop
 ├── drop stop
 ├── start
 └── end
This is sufficient for historical transport reporting.

36.45 Tenant Isolation
All Transportation-owned entities are tenant-scoped:
vehicles.tenant_id
drivers.tenant_id
routes.tenant_id
route_versions.tenant_id
stops.tenant_id
route_version_stops.tenant_id
transport_services.tenant_id
trips.tenant_id
student_transport_assignments.tenant_id
A student from School A must never receive a transport assignment from School B.

36.46 Important Constraints
Examples:
UNIQUE(tenant_id, vehicle_number)

UNIQUE(tenant_id, registration_number)

UNIQUE(tenant_id, driver_number)

UNIQUE(tenant_id, route.code)

UNIQUE(tenant_id, transport_service.code)
For route stops:
UNIQUE(route_version_id, sequence)
For assignments, uniqueness should account for effective periods rather than simply:

because a student can legitimately have multiple historical assignments.

36.47 Indexing
Likely high-value indexes:
vehicles:
  (tenant_id, status)
  (tenant_id, vehicle_number)

drivers:
  (tenant_id, status)
  (tenant_id, driver_number)

trips:
  (tenant_id, trip_date, status)
  (tenant_id, vehicle_id, trip_date)
  (tenant_id, driver_id, trip_date)

student_transport_assignments:
  (tenant_id, student_id, status)
  (tenant_id, route_version_id, status)
  (tenant_id, start_date, end_date)

36.48 Capacity Concurrency
When activating a new assignment:
Count active assignments
        ↓
Compare capacity
        ↓
Commit assignment
The count must be protected against simultaneous assignment requests.
Otherwise:
39 seats available
+
2 simultaneous approvals
=
41 assignments
could occur.

36.49 Fee Integration
The relationship should remain:
Transportation
       ↓
Student Transport Assignment
       ↓
Applicable Charge
       ↓
Fees
       ↓
Fee Demand
This can be implemented through:
synchronous calculation,
a domain contract,
or an event depending on the exact billing workflow.
The financial transaction remains in Fees.

36.50 Communication Integration
Transportation events can produce:
RouteChanged
TripCancelled
StudentTransportActivated
StudentTransportChanged
Communication can then send:
Guardian notification
Transportation should not own SMS/email delivery.

36.51 Reporting Integration
Reporting can consume:
TripCompleted
StudentTransportChanged
VehicleStatusChanged
to produce:
Vehicle utilization
Route utilization
Student assignment counts
Capacity utilization
Trip statistics

36.52 Current Domain Graph
After Transportation:
Academic
   │
   ├──→ Student
   │      │
   │      ├──→ Attendance
   │      ├──→ Examination
   │      ├──→ Fees
   │      └──→ Transportation
   │
   └──→ Teacher
          ↓
    Teaching Assignment
          ↓
       Attendance / Examination

Transportation
      ↓
Applicable Charges
      ↓
     Fees

Transportation
      ↓
 Communication
      ↓
 Reporting / Portal / Integrations
The direction remains clean.

36.53 Key Decisions Locked
✓ Vehicle ≠ Trip
✓ Route ≠ Trip
✓ Route ≠ Transport Service
✓ Driver ≠ User
✓ Student ≠ Transport Assignment
✓ Transport assignment is effective-dated
✓ Route configuration can be versioned
✓ Historical trips retain their operational context
✓ Pickup and drop stops are separate
✓ Capacity is validated
✓ Transport attendance is separate from school attendance
✓ GPS remains an integration/stream concern
✓ Fees owns financial collection
✓ Communication consumes transport events
✓ Reporting consumes transport facts

36.54 What This Enables
The model supports:
multiple buses,
multiple routes,
shared stops,
different pickup/drop locations,
morning/evening services,
changing vehicles,
driver substitutions,
historical route changes,
student route changes,
capacity management,
future GPS tracking,
future transport attendance,
future transport pricing.
without turning Transportation into a fleet-management or GPS platform prematurely.

Next: Part 37 — Timetable Database Design
The next domain will connect:
Academic
Teacher / Teaching Assignment
Rooms
Time Slots
Timetable Entries
Substitutions
Leave / Availability
The particularly important design question will be how to preserve a published timetable version while allowing operational changes such as teacher substitutions, room changes, and cancelled sessions without mutating the base timetable.
