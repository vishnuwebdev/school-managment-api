/**
 * Enum value lists shared by the database schema, validation and OpenAPI.
 * Changing a list requires a migration.
 */
export const TENANT_STATUS = [
  'REQUESTED',
  'UNDER_REVIEW',
  'APPROVED',
  'PROVISIONING',
  'ACTIVE',
  'SUSPENDED',
  'ARCHIVED',
] as const;
export type TenantStatus = (typeof TENANT_STATUS)[number];

export const SCHOOL_REQUEST_STATUS = ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'] as const;
export type SchoolRequestStatus = (typeof SCHOOL_REQUEST_STATUS)[number];

export const USER_STATUS = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export type UserStatus = (typeof USER_STATUS)[number];

export const ONE_TIME_TOKEN_STATUS = ['PENDING', 'SENT', 'USED', 'EXPIRED', 'REVOKED'] as const;
export type OneTimeTokenStatus = (typeof ONE_TIME_TOKEN_STATUS)[number];

export const MEMBERSHIP_KIND = ['PLATFORM', 'TENANT'] as const;
export type MembershipKind = (typeof MEMBERSHIP_KIND)[number];

export const MEMBERSHIP_STATUS = ['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUS)[number];

export const PERMISSION_SCOPE = ['PLATFORM', 'TENANT'] as const;
export type PermissionScope = (typeof PERMISSION_SCOPE)[number];

export const RECORD_STATUS = ['ACTIVE', 'ARCHIVED'] as const;
export type RecordStatus = (typeof RECORD_STATUS)[number];

export const ROLE_TYPE = ['SYSTEM', 'CUSTOM'] as const;
export type RoleType = (typeof ROLE_TYPE)[number];

export const SCOPE_TYPE = [
  'ALL_TENANTS', // platform: every school
  'SELECTED_TENANTS', // platform: scope_ref.tenant_ids
  'ALL_TENANT',
  'ASSIGNED_CLASS',
  'ASSIGNED_SECTION',
  'ASSIGNED_SUBJECT',
  'OWN_RECORD',
  'SELECTED_RESOURCE',
] as const;
export type ScopeType = (typeof SCOPE_TYPE)[number];

export const ASSIGNMENT_STATUS = ['ACTIVE', 'REVOKED'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUS)[number];

export const PLAN_VERSION_STATUS = ['DRAFT', 'ACTIVE', 'RETIRED'] as const;

export const SUBSCRIPTION_STATUS = [
  'PENDING',
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'EXPIRED',
  'CANCELLED',
  /** Replaced by a newer subscription (upgrade, downgrade, renewal). Not a cancellation. */
  'SUPERSEDED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[number];

export const BILLING_INTERVAL = ['MONTHLY', 'ANNUAL', 'CUSTOM'] as const;
export type BillingInterval = (typeof BILLING_INTERVAL)[number];

export const SUBSCRIPTION_ITEM_TYPE = ['PLAN', 'ADD_ON'] as const;
export const PRICING_SOURCE = ['CATALOG', 'CUSTOM_CONTRACT'] as const;

export const ENTITLEMENT_SOURCE = ['PLAN', 'ADD_ON', 'CUSTOM_CONTRACT', 'ADMIN_OVERRIDE'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCE)[number];

export const ENTITLEMENT_EFFECT = ['GRANT', 'DENY'] as const;
export type EntitlementEffect = (typeof ENTITLEMENT_EFFECT)[number];

export const ENTITLEMENT_STATUS = ['ACTIVE', 'REVOKED'] as const;

export const ACTOR_TYPE = ['USER', 'PLATFORM_USER', 'SYSTEM', 'ANONYMOUS'] as const;
export type ActorType = (typeof ACTOR_TYPE)[number];

export const OUTBOX_STATUS = ['PENDING', 'PUBLISHED', 'FAILED'] as const;

// ---- Academic structure ------------------------------------------------------
export const ACADEMIC_YEAR_STATUS = [
  'DRAFT',
  'UPCOMING',
  'ACTIVE',
  'COMPLETED',
  'ARCHIVED',
] as const;
export type AcademicYearStatus = (typeof ACADEMIC_YEAR_STATUS)[number];

export const CLASS_PHASE = ['EARLY_YEARS', 'PRIMARY', 'SECONDARY', 'SENIOR'] as const;
export type ClassPhase = (typeof CLASS_PHASE)[number];

export const CLASS_STATUS = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type ClassStatus = (typeof CLASS_STATUS)[number];

export const SECTION_STATUS = ['DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED'] as const;
export type SectionStatus = (typeof SECTION_STATUS)[number];

export const SUBJECT_TYPE = ['CORE', 'ELECTIVE', 'OPTIONAL', 'EXTRACURRICULAR', 'OTHER'] as const;
export type SubjectType = (typeof SUBJECT_TYPE)[number];

export const SUBJECT_STATUS = ['ACTIVE', 'ARCHIVED'] as const;
export const OFFERING_STATUS = ['ACTIVE', 'INACTIVE'] as const;

// ---- Students ----------------------------------------------------------------
export const STUDENT_STATUS = [
  'PROSPECTIVE',
  'ADMISSION_PENDING',
  'ADMITTED',
  'ACTIVE',
  'TRANSFERRED',
  'WITHDRAWN',
  'GRADUATED',
  'ARCHIVED',
] as const;
export type StudentStatus = (typeof STUDENT_STATUS)[number];

export const GENDER = ['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED'] as const;

export const ADMISSION_STATUS = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type AdmissionStatus = (typeof ADMISSION_STATUS)[number];

export const ENROLLMENT_STATUS = [
  'PENDING',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
  'TRANSFERRED',
  'WITHDRAWN',
] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUS)[number];
/** Statuses that occupy a seat and count as "the student's enrollment for the year". */
export const OPEN_ENROLLMENT_STATUSES: readonly EnrollmentStatus[] = ['PENDING', 'ACTIVE'];

export const ENROLLMENT_TYPE = [
  'NEW',
  'PROMOTION',
  'TRANSFER_IN',
  'REJOIN',
  'CHANGE',
  'OTHER',
] as const;

export const GUARDIAN_STATUS = ['ACTIVE', 'ARCHIVED'] as const;
export const GUARDIAN_RELATION = [
  'PARENT',
  'FATHER',
  'MOTHER',
  'GUARDIAN',
  'GRANDPARENT',
  'SIBLING',
  'OTHER',
] as const;
export const BLOOD_GROUP = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export const ADMISSION_TYPE = ['NEW', 'TRANSFER_IN', 'RE_ADMISSION'] as const;
export const ADMISSION_NUMBER_MODE = ['AUTO', 'MANUAL'] as const;
export const GUARDIAN_CHANNEL = ['EMAIL', 'SMS', 'WHATSAPP', 'PHONE'] as const;
export const GUARDIAN_LINK_STATUS = ['ACTIVE', 'ENDED'] as const;

// ---- Teachers & staff --------------------------------------------------------
export const STAFF_TYPE = ['TEACHING', 'NON_TEACHING'] as const;
export type StaffType = (typeof STAFF_TYPE)[number];

export const TEACHER_STATUS = [
  'PROSPECTIVE',
  'ONBOARDING',
  'ACTIVE',
  'ON_LEAVE',
  'INACTIVE',
  'RESIGNED',
  'TERMINATED',
  'RETIRED',
  'ARCHIVED',
] as const;
export type TeacherStatus = (typeof TEACHER_STATUS)[number];
/** Statuses in which the person has left (or been put out of) day-to-day service. */
export const TEACHER_LEAVING_STATUSES: readonly TeacherStatus[] = [
  'INACTIVE',
  'RESIGNED',
  'TERMINATED',
  'RETIRED',
  'ARCHIVED',
];

export const EMPLOYMENT_TYPE = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'VISITING'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPE)[number];

export const QUALIFICATION_TYPE = [
  'DEGREE',
  'DIPLOMA',
  'CERTIFICATION',
  'LICENSE',
  'OTHER',
] as const;
export const QUALIFICATION_STATUS = ['ACTIVE', 'REMOVED'] as const;

export const ASSIGNMENT_ROLE = ['PRIMARY', 'CO_TEACHER', 'SUBSTITUTE'] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLE)[number];
export const TEACHING_ASSIGNMENT_STATUS = ['ACTIVE', 'ENDED', 'CANCELLED'] as const;
export type TeachingAssignmentStatus = (typeof TEACHING_ASSIGNMENT_STATUS)[number];

// ---- Attendance ----------------------------------------------------------------
export const ATTENDANCE_TYPE = ['DAILY', 'SUBJECT'] as const;
export type AttendanceType = (typeof ATTENDANCE_TYPE)[number];

/** DRAFT → SUBMITTED → FINAL (approval optional per school); reject/reopen return to DRAFT. */
export const ATTENDANCE_SESSION_STATUS = ['DRAFT', 'SUBMITTED', 'FINAL'] as const;
export type AttendanceSessionStatus = (typeof ATTENDANCE_SESSION_STATUS)[number];

export const ATTENDANCE_STATUS_CATEGORY = [
  'PRESENT',
  'ABSENT',
  'LATE',
  'HALF_DAY',
  'EXCUSED',
  'LEAVE',
  'OTHER',
] as const;
export type AttendanceStatusCategory = (typeof ATTENDANCE_STATUS_CATEGORY)[number];

export const ATTENDANCE_STATUS_STATE = ['ACTIVE', 'INACTIVE'] as const;

export const ATTENDANCE_CORRECTION_STATUS = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'AUTO_APPLIED',
] as const;
export type AttendanceCorrectionStatus = (typeof ATTENDANCE_CORRECTION_STATUS)[number];

// ---- Timetable -----------------------------------------------------------------
/** Kind of a period in the school day. Only LESSON periods take timetable entries. */
export const PERIOD_KIND = ['LESSON', 'BREAK', 'LUNCH', 'ASSEMBLY', 'CUSTOM'] as const;
export type PeriodKind = (typeof PERIOD_KIND)[number];
export const PERIOD_STATUS = ['ACTIVE', 'INACTIVE'] as const;

export const VENUE_TYPE = ['CLASSROOM', 'LAB', 'HALL', 'OTHER'] as const;
export type VenueType = (typeof VENUE_TYPE)[number];
export const VENUE_STATUS = ['ACTIVE', 'INACTIVE'] as const;

/** DRAFT (editable) → PUBLISHED (read-only, one per academic year) → ARCHIVED (history). */
export const TIMETABLE_STATUS = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type TimetableStatus = (typeof TIMETABLE_STATUS)[number];

/** CANCELLED is reserved for date-specific overrides (deferred); V1 never sets it. */
export const TIMETABLE_ENTRY_STATUS = ['ACTIVE', 'CANCELLED'] as const;

// ---- School fees (mirrors drizzle/0006_fees.sql) ----------------------------------------------
export const FEE_CATEGORY_STATUS = ['ACTIVE', 'INACTIVE'] as const;
export type FeeCategoryStatus = (typeof FEE_CATEGORY_STATUS)[number];

export const FEE_FREQUENCY = [
  'ONE_TIME',
  'MONTHLY',
  'QUARTERLY',
  'HALF_YEARLY',
  'ANNUAL',
  'CUSTOM',
] as const;
export type FeeFrequency = (typeof FEE_FREQUENCY)[number];

export const FEE_STRUCTURE_STATUS = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type FeeStructureStatus = (typeof FEE_STRUCTURE_STATUS)[number];

export const FEE_ASSIGNMENT_STATUS = ['ACTIVE', 'CANCELLED'] as const;
export type FeeAssignmentStatus = (typeof FEE_ASSIGNMENT_STATUS)[number];

export const FEE_DEMAND_STATUS = [
  'DRAFT',
  'ISSUED',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'CANCELLED',
  'WRITTEN_OFF',
  'WAIVED',
] as const;
export type FeeDemandStatus = (typeof FEE_DEMAND_STATUS)[number];

export const LATE_FEE_TYPE = ['FIXED', 'PERCENT', 'PER_DAY'] as const;
export type LateFeeType = (typeof LATE_FEE_TYPE)[number];

export const FEE_ADJUSTMENT_TYPE = ['CONCESSION', 'WAIVER'] as const;
export type FeeAdjustmentType = (typeof FEE_ADJUSTMENT_TYPE)[number];

export const FEE_ADJUSTMENT_VALUE_TYPE = ['AMOUNT', 'PERCENT'] as const;
export type FeeAdjustmentValueType = (typeof FEE_ADJUSTMENT_VALUE_TYPE)[number];

export const FEE_ADJUSTMENT_STATUS = [
  'REQUESTED',
  'APPROVED',
  'APPLIED',
  'REJECTED',
  'CANCELLED',
] as const;
export type FeeAdjustmentStatus = (typeof FEE_ADJUSTMENT_STATUS)[number];

export const PAYER_TYPE = ['STUDENT', 'GUARDIAN', 'OTHER'] as const;
export type PayerType = (typeof PAYER_TYPE)[number];

export const PAYMENT_METHOD = [
  'CASH',
  'BANK_TRANSFER',
  'CHEQUE',
  'CARD',
  'UPI',
  'ONLINE_GATEWAY',
  'OTHER',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHOD)[number];

/**
 * What a payment can be recorded as. Payments are made outside the portal (no gateway, no card
 * data), so UPI and ONLINE_GATEWAY are never accepted for new payments; they stay in the enum only
 * so rows recorded earlier still read back.
 */
export const RECORDABLE_PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'CHEQUE',
  'CARD',
  'OTHER',
] as const;

export const PAYMENT_STATUS = [
  'PENDING',
  'RECEIVED',
  'VERIFIED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[number];

export const ALLOCATION_STATUS = ['ACTIVE', 'PARTIALLY_REVERSED', 'REVERSED'] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUS)[number];

export const RECEIPT_STATUS = ['ISSUED', 'VOID'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUS)[number];

export const REFUND_STATUS = [
  'REQUESTED',
  'APPROVED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type RefundStatus = (typeof REFUND_STATUS)[number];

/** Payments that hold money which can still be allocated to demands or refunded. */
export const ALLOCATABLE_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'RECEIVED',
  'VERIFIED',
  'PARTIALLY_REFUNDED',
];

/** Refunds that still reserve money on their payment (not yet completed or closed). */
export const OPEN_REFUND_STATUSES: readonly RefundStatus[] = [
  'REQUESTED',
  'APPROVED',
  'PROCESSING',
];

export const INVOICE_STATUS = ['OPEN', 'PAID', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[number];

export const BILLING_PAYMENT_METHOD = [
  'CASH',
  'BANK_TRANSFER',
  'CHEQUE',
  'CARD',
  'MOBILE_MONEY',
  'OTHER',
] as const;
export type BillingPaymentMethod = (typeof BILLING_PAYMENT_METHOD)[number];

export const BILLING_PAYMENT_STATUS = ['RECEIVED', 'REVERSED'] as const;

// ---- Examinations ------------------------------------------------------------
export const EXAM_TYPE = ['UNIT_TEST', 'MID_TERM', 'FINAL', 'PRACTICAL', 'OTHER'] as const;
export type ExamType = (typeof EXAM_TYPE)[number];

/** DRAFT = being set up and marked; PUBLISHED = results are final and marks are locked. */
export const EXAM_STATUS = ['DRAFT', 'PUBLISHED'] as const;
export type ExamStatus = (typeof EXAM_STATUS)[number];
