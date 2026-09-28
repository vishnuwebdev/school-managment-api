import { expandPermissionPatterns } from './permissions.js';

/**
 * System roles. These are starting bundles of permissions, not hard-coded
 * behaviour: code never checks role codes. Schools cannot edit system roles,
 * but can create custom roles (e.g. a "Sub Admin" with selected permissions).
 */
export interface SystemRoleDef {
  code: string;
  name: string;
  description: string;
  scope: 'PLATFORM' | 'TENANT';
  /** Permission codes or patterns (`students.*`, `*`). */
  permissions: string[];
}

const TENANT_READ_ONLY = [
  'tenant.profile.read',
  'tenant.settings.read',
  'tenant.subscription.read',
  'members.read',
  'roles.read',
  'audit.read',
  'students.read',
  'students.admissions.read',
  'students.documents.read',
  'academics.read',
  'teachers.read',
  'attendance.read',
  'exams.read',
  'fees.read',
  'timetable.read',
  'leave.read',
  'communication.read',
  'library.read',
  'transport.read',
  'reports.read',
];

export const SYSTEM_ROLES: SystemRoleDef[] = [
  // ---- Platform roles --------------------------------------------------------
  {
    code: 'SUPER_ADMIN',
    name: 'Super Admin',
    description: 'Full platform access, including acting inside any school.',
    scope: 'PLATFORM',
    permissions: ['*'],
  },
  {
    code: 'PLATFORM_ADMIN',
    name: 'Platform Admin',
    description: 'Manages schools, provisioning and entitlements.',
    scope: 'PLATFORM',
    permissions: [
      'platform.tenants.*',
      'platform.subscriptions.read',
      'platform.entitlements.*',
      'platform.catalog.read',
      'platform.users.read',
      'platform.audit.read',
      ...TENANT_READ_ONLY,
    ],
  },
  {
    code: 'BILLING_ADMIN',
    name: 'Billing Admin',
    description: 'Manages subscriptions and plans.',
    scope: 'PLATFORM',
    permissions: [
      'platform.tenants.read',
      'platform.subscriptions.*',
      'platform.entitlements.read',
      'platform.catalog.read',
    ],
  },
  {
    code: 'SALES_ADMIN',
    name: 'Sales Admin',
    description: 'Onboards schools: reviews requests, views plans and subscriptions.',
    scope: 'PLATFORM',
    permissions: [
      'platform.tenants.read',
      'platform.tenants.review',
      'platform.tenants.create',
      'platform.subscriptions.read',
      'platform.catalog.read',
    ],
  },
  {
    code: 'OPERATIONS_ADMIN',
    name: 'Operations Admin',
    description: 'Runs schools day to day: provisioning, suspension, entitlements (read).',
    scope: 'PLATFORM',
    permissions: [
      'platform.tenants.read',
      'platform.tenants.update',
      'platform.tenants.provision',
      'platform.tenants.suspend',
      'platform.entitlements.read',
      'platform.catalog.read',
      'platform.audit.read',
    ],
  },
  {
    code: 'SUPPORT_ADMIN',
    name: 'Support Admin',
    description: 'Read-only support access to schools.',
    scope: 'PLATFORM',
    permissions: [
      'platform.tenants.read',
      'platform.tenants.access',
      'platform.entitlements.read',
      'platform.audit.read',
      ...TENANT_READ_ONLY,
    ],
  },

  // ---- School (tenant) system roles ----------------------------------------
  {
    code: 'SCHOOL_ADMIN',
    name: 'School Admin',
    description: 'Full access within the school, limited by the school’s plan.',
    scope: 'TENANT',
    permissions: expandPermissionPatterns(['*'], 'TENANT').filter((c) => c !== 'portal.access'),
  },
  {
    code: 'PRINCIPAL',
    name: 'Principal',
    description: 'Academic and administrative oversight.',
    scope: 'TENANT',
    permissions: [
      ...TENANT_READ_ONLY,
      'academics.manage',
      'attendance.approve',
      'exams.manage',
      'exams.results.approve',
      'exams.results.publish',
      'timetable.manage',
      'timetable.publish',
      'leave.approve',
      'communication.announcements.manage',
      'students.admissions.approve',
      'reports.export',
    ],
  },
  {
    code: 'ACCOUNTANT',
    name: 'Accountant',
    description: 'Fees, receipts and financial reports.',
    scope: 'TENANT',
    permissions: ['students.read', 'academics.read', 'fees.*', 'reports.*', 'communication.read'],
  },
  {
    code: 'TEACHER',
    name: 'Teacher',
    description: 'Assigned classes: attendance, marks and timetable.',
    scope: 'TENANT',
    permissions: [
      'students.read',
      'academics.read',
      'attendance.read',
      'attendance.mark',
      'attendance.correct',
      'exams.read',
      'exams.marks.enter',
      'timetable.read',
      'leave.read',
      'leave.request',
      'communication.read',
    ],
  },
  {
    code: 'RECEPTIONIST',
    name: 'Receptionist / Office Staff',
    description: 'Student records, admissions, documents and notices.',
    scope: 'TENANT',
    permissions: [
      'students.read',
      'students.create',
      'students.update',
      'students.admissions.read',
      'students.admissions.manage',
      'students.documents.*',
      'academics.read',
      'communication.read',
      'communication.announcements.manage',
    ],
  },
  {
    code: 'LIBRARIAN',
    name: 'Librarian',
    description: 'Library catalogue and circulation.',
    scope: 'TENANT',
    permissions: ['students.read', 'library.*', 'communication.read'],
  },
  {
    code: 'TRANSPORT_MANAGER',
    name: 'Transport Manager',
    description: 'Routes, vehicles and student transport.',
    scope: 'TENANT',
    permissions: ['students.read', 'transport.*', 'communication.read'],
  },
  {
    code: 'PARENT',
    name: 'Parent / Guardian',
    description: 'Portal access to linked students only.',
    scope: 'TENANT',
    permissions: ['portal.access'],
  },
];

export function resolveSystemRolePermissions(role: SystemRoleDef): string[] {
  // Platform roles may carry tenant permissions (used when acting inside a school).
  return expandPermissionPatterns(role.permissions);
}
