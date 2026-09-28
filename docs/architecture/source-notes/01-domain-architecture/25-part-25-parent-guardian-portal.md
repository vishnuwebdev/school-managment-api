<!-- Source: Apple Notes, folder 'Notes' -->
# Part 25 — Parent / Guardian Portal

The Parent/Guardian Portal should be treated primarily as a user-facing access layer over existing school domains, with a small amount of portal-specific functionality.
The key principle is:
The portal does not become the owner of student, fee, attendance, examination, or communication data.
It provides controlled access to data owned by those domains.

25.1 Why This Needs Its Own Design
A guardian is not the same thing as a system user.
We already established:
Guardian
   ≠
User
A guardian may exist without an account.
When portal access is required:
Guardian
   ↓
User Account
   ↓
Membership
   ↓
School
   ↓
Guardian Scope
This allows the same guardian to potentially have relationships with multiple students.

25.2 Domain Boundary
The portal should own:
Parent / Guardian Portal
├── Portal Access
├── Guardian Context
├── Student Relationships
├── Portal Preferences
├── Self-Service Requests
└── Portal Dashboard / Read Models
It references:
Student
Guardian
Enrollment
Attendance
Examination
Fees
Transportation
Library
Communication
Timetable
It does not own those domain records.

25.3 Guardian Relationship
The existing Student domain owns the relationship:
Student
   ↓
Guardian Relationship
   ↓
Guardian
Example:
Student A
├── Mother
├── Father
└── Emergency Contact
The portal consumes this relationship.
It should not create a second independent student-parent relationship table.

25.4 Guardian User Account
A guardian can be invited to create/login to an account.
Guardian
   ↓
User Account
   ↓
Membership
   ↓
School
The account provides authentication.
The Guardian relationship provides authorization scope.
These are separate concerns.

25.5 Multi-Student Guardians
A guardian may have:
Guardian
 ├── Student A
 ├── Student B
 └── Student C
The portal should support a student selector:
My Children
├── Student A
├── Student B
└── Student C
But authorization must still verify the guardian's relationship with each student.
The client cannot simply submit:
student_id = X
and receive that student's information.

25.6 Student Context
Conceptually:
Authenticated Guardian
        ↓
Guardian Membership
        ↓
Authorized Guardian
        ↓
Student Relationship
        ↓
Student Context
Every student-specific request passes through this authorization boundary.

25.7 Portal Dashboard
The dashboard can aggregate information from existing domains:
Guardian Dashboard
├── Student Summary
├── Attendance
├── Upcoming Exams
├── Recent Results
├── Outstanding Fees
├── Timetable
├── Library Loans
├── Transport
└── Notifications
These are read models/aggregated views, not new copies of the underlying business data.

25.8 Dashboard Architecture
Avoid:
Portal Database
├── Copy of Student
├── Copy of Fees
├── Copy of Attendance
└── Copy of Exams
as the primary source of truth.
Instead:
Portal
  ↓
Domain APIs / Read Models
  ↓
Student
Fees
Attendance
Examination
Library
Transport
For high-performance dashboards, dedicated read models can be introduced later.

25.9 Portal Feature Areas
Initial portal:
Parent Portal
├── My Children
├── Student Profile
├── Attendance
├── Examination / Results
├── Fees
├── Timetable
├── Library
├── Transportation
├── Notifications
└── Requests
The exact feature visibility should follow school entitlements.

25.10 Entitlement Interaction
Suppose a school has no transportation feature.
Then:
Guardian Portal
 ├── Student
 ├── Attendance
 ├── Fees
 ├── Exams
 └── Transportation ← unavailable
The portal should respect the same entitlement engine used by the rest of the platform.
It should not maintain its own feature-access logic.

25.11 Student Profile
Guardian may see permitted information such as:
Student Name
Student Number
Class
Section
Academic Year
Basic Profile Information
Sensitive information should only be exposed if explicitly permitted by policy.

25.12 Attendance
Portal consumes Attendance:
Guardian
 ↓
Authorized Student
 ↓
Attendance
Possible views:
Today's Status
Monthly Summary
Attendance Percentage
Absences
Late Records
The portal does not modify attendance records.
If corrections are allowed, that should be an explicit workflow.

25.13 Examination
Guardian may see:
Upcoming Assessments
Exam Schedule
Marks
Grades
Results
Report Cards
Only published results should normally be visible.
This follows Examination's lifecycle:
Mark Entry
 ↓
Review
 ↓
Publication
 ↓
Guardian Access
A teacher's unpublished marks should not accidentally appear in the portal.

25.14 Fees
Guardian can view:
Outstanding Amount
Fee Demands
Due Dates
Payment History
Receipts
Concessions where appropriate
The Fees domain remains authoritative.

25.15 Online Payment
If online payment is later enabled:
Guardian Portal
      ↓
Fee Payment Request
      ↓
Payment Gateway
      ↓
Fees Domain
      ↓
Payment Confirmation
      ↓
Receipt
The portal should never directly mark a fee as paid.
Payment confirmation must come through the Fees/payment workflow.

25.16 Transportation
If enabled:
Guardian
 ↓
Student
 ↓
Transport Assignment
 ↓
Route / Stop
Potential views:
Route
Pickup Stop
Drop Stop
Pickup Time
Drop Time
Transport Status
Future GPS tracking can be added without changing the basic portal model.

25.17 Library
Guardian may optionally see:
Student Library Loans
Overdue Books
Reservations
Fines
Again, Library remains authoritative.

25.18 Timetable
Guardian may see:
Student
 ↓
Enrollment
 ↓
Class/Section
 ↓
Timetable
This should be a read-only derived view.

25.19 Communication
The portal can expose:
Announcements
Notifications
School Messages
Communication remains the owner.
The portal is simply another delivery/access channel.

25.20 Guardian Preferences
Portal-specific preferences may include:
Preferred Language
Notification Preferences
Portal Display Preferences
Communication preferences should integrate with the common Communication domain rather than creating conflicting preference records.

25.21 Multiple Guardians
A student may have multiple guardians:
Student
 ├── Guardian A
 ├── Guardian B
 └── Guardian C
Each guardian can have different access.
For example:
Guardian A → Portal Access
Guardian B → Portal Access
Guardian C → No Portal Access
The relationship remains the basis for authorization.

25.22 Guardian Relationship Types
Examples:
Parent
Guardian
Grandparent
Sibling
Other Authorized Person
These should be configurable/reference data rather than hardcoded business logic.

25.23 Relationship Permissions
A future model may allow relationship-specific restrictions.
For example:
Guardian A
→ Full academic access

Guardian B
→ Attendance + communication only
This should be implemented through explicit relationship/access policy, not by assuming every guardian has identical rights.

25.24 Portal Access Lifecycle
A guardian portal invitation can follow:
Not Invited
 ↓
Invited
 ↓
Pending Activation
 ↓
Active
 ↓
Suspended
 ↓
Revoked
This is separate from the Guardian's existence.
Revoking portal access should not delete the guardian record.

25.25 Invitation
Conceptually:
Guardian
 ↓
Invitation
 ↓
Email / SMS
 ↓
Account Activation
 ↓
User
Communication handles actual delivery.
Identity handles authentication.
Portal handles the relationship/context.

25.26 Password / Authentication
The portal should use the central Identity system.
Do not create:
Parent Password System
separate from platform authentication.
Use:
Identity
 ↓
Authentication
 ↓
Guardian Membership
 ↓
Portal Authorization

25.27 Guardian Scope
The critical authorization check is:
Is this authenticated user authorized to access
this student within this school?
Only then should the requested domain data be returned.

25.28 Security Example
Request:
GET /students/STUDENT-123/attendance
The system should validate:
Authenticated?
AND
School context valid?
AND
Guardian relationship exists?
AND
Relationship permits attendance access?
AND
Attendance feature entitled?
AND
Student record accessible?
Only then:
ALLOW

25.29 Never Trust Student IDs
A guardian selecting:
student_id = 12345
does not establish authorization.
The server must derive or validate access from the authenticated guardian relationship.
This follows the platform-wide rule:
Client-supplied IDs are references, not authorization.

25.30 Requests / Self-Service
The portal may eventually allow requests such as:
Address Update Request
Guardian Information Update
Document Request
Transfer Request
Leave/Absence Notification
Fee Query
But there is an important boundary.
The portal owns:
Request Submission
The target domain owns:
Business Approval / Actual Data Change
For example:
Guardian
 ↓
Address Change Request
 ↓
Student Domain
 ↓
Review / Approval
 ↓
Student Profile Updated

25.31 Parent-Initiated Absence
A guardian may report:
"My child will be absent tomorrow."
This should not directly create an Attendance record.
Instead:
Guardian Absence Request
 ↓
Attendance / Leave Workflow
 ↓
School Review
 ↓
Attendance outcome
This avoids giving the portal authority over attendance truth.

25.32 Document Access
Guardians may need access to:
Report Card
Fee Receipt
Certificate
Student Documents
Files remain owned by the appropriate domain/common File Service.
The portal receives controlled access.
Files must remain:
Private
Tenant-scoped
Student-scoped
Permission-checked

25.33 Report Cards
Report cards are generated/owned by Examination or Reporting.
Portal provides:
View / Download
not:
Generate Report Card
unless the business workflow explicitly gives portal users that capability.

25.34 Portal Notifications
Notification flow:
Domain
 ↓
Event
 ↓
Communication
 ↓
Notification
 ↓
Portal In-App
This keeps portal UI separate from communication generation.

25.35 Portal Permissions
Guardian permissions should be explicit.
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
These permissions can be associated with the guardian portal role.

25.36 Portal vs School Admin
These are fundamentally different access models.
School Admin:
Tenant-wide administrative permissions
Guardian:
Relationship-scoped permissions
A guardian should never inherit School Admin permissions merely because they are associated with a student.

25.37 Portal Feature Entitlement
A school could potentially enable:
parent_portal
with sub-capabilities:
parent_portal.attendance
parent_portal.results
parent_portal.fees
parent_portal.transport
parent_portal.library
parent_portal.online_payment
Again, actual commercial packaging should remain in the entitlement layer.

25.38 Audit
Audit important portal actions:
Portal invitation
Portal activation
Portal access revoked
Guardian relationship access changed
Self-service request submitted
Sensitive document accessed
Online payment initiated
Read access to ordinary information does not necessarily require an audit record for every page view, but sensitive access policies can require it.

25.39 Events
Portal may emit:
GuardianPortalInvited
GuardianPortalActivated
GuardianPortalSuspended
GuardianPortalRevoked

PortalRequestCreated
PortalRequestCancelled
It may consume events such as:
ResultPublished
FeeDemandIssued
PaymentReceived
AnnouncementPublished
LibraryLoanOverdue
TransportChangePublished

25.40 Tenant Isolation
Guardian access is always:
User
 ↓
School Membership
 ↓
Guardian Relationship
 ↓
Student
A guardian associated with one school must not automatically gain access to a student with a similar ID in another school.
This is especially important because a person could potentially be associated with multiple schools.

25.41 Reporting
Portal-specific reports are limited.
The primary reporting domains remain:
Attendance → Attendance Reports
Examination → Result Reports
Fees → Financial Reports
Library → Library Reports
Portal analytics can later measure:
Portal Logins
Feature Usage
Notification Engagement
Payment Initiation
Request Volume
without becoming the owner of operational reporting.

25.42 Failure Scenarios
Domain unavailable
If Attendance is temporarily unavailable:
Portal
 ↓
Attendance unavailable
 ↓
Show controlled unavailable state
Do not display stale information as if it were current unless a clearly identified read model is being used.
Payment timeout
Payment initiated
 ↓
Provider timeout
 ↓
Payment = pending/unknown
The portal must not declare success merely because the user returned to the site.
Relationship revoked
Guardian relationship revoked
 ↓
Portal access immediately restricted

25.43 Caching
Portal dashboards may use cached/read-optimized data, but authorization must remain correct.
Never use:
cached student data
as proof that a guardian is authorized to access that student.
Authorization and data isolation remain authoritative.

25.44 Mobile App
A future mobile app should consume the same APIs:
Web Portal
      │
Mobile App
      │
      ↓
Portal/API Layer
      ↓
Domain Services
Do not create a separate mobile-specific business logic system.

25.45 Feature Structure
Initial:
Parent / Guardian Portal
├── Dashboard
├── Children
├── Attendance
├── Examinations & Results
├── Fees
├── Timetable
├── Library
├── Transportation
├── Notifications
└── Requests
Future:
├── Online Payments
├── Digital Documents
├── Messaging
├── Meeting Requests
└── Mobile Push

25.46 Final Portal Architecture
                    IDENTITY
                       │
                       ↓
                 GUARDIAN USER
                       │
                       ↓
                 SCHOOL MEMBERSHIP
                       │
                       ↓
                GUARDIAN RELATIONSHIP
                       │
                       ↓
                    STUDENT
                       │
       ┌───────────────┼────────────────┐
       ↓               ↓                ↓
 Attendance       Examination          Fees
       ↓               ↓                ↓
       └───────────────┼────────────────┘
                       ↓
                 PARENT PORTAL
                       │
       ┌───────────────┼───────────────┐
       ↓               ↓               ↓
   Timetable        Library       Transportation
                       │
                       ↓
                 Communication
The crucial architectural principle is that the Parent/Guardian Portal is an access layer and workflow boundary, not a duplicate school-management domain.

Updated Domain Map
We now have:
Platform
├── Identity / RBAC
├── Tenant Management
├── Plans / Billing / Entitlements
├── Audit
└── Platform Services

School Domains
├── Student
├── Academic
├── Teacher
├── Attendance
├── Examination
├── Fees
├── Transportation
├── Communication
├── Timetable
├── Library
├── Leave / Staff Operations
└── Parent / Guardian Portal
Next: Part 26 — User & Role Administration. This is particularly important because it ties together Identity, Memberships, RBAC, tenant administration, School Admin/Sub Admin management, and the permission model we've established throughout the architecture.
