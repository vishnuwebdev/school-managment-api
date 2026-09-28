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
}

const t = (code: string, name: string, feature: FeatureCode, sensitive = false): PermissionDef => ({
  code,
  name,
  feature,
  scope: 'TENANT',
  sensitive,
});
const p = (code: string, name: string, sensitive = false): PermissionDef => ({
  code,
  name,
  feature: 'platform',
  scope: 'PLATFORM',
  sensitive,
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
  p('platform.users.read', 'View platform users'),
  p('platform.users.manage', 'Manage platform users and roles', true),
  p('platform.audit.read', 'View platform audit log'),

  // ---- Core (always entitled) ---------------------------------------------
  t('tenant.profile.read', 'View school profile', 'core'),
  t('tenant.profile.update', 'Edit school profile', 'core'),
  t('tenant.settings.read', 'View school settings', 'core'),
  t('tenant.settings.update', 'Edit school settings', 'core'),
  t('tenant.subscription.read', 'View plan and subscription', 'core'),
  t('members.read', 'View users', 'core'),
  t('members.invite', 'Invite users', 'core'),
  t('members.update', 'Suspend / reactivate users', 'core'),
  t('members.revoke', 'Remove users from the school', 'core', true),
  t('roles.read', 'View roles', 'core'),
  t('roles.create', 'Create roles', 'core'),
  t('roles.update', 'Edit roles', 'core', true),
  t('roles.archive', 'Archive roles', 'core', true),
  t('roles.assign', 'Assign roles to users', 'core', true),
  t('audit.read', 'View audit log', 'core'),

  // ---- Students ------------------------------------------------------------
  t('students.read', 'View students', 'students'),
  t('students.create', 'Create students', 'students'),
  t('students.update', 'Edit students', 'students'),
  t('students.archive', 'Archive / withdraw students', 'students', true),
  t('students.import', 'Import students', 'students'),
  t('students.export', 'Export students', 'students'),
  t('students.admissions.read', 'View admissions', 'students.admissions'),
  t('students.admissions.manage', 'Manage admissions', 'students.admissions'),
  t('students.admissions.approve', 'Approve admissions', 'students.admissions'),
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

  // ---- Attendance ----------------------------------------------------------
  t('attendance.read', 'View attendance', 'attendance'),
  t('attendance.mark', 'Mark attendance', 'attendance'),
  t('attendance.correct', 'Request / make attendance corrections', 'attendance'),
  t('attendance.approve', 'Approve attendance corrections', 'attendance'),

  // ---- Examinations --------------------------------------------------------
  t('exams.read', 'View examinations', 'examinations'),
  t('exams.manage', 'Manage examinations', 'examinations'),
  t('exams.marks.enter', 'Enter marks', 'examinations'),
  t('exams.results.approve', 'Approve results', 'examinations'),
  t('exams.results.publish', 'Publish results', 'examinations', true),

  // ---- Fees ----------------------------------------------------------------
  t('fees.read', 'View fees', 'fees'),
  t('fees.manage', 'Manage fee structures and assignments', 'fees'),
  t('fees.payments.create', 'Record payments', 'fees'),
  t('fees.payments.verify', 'Verify payments', 'fees', true),
  t('fees.refunds.approve', 'Approve refunds', 'fees', true),
  t('fees.waivers.approve', 'Approve waivers and discounts', 'fees', true),
  t('fees.export', 'Export fee data', 'fees'),

  // ---- Timetable & leave -----------------------------------------------------
  t('timetable.read', 'View timetable', 'timetable'),
  t('timetable.manage', 'Edit timetable', 'timetable'),
  t('timetable.publish', 'Publish timetable', 'timetable'),
  t('leave.read', 'View leave', 'leave'),
  t('leave.request', 'Request leave', 'leave'),
  t('leave.approve', 'Approve leave', 'leave'),

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
