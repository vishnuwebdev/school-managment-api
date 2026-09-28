import bcrypt from 'bcryptjs';
import { db } from './index.js';
import { env } from '../config/env.js';
import { PERMISSIONS } from '../core/permissions.js';
import { V2_PERMISSIONS } from '../core/permissionsV2.js';
import { storage } from '../modules/storage/localStorageAdapter.js';
import { generateTimetable, DEFAULT_SLOTS, DEFAULT_CYCLE_DAYS, DEFAULT_HARD_RULES, DEFAULT_SOFT_RULES } from '../core/timetableGenerator.js';
import { raiseInvoicesForTerm, recordPayment, matchBankLine, setupPaymentPlan, getInvoiceView, getStudentBalance, todayStr } from '../modules/fees/service.js';
import { computePercentage } from '../modules/attendance/service.js';
import { gradeForPercentage, classTeacherFor, computeMarksheetStats, passRateFor, gradeWideMean, generateReportCardPdf, storeReportCardPdf } from '../modules/exams/service.js';
import { backfillFromGuardians } from '../modules/parents/service.js';
import { calculateRun } from '../modules/payroll/service.js';

// Creates the minimal data a fresh database needs to be usable: one demo
// school, the three roles context.md asks for (kept minimal on purpose —
// "Super Admin", "School Admin", "Sub Admin" with feature-level grants),
// one login per role, a handful of students, and enough School Setup mock
// data (profile, academic years/terms, subjects, holidays, grading scale,
// fee types) that the module isn't empty the first time someone logs in.
// Safe to re-run — every block checks before creating, and never overwrites
// data that's already there (including anything a user has since edited).
// Runs automatically on boot for the memory driver (which has nothing to
// persist between restarts); run explicitly with `npm run seed` for mysql
// or mongo once DATABASE_URL points at a real instance.
// RBAC rewrite: V2_PERMISSIONS (the new feature:page:action catalog, so
// far just Dashboard + School Setup) is added explicitly here rather than
// relied on purely via permit()'s old<->new compatibility map, because
// 'dashboard:overview:read' has no old-format equivalent to bridge from
// -- Dashboard never had a permission gate before this rewrite. School
// Setup's two new keys ARE bridged by the compat map from the old
// 'school.settings.view'/'update' already in PERMISSIONS, so adding them
// here too is redundant but harmless -- explicit is better than relying
// on a transitional shim once a role's grants are being hand-edited
// anyway, per the plan doc's "full visibility" goal.
const SCHOOL_ADMIN_PERMISSIONS = [...PERMISSIONS.filter((p) => !p.startsWith('platform.')), ...V2_PERMISSIONS];
// Sub Admin keeps its existing minimal grant unchanged, plus
// dashboard:overview:read only -- Dashboard was visible to any
// authenticated user before this rewrite (no gate existed), so this
// preserves that behaviour now that it's a real, checked permission.
// Sub Admin still has no school.settings.* today, so it deliberately does
// NOT get the new school-setup:profile:* keys either -- same access as
// before, just expressed in the new model where School Setup has one.
const SUB_ADMIN_PERMISSIONS = ['students.view', 'students.create', 'attendance.view', 'attendance.create', 'parents.view', 'parents.create', 'dashboard:overview:read', 'notices:board:read', 'notices:board:write', 'notices:acknowledgements:read', 'settings:regional:read', 'settings:regional:write'];

export async function seed() {
  await db.ready();

  let school = await db.schools.findBySlug('bright-future');
  if (!school) school = await db.schools.create({ name: 'Bright Future International School', slug: 'bright-future' });

  const ensureRole = async (tenantId, key, name, permissions, isSystem) => {
    const existing = await db.roles.findByKey(tenantId, key);
    if (existing) return existing;
    return db.roles.create({ tenantId, key, name, permissions, isSystem });
  };

  const superAdmin = await ensureRole(null, 'super_admin', 'Super Admin', [...PERMISSIONS, ...V2_PERMISSIONS], true);
  const schoolAdmin = await ensureRole(school.id, 'school_admin', 'School Administrator', SCHOOL_ADMIN_PERMISSIONS, true);
  // System roles on an already-seeded (mysql/mongo) database never pick up
  // permissions added to the catalog later -- ensureRole returns the
  // existing row untouched. Top up ONLY the two system roles with any
  // missing catalog keys (never removes anything, never touches custom
  // roles or sub_admin), so a new module such as Payroll is usable by the
  // school administrator after `npm run seed` without a manual role edit.
  const topUpSystemRole = async (role, tenantId, expected) => {
    if (!role?.isSystem) return;
    const missing = expected.filter((p) => !(role.permissions || []).includes(p));
    if (missing.length) await db.roles.updatePermissions(tenantId, role.key, [...(role.permissions || []), ...missing]);
  };
  await topUpSystemRole(superAdmin, null, [...PERMISSIONS, ...V2_PERMISSIONS]);
  await topUpSystemRole(schoolAdmin, school.id, SCHOOL_ADMIN_PERMISSIONS);
  await ensureRole(school.id, 'sub_admin', 'Sub Admin', SUB_ADMIN_PERMISSIONS, false);

  // Tier-one entitlements (RBAC plan doc): explicit rows for the demo
  // school on both migrated features, for real audit visibility from day
  // one rather than leaving the Super Admin's Entitlements screen empty
  // and relying silently on entitlements.js's "missing row = enabled"
  // default. Safe to re-run: upsert is a no-op in effect if already set.
  await db.schoolEntitlements.upsert({ tenantId: school.id, featureKey: 'dashboard', enabled: true, updatedBy: null });
  await db.schoolEntitlements.upsert({ tenantId: school.id, featureKey: 'school-setup', enabled: true, updatedBy: null });

  const ensureUser = async (tenantId, email, fullName, roleKeys, password) => {
    const existing = await db.users.findByEmail(email);
    if (existing) return existing;
    const passwordHash = await bcrypt.hash(password, env.bcryptRounds);
    return db.users.create({ tenantId, email, passwordHash, fullName, roleKeys });
  };

  // The School Admin login below (admin@brightfuture.edu) is the account
  // that owns all the School Setup mock data seeded further down, and it's
  // already what the login screen pre-fills and what the "School Admin"
  // dev-login chip signs in as — nothing further is needed to "link" it.
  await ensureUser(null, 'superadmin@edusphere.app', 'Platform Super Admin', ['super_admin'], 'ChangeMe123!');
  await ensureUser(school.id, 'admin@brightfuture.edu', 'Bright Future Admin', ['school_admin'], 'ChangeMe123!');
  await ensureUser(school.id, 'subadmin@brightfuture.edu', 'Bright Future Sub Admin', ['sub_admin'], 'ChangeMe123!');

  await seedStudents(school.id);

  await seedStaff(school.id);

  await seedTimetable(school.id);

  await seedSchoolSetup(school.id);

  await seedClasses(school.id);

  await seedAttendance(school.id);

  await seedFees(school.id);

  await seedExams(school.id);

  await seedParents(school.id);

  await seedNotices(school.id);

  await seedSecurityPolicy(school.id);

  await seedPayroll(school.id);

  return { school };
}

// School Setup (see the "School Setup - All Related Screens" design) has
// nine profile sections plus six list-style tabs. All of it is real,
// tenant-scoped data once saved — this just fills it in with a believable
// example so the screens aren't empty on first login.
async function seedSchoolSetup(tenantId) {
  const profile = await db.schoolProfile.get(tenantId);
  if (!profile.basicInfo?.schoolName) {
    const sections = {
      basicInfo: {
        schoolName: 'Bright Future International School',
        shortName: 'BFIS',
        schoolType: 'Private',
        affiliationBoard: 'CBSE',
        affiliationNumber: 'AFF-2010-4471',
        schoolCode: 'BFS-001',
        establishedYear: '1998',
        mediumOfInstruction: 'English',
        motto: 'Empowering Minds, Building Futures',
        about: 'Bright Future International School is a co-educational day school offering Nursery through Grade 12, known for its blend of academic rigour and holistic development.',
      },
      contact: {
        primaryPhone: '+91 98765 43210',
        secondaryPhone: '+91 98765 43211',
        email: 'info@brightfuture.edu',
        alternateEmail: 'admissions@brightfuture.edu',
        landline: '011-4567 8900',
        receptionPhone: '011-4567 8901',
        fax: '011-4567 8999',
        contactPersonName: 'Anita Verma',
        designation: 'Front Office Manager',
      },
      address: {
        addressLine1: '24, Sector 12, Vasant Vihar',
        addressLine2: 'Near City Park',
        city: 'New Delhi',
        state: 'Delhi',
        pinCode: '110057',
        country: 'India',
      },
      branding: {
        logoUrl: '',
        bannerUrl: '',
        primaryColor: '#1E3A8A',
        secondaryColor: '#F59E0B',
        accentColor: '#10B981',
      },
      bank: {
        accountHolderName: 'Bright Future International School Trust',
        bankName: 'HDFC Bank',
        accountNumber: '50100234567890',
        ifscCode: 'HDFC0001234',
        branchName: 'Vasant Vihar Branch',
        accountType: 'Current Account',
      },
      registration: {
        registrationNumber: 'REG/DL/1998/00456',
        registrationDate: '1998-06-12',
        trustSocietyName: 'Bright Future Education Trust',
        trustRegistrationNumber: 'TR/1997/0231',
        panNumber: 'AABCB1234E',
        tanNumber: 'DELB12345F',
        gstNumber: '07AABCB1234E1Z5',
        udiseCode: '07100112345',
      },
      social: {
        website: 'https://www.brightfuture.edu',
        facebook: 'https://facebook.com/brightfutureintl',
        instagram: 'https://instagram.com/brightfutureintl',
        youtube: 'https://youtube.com/@brightfutureintl',
        twitter: 'https://twitter.com/brightfutureedu',
        linkedin: 'https://linkedin.com/school/bright-future-international',
      },
      promotion: {
        autoPromotion: true,
        requireApproval: true,
        allowExamChange: false,
        retainFailedStudents: true,
      },
      // Regional Format (edusphere-settings-module-plan-2026-09-23.md) --
      // moved into the Settings module; the 3 delivery-medium toggles that
      // used to live here (enableEmailNotifications/enableSmsNotifications/
      // enableParentPortalAccess) were dropped rather than relocated, since
      // this codebase has no email/SMS delivery and no parent portal login
      // to enable in the first place -- they were dead controls.
      preferences: {
        dateFormat: 'DD/MM/YYYY',
        timeFormat: '12 Hour',
        currency: 'INR',
      },
    };
    for (const [section, data] of Object.entries(sections)) {
      await db.schoolProfile.updateSection(tenantId, section, data);
    }
  }

  let years = await db.academicYears.list(tenantId);
  if (years.length === 0) {
    await db.academicYears.create({ tenantId, label: '2024-2025', startDate: '2024-04-01', endDate: '2025-03-31', status: 'closed' });
    const current = await db.academicYears.create({ tenantId, label: '2025-2026', startDate: '2025-04-01', endDate: '2026-03-31', status: 'upcoming' });
    await db.academicYears.create({ tenantId, label: '2026-2027', startDate: '2026-04-01', endDate: '2027-03-31', status: 'upcoming' });
    await db.academicYears.setCurrent(tenantId, current.id);
    years = await db.academicYears.list(tenantId);
  }

  const currentYear = years.find((y) => y.status === 'current') || years[0];
  if (currentYear && (await db.academicTerms.list(tenantId)).length === 0) {
    const terms = [
      ['Term 1', '2025-04-01', '2025-07-31'],
      ['Term 2', '2025-08-01', '2025-11-30'],
      ['Term 3', '2025-12-01', '2026-03-31'],
    ];
    for (const [name, startDate, endDate] of terms) {
      await db.academicTerms.create({ tenantId, academicYearId: currentYear.id, name, startDate, endDate });
    }
  }

  if ((await db.subjects.list(tenantId)).length === 0) {
    const subjects = [
      ['English', 'ENG', 'Nursery - 12'],
      ['Mathematics', 'MATH', 'Nursery - 12'],
      ['Science', 'SCI', '1 - 10'],
      ['Social Studies', 'SST', '3 - 10'],
      ['Hindi', 'HIN', '1 - 10'],
      ['Computer Science', 'CS', '6 - 12'],
      ['Physical Education', 'PE', 'Nursery - 12'],
      ['Art & Craft', 'ART', 'Nursery - 8'],
    ];
    for (const [name, code, applicableClasses] of subjects) {
      await db.subjects.create({ tenantId, name, code, applicableClasses });
    }
  }

  if ((await db.holidays.list(tenantId)).length === 0) {
    const holidays = [
      ['Summer Vacation', '2025-05-15', '2025-06-15', 'School'],
      ['Independence Day', '2025-08-15', '2025-08-15', 'National'],
      ['Gandhi Jayanti', '2025-10-02', '2025-10-02', 'National'],
      ['Diwali Break', '2025-10-20', '2025-10-24', 'Religious'],
      ['Christmas', '2025-12-25', '2025-12-25', 'Religious'],
      ['Winter Break', '2025-12-26', '2026-01-02', 'School'],
      ['Republic Day', '2026-01-26', '2026-01-26', 'National'],
      ['Holi', '2026-03-04', '2026-03-04', 'Religious'],
    ];
    for (const [name, startDate, endDate, type] of holidays) {
      await db.holidays.create({ tenantId, name, startDate, endDate, type });
    }
  }

  if ((await db.grades.list(tenantId)).length === 0) {
    const grades = [
      ['A1', 91, 100, 10],
      ['A2', 81, 90, 9],
      ['B1', 71, 80, 8],
      ['B2', 61, 70, 7],
      ['C1', 51, 60, 6],
      ['C2', 41, 50, 5],
      ['D', 33, 40, 4],
      ['E (Needs Improvement)', 0, 32, 0],
    ];
    for (const [grade, minMarks, maxMarks, gradePoint] of grades) {
      await db.grades.create({ tenantId, grade, minMarks, maxMarks, gradePoint });
    }
  }

  if ((await db.feeTypes.list(tenantId)).length === 0) {
    const feeTypes = [
      ['Tuition Fee', 'Monthly', 'Nursery - 12', 3500],
      ['Admission Fee', 'One Time', 'Nursery - 12', 15000],
      ['Transport Fee', 'Monthly', '1 - 12', 1800],
      ['Examination Fee', 'Quarterly', '1 - 12', 800],
      ['Library Fee', 'Annual', '1 - 12', 500],
      ['Annual Day Fund', 'Annual', 'Nursery - 12', 1200],
    ];
    for (const [name, frequency, applicableClasses, amount] of feeTypes) {
      await db.feeTypes.create({ tenantId, name, frequency, applicableClasses, amount });
    }
  }
}

// Student Management (designs/Student managment system.png). 12 students
// across the classes School Setup's grading/subjects already reference,
// with real personal/parent/academic detail so every profile tab and list
// filter has something genuine to show -- 10 active, one withdrawn and one
// transferred so the Withdraw/Transfer flow and their reports aren't empty
// either. No document files or attendance history are seeded here: there's
// nothing honest to invent for a birth-certificate scan or a day's roster,
// so Documents and the Attendance tab start empty until someone uploads or
// marks attendance for real through the app.
async function seedStudents(tenantId) {
  if (await db.students.existsByAdmissionNumber(tenantId, 'BFS001')) return;

  const guardians = (father, mother) => ({
    father: father ? { name: father[0], phone: father[1], email: father[2] || '' } : {},
    mother: mother ? { name: mother[0], phone: mother[1], email: mother[2] || '' } : {},
    guardian: {},
  });

  const students = [
    {
      admissionNumber: 'BFS001', firstName: 'Aarav', middleName: 'Kumar', lastName: 'Sharma',
      dateOfBirth: '2015-01-12', gender: 'Male', bloodGroup: 'B+', nationality: 'Indian',
      aadhaarNumber: '1234 5678 9012', studentEmail: 'aarav.sharma@email.com',
      guardians: guardians(['Rajesh Sharma', '+91 98765 43210', 'rajesh.sharma@email.com'], ['Sunita Sharma', '+91 98765 43212', '']),
      academicYear: '2025-2026', className: 'Class 5', section: 'A', rollNumber: '15',
      admissionDate: '2024-01-15', admissionType: 'New Admission', house: 'Blue House', category: 'General', transportRequired: true,
    },
    {
      admissionNumber: 'BFS002', firstName: 'Diya', lastName: 'Patel',
      dateOfBirth: '2016-03-14', gender: 'Female', bloodGroup: 'O+', nationality: 'Indian',
      guardians: guardians(['Kiran Patel', '+91 98123 45601', ''], ['Nisha Patel', '+91 98123 45602', '']),
      academicYear: '2025-2026', className: 'Class 5', section: 'B', rollNumber: '8',
      admissionDate: '2024-02-01', admissionType: 'New Admission', house: 'Red House', category: 'OBC', transportRequired: false,
    },
    {
      admissionNumber: 'BFS003', firstName: 'Kabir', middleName: 'Rohan', lastName: 'Singh',
      dateOfBirth: '2014-07-05', gender: 'Male', bloodGroup: 'A+', nationality: 'Indian',
      guardians: guardians(['Manpreet Singh', '+91 97123 45611', ''], ['Amrit Singh', '+91 97123 45612', '']),
      academicYear: '2025-2026', className: 'Class 6', section: 'A', rollNumber: '12',
      admissionDate: '2022-06-10', admissionType: 'New Admission', house: 'Green House', category: 'General', transportRequired: true,
    },
    {
      admissionNumber: 'BFS004', firstName: 'Meera', lastName: 'Nair',
      dateOfBirth: '2015-11-22', gender: 'Female', bloodGroup: 'AB+', nationality: 'Indian',
      guardians: guardians(['Suresh Nair', '+91 96123 45621', ''], ['Lakshmi Nair', '+91 96123 45622', '']),
      academicYear: '2025-2026', className: 'Class 5', section: 'A', rollNumber: '21',
      admissionDate: '2024-01-20', admissionType: 'New Admission', house: 'Yellow House', category: 'General', transportRequired: false,
    },
    {
      admissionNumber: 'BFS005', firstName: 'Arjun', lastName: 'Gupta',
      dateOfBirth: '2013-04-30', gender: 'Male', bloodGroup: 'B-', nationality: 'Indian',
      guardians: guardians(['Vikram Gupta', '+91 95123 45631', ''], ['Pooja Gupta', '+91 95123 45632', '']),
      academicYear: '2025-2026', className: 'Class 7', section: 'B', rollNumber: '5',
      admissionDate: '2021-06-15', admissionType: 'New Admission', house: 'Blue House', category: 'General', transportRequired: true,
    },
    {
      admissionNumber: 'BFS006', firstName: 'Zoya', lastName: 'Khan',
      dateOfBirth: '2014-09-11', gender: 'Female', bloodGroup: 'O-', nationality: 'Indian',
      guardians: guardians(['Imran Khan', '+91 94123 45641', ''], ['Sana Khan', '+91 94123 45642', '']),
      academicYear: '2025-2026', className: 'Class 6', section: 'B', rollNumber: '18',
      admissionDate: '2022-07-01', admissionType: 'New Admission', house: 'Red House', category: 'General', transportRequired: false,
    },
    {
      admissionNumber: 'BFS007', firstName: 'Ishaan', middleName: 'Dev', lastName: 'Verma',
      dateOfBirth: '2016-06-18', gender: 'Male', bloodGroup: 'A+', nationality: 'Indian',
      guardians: guardians(['Anil Verma', '+91 93123 45651', ''], ['Ritu Verma', '+91 93123 45652', '']),
      academicYear: '2025-2026', className: 'Class 4', section: 'A', rollNumber: '2',
      admissionDate: '2025-04-05', admissionType: 'New Admission', house: 'Green House', category: 'General', transportRequired: true,
    },
    {
      admissionNumber: 'BFS008', firstName: 'Ananya', lastName: 'Reddy',
      dateOfBirth: '2015-08-25', gender: 'Female', bloodGroup: 'B+', nationality: 'Indian',
      guardians: guardians(['Srinivas Reddy', '+91 92123 45661', ''], ['Divya Reddy', '+91 92123 45662', '']),
      academicYear: '2025-2026', className: 'Class 5', section: 'A', rollNumber: '9',
      admissionDate: '2024-03-10', admissionType: 'New Admission', house: 'Yellow House', category: 'OBC', transportRequired: false,
    },
    {
      admissionNumber: 'BFS009', firstName: 'Karan', lastName: 'Malhotra',
      dateOfBirth: '2012-12-02', gender: 'Male', bloodGroup: 'O+', nationality: 'Indian',
      guardians: guardians(['Sanjay Malhotra', '+91 91123 45671', ''], ['Neha Malhotra', '+91 91123 45672', '']),
      academicYear: '2025-2026', className: 'Class 8', section: 'A', rollNumber: '7',
      admissionDate: '2020-06-20', admissionType: 'New Admission', house: 'Blue House', category: 'General', transportRequired: true,
    },
    {
      admissionNumber: 'BFS010', firstName: 'Ishita', lastName: 'Roy',
      dateOfBirth: '2017-01-09', gender: 'Female', bloodGroup: 'A-', nationality: 'Indian',
      guardians: guardians(['Debashish Roy', '+91 90123 45681', ''], ['Priya Roy', '+91 90123 45682', '']),
      academicYear: '2025-2026', className: 'Class 3', section: 'B', rollNumber: '14',
      admissionDate: '2025-04-10', admissionType: 'New Admission', house: 'Red House', category: 'EWS', transportRequired: false,
    },
    {
      admissionNumber: 'BFS011', firstName: 'Yash', lastName: 'Choudhary',
      dateOfBirth: '2014-03-03', gender: 'Male', bloodGroup: 'B+', nationality: 'Indian',
      guardians: guardians(['Rakesh Choudhary', '+91 89123 45691', ''], ['Anita Choudhary', '+91 89123 45692', '']),
      academicYear: '2025-2026', className: 'Class 6', section: 'A', rollNumber: '20',
      admissionDate: '2023-06-15', admissionType: 'New Admission', house: 'Green House', category: 'General', transportRequired: true,
      withdraw: { date: '2026-08-10', reason: 'Moving to another city', remarks: 'Family relocated to Pune.' },
    },
    {
      admissionNumber: 'BFS012', firstName: 'Priya', lastName: 'Menon',
      dateOfBirth: '2013-10-17', gender: 'Female', bloodGroup: 'O+', nationality: 'Indian',
      guardians: guardians(['Suresh Menon', '+91 88123 45601', ''], ['Latha Menon', '+91 88123 45602', '']),
      academicYear: '2025-2026', className: 'Class 7', section: 'A', rollNumber: '11',
      admissionDate: '2021-06-05', admissionType: 'New Admission', house: 'Yellow House', category: 'General', transportRequired: false,
      transfer: { date: '2026-07-15', transferTo: 'Green Valley Public School, Bangalore', reason: 'Parent job relocation', remarks: 'Transfer certificate issued.' },
    },
  ];

  for (const { withdraw, transfer, ...payload } of students) {
    const student = await db.students.create({ tenantId, ...payload });
    if (withdraw) await db.students.withdraw(tenantId, student.id, withdraw);
    if (transfer) await db.students.transfer(tenantId, student.id, transfer);
  }
}

// Teachers & Staff (designs/Teacher feature UI mockup/Teachers & Staff.dc.html)
// -- names, roles, departments and workload figures below are taken
// directly from that design's STAFF/WORKLOAD/leaveReqs/DOCS sample arrays
// so the seeded data matches what the mockup shows. Assignment periods are
// re-derived from real staff_assignments rows (workload is computed live
// by the API, never stored), so they're close to but not required to
// exactly reproduce the design's hardcoded WORKLOAD totals.
async function seedStaff(tenantId) {
  if (await db.staff.existsByEmployeeId(tenantId, 'EMP-0142')) return;

  const staffDefs = [
    { employeeId: 'EMP-0142', firstName: 'Thandiwe', lastName: 'Ndlovu', gender: 'Female', dateOfBirth: '1985-03-22', idNumber: '8503225800087', staffType: 'Teaching', designation: 'Senior Teacher', department: 'Mathematics', employmentType: 'Permanent · Full-time', joiningDate: '2019-01-14', workEmail: 't.ndlovu@brightfuture.edu', phone: '+27 82 441 9087', weeklyPeriodCapacity: 30, isClassTeacher: true, classTeacherOf: 'Class 10 · B', notes: 'HOD Sciences reporting line; leads Grade 12 Maths.' },
    { employeeId: 'EMP-0156', firstName: 'Sipho', lastName: 'Maseko', gender: 'Male', dateOfBirth: '1990-07-09', staffType: 'Teaching', designation: 'Teacher', department: 'Languages', employmentType: 'Permanent · Full-time', joiningDate: '2020-02-03', workEmail: 's.maseko@brightfuture.edu', phone: '+27 83 552 1190', weeklyPeriodCapacity: 30 },
    { employeeId: 'EMP-0163', firstName: 'Lerato', lastName: 'Dube', gender: 'Female', dateOfBirth: '1979-11-30', staffType: 'Teaching', designation: 'Head of Department', department: 'Sciences', employmentType: 'Permanent · Full-time', joiningDate: '2017-07-21', workEmail: 'l.dube@brightfuture.edu', phone: '+27 84 220 6634', weeklyPeriodCapacity: 24, isClassTeacher: true, classTeacherOf: 'Class 11 · B' },
    { employeeId: 'EMP-0171', firstName: 'Johan', lastName: 'Pretorius', gender: 'Male', dateOfBirth: '1988-02-17', staffType: 'Teaching', designation: 'Teacher', department: 'Humanities', employmentType: 'Permanent · Full-time', joiningDate: '2021-04-12', workEmail: 'j.pretorius@brightfuture.edu', phone: '+27 81 334 7712', weeklyPeriodCapacity: 30 },
    { employeeId: 'EMP-0188', firstName: 'Naledi', lastName: 'Khumalo', gender: 'Female', dateOfBirth: '1996-05-14', staffType: 'Teaching', designation: 'Teacher', department: 'Mathematics', employmentType: 'Probationary · Full-time', joiningDate: '2022-08-01', workEmail: 'n.khumalo@brightfuture.edu', phone: '+27 79 118 4420', weeklyPeriodCapacity: 30, status: 'probation' },
    { employeeId: 'EMP-0194', firstName: 'Fatima', lastName: 'Patel', gender: 'Female', dateOfBirth: '1975-09-02', staffType: 'Non-teaching', designation: 'Librarian', department: 'Support Services', employmentType: 'Permanent · Full-time', joiningDate: '2018-09-19', workEmail: 'f.patel@brightfuture.edu', phone: '+27 82 990 3341', weeklyPeriodCapacity: 0 },
    { employeeId: 'EMP-0201', firstName: 'Bongani', lastName: 'Zulu', gender: 'Male', dateOfBirth: '1992-01-27', staffType: 'Non-teaching', designation: 'Admin Clerk', department: 'Administration', employmentType: 'Permanent · Full-time', joiningDate: '2023-03-05', workEmail: 'b.zulu@brightfuture.edu', phone: '+27 76 662 5518', weeklyPeriodCapacity: 0 },
    { employeeId: 'EMP-0209', firstName: 'Elize', lastName: 'van Wyk', gender: 'Female', dateOfBirth: '1998-06-08', staffType: 'Teaching', designation: 'Teacher', department: 'Creative Arts', employmentType: 'Contract · Full-time', joiningDate: '2024-01-27', workEmail: 'e.vanwyk@brightfuture.edu', phone: '+27 78 441 0092', weeklyPeriodCapacity: 30, status: 'inactive' },
    { employeeId: 'EMP-0217', firstName: 'Kagiso', lastName: 'Molefe', gender: 'Male', dateOfBirth: '1991-10-19', staffType: 'Teaching', designation: 'Teacher', department: 'Languages', employmentType: 'Permanent · Full-time', joiningDate: '2021-01-18', workEmail: 'k.molefe@brightfuture.edu', phone: '+27 83 774 2261', weeklyPeriodCapacity: 30 },
    { employeeId: 'EMP-0225', firstName: 'Priya', lastName: 'Naidoo', gender: 'Female', dateOfBirth: '1994-04-25', staffType: 'Teaching', designation: 'Teacher', department: 'Sciences', employmentType: 'Permanent · Full-time', joiningDate: '2022-01-10', workEmail: 'p.naidoo@brightfuture.edu', phone: '+27 84 556 8813', weeklyPeriodCapacity: 30 },
  ];

  const byEmployeeId = {};
  for (const { status, ...def } of staffDefs) {
    const staffMember = await db.staff.create({ tenantId, ...def });
    if (status) await db.staff.update(tenantId, staffMember.id, { status });
    byEmployeeId[def.employeeId] = staffMember.id;
  }

  const assign = async (employeeId, subject, className, section, periodsPerWeek, role = 'Subject') => {
    await db.staffAssignments.create({ tenantId, staffId: byEmployeeId[employeeId], subject, className, section, periodsPerWeek, role });
  };

  // Thandiwe Ndlovu -- Mathematics + Physical Sciences, class teacher 10-B.
  await assign('EMP-0142', 'Mathematics', 'Class 10', 'B', 6, 'Class teacher');
  await assign('EMP-0142', 'Mathematics', 'Class 11', 'A', 6);
  await assign('EMP-0142', 'Mathematics', 'Class 12', 'A', 5);
  await assign('EMP-0142', 'Physical Sciences', 'Class 12', 'A', 5);
  await assign('EMP-0142', 'Life Orientation', 'Class 10', 'B', 4, 'Relief');
  // Sipho Maseko -- English, Life Orientation, Afrikaans.
  await assign('EMP-0156', 'English', 'Class 8', 'A', 6);
  await assign('EMP-0156', 'English', 'Class 8', 'B', 6);
  await assign('EMP-0156', 'English', 'Class 9', 'A', 6);
  await assign('EMP-0156', 'Life Orientation', 'Class 8', 'A', 5);
  await assign('EMP-0156', 'Afrikaans', 'Class 9', 'A', 5);
  // Lerato Dube -- Life Sciences HOD, class teacher 11-B, reduced load.
  await assign('EMP-0163', 'Life Sciences', 'Class 11', 'B', 9, 'Class teacher');
  await assign('EMP-0163', 'Life Sciences', 'Class 12', 'B', 9);
  // Johan Pretorius -- History + Geography, deliberately over capacity
  // (31 of 30) to exercise the "over capacity" workload state.
  await assign('EMP-0171', 'History', 'Class 9', 'B', 8);
  await assign('EMP-0171', 'History', 'Class 10', 'A', 7);
  await assign('EMP-0171', 'Geography', 'Class 9', 'B', 8);
  await assign('EMP-0171', 'Geography', 'Class 10', 'A', 8);
  // Naledi Khumalo -- Mathematics, Grade 7 (probation).
  await assign('EMP-0188', 'Mathematics', 'Class 7', 'A', 11);
  await assign('EMP-0188', 'Mathematics', 'Class 7', 'B', 11);
  // Elize van Wyk -- Visual Arts + Music.
  await assign('EMP-0209', 'Visual Arts', 'Class 8', 'A', 6);
  await assign('EMP-0209', 'Visual Arts', 'Class 9', 'A', 6);
  await assign('EMP-0209', 'Visual Arts', 'Class 9', 'B', 6);
  await assign('EMP-0209', 'Music', 'Class 8', 'A', 5);
  await assign('EMP-0209', 'Music', 'Class 9', 'A', 6);
  // Kagiso Molefe -- Afrikaans + English.
  await assign('EMP-0217', 'Afrikaans', 'Class 8', 'A', 6);
  await assign('EMP-0217', 'Afrikaans', 'Class 8', 'B', 6);
  await assign('EMP-0217', 'English', 'Class 9', 'B', 6);
  await assign('EMP-0217', 'English', 'Class 10', 'A', 6);
  // Priya Naidoo -- Physical Sciences + Life Sciences.
  await assign('EMP-0225', 'Physical Sciences', 'Class 11', 'A', 9);
  await assign('EMP-0225', 'Physical Sciences', 'Class 11', 'B', 9);
  await assign('EMP-0225', 'Life Sciences', 'Class 10', 'A', 9);
  // Fatima Patel (Librarian) and Bongani Zulu (Admin Clerk) are
  // non-teaching -- no subject/class assignments.

  // Leave requests -- matches the design's "Leave & Attendance" queue plus
  // a couple of older approved records so Thandiwe's own balance bars
  // aren't empty on her profile.
  const leave = async (employeeId, leaveType, startDate, endDate, status, reason) => {
    const record = await db.staffLeave.create({ tenantId, staffId: byEmployeeId[employeeId], leaveType, startDate, endDate, daysCount: Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1, reason: reason || null });
    if (status !== 'pending') await db.staffLeave.decide(tenantId, record.id, { status, decidedBy: null });
  };
  await leave('EMP-0171', 'Sick leave', '2026-09-14', '2026-09-16', 'pending', 'Flu, resting on doctor’s advice.');
  await leave('EMP-0188', 'Family responsibility', '2026-09-17', '2026-09-17', 'pending', 'Family emergency.');
  await leave('EMP-0209', 'Annual leave', '2026-09-28', '2026-10-02', 'approved', 'Family trip, booked in advance.');
  await leave('EMP-0163', 'Study leave', '2026-10-05', '2026-10-05', 'approved', 'Postgrad supervision meeting at UCT.');
  await leave('EMP-0201', 'Unpaid leave', '2026-09-21', '2026-09-25', 'declined', 'Requested outside the notice period.');
  await leave('EMP-0142', 'Annual leave', '2026-06-01', '2026-06-05', 'approved', 'Mid-year break.');
  await leave('EMP-0142', 'Sick leave', '2026-03-10', '2026-03-11', 'approved', 'Flu.');

  // Documents & Qualifications -- matches the design's DOCS sample rows.
  // Seeded through the real storage adapter (a tiny placeholder text file)
  // so the download endpoint works end to end, not just the metadata list.
  const doc = async (employeeId, fileName, documentType, expiryDate) => {
    const staffId = byEmployeeId[employeeId];
    const buffer = Buffer.from(`Placeholder for ${fileName} (seed data).`, 'utf-8');
    const storageKey = await storage.save({ tenantId, entityType: 'staff', entityId: staffId, fileName: `${fileName}.pdf`, buffer });
    await db.documents.create({
      tenantId, entityType: 'staff', entityId: staffId, documentType,
      fileName: `${fileName}.pdf`, storageKey, mimeType: 'application/pdf', sizeBytes: buffer.length,
      uploadedBy: null, expiryDate: expiryDate || null,
    });
  };
  await doc('EMP-0142', 'BEd Honours - Wits', 'Qualification', null);
  await doc('EMP-0142', 'SACE registration', 'Registration', '2026-12-31');
  await doc('EMP-0142', 'Police clearance', 'Compliance', '2026-03-02'); // already expired
  await doc('EMP-0156', 'SACE registration', 'Registration', '2026-09-30'); // expiring soon
  await doc('EMP-0156', 'BA Languages - UP', 'Qualification', null);
  await doc('EMP-0163', 'PhD Life Sciences - UCT', 'Qualification', null);
  await doc('EMP-0194', 'First-aid certificate', 'Training', '2026-10-14'); // expiring soon
  await doc('EMP-0201', 'Employment contract', 'Contract', '2026-12-31');
  await doc('EMP-0188', 'Teaching diploma', 'Qualification', null);
}

// Timetable (designs/Teacher feature UI mockup/Timetable.dc.html) -- runs
// the real generator (core/timetableGenerator.js) against the real
// staff_assignments seeded just above, so every number on screens 1-7
// comes from an actual computed run rather than hand-typed grid data.
// Johan Pretorius's 31-of-30-period load and his pending sick leave
// (both seeded in seedStaff) organically produce a real "Over ceiling"
// clash-report finding and a real Substitution & Relief scenario --
// neither is special-cased here.
async function seedTimetable(tenantId) {
  if (await db.timetableConfig.get(tenantId)) return;

  await db.timetableConfig.upsert(tenantId, {
    cycleDays: DEFAULT_CYCLE_DAYS,
    cycleAnchor: '2026-09-14',
    slots: DEFAULT_SLOTS,
    hardRules: DEFAULT_HARD_RULES,
    softRules: DEFAULT_SOFT_RULES,
  });

  // Specialist venues (screen 8) -- free-text `subjects`, matched
  // case-insensitively against staff_assignments.subject (see
  // core/timetableGenerator.js's venueForSubject).
  const scienceLab = await db.timetableVenues.create({ tenantId, name: 'Science laboratory', capacity: '40 learners', subjects: 'Physical Sciences, Life Sciences' });
  const artMusicRoom = await db.timetableVenues.create({ tenantId, name: 'Art & Music room', capacity: '35 learners', subjects: 'Visual Arts, Music' });
  const venues = [scienceLab, artMusicRoom];

  const [assignments, staff] = await Promise.all([
    db.staffAssignments.listForTenant(tenantId),
    db.staff.list(tenantId, {}),
  ]);
  const staffCapacity = Object.fromEntries(staff.map((s) => [s.id, s.weeklyPeriodCapacity ?? 30]));

  // Run 1 -- becomes the live timetable (screens 1-3, 11).
  const run1 = generateTimetable({ assignments, staffCapacity, venues, slots: DEFAULT_SLOTS, cycleDays: DEFAULT_CYCLE_DAYS, softRules: DEFAULT_SOFT_RULES });
  const version1 = await db.timetableVersions.create({ tenantId, note: `Initial auto-generate — ${run1.stats.placedPct}% placed`, createdBy: null });
  await db.timetableEntries.replaceForVersion(tenantId, version1.id, run1.entries);
  await db.timetableRuns.create({
    tenantId, versionId: version1.id, hardRules: DEFAULT_HARD_RULES, softRules: DEFAULT_SOFT_RULES,
    totalPeriods: run1.stats.totalPeriods, placedPeriods: run1.stats.placedPeriods,
    note: `${run1.stats.placedPct}% placed · ${run1.unplaced.length} unplaced`, createdBy: null,
  });
  await db.timetableVersions.publish(tenantId, version1.id, { effectiveFrom: '2026-09-01' });

  // Run 2 -- a second, still-draft version (with "one free day" turned
  // down to Medium) so Versions (screen 11) and the Auto-generate run
  // history (screen 6) both have more than a single row on first login,
  // and the "live timetable can't be edited directly" guard is real from
  // the start rather than only reachable after a user generates once.
  const draftSoftRules = DEFAULT_SOFT_RULES.map((r) => (r.key === 'oneFreeDay' ? { ...r, weight: 'Medium' } : r));
  const run2 = generateTimetable({ assignments, staffCapacity, venues, slots: DEFAULT_SLOTS, cycleDays: DEFAULT_CYCLE_DAYS, softRules: draftSoftRules });
  const version2 = await db.timetableVersions.create({ tenantId, note: `Draft — "one free day" weight lowered to Medium — ${run2.stats.placedPct}% placed`, createdBy: null });
  await db.timetableEntries.replaceForVersion(tenantId, version2.id, run2.entries);
  await db.timetableRuns.create({
    tenantId, versionId: version2.id, hardRules: DEFAULT_HARD_RULES, softRules: draftSoftRules,
    totalPeriods: run2.stats.totalPeriods, placedPeriods: run2.stats.placedPeriods,
    note: `${run2.stats.placedPct}% placed · ${run2.unplaced.length} unplaced`, createdBy: null,
  });
  // version2 stays draft on purpose -- generate never auto-publishes.

  // Exam timetable (screen 9) -- deliberately self-contained; see
  // schema.sql's exam_sessions comment for why this doesn't read from a
  // real Examinations module (there isn't one yet in this codebase).
  const byEmployeeId = Object.fromEntries(staff.map((s) => [s.employeeId, s.id]));
  await db.examSessions.create({ tenantId, className: 'Class 10', examDate: '2026-10-12', session: 'AM', subject: 'Mathematics', venue: 'Assembly Hall', seats: 60, invigilatorStaffId: byEmployeeId['EMP-0142'], termLabel: 'Term 3 Final Exams' });
  await db.examSessions.create({ tenantId, className: 'Class 10', examDate: '2026-10-12', session: 'PM', subject: 'History', venue: 'Assembly Hall', seats: 60, invigilatorStaffId: byEmployeeId['EMP-0171'], termLabel: 'Term 3 Final Exams' });
  await db.examSessions.create({ tenantId, className: 'Class 11', examDate: '2026-10-13', session: 'AM', subject: 'Physical Sciences', venue: 'Science laboratory', seats: 34, invigilatorStaffId: byEmployeeId['EMP-0225'], termLabel: 'Term 3 Final Exams' });
  // No invigilator assigned yet on this one -- exercises screen 9's
  // "missing invigilator" check (GET /exams-checks) honestly.
  await db.examSessions.create({ tenantId, className: 'Class 9', examDate: '2026-10-13', session: 'AM', subject: 'English', venue: 'Hall B', seats: 45, invigilatorStaffId: null, termLabel: 'Term 3 Final Exams' });

  // Substitution & relief (screen 10) needs no seed data of its own --
  // GET /relief derives it live from staff_leave + the live version's
  // entries (see routes.js), so Johan Pretorius's real pending sick leave
  // (2026-09-14 to 2026-09-16, seeded in seedStaff) surfaces there on its
  // own the first time that screen is opened on one of those dates.
}

// Classes & Sections (designs/Teacher feature UI mockup/Classes and
// Sections.dc.html). class_levels is the authoritative class/section
// registry -- the exact same 15 names as kClassOptions in the Flutter app
// (Students/Staff/Timetable's add/edit screens still take free-text class
// names; migrating those onto this registry is tracked, not silently done
// here -- see this module's own GET /settings "consumers" list), so
// nothing drifts even before those callers are migrated. Capacities and
// phases reflect real planning (Early years: 30 seats/section; Primary and
// Secondary: 35) and Class 12 is genuinely "provisional" because next
// year's Grade 12 structure isn't finalised yet at this point in the
// school calendar. Enrolled counts are never invented here -- GET
// /classes/levels computes them live from seedStudents()'s real rows, so
// most sections honestly show 0 enrolled until admissions happen through
// the app; the two real class teachers already seeded on staff
// (Thandiwe Ndlovu -> Class 10 · B, Lerato Dube -> Class 11 · B) surface
// automatically once those sections exist here.
async function seedClasses(tenantId) {
  if ((await db.classLevels.list(tenantId)).length > 0) return;

  const LEVELS = [
    ['Nursery', 'Early years', 30, ['A', 'B']],
    ['LKG', 'Early years', 30, ['A', 'B']],
    ['UKG', 'Early years', 30, ['A', 'B']],
    ['Class 1', 'Primary', 35, ['A', 'B', 'C']],
    ['Class 2', 'Primary', 35, ['A', 'B', 'C']],
    ['Class 3', 'Primary', 35, ['A', 'B']],
    ['Class 4', 'Primary', 35, ['A', 'B']],
    ['Class 5', 'Primary', 35, ['A', 'B']],
    ['Class 6', 'Primary', 35, ['A', 'B']],
    ['Class 7', 'Primary', 35, ['A', 'B']],
    ['Class 8', 'Secondary', 35, ['A', 'B']],
    ['Class 9', 'Secondary', 35, ['A', 'B']],
    ['Class 10', 'Secondary', 35, ['A', 'B']],
    ['Class 11', 'Secondary', 35, ['A', 'B']],
    ['Class 12', 'Secondary', 35, ['A', 'B']],
  ];

  const levelByName = {};
  for (let orderIndex = 0; orderIndex < LEVELS.length; orderIndex += 1) {
    const [name, phase, defaultCapacity, letters] = LEVELS[orderIndex];
    const level = await db.classLevels.create({
      tenantId, name, phase, orderIndex, languageOfInstruction: 'English', defaultCapacity,
      status: name === 'Class 12' ? 'provisional' : 'active',
    });
    levelByName[name] = level;
    for (let li = 0; li < letters.length; li += 1) {
      await db.classSections.create({
        tenantId, classLevelId: level.id, letter: letters[li],
        capacity: defaultCapacity, room: `Room ${orderIndex + 1}${letters[li]}`,
      });
    }
  }

  await db.classStructureSettings.upsert(tenantId, {
    sectionLetters: 'A,B,C,D,E', defaultSeats: 35, defaultSeatsEarlyYears: 30,
  });

  // Curriculum plan (screen 6) -- seeded only for the two subjects where
  // School Setup's subject catalog and Staff's real assignment records
  // actually agree on a name (English, Mathematics). The other six
  // catalog subjects (Science, Social Studies, Hindi, Computer Science,
  // Physical Education, Art & Craft) were never given matching staff
  // assignments in seedStaff() -- it uses a different, CAPS-style subject
  // vocabulary (Life Sciences, Physical Sciences, Afrikaans, History...)
  // for its own bios. Planning periods for subjects with zero real
  // staffing would manufacture false "no teacher" alarms rather than
  // surface a real one, so those six stay unplanned (blank) until a real
  // admin fills them in -- the two that are seeded genuinely do surface
  // real, honest "no teacher assigned yet" notes for the levels Staff
  // hasn't covered, which is the check working as intended.
  const levelNames = LEVELS.map(([name]) => name);
  for (const name of levelNames) {
    await db.classCurriculum.create({ tenantId, subjectName: 'English', className: name, periodsPerCycle: 8 });
    await db.classCurriculum.create({ tenantId, subjectName: 'Mathematics', className: name, periodsPerCycle: 8 });
  }

  // Waitlist (screen 5) -- a real admin-managed queue, not a fabricated
  // admissions pipeline: two genuine "interest recorded ahead of a seat
  // opening" entries, independent of current capacity.
  await db.classWaitlist.create({ tenantId, className: 'Nursery', learnerName: 'Ayaan Patel', note: 'Toured campus 2026-09-02; waiting for a seat to open.' });
  await db.classWaitlist.create({ tenantId, className: 'Class 1', learnerName: 'Naledi Botha', note: 'Sibling of an existing Class 4 learner; requested for the 2026-2027 intake.' });
}


// Attendance (designs/Teacher feature UI mockup/Attendance.dc.html, 9
// screens). The earlier decision not to seed attendance history (see
// seedStudents' header comment) was right when only the daily register
// screen existed -- there was nothing honest to show with it. Now that
// Monthly summary, Defaulters, Corrections and Trends are real screens
// whose entire point is analysing history, an empty history makes them
// impossible to verify. So this seeds five school weeks of REAL daily
// register rows (one attendance_history entry per mark, exactly as if a
// teacher had taken the register each day) for every active student, up
// to and including YESTERDAY -- today itself is deliberately left
// unmarked for every class, so "Attendance today" (screen 1) still shows
// genuine open registers rather than a fabricated "already submitted"
// state.
//
// Two students are seeded as real defaulters (below the 75% at-risk
// threshold, one with a live 3+ day absence streak) so the At-risk screen
// and its computed policy "stage" have something real to show; one of
// them already has a warning_letter intervention logged, the other is
// still at the initial "Monitoring" stage. A same-day correction and a
// backdated (8-day-old) correction request are also seeded so Corrections
// History has both an already-applied row and one sitting in the approval
// queue. actorId is left null throughout, matching how seedTimetable
// marks its own generated versions (createdBy: null) -- these are seeded
// rows, not a real person's action.
async function seedAttendance(tenantId) {
  const students = await db.students.list(tenantId, { status: 'active' });
  if (!students.length) return;

  const already = await db.attendance.findByStudent(tenantId, students[0].id);
  if (already.length) return; // idempotent across restarts, same as the other seed*() functions

  const sorted = [...students].sort((a, b) => a.admissionNumber.localeCompare(b.admissionNumber));
  const defaulterA = sorted[0]; // ends with a live 3+ day absence streak, no intervention yet -- "Monitoring"
  const defaulterB = sorted[1]; // ends present, but term percentage stays under threshold -- "Letter sent"

  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const weekdays = [];
  for (let back = 1; weekdays.length < 25; back += 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - back);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) weekdays.push(d.toISOString().slice(0, 10));
  }
  weekdays.reverse(); // oldest first, so "last 3" below really means most recent

  const mark = async (student, date, status, remark = '') => {
    await db.attendance.upsertMany(tenantId, {
      date, className: student.className, section: student.section,
      records: [{ studentId: student.id, status, remark }], actorId: null,
    });
  };

  for (const student of students) {
    const isDefaulterA = student.id === defaulterA.id;
    const isDefaulterB = student.id === defaulterB.id;
    for (let i = 0; i < weekdays.length; i += 1) {
      const date = weekdays[i];
      let status = 'present';
      if (isDefaulterA) {
        // Mostly absent, and absent for the final 4 marked days -- a real,
        // live consecutive-absence streak as of "today".
        const last4 = i >= weekdays.length - 4;
        status = last4 ? 'absent' : (i % 3 === 0 ? 'present' : 'absent');
      } else if (isDefaulterB) {
        // Chronically under the threshold without an active streak --
        // isolated single absences every third day, never two in a row,
        // spread evenly through the term.
        status = i % 3 === 0 ? 'present' : (i % 3 === 1 ? 'absent' : 'late');
      } else {
        const roll = i % 10;
        status = roll < 8 ? 'present' : roll === 8 ? 'late' : 'absent';
      }
      await mark(student, date, status, status === 'absent' && Math.random() < 0.4 ? 'No note from guardian' : '');
    }
  }

  // A same-day-window correction (applied immediately, lands straight in
  // attendance_history as a real 'updated' row) -- the student was marked
  // absent, corrected to late once a guardian note arrived.
  const correctionDate = weekdays[weekdays.length - 3];
  await mark(sorted[2], correctionDate, 'absent');
  await mark(sorted[2], correctionDate, 'late', 'Guardian called in — bus delay, arrived at 9:40');

  // A backdated correction (8 days back, past the default 7-day window) --
  // seeded straight into the approval queue exactly as PUT /api/attendance
  // would have routed it, so the pending queue isn't empty on first run.
  const backdatedDate = weekdays[weekdays.length - 9];
  const priorRecords = await db.attendance.findMatching(tenantId, backdatedDate, sorted[3].className, sorted[3].section);
  const prior = priorRecords.find((r) => r.studentId === sorted[3].id);
  if (prior) {
    await db.attendanceCorrectionRequests.create({
      tenantId, studentId: sorted[3].id, date: backdatedDate, className: sorted[3].className, section: sorted[3].section,
      previousStatus: prior.status, previousRemark: prior.remark,
      requestedStatus: 'leave', requestedRemark: 'Family medical emergency — leave form submitted late',
      reason: 'Family medical emergency — leave form submitted late', requestedBy: null, requestedAt: new Date().toISOString(),
    });
  }

  // Defaulter B already has a warning letter on record; Defaulter A is
  // still at the very first policy stage with nothing logged yet.
  await db.attendanceInterventions.create({
    tenantId, studentId: defaulterB.id, type: 'warning_letter',
    note: 'First attendance warning letter sent home.', createdBy: null, createdAt: new Date().toISOString(),
  });

  // Settings: period-wise marking turned on for the Secondary phase only
  // (Class 8-12), matching the mockup's own "off by default, opt in per
  // phase" default -- everything else keeps the built-in defaults.
  await db.attendanceSettings.upsert(tenantId, { periodMarkingPhases: ['Secondary'] });
}

// Fees & Payments (designs/Teacher feature UI mockup/Fees and
// Payments.dc.html, 9 screens). Seeds a real, worked example of a term's
// worth of collections: a published fee structure (per-phase heads, one
// of them Early-years-only so an unused head is genuinely on record, not
// fabricated), a billing schedule with two terms already due and a third
// not yet billed, invoices raised for every active student against both
// due terms, a real spread of payment outcomes (fully paid & reconciled,
// part-paid, untouched), a real sibling discount (two existing active
// students are given a shared "guardian" contact -- see the comment
// below), a real payment plan, real escalation history, and a real bank
// reconciliation queue with Exact/Likely/None lines side by side.
//
// Reuses the module's own service.js functions throughout (raiseInvoices-
// ForTerm, recordPayment, matchBankLine, setupPaymentPlan, getInvoiceView,
// getStudentBalance) rather than re-deriving the logic here, so the seed
// data is produced by exactly the same code path the API itself runs --
// the same principle as seedAttendance driving real attendance.upsertMany
// calls instead of writing history rows by hand.
async function seedFees(tenantId) {
  if ((await db.feeStructures.list(tenantId)).length > 0) return; // idempotent, same as the other seed*() functions

  const admin = await db.users.findByEmail('admin@brightfuture.edu');
  const subAdmin = await db.users.findByEmail('subadmin@brightfuture.edu');
  const adminId = admin?.id || null;
  const subAdminId = subAdmin?.id || null;

  // Sibling discount (rules.siblingDiscountPercent, applied automatically
  // by raiseInvoicesForTerm/isYoungerSibling) needs two active students
  // who genuinely share a guardian contact to have anything real to show.
  // No two seeded students share a surname, so rather than inventing a
  // 13th student just to demonstrate this, two existing active students
  // -- Arjun Gupta (Class 7) and Karan Malhotra (Class 8), a plausible
  // one-grade age gap -- are given a shared secondary "guardian" contact
  // (a shared family friend/emergency contact), a field every seeded
  // student already has present but empty. Nothing on either student's
  // real father/mother contact fields is touched.
  const allStudents = await db.students.list(tenantId, {});
  const byAdmission = Object.fromEntries(allStudents.map((s) => [s.admissionNumber, s]));
  const arjun = byAdmission['BFS005'];
  const karan = byAdmission['BFS009'];
  if (arjun && karan) {
    const sharedGuardian = { name: 'Meena Iyer (family friend, listed on both files)', phone: '+91 99887 76655', email: '' };
    await db.students.update(tenantId, arjun.id, { guardians: { ...arjun.guardians, guardian: sharedGuardian } });
    await db.students.update(tenantId, karan.id, { guardians: { ...karan.guardians, guardian: sharedGuardian } });
  }

  // Fee structure -- one published version. Tuition/Books/Sports price
  // every phase actually in use; Aftercare is Early-years-only and priced
  // for it, but genuinely unbilled this run since no active student is in
  // Nursery/LKG/UKG yet -- an honest "defined, not yet needed" head,
  // exactly like Classes & Sections' six unplanned curriculum subjects.
  const draft = await db.feeStructures.createDraft(tenantId, { createdBy: adminId });
  const heads = await db.feeStructureHeads.replaceForStructure(tenantId, draft.id, [
    { name: 'Tuition', type: 'Core', cycle: 'Per term', amountEarlyYears: 8500, amountPrimary: 9800, amountSecondary: 11500, appliesTo: 'All learners' },
    { name: 'Books & Materials', type: 'Core', cycle: 'Per term', amountEarlyYears: 650, amountPrimary: 850, amountSecondary: 1100, appliesTo: 'All learners' },
    { name: 'Sports & Extra-mural', type: 'Optional', cycle: 'Per term', amountEarlyYears: 450, amountPrimary: 600, amountSecondary: 750, appliesTo: 'All learners' },
    { name: 'Aftercare', type: 'Optional', cycle: 'Per term', amountEarlyYears: 1200, amountPrimary: null, amountSecondary: null, appliesTo: 'Early years only' },
  ]);
  await db.feeStructures.publish(tenantId, draft.id);
  await db.audit.record({ event: 'fees.structurePublished', actorId: adminId, target: draft.id, tenantId, summary: { version: 1, heads: heads.length } });

  // Billing schedule -- Term 1 and Term 2 already due (so invoices raised
  // below have real ageing to show across the whole status range, up to
  // and including the "handover" escalation tier), Term 3 due in
  // December and deliberately not yet billed, matching how every other
  // module's "batch" action here is manual and admin-triggered.
  const schedule = [
    { termLabel: 'Term 1', dueDate: '2026-05-15', sharePercent: 40, note: 'Due at the start of Term 1' },
    { termLabel: 'Term 2', dueDate: '2026-08-15', sharePercent: 35, note: 'Due at the start of Term 2' },
    { termLabel: 'Term 3', dueDate: '2026-12-15', sharePercent: 25, note: 'Due at the start of Term 3 -- not yet billed' },
  ];
  for (let i = 0; i < schedule.length; i += 1) {
    await db.feeBillingSchedule.create({ tenantId, orderIndex: i, ...schedule[i] });
  }

  // Raise Term 1, then Term 2 -- both real calls to the same endpoint an
  // admin would use, including the real sibling discount and the real
  // interest true-up run immediately after each (see accrueInterest's
  // header: every overdue invoice, whether or not it's about to be paid
  // off a moment later in this script, genuinely owes that interest as
  // of today -- exactly as it would for a real school digitising an
  // existing arrears book for the first time).
  await raiseInvoicesForTerm(tenantId, 'Term 1', adminId);
  await raiseInvoicesForTerm(tenantId, 'Term 2', adminId);

  const invoiceFor = async (studentId, termLabel) => (await db.feeInvoices.list(tenantId, { studentId })).find((i) => i.termLabel === termLabel);

  // amount: 'full' | 'part' (55%) | undefined (left unpaid). bank: true
  // records a matching bank-statement line so the payment reconciles to
  // Exact and gets confirmed, exactly like a real EFT landing in the
  // account; omitted, the payment sits real but unconfirmed -- the same
  // "unreconciled value" the overview/reconciliation screens are built to
  // surface.
  const plan = [
    { adm: 'BFS001', name: 'Sharma', term1: 'full', term2: 'full', method: 'EFT', bank: true },
    { adm: 'BFS002', name: 'Patel', term1: 'full', term2: undefined, method: 'EFT', bank: false },
    { adm: 'BFS003', name: 'Singh', term1: 'part', term2: undefined, method: 'Card', bank: false },
    { adm: 'BFS004', name: 'Nair', term1: undefined, term2: undefined },
    { adm: 'BFS005', name: 'Gupta', term1: 'part', term2: 'full', method: 'Debit order', bank: true }, // Arjun -- sibling discount on both invoices
    { adm: 'BFS006', name: 'Khan', term1: 'full', term2: 'full', method: 'EFT', bank: true },
    { adm: 'BFS007', name: 'Verma', term1: undefined, term2: undefined }, // -> payment plan below
    { adm: 'BFS008', name: 'Reddy', term1: undefined, term2: undefined }, // -> escalation history below
    { adm: 'BFS009', name: 'Malhotra', term1: undefined, term2: undefined }, // Karan -- no discount, worst arrears
    { adm: 'BFS010', name: 'Roy', term1: 'full', term2: 'part', method: 'Cash', bank: false },
  ];

  let bankRefSeq = 1;
  for (const row of plan) {
    const student = byAdmission[row.adm];
    if (!student) continue;
    for (const [termLabel, mode] of [['Term 1', row.term1], ['Term 2', row.term2]]) {
      if (!mode) continue;
      const invoice = await invoiceFor(student.id, termLabel);
      if (!invoice) continue;
      const view = await getInvoiceView(tenantId, invoice);
      if (view.balance <= 0) continue;
      const amountReceived = mode === 'full' ? view.balance : Number((view.balance * 0.55).toFixed(2));
      const bankReference = `${row.name.toUpperCase()}${bankRefSeq}`;
      bankRefSeq += 1;
      const { payment } = await recordPayment(tenantId, adminId, {
        studentId: student.id, amountReceived, dateReceived: invoice.dueDate < todayStr() ? invoice.dueDate : todayStr(),
        method: row.method || 'EFT', bankReference, allocations: [{ invoiceId: invoice.id, amount: amountReceived }],
      });
      if (row.bank) {
        const line = await db.bankStatementLines.create({
          tenantId, date: payment.dateReceived, reference: bankReference, amount: amountReceived,
          matchedPaymentId: null, confidence: 'None', reviewedBy: null, reviewedAt: null, createdBy: adminId,
        });
        await matchBankLine(tenantId, line);
      }
    }
  }

  // Two more bank lines that don't cleanly resolve -- a same-amount-only
  // "Likely" match still waiting on human review, and a genuinely
  // unidentified deposit ("None") that fee_settings' unmatchedAlert rule
  // exists to chase.
  const diyaTerm1 = await invoiceFor(byAdmission['BFS002'].id, 'Term 1');
  const diyaView = diyaTerm1 ? await getInvoiceView(tenantId, diyaTerm1) : null;
  if (diyaView && diyaView.paidAllocated > 0) {
    const likelyLine = await db.bankStatementLines.create({
      tenantId, date: todayStr(), reference: 'EFT REF UNKNOWN 4471', amount: diyaView.paidAllocated,
      matchedPaymentId: null, confidence: 'None', reviewedBy: null, reviewedAt: null, createdBy: adminId,
    });
    await matchBankLine(tenantId, likelyLine); // same amount as Diya's real unconfirmed payment, different reference -- resolves to "Likely"
  }
  await db.bankStatementLines.create({
    tenantId, date: todayStr(), reference: 'MOBILE DEPOSIT 9021', amount: 500,
    matchedPaymentId: null, confidence: 'None', reviewedBy: null, reviewedAt: null, createdBy: adminId,
  });

  // Payment plan (screen 7) for Ishaan Verma -- a real record against his
  // genuine outstanding balance, three instalments starting a few days
  // out so it reads as "On track" rather than already broken.
  const ishaan = byAdmission['BFS007'];
  if (ishaan) {
    const { owed } = await getStudentBalance(tenantId, ishaan.id);
    if (owed > 0) {
      const startDate = new Date(); startDate.setUTCDate(startDate.getUTCDate() + 5);
      await setupPaymentPlan(tenantId, adminId, ishaan.id, { instalmentCount: 3, startDate: startDate.toISOString().slice(0, 10) });
    }
  }

  // Escalation history (screen 7) -- Ananya already has one reminder on
  // record from three weeks ago; Karan (the older, undiscounted sibling,
  // and the most overdue learner seeded) has both a first and a second
  // reminder already logged, so re-running the ladder finds him queued
  // for the next real step rather than starting cold.
  const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString(); };
  const ananya = byAdmission['BFS008'];
  if (ananya) {
    await db.feeEscalationEvents.create({ tenantId, studentId: ananya.id, invoiceId: null, step: 'first_reminder', note: '', createdBy: adminId, createdAt: daysAgo(21) });
  }
  if (karan) {
    await db.feeEscalationEvents.create({ tenantId, studentId: karan.id, invoiceId: null, step: 'first_reminder', note: '', createdBy: adminId, createdAt: daysAgo(55) });
    await db.feeEscalationEvents.create({ tenantId, studentId: karan.id, invoiceId: null, step: 'second_reminder', note: '', createdBy: adminId, createdAt: daysAgo(25) });
  }

  // Disbursements (screen 8) -- one still awaiting approval, one already
  // approved by a second person (above the two-person threshold, so
  // requester and approver are genuinely different accounts) but not yet
  // paid, and one fully paid with a real proof-of-payment document
  // attached through the same storage adapter seedStaff's documents use.
  await db.feeDisbursements.create({
    tenantId, reference: 'PAY-2026-301', date: todayStr(), payeeName: 'Cape Print & Stationery', reason: 'Term 3 exam booklet printing',
    amount: 2850, method: 'EFT', state: 'Awaiting approval', proofDocumentId: null, requestedBy: adminId, approvedBy: null, decidedAt: null,
  });

  const bigDisbursement = await db.feeDisbursements.create({
    tenantId, reference: 'PAY-2026-302', date: todayStr(), payeeName: 'GreenTurf Sports Surfaces', reason: 'Resurfacing the netball court',
    amount: 18500, method: 'EFT', state: 'Awaiting approval', proofDocumentId: null, requestedBy: subAdminId || adminId, approvedBy: null, decidedAt: null,
  });
  await db.feeDisbursements.update(tenantId, bigDisbursement.id, { state: 'Approved', approvedBy: adminId, decidedAt: new Date().toISOString() });
  await db.audit.record({ event: 'fees.disbursementApproved', actorId: adminId, target: bigDisbursement.id, tenantId, summary: { amount: 18500 } });

  const paidDisbursement = await db.feeDisbursements.create({
    tenantId, reference: 'PAY-2026-303', date: daysAgo(6).slice(0, 10), payeeName: 'City Bus Services', reason: 'Term 2 transport subsidy top-up',
    amount: 4200, method: 'EFT', state: 'Approved', proofDocumentId: null, requestedBy: adminId, approvedBy: adminId, decidedAt: daysAgo(5),
  });
  const proofBuffer = Buffer.from('Placeholder for City Bus Services EFT proof of payment (seed data).', 'utf-8');
  const storageKey = await storage.save({ tenantId, entityType: 'fees', entityId: paidDisbursement.id, fileName: 'PAY-2026-303-proof.pdf', buffer: proofBuffer });
  const proofDoc = await db.documents.create({
    tenantId, entityType: 'fees', entityId: paidDisbursement.id, documentType: 'Proof of payment',
    fileName: 'PAY-2026-303-proof.pdf', storageKey, mimeType: 'application/pdf', sizeBytes: proofBuffer.length, uploadedBy: adminId, expiryDate: null,
  });
  await db.feeDisbursements.update(tenantId, paidDisbursement.id, { proofDocumentId: proofDoc.id, state: 'Paid' });
  await db.audit.record({ event: 'fees.disbursementPaid', actorId: adminId, target: paidDisbursement.id, tenantId, summary: { amount: 4200 } });
}


// Examinations (designs/Teacher feature UI mockup/Examinations.dc.html,
// screens 1-9). See db/schema.sql's Examinations header and the project
// plan doc (edusphere-examinations-module-plan-2026-09-20.md) for the four
// binding decisions this module builds against.
//
// Class 5 is used throughout because among the twelve students seeded in
// seedStudents() it is the only class level with more than one populated,
// active section (three in A, one in B) -- see that function's own header
// note on className/section still being free text, not a real FK yet.
// Three genuine staff_assignments rows are added below (English,
// Mathematics, Science) so every teacher/class-teacher label in this
// module is a real lookup, never a fabricated name -- the same call
// seedClasses() already made for curriculum data, extended here to the
// two sections this module actually needs.
//
// Two cycles are seeded: an older one carried all the way through to
// Published (report cards generated, results released) so screens 7-9
// have real completed data to show, and a current one still mid-flight
// across Datesheet/Structure/Marks entry/Moderation (a draft, a
// submission, an approval and a returned sheet, plus a genuine absent and
// a genuine not-entered mark) so screens 3-6 show every real status a
// sheet or a mark can be in. A fourth subject on the current cycle
// (Hindi) is left with an incomplete component split and no scheduled
// paper on purpose -- a real, honest "entry closed / unscheduled" state,
// not a gap that was missed.
async function seedExams(tenantId) {
  if ((await db.examCycles.list(tenantId)).length > 0) return;

  const CLASS = 'Class 5';
  const allStaff = await db.staff.list(tenantId, {});
  const byEmp = Object.fromEntries(allStaff.map((s) => [s.employeeId, s]));

  const ensureAssignment = async (employeeId, subject, section, periodsPerWeek, role = 'Subject') => {
    const staffMember = byEmp[employeeId];
    if (!staffMember) return;
    const existing = await db.staffAssignments.listForStaff(tenantId, staffMember.id);
    if (existing.some((a) => a.className === CLASS && a.section === section && a.subject === subject)) return;
    await db.staffAssignments.create({ tenantId, staffId: staffMember.id, subject, className: CLASS, section, periodsPerWeek, role });
  };
  await ensureAssignment('EMP-0156', 'English', 'A', 6);
  await ensureAssignment('EMP-0156', 'English', 'B', 6);
  await ensureAssignment('EMP-0188', 'Mathematics', 'A', 8, 'Class teacher');
  await ensureAssignment('EMP-0188', 'Mathematics', 'B', 8);
  await ensureAssignment('EMP-0163', 'Science', 'A', 6);
  await ensureAssignment('EMP-0163', 'Science', 'B', 6);
  const naledi = byEmp['EMP-0188'];
  if (naledi && naledi.classTeacherOf !== `${CLASS} · A`) {
    await db.staff.update(tenantId, naledi.id, { isClassTeacher: true, classTeacherOf: `${CLASS} · A` });
  }

  const studentsA = await db.students.findByClassSection(tenantId, CLASS, 'A');
  const studentsB = await db.students.findByClassSection(tenantId, CLASS, 'B');
  const byFirstName = (list, first) => list.find((s) => s.firstName === first);
  const aarav = byFirstName(studentsA, 'Aarav');
  const meera = byFirstName(studentsA, 'Meera');
  const ananya = byFirstName(studentsA, 'Ananya');
  const diya = byFirstName(studentsB, 'Diya');

  const school = await db.schools.findById(tenantId);
  const fatima = byEmp['EMP-0194'];
  const bongani = byEmp['EMP-0201'];

  const makeStructure = async (cycleId, subjectName, maxMarks, passMarks, components) => {
    const structure = await db.examStructure.create({ tenantId, cycleId, className: CLASS, subjectName, maxMarks, passMarks, weight: 1 });
    for (const [i, c] of components.entries()) {
      await db.examStructureComponents.create({ tenantId, structureId: structure.id, name: c.name, maxMarks: c.maxMarks, passMarks: c.passMarks ?? 0, orderIndex: i });
    }
    return structure;
  };

  // Mirrors the real PUT /cycles/:id/marks logic closely enough for seed
  // purposes: a student passed with no components entered gets a genuine
  // "not_entered" row (not silently skipped), `absent: true` gets a real
  // "absent" row, and a below-pass total gets flagged exactly like the
  // live route would.
  const enterMarks = async (marksheet, structure, entries) => {
    for (const { student, componentMarks = {}, absent } of entries) {
      let total = null; let flag = null;
      if (absent) {
        flag = 'absent';
      } else {
        const values = Object.values(componentMarks);
        if (!values.length) {
          flag = 'not_entered';
        } else {
          total = values.reduce((a, b) => a + b, 0);
          if (total < structure.passMarks) flag = 'below_pass';
        }
      }
      const grade = total != null ? await gradeForPercentage(tenantId, (total / structure.maxMarks) * 100) : null;
      await db.examMarks.create({ tenantId, marksheetId: marksheet.id, studentId: student.id, componentMarks: absent ? {} : componentMarks, total, grade, flag, remark: '' });
    }
    const allMarks = await db.examMarks.list(tenantId, { marksheetId: marksheet.id });
    const stats = computeMarksheetStats(allMarks);
    const passRatePct = passRateFor(allMarks, structure.passMarks);
    await db.examMarksheets.update(tenantId, marksheet.id, { mean: stats.mean, passRatePct, flags: stats.flags });
  };

  // ---- Cycle 1: completed & published -- real results/report cards/audit/parent-preview data ----
  const cycle1 = await db.examCycles.create({
    tenantId, name: 'Unit Test 1', academicTerm: 'Term 2', examType: 'Class test',
    windowOpens: '2026-06-01', windowCloses: '2026-06-05', weightInTermMark: 10,
    classNames: [CLASS], marksEntryCloses: '2026-06-12', entryRolePolicy: 'assigned_teacher',
    stage: 'marking', createdBy: null,
  });
  await db.examAuditLog.record({ event: 'Cycle created', actorId: null, target: cycle1.id, tenantId, cycleId: cycle1.id, detail: `${cycle1.name} created` });

  const c1English = await makeStructure(cycle1.id, 'English', 100, 35, [{ name: 'Theory', maxMarks: 80 }, { name: 'Practical', maxMarks: 20 }]);
  const c1Math = await makeStructure(cycle1.id, 'Mathematics', 100, 35, [{ name: 'Theory', maxMarks: 80 }, { name: 'Practical', maxMarks: 20 }]);

  await db.examSessions.create({ tenantId, cycleId: cycle1.id, className: CLASS, examDate: '2026-06-02', session: 'AM', subject: 'English', venue: 'Hall A', seats: 40, invigilatorStaffId: fatima?.id ?? null, termLabel: cycle1.name, periodSlotId: 'P1', durationMinutes: 90, sectionsIncluded: ['A', 'B'] });
  await db.examSessions.create({ tenantId, cycleId: cycle1.id, className: CLASS, examDate: '2026-06-04', session: 'AM', subject: 'Mathematics', venue: 'Hall A', seats: 40, invigilatorStaffId: bongani?.id ?? null, termLabel: cycle1.name, periodSlotId: 'P1', durationMinutes: 90, sectionsIncluded: ['A', 'B'] });

  const c1EnglishA = await db.examMarksheets.create({ tenantId, cycleId: cycle1.id, className: CLASS, section: 'A', subjectName: 'English', teacherStaffId: byEmp['EMP-0156']?.id ?? null, status: 'draft' });
  await enterMarks(c1EnglishA, c1English, [
    { student: aarav, componentMarks: { Theory: 62, Practical: 16 } },
    { student: meera, componentMarks: { Theory: 68, Practical: 17 } },
    { student: ananya, componentMarks: { Theory: 42, Practical: 13 } },
  ]);
  const c1EnglishB = await db.examMarksheets.create({ tenantId, cycleId: cycle1.id, className: CLASS, section: 'B', subjectName: 'English', teacherStaffId: byEmp['EMP-0156']?.id ?? null, status: 'draft' });
  await enterMarks(c1EnglishB, c1English, [{ student: diya, componentMarks: { Theory: 72, Practical: 18 } }]);

  const c1MathA = await db.examMarksheets.create({ tenantId, cycleId: cycle1.id, className: CLASS, section: 'A', subjectName: 'Mathematics', teacherStaffId: byEmp['EMP-0188']?.id ?? null, status: 'draft' });
  await enterMarks(c1MathA, c1Math, [
    { student: aarav, componentMarks: { Theory: 70, Practical: 18 } },
    { student: meera, componentMarks: { Theory: 60, Practical: 16 } },
    { student: ananya, componentMarks: { Theory: 22, Practical: 8 } }, // 30 -- below the 35 pass mark
  ]);
  const c1MathB = await db.examMarksheets.create({ tenantId, cycleId: cycle1.id, className: CLASS, section: 'B', subjectName: 'Mathematics', teacherStaffId: byEmp['EMP-0188']?.id ?? null, status: 'draft' });
  await enterMarks(c1MathB, c1Math, [{ student: diya, componentMarks: { Theory: 76, Practical: 19 } }]);

  for (const sheet of [c1EnglishA, c1EnglishB, c1MathA, c1MathB]) {
    await db.examMarksheets.update(tenantId, sheet.id, { status: 'submitted', submittedBy: null, submittedAt: '2026-06-06T09:00:00.000Z' });
    await db.examMarksheets.update(tenantId, sheet.id, { status: 'approved', decidedBy: null, decidedAt: '2026-06-07T09:00:00.000Z' });
    await db.examAuditLog.record({ event: 'Sheet approved', actorId: null, cycleId: cycle1.id, tenantId, target: sheet.id, detail: `${sheet.className}·${sheet.section} ${sheet.subjectName} approved` });
  }

  // Class-teacher comments -- Class 5 A has a real class teacher (Naledi,
  // assigned above); Class 5 B genuinely has none yet, so her comment
  // there is filed with no classTeacherStaffId -- the same honest gap
  // documented everywhere else in this codebase rather than a fabricated
  // link.
  const comments1 = [
    [aarav, 'Consistent effort all term; keep practising mental maths.'],
    [meera, 'Excellent participation in class discussions.'],
    [ananya, 'Struggling with core Maths concepts -- recommend extra support sessions.'],
    [diya, 'Settling in well this term, good improvement in written work.'],
  ];
  for (const [student, comment] of comments1) {
    const teacher = await classTeacherFor(tenantId, CLASS, student.section);
    await db.examReportComments.upsert(tenantId, { cycleId: cycle1.id, studentId: student.id, className: CLASS, comment, classTeacherStaffId: teacher?.staffId ?? null });
  }

  // Real per-learner PDFs, generated exactly the way the API's own
  // report-cards/generate route does (same service functions).
  const allC1Students = [...studentsA, ...studentsB];
  const allC1Comments = await db.examReportComments.list(tenantId, { cycleId: cycle1.id });
  let reportCounter = 1;
  for (const student of allC1Students) {
    const rows = [];
    let scoredMax = 0; let scoredTotal = 0;
    for (const [structure, sheetA, sheetB] of [[c1English, c1EnglishA, c1EnglishB], [c1Math, c1MathA, c1MathB]]) {
      const sheet = student.section === 'A' ? sheetA : sheetB;
      const marks = await db.examMarks.list(tenantId, { marksheetId: sheet.id });
      const mark = marks.find((m) => m.studentId === student.id);
      const gradeMean = await gradeWideMean(tenantId, cycle1.id, CLASS, structure.subjectName, student.section);
      rows.push({
        subject: structure.subjectName,
        mark: mark?.total != null ? `${mark.total} / ${structure.maxMarks}` : 'Pending',
        grade: mark?.grade || '—', mean: gradeMean != null ? String(gradeMean) : '—', comment: mark?.remark || '',
      });
      if (mark?.total != null) { scoredMax += structure.maxMarks; scoredTotal += Number(mark.total); }
    }
    const aggregatePct = scoredMax ? Number((scoredTotal * 100 / scoredMax).toFixed(1)) : null;
    const history = await db.attendance.findByStudent(tenantId, student.id);
    const attendancePct = computePercentage(history);
    const own = allC1Comments.find((c) => c.studentId === student.id);
    const classTeacher = own?.classTeacherStaffId ? await db.staff.findById(tenantId, own.classTeacherStaffId) : null;
    const buffer = await generateReportCardPdf({
      tenant: school, cycle: cycle1, student, className: CLASS, section: student.section, rows,
      aggregatePct, position: null, totalLearners: allC1Students.length, attendancePct,
      classTeacherName: classTeacher ? `${classTeacher.firstName} ${classTeacher.lastName}` : null,
      classTeacherComment: own?.comment || '', reportNo: `R-Class5-${String(reportCounter).padStart(3, '0')}`,
    });
    reportCounter += 1;
    await storeReportCardPdf(tenantId, student.id, buffer, null);
  }
  await db.examAuditLog.record({ event: 'Report cards generated', actorId: null, cycleId: cycle1.id, tenantId, target: cycle1.id, detail: `${allC1Students.length} report card(s) generated for ${CLASS}` });

  await db.examCycles.update(tenantId, cycle1.id, { stage: 'published', publishSettings: { showGradeWideAverage: true, showAttendance: true }, updatedAt: new Date().toISOString() });
  await db.examAuditLog.record({ event: 'Results published', actorId: null, cycleId: cycle1.id, tenantId, target: cycle1.id, detail: `${cycle1.name} released to parent portal (4 approved marksheets)` });
  await db.audit.record({ event: 'exams.resultsPublished', actorId: null, target: cycle1.id, tenantId, summary: { approvedCount: 4 } });

  // ---- Cycle 2: current, mid-flight -- real Datesheet/Structure/Marks entry/Moderation data ----
  const cycle2 = await db.examCycles.create({
    tenantId, name: 'Mid-Term Examination', academicTerm: 'Term 2', examType: 'Mid-term',
    windowOpens: '2026-09-01', windowCloses: '2026-09-15', weightInTermMark: 30,
    classNames: [CLASS], marksEntryCloses: '2026-09-30', entryRolePolicy: 'assigned_teacher',
    stage: 'marking', createdBy: null,
  });
  await db.examAuditLog.record({ event: 'Cycle created', actorId: null, target: cycle2.id, tenantId, cycleId: cycle2.id, detail: `${cycle2.name} created` });

  const c2English = await makeStructure(cycle2.id, 'English', 100, 35, [{ name: 'Theory', maxMarks: 80 }, { name: 'Practical', maxMarks: 20 }]);
  const c2Math = await makeStructure(cycle2.id, 'Mathematics', 100, 35, [{ name: 'Theory', maxMarks: 80 }, { name: 'Practical', maxMarks: 20 }]);
  const c2Science = await makeStructure(cycle2.id, 'Science', 50, 18, [{ name: 'Theory', maxMarks: 35 }, { name: 'Practical', maxMarks: 15 }]);
  // Hindi's components are left deliberately short of its own maximum (30
  // of 50) -- a real, still-incomplete structure, so Overview's "structure
  // incomplete" blocker and the Datesheet's "Unscheduled" row both have
  // something genuine to show, exactly like an admin who hasn't finished
  // setting it up yet.
  await makeStructure(cycle2.id, 'Hindi', 50, 18, [{ name: 'Written', maxMarks: 30 }]);

  await db.examSessions.create({ tenantId, cycleId: cycle2.id, className: CLASS, examDate: '2026-09-08', session: 'AM', subject: 'English', venue: 'Hall A', seats: 40, invigilatorStaffId: fatima?.id ?? null, termLabel: cycle2.name, periodSlotId: 'P1', durationMinutes: 90, sectionsIncluded: ['A', 'B'] });
  await db.examSessions.create({ tenantId, cycleId: cycle2.id, className: CLASS, examDate: '2026-09-10', session: 'AM', subject: 'Mathematics', venue: 'Hall A', seats: 40, invigilatorStaffId: bongani?.id ?? null, termLabel: cycle2.name, periodSlotId: 'P1', durationMinutes: 90, sectionsIncluded: ['A', 'B'] });
  await db.examSessions.create({ tenantId, cycleId: cycle2.id, className: CLASS, examDate: '2026-09-12', session: 'PM', subject: 'Science', venue: 'Lab 1', seats: 40, invigilatorStaffId: fatima?.id ?? null, termLabel: cycle2.name, periodSlotId: 'P6', durationMinutes: 60, sectionsIncluded: ['A', 'B'] });
  await db.examAuditLog.record({ event: 'Datesheet published', actorId: null, target: cycle2.id, tenantId, cycleId: cycle2.id, detail: 'Marks entry is now open' });

  const c2EnglishA = await db.examMarksheets.create({ tenantId, cycleId: cycle2.id, className: CLASS, section: 'A', subjectName: 'English', teacherStaffId: byEmp['EMP-0156']?.id ?? null, status: 'draft' });
  await enterMarks(c2EnglishA, c2English, [
    { student: aarav, componentMarks: { Theory: 65, Practical: 17 } },
    { student: meera, componentMarks: { Theory: 70, Practical: 18 } },
    { student: ananya, componentMarks: { Theory: 45, Practical: 14 } },
  ]);
  await db.examMarksheets.update(tenantId, c2EnglishA.id, { status: 'submitted', submittedBy: null, submittedAt: '2026-09-13T09:00:00.000Z' });
  await db.examMarksheets.update(tenantId, c2EnglishA.id, { status: 'approved', decidedBy: null, decidedAt: '2026-09-14T09:00:00.000Z' });
  await db.examAuditLog.record({ event: 'Sheet approved', actorId: null, cycleId: cycle2.id, tenantId, target: c2EnglishA.id, detail: `${CLASS}·A English approved` });

  const c2EnglishB = await db.examMarksheets.create({ tenantId, cycleId: cycle2.id, className: CLASS, section: 'B', subjectName: 'English', teacherStaffId: byEmp['EMP-0156']?.id ?? null, status: 'draft' });
  await enterMarks(c2EnglishB, c2English, [{ student: diya, componentMarks: { Theory: 74, Practical: 19 } }]);
  await db.examMarksheets.update(tenantId, c2EnglishB.id, { status: 'submitted', submittedBy: null, submittedAt: '2026-09-13T10:00:00.000Z' });
  await db.examAuditLog.record({ event: 'Sheet submitted', actorId: null, cycleId: cycle2.id, tenantId, target: c2EnglishB.id, detail: `${CLASS}·B English submitted` });

  const c2MathA = await db.examMarksheets.create({ tenantId, cycleId: cycle2.id, className: CLASS, section: 'A', subjectName: 'Mathematics', teacherStaffId: byEmp['EMP-0188']?.id ?? null, status: 'draft' });
  await enterMarks(c2MathA, c2Math, [
    { student: aarav, componentMarks: { Theory: 72, Practical: 18 } },
    { student: meera, componentMarks: { Theory: 58, Practical: 15 } },
    { student: ananya, componentMarks: {}, absent: true },
  ]);
  await db.examMarksheets.update(tenantId, c2MathA.id, { status: 'submitted', submittedBy: null, submittedAt: '2026-09-13T11:00:00.000Z' });
  await db.examMarksheets.update(tenantId, c2MathA.id, { status: 'returned', decidedBy: null, decidedAt: '2026-09-14T09:30:00.000Z', reviewerNote: 'Please confirm Ananya’s absent mark against the invigilator’s sheet before resubmitting.' });
  await db.examAuditLog.record({ event: 'Sheet returned', actorId: null, cycleId: cycle2.id, tenantId, target: c2MathA.id, detail: `${CLASS}·A Mathematics returned -- confirm Ananya's absence` });

  // Mathematics B is left in draft -- the teacher hasn't submitted yet, a
  // real, ordinary "still being marked" state.
  const c2MathB = await db.examMarksheets.create({ tenantId, cycleId: cycle2.id, className: CLASS, section: 'B', subjectName: 'Mathematics', teacherStaffId: byEmp['EMP-0188']?.id ?? null, status: 'draft' });
  await enterMarks(c2MathB, c2Math, [{ student: diya, componentMarks: { Theory: 66, Practical: 17 } }]);

  // Ananya's Science mark is entered as a genuine explicit blank
  // ("not_entered", distinct from "absent") so the Marks entry screen's
  // blank count has something real to show.
  const c2ScienceA = await db.examMarksheets.create({ tenantId, cycleId: cycle2.id, className: CLASS, section: 'A', subjectName: 'Science', teacherStaffId: byEmp['EMP-0163']?.id ?? null, status: 'draft' });
  await enterMarks(c2ScienceA, c2Science, [
    { student: aarav, componentMarks: { Theory: 26, Practical: 11 } },
    { student: meera, componentMarks: { Theory: 30, Practical: 12 } },
    { student: ananya, componentMarks: {} },
  ]);
  await db.examMarksheets.update(tenantId, c2ScienceA.id, { status: 'submitted', submittedBy: null, submittedAt: '2026-09-13T12:00:00.000Z' });
  await db.examAuditLog.record({ event: 'Sheet submitted', actorId: null, cycleId: cycle2.id, tenantId, target: c2ScienceA.id, detail: `${CLASS}·A Science submitted` });

  // Science B genuinely has nothing entered yet -- a plain, still-open
  // draft, left exactly as the GET marks endpoint would first create it.
  await db.examMarksheets.create({ tenantId, cycleId: cycle2.id, className: CLASS, section: 'B', subjectName: 'Science', teacherStaffId: byEmp['EMP-0163']?.id ?? null, status: 'draft' });
}

// Parent Registry (see "Parent Registry Blueprint" plan artifact,
// 2026-09-20, and modules/parents/service.js's own header). Runs the real
// backfillFromGuardians() migration against the students already seeded
// above -- the exact same function the "Backfill" button/route uses, not
// a separate seed-only copy -- so first login already has real parents +
// parent_student_links data instead of an empty registry. Honest note:
// none of the seeded students in this codebase are actual siblings of
// each other, so this produces one parent per real guardian contact
// rather than demonstrating the "two siblings share a parent" merge
// scenario -- that path is real and exercised by the module's own
// dedupe-search/merge routes, just not by this particular seed data.
async function seedParents(tenantId) {
  if ((await db.parents.list(tenantId, {})).length > 0) return;
  await backfillFromGuardians(tenantId, null);
}

// Notices & Communication (edusphere-notices-communication-module-plan-
// 2026-09-22.md). A believable spread across every computed status
// (draft/scheduled/published/expired/archived) and every audience type,
// so the Notice Board isn't empty on first login and every UI state
// (including the acknowledgement log) has something real to show.
// Dates are computed relative to "now" rather than hard-coded, so this
// stays correct no matter when the seed actually runs.
async function seedNotices(tenantId) {
  if ((await db.notices.list(tenantId, {})).length > 0) return;

  const admin = await db.users.findByEmail('admin@brightfuture.edu');
  const students = await db.students.list(tenantId, {});
  const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString();

  const published = await db.notices.create({
    tenantId, title: 'School reopens Monday after the mid-term break', category: 'announcement',
    description: 'Classes resume for all grades on Monday. Please ensure students carry their updated timetable and any outstanding fee receipts.',
    audienceType: 'entire_school', audienceRole: null, audienceClassName: null, audienceSection: null,
    audienceRecipientType: null, audienceRecipientId: null,
    publishAt: daysFromNow(-3), expiryAt: daysFromNow(4), isDraft: false, isArchived: false, createdBy: admin.id,
  });
  await db.noticeAcknowledgements.create({
    tenantId, noticeId: published.id, recipientLabel: 'Class 10 · B parents (WhatsApp group)',
    method: 'phone', note: 'Confirmed with the class WhatsApp group admin.', recordedBy: admin.id,
  });

  await db.notices.create({
    tenantId, title: 'Annual Sports Day', category: 'event',
    description: 'Class 10 · A will be participating in the inter-house athletics events. Sports uniform is compulsory for all participants.',
    audienceType: 'class', audienceRole: null, audienceClassName: 'Class 10', audienceSection: 'A',
    audienceRecipientType: null, audienceRecipientId: null,
    publishAt: daysFromNow(5), expiryAt: daysFromNow(6), isDraft: false, isArchived: false, createdBy: admin.id,
  });

  await db.notices.create({
    tenantId, title: 'Revised fee payment deadline circular', category: 'circular',
    description: 'The Q3 fee payment deadline has been moved up by one week ahead of the new term. Please refer to the updated billing schedule.',
    audienceType: 'role', audienceRole: 'parent', audienceClassName: null, audienceSection: null,
    audienceRecipientType: null, audienceRecipientId: null,
    publishAt: daysFromNow(-20), expiryAt: daysFromNow(-2), isDraft: false, isArchived: false, createdBy: admin.id,
  });

  await db.notices.create({
    tenantId, title: 'Staff meeting agenda -- draft', category: 'notice',
    description: 'Draft agenda for the upcoming staff meeting: exam scheduling, timetable clashes for Term 2, and the new attendance settings.',
    audienceType: 'role', audienceRole: 'teacher', audienceClassName: null, audienceSection: null,
    audienceRecipientType: null, audienceRecipientId: null,
    publishAt: daysFromNow(2), expiryAt: null, isDraft: true, isArchived: false, createdBy: admin.id,
  });

  if (students[0]) {
    await db.notices.create({
      tenantId, title: `Fee arrears reminder for ${students[0].firstName} ${students[0].lastName}`, category: 'notice',
      description: 'A one-off reminder sent directly regarding an outstanding balance on this student\'s fee ledger.',
      audienceType: 'individual', audienceRole: null, audienceClassName: null, audienceSection: null,
      audienceRecipientType: 'student', audienceRecipientId: students[0].id,
      publishAt: daysFromNow(-10), expiryAt: null, isDraft: false, isArchived: true, createdBy: admin.id,
    });
  }
}

// Settings module (edusphere-settings-module-plan-2026-09-23.md) --
// seeds one security_policies row per tenant using exactly the defaults
// SECURITY_POLICY_DEFAULTS in modules/settings/service.js already falls
// back to when a row is missing, so this call is purely for a real,
// non-empty row to show/edit on the Security Policy screen from first
// login -- it changes no actual enforced behaviour versus having no row.
async function seedSecurityPolicy(tenantId) {
  const existing = await db.securityPolicies.get(tenantId);
  if (existing) return;
  await db.securityPolicies.upsert(tenantId, {
    minPasswordLength: 8,
    requireUppercase: false,
    requireNumber: false,
    requireSymbol: false,
    passwordExpiryDays: 0,
    sessionTimeoutMinutes: 480,
    maxFailedLoginAttempts: 5,
    lockoutDurationMinutes: 15,
  });
}

// Payroll (edusphere-staff-payroll-build-2026-09-24.md): a pay setup for
// most staff, one approved unpaid-leave day in August so the leave
// deduction is visible, and August 2026 already run, finalised and marked
// paid -- so the Payroll summary isn't empty on first login, while the
// current month is left for the admin to run. Deliberate gaps so the
// exception list has something real to show: Kagiso Molefe has no pay
// setup at all, Bongani Zulu's bank details are unverified. Amounts are
// illustrative monthly ZAR figures; deductions are admin-entered (no tax
// tables), matching the module's scope.
async function seedPayroll(tenantId) {
  if ((await db.payrollRuns.list(tenantId)).length || (await db.payProfiles.list(tenantId)).length) return;
  const staff = await db.staff.list(tenantId, {});
  const byEmp = Object.fromEntries(staff.map((s) => [s.employeeId, s]));

  const standardDeductions = (pension = 7.5) => [
    { label: 'PAYE (as captured)', type: 'percent', value: 18 },
    { label: 'UIF', type: 'percent', value: 1 },
    { label: 'Pension fund', type: 'percent', value: pension },
    { label: 'Medical aid', type: 'fixed', value: 1850 },
  ];
  const bank = (holder, bankName, accountNumber, verified = true) => ({ accountHolder: holder, bankName, accountNumber, branchCode: '250655', verified });
  const setups = [
    ['EMP-0142', 42500, [{ label: 'Head of subject allowance', amount: 2500 }], standardDeductions(), bank('T Ndlovu', 'FNB', '62845510234')],
    ['EMP-0156', 31800, [], standardDeductions(), bank('S Maseko', 'Capitec', '1398822045')],
    ['EMP-0163', 48900, [{ label: 'HOD allowance', amount: 4000 }], standardDeductions(), bank('L Dube', 'Standard Bank', '10127733561')],
    ['EMP-0171', 32600, [], standardDeductions(), bank('J Pretorius', 'ABSA', '4077120931')],
    ['EMP-0188', 27400, [], standardDeductions(5), bank('N Khumalo', 'Capitec', '1502774309')],
    ['EMP-0194', 21500, [{ label: 'Transport allowance', amount: 900 }], standardDeductions(5), bank('F Patel', 'Nedbank', '1198456602')],
    ['EMP-0201', 18900, [{ label: 'Transport allowance', amount: 900 }], standardDeductions(5), bank('B Zulu', 'FNB', '62901133478', false)],
    ['EMP-0225', 30400, [], standardDeductions(), bank('P Naidoo', 'Standard Bank', '10144982270')],
  ];
  for (const [employeeId, basicSalary, allowances, deductions, bankDetails] of setups) {
    const member = byEmp[employeeId];
    if (!member) continue;
    await db.payProfiles.upsert(tenantId, member.id, { basicSalary, allowances, deductions, bank: bankDetails, updatedBy: null, updatedAt: new Date().toISOString() });
  }

  if (byEmp['EMP-0225']) {
    const record = await db.staffLeave.create({ tenantId, staffId: byEmp['EMP-0225'].id, leaveType: 'Unpaid leave', startDate: '2026-08-17', endDate: '2026-08-17', daysCount: 1, reason: 'Personal day beyond annual allowance.' });
    await db.staffLeave.decide(tenantId, record.id, { status: 'approved', decidedBy: null });
  }

  const run = await db.payrollRuns.create({ tenantId, period: '2026-08', status: 'draft', totals: null, missingProfiles: [], createdBy: null });
  await calculateRun(tenantId, run);
  await db.payrollRuns.update(tenantId, run.id, {
    status: 'paid', finalisedAt: '2026-08-24T09:00:00.000Z', finalisedBy: null,
    paidOn: '2026-08-25', paidReference: 'EFT batch AUG-2026', paidAt: '2026-08-25T10:30:00.000Z', paidBy: null,
  });
}
