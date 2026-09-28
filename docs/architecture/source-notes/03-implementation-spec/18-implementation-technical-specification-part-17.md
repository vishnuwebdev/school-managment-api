<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 17

Human Resources & Staff Administration
HR/Staff Administration should own the employment relationship and staff lifecycle, while Teacher Management remains responsible for teacher-specific academic capabilities.
The boundary is:
Person / User
      ↓
Staff Employment
      ↓
Department / Position
      ↓
Employment Lifecycle
      ↓
Teacher Capability (if applicable)
      ↓
Leave / Timetable / Other Domains
A teacher is therefore not a second employment record.

711. Domain Boundary
HR/Staff Administration owns:
staff employment records
departments
positions
employment types
contracts
employment history
onboarding
offboarding
staff documents
organizational structure
HR status
reporting relationships
emergency/contact information where HR-owned
It does not own:
authentication
user accounts
teacher academic assignments
leave transactions
payroll calculations
attendance
student records

712. Staff vs User vs Teacher
These remain distinct concepts.
User
 ↓
Authentication / platform access

Staff
 ↓
Employment relationship

Teacher
 ↓
Academic teaching capability
A staff member may have:
User
Staff
Teacher
but these are not interchangeable.
A non-teaching employee may have:
User
Staff
without a Teacher record.

713. Staff Record
staff
-----
id
tenant_id
user_id
staff_number
employee_number
first_name
middle_name
last_name
preferred_name
date_of_birth
gender
personal_email
personal_phone
work_email
work_phone
join_date
employment_status
department_id
position_id
manager_staff_id
photo_file_id
created_at
updated_at
version
user_id is nullable because employment can exist before application access is provisioned.

714. Employment Status
PROSPECTIVE
ONBOARDING
ACTIVE
SUSPENDED
ON_LEAVE
RESIGNED
TERMINATED
RETIRED
ARCHIVED
ON_LEAVE should normally be derived/integrated from Leave rather than treated as the authoritative leave transaction.
For example, an employee can remain ACTIVE while currently having approved leave.
Therefore avoid making employment status mirror every temporary absence.

715. Staff Number
tenant_id + staff_number
must be unique.
Do not rely on global uniqueness.

716. Employee Number
Some schools may use an employee number separate from staff number.
If used:
tenant_id + employee_number
must be unique.
This allows migration from existing HR systems without forcing one numbering scheme.

717. Departments
departments
-----------
id
tenant_id
code
name
parent_department_id
manager_staff_id
status
created_at
updated_at
version
Examples:
Administration
Academic
Finance
Transport
Library
IT
Operations
Support shallow hierarchy initially.

718. Positions
positions
---------
id
tenant_id
code
title
description
department_id
status
created_at
updated_at
version
Examples:
Principal
Teacher
Accountant
Librarian
Driver
Receptionist
IT Administrator
A position is an organizational definition, not an employee's current employment record.

719. Employment Types
employment_types
----------------
id
tenant_id
code
name
status
created_at
updated_at
Examples:
FULL_TIME
PART_TIME
CONTRACT
TEMPORARY
INTERN
CONSULTANT

720. Employment Record
A staff member may have multiple employment periods over time.
employment_records
------------------
id
tenant_id
staff_id
employment_type_id
department_id
position_id
manager_staff_id
start_date
end_date
status
contract_id
created_at
updated_at
version
This preserves employment history.

721. Why Employment History Is Separate
Consider:
Teacher
2024–2026 → Academic Department

2026–2028 → Administration
Do not overwrite the original department/position.
Create a new effective employment record.

722. Employment Contract
employment_contracts
--------------------
id
tenant_id
staff_id
contract_number
contract_type
start_date
end_date
status
signed_date
document_file_id
created_at
updated_at
version
Status:
DRAFT
PENDING_SIGNATURE
ACTIVE
EXPIRED
TERMINATED
CANCELLED

723. Contract Types
Configurable examples:
PERMANENT
FIXED_TERM
PROBATION
CONSULTANCY
TEMPORARY

724. Probation
Probation should be represented as employment metadata rather than creating a separate employee lifecycle.
probation_start_date
probation_end_date
probation_status
Status:
NOT_APPLICABLE
IN_PROGRESS
COMPLETED
EXTENDED
FAILED

725. Staff Lifecycle
PROSPECTIVE
    ↓
ONBOARDING
    ↓
ACTIVE
    ↓
RESIGNED / TERMINATED / RETIRED
    ↓
ARCHIVED
Suspension is a separate controlled state.

726. Onboarding
staff_onboarding
----------------
id
tenant_id
staff_id
status
start_date
completed_at
created_at
updated_at
Status:
NOT_STARTED
IN_PROGRESS
COMPLETED
CANCELLED

727. Onboarding Tasks
staff_onboarding_tasks
----------------------
id
tenant_id
onboarding_id
task_code
name
status
assigned_to
due_date
completed_at
created_at
updated_at
Examples:
DOCUMENT_VERIFICATION
CONTRACT_SIGNING
USER_ACCOUNT
ID_CARD
ORIENTATION
SYSTEM_ACCESS
This is intentionally lightweight; V1 does not need a generic workflow engine.

728. Offboarding
staff_offboarding
-----------------
id
tenant_id
staff_id
reason
last_working_date
status
created_at
updated_at
Status:
INITIATED
IN_PROGRESS
COMPLETED
CANCELLED

729. Offboarding Tasks
Examples:
Asset Return
Access Revocation
Document Completion
Knowledge Transfer
Final Clearance
Each can be tracked through an explicit task.

730. Offboarding Integration
Completing offboarding may trigger:
HR
 ↓
Staff status changed
 ↓
Teacher capability ended
 ↓
Membership suspended/revoked
 ↓
Assets returned
 ↓
Leave closed/settled
 ↓
Timetable assignments ended
Do not perform all of these as one enormous cross-domain database transaction.
Use domain interfaces plus events/orchestration.

731. Teacher Integration
Teacher Management references:
staff_id
where appropriate.
Teacher remains responsible for:
teaching qualifications
teaching assignments
academic teaching status
HR remains responsible for:
employment
contract
department
position
employment lifecycle

732. Staff Documents
HR-specific documents use the shared File Service.
staff_documents
---------------
id
tenant_id
staff_id
document_type
document_number
issue_date
expiry_date
file_id
status
created_at
updated_at
version
Examples:
Employment Contract
Identity Document
Qualification
Address Proof
Background Verification
Other
The file itself remains in File Management.

733. Document Expiry
HR documents can integrate with the File Service expiry mechanism.
Example:
License expires
 ↓
DocumentExpiryUpcoming
 ↓
HR notification
HR remains responsible for the business meaning of the document.

734. Staff Emergency Contacts
staff_emergency_contacts
------------------------
id
tenant_id
staff_id
name
relationship
phone
email
address
is_primary
created_at
updated_at
Sensitive information should have restricted permissions.

735. Staff Addresses
If HR requires a dedicated address:
staff_addresses
---------------
id
tenant_id
staff_id
address_type
line_1
line_2
city
state
postal_code
country
is_primary
effective_from
effective_until
created_at
updated_at
Do not duplicate this into the User identity table.

736. Reporting Relationships
manager_staff_id supports:
Principal
 ↓
Academic Head
 ↓
Teacher
Avoid building a complex organization graph V1.
A simple parent relationship is sufficient.

737. Organizational Structure
Department + position + manager provide the initial structure:
Department
   ↓
Position
   ↓
Staff
   ↓
Manager
Future organizational units can be added without changing employment records.

738. HR Permissions
Initial permissions:
staff.view
staff.create
staff.update
staff.archive

employment.view
employment.manage

department.view
department.manage

position.view
position.manage

contract.view
contract.create
contract.update
contract.terminate

onboarding.view
onboarding.manage

offboarding.view
offboarding.manage

staff_document.view
staff_document.manage

staff_sensitive.view
staff_sensitive.manage

hr_report.view
hr_export

739. Sensitive HR Data
Restrict access to:
personal contact information
emergency contacts
employment contracts
identity documents
compensation-related metadata if later introduced
termination records
Do not expose sensitive HR information merely because a user has staff.view.
Use separate permissions/scopes.

740. Staff APIs
Staff:
/api/v1/staff
/api/v1/staff/:id
Employment:
/api/v1/staff/:id/employment
/api/v1/employment-records
Departments:
/api/v1/departments
/api/v1/departments/:id
Positions:
/api/v1/positions
/api/v1/positions/:id
Contracts:
/api/v1/staff/:id/contracts
/api/v1/contracts/:id
Onboarding:
/api/v1/staff/:id/onboarding
Offboarding:
/api/v1/staff/:id/offboarding

741. HR Application Services
CreateStaff
UpdateStaff
ActivateStaff
SuspendStaff
ArchiveStaff

CreateDepartment
CreatePosition

CreateEmploymentRecord
EndEmployment
TransferDepartment
ChangePosition

CreateContract
RenewContract
TerminateContract

StartOnboarding
CompleteOnboardingTask
CompleteOnboarding

StartOffboarding
CompleteOffboardingTask
CompleteOffboarding

742. Staff Lifecycle Rules
Activation
Requires:
valid staff record
+
valid employment record
+
required onboarding conditions
Termination
Should:
stop new operational assignments
end applicable employment record
trigger Teacher integration where applicable
revoke/suspend access according to policy
preserve historical records

743. HR Events
StaffCreated
StaffUpdated
StaffActivated
StaffSuspended
StaffArchived

EmploymentStarted
EmploymentEnded
DepartmentChanged
PositionChanged

ContractCreated
ContractRenewed
ContractExpired
ContractTerminated

OnboardingStarted
OnboardingCompleted

OffboardingStarted
OffboardingCompleted

744. Teacher Termination Integration
When employment ends:
EmploymentEnded
 ↓
Teacher Management
 ↓
End active teaching assignments
 ↓
Prevent new assignments
Teacher historical records remain intact.
This is an asynchronous cross-domain reaction, with synchronous validation where immediate authorization is required.

745. Identity Integration
HR should not create authentication credentials directly.
If staff requires portal access:
HR
 ↓
Identity/Application Interface
 ↓
User invitation/account
 ↓
Membership
Authentication remains owned by Identity.

746. Access Revocation
Offboarding should eventually result in:
membership suspended/revoked
+
active sessions invalidated
This should be executed through the Identity service.
HR should not directly modify authentication tables.

747. Leave Integration
Leave owns:
leave application
leave balance
approval
HR owns:
employment eligibility
policy assignment context
Example:
Employment Type
 ↓
Leave Policy Assignment
Leave then handles actual leave transactions.

748. Asset Integration
Staff may have assigned assets.
HR/Offboarding can request an asset clearance:
Offboarding
 ↓
Asset return task
 ↓
Asset Management
 ↓
Returned
Asset Management remains authoritative for the asset.

749. Payroll Boundary
Payroll should not be embedded into HR V1.
HR may provide:
employee identity
employment type
position
department
effective employment dates
A future Payroll module can consume these.
This prevents compensation calculations from becoming entangled with employment administration.

750. HR Database Indexes
staff:
  tenant_id, staff_number UNIQUE
  tenant_id, employee_number UNIQUE
  tenant_id, user_id

departments:
  tenant_id, code UNIQUE

positions:
  tenant_id, code UNIQUE

employment_records:
  tenant_id, staff_id, start_date
  tenant_id, department_id
  tenant_id, position_id

employment_contracts:
  tenant_id, staff_id
  tenant_id, contract_number UNIQUE

staff_documents:
  tenant_id, staff_id, document_type

staff_emergency_contacts:
  tenant_id, staff_id

staff_onboarding:
  tenant_id, staff_id

staff_offboarding:
  tenant_id, staff_id

751. Employment Concurrency
Changes to employment status/records should use optimistic locking.
Example:
Employment Version = 4

HR Admin A → transfer
HR Admin B → terminate

Only one operation can commit against version 4.
The second receives a conflict and must reload.

752. Effective-Dated Employment
Department/position changes should be effective-dated.
Example:
01-Jan → Academic / Teacher
01-Jul → Administration / Coordinator
Historical reports should resolve the employment record applicable on the requested date.

753. HR Reporting
Initial reports:
Staff Directory
Active Staff
Department-wise Staff
Position-wise Staff
Employment Expiry
Contract Expiry
Onboarding Status
Offboarding Status
Staff Document Expiry
Staff History
Sensitive reports require explicit permissions.

754. Staff Directory
Normal directory fields:
name
staff number
department
position
work contact
status
Sensitive HR data should not be included in the ordinary directory.

755. HR Audit
Audit:
staff creation/modification
employment changes
department transfers
position changes
contract changes
onboarding completion
offboarding
sensitive document access
sensitive-data changes
manual status overrides
Termination and contract operations should always include actor and reason where applicable.

756. HR Module Contract
Human Resources
│
├── Staff
├── Departments
├── Positions
├── Employment Types
├── Employment Records
├── Contracts
├── Onboarding
├── Offboarding
├── Staff Documents
├── Emergency Contacts
└── Organizational Structure
Core lifecycle:
Prospective
 ↓
Onboarding
 ↓
Active Employment
 ↓
Transfer / Contract Change
 ↓
Resignation / Termination / Retirement
 ↓
Archived
The key architectural rule is:
HR owns the employment relationship; Teacher Management owns academic teaching capability; Identity owns authentication and access.

Next Domain
The next specification will cover Payroll & Salary Management only if payroll is part of the intended school product scope. Otherwise, the next core operational domain will be School Calendar & Events, covering academic calendars, holidays, school events, event participants and calendar publishing.
