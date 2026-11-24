/**
 * Enum value lists shared by the database schema, validation and OpenAPI.
 * Changing a list requires a migration.
 */
export const TENANT_STATUS = [
    "REQUESTED",
    "UNDER_REVIEW",
    "APPROVED",
    "PROVISIONING",
    "ACTIVE",
    "SUSPENDED",
    "ARCHIVED",
];
export const SCHOOL_REQUEST_STATUS = [
    "PENDING",
    "UNDER_REVIEW",
    "APPROVED",
    "REJECTED",
];
export const USER_STATUS = [
    "INVITED",
    "ACTIVE",
    "SUSPENDED",
    "DEACTIVATED",
];
export const ONE_TIME_TOKEN_STATUS = [
    "PENDING",
    "SENT",
    "USED",
    "EXPIRED",
    "REVOKED",
];
export const MEMBERSHIP_KIND = ["PLATFORM", "TENANT"];
export const MEMBERSHIP_STATUS = [
    "INVITED",
    "ACTIVE",
    "SUSPENDED",
    "REVOKED",
];
export const PERMISSION_SCOPE = ["PLATFORM", "TENANT"];
export const RECORD_STATUS = ["ACTIVE", "ARCHIVED"];
export const ROLE_TYPE = ["SYSTEM", "CUSTOM"];
export const SCOPE_TYPE = [
    "ALL_TENANTS", // platform: every school
    "SELECTED_TENANTS", // platform: scope_ref.tenant_ids
    "ALL_TENANT",
    "ASSIGNED_CLASS",
    "ASSIGNED_SECTION",
    "ASSIGNED_SUBJECT",
    "OWN_RECORD",
    "SELECTED_RESOURCE",
];
export const ASSIGNMENT_STATUS = ["ACTIVE", "REVOKED"];
export const PLAN_VERSION_STATUS = ["DRAFT", "ACTIVE", "RETIRED"];
export const SUBSCRIPTION_STATUS = [
    "PENDING",
    "TRIAL",
    "ACTIVE",
    "PAST_DUE",
    "EXPIRED",
    "CANCELLED",
    /** Replaced by a newer subscription (upgrade, downgrade, renewal). Not a cancellation. */
    "SUPERSEDED",
];
export const BILLING_INTERVAL = ["MONTHLY", "ANNUAL", "CUSTOM"];
export const SUBSCRIPTION_ITEM_TYPE = ["PLAN", "ADD_ON"];
export const PRICING_SOURCE = ["CATALOG", "CUSTOM_CONTRACT"];
export const ENTITLEMENT_SOURCE = [
    "PLAN",
    "ADD_ON",
    "CUSTOM_CONTRACT",
    "ADMIN_OVERRIDE",
];
export const ENTITLEMENT_EFFECT = ["GRANT", "DENY"];
export const ENTITLEMENT_STATUS = ["ACTIVE", "REVOKED"];
export const ACTOR_TYPE = [
    "USER",
    "PLATFORM_USER",
    "SYSTEM",
    "ANONYMOUS",
];
export const OUTBOX_STATUS = ["PENDING", "PUBLISHED", "FAILED"];
// ---- Academic structure ------------------------------------------------------
export const ACADEMIC_YEAR_STATUS = [
    "DRAFT",
    "UPCOMING",
    "ACTIVE",
    "COMPLETED",
    "ARCHIVED",
];
export const CLASS_PHASE = [
    "EARLY_YEARS",
    "PRIMARY",
    "SECONDARY",
    "SENIOR",
];
export const CLASS_STATUS = ["ACTIVE", "INACTIVE", "ARCHIVED"];
export const SECTION_STATUS = [
    "DRAFT",
    "ACTIVE",
    "CLOSED",
    "ARCHIVED",
];
export const SUBJECT_TYPE = [
    "CORE",
    "ELECTIVE",
    "OPTIONAL",
    "EXTRACURRICULAR",
    "OTHER",
];
export const SUBJECT_STATUS = ["ACTIVE", "ARCHIVED"];
export const OFFERING_STATUS = ["ACTIVE", "INACTIVE"];
// ---- Students ----------------------------------------------------------------
export const STUDENT_STATUS = [
    "PROSPECTIVE",
    "ADMISSION_PENDING",
    "ADMITTED",
    "ACTIVE",
    "TRANSFERRED",
    "WITHDRAWN",
    "GRADUATED",
    "ARCHIVED",
];
export const GENDER = ["MALE", "FEMALE", "OTHER", "UNDISCLOSED"];
export const ADMISSION_STATUS = [
    "DRAFT",
    "SUBMITTED",
    "UNDER_REVIEW",
    "APPROVED",
    "REJECTED",
    "CANCELLED",
];
export const ENROLLMENT_STATUS = [
    "PENDING",
    "ACTIVE",
    "COMPLETED",
    "CANCELLED",
    "TRANSFERRED",
    "WITHDRAWN",
];
/** Statuses that occupy a seat and count as "the student's enrollment for the year". */
export const OPEN_ENROLLMENT_STATUSES = [
    "PENDING",
    "ACTIVE",
];
export const ENROLLMENT_TYPE = [
    "NEW",
    "PROMOTION",
    "TRANSFER_IN",
    "REJOIN",
    "CHANGE",
    "OTHER",
];
export const GUARDIAN_STATUS = ["ACTIVE", "ARCHIVED"];
export const GUARDIAN_RELATION = [
    "PARENT",
    "FATHER",
    "MOTHER",
    "GUARDIAN",
    "GRANDPARENT",
    "SIBLING",
    "OTHER",
];
export const BLOOD_GROUP = [
    "A+",
    "A-",
    "B+",
    "B-",
    "AB+",
    "AB-",
    "O+",
    "O-",
];
export const ADMISSION_TYPE = ["NEW", "TRANSFER_IN", "RE_ADMISSION"];
export const ADMISSION_NUMBER_MODE = ["AUTO", "MANUAL"];
export const GUARDIAN_CHANNEL = ["EMAIL", "SMS", "WHATSAPP", "PHONE"];
export const GUARDIAN_LINK_STATUS = ["ACTIVE", "ENDED"];
// ---- Teachers ------------------------------------------------------------------
export const TEACHER_STATUS = [
    "PROSPECTIVE",
    "ONBOARDING",
    "ACTIVE",
    "ON_LEAVE",
    "INACTIVE",
    "RESIGNED",
    "TERMINATED",
    "RETIRED",
    "ARCHIVED",
];
/** Statuses in which the person has left (or been put out of) day-to-day service. */
export const TEACHER_LEAVING_STATUSES = [
    "INACTIVE",
    "RESIGNED",
    "TERMINATED",
    "RETIRED",
    "ARCHIVED",
];
export const EMPLOYMENT_TYPE = [
    "FULL_TIME",
    "PART_TIME",
    "CONTRACT",
    "VISITING",
];
export const QUALIFICATION_TYPE = [
    "DEGREE",
    "DIPLOMA",
    "CERTIFICATION",
    "LICENSE",
    "OTHER",
];
export const QUALIFICATION_STATUS = ["ACTIVE", "REMOVED"];
export const ASSIGNMENT_ROLE = ["PRIMARY", "CO_TEACHER", "SUBSTITUTE"];
export const TEACHING_ASSIGNMENT_STATUS = [
    "ACTIVE",
    "ENDED",
    "CANCELLED",
];
// ---- Attendance ----------------------------------------------------------------
export const ATTENDANCE_TYPE = ["DAILY", "SUBJECT"];
/** DRAFT → SUBMITTED → FINAL (approval optional per school); reject/reopen return to DRAFT. */
export const ATTENDANCE_SESSION_STATUS = [
    "DRAFT",
    "SUBMITTED",
    "FINAL",
];
export const ATTENDANCE_STATUS_CATEGORY = [
    "PRESENT",
    "ABSENT",
    "LATE",
    "HALF_DAY",
    "EXCUSED",
    "LEAVE",
    "OTHER",
];
export const ATTENDANCE_STATUS_STATE = ["ACTIVE", "INACTIVE"];
export const ATTENDANCE_CORRECTION_STATUS = [
    "PENDING",
    "APPROVED",
    "REJECTED",
    "AUTO_APPLIED",
];
// ---- Timetable -----------------------------------------------------------------
/** Kind of a period in the school day. Only LESSON periods take timetable entries. */
export const PERIOD_KIND = [
    "LESSON",
    "BREAK",
    "LUNCH",
    "ASSEMBLY",
    "CUSTOM",
];
export const PERIOD_STATUS = ["ACTIVE", "INACTIVE"];
export const VENUE_TYPE = ["CLASSROOM", "LAB", "HALL", "OTHER"];
export const VENUE_STATUS = ["ACTIVE", "INACTIVE"];
/** DRAFT (editable) → PUBLISHED (read-only, one per academic year) → ARCHIVED (history). */
/** A weekday exception of a lesson period: another lesson, or no lesson (free). */
export const OVERRIDE_KIND = ["LESSON", "FREE"];
export const TIMETABLE_STATUS = ["DRAFT", "PUBLISHED", "ARCHIVED"];
/** CANCELLED is reserved for date-specific overrides (deferred); V1 never sets it. */
export const TIMETABLE_ENTRY_STATUS = ["ACTIVE", "CANCELLED"];
// ---- School fees (mirrors drizzle/0006_fees.sql) ----------------------------------------------
export const FEE_CATEGORY_STATUS = ["ACTIVE", "INACTIVE"];
export const FEE_FREQUENCY = [
    "ONE_TIME",
    "MONTHLY",
    "QUARTERLY",
    "HALF_YEARLY",
    "ANNUAL",
    "CUSTOM",
];
export const FEE_STRUCTURE_STATUS = ["DRAFT", "PUBLISHED", "ARCHIVED"];
/** How a learner pays the grade fee: 11 monthly instalments, 4 termly ones, or once with the early-payment discount. */
export const PAYMENT_PLAN = ["MONTHLY", "TERMLY", "ANNUAL"];
export const FEE_ASSIGNMENT_STATUS = ["ACTIVE", "CANCELLED"];
export const FEE_DEMAND_STATUS = [
    "DRAFT",
    "ISSUED",
    "PARTIALLY_PAID",
    "PAID",
    "OVERDUE",
    "CANCELLED",
    "WRITTEN_OFF",
    "WAIVED",
];
export const LATE_FEE_TYPE = ["FIXED", "PERCENT", "PER_DAY"];
export const FEE_ADJUSTMENT_TYPE = ["CONCESSION", "WAIVER"];
export const FEE_ADJUSTMENT_VALUE_TYPE = ["AMOUNT", "PERCENT"];
export const FEE_ADJUSTMENT_STATUS = [
    "REQUESTED",
    "APPROVED",
    "APPLIED",
    "REJECTED",
    "CANCELLED",
];
export const PAYER_TYPE = ["STUDENT", "GUARDIAN", "OTHER"];
export const PAYMENT_METHOD = [
    "CASH",
    "BANK_TRANSFER",
    "CHEQUE",
    "CARD",
    "UPI",
    "ONLINE_GATEWAY",
    "OTHER",
];
/**
 * What a payment can be recorded as. Payments are made outside the portal (no gateway, no card
 * data): UPI here is money the school received on its own UPI ID and records by hand.
 * ONLINE_GATEWAY is never accepted for new payments; it stays in the enum only so rows recorded
 * earlier still read back.
 */
export const RECORDABLE_PAYMENT_METHODS = [
    "CASH",
    "UPI",
    "BANK_TRANSFER",
    "CHEQUE",
    "CARD",
    "OTHER",
];
export const PAYMENT_STATUS = [
    "PENDING",
    "RECEIVED",
    "VERIFIED",
    "FAILED",
    "CANCELLED",
    "REFUNDED",
    "PARTIALLY_REFUNDED",
];
export const ALLOCATION_STATUS = [
    "ACTIVE",
    "PARTIALLY_REVERSED",
    "REVERSED",
];
export const RECEIPT_STATUS = ["ISSUED", "VOID"];
export const REFUND_STATUS = [
    "REQUESTED",
    "APPROVED",
    "PROCESSING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
];
/** Payments that hold money which can still be allocated to demands or refunded. */
export const ALLOCATABLE_PAYMENT_STATUSES = [
    "RECEIVED",
    "VERIFIED",
    "PARTIALLY_REFUNDED",
];
/** Refunds that still reserve money on their payment (not yet completed or closed). */
export const OPEN_REFUND_STATUSES = [
    "REQUESTED",
    "APPROVED",
    "PROCESSING",
];
export const INVOICE_STATUS = ["OPEN", "PAID", "VOID"];
/** SUBSCRIPTION = plan invoices (full model); SESSION_FEE = the yearly platform fee (school payments). */
export const INVOICE_KIND = ["SUBSCRIPTION", "SESSION_FEE"];
export const BILLING_PAYMENT_METHOD = [
    "CASH",
    "BANK_TRANSFER",
    "CHEQUE",
    "CARD",
    "UPI",
    "OTHER",
];
export const BILLING_PAYMENT_STATUS = ["RECEIVED", "REVERSED"];
// ---- Examinations ------------------------------------------------------------
export const EXAM_TYPE = [
    "UNIT_TEST",
    "MID_TERM",
    "FINAL",
    "PRACTICAL",
    "OTHER",
];
/** DRAFT = being set up and marked; PUBLISHED = results are final and marks are locked. */
export const EXAM_STATUS = ["DRAFT", "PUBLISHED"];
