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
  { code: 'students.admissions', name: 'Admissions', parent: 'students', dependsOn: ['students'] },
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

  { code: 'attendance', name: 'Attendance', dependsOn: ['students', 'academics'] },
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

  { code: 'parent_portal', name: 'Parent / guardian portal', dependsOn: ['students'] },
  { code: 'library', name: 'Library', dependsOn: ['students'] },
  { code: 'transport', name: 'Transportation', dependsOn: ['students'] },
  { code: 'reports', name: 'Reports & analytics' },
  { code: 'integrations', name: 'Integrations & external systems' },
] as const satisfies readonly FeatureDef[];

export type FeatureCode = (typeof FEATURES)[number]['code'];
