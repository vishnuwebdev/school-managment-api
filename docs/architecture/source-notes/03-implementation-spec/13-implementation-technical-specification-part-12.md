<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 12

Communication & Notifications
Communication should be a shared platform capability with a domain module for school-specific messaging. It should not be implemented independently inside Student, Attendance, Fees, Examination, etc.
The architecture should centralize:
recipient resolution
templates
channels
delivery
retries
preferences
provider integrations
delivery audit
while individual domains remain responsible for deciding when a business event deserves communication.

465. Domain Boundary
Communication owns:
notification templates
notification requests
announcements
recipient resolution
delivery channels
delivery attempts
notification preferences
provider configuration
messaging status
communication history
It does not own:
student identity
parent/guardian identity
teacher identity
fee transactions
attendance
examination results
school lifecycle
Those domains provide references and events.

466. Communication Architecture
Domain Event
     ↓
Notification Decision
     ↓
Notification Request
     ↓
Recipient Resolution
     ↓
Template Rendering
     ↓
Channel Delivery
     ↓
Provider
     ↓
Delivery Result
Example:
Fee Invoice Issued
      ↓
Communication
      ↓
Parent recipients
      ↓
SMS + WhatsApp + Email

467. Notification vs Announcement
These are different concepts.
Notification
Triggered by a business event.
Examples:
fee invoice issued
attendance marked absent
result published
leave approved
Announcement
A user intentionally creates a message for a target audience.
Examples:
school holiday notice
parent meeting
school event
emergency announcement
Both use the common delivery infrastructure.

468. Notification Templates
notification_templates
----------------------
id
tenant_id
code
name
event_type
channel
subject_template
body_template
status
version
created_at
updated_at
Status:
DRAFT
ACTIVE
INACTIVE
ARCHIVED

469. Template Versioning
Never modify a published template in place if historical reproducibility matters.
Use:
Template
 ├── Version 1
 ├── Version 2
 └── Version 3
A notification records the template version used.

470. Template Variables
Templates use a controlled variable model.
Example:
{{student_name}}
{{invoice_number}}
{{amount_due}}
{{due_date}}
Only registered variables are allowed.
Do not permit arbitrary executable template expressions.

471. Template Rendering
Use a sandboxed/simple template engine.
Rendering input:
template
+
validated context
Output:
subject
body
Template rendering must never execute arbitrary code.

472. Notification Channels
Initial channels:
IN_APP
EMAIL
SMS
WHATSAPP
PUSH
Channel availability depends on tenant/provider configuration.

473. Provider Abstraction
Communication should not depend directly on one provider.
interface NotificationProvider {
  send(request): Promise<ProviderResult>
}
Implementations can include:
EmailProvider
SmsProvider
WhatsAppProvider
PushProvider
Provider credentials belong in secure configuration/secrets management.

474. Notification Request
notification_requests
---------------------
id
tenant_id
event_id
notification_type
template_id
template_version
priority
status
scheduled_at
created_at
updated_at
Status:
PENDING
PROCESSING
SENT
PARTIALLY_SENT
FAILED
CANCELLED

475. Notification Recipients
notification_recipients
-----------------------
id
tenant_id
notification_request_id
recipient_type
recipient_id
channel
destination
status
created_at
updated_at
Recipient types:
USER
STUDENT
GUARDIAN
TEACHER
STAFF
TENANT_ADMIN
The actual recipient resolution should use domain/application interfaces rather than duplicating contact data.

476. Destination Snapshot
At the time of delivery, retain the destination actually used.
Example:
email = parent@example.com
This is useful when the contact information later changes.
The snapshot is historical delivery data, not authoritative identity data.

477. Delivery Attempts
notification_deliveries
-----------------------
id
tenant_id
notification_recipient_id
provider
provider_message_id
attempt_number
status
sent_at
delivered_at
failed_at
failure_code
failure_reason
created_at
updated_at
This allows retries without overwriting the original attempt.

478. Delivery Status
QUEUED
SENDING
SENT
DELIVERED
FAILED
BOUNCED
REJECTED
CANCELLED
Not every provider supports every state.
Provider-specific states should be normalized into the platform model.

479. Notification Preferences
Users should control eligible communication channels.
notification_preferences
------------------------
id
tenant_id
user_id
notification_type
channel
enabled
created_at
updated_at
Example:
Fee Reminder
 ├── Email → ON
 ├── SMS → ON
 └── WhatsApp → OFF

480. Mandatory Notifications
Some notifications may not be user-disableable.
Examples:
security alerts
account verification
password reset
critical school announcements
The template/type definition can specify:
is_mandatory
Preferences cannot override mandatory delivery.

481. Notification Priority
LOW
NORMAL
HIGH
CRITICAL
Priority influences queue processing, not business authorization.

482. Announcement
announcements
-------------
id
tenant_id
title
body
announcement_type
status
publish_at
expires_at
created_by
published_by
created_at
updated_at
version
Status:
DRAFT
SCHEDULED
PUBLISHED
EXPIRED
CANCELLED

483. Announcement Audience
Do not store only a free-form recipient list.
Use audience rules.
announcement_audiences
----------------------
id
tenant_id
announcement_id
audience_type
academic_year_id
class_id
section_id
recipient_group
created_at
Examples:
ALL_PARENTS
ALL_TEACHERS
GRADE
SECTION
CUSTOM_RECIPIENTS

484. Audience Resolution
At send time:
Audience Rule
 ↓
Resolve Current Members
 ↓
Apply Preferences
 ↓
Generate Recipients
This prevents stale recipient lists from becoming authoritative.

485. Announcement Publication
Draft
 ↓
Schedule / Publish
 ↓
Recipient Resolution
 ↓
Delivery
Large announcements should use background jobs.

486. In-App Notifications
In-app notifications should be persisted separately enough to support unread/read state.
in_app_notifications
--------------------
id
tenant_id
user_id
notification_request_id
title
body
deep_link
read_at
created_at
expires_at

487. Deep Links
Notifications can carry a safe application route.
Example:
/fees/invoices/123
The client must still authorize access after navigation.
A deep link is not an authorization mechanism.

488. Communication Authorization
Sending communication requires permission.
Initial permissions:
notification.view
notification.send
notification.manage_templates

announcement.view
announcement.create
announcement.update
announcement.publish
announcement.cancel

communication.view_history
communication.export

489. Recipient Privacy
A notification must not expose other recipients.
For example, bulk email should not accidentally place hundreds of parent addresses in a single visible recipient list.
Provider adapters should support:
individual delivery
or
provider-approved batch delivery
with appropriate privacy controls.

490. Communication APIs
Templates:
/api/v1/notification-templates
/api/v1/notification-templates/:id
/api/v1/notification-templates/:id/versions
Notifications:
/api/v1/notifications
/api/v1/notifications/:id
/api/v1/notifications/:id/cancel
Announcements:
/api/v1/announcements
/api/v1/announcements/:id
/api/v1/announcements/:id/publish
/api/v1/announcements/:id/cancel
Preferences:
/api/v1/notification-preferences
History:
/api/v1/communication/history

491. Notification Application Services
CreateTemplate
PublishTemplateVersion
DisableTemplate

CreateNotification
ResolveRecipients
QueueNotification
CancelNotification

CreateAnnouncement
PublishAnnouncement
CancelAnnouncement

SendNotification
RetryDelivery

UpdateNotificationPreference
MarkInAppNotificationRead

492. Asynchronous Delivery
Business transactions should not wait for SMS/email/WhatsApp delivery.
Example:
Fee Invoice
 ↓
DB transaction commits
 ↓
Outbox Event
 ↓
Notification Job
 ↓
Provider
Provider failure must not roll back the invoice.

493. Retry Strategy
Delivery failures use bounded retries.
Example conceptual policy:
Attempt 1
 ↓
short delay
 ↓
Attempt 2
 ↓
longer delay
 ↓
Attempt 3
 ↓
Failed / Dead Letter
Retryability depends on provider response.
Permanent failures should not be endlessly retried.

494. Idempotent Delivery
Every notification delivery should have an idempotency key.
For example:
tenant_id
+
notification_request_id
+
recipient_id
+
channel
Provider-specific idempotency keys should be used where supported.

495. Provider Webhooks
Providers may send:
delivered
bounced
failed
read
rejected
Webhook processing follows:
Signature Verification
 ↓
Deduplication
 ↓
Persist Receipt
 ↓
Resolve Delivery
 ↓
Update Status
Provider webhook event IDs must be unique.

496. Communication Events
Important events:
NotificationQueued
NotificationSent
NotificationDelivered
NotificationFailed

AnnouncementPublished
AnnouncementExpired

NotificationPreferenceChanged
Provider-specific events should remain inside the Integration/Communication boundary unless they have broader business meaning.

497. Domain Trigger Examples
Attendance
Attendance marked absent
 ↓
Attendance Event
 ↓
Notification
 ↓
Parent
Fees
Invoice issued
 ↓
Notification
 ↓
Parent
Examination
Results published
 ↓
Notification
 ↓
Student / Guardian
The originating domain decides that the event occurred; Communication decides how to deliver it.

498. Notification Deduplication
A single business event should not unintentionally generate duplicate notifications.
Use:
event_id
notification_type
recipient
channel
as part of the deduplication strategy.
If a user legitimately needs multiple notifications from the same event, that must be explicitly represented.

499. Scheduled Notifications
Support:
scheduled_at
for:
fee reminders
upcoming events
examination notices
school announcements
The job processor picks up due notification requests.

500. Communication Templates and Tenant Overrides
System templates may provide defaults.
Tenant-specific templates can override them.
Resolution:
Tenant Template
      ↓
if absent
      ↓
Platform Default Template
Tenant customization must never change the platform default globally.

501. Multi-Tenant Provider Configuration
Provider configuration belongs to the tenant where applicable.
tenant_id
provider_type
provider_config_reference
status
Actual credentials should live in secure secrets/configuration storage, not ordinary database rows in plaintext.

502. Communication Audit
Audit:
template changes
announcement creation/publication
bulk communication
manual sends
recipient overrides
preference changes
provider configuration changes
cancellation
delivery failures where operationally significant
Message content may contain personal data, so retention and access must be controlled.

503. Communication Data Retention
Not every delivery record needs indefinite retention.
Separate:
Business audit
Delivery history
Provider technical logs
Application logs
with independent retention policies.

504. Communication Database Indexes
notification_templates:
  tenant_id, code, version

notification_requests:
  tenant_id, status, scheduled_at
  tenant_id, event_id

notification_recipients:
  tenant_id, notification_request_id
  tenant_id, recipient_id, status

notification_deliveries:
  tenant_id, notification_recipient_id
  provider, provider_message_id

notification_preferences:
  tenant_id, user_id, notification_type, channel UNIQUE

announcements:
  tenant_id, status, publish_at

in_app_notifications:
  tenant_id, user_id, read_at
  tenant_id, user_id, created_at

505. Communication Tenant Isolation
Every request must carry:
TenantContext
Background jobs must also carry tenant context.
A notification job must never be able to resolve recipients from another tenant.

506. Cross-Tenant Safety
Particularly sensitive operations:
bulk announcement
bulk SMS
bulk email
communication export
must enforce:
+
audience authorization
+
recipient resolution
Platform-wide communication requires an explicit platform permission and separate audience rules.

507. Communication Reporting
Initial reports:
Messages Sent
Delivery Rate
Failure Rate
Channel Usage
Announcement Delivery
Notification History
These are operational reports, not the source of truth for business domains.

508. Communication Module Contract
Communication
│
├── Templates
├── Template Versions
├── Notification Requests
├── Recipients
├── Delivery Attempts
├── Announcements
├── Preferences
├── In-App Notifications
└── Provider Integrations
Core flow:
Business Event
 ↓
Notification Request
 ↓
Recipient Resolution
 ↓
Template
 ↓
Channel
 ↓
Provider
 ↓
Delivery Tracking
The central architectural rule is:
Business domains produce authoritative events; Communication owns delivery and never becomes the source of truth for the business transaction that triggered the message.

Next Domain
The next implementation specification will cover Document & File Management, including document metadata, private file storage, student/teacher/tenant documents, access control, uploads, versioning, expiry tracking, secure download URLs, retention and file lifecycle.
