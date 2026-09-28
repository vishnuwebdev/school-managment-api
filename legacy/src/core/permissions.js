// The platform-wide permission catalog. Permissions are code-defined (so
// they can't be typo'd or invented at runtime) but which permissions a role
// grants is data (roles table/collection), per spec section 6: "A role is a
// collection of permissions." Add a new module's permissions here only —
// nothing else needs to change to make them assignable to a role.
export const PERMISSIONS = [
  // Platform (super admin only)
  'platform.schools.manage',
  'platform.audit.view',

  // School setup
  'school.settings.view', 'school.settings.update',

  // Academic structure
  'academicYears.view', 'academicYears.manage',
  'classes.view', 'classes.manage',
  'subjects.view', 'subjects.manage',

  // People
  'students.view', 'students.create', 'students.update', 'students.archive', 'students.import',
  'parents.view', 'parents.create', 'parents.update',
  'staff.view', 'staff.create', 'staff.update', 'staff.archive', 'staff.import',

  // Daily operations
  'attendance.view', 'attendance.create', 'attendance.update', 'attendance.correction.approve', 'attendance.settings.manage',
  'fees.view', 'fees.create', 'fees.update', 'fees.refund',
  'timetable.view', 'timetable.manage',
  'notices.view', 'notices.create',

  // Academic operations
  'exams.view', 'exams.create', 'exams.update', 'exams.publish',
  'documents.view', 'documents.upload', 'documents.generate',

  // Administration
  'reports.view',
  'audit.view',
  'users.view', 'users.create', 'users.update', 'users.deactivate',
  'roles.view', 'roles.manage',
  'settings.view', 'settings.update',
];

export const PERMISSION_SET = new Set(PERMISSIONS);

export const isKnownPermission = (key) => PERMISSION_SET.has(key);
