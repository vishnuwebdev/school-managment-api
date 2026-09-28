<!-- Source: Apple Notes, folder 'Notes' -->
# Part 21 — Communication & Notification Management

Communication is a cross-cutting capability, but it should still have a clear domain boundary.
The key distinction is:
Business domains decide that something should be communicated. Communication Management decides how, when, and through which channel it is delivered.
For example:
Fee Management
   ↓
FeeDue event
   ↓
Communication Management
   ↓
Email / SMS / Push / In-App
Fee Management should not contain SMS-provider code.

21.1 Domain Purpose
Communication Management handles:
Communication
│
├── Notification Templates
├── Notification Preferences
├── Recipients
├── Notification Requests
├── Delivery
├── Delivery Status
├── In-App Notifications
├── Broadcasts
└── Communication History
Potential future capabilities:
├── Email
├── SMS
├── Push Notifications
├── WhatsApp
├── Parent Messaging
├── Teacher Messaging
├── Announcements
└── Campaigns
These should be introduced independently.

21.2 Communication vs Notification
We should distinguish two concepts.
Notification
A system-generated message triggered by an event.
Example:
Fee payment received
Communication
A broader message intentionally sent to users/groups.
Example:
School holiday announcement
Therefore:
Communication Management
├── Notifications
└── Broadcasts / Announcements

21.3 Communication Does Not Own Business Events
For example:
Exam Published
belongs to Examination.
Communication consumes:
ExamPublished
and determines whether a notification should be sent.

21.4 Notification Flow
Standard flow:
Domain Operation
      ↓
Domain Event
      ↓
Notification Policy
      ↓
Create Notification
      ↓
Resolve Recipient
      ↓
Select Channel
      ↓
Queue Delivery
      ↓
Provider
      ↓
Delivery Result
This keeps business domains independent of communication infrastructure.

21.5 Example: Fee Reminder
Fee Demand
      ↓
Due Date Approaching
      ↓
Fee Event
      ↓
Notification Policy
      ↓
Guardian
      ↓
SMS + Email
The Fee domain does not need to know which SMS provider is used.

21.6 Notification Channels
Initial architecture should support:
In-App
Email
SMS
Push
Future:
WhatsApp
Voice
Other external channels
Channels should be adapters behind a common interface.
Conceptually:
Notification Service
       │
 ┌─────┼─────┬─────┐
 ↓     ↓     ↓     ↓
Email  SMS  Push  In-App

21.7 Provider Abstraction
Avoid:
FeeService → Twilio
ExamService → Provider X
TransportService → Provider Y
Instead:
Communication
      ↓
Channel Adapter
      ↓
Provider
This allows providers to change without rewriting business modules.

21.8 Notification Template
Templates should be configurable.
Conceptually:
Template
├── Event Type
├── Channel
├── Language
├── Subject
├── Body
├── Variables
└── Version
Example:
Event:
FeeDue

Channel:
Email

Variables:
student_name
amount
due_date

21.9 Template Variables
Templates should support controlled variables.
Example:
{{student_name}}
{{amount}}
{{due_date}}
{{school_name}}
The system should validate variables rather than allowing arbitrary code execution or unrestricted template logic.

21.10 Template Versioning
Published communication templates should be versioned.
Fee Reminder
 ├── v1
 ├── v2
 └── v3
A historical delivery should retain the version/content used at the time.
This is important for communication history.

21.11 Notification Preferences
Users should be able to control appropriate notifications.
Conceptually:
User
 ↓
Notification Preferences
 ↓
Event
 ↓
Channel
Example:
Fee Reminder
Email = ON
SMS = ON
Push = OFF
However, some notifications may be mandatory and not user-disableable.

21.12 Mandatory vs Optional Notifications
A notification policy can define:
Required
Optional
Examples potentially required:
Security alert
Account access event
Payment confirmation
Examples potentially optional:
General announcement
Reminder
Promotional message
The exact policy depends on product/business requirements.

21.13 Recipient Resolution
A domain event should not directly provide raw communication addresses everywhere.
Instead:
Event
 ↓
Recipient Resolver
 ↓
User / Guardian / Teacher / Staff
 ↓
Contact Channels
This centralizes recipient logic.

21.14 Guardian Notifications
For students:
Student
 ↓
Guardian Relationship
 ↓
Guardian Contact
 ↓
Notification
This is why the earlier separation between:
Guardian
and:
User
is important.
A guardian can receive communication without necessarily having a portal login.

21.15 Contact Information
Communication should use authoritative contact information.
For example:
Guardian
 ├── Phone
 ├── Email
 └── Communication Preferences
The communication system should not create another independent phone/email database.

21.16 Delivery Status
Every delivery should have a lifecycle.
For example:
Queued
 ↓
Processing
 ↓
Sent
 ↓
Delivered
Alternative:
Failed
Retrying
Cancelled
The exact states depend on the channel.

21.17 Delivery Failure
Communication failure should not normally roll back the business event.
Example:
Payment Received
      ↓
Payment SUCCESS
      ↓
SMS FAILED
The payment remains successful.
The notification is retried independently.

21.18 Retry Policy
Transient failures can be retried.
Example:
Attempt 1
 ↓
Failed
 ↓
Retry
 ↓
Failed
 ↓
Retry
 ↓
Final Failure
Retry strategy should have:
maximum attempts,
delay/backoff,
provider-specific error handling.

21.19 Idempotent Delivery
A notification must not accidentally be sent twice because of a retry.
Conceptually:
Notification ID
+
Channel
+
Recipient
or an equivalent idempotency key prevents duplicate delivery.

21.20 In-App Notifications
In-app notifications can be stored:
Notification
├── Recipient
├── Title
├── Message
├── Type
├── Read Status
└── Created At
Example:
"You have 3 pending fee approvals."

21.21 Broadcasts / Announcements
Schools may need:
Announcement
Examples:
School will remain closed tomorrow.

Annual function registration is now open.

Parent meeting scheduled for Saturday.
These are not necessarily generated by domain events.

21.22 Broadcast Targeting
Announcements may target:
Entire School
Teachers
Students
Guardians
Specific Class
Specific Section
Specific Role
Specific User Group
The recipient scope must be tenant-safe.
A school user must never be able to broadcast to another tenant.

21.23 Scheduled Communications
Announcements may be:
Draft
Scheduled
Published
Expired
Cancelled
Example:
Create today
 ↓
Schedule for tomorrow 8:00 AM
 ↓
Automatically deliver
This uses the existing background-job infrastructure.

21.24 Communication History
The system should retain:
Who sent it
Who received it
What was sent
Which channel
When
Delivery status
Template/version
This is useful for:
support,
compliance,
troubleshooting,
user history.

21.25 Audit vs Communication History
They remain separate.
Audit:
Admin changed notification template
Communication history:
Fee reminder sent to Guardian X
Both may exist for the same action.

21.26 Communication Permissions
Initial permissions:
communication.view
communication.create
communication.send
communication.cancel
communication.export
Templates:
notification_template.view
notification_template.create
notification_template.update
notification_template.publish
notification_template.archive
Broadcasts:
announcement.view
announcement.create
announcement.update
announcement.publish
announcement.cancel

21.27 Sensitive Communication Permissions
Sending a message to the entire school can be high-impact.
Therefore:
announcement.publish
may require elevated permission.
Potentially later:
Create
   ↓
Review
   ↓
Approve
   ↓
Publish
The approval mechanism can reuse the platform's general approval concepts.

21.28 Communication Feature Structure
Initial:
Communication
│
├── Notifications
├── Templates
├── In-App Messages
├── Announcements
└── Delivery History
Potential future:
├── SMS
├── WhatsApp
├── Parent Messaging
├── Teacher Messaging
└── Campaigns

21.29 Feature Entitlement
A school may have:
communication.basic
while advanced channels might later be commercial capabilities:
communication.sms
communication.whatsapp
communication.bulk
The entitlement system already supports this.
Do not create these as separate commercial features unless the business model actually needs them.

21.30 Tenant Isolation
Every communication record must carry tenant context.
Examples:
Notification
Announcement
Template
Delivery
Communication History
Search, queues, logs, and reports must maintain the same tenant boundary.

21.31 Cross-Domain Events
Examples:
StudentCreated
FeeDemandIssued
PaymentReceived
ExamPublished
AttendanceMarkedAbsent
TransportTripCancelled
Communication subscribes where appropriate.
This gives us:
Domain → Event → Communication
rather than:
Domain → SMS Provider

21.32 Notification Policy
A policy determines:
Event
 ↓
Should notify?
 ↓
Who?
 ↓
Which channel?
 ↓
When?
 ↓
Which template?
For example:
PaymentReceived
→ Guardian
→ Email + In-App
→ Immediately
while:
FeeDue
→ Guardian
→ SMS
→ 3 days before due date

21.33 Policy Configuration
Schools may eventually configure:
Enabled notifications
Channels
Timing
Recipients
Language
Templates
Configuration changes should be audited.

21.34 Language / Localization
The architecture should support localized templates.
Example:
Fee Reminder
├── English
├── Hindi
└── Other language
The system can choose language based on recipient preferences or school configuration.
Exact localization rules can be deferred.

21.35 Communication and Consent
Some channels may require consent or opt-in policies.
The platform should leave room for:
Communication Consent
without assuming every channel has identical legal requirements.
This is particularly relevant to external messaging channels.

21.36 External Provider Abstraction
The architecture should look like:
Communication Service
        │
        ├── Email Adapter
        │       ↓
        │    Provider
        │
        ├── SMS Adapter
        │       ↓
        │    Provider
        │
        └── Push Adapter
                ↓
             Provider
Changing providers should not require changes to Fee, Exam, Student, or Transportation domains.

21.37 Background Jobs
Communication should use the common job infrastructure for:
Bulk sending
Scheduled notifications
Retries
Digest generation
Provider reconciliation
Every tenant-specific job carries tenant context.

21.38 Bulk Communication
Example:
Send announcement
to 2,000 guardians
should not perform 2,000 external API calls inside one HTTP request.
Instead:
Create Broadcast
 ↓
Queue Job
 ↓
Fan-out
 ↓
Provider Delivery
 ↓
Results

21.39 Communication Rate Limits
Protect the platform against accidental or malicious bulk sending.
Examples:
Maximum messages per operation
Maximum messages per hour
Provider rate limits
Per-user send limits
The exact limits can be configuration/operational policy.

21.40 Communication Reports
Useful reports:
Messages Sent
Delivery Rate
Failure Rate
Channel Usage
Notification History
Broadcast History
Provider-specific reporting can remain within the communication infrastructure.

21.41 Events
Communication itself may emit:
NotificationQueued
NotificationSent
NotificationDelivered
NotificationFailed

AnnouncementPublished
AnnouncementCompleted
Other platform services can consume these if required.

21.42 Communication Conceptual Model
Domain Event
     │
     ↓
Notification Policy
     │
     ↓
Recipient Resolution
     │
     ↓
Notification
     │
     ↓
Delivery
     │
 ┌───┼────┬────┐
 ↓   ↓    ↓    ↓
Email SMS Push In-App
     │
     ↓
Delivery History
For broadcasts:
Announcement
    ↓
Target Audience
    ↓
Recipient Resolution
    ↓
Bulk Delivery

21.43 What We Should Not Finalize Yet
Intentionally deferred:
❌ Specific SMS provider
❌ Specific email provider
❌ WhatsApp provider
❌ Exact consent/legal implementation
❌ Complete template engine
❌ Marketing campaign system
❌ Chat/messaging platform
❌ Advanced communication analytics
❌ AI-generated communication
These should be selected when actual requirements exist.

21.44 Updated Architecture
The platform now looks like:
                         PLATFORM CORE
                              │
                              ↓
                         SCHOOL/TENANT
                              │
       ┌──────────────────────┼───────────────────────┐
       ↓                      ↓                       ↓
  ACADEMIC                STUDENT                  TEACHER
  STRUCTURE               MANAGEMENT               MANAGEMENT
       │                      │                       │
       └──────────────┬───────┴───────────┬───────────┘
                      ↓                   ↓
                 ATTENDANCE          EXAMINATION
                      │                   │
                      └─────────┬─────────┘
                                ↓
                              FEES
                                │
                       TRANSPORTATION
                                │
                                ↓
                       DOMAIN EVENTS
                                │
                                ↓
                     COMMUNICATION
                                │
                    ┌───────────┼───────────┐
                    ↓           ↓           ↓
                  Email        SMS         Push
The important architectural point is that Communication is downstream of domain events, not embedded inside individual domains.

21.45 Next Domain — Timetable
The next domain should be Timetable Management.
It will combine several existing foundations:
Academic Structure
+
Teacher Assignments
+
Subjects
+
Sections
+
Rooms
+
Time Slots
It will also introduce an important distinction between:
Timetable Configuration
and:
Actual Scheduled Classes
which will matter later for substitutions, cancellations, teacher availability, and future attendance integration.
