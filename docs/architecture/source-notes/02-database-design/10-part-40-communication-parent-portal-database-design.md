<!-- Source: Apple Notes, folder 'Core Database design system' -->
# Part 40 — Communication + Parent Portal Database Design

These should remain two separate domains even though they interact heavily.
The core architecture is:
Business Domains
      ↓
Domain Events
      ↓
Communication
      ↓
Notification / Announcement
      ↓
Provider
      ↓
Delivery
and:
Guardian
   ↓
Portal Account
   ↓
Guardian Scope
   ↓
Student Relationship
   ↓
Domain Read Models
The Parent Portal is therefore an access and workflow layer, not a second source of truth.

40.1 Communication Ownership
Communication owns:
Notification Templates
Notification Template Versions
Notification Preferences
Notification Requests
Recipients
Deliveries
Delivery Attempts
In-App Notifications
Announcements
Announcement Targets
Communication History
It does not own:
Students
Teachers
Fees
Attendance
Examinations
Library
Transportation
Timetable
Those domains decide what happened.
Communication decides how to communicate it.

40.2 Notification Template
Conceptually:
notification_templates
----------------------
id
tenant_id
template_key
name
event_type
channel
language
status
created_at
updated_at
Examples:
fee.demand.issued
attendance.absence.created
exam.result.published
library.loan.overdue
leave.request.approved
transport.change.published

40.3 Template Version
Published templates should be versioned.
notification_template_versions
------------------------------
id
tenant_id
template_id
version
subject_template
body_template
variables_schema
status
published_at
created_at
Why?
If a notification was sent using Version 3, later editing the template to Version 4 must not rewrite the historical communication record.

40.4 Channel
Initial channels:
IN_APP
EMAIL
SMS
PUSH
Future:
WHATSAPP
OTHER
The domain should not hardcode provider-specific details.

40.5 Provider Adapter
Communication should interact with an abstract provider interface:
Communication
      ↓
Channel Adapter
      ↓
Provider
For example:
Email
  ↓
Email Provider A

SMS
  ↓
SMS Provider B
Changing providers should not require changing the Notification domain.

40.6 Notification Request
A notification request represents the system deciding:
This communication should be sent.
notification_requests
---------------------
id
tenant_id
event_type
template_id
template_version_id
priority
status
scheduled_at
created_at
It can reference the originating domain entity:
source_entity_type
source_entity_id
plus correlation information.

40.7 Why Source Entity Matters
Suppose:
Fee Demand #123
causes:
Notification Request #456
The communication history can retain:
source = Fee Demand #123
without Communication owning the Fee Demand.

40.8 Recipient
Recipients can be:
User
Guardian
Student
Teacher
Staff
School audience
However, Communication should resolve recipients from authoritative domain relationships.
It should not maintain its own independent copy of:


40.9 Recipient Snapshot
For historical delivery, preserve the destination used at the time.
For example:
recipient_snapshot
------------------
recipient_type
recipient_reference
channel
destination
display_name
This is useful because a user's email address may change later.
Historical delivery should still show where the message was actually sent.

40.10 Delivery
A notification request can generate multiple deliveries.
notification_request
       │
       ├── Email Delivery
       ├── SMS Delivery
       └── In-App Delivery
Conceptually:
notification_deliveries
-----------------------
id
tenant_id
notification_request_id
recipient_type
recipient_id
channel
destination
status
sent_at
delivered_at
failed_at
created_at
updated_at

40.11 Delivery Lifecycle
QUEUED
   ↓
PROCESSING
   ↓
SENT
   ↓
DELIVERED
Failure path:
PROCESSING
   ↓
FAILED
   ↓
RETRYING
   ↓
SENT / DELIVERED
Some providers may only support:

without confirming delivery.

40.12 Delivery Attempts
Provider retries should be separately recorded when necessary.
notification_delivery_attempts
------------------------------
id
tenant_id
delivery_id
attempt_number
provider
provider_message_id
status
error_code
error_message
attempted_at
This prevents the main Delivery record from becoming a confusing retry log.

40.13 Idempotency
Notification delivery must be idempotent.
For example:
event_id = E123
recipient = U456
channel = EMAIL
should not accidentally send the same email twice because a worker was retried.
An appropriate idempotency key should be generated for the delivery operation.

40.14 In-App Notification
In-app notifications are stored directly:
in_app_notifications
--------------------
id
tenant_id
recipient_user_id
notification_request_id
title
body
notification_type
read_at
created_at
This supports:
Unread
Read
without requiring an external provider.

40.15 Notification Preferences
Users may control permitted notification channels.
notification_preferences
------------------------
id
tenant_id
user_id
notification_type
channel
enabled
updated_at
Example:
Fee Reminder
 ├── Email = ON
 ├── SMS   = ON
 └── Push  = OFF

40.16 Mandatory Notifications
Not every notification should be suppressible.
For example, a school may classify certain security or administrative notifications as mandatory.
Therefore:
User Preference
      +
Notification Policy
      ↓
Effective Delivery Decision
A preference must not automatically override a mandatory notification.

40.17 Announcement
An announcement is different from an event-generated notification.
Examples:
"School will remain closed tomorrow."

"Annual sports day registrations are open."
Conceptually:
announcements
------------
id
tenant_id
title
body
status
publish_at
expires_at
created_by
published_by
created_at
updated_at

40.18 Announcement Lifecycle
DRAFT
   ↓
SCHEDULED
   ↓
PUBLISHED
   ↓
EXPIRED
Alternative:


40.19 Announcement Targeting
Announcements may target:
Entire School
Students
Guardians
Teachers
Staff
Specific Class
Specific Section
Specific Group
Specific Users
Use a target table rather than embedding all targeting into the announcement.
announcement_targets
--------------------
id
tenant_id
announcement_id
target_type
target_reference

40.20 Target Resolution
For example:
Announcement
Target = CLASS
Reference = Grade 8
Communication resolves the applicable users.
The announcement does not permanently duplicate every student/guardian relationship unless needed for delivery history.

40.21 Scheduled Announcements
Scheduled announcements should use the Job system:
Announcement
   ↓
Scheduled Job
   ↓
Publish
   ↓
Resolve Audience
   ↓
Create Deliveries
Do not depend on an HTTP request remaining alive until the scheduled time.

40.22 Communication History
Historical communication should answer:
What was sent?
To whom?
When?
Through which channel?
Using which template version?
What was the result?
This is different from Audit.

40.23 Communication vs Audit
Audit:
"Admin changed notification template."

Communication:
"Email was sent to guardian@example..."
They serve different purposes.

40.24 Parent Portal Ownership
Parent Portal owns:
Portal Access
Guardian Portal Membership
Portal Scope
Portal Preferences
Self-Service Requests
Portal Read Models / Dashboard Aggregation
It does not own:
Student
Enrollment
Attendance
Exam Results
Fees
Library Loans
Transport Assignments
Timetable

40.25 Guardian Identity Chain
The established identity model becomes:
Guardian
   ↓
User Account
   ↓
Membership
   ↓
School
   ↓
Guardian Scope
   ↓
Student Relationship
The guardian relationship remains owned by Student Management.

40.26 Portal Access
Conceptually:
portal_access
------------
id
tenant_id
guardian_id
user_id
status
invited_at
activated_at
suspended_at
revoked_at
created_at
updated_at
Lifecycle:
NOT_INVITED
   ↓
INVITED
   ↓
PENDING_ACTIVATION
   ↓
ACTIVE
Alternative states:
SUSPENDED
REVOKED

40.27 Guardian Scope
The portal must determine exactly which students the guardian can access.
Do not trust:
GET /students/123
merely because the authenticated user supplied Student 123.
Authorization must resolve:
Authenticated Guardian
       ↓
Guardian Relationship
       ↓
Authorized Student

40.28 Multiple Children
A guardian can have:
Guardian
 ├── Student A
 ├── Student B
 └── Student C
The portal can therefore provide a child selector.
Each selected student must still be authorized through the underlying relationship.

40.29 Different Guardian Access
Two guardians may have different access.
For example:
Guardian A
 ├── Student profile
 ├── Attendance
 ├── Fees
 └── Results

Guardian B
 ├── Student profile
 └── Attendance
This should be represented through relationship/access policy rather than assuming all guardians have identical rights.

40.30 Portal Permissions
Examples:
portal.student.view
portal.attendance.view
portal.exam.view
portal.result.view
portal.fee.view
portal.fee.pay
portal.library.view
portal.transport.view
portal.timetable.view
portal.communication.view
portal.request.create
These are still subject to:
Guardian Relationship
+
Student Scope
+
Entitlement
+
Portal Permission

40.31 Portal Dashboard
The dashboard may combine:
Student
Attendance
Examination
Fees
Timetable
Library
Transportation
Communication
But the dashboard is an aggregation layer.
It should not become the owner of these records.

40.32 Portal Read Models
For performance, a read model can aggregate frequently displayed information.
Conceptually:
Domain Events
    ↓
Portal Read Model
    ↓
Dashboard
Example:
portal_student_summary
----------------------
tenant_id
student_id
attendance_summary
outstanding_fee_summary
latest_result_summary
library_summary
transport_summary
updated_at
This is derived data.
The operational domains remain authoritative.

40.33 Eventual Consistency
Portal dashboards may be slightly stale.
For example:
Fee payment completed
        ↓
Portal summary updated asynchronously
The actual payment screen should still query the Fees domain when authoritative current information is required.

40.34 Fee Payment from Portal
The portal must never do:
UPDATE fee_demand
SET paid = true
Instead:
Portal
 ↓
Fees Payment Command
 ↓
Payment Gateway
 ↓
Fees
 ↓
Payment / Allocation / Receipt
 ↓
Portal Read Model

40.35 Examination Results
The portal should only expose published results.
Marks
 ↓
Calculation
 ↓
Review
 ↓
Publication
 ↓
Portal
It should not expose draft or unpublished marks merely because the guardian is authenticated.

40.36 Attendance
Portal access is generally read-only:
Attendance
 ↓
Published/visible attendance
 ↓
Portal
If parents need to report an absence, that should become a request:
Portal
 ↓
Absence Request
 ↓
Attendance / Leave workflow
 ↓
Approval
 ↓
Actual Attendance
The portal never directly changes attendance.

40.37 Portal Requests
Self-service requests can be modeled as:
portal_requests
---------------
id
tenant_id
guardian_id
student_id
request_type
status
subject
description
created_at
updated_at
Examples:
ABSENCE_REQUEST
DOCUMENT_REQUEST
PROFILE_UPDATE_REQUEST
TRANSFER_REQUEST
OTHER
The target domain owns the actual approval/change.

40.38 Portal Request Lifecycle
DRAFT
   ↓
SUBMITTED
   ↓
UNDER_REVIEW
   ↓
APPROVED / REJECTED
Potential:


40.39 Portal Request Ownership
For example:
Profile Update Request
        ↓
Student Management
        ↓
Validation
        ↓
Student Updated
The Portal owns the request submission, not the Student record.

40.40 Portal Documents
Documents use the common File Service.
Portal
 ↓
Authorized Document
 ↓
File Service
 ↓
Private File
Access must be tenant- and relationship-scoped.

40.41 Portal Invitations
Invitation flow:
Guardian
 ↓
Portal Access Created
 ↓
Invitation
 ↓
Communication
 ↓
Activation
 ↓
Portal Active
Invitation tokens should be:
expiring,
single-use,
non-guessable.
Authentication remains owned by Identity.

40.42 Portal Preferences
Conceptually:
portal_preferences
------------------
id
tenant_id
guardian_id
language
timezone
display_preferences
updated_at
Notification preferences remain owned by Communication.
Do not duplicate notification preference logic here.

40.43 Parent Portal Audit
Audit important actions such as:
Portal invitation
Portal activation
Portal suspension
Portal revocation
Guardian relationship access changes
Sensitive document access
Payment initiation
Portal request submission/cancellation

40.44 Communication Events
Communication consumes events from other domains:
FeeDemandIssued
PaymentReceived
ResultPublished
AttendanceMarked
LoanOverdue
ReservationAvailable
LeaveApproved
TransportChangePublished
It may produce:
NotificationQueued
NotificationSent
NotificationFailed
AnnouncementPublished

40.45 Portal Events
Portal can produce:
GuardianPortalInvited
GuardianPortalActivated
GuardianPortalSuspended
GuardianPortalRevoked
PortalRequestCreated
PortalRequestCancelled
It consumes domain events such as:
ResultPublished
FeeDemandIssued
PaymentReceived
LibraryLoanOverdue
TransportChangePublished
AnnouncementPublished

40.46 Tenant Isolation
Communication and Portal records must remain tenant-scoped.
For example:
notification_deliveries.tenant_id
announcements.tenant_id
notification_preferences.tenant_id
and:
portal_access.tenant_id
portal_requests.tenant_id
portal_preferences.tenant_id
Cross-school recipient resolution must be impossible.

40.47 Communication Database Structure
Communication
├── notification_templates
├── notification_template_versions
├── notification_preferences
├── notification_requests
├── notification_deliveries
├── notification_delivery_attempts
├── in_app_notifications
├── announcements
└── announcement_targets

40.48 Parent Portal Database Structure
Parent Portal
├── portal_access
├── portal_preferences
├── portal_requests
└── portal_read_models
The Guardian–Student relationship remains in Student Management.

40.49 Key Boundary
The final distinction should be:
Communication
= "How do we tell someone?"

Portal
= "How does a guardian access information and initiate requests?"

Domain
= "What actually happened?"
This prevents both modules from becoming oversized cross-domain owners.

40.50 Complete Flow Example
Suppose a student's fee demand is issued.
Fees
  │
  └── FeeDemandIssued
          ↓
     Communication
          ↓
     Notification Request
          ↓
     Resolve Guardian
          ↓
     Email + In-App
The guardian then opens the portal:
Guardian
   ↓
Portal
   ↓
Authorized Student
   ↓
Fees Read Model / Fees
   ↓
Outstanding Demand
The guardian pays:
Portal
   ↓
Fees
   ↓
Payment Gateway
   ↓
Payment Confirmed
   ↓
Receipt
   ↓
Portal Read Model
No circular ownership is introduced.

40.51 Communication Failure
If email provider fails:
Fee Demand
   ↓
Committed Successfully
   ↓
Notification Queued
   ↓
Email Failed
   ↓
Retry
The fee transaction is not rolled back.

40.52 Portal Read Model Failure
If portal projection processing fails:
Fee Payment
   ↓
Successful
   ↓
Portal Projection Failed
The payment remains authoritative and successful.
The projection worker retries.

40.53 Notification Deduplication
A domain event should have a stable:
event_id
Communication should use that when constructing idempotency keys.
This prevents duplicate notification delivery after event/job retries.

40.54 Feature Entitlement
Both Communication and Parent Portal remain subject to the entitlement system.
For example:
Parent Portal
   ↓
Entitlement
   ↓
portal.attendance
A school may have:
Parent Portal = enabled
Attendance Portal View = disabled
without disabling the underlying Attendance domain.

40.55 Key Decisions Locked
✓ Communication is downstream from business domains
✓ Templates are versioned
✓ Delivery is separate from Notification Request
✓ Delivery attempts are retryable
✓ Provider adapters isolate external vendors
✓ Notification preferences are separate from portal preferences
✓ Announcements are separate from event notifications
✓ Communication history is separate from audit
✓ Parent Portal is not a source of business truth
✓ Guardian relationships remain in Student Management
✓ Portal authorization is relationship-scoped
✓ Portal requests do not directly modify domain data
✓ Portal dashboards may use read models
✓ Portal read models are eventually consistent
✓ Fee payments still belong to Fees
✓ Published results remain owned by Examination
✓ Tenant isolation applies throughout

40.56 Architecture After Part 40
                    PLATFORM
                       │
        ┌──────────────┼──────────────┐
        ↓              ↓              ↓
   Identity/RBAC   Entitlement     Communication
        │                              ↑
        │                              │
        ↓                              │
      SCHOOL                           │
        │                              │
 ┌──────┼───────────────┐              │
 ↓      ↓       ↓       ↓              │
Student Academic Teacher Operations ────┘
   │       │       │       │
   └───────┴───────┴───────┴──→ Events
                                  │
                                  ↓
                           Communication
                                  │
                                  ↓
                              Guardians
                                  │
                                  ↓
                             Parent Portal
                                  │
                                  ↓
                          Domain Read Models
The important architectural property is that Portal and Communication sit downstream of the operational domains rather than becoming central owners of school data.
Next: Part 41 — Reporting & Integrations Database Design
That will cover:
Reporting
├── Report Definitions
├── Report Runs
├── Dashboards
├── Metrics
├── Read Models
├── Exports
└── Scheduled Reports

Integrations
├── Integration Registry
├── Provider Connections
├── Credentials References
├── Webhooks
├── Sync Jobs
├── External References
└── Integration Logs
After Part 41, the remaining step will be the global database constraints, indexing, transaction, concurrency, and cross-tenant integrity review before considering the foundation complete.
