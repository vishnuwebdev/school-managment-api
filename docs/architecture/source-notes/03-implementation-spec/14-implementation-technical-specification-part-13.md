<!-- Source: Apple Notes, folder 'Technical Design System' -->
# Implementation Technical Specification — Part 13

Document & File Management
Document Management should be implemented as a shared platform service rather than allowing Student, Teacher, Fees, Admissions and other modules to manage files independently.
The central principle is:
Business Domain
     ↓
File Metadata / Ownership
     ↓
File Service
     ↓
Private Object Storage
The database stores metadata and references. The actual file content belongs in object storage.

509. Domain Boundary
File Management owns:
file metadata
object-storage references
uploads
downloads
file versions
document types
ownership
access authorization
expiry tracking
retention
quarantine/status
deletion/archive lifecycle
It does not own:
student identity
teacher identity
admission records
qualification records
invoices
leave applications
Those domains reference files.

510. File vs Document
These concepts should remain separate.
File
The physical digital object.
Examples:
PDF
JPG
PNG
DOCX
Document
The business meaning attached to one or more files.
Example:
Student
 ↓
Birth Certificate
 ↓
File version 1
File version 2
This allows one business document to have multiple versions.

511. File Record
files
-----
id
tenant_id
storage_provider
storage_bucket
storage_key
original_filename
mime_type
file_size
checksum
status
uploaded_by
created_at
updated_at
Status:
UPLOADING
AVAILABLE
QUARANTINED
FAILED
ARCHIVED
DELETED

512. Storage Separation
Do not store file binaries in MySQL.
Use:
MySQL
  └── metadata

Object Storage
  └── actual file
This keeps database backups manageable and allows future storage-provider changes.

513. Tenant-Scoped Storage Keys
Storage keys should contain tenant isolation.
Example:
tenants/{tenant_id}/documents/{file_id}
Never expose raw storage keys to clients.

514. File IDs
Use opaque IDs such as UUIDv7-style identifiers.
Do not expose:
tenant_id
+
original filename
as the security boundary.
Authorization always occurs before file access.

515. Document Types
document_types
--------------
id
tenant_id
code
name
description
entity_type
requires_expiry
requires_document_number
status
created_at
updated_at
Examples:
BIRTH_CERTIFICATE
IDENTITY_DOCUMENT
TRANSFER_CERTIFICATE
QUALIFICATION_CERTIFICATE
EMPLOYMENT_DOCUMENT
MEDICAL_CERTIFICATE
ADDRESS_PROOF
OTHER

516. Document Metadata
Business domains can own their document metadata while File Service owns the actual file.
For example:
student_documents
-----------------
id
tenant_id
student_id
document_type_id
document_number
issue_date
expiry_date
status
created_at
updated_at
version
The table references:
file_id
through the document/file relationship.

517. Generic File Relationship
For shared infrastructure, support:
file_links
----------
id
tenant_id
file_id
entity_type
entity_id
relationship_type
created_at
Example:
STUDENT
student_123
BIRTH_CERTIFICATE
However, this generic relation must not replace domain-specific metadata tables when metadata matters.

518. Domain Ownership
Recommended:
Student
 → student_documents

Teacher
 → teacher_documents

Leave
 → leave_application_documents

Fee
 → fee_invoice_documents

Tenant
 → tenant_documents
File Service remains responsible for the actual file.

519. Upload Flow
Do not send large files through the application server unnecessarily.
Recommended:
Client
 ↓
Request Upload
 ↓
File Service validates metadata
 ↓
Generate short-lived upload URL
 ↓
Client uploads directly to object storage
 ↓
Storage confirmation
 ↓
File marked AVAILABLE

520. Upload Authorization
Before issuing an upload URL:
Authenticated
AND
Tenant Access
AND
Feature Access
AND
Permission
AND
Entity Access
must all succeed.
A valid upload URL does not replace application authorization.

521. Upload Validation
Validate:
tenant
user permission
file size
MIME type
extension
target entity
document type
upload purpose
Do not trust client-supplied MIME type alone.

522. File Size Limits
Configure limits at multiple levels:
platform maximum
tenant maximum
document-type maximum
For example, a normal identity document may have a lower maximum than a school-generated report.
Actual limits should be configuration, not hardcoded domain logic.

523. File Type Validation
Validate using:
declared MIME type
filename extension
file signature/magic bytes where appropriate
Do not rely only on .pdf, .jpg, etc.

524. Malware Scanning
Where supported, uploaded files should pass through:
Uploaded
 ↓
Quarantine
 ↓
Malware Scan
 ↓
AVAILABLE
or:
QUARANTINED
if scanning fails.
The application must not expose quarantined files to normal users.

525. File Checksum
Store a checksum:
checksum_algorithm
checksum
For example:

This supports:
integrity validation
duplicate detection
storage verification
Checksum equality should not automatically mean business-document equality.

526. Duplicate Uploads
V1:
detect potential duplicate
warn user
allow explicit upload if permitted
Do not automatically replace an existing business document.

527. Document Versions
document
  ↓
version 1
  ↓
version 2
  ↓
version 3
Use:
document_versions
-----------------
id
tenant_id
document_id
file_id
version_number
status
uploaded_by
created_at
Status:
DRAFT
CURRENT
SUPERSEDED
REJECTED
ARCHIVED

528. Current Version
Only one version should normally be CURRENT.
Enforce this through application transaction logic plus appropriate database constraints.
Changing the current version must be audited.

529. Secure Download
Do not expose permanent object-storage URLs.
Flow:
GET /files/:id/download
        ↓
Authorize
        ↓
Generate short-lived signed URL
        ↓
Client downloads
Signed URL lifetime should be short and configurable.

530. File Access Rules
Access should be determined by:
User
 ↓
Tenant
 ↓
Permission
 ↓
Business Entity
 ↓
Document
A user who knows a file ID must not automatically be able to download it.

531. Student Document Access
For example:
Student Document
may be accessible to:
authorized school administrators
authorized staff
specific student/guardian portal users where permitted
depending on document type.
Sensitive documents should support narrower permissions.

532. Teacher Document Access
Teacher documents should normally be restricted to authorized administrators/HR-like roles.
A teacher should not automatically be able to access another teacher's employment documents.

533. File Permissions
Initial permissions:
file.view
file.upload
file.download
file.replace
file.archive
file.delete
file.manage_types

document.view
document.create
document.update
document.replace
document.archive
document.export
Actual authorization also requires entity-level scope.

534. Soft Delete
Files should generally not be physically deleted immediately.
AVAILABLE
 ↓
ARCHIVED
 ↓
RETENTION PERIOD
 ↓
PURGE
Physical deletion should be performed only by controlled retention/purge workflows.

535. Document Deletion
A business document may be removed from active use without immediately destroying the underlying file.
Example:
Student Document
 ↓
ARCHIVED
The file remains retained according to policy.

536. Legal/Retention Controls
Retention should be configurable by:
document type
tenant
data category
Examples:
student records
employment records
financial documents
may have different retention periods.
Do not hardcode one global retention duration.

537. Expiry Tracking
Some documents expire.
Store:
issue_date
expiry_date
The File/Document service can generate events for upcoming expiry.
Example:
Document expires in 30 days
 ↓
DocumentExpiryUpcoming
 ↓
Notification

538. Expired Documents
Expiry does not automatically mean deletion.
CURRENT
 ↓
EXPIRED
The business domain can decide whether the document remains valid for historical purposes.

539. Document Status
Domain-specific document status should remain separate from physical file status.
Example:
File:
AVAILABLE

Student Document:
EXPIRED
This separation is important.

540. File Metadata Security
Do not expose internal metadata unnecessarily:
storage bucket
storage key
checksum
provider internals
security scan details
API responses should expose only what clients need.

541. File APIs
Upload:
POST /api/v1/files/upload-request
POST /api/v1/files/:id/complete
Download:
GET /api/v1/files/:id/download
Metadata:
GET /api/v1/files/:id
PATCH /api/v1/files/:id
Versions:
GET /api/v1/documents/:id/versions
POST /api/v1/documents/:id/versions
Document types:
GET /api/v1/document-types
POST /api/v1/document-types

542. File Application Services
RequestFileUpload
CompleteFileUpload
ValidateUploadedFile
ScanFile

CreateDocument
AddDocumentVersion
ReplaceDocumentVersion
ArchiveDocument

AuthorizeFileAccess
GenerateDownloadUrl

ProcessDocumentExpiry
PurgeExpiredFiles

543. File Events
FileUploadRequested
FileUploaded
FileScanCompleted
FileQuarantined
FileAvailable

DocumentCreated
DocumentVersionAdded
DocumentVersionReplaced
DocumentArchived
DocumentExpired
DocumentPurged

544. File Jobs
Background jobs include:
VirusScanJob
FileMetadataExtractionJob
DocumentExpiryJob
RetentionPurgeJob
BulkExportJob
All jobs carry:
tenant_id
actor/context
correlation_id
job_id

545. File Concurrency
Version updates use optimistic locking.
Example:
Version = 4

User A edits
User B edits

Only one update succeeds against version 4.
The other receives:
CONFLICT
and must reload.

546. File Export
Bulk document exports are particularly sensitive.
Flow:
Export Request
 ↓
Authorization
 ↓
Validate Scope
 ↓
Background Job
 ↓
Generate Archive
 ↓
Store Private File
 ↓
Short-lived Download
Every export should be audited.

547. Export Safety
Do not allow:
tenant-wide "download all documents"
unless the role explicitly has that permission.
Exports should require a defined scope.
Examples:
selected students
selected document type
selected academic year

548. File Access Audit
Audit:
upload
download
replacement
archive
deletion/purge
export
permission-sensitive access
document version changes
For especially sensitive document categories, download events should be retained.

549. Storage Failure Handling
If object storage succeeds but database completion fails:
File exists
DB says UPLOADING
A reconciliation job should detect and recover/clean up orphaned objects.
Conversely:
DB says AVAILABLE
Object missing
should become an observable integrity error, not a silent 404.

550. Object Storage Lifecycle
Use storage lifecycle policies where available:
ACTIVE
 ↓
ARCHIVE STORAGE
 ↓
PURGE
But business retention rules remain authoritative.

551. File Database Indexes
files:
  tenant_id, status
  tenant_id, checksum
  tenant_id, created_at

file_links:
  tenant_id, entity_type, entity_id
  tenant_id, file_id

document_types:
  tenant_id, code UNIQUE

document_versions:
  tenant_id, document_id, version_number UNIQUE

552. Tenant Isolation
Every file operation must enforce:
tenant_id
at the application and repository layers.
A file ID alone never establishes ownership.

553. Cross-Tenant Storage Safety
Even if two tenants have the same filename:
student/photo.jpg
their storage keys must differ.
Use opaque tenant-scoped paths:
tenants/{tenant_id}/files/{file_id}
Never derive authorization from filenames.

554. File Service Contract
File Management
│
├── File Metadata
├── Document Types
├── Documents
├── Versions
├── Uploads
├── Downloads
├── Access Control
├── Expiry
├── Retention
└── Storage Integration
Core lifecycle:
Request Upload
 ↓
Upload
 ↓
Scan
 ↓
Available
 ↓
Business Document
 ↓
Version / Replace
 ↓
Archive
 ↓
Retention
 ↓
Purge
The key architectural rule is:
Business modules own the meaning of documents; the File Service owns secure storage, file lifecycle and access mechanics.

Next Domain
The next implementation specification will cover Library Management, including books, copies, categories, authors, members, issue/return, renewals, reservations, fines, lost/damaged books and library reporting.
