import crypto from 'node:crypto';

// Zero-setup development adapter. Implements the exact same repository
// contract as adapters/mysqlAdapter.js and adapters/mongoAdapter.js so the
// rest of the codebase never knows (or cares) which one is active — see
// db/index.js. Nothing here is meant to run in production; it exists so the
// API is fully runnable and testable before a real database is connected.
export function createMemoryAdapter() {
  const state = {
    schools: [],
    roles: [],
    schoolEntitlements: [],
    users: [],
    students: [],
    attendance: [],
    attendanceHistory: [],
    documents: [],
    audit: [],
    notices: [],
    noticeAcknowledgements: [],
    // School Setup (see context-memory/gap-analysis-2026-09-14.md + the
    // "School Setup - All Related Screens" design): one settings row per
    // tenant holding every profile/preference section as its own key, plus
    // five simple tenant-scoped list collections.
    schoolProfiles: [],
    securityPolicies: [],
    academicYears: [],
    academicTerms: [],
    subjects: [],
    holidays: [],
    grades: [],
    feeTypes: [],
    // Teachers & Staff
    staff: [],
    staffAssignments: [],
    staffLeave: [],
    // Payroll (see schema.sql's Payroll header)
    payProfiles: [],
    payrollRuns: [],
    payslips: [],
    // Timetable (see schema.sql's table comments for the full design)
    timetableConfig: [],
    timetableVenues: [],
    timetableVersions: [],
    timetableEntries: [],
    timetableRuns: [],
    examSessions: [],
    timetableRelief: [],
    // Classes & Sections
    classLevels: [],
    classSections: [],
    classWaitlist: [],
    classCurriculum: [],
    classPromotionRuns: [],
    classStructureSettings: [],
    // Attendance module additions (settings, backdated-correction
    // approval queue, period-level marks, defaulter interventions)
    attendanceSettings: [],
    attendanceCorrectionRequests: [],
    attendancePeriods: [],
    attendanceInterventions: [],
    // Examinations module additions -- exam_sessions above is extended
    // (cycleId/periodSlotId/durationMinutes/sectionsIncluded), not
    // duplicated. See schema.sql's Examinations header for the full
    // rationale and db/seed.js's seedExams() for what a real cycle looks
    // like end to end.
    examCycles: [],
    examStructure: [],
    examStructureComponents: [],
    examMarksheets: [],
    examMarks: [],
    examReportComments: [],
    examAuditLog: [],
    // Parent Registry -- see modules/parents/service.js's header for the
    // full design rationale.
    parents: [],
    parentStudentLinks: [],
    // Fees & Payments module additions (see schema.sql's Fees & Payments
    // header). fee_types (School Setup) is untouched -- this is a
    // separate, richer, versioned model, per the project plan doc.
    feeStructures: [],
    feeStructureHeads: [],
    feeBillingSchedule: [],
    feeStructureRules: [],
    feeInvoices: [],
    feeInvoiceLines: [],
    feePayments: [],
    feePaymentAllocations: [],
    feePaymentPlans: [],
    bankStatementLines: [],
    feeDisbursements: [],
    feeEscalationEvents: [],
    feeSettings: [],
  };

  // Shared shape for the six simple "list of records, scoped to a tenant"
  // collections above (academicYears gets one extra method, setCurrent).
  // Kept generic here so mysqlAdapter/mongoAdapter can each implement the
  // exact same contract however suits their storage.
  function simpleCollection(key) {
    return {
      async list(tenantId, extraFilter = {}) {
        return state[key].filter((r) =>
          r.tenantId === tenantId &&
          Object.entries(extraFilter).every(([k, v]) => v === undefined || v === null || r[k] === v));
      },
      async findById(tenantId, recordId) {
        return state[key].find((r) => r.id === recordId && r.tenantId === tenantId) || null;
      },
      async create(payload) {
        const record = { id: id(), createdAt: new Date().toISOString(), ...payload };
        state[key].push(record);
        return record;
      },
      async update(tenantId, recordId, patch) {
        const record = state[key].find((r) => r.id === recordId && r.tenantId === tenantId);
        if (!record) return null;
        Object.assign(record, patch);
        return record;
      },
      async remove(tenantId, recordId) {
        const index = state[key].findIndex((r) => r.id === recordId && r.tenantId === tenantId);
        if (index < 0) return false;
        state[key].splice(index, 1);
        return true;
      },
    };
  }

  const PROFILE_SECTIONS = ['basicInfo', 'contact', 'address', 'branding', 'bank', 'registration', 'social', 'promotion', 'preferences'];
  function emptyProfile(tenantId) {
    const profile = { tenantId, updatedAt: null };
    for (const section of PROFILE_SECTIONS) profile[section] = {};
    return profile;
  }

  const id = () => crypto.randomUUID();

  return {
    driver: 'memory',
    async ready() {}, // memory needs no connection/migration step
    _state: state, // exposed for the seed script only

    schools: {
      async list() { return state.schools; },
      async findById(schoolId) { return state.schools.find((s) => s.id === schoolId) || null; },
      async findBySlug(slug) { return state.schools.find((s) => s.slug === slug) || null; },
      async create({ name, slug }) {
        const school = { id: id(), name, slug, active: true, createdAt: new Date().toISOString() };
        state.schools.push(school);
        return school;
      },
    },

    roles: {
      // tenantId === null selects platform-level roles (e.g. super_admin).
      async list(tenantId) { return state.roles.filter((r) => r.tenantId === tenantId || r.tenantId === null); },
      async findByKey(tenantId, key) {
        return state.roles.find((r) => r.key === key && (r.tenantId === tenantId || r.tenantId === null)) || null;
      },
      async permissionsForKeys(tenantId, keys) {
        const roles = state.roles.filter((r) => keys.includes(r.key) && (r.tenantId === tenantId || r.tenantId === null));
        return [...new Set(roles.flatMap((r) => r.permissions))];
      },
      async create({ tenantId, key, name, permissions, isSystem = false }) {
        const role = { id: id(), tenantId, key, name, permissions, isSystem };
        state.roles.push(role);
        return role;
      },
      async updatePermissions(tenantId, key, permissions) {
        const role = state.roles.find((r) => r.key === key && r.tenantId === tenantId);
        if (!role) return null;
        role.permissions = permissions;
        return role;
      },
    },

    // Tier one of the two-tier RBAC model -- see core/entitlements.js.
    // One row per (tenantId, featureKey); upsert rather than a separate
    // create/update pair since a school either already has a decision
    // recorded for a feature or doesn't.
    schoolEntitlements: {
      async list(tenantId) { return state.schoolEntitlements.filter((e) => e.tenantId === tenantId); },
      async listAll() { return state.schoolEntitlements; },
      async upsert({ tenantId, featureKey, enabled, updatedBy }) {
        let row = state.schoolEntitlements.find((e) => e.tenantId === tenantId && e.featureKey === featureKey);
        const updatedAt = new Date().toISOString();
        if (row) {
          row.enabled = enabled;
          row.updatedBy = updatedBy;
          row.updatedAt = updatedAt;
        } else {
          row = { id: id(), tenantId, featureKey, enabled, updatedBy, updatedAt };
          state.schoolEntitlements.push(row);
        }
        return row;
      },
    },

    users: {
      async findByEmail(email) { return state.users.find((u) => u.email === email.toLowerCase()) || null; },
      async findById(userId) { return state.users.find((u) => u.id === userId) || null; },
      async listByTenant(tenantId) { return state.users.filter((u) => u.tenantId === tenantId); },
      async create({ tenantId, email, passwordHash, fullName, roleKeys, status = 'active' }) {
        const user = {
          id: id(), tenantId, email: email.toLowerCase(), passwordHash, fullName, phone: null,
          roleKeys, status, lastLoginAt: null, failedLoginAttempts: 0, lockedUntil: null,
          createdAt: new Date().toISOString(),
        };
        state.users.push(user);
        return user;
      },
      // A successful login clears any lockout state, same call as
      // recording the login timestamp -- see auth/service.js's login().
      async recordLogin(userId) {
        const user = state.users.find((u) => u.id === userId);
        if (user) {
          user.lastLoginAt = new Date().toISOString();
          user.failedLoginAttempts = 0;
          user.lockedUntil = null;
        }
      },
      async setStatus(tenantId, userId, status) {
        const user = state.users.find((u) => u.id === userId && u.tenantId === tenantId);
        if (!user) return null;
        user.status = status;
        return user;
      },
      async setRoles(tenantId, userId, roleKeys) {
        const user = state.users.find((u) => u.id === userId && u.tenantId === tenantId);
        if (!user) return null;
        user.roleKeys = roleKeys;
        return user;
      },
      // My Account (Settings module) -- editable self-service profile
      // fields, scoped by tenantId same as setStatus/setRoles above.
      async updateProfile(tenantId, userId, patch) {
        const user = state.users.find((u) => u.id === userId && u.tenantId === tenantId);
        if (!user) return null;
        Object.assign(user, patch);
        return user;
      },
      // Password/lockout fields -- scoped by userId only, same precedent
      // as recordLogin above (acting on the verified caller's own id,
      // no tenant check needed since a JWT's `sub` already identifies
      // exactly one user regardless of tenant).
      async updateSecurity(userId, patch) {
        const user = state.users.find((u) => u.id === userId);
        if (!user) return null;
        Object.assign(user, patch);
        return user;
      },
    },

    students: {
      async list(tenantId, { query = '', className, section, status } = {}) {
        const q = query.toLowerCase();
        return state.students.filter((s) =>
          s.tenantId === tenantId &&
          (!className || s.className === className) &&
          (!section || s.section === section) &&
          (!status || s.status === status) &&
          `${s.firstName} ${s.lastName} ${s.admissionNumber}`.toLowerCase().includes(q));
      },
      async findById(tenantId, studentId) {
        return state.students.find((s) => s.id === studentId && s.tenantId === tenantId) || null;
      },
      async findByClassSection(tenantId, className, section) {
        return state.students.filter((s) => s.tenantId === tenantId && s.status === 'active' && s.className === className && s.section === section);
      },
      async existsByAdmissionNumber(tenantId, admissionNumber) {
        return state.students.some((s) => s.tenantId === tenantId && s.admissionNumber === admissionNumber);
      },
      async create(student) {
        const record = { id: id(), status: 'active', ...student };
        state.students.push(record);
        return record;
      },
      async archive(tenantId, studentId) {
        const student = state.students.find((s) => s.id === studentId && s.tenantId === tenantId);
        if (!student) return null;
        student.status = 'archived';
        return student;
      },
      async update(tenantId, studentId, patch) {
        const student = state.students.find((s) => s.id === studentId && s.tenantId === tenantId);
        if (!student) return null;
        Object.assign(student, patch, { updatedAt: new Date().toISOString() });
        return student;
      },
      async withdraw(tenantId, studentId, withdrawal) {
        const student = state.students.find((s) => s.id === studentId && s.tenantId === tenantId);
        if (!student) return null;
        student.status = 'withdrawn';
        student.withdrawal = withdrawal;
        student.updatedAt = new Date().toISOString();
        return student;
      },
      async transfer(tenantId, studentId, transfer) {
        const student = state.students.find((s) => s.id === studentId && s.tenantId === tenantId);
        if (!student) return null;
        student.status = 'transferred';
        student.transfer = transfer;
        student.updatedAt = new Date().toISOString();
        return student;
      },
    },

    attendance: {
      async findMatching(tenantId, date, className, section) {
        return state.attendance.filter((a) => a.tenantId === tenantId && a.date === date && a.className === className && a.section === section);
      },
      async findByStudent(tenantId, studentId) {
        return state.attendance.filter((a) => a.tenantId === tenantId && a.studentId === studentId).sort((a, b) => b.date.localeCompare(a.date));
      },
      async summary(tenantId, { date, className, section }) {
        return state.attendance.filter((a) => a.tenantId === tenantId && a.date === date && (!className || a.className === className) && (!section || a.section === section));
      },
      async upsertMany(tenantId, { date, className, section, records, actorId }) {
        const now = new Date().toISOString();
        const saved = [];
        for (const item of records) {
          const index = state.attendance.findIndex((a) => a.tenantId === tenantId && a.date === date && a.className === className && a.section === section && a.studentId === item.studentId);
          const before = index < 0 ? null : { ...state.attendance[index] };
          const after = {
            id: before?.id || id(), tenantId, date, className, section, studentId: item.studentId,
            status: item.status, remark: item.remark?.trim() || '',
            createdBy: before?.createdBy || actorId, createdAt: before?.createdAt || now,
            updatedBy: actorId, updatedAt: now,
          };
          if (index < 0) state.attendance.push(after); else state.attendance[index] = after;
          state.attendanceHistory.unshift({ id: id(), tenantId, attendanceId: after.id, action: before ? 'updated' : 'created', actorId, before, after: { ...after }, at: now });
          saved.push(after);
        }
        return saved;
      },
      // Full correction trail for this tenant, newest first -- backs the
      // Corrections History screen. Raw rows only; the route decides what
      // counts as a "correction" (edit after the lock / backdated) versus
      // an ordinary first-time mark, since that's presentation logic, not
      // storage logic.
      async history(tenantId) {
        return state.attendanceHistory.filter((h) => h.tenantId === tenantId).sort((a, b) => (a.at < b.at ? 1 : -1));
      },
    },

    // Backdated corrections (screen 7/9): a request sits here pending
    // until someone holding attendance.correction.approve decides it. See
    // modules/attendance/routes.js for the full decide flow.
    attendanceCorrectionRequests: {
      async list(tenantId, { status } = {}) {
        return state.attendanceCorrectionRequests
          .filter((r) => r.tenantId === tenantId && (!status || r.status === status))
          .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
      },
      async findById(tenantId, requestId) {
        return state.attendanceCorrectionRequests.find((r) => r.id === requestId && r.tenantId === tenantId) || null;
      },
      async create(payload) {
        const record = { id: id(), status: 'pending', ...payload };
        state.attendanceCorrectionRequests.push(record);
        return record;
      },
      async decide(tenantId, requestId, { status, decidedBy, decisionNote }) {
        const record = state.attendanceCorrectionRequests.find((r) => r.id === requestId && r.tenantId === tenantId);
        if (!record) return null;
        record.status = status;
        record.decidedBy = decidedBy;
        record.decidedAt = new Date().toISOString();
        record.decisionNote = decisionNote || null;
        return record;
      },
    },

    // Period-wise attendance (screen 3) -- a separate table from the daily
    // register, deliberately keyed by (student, date, slot) rather than
    // just (student, date) since a learner can have a different mark per
    // period in the same day.
    attendancePeriods: {
      async findForDay(tenantId, date, className, section) {
        return state.attendancePeriods.filter((p) => p.tenantId === tenantId && p.date === date && p.className === className && p.section === section);
      },
      async upsertMany(tenantId, { date, slotId, className, section, subject, records, actorId }) {
        const now = new Date().toISOString();
        const saved = [];
        for (const item of records) {
          const index = state.attendancePeriods.findIndex(
            (p) => p.tenantId === tenantId && p.date === date && p.slotId === slotId && p.studentId === item.studentId);
          const existing = index < 0 ? null : state.attendancePeriods[index];
          const after = {
            id: existing?.id || id(), tenantId, date, slotId, className, section, subject,
            studentId: item.studentId, status: item.status, remark: item.remark?.trim() || '',
            createdBy: existing?.createdBy || actorId, createdAt: existing?.createdAt || now,
            updatedBy: actorId, updatedAt: now,
          };
          if (index < 0) state.attendancePeriods.push(after); else state.attendancePeriods[index] = after;
          saved.push(after);
        }
        return saved;
      },
    },

    // Defaulter/at-risk interventions (screens 5/6) -- a real tracked
    // action log (stage/date/actor). No letter/SMS/email is actually sent;
    // see routes.js header for why (no Notices & Communication backend
    // exists yet in this codebase).
    attendanceInterventions: simpleCollection('attendanceInterventions'),

    // Examinations (designs/Teacher feature UI mockup/Examinations.dc.html).
    // exam_sessions itself (the Datesheet, screen 3) lives further down,
    // extended in place -- see that block's own comment.
    examCycles: simpleCollection('examCycles'),

    examStructure: {
      ...simpleCollection('examStructure'),
      async findOne(tenantId, { cycleId, className, subjectName }) {
        return state.examStructure.find((s) =>
          s.tenantId === tenantId && s.cycleId === cycleId && s.className === className && s.subjectName === subjectName) || null;
      },
    },
    examStructureComponents: simpleCollection('examStructureComponents'),

    examMarksheets: {
      ...simpleCollection('examMarksheets'),
      async findOne(tenantId, { cycleId, className, section, subjectName }) {
        return state.examMarksheets.find((m) =>
          m.tenantId === tenantId && m.cycleId === cycleId && m.className === className &&
          m.section === section && m.subjectName === subjectName) || null;
      },
    },
    examMarks: {
      ...simpleCollection('examMarks'),
      async findOne(tenantId, { marksheetId, studentId }) {
        return state.examMarks.find((m) => m.tenantId === tenantId && m.marksheetId === marksheetId && m.studentId === studentId) || null;
      },
    },

    // One row per cycle+student -- upsert-by-lookup rather than the
    // generic create/update-by-id contract, since the UI always means
    // "set this student's comment for this cycle", never "create a new
    // comment row".
    examReportComments: {
      async list(tenantId, { cycleId } = {}) {
        return state.examReportComments.filter((c) => c.tenantId === tenantId && (!cycleId || c.cycleId === cycleId));
      },
      async upsert(tenantId, { cycleId, studentId, className, comment, classTeacherStaffId }) {
        let row = state.examReportComments.find((c) => c.tenantId === tenantId && c.cycleId === cycleId && c.studentId === studentId);
        if (!row) {
          row = { id: id(), tenantId, cycleId, studentId, className, comment: '', classTeacherStaffId: null };
          state.examReportComments.push(row);
        }
        row.comment = comment;
        if (classTeacherStaffId !== undefined) row.classTeacherStaffId = classTeacherStaffId;
        row.updatedAt = new Date().toISOString();
        return row;
      },
    },

    // Append-only, mirrors db.audit's shape plus a cycleId scope -- see
    // schema.sql's exam_audit_log comment.
    examAuditLog: {
      async record({ event, actorId, target = null, tenantId, cycleId = null, detail = '', beforeJson = null, afterJson = null }) {
        const record = { id: id(), tenantId, cycleId, event, actorId, target, detail, beforeJson, afterJson, at: new Date().toISOString() };
        state.examAuditLog.unshift(record);
        return record;
      },
      async list(tenantId, { cycleId } = {}) {
        return state.examAuditLog.filter((a) => a.tenantId === tenantId && (!cycleId || a.cycleId === cycleId));
      },
    },

    // Parent Registry -- see modules/parents/service.js's header. `parents`
    // is a plain simpleCollection; `parentStudentLinks` needs its own
    // list() because callers filter by EITHER parentId OR studentId
    // (simpleCollection's extraFilter only ANDs a fixed set of keys,
    // which is fine here since both keys are optional and undefined ones
    // are already skipped by its Object.entries(...).every(...) check).
    parents: simpleCollection('parents'),
    parentStudentLinks: simpleCollection('parentStudentLinks'),

    // One settings row per tenant -- register lock, backdate window,
    // at-risk threshold, per-phase period-marking toggle, and (saved but
    // honestly not wired to anything yet) guardian notification rules.
    attendanceSettings: {
      async get(tenantId) {
        return state.attendanceSettings.find((s) => s.tenantId === tenantId) || null;
      },
      async upsert(tenantId, patch) {
        let row = state.attendanceSettings.find((s) => s.tenantId === tenantId);
        if (!row) {
          row = { tenantId };
          state.attendanceSettings.push(row);
        }
        Object.assign(row, patch, { updatedAt: new Date().toISOString() });
        return row;
      },
    },

    schoolProfile: {
      async get(tenantId) {
        const row = state.schoolProfiles.find((p) => p.tenantId === tenantId);
        return row || emptyProfile(tenantId);
      },
      async updateSection(tenantId, section, data) {
        let row = state.schoolProfiles.find((p) => p.tenantId === tenantId);
        if (!row) {
          row = emptyProfile(tenantId);
          state.schoolProfiles.push(row);
        }
        row[section] = data;
        row.updatedAt = new Date().toISOString();
        return row;
      },
    },

    // Settings module -- Security Policy, one row per tenant. Same
    // get/upsert shape as attendanceSettings/feeSettings/
    // classStructureSettings above; defaults when no row live in
    // modules/settings/service.js's getSecurityPolicy(), not here.
    securityPolicies: {
      async get(tenantId) {
        return state.securityPolicies.find((s) => s.tenantId === tenantId) || null;
      },
      async upsert(tenantId, patch) {
        let row = state.securityPolicies.find((s) => s.tenantId === tenantId);
        if (!row) {
          row = { tenantId };
          state.securityPolicies.push(row);
        }
        Object.assign(row, patch, { updatedAt: new Date().toISOString() });
        return row;
      },
    },

    academicYears: {
      ...simpleCollection('academicYears'),
      // Only one academic year is "current" at a time -- selecting a new
      // one demotes whichever year previously held that status.
      async setCurrent(tenantId, yearId) {
        const year = state.academicYears.find((y) => y.id === yearId && y.tenantId === tenantId);
        if (!year) return null;
        state.academicYears.forEach((y) => {
          if (y.tenantId !== tenantId) return;
          y.status = y.id === yearId ? 'current' : (y.status === 'current' ? 'closed' : y.status);
        });
        return year;
      },
    },

    academicTerms: simpleCollection('academicTerms'),
    subjects: simpleCollection('subjects'),
    holidays: simpleCollection('holidays'),
    grades: simpleCollection('grades'),
    feeTypes: simpleCollection('feeTypes'),

    // Teachers & Staff (mirrors the students collection's shape/lifecycle
    // conventions -- see schema.sql's staff table comment for why status
    // only tracks active/probation/inactive/resigned and "on leave today"
    // is derived from staffLeave instead of stored).
    staff: {
      async list(tenantId, { query = '', department, staffType, status } = {}) {
        const q = query.toLowerCase();
        return state.staff.filter((s) =>
          s.tenantId === tenantId &&
          (!department || s.department === department) &&
          (!staffType || s.staffType === staffType) &&
          (!status || s.status === status) &&
          `${s.firstName} ${s.lastName} ${s.employeeId}`.toLowerCase().includes(q));
      },
      async findById(tenantId, staffId) {
        return state.staff.find((s) => s.id === staffId && s.tenantId === tenantId) || null;
      },
      async existsByEmployeeId(tenantId, employeeId) {
        return state.staff.some((s) => s.tenantId === tenantId && s.employeeId === employeeId);
      },
      async create(staffMember) {
        const record = { id: id(), status: 'active', createdAt: new Date().toISOString(), ...staffMember };
        state.staff.push(record);
        return record;
      },
      async update(tenantId, staffId, patch) {
        const staffMember = state.staff.find((s) => s.id === staffId && s.tenantId === tenantId);
        if (!staffMember) return null;
        Object.assign(staffMember, patch, { updatedAt: new Date().toISOString() });
        return staffMember;
      },
      async archive(tenantId, staffId) {
        const staffMember = state.staff.find((s) => s.id === staffId && s.tenantId === tenantId);
        if (!staffMember) return null;
        staffMember.status = 'inactive';
        staffMember.updatedAt = new Date().toISOString();
        return staffMember;
      },
      async offboard(tenantId, staffId, offboarding) {
        const staffMember = state.staff.find((s) => s.id === staffId && s.tenantId === tenantId);
        if (!staffMember) return null;
        staffMember.status = 'resigned';
        staffMember.offboarding = offboarding;
        staffMember.updatedAt = new Date().toISOString();
        return staffMember;
      },
    },

    // Subject/class/section assignments -- also the source data for the
    // Assignment Matrix and Workload views (see schema.sql comment).
    staffAssignments: {
      async listForStaff(tenantId, staffId) {
        return state.staffAssignments.filter((a) => a.tenantId === tenantId && a.staffId === staffId);
      },
      async listForTenant(tenantId) {
        return state.staffAssignments.filter((a) => a.tenantId === tenantId);
      },
      async findById(tenantId, assignmentId) {
        return state.staffAssignments.find((a) => a.id === assignmentId && a.tenantId === tenantId) || null;
      },
      async create(assignment) {
        const record = { id: id(), createdAt: new Date().toISOString(), ...assignment };
        state.staffAssignments.push(record);
        return record;
      },
      async update(tenantId, assignmentId, patch) {
        const assignment = state.staffAssignments.find((a) => a.id === assignmentId && a.tenantId === tenantId);
        if (!assignment) return null;
        Object.assign(assignment, patch);
        return assignment;
      },
      async remove(tenantId, assignmentId) {
        const index = state.staffAssignments.findIndex((a) => a.id === assignmentId && a.tenantId === tenantId);
        if (index < 0) return false;
        state.staffAssignments.splice(index, 1);
        return true;
      },
    },

    // Leave requests -- approve/decline queue + per-type balance. Only the
    // real leave-ledger half of the design's "Leave & Attendance" screen;
    // the fabricated daily attendance-calendar heatmap (who was physically
    // present each day) has no data source here and is cut, same call as
    // the Timetable screen's clash-detection/auto-balance.
    staffLeave: {
      async list(tenantId, { staffId, status } = {}) {
        return state.staffLeave
          .filter((l) => l.tenantId === tenantId && (!staffId || l.staffId === staffId) && (!status || l.status === status))
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      },
      async findById(tenantId, leaveId) {
        return state.staffLeave.find((l) => l.id === leaveId && l.tenantId === tenantId) || null;
      },
      async create(leave) {
        const record = { id: id(), status: 'pending', createdAt: new Date().toISOString(), ...leave };
        state.staffLeave.push(record);
        return record;
      },
      async decide(tenantId, leaveId, { status, decidedBy }) {
        const leave = state.staffLeave.find((l) => l.id === leaveId && l.tenantId === tenantId);
        if (!leave) return null;
        leave.status = status;
        leave.decidedBy = decidedBy;
        leave.decidedAt = new Date().toISOString();
        return leave;
      },
    },

    // Timetable -- config is one row per tenant (mirrors schoolProfile's
    // shape), venues is a simple list, versions/entries/runs are the real
    // grid data, examSessions/timetableRelief are their own small lists.
    timetableConfig: {
      async get(tenantId) {
        return state.timetableConfig.find((c) => c.tenantId === tenantId) || null;
      },
      async upsert(tenantId, patch) {
        let row = state.timetableConfig.find((c) => c.tenantId === tenantId);
        if (!row) {
          row = { tenantId };
          state.timetableConfig.push(row);
        }
        Object.assign(row, patch, { updatedAt: new Date().toISOString() });
        return row;
      },
    },

    timetableVenues: simpleCollection('timetableVenues'),

    timetableVersions: {
      async list(tenantId) {
        return state.timetableVersions.filter((v) => v.tenantId === tenantId).sort((a, b) => b.versionNumber - a.versionNumber);
      },
      async findById(tenantId, versionId) {
        return state.timetableVersions.find((v) => v.id === versionId && v.tenantId === tenantId) || null;
      },
      async getLive(tenantId) {
        return state.timetableVersions.find((v) => v.tenantId === tenantId && v.state === 'live') || null;
      },
      async create({ tenantId, note = '', sourceRunId = null, createdBy }) {
        const existing = state.timetableVersions.filter((v) => v.tenantId === tenantId);
        const versionNumber = existing.length === 0 ? 1 : Math.max(...existing.map((v) => v.versionNumber)) + 1;
        const record = {
          id: id(), tenantId, versionNumber, state: 'draft', note, sourceRunId, createdBy,
          createdAt: new Date().toISOString(), publishedAt: null, effectiveFrom: null,
        };
        state.timetableVersions.push(record);
        return record;
      },
      async publish(tenantId, versionId, { effectiveFrom } = {}) {
        const version = state.timetableVersions.find((v) => v.id === versionId && v.tenantId === tenantId);
        if (!version) return null;
        const previousLive = state.timetableVersions.find((v) => v.tenantId === tenantId && v.state === 'live');
        if (previousLive) previousLive.state = 'archived';
        version.state = 'live';
        version.publishedAt = new Date().toISOString();
        version.effectiveFrom = effectiveFrom || null;
        return version;
      },
    },

    timetableEntries: {
      async listForVersion(tenantId, versionId) {
        return state.timetableEntries.filter((e) => e.tenantId === tenantId && e.versionId === versionId);
      },
      // Wipes and re-writes every entry for a version in one call -- used
      // by both a fresh auto-generate run and "discard changes" (re-seed
      // from the version's own source run would need the run's original
      // output, so discard instead just re-lists what's there; the wizard
      // never calls this mid-edit).
      async replaceForVersion(tenantId, versionId, entries) {
        state.timetableEntries = state.timetableEntries.filter((e) => !(e.tenantId === tenantId && e.versionId === versionId));
        const records = entries.map((e) => ({ id: id(), tenantId, versionId, createdAt: new Date().toISOString(), ...e }));
        state.timetableEntries.push(...records);
        return records;
      },
      // One manual drag-drop placement (Build/Edit screen) -- replaces
      // whatever (if anything) already occupied that class+day+slot.
      async upsertOne(tenantId, versionId, entry) {
        const index = state.timetableEntries.findIndex((e) =>
          e.tenantId === tenantId && e.versionId === versionId &&
          e.className === entry.className && e.section === entry.section &&
          e.day === entry.day && e.slotId === entry.slotId);
        const record = { id: index >= 0 ? state.timetableEntries[index].id : id(), tenantId, versionId, createdAt: new Date().toISOString(), ...entry };
        if (index >= 0) state.timetableEntries[index] = record; else state.timetableEntries.push(record);
        return record;
      },
      async removeOne(tenantId, versionId, { className, section, day, slotId }) {
        const index = state.timetableEntries.findIndex((e) =>
          e.tenantId === tenantId && e.versionId === versionId &&
          e.className === className && e.section === section && e.day === day && e.slotId === slotId);
        if (index < 0) return false;
        state.timetableEntries.splice(index, 1);
        return true;
      },
    },

    timetableRuns: {
      async list(tenantId) {
        return state.timetableRuns.filter((r) => r.tenantId === tenantId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      },
      async create(run) {
        const record = { id: id(), createdAt: new Date().toISOString(), ...run };
        state.timetableRuns.push(record);
        return record;
      },
    },

    examSessions: {
      async list(tenantId, { className } = {}) {
        return state.examSessions
          .filter((e) => e.tenantId === tenantId && (!className || e.className === className))
          .sort((a, b) => a.examDate.localeCompare(b.examDate) || a.session.localeCompare(b.session));
      },
      async findById(tenantId, examId) {
        return state.examSessions.find((e) => e.id === examId && e.tenantId === tenantId) || null;
      },
      async create(exam) {
        const record = { id: id(), createdAt: new Date().toISOString(), ...exam };
        state.examSessions.push(record);
        return record;
      },
      async update(tenantId, examId, patch) {
        const exam = state.examSessions.find((e) => e.id === examId && e.tenantId === tenantId);
        if (!exam) return null;
        Object.assign(exam, patch);
        return exam;
      },
      async remove(tenantId, examId) {
        const index = state.examSessions.findIndex((e) => e.id === examId && e.tenantId === tenantId);
        if (index < 0) return false;
        state.examSessions.splice(index, 1);
        return true;
      },
    },

    // Substitution & relief -- one row per period that needs covering
    // because its usual teacher is on leave that day (see schema.sql).
    timetableRelief: {
      async listForDate(tenantId, reliefDate) {
        return state.timetableRelief.filter((r) => r.tenantId === tenantId && r.reliefDate === reliefDate);
      },
      async findById(tenantId, reliefId) {
        return state.timetableRelief.find((r) => r.id === reliefId && r.tenantId === tenantId) || null;
      },
      // Idempotent by (date, slot, class, section) -- re-deriving "who
      // needs cover today" from live staff_leave never creates duplicates.
      async ensure(tenantId, row) {
        let existing = state.timetableRelief.find((r) =>
          r.tenantId === tenantId && r.reliefDate === row.reliefDate && r.slotId === row.slotId &&
          r.className === row.className && r.section === row.section);
        if (existing) return existing;
        existing = { id: id(), tenantId, status: 'open', coverStaffId: null, note: '', notifiedAt: null, createdAt: new Date().toISOString(), ...row };
        state.timetableRelief.push(existing);
        return existing;
      },
      async assign(tenantId, reliefId, { coverStaffId, note = '' }) {
        const row = state.timetableRelief.find((r) => r.id === reliefId && r.tenantId === tenantId);
        if (!row) return null;
        row.coverStaffId = coverStaffId;
        row.status = coverStaffId ? 'covered' : 'open';
        if (note) row.note = note;
        return row;
      },
      async markNotified(tenantId, ids) {
        const now = new Date().toISOString();
        for (const row of state.timetableRelief) {
          if (row.tenantId === tenantId && ids.includes(row.id)) row.notifiedAt = now;
        }
        return state.timetableRelief.filter((r) => r.tenantId === tenantId && ids.includes(r.id));
      },
    },

    // Classes & Sections (designs/Teacher feature UI mockup/
    // Classes and Sections.dc.html) -- class_levels is the canonical class
    // list every other module should eventually read (see routes.js for
    // exactly which ones already do); sorted by orderIndex so "promotes
    // from/to" can be computed as the neighbouring level rather than
    // stored redundantly. Class teacher is deliberately NOT stored here --
    // staff.classTeacherOf (already used by the Staff module) is the
    // single source of truth; see classes/routes.js.
    classLevels: {
      async list(tenantId) {
        return state.classLevels.filter((l) => l.tenantId === tenantId).sort((a, b) => a.orderIndex - b.orderIndex);
      },
      async findById(tenantId, levelId) {
        return state.classLevels.find((l) => l.id === levelId && l.tenantId === tenantId) || null;
      },
      async findByName(tenantId, name) {
        return state.classLevels.find((l) => l.tenantId === tenantId && l.name === name) || null;
      },
      async create(level) {
        const record = { id: id(), createdAt: new Date().toISOString(), ...level };
        state.classLevels.push(record);
        return record;
      },
      async update(tenantId, levelId, patch) {
        const level = state.classLevels.find((l) => l.id === levelId && l.tenantId === tenantId);
        if (!level) return null;
        Object.assign(level, patch, { updatedAt: new Date().toISOString() });
        return level;
      },
      async remove(tenantId, levelId) {
        const index = state.classLevels.findIndex((l) => l.id === levelId && l.tenantId === tenantId);
        if (index < 0) return false;
        state.classLevels.splice(index, 1);
        return true;
      },
    },

    classSections: {
      async list(tenantId, { classLevelId } = {}) {
        return state.classSections
          .filter((s) => s.tenantId === tenantId && (!classLevelId || s.classLevelId === classLevelId))
          .sort((a, b) => a.letter.localeCompare(b.letter));
      },
      async findById(tenantId, sectionId) {
        return state.classSections.find((s) => s.id === sectionId && s.tenantId === tenantId) || null;
      },
      async create(section) {
        const record = { id: id(), createdAt: new Date().toISOString(), ...section };
        state.classSections.push(record);
        return record;
      },
      async update(tenantId, sectionId, patch) {
        const section = state.classSections.find((s) => s.id === sectionId && s.tenantId === tenantId);
        if (!section) return null;
        Object.assign(section, patch, { updatedAt: new Date().toISOString() });
        return section;
      },
      async remove(tenantId, sectionId) {
        const index = state.classSections.findIndex((s) => s.id === sectionId && s.tenantId === tenantId);
        if (index < 0) return false;
        state.classSections.splice(index, 1);
        return true;
      },
    },

    classWaitlist: simpleCollection('classWaitlist'),
    classCurriculum: simpleCollection('classCurriculum'),
    classPromotionRuns: {
      async list(tenantId) {
        return state.classPromotionRuns.filter((r) => r.tenantId === tenantId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      },
      async findById(tenantId, runId) {
        return state.classPromotionRuns.find((r) => r.id === runId && r.tenantId === tenantId) || null;
      },
      async create(run) {
        const record = { id: id(), createdAt: new Date().toISOString(), rolledBack: false, ...run };
        state.classPromotionRuns.push(record);
        return record;
      },
      async markRolledBack(tenantId, runId) {
        const run = state.classPromotionRuns.find((r) => r.id === runId && r.tenantId === tenantId);
        if (!run) return null;
        run.rolledBack = true;
        return run;
      },
    },

    classStructureSettings: {
      async get(tenantId) {
        return state.classStructureSettings.find((c) => c.tenantId === tenantId) || null;
      },
      async upsert(tenantId, patch) {
        let row = state.classStructureSettings.find((c) => c.tenantId === tenantId);
        if (!row) {
          row = { tenantId };
          state.classStructureSettings.push(row);
        }
        Object.assign(row, patch, { updatedAt: new Date().toISOString() });
        return row;
      },
    },

    // Fees & Payments module additions. This is a RECORD of an offline
    // collection process (see schema.sql header) -- fee_types/School
    // Setup is untouched and unrelated.
    feeStructures: {
      async list(tenantId) {
        return state.feeStructures.filter((s) => s.tenantId === tenantId).sort((a, b) => b.version - a.version);
      },
      async findById(tenantId, structureId) {
        return state.feeStructures.find((s) => s.id === structureId && s.tenantId === tenantId) || null;
      },
      async findPublished(tenantId) {
        return state.feeStructures.find((s) => s.tenantId === tenantId && s.status === 'published') || null;
      },
      async createDraft(tenantId, { createdBy }) {
        const existing = state.feeStructures.filter((s) => s.tenantId === tenantId);
        const version = existing.length === 0 ? 1 : Math.max(...existing.map((s) => s.version)) + 1;
        const record = { id: id(), tenantId, version, status: 'draft', publishedAt: null, createdBy, createdAt: new Date().toISOString() };
        state.feeStructures.push(record);
        return record;
      },
      // Publishing a draft archives whichever version was previously
      // published -- exactly one published version prices new invoices at
      // a time, the same one-live-at-a-time rule as timetable_versions.
      async publish(tenantId, structureId) {
        const target = state.feeStructures.find((s) => s.id === structureId && s.tenantId === tenantId);
        if (!target) return null;
        state.feeStructures.forEach((s) => {
          if (s.tenantId === tenantId && s.status === 'published') s.status = 'archived';
        });
        target.status = 'published';
        target.publishedAt = new Date().toISOString();
        return target;
      },
    },

    feeStructureHeads: {
      ...simpleCollection('feeStructureHeads'),
      // The Fee structure screen saves the whole grid at once -- replace
      // is simpler and safer than diffing individual head edits, matching
      // how class_curriculum's PUT already replaces its rows wholesale.
      async replaceForStructure(tenantId, structureId, heads) {
        state.feeStructureHeads = state.feeStructureHeads.filter((h) => !(h.tenantId === tenantId && h.structureId === structureId));
        const created = heads.map((h, index) => ({ id: id(), tenantId, structureId, orderIndex: index, createdAt: new Date().toISOString(), ...h }));
        state.feeStructureHeads.push(...created);
        return created;
      },
    },

    feeBillingSchedule: simpleCollection('feeBillingSchedule'),

    feeStructureRules: {
      async get(tenantId) {
        return state.feeStructureRules.find((r) => r.tenantId === tenantId) || null;
      },
      async upsert(tenantId, patch) {
        let row = state.feeStructureRules.find((r) => r.tenantId === tenantId);
        if (!row) {
          row = { tenantId };
          state.feeStructureRules.push(row);
        }
        Object.assign(row, patch, { updatedAt: new Date().toISOString() });
        return row;
      },
    },

    feeInvoices: {
      ...simpleCollection('feeInvoices'),
      async existsForStudentTerm(tenantId, studentId, termLabel) {
        return state.feeInvoices.some((i) => i.tenantId === tenantId && i.studentId === studentId && i.termLabel === termLabel);
      },
      async findByInvoiceNo(tenantId, invoiceNo) {
        return state.feeInvoices.find((i) => i.tenantId === tenantId && i.invoiceNo === invoiceNo) || null;
      },
    },

    feeInvoiceLines: {
      ...simpleCollection('feeInvoiceLines'),
      async createMany(tenantId, invoiceId, lines) {
        const created = lines.map((l) => ({ id: id(), tenantId, invoiceId, createdAt: new Date().toISOString(), ...l }));
        state.feeInvoiceLines.push(...created);
        return created;
      },
    },

    feePayments: {
      ...simpleCollection('feePayments'),
      async markConfirmed(tenantId, paymentId) {
        const row = state.feePayments.find((p) => p.id === paymentId && p.tenantId === tenantId);
        if (!row) return null;
        row.confirmed = true;
        return row;
      },
    },

    feePaymentAllocations: {
      ...simpleCollection('feePaymentAllocations'),
      async createMany(tenantId, paymentId, allocations) {
        const created = allocations.map((a) => ({ id: id(), tenantId, paymentId, createdAt: new Date().toISOString(), ...a }));
        state.feePaymentAllocations.push(...created);
        return created;
      },
    },

    feePaymentPlans: simpleCollection('feePaymentPlans'),

    // Bank lines entered by hand (see schema.sql header -- no statement
    // upload this pass). setMatch is called by the real matching engine
    // in modules/fees/service.js, never directly by the person entering
    // the line.
    bankStatementLines: {
      ...simpleCollection('bankStatementLines'),
      async setMatch(tenantId, lineId, { paymentId, confidence, reviewedBy }) {
        const row = state.bankStatementLines.find((l) => l.id === lineId && l.tenantId === tenantId);
        if (!row) return null;
        row.matchedPaymentId = paymentId;
        row.confidence = confidence;
        row.reviewedBy = reviewedBy;
        row.reviewedAt = new Date().toISOString();
        return row;
      },
    },

    feeDisbursements: {
      ...simpleCollection('feeDisbursements'),
      async decide(tenantId, disbursementId, { state: newState, approvedBy }) {
        const row = state.feeDisbursements.find((d) => d.id === disbursementId && d.tenantId === tenantId);
        if (!row) return null;
        row.state = newState;
        row.approvedBy = approvedBy;
        row.decidedAt = new Date().toISOString();
        return row;
      },
    },

    // Escalation ladder log (screen 7) -- see schema.sql header: automatic
    // reminder counts are derived live from invoice ageing in service.js;
    // this table only logs the two MANUAL steps for real.
    feeEscalationEvents: simpleCollection('feeEscalationEvents'),

    feeSettings: {
      async get(tenantId) {
        return state.feeSettings.find((s) => s.tenantId === tenantId) || null;
      },
      async upsert(tenantId, patch) {
        let row = state.feeSettings.find((s) => s.tenantId === tenantId);
        if (!row) {
          row = { tenantId };
          state.feeSettings.push(row);
        }
        Object.assign(row, patch, { updatedAt: new Date().toISOString() });
        return row;
      },
    },

    documents: {
      async create(doc) {
        const record = { id: id(), createdAt: new Date().toISOString(), ...doc };
        state.documents.push(record);
        return record;
      },
      async listForEntity(tenantId, entityType, entityId) {
        return state.documents.filter((d) => d.tenantId === tenantId && d.entityType === entityType && d.entityId === entityId);
      },
      async listForEntityType(tenantId, entityType) {
        return state.documents.filter((d) => d.tenantId === tenantId && d.entityType === entityType);
      },
      async findById(tenantId, documentId) {
        return state.documents.find((d) => d.id === documentId && d.tenantId === tenantId) || null;
      },
      async remove(tenantId, documentId) {
        const index = state.documents.findIndex((d) => d.id === documentId && d.tenantId === tenantId);
        if (index === -1) return false;
        state.documents.splice(index, 1);
        return true;
      },
    },

    // Notices & Communication (edusphere-notices-communication-module-plan-
    // 2026-09-22.md). Status is computed by modules/notices/service.js from
    // publish_at/expiry_at/is_draft/is_archived, never stored here.
    notices: {
      async list(tenantId, { category, audienceType, className, search } = {}) {
        let rows = state.notices.filter((n) => n.tenantId === tenantId);
        if (category) rows = rows.filter((n) => n.category === category);
        if (audienceType) rows = rows.filter((n) => n.audienceType === audienceType);
        if (className) rows = rows.filter((n) => n.audienceClassName === className);
        if (search) {
          const q = search.toLowerCase();
          rows = rows.filter((n) => n.title.toLowerCase().includes(q) || n.description.toLowerCase().includes(q));
        }
        return rows.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      },
      async findById(tenantId, noticeId) {
        return state.notices.find((n) => n.id === noticeId && n.tenantId === tenantId) || null;
      },
      async create(notice) {
        const record = { id: id(), createdAt: new Date().toISOString(), updatedAt: null, ...notice };
        state.notices.push(record);
        return record;
      },
      async update(tenantId, noticeId, patch) {
        const notice = state.notices.find((n) => n.id === noticeId && n.tenantId === tenantId);
        if (!notice) return null;
        Object.assign(notice, patch, { updatedAt: new Date().toISOString() });
        return notice;
      },
      async remove(tenantId, noticeId) {
        const index = state.notices.findIndex((n) => n.id === noticeId && n.tenantId === tenantId);
        if (index === -1) return false;
        state.notices.splice(index, 1);
        return true;
      },
    },

    noticeAcknowledgements: {
      async listForNotice(tenantId, noticeId) {
        return state.noticeAcknowledgements
          .filter((a) => a.tenantId === tenantId && a.noticeId === noticeId)
          .slice()
          .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));
      },
      async create(ack) {
        const record = { id: id(), recordedAt: new Date().toISOString(), ...ack };
        state.noticeAcknowledgements.push(record);
        return record;
      },
    },

    // Payroll (see schema.sql's Payroll header).
    payProfiles: {
      ...simpleCollection('payProfiles'),
      async findByStaff(tenantId, staffId) {
        return state.payProfiles.find((p) => p.tenantId === tenantId && p.staffId === staffId) || null;
      },
      async upsert(tenantId, staffId, patch) {
        const existing = state.payProfiles.find((p) => p.tenantId === tenantId && p.staffId === staffId);
        if (existing) { Object.assign(existing, patch); return existing; }
        const record = { id: id(), createdAt: new Date().toISOString(), tenantId, staffId, ...patch };
        state.payProfiles.push(record);
        return record;
      },
    },
    payrollRuns: {
      ...simpleCollection('payrollRuns'),
      async findByPeriod(tenantId, period) {
        return state.payrollRuns.find((r) => r.tenantId === tenantId && r.period === period) || null;
      },
    },
    payslips: {
      ...simpleCollection('payslips'),
      async listByStaff(tenantId, staffId) {
        return state.payslips.filter((p) => p.tenantId === tenantId && p.staffId === staffId)
          .sort((a, b) => b.period.localeCompare(a.period));
      },
      async removeByRun(tenantId, runId) {
        state.payslips = state.payslips.filter((p) => !(p.tenantId === tenantId && p.runId === runId));
        return true;
      },
    },

    audit: {
      async record({ event, actorId, target, tenantId, summary = {} }) {
        state.audit.unshift({ id: id(), event, actorId, target, tenantId, summary, at: new Date().toISOString() });
      },
      async list(tenantId) { return state.audit.filter((a) => a.tenantId === tenantId); },
    },
  };
}
