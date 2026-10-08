import type { FeatureCode } from './features.js';

/**
 * Permission catalog — the stable authorization contract (`domain.resource.action`).
 * Seeded into `permissions`. Code checks permissions, never role names.
 *
 * `feature` links a permission to the product capability it belongs to, so the
 * authorization layer can require the tenant entitlement automatically.
 */
export interface PermissionDef {
  code: string;
  name: string;
  feature: FeatureCode | 'platform';
  scope: 'PLATFORM' | 'TENANT';
  sensitive?: boolean;
  /** How a narrower-than-school role assignment applies to this permission (D55). */
  scopeSupport: ScopeSupport;
}

/**
 * What a grant narrower than the whole school (ASSIGNED_SECTION, ASSIGNED_CLASS,
 * OWN_RECORD) means for a permission. Enforced once, when grants are loaded
 * (`applyScopePolicy`), so a module that ignores scope can never widen it.
 *
 * - TENANT_WIDE – the permission only works school-wide; a narrower grant does
 *   not confer it. Assigning a role that contains it with a narrower scope is refused.
 * - NEUTRAL     – the permission does not select records by itself (school
 *   reference data, or a gate whose records are limited by another permission's
 *   scope, e.g. `fees.export` with `fees.read`); any grant counts as school-wide.
 * - PLACEMENT   – the module narrows records to ASSIGNED_SECTION / ASSIGNED_CLASS;
 *   other narrower types do not confer it.
 * - OWN         – a narrower grant means "own records only" (the module decides).
 *
 * A permission is PLACEMENT only when its module passes that permission to a scope
 * helper (studentScope, placementScope, feeScope, entryScope, loadStudent, …);
 * everything not listed in SCOPE_SUPPORT is TENANT_WIDE (fail closed).
 */
export type ScopeSupport = 'TENANT_WIDE' | 'NEUTRAL' | 'PLACEMENT' | 'OWN';

const SCOPE_SUPPORT: Readonly<Record<string, Exclude<ScopeSupport, 'TENANT_WIDE'>>> = {
  // School reference data, and export gates whose rows follow the read permission's scope.
  'tenant.profile.read': 'NEUTRAL',
  'tenant.settings.read': 'NEUTRAL',
  'academics.read': 'NEUTRAL',
  'communication.read': 'NEUTRAL',
  'attendance.export': 'NEUTRAL',
  'fees.export': 'NEUTRAL',

  // Students: every loader / list takes the permission's own scope.
  'students.read': 'PLACEMENT',
  'students.update': 'PLACEMENT',
  'students.archive': 'PLACEMENT',
  'students.enroll': 'PLACEMENT',
  'students.guardians.manage': 'PLACEMENT',
  'students.government_id.read': 'PLACEMENT',
  'students.certificates.read': 'PLACEMENT',
  'students.certificates.issue': 'PLACEMENT',
  'students.certificates.void': 'PLACEMENT',
  'students.documents.read': 'PLACEMENT',
  'students.documents.manage': 'PLACEMENT',

  // Attendance (placementScope / sectionInScope / loadSession).
  'attendance.read': 'PLACEMENT',
  'attendance.mark': 'PLACEMENT',
  'attendance.correct': 'PLACEMENT',
  'attendance.approve': 'PLACEMENT',

  // Fees (feeScope / loadDemand / loadPayment / loadStudent); bulk and
  // configuration operations use requireWide() on top.
  'fees.read': 'PLACEMENT',
  'fees.manage': 'PLACEMENT',
  'fees.payments.create': 'PLACEMENT',
  'fees.payments.verify': 'PLACEMENT',
  'fees.concessions.request': 'PLACEMENT',
  'fees.refunds.request': 'PLACEMENT',
  'fees.refunds.approve': 'PLACEMENT',
  'fees.waivers.approve': 'PLACEMENT',

  // Timetable (entryScope / sectionInScope).
  'timetable.read': 'PLACEMENT',
  'timetable.manage': 'PLACEMENT',
  'timetable.export': 'PLACEMENT',

  // Examinations (placementScope in the exams module: papers, marks and results are limited to the caller's classes and sections).
  'exams.read': 'PLACEMENT',
  'exams.marks.enter': 'PLACEMENT',

  // Own records: a teacher's own personnel record, own leave, a guardian's own children.
  'teachers.read': 'OWN',
  'leave.read': 'OWN',
  'leave.request': 'OWN',
  'portal.access': 'OWN',
};

const t = (code: string, name: string, feature: FeatureCode, sensitive = false): PermissionDef => ({
  code,
  name,
  feature,
  scope: 'TENANT',
  sensitive,
  scopeSupport: SCOPE_SUPPORT[code] ?? 'TENANT_WIDE',
});
const p = (code: string, name: string, sensitive = false): PermissionDef => ({
  code,
  name,
  feature: 'platform',
  scope: 'PLATFORM',
  sensitive,
  // Platform permissions are governed by ALL_TENANTS / SELECTED_TENANTS, not by this policy.
  scopeSupport: 'TENANT_WIDE',
});

export const PERMISSIONS: readonly PermissionDef[] = [
  // ---- Platform administration --------------------------------------------
  p('platform.tenants.read', 'View schools'),
  p('platform.tenants.create', 'Create schools'),
  p('platform.tenants.update', 'Edit school profiles'),
  p('platform.tenants.review', 'Review school requests'),
  p('platform.tenants.provision', 'Provision schools'),
  p('platform.tenants.suspend', 'Suspend / reactivate schools', true),
  p('platform.tenants.archive', 'Archive schools', true),
  p('platform.tenants.access', 'Act inside a school (support access)', true),
  p('platform.subscriptions.read', 'View subscriptions'),
  p('platform.subscriptions.manage', 'Change subscriptions', true),
  p('platform.entitlements.read', 'View school entitlements'),
  p('platform.entitlements.override', 'Override school entitlements', true),
  p('platform.catalog.read', 'View plans and features'),
  p('platform.plans.manage', 'Create and edit plans and what they include', true),
  p('platform.users.read', 'View platform users'),
  p('platform.users.manage', 'Manage platform users and roles', true),
  p('platform.audit.read', 'View platform audit log'),

  // ---- Core (always entitled) ---------------------------------------------
  t('tenant.profile.read', 'View school profile', 'core'),
  t('tenant.profile.update', 'Edit school profile', 'core'),
  t('tenant.settings.read', 'View school settings', 'core'),
  t('tenant.settings.update', 'Edit school settings', 'core'),
  t('tenant.finance.read', 'View school bank accounts (masked) and registration numbers', 'core'),
  t('tenant.finance.manage', 'Manage school bank accounts and registration numbers', 'core', true),
  t('tenant.finance.reveal', 'Reveal full bank account numbers', 'core', true),
  t('tenant.subscription.read', 'View plan and subscription', 'core'),
  t(
    'tenant.billing.read',
    'View invoices, payments and receipts for the school’s subscription',
    'core',
  ),
  t('members.read', 'View users', 'core'),
  t('members.invite', 'Invite users', 'core'),
  t('members.update', 'Suspend / reactivate users', 'core'),
  t('members.revoke', 'Remove users from the school', 'core', true),
  t('roles.read', 'View roles', 'core'),
  t('roles.create', 'Create roles', 'custom_roles'),
  t('roles.update', 'Edit roles', 'custom_roles', true),
  t('roles.archive', 'Archive roles', 'custom_roles', true),
  t('roles.assign', 'Assign roles to users', 'core', true),
  t('audit.read', 'View audit log', 'core'),

  // ---- Students ------------------------------------------------------------
  t('students.read', 'View students', 'students'),
  t('students.create', 'Create students', 'students'),
  t('students.update', 'Edit students', 'students'),
  t('students.archive', 'Archive / withdraw students', 'students', true),
  t('students.enroll', 'Enroll students and change classes', 'students'),
  t('students.guardians.manage', 'Manage student guardians', 'students'),
  t('students.settings.manage', 'Manage houses and admission numbering', 'students'),
  t('students.government_id.read', 'View full student government ID', 'students', true),
  t('students.import', 'Import students', 'students.bulk'),
  t('students.export', 'Export students', 'students.bulk'),
  t('students.certificates.read', 'View issued certificates and ID cards', 'students.certificates'),
  t(
    'students.certificates.issue',
    'Issue certificates and ID cards',
    'students.certificates',
    true,
  ),
  t('students.certificates.void', 'Void issued certificates', 'students.certificates', true),
  t('students.certificates.manage', 'Edit certificate wording', 'students.certificates'),
  t('students.admissions.read', 'View admissions', 'students.admissions'),
  t('students.admissions.manage', 'Manage admissions', 'students.admissions'),
  t('students.admissions.approve', 'Approve admissions', 'students.admissions.approvals'),
  t('students.documents.read', 'View student documents', 'students.documents'),
  t('students.documents.manage', 'Upload / remove student documents', 'students.documents'),

  // ---- Academics -----------------------------------------------------------
  t('academics.read', 'View academic structure', 'academics'),
  t('academics.manage', 'Manage years, terms, classes, sections and subjects', 'academics'),

  // ---- Teachers & staff ----------------------------------------------------
  t('teachers.read', 'View teachers and staff', 'teachers'),
  t('teachers.create', 'Create teachers and staff', 'teachers'),
  t('teachers.update', 'Edit teachers and staff', 'teachers'),
  t('teachers.archive', 'Archive teachers and staff', 'teachers', true),
  t('teachers.assignments.manage', 'Manage teaching assignments', 'teachers'),
  t('teachers.reports.read', 'View staff reports', 'teachers'),
  t('teachers.export', 'Export teachers and staff', 'teachers'),
  t('teachers.documents.read', 'View staff documents', 'teachers'),
  t('teachers.documents.manage', 'Upload / remove staff documents', 'teachers'),
  t('teachers.attendance.read', 'View staff attendance', 'teachers.staff_attendance'),
  t('teachers.attendance.mark', 'Mark staff attendance', 'teachers.staff_attendance'),
  t('teachers.portal.manage', 'Invite / remove teacher portal access', 'teachers.portal', true),

  // ---- Attendance ----------------------------------------------------------
  t('attendance.read', 'View attendance', 'attendance'),
  t('attendance.mark', 'Mark attendance', 'attendance'),
  t('attendance.correct', 'Request / make attendance corrections', 'attendance.corrections'),
  t(
    'attendance.approve',
    'Approve, reject and reopen attendance and corrections',
    'attendance.corrections',
  ),
  t('attendance.export', 'Export attendance registers and reports', 'attendance'),
  t('attendance.statuses.manage', 'Manage attendance statuses', 'attendance'),
  t('attendance.settings.manage', 'Manage attendance settings', 'attendance'),

  // ---- Examinations --------------------------------------------------------
  t('exams.read', 'View examinations', 'examinations'),
  t('exams.manage', 'Manage examinations', 'examinations'),
  t('exams.marks.enter', 'Enter marks', 'examinations'),
  t('exams.results.approve', 'Approve results', 'examinations'),
  t('exams.results.publish', 'Publish results', 'examinations', true),

  // ---- Fees ----------------------------------------------------------------
  t('fees.read', 'View fees', 'fees'),
  t('fees.manage', 'Manage fee structures and assignments', 'fees'),
  t('fees.settings.manage', 'Manage fee settings and categories', 'fees'),
  t('fees.structures.publish', 'Publish and archive fee structures', 'fees', true),
  t('fees.payments.create', 'Record payments', 'fees'),
  t('fees.payments.verify', 'Verify payments', 'fees', true),
  t('fees.concessions.request', 'Request fee concessions and waivers', 'fees.concessions'),
  t('fees.refunds.request', 'Request refunds', 'fees.refunds'),
  t('fees.refunds.approve', 'Approve refunds', 'fees.refunds', true),
  t('fees.waivers.approve', 'Approve waivers and discounts', 'fees.concessions', true),
  t('fees.export', 'Export fee data', 'fees'),
  t('fees.reconcile', 'Import bank statements and reconcile payments', 'fees.reconciliation'),
  t('fees.arrears.manage', 'Record reminders and manage payment plans', 'fees.arrears'),
  t(
    'fees.arrears.escalate',
    'Escalate arrears: letters of demand and collections handover',
    'fees.arrears',
    true,
  ),

  // ---- Timetable & leave -----------------------------------------------------
  t('timetable.read', 'View timetable', 'timetable'),
  t('timetable.manage', 'Edit timetable', 'timetable'),
  t('timetable.publish', 'Publish and archive timetable versions', 'timetable'),
  t('timetable.export', 'Export timetables', 'timetable'),
  t('leave.read', 'View leave', 'leave'),
  t('leave.request', 'Request leave', 'leave'),
  t('leave.approve', 'Approve leave', 'leave'),
  t('leave.types.manage', 'Manage leave types', 'leave'),

  // ---- Communication ---------------------------------------------------------
  t('communication.read', 'View notices', 'communication'),
  t('communication.announcements.manage', 'Create and publish notices', 'communication'),
  t('communication.messages.send', 'Send bulk messages', 'communication'),

  // ---- Portal, library, transport, reports, integrations -------------------
  t('portal.access', 'Use the parent / guardian portal', 'parent_portal'),
  t('library.read', 'View library', 'library'),
  t('library.manage', 'Manage library catalogue', 'library'),
  t('library.circulate', 'Issue and return books', 'library'),
  t('library.fines.waive', 'Waive library fines', 'library', true),
  t('transport.read', 'View transport', 'transport'),
  t('transport.manage', 'Manage routes, vehicles and drivers', 'transport'),
  t('transport.assign', 'Assign students to transport', 'transport'),
  t('reports.read', 'View reports', 'reports'),
  t('reports.export', 'Export reports', 'reports'),
  t('integrations.manage', 'Manage integrations', 'integrations', true),
];

export const PERMISSION_CODES = new Set(PERMISSIONS.map((x) => x.code));

for (const code of Object.keys(SCOPE_SUPPORT)) {
  if (!PERMISSIONS.some((x) => x.code === code && x.scope === 'TENANT'))
    throw new Error(`SCOPE_SUPPORT lists unknown tenant permission ${code}`);
}

/** Expand `students.*`-style patterns (and `*` / `platform.*`) against the catalog. */
export function expandPermissionPatterns(
  patterns: readonly string[],
  scope?: 'PLATFORM' | 'TENANT',
): string[] {
  const pool = scope ? PERMISSIONS.filter((x) => x.scope === scope) : PERMISSIONS;
  const out = new Set<string>();
  for (const pattern of patterns) {
    if (pattern === '*') {
      pool.forEach((x) => out.add(x.code));
    } else if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -1);
      pool.filter((x) => x.code.startsWith(prefix)).forEach((x) => out.add(x.code));
    } else {
      if (!PERMISSION_CODES.has(pattern))
        throw new Error(`Unknown permission in catalog pattern: ${pattern}`);
      out.add(pattern);
    }
  }
  return [...out].sort();
}
