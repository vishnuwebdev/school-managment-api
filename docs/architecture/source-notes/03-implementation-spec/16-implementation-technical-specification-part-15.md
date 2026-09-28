<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 15

Transport Management
Transport should be designed around routes, stops, vehicles, assignments and trips rather than treating transport as simply a field on the student record.
The core model is:
Route
  ↓
Stops
  ↓
Route Schedule
  ↓
Vehicle / Driver
  ↓
Student Transport Assignment
  ↓
Pickup / Drop-off
Transport also needs to remain independent from Fee Management while exposing chargeable transport assignments to it.

602. Domain Boundary
Transport owns:
transport configuration
routes
route stops
vehicles
drivers
driver assignments
route schedules
student transport assignments
pickup/drop-off configuration
transport trips
trip attendance/status
transport incidents
transport fees configuration
transport reports
It does not own:
students
teachers
fee invoices/payments
employment records
attendance
notifications

603. Transport Configuration
transport_settings
------------------
id
tenant_id
default_capacity_policy
tracking_enabled
trip_tracking_enabled
distance_unit
status
created_at
updated_at
version
This allows school-specific configuration without hardcoding behavior.

604. Route
A route represents a recurring transport path.
transport_routes
----------------
id
tenant_id
code
name
description
route_type
status
effective_from
effective_until
created_at
updated_at
version
Route types:
PICKUP
DROP_OFF
BOTH
Status:
DRAFT
ACTIVE
INACTIVE
ARCHIVED

605. Route Stops
transport_route_stops
---------------------
id
tenant_id
route_id
stop_code
name
sequence
latitude
longitude
pickup_allowed
drop_off_allowed
estimated_arrival_time
status
created_at
updated_at
Coordinates are optional in V1.
The design should not require GPS tracking.

606. Stop Ordering
sequence determines route order.
Example:
1 → Main Gate
2 → Central Market
3 → Green Park
4 → School
Unique constraint:
tenant_id + route_id + sequence

607. Stop Time
Store scheduled local time rather than UTC for recurring routes.
Example:
07:15
07:25
07:40
Interpret using the tenant timezone.

608. Vehicle
transport_vehicles
------------------
id
tenant_id
registration_number
vehicle_number
vehicle_type
capacity
make
model
manufacture_year
status
created_at
updated_at
version
Status:
AVAILABLE
ASSIGNED
MAINTENANCE
INACTIVE
RETIRED

609. Vehicle Identity
Vehicle registration number should be unique per tenant.
tenant_id + registration_number
Do not assume government registration numbers are globally unique enough for platform-level authorization.

610. Vehicle Capacity
Capacity is a configurable numeric limit.
capacity
Student assignment validation should consider active assignments for the relevant route/time.
Do not simply count every historical assignment.

611. Drivers
Transport should not create a second person identity model.
A driver can reference:
Teacher/Staff identity where applicable
external driver record where the driver is not a school employee
Recommended:
transport_drivers
----------------
id
tenant_id
user_id
teacher_id
name
phone
license_number
license_expiry_date
status
created_at
updated_at
version
For an external driver, teacher_id is null.

612. Driver Types
STAFF
EXTERNAL
CONTRACTOR
Employment information remains outside Transport.

613. Driver Eligibility
Before assigning a driver:
driver active
+
license valid
+
required documents valid
If regulatory requirements become more sophisticated, they can be added as configurable compliance rules.

614. Route Schedule
A route can operate on different schedules.
transport_route_schedules
-------------------------
id
tenant_id
route_id
day_of_week
start_time
end_time
vehicle_id
driver_id
status
effective_from
effective_until
created_at
updated_at
version

615. Route Schedule Conflicts
Prevent:
Vehicle A
07:00–08:00
Route 1

AND

Vehicle A
07:30–08:30
Route 2
unless the school explicitly allows overlapping schedules.
Likewise for drivers.

616. Student Transport Assignment
Students need an effective-dated transport assignment.
student_transport_assignments
-----------------------------
id
tenant_id
student_id
enrollment_id
route_id
pickup_stop_id
dropoff_stop_id
transport_type
start_date
end_date
status
created_at
updated_at
version
Transport type:
PICKUP_ONLY
DROP_OFF_ONLY
BOTH

617. Why Enrollment Is Referenced
Transport assignment should remain tied to the student's academic context where relevant.
A student changing section/class may need a new assignment while historical transport records remain intact.
Do not overwrite the old assignment.

618. Assignment Lifecycle
DRAFT
 ↓
ACTIVE
 ↓
SUSPENDED
 ↓
ENDED
 ↓
ARCHIVED

619. Pickup/Drop-off Safety
Pickup and drop-off points should be explicit.
Do not infer:
pickup_stop = route.first_stop
because student-specific arrangements may differ.

620. Guardian Contact
Transport may need an authorized pickup person.
Do not duplicate Guardian identity.
Reference Student Management's guardian relationship.
Future model:
transport_pickup_authorizations
-------------------------------
id
tenant_id
student_id
guardian_id
pickup_stop_id
valid_from
valid_until
status

621. Transport Schedule
A student assignment does not necessarily mean the student travels every day.
Support schedule applicability:
MONDAY
TUESDAY
WEDNESDAY
THURSDAY
FRIDAY
This can be represented in an assignment schedule table.
student_transport_assignment_days
----------------------------------
assignment_id
day_of_week

622. Transport Trips
A recurring route is configuration.
A trip is an actual operational occurrence.
transport_trips
---------------
id
tenant_id
route_schedule_id
trip_date
trip_type
vehicle_id
driver_id
status
started_at
completed_at
created_at
updated_at
version
Trip types:
PICKUP
DROP_OFF
Status:
PLANNED
STARTED
COMPLETED
CANCELLED

623. Why Trips Matter
Without trip records, the system cannot distinguish:
scheduled route
from:
actual route operated on 2026-09-28
Trips provide operational history.

624. Trip Student Records
If the school needs actual transport attendance:
transport_trip_students
-----------------------
id
tenant_id
trip_id
student_transport_assignment_id
status
boarded_at
dropped_at
marked_by
remarks
created_at
updated_at
version
Status:
EXPECTED
BOARDED
NOT_BOARDED
DROPPED
NO_SHOW

625. Transport Attendance vs School Attendance
Transport attendance is not academic attendance.
Do not write transport boarding status into Attendance Management.
They represent different facts.

626. Trip Student Lifecycle
Pickup:
EXPECTED
 ↓
BOARDED
 ↓
DROPPED
No-show:
EXPECTED
 ↓
NO_SHOW
A transport trip can therefore provide operational safety information without contaminating academic attendance.

627. Route Capacity
Before activating a student assignment:
active assignments
+
new assignment
<=
vehicle capacity
if capacity enforcement is enabled.
If capacity is exceeded, the system should reject or require an explicitly authorized override.

628. Capacity Race Condition
Two administrators may simultaneously add students.
Therefore capacity validation must occur inside a transaction with appropriate locking/revalidation.
Example:
Capacity = 40
Current = 39

Admin A → add
Admin B → add
Only one should consume the final seat under strict capacity enforcement.

629. Transport Fees Integration
Transport should define the chargeable transport configuration, but Fee Management owns financial obligations.
Example:
Transport Assignment
       ↓
Transport Fee Rule
       ↓
Fee Management
       ↓
Demand / Invoice

630. Transport Fee Rules
transport_fee_rules
-------------------
id
tenant_id
route_id
stop_id
transport_type
amount
frequency
effective_from
effective_until
status
created_at
updated_at
Examples:
Monthly
Quarterly
Annual

631. Fee Snapshot
When Fee Management creates a demand, it snapshots the transport amount.
Changing the route price later must not silently alter an already-issued invoice.

632. Transport Suspension
A student may temporarily stop using transport.
Use:
ACTIVE
 ↓
SUSPENDED
rather than ending the assignment if it is expected to resume.
Fee behavior should be controlled by explicit business rules.

633. Transport Assignment Changes
Changing:
route
pickup stop
drop-off stop
transport type
should create historical records.
Do not mutate historical trip context.

634. Assignment Effective Dates
Prevent conflicting active assignments.
For the same student:
assignment A:
2026-01-01 → 2026-06-30

assignment B:
2026-07-01 → ...
is valid.
Overlapping assignments should normally require an explicit exception.

635. Vehicle Maintenance
V1 can support basic maintenance status without creating a full fleet-management system.
vehicle_maintenance
-------------------
id
tenant_id
vehicle_id
maintenance_type
scheduled_date
completed_date
status
remarks
created_at
updated_at
Status:
SCHEDULED
IN_PROGRESS
COMPLETED
CANCELLED
A vehicle in blocking maintenance should not be assignable to a new trip.

636. Driver Availability
Transport can use driver availability information from its own operational records.
If the driver is also a school teacher/staff member, broader Leave/Availability information should be consulted through the appropriate interface.

637. Driver Substitution
If a driver becomes unavailable:
Driver unavailable
 ↓
Affected route schedules/trips
 ↓
Replacement driver
Do not change the driver's employment or leave record.

638. Route Exceptions
Support one-day changes:
transport_schedule_exceptions
-----------------------------
id
tenant_id
route_schedule_id
exception_date
exception_type
reason
status
created_at
updated_at
Examples:
route cancelled
alternate vehicle
alternate driver
stop temporarily unavailable

639. Route Stop Exceptions
transport_stop_exceptions
-------------------------
id
tenant_id
route_id
stop_id
exception_date
status
reason
This handles temporary closure or pickup changes.

640. Incident Management
Transport should support operational incidents.
transport_incidents
-------------------
id
tenant_id
trip_id
incident_type
severity
description
occurred_at
reported_by
status
created_at
updated_at
Types:
ACCIDENT
BREAKDOWN
DELAY
STUDENT_INCIDENT
DRIVER_INCIDENT
OTHER
Severity:
LOW
MEDIUM
HIGH
CRITICAL

641. Incident Workflow
REPORTED
 ↓
UNDER_REVIEW
 ↓
RESOLVED
 ↓
CLOSED
Critical incidents should be separately auditable and capable of triggering urgent notifications.

642. GPS / Live Tracking
Do not make live GPS a V1 dependency.
The architecture can later support:
Trip
 ↓
Location Provider
 ↓
Live Position
without changing student assignment or route models.

643. Transport Permissions
Initial permissions:
transport.view
transport.manage_routes
transport.manage_stops

transport.manage_vehicles
transport.manage_drivers

transport.view_assignments
transport.create_assignment
transport.update_assignment
transport.suspend_assignment
transport.end_assignment

transport.manage_trips
transport.mark_boarding

transport.manage_fees

transport.manage_incidents
transport.view_reports
transport.export

644. APIs
Routes:
/api/v1/transport/routes
/api/v1/transport/routes/:id
/api/v1/transport/routes/:id/stops
Vehicles:
/api/v1/transport/vehicles
/api/v1/transport/vehicles/:id
Drivers:
/api/v1/transport/drivers
/api/v1/transport/drivers/:id
Assignments:
/api/v1/transport/student-assignments
/api/v1/transport/student-assignments/:id
Trips:
/api/v1/transport/trips
/api/v1/transport/trips/:id
/api/v1/transport/trips/:id/students
Incidents:
/api/v1/transport/incidents
/api/v1/transport/incidents/:id

645. Transport Application Services
CreateRoute
AddRouteStop
UpdateRoute
ActivateRoute

CreateVehicle
UpdateVehicle
RetireVehicle

CreateDriver
UpdateDriver
SuspendDriver

CreateRouteSchedule
ValidateRouteSchedule

AssignStudentTransport
ChangeStudentTransport
SuspendStudentTransport
EndStudentTransport

CreateTrip
StartTrip
CompleteTrip
CancelTrip

MarkStudentBoarded
MarkStudentDropped
MarkStudentNoShow

ReportTransportIncident
ResolveTransportIncident

646. Transport Events
RouteCreated
RouteActivated
RouteUpdated

VehicleCreated
VehicleMaintenanceStarted
VehicleMaintenanceCompleted
VehicleRetired

DriverCreated
DriverSuspended

StudentTransportAssigned
StudentTransportChanged
StudentTransportSuspended
StudentTransportEnded

TripCreated
TripStarted
TripCompleted
TripCancelled

StudentBoarded
StudentDropped
StudentNoShow

TransportIncidentReported
TransportIncidentResolved

647. Notification Integration
Communication may consume events such as:
TripDelayed
TransportIncidentReported
Reservation/assignment change
For example:
Transport incident
 ↓
Communication
 ↓
Authorized guardians
The Transport domain should not directly send SMS/WhatsApp/email.

648. Student Integration
Transport references:
student_id
enrollment_id
guardian_id
Student Management remains authoritative.
When a student is withdrawn/transferred, Transport can react through events and identify affected active assignments.

649. Fee Integration
Transport sends chargeable assignment information to Fee Management through an application interface/event.
Fee Management generates:
demand
invoice
payment
receipt
Transport never updates those financial records directly.

650. Timetable Integration
Transport generally operates independently from academic timetable.
However, school start/end times can inform route schedules.
Use an interface/read model rather than duplicating academic schedules.

651. Leave Integration
If a driver is a school employee, Leave/Availability may affect driver availability.
Transport should query authoritative availability before assigning a driver.

652. Transport Audit
Audit:
route changes
stop changes
vehicle changes
driver assignments
student assignments
capacity overrides
trip operations
boarding changes
incidents
fee configuration changes
manual overrides
Especially sensitive:
student pickup/drop-off changes
incident changes
capacity overrides

653. Transport Database Indexes
transport_routes:
  tenant_id, code UNIQUE

transport_route_stops:
  tenant_id, route_id, sequence UNIQUE
  tenant_id, route_id, stop_code

transport_vehicles:
  tenant_id, registration_number UNIQUE
  tenant_id, vehicle_number UNIQUE

transport_drivers:
  tenant_id, license_number

transport_route_schedules:
  tenant_id, route_id, day_of_week
  tenant_id, vehicle_id, day_of_week
  tenant_id, driver_id, day_of_week

student_transport_assignments:
  tenant_id, student_id, status
  tenant_id, route_id, status
  tenant_id, pickup_stop_id
  tenant_id, dropoff_stop_id

transport_trips:
  tenant_id, route_schedule_id, trip_date, trip_type

transport_trip_students:
  tenant_id, trip_id, student_transport_assignment_id

transport_incidents:
  tenant_id, trip_id, status

654. Transport Concurrency
Critical operations:
student assignment
vehicle assignment
driver assignment
trip creation
boarding status
capacity enforcement
must use transactional validation and optimistic locking/locking where necessary.

655. Historical Integrity
Historical trips must retain:
actual vehicle
actual driver
route
stop
student assignment
even if the route or vehicle is later changed.
Do not resolve historical trips dynamically from today's route configuration.

656. Transport Module Contract
Transport
│
├── Routes
├── Stops
├── Vehicles
├── Drivers
├── Route Schedules
├── Student Assignments
├── Trips
├── Boarding
├── Incidents
├── Maintenance
└── Transport Fee Rules
Primary lifecycle:
Route Configuration
 ↓
Student Assignment
 ↓
Scheduled Trip
 ↓
Trip Operation
 ↓
Boarding / Drop-off
 ↓
Trip Completion
The critical architectural rule is:
Transport owns the operational journey; Student owns the person; Fee Management owns the financial obligation; Communication owns the notification.

Next Domain
The next specification will cover Inventory & Asset Management, including asset categories, stock items, warehouses/stores, purchases/receipts, stock movements, issue/return, asset assignment, maintenance, depreciation metadata and disposal.
