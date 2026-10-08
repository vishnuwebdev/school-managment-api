/**
 * Product capability catalog — the single source of truth for feature codes.
 * Seeded into `features` / `feature_dependencies`. Keep the hierarchy shallow
 * (feature → sub-feature). Dependencies are data, never hard-coded checks.
 */
export interface FeatureDef {
  code: string;
  name: string;
  description?: string;
  parent?: string;
  isCore?: boolean;
  /**
   * A capability is a finer-grained switch below a feature or sub-feature
   * (feature → sub-feature → capability). Plans include every capability of
   * the features they contain unless a plan lists it explicitly as excluded.
   */
  kind?: 'capability';
  dependsOn?: string[];
}

export const FEATURES = [
  {
    code: 'core',
    name: 'Platform core',
    isCore: true,
    description: 'Sign-in, school profile, settings, users, roles and audit.',
  },

  { code: 'students', name: 'Student management' },
  {
    code: 'students.certificates',
    name: 'Certificates & ID cards',
    description: 'Issue, void and customise certificates and ID cards.',
    parent: 'students',
    kind: 'capability',
    dependsOn: ['students'],
  },
  {
    code: 'students.bulk',
    name: 'Bulk import & export',
    description: 'Import students from files and export student lists.',
    parent: 'students',
    kind: 'capability',
    dependsOn: ['students'],
  },
  { code: 'students.admissions', name: 'Admissions', parent: 'students', dependsOn: ['students'] },
  {
    code: 'students.admissions.approvals',
    name: 'Admission approvals',
    description: 'Approve or reject admission applications.',
    parent: 'students.admissions',
    kind: 'capability',
    dependsOn: ['students.admissions'],
  },
  {
    code: 'students.documents',
    name: 'Student documents',
    parent: 'students',
    dependsOn: ['students'],
  },

  {
    code: 'academics',
    name: 'Academic structure',
    description: 'Academic years, terms, classes, sections and subjects.',
  },
  { code: 'teachers', name: 'Teacher & staff management' },
  {
    code: 'teachers.portal',
    name: 'Teacher portal access',
    description: 'Invite teachers and staff to sign in.',
    parent: 'teachers',
    kind: 'capability',
    dependsOn: ['teachers'],
  },
  {
    code: 'teachers.staff_attendance',
    name: 'Staff attendance',
    description: 'Mark and view teacher and staff attendance.',
    parent: 'teachers',
    kind: 'capability',
    dependsOn: ['teachers'],
  },

  { code: 'attendance', name: 'Attendance', dependsOn: ['students', 'academics'] },
  {
    code: 'attendance.corrections',
    name: 'Corrections & approvals',
    description: 'Request, make and approve attendance corrections.',
    parent: 'attendance',
    kind: 'capability',
    dependsOn: ['attendance'],
  },
  {
    code: 'attendance.subject',
    name: 'Subject/period attendance',
    parent: 'attendance',
    dependsOn: ['attendance', 'timetable'],
  },

  { code: 'examinations', name: 'Examinations & results', dependsOn: ['students', 'academics'] },
  {
    code: 'examinations.online_results',
    name: 'Online results',
    parent: 'examinations',
    dependsOn: ['examinations', 'parent_portal'],
  },

  { code: 'fees', name: 'Fee management', dependsOn: ['students'] },
  {
    code: 'fees.concessions',
    name: 'Concessions & waivers',
    description: 'Request and approve fee concessions, waivers and discounts.',
    parent: 'fees',
    kind: 'capability',
    dependsOn: ['fees'],
  },
  {
    code: 'fees.refunds',
    name: 'Refunds',
    description: 'Request and approve fee refunds.',
    parent: 'fees',
    kind: 'capability',
    dependsOn: ['fees'],
  },
  {
    code: 'fees.reconciliation',
    name: 'Bank reconciliation',
    description: 'Import bank statements and reconcile payments.',
    parent: 'fees',
    kind: 'capability',
    dependsOn: ['fees'],
  },
  {
    code: 'fees.arrears',
    name: 'Arrears & collections',
    description: 'Reminders, payment plans and collections handover.',
    parent: 'fees',
    kind: 'capability',
    dependsOn: ['fees'],
  },
  {
    code: 'fees.online_payments',
    name: 'Online fee payments',
    parent: 'fees',
    dependsOn: ['fees'],
  },

  { code: 'timetable', name: 'Timetable', dependsOn: ['academics', 'teachers'] },
  { code: 'leave', name: 'Leave & staff availability', dependsOn: ['teachers'] },

  { code: 'communication', name: 'Communication & notices' },
  {
    code: 'communication.sms',
    name: 'SMS delivery',
    parent: 'communication',
    dependsOn: ['communication'],
  },

  {
    code: 'custom_roles',
    name: 'Custom roles',
    description:
      'Create, edit and archive the school’s own roles. Built-in roles and inviting users are always available.',
  },
  { code: 'parent_portal', name: 'Parent / guardian portal', dependsOn: ['students'] },
  { code: 'library', name: 'Library', dependsOn: ['students'] },
  { code: 'transport', name: 'Transportation', dependsOn: ['students'] },
  { code: 'reports', name: 'Reports & analytics' },
  { code: 'integrations', name: 'Integrations & external systems' },
] as const satisfies readonly FeatureDef[];

export type FeatureCode = (typeof FEATURES)[number]['code'];
