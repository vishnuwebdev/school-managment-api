<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 18

School Calendar & Events Management
The Calendar domain should provide the school's shared temporal structure without becoming the owner of academic years, attendance, examinations, leave, or timetable data.
The core distinction is:
Academic Year
      ↓
School Calendar
      ├── Holidays
      ├── Working Days
      ├── Events
      └── Calendar Exceptions
Other domains consume calendar information rather than maintaining their own independent holiday logic.

757. Domain Boundary
Calendar & Events owns:
school calendars
calendar periods
holidays
non-working days
school events
event categories
event participants/audiences
event locations
event publication
event reminders
calendar exceptions
It does not own:
academic years
timetable periods
teacher leave
attendance
examinations
fee due dates
Those domains can reference calendar information.

758. School Calendar
school_calendars
----------------
id
tenant_id
academic_year_id
name
code
start_date
end_date
status
is_current
created_at
updated_at
version
Status:
DRAFT
ACTIVE
CLOSED
ARCHIVED
Normally one calendar is current for a given academic year unless the school explicitly supports multiple calendars.

759. Calendar Periods
Schools may divide a calendar into:
Term 1
Term 2
Term 3
calendar_periods
----------------
id
tenant_id
calendar_id
name
code
start_date
end_date
sequence
status
created_at
updated_at
These periods are calendar concepts and should not replace Academic Management's academic structures.

760. Working Calendar
Calendar provides the common working/non-working-day definition.
calendar_days
-------------
id
tenant_id
calendar_id
calendar_date
day_type
reason
is_working_day
created_at
updated_at
Day types:
WORKING
HOLIDAY
WEEKEND
SPECIAL_WORKING
SCHOOL_CLOSED

761. Why Calendar Owns Holidays
Leave, Fees, Attendance and Timetable may all need to know whether a date is a school working day.
Without a shared source:
Attendance holiday
≠
Leave holiday
≠
Timetable holiday
The Calendar domain provides the common school calendar.

762. Holiday
calendar_holidays
-----------------
id
tenant_id
calendar_id
holiday_date
name
holiday_type
is_full_day
description
status
created_at
updated_at
Holiday types:
SCHOOL
PUBLIC
OPTIONAL
EXAM_BREAK
TERM_BREAK
OTHER

763. Holiday Rules
A holiday can have domain-specific consequences.
For example:
School Holiday
 ↓
No regular timetable
 ↓
No normal student attendance
But:
Holiday
 ≠
Automatic cancellation of every event
An explicitly scheduled event may still occur.
Each consuming domain decides how to interpret the calendar.

764. Event
school_events
------------
id
tenant_id
calendar_id
title
description
event_type_id
start_date
end_date
start_time
end_time
all_day
location_id
status
visibility
created_by
published_at
created_at
updated_at
version
Status:
DRAFT
SCHEDULED
PUBLISHED
CANCELLED
COMPLETED
ARCHIVED

765. Event Types
event_types
-----------
id
tenant_id
code
name
description
status
created_at
updated_at
Examples:
PARENT_MEETING
SPORTS_DAY
CULTURAL_EVENT
STAFF_MEETING
WORKSHOP
HOLIDAY
ORIENTATION
OTHER

766. Event Location
event_locations
---------------
id
tenant_id
name
description
capacity
location_type
status
created_at
updated_at
Examples:
AUDITORIUM
GROUND
CLASSROOM
ONLINE
OFF_CAMPUS
This is intentionally separate from Timetable rooms because an event location does not necessarily represent a regularly scheduled classroom resource.

767. Event Audience
Events should target audience groups rather than requiring manual recipient lists in every case.
event_audiences
---------------
id
tenant_id
event_id
audience_type
academic_year_id
class_id
section_id
created_at
updated_at
Examples:
ALL_STUDENTS
ALL_PARENTS
ALL_TEACHERS
STAFF
CLASS
SECTION
CUSTOM

768. Event Participants
For events requiring explicit participation:
event_participants
------------------
id
tenant_id
event_id
participant_type
participant_id
participation_status
registered_at
created_at
updated_at
Status:
INVITED
REGISTERED
CONFIRMED
DECLINED
ATTENDED
ABSENT
CANCELLED
This is different from audience targeting.

769. Audience vs Participant
Audience
→ Who should receive information

Participant
→ Who is actually participating
For example:
Audience → Grade 5 parents
Participants → parents who registered

770. Event Recurrence
V1 should support common recurring events without introducing a generic calendar engine.
event_recurrences
-----------------
id
tenant_id
event_id
frequency
interval_value
days_of_week
until_date
occurrence_count
status
Initial frequency:
DAILY
WEEKLY
MONTHLY
Only add complex recurrence rules when required.

771. Event Occurrences
For recurring events, generated occurrences can be materialized when necessary.
event_occurrences
-----------------
id
tenant_id
event_id
occurrence_date
start_time
end_time
status
This allows one occurrence to be cancelled or changed without changing the recurrence definition.

772. Event Cancellation
Do not delete an event after publication.
PUBLISHED
 ↓
CANCELLED
Retain:
cancellation reason
actor
timestamp

773. Event Rescheduling
For a published event:
Original Event
 ↓
Event Change
 ↓
New Date/Time
The original change should be auditable.
For recurring events, modify the recurrence or a specific occurrence rather than rewriting history.

774. Calendar Publication
A calendar may have:
DRAFT
 ↓
REVIEW
 ↓
PUBLISHED
Publishing exposes the approved calendar to users and consuming modules.

775. Calendar Versioning
Like Timetable, a published calendar should not be silently overwritten.
Recommended:
Calendar Version 1
 ↓
Published

Calendar Version 2
 ↓
Draft changes
 ↓
Published
Historical attendance/leave decisions can therefore reference the calendar context applicable at that time.

776. Calendar Exceptions
calendar_exceptions
-------------------
id
tenant_id
calendar_id
exception_date
exception_type
reason
is_working_day_override
created_at
updated_at
Examples:
Special Working Saturday
Unexpected School Closure
Holiday Change

777. Calendar Conflict Rules
The Calendar domain should identify obvious conflicts such as:
event start >= event end
event outside calendar range
invalid recurrence
It should not attempt to own every cross-domain conflict.
For example, whether an event conflicts with a class timetable is determined through Timetable integration.

778. Event Capacity
If a location has capacity:
registered participants <= location.capacity
may be enforced.
This should be configurable because some events may intentionally exceed nominal capacity.

779. Event Registration
For events requiring registration:
event_registration_settings
---------------------------
id
tenant_id
event_id
registration_required
registration_open_at
registration_close_at
maximum_participants
waitlist_enabled

780. Event Registration
event_registrations
-------------------
id
tenant_id
event_id
participant_type
participant_id
status
registered_at
cancelled_at
created_at
updated_at
version
Status:
REGISTERED
WAITLISTED
CONFIRMED
CANCELLED
ATTENDED

781. Waitlist
If enabled:
Capacity Full
 ↓
Registration
 ↓
WAITLISTED
When a confirmed participant cancels:
Next waitlisted participant
 ↓
CONFIRMED
The transition must be concurrency-safe.

782. Calendar Permissions
calendar.view
calendar.manage
calendar.publish

holiday.view
holiday.manage

event.view
event.create
event.update
event.cancel
event.publish

event_registration.view
event_registration.manage

calendar.export

783. APIs
Calendars:
/api/v1/calendars
/api/v1/calendars/:id
/api/v1/calendars/:id/publish
Calendar days:
/api/v1/calendars/:id/days
/api/v1/calendars/:id/holidays
Events:
/api/v1/events
/api/v1/events/:id
/api/v1/events/:id/publish
/api/v1/events/:id/cancel
Registration:
/api/v1/events/:id/registrations
/api/v1/events/:id/registrations/:registrationId

784. Calendar Application Services
CreateCalendar
PublishCalendar
CreateCalendarPeriod

CreateHoliday
UpdateHoliday
CreateCalendarException

CreateEvent
UpdateEvent
PublishEvent
CancelEvent
RescheduleEvent

RegisterParticipant
CancelRegistration
PromoteWaitlist

GetSchoolCalendar
GetUpcomingEvents

785. Calendar Events
CalendarCreated
CalendarPublished
CalendarUpdated

HolidayCreated
HolidayUpdated
CalendarExceptionCreated

SchoolEventCreated
SchoolEventPublished
SchoolEventUpdated
SchoolEventCancelled
SchoolEventCompleted

EventRegistrationCreated
EventRegistrationCancelled
EventRegistrationConfirmed

786. Communication Integration
Published events can trigger notifications:
School Event Published
 ↓
Communication
 ↓
Audience Resolution
 ↓
Notification
Examples:
parent meeting
holiday
sports day
orientation
event reminder
Calendar should not send messages directly.

787. Timetable Integration
A calendar can affect timetable operations:
School Closed
 ↓
Timetable identifies affected recurring schedule
But Timetable owns the schedule itself.
A calendar change should therefore emit an event rather than directly modifying timetable records.

788. Attendance Integration
Attendance can query:
Is this a school working day?
The answer comes from Calendar.
Attendance still owns the actual attendance session.

789. Leave Integration
Leave calculation can use Calendar to determine:
working days
holidays
school closures
Leave still owns leave entitlement and applications.
This removes duplicate holiday logic.

790. Examination Integration
Examination can reference calendar dates for:
examination periods
holidays
school closures
Examination remains authoritative for examination schedules.

791. Fee Integration
Fee Management may use calendar information for:
due-date reminders
payment office closures
collection schedules
It should not use calendar events to silently alter financial obligations.

792. Calendar Date Semantics
Use:
DATE
for:
school dates
holidays
event dates
Use tenant-local time for:
event start/end
reminders
scheduled communication
Persist actual timestamps in UTC when required.

793. Calendar Timezone
Tenant configuration provides the authoritative timezone.
All calendar calculations use:
tenant.timezone
Never use the server's timezone as the business timezone.

794. Event Reminders
Reminder configuration:
event_reminders
--------------
id
tenant_id
event_id
reminder_type
offset_minutes
status
created_at
Example:
24 hours before
1 hour before
The reminder produces a notification request through Communication.

795. Calendar Jobs
Background jobs:
EventReminderJob
RecurringEventGenerationJob
CalendarPublicationJob
EventExpiryJob
WaitlistPromotionJob
All jobs are tenant-scoped and idempotent.

796. Calendar Concurrency
Important operations:
publishing calendar
event registration
waitlist promotion
event rescheduling
occurrence modification
should use optimistic locking and transactional checks.

797. Registration Concurrency
Example:
Capacity = 100
Confirmed = 99

User A registers
User B registers
Only one may consume the final confirmed seat if capacity is enforced.
The registration transaction must revalidate capacity.

798. Calendar Audit
Audit:
calendar publication
holiday changes
working-day overrides
event creation
event changes
cancellation
publication
registration
waitlist promotion
manual overrides
Changing a published holiday should require an explicit reason.

799. Calendar Database Indexes
school_calendars:
  tenant_id, academic_year_id, code UNIQUE

calendar_days:
  tenant_id, calendar_id, calendar_date UNIQUE

calendar_holidays:
  tenant_id, calendar_id, holiday_date

school_events:
  tenant_id, calendar_id, start_date
  tenant_id, status, start_date

event_participants:
  tenant_id, event_id, participant_type, participant_id

event_registrations:
  tenant_id, event_id, participant_type, participant_id UNIQUE
  tenant_id, event_id, status

event_occurrences:
  tenant_id, event_id, occurrence_date

800. Calendar Tenant Isolation
All calendar and event data is tenant-scoped.
An event ID from another school must never be accessible simply because the ID is known.

801. Calendar Module Contract
School Calendar & Events
│
├── Calendars
├── Calendar Periods
├── Calendar Days
├── Holidays
├── Exceptions
├── Events
├── Locations
├── Audiences
├── Participants
├── Registrations
└── Reminders
Primary lifecycle:
Calendar Draft
 ↓
Review
 ↓
Publish
 ↓
Operational Use
 ↓
Close
 ↓
Archive
Event lifecycle:
Draft
 ↓
Scheduled
 ↓
Published
 ↓
Completed
The critical architectural rule is:
Calendar provides the school's authoritative temporal context; individual domains continue to own their operational transactions.

Remaining Major Domains
At this point the architecture has covered most of the core school-management operational surface:
1. Identity / Authentication
2. Tenant / School Management
3. Plans / Subscriptions / Entitlements
4. Platform Billing
5. Student Management
6. Academic Management
7. Teacher Management
8. Attendance
9. Examination & Results
10. Fee Management
11. Timetable
12. Leave & Availability
13. Communication
14. File / Document Management
15. Library
16. Transport
17. Inventory & Assets
18. HR / Staff Administration
19. School Calendar & Events
The next major specification should be Payroll & Salary Management if payroll is intended to be part of the SaaS product. Otherwise, the next high-value domain is Parent/Student Portal & Self-Service, which would define the external-facing access model over the domains already designed.
