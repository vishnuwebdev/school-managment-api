import crypto from 'node:crypto';
import mysql from 'mysql2/promise';

// Real, persistent adapter for production/staging. Implements the exact
// same contract as adapters/memoryAdapter.js — see db/schema.sql for the
// table definitions this code assumes exist (run schema.sql once before
// pointing DATABASE_DRIVER at mysql). Not yet exercised against a live
// database in this environment; review the queries against your instance
// before relying on it, and open an issue in context-memory if anything
// doesn't match.
export function createMysqlAdapter(databaseUrl) {
  const pool = mysql.createPool(databaseUrl);
  const id = () => crypto.randomUUID();
  const now = () => new Date();

  const row = (r) => (r?.[0] ? r[0] : null); // helper for SELECT ... LIMIT 1

  const safeParseJson = (value) => {
    if (!value) return {};
    if (typeof value === 'object') return value; // mysql2 may already parse JSON columns
    try { return JSON.parse(value); } catch { return {}; }
  };

  // Generic CRUD for the six simple tenant-scoped list tables School Setup
  // added (academic_years, academic_terms, subjects, holidays, grades,
  // fee_types) -- same contract as memoryAdapter.js's simpleCollection, so
  // school-setup route modules don't need to know which driver is active.
  // `columns` maps { js: camelCase field, sql: snake_case column,
  // serialize/parse: optional value transforms }.
  function sqlSimpleCollection(table, columns, extraFilterColumn) {
    function fromRow(r) {
      if (!r) return null;
      const obj = { id: r.id, tenantId: r.tenant_id, createdAt: r.created_at };
      for (const c of columns) obj[c.js] = c.parse ? c.parse(r[c.sql]) : r[c.sql];
      return obj;
    }
    const collection = {
      async list(tenantId, extraFilter = {}) {
        const clauses = ['tenant_id = ?'];
        const params = [tenantId];
        if (extraFilterColumn) {
          const value = extraFilter[extraFilterColumn.js];
          if (value !== undefined && value !== null) { clauses.push(`${extraFilterColumn.sql} = ?`); params.push(value); }
        }
        const [rows] = await pool.query(`SELECT * FROM ${table} WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params);
        return rows.map(fromRow);
      },
      async findById(tenantId, recordId) {
        const [rows] = await pool.query(`SELECT * FROM ${table} WHERE id = ? AND tenant_id = ?`, [recordId, tenantId]);
        return fromRow(row(rows));
      },
      async create(payload) {
        const recordId = id();
        const cols = ['id', 'tenant_id', ...columns.map((c) => c.sql)];
        const values = [recordId, payload.tenantId, ...columns.map((c) => {
          const value = payload[c.js];
          return c.serialize ? c.serialize(value) : (value === undefined ? null : value);
        })];
        await pool.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, values);
        return collection.findById(payload.tenantId, recordId);
      },
      async update(tenantId, recordId, patch) {
        const setCols = columns.filter((c) => patch[c.js] !== undefined);
        if (setCols.length) {
          const setClause = setCols.map((c) => `${c.sql} = ?`).join(', ');
          const values = setCols.map((c) => (c.serialize ? c.serialize(patch[c.js]) : patch[c.js]));
          await pool.query(`UPDATE ${table} SET ${setClause} WHERE id = ? AND tenant_id = ?`, [...values, recordId, tenantId]);
        }
        return collection.findById(tenantId, recordId);
      },
      async remove(tenantId, recordId) {
        const [result] = await pool.query(`DELETE FROM ${table} WHERE id = ? AND tenant_id = ?`, [recordId, tenantId]);
        return result.affectedRows > 0;
      },
    };
    return collection;
  }

  const PROFILE_SECTION_COLUMN = {
    basicInfo: 'basic_info', contact: 'contact', address: 'address', branding: 'branding',
    bank: 'bank', registration: 'registration', social: 'social', promotion: 'promotion', preferences: 'preferences',
  };
  function emptyProfile(tenantId) {
    const profile = { tenantId, updatedAt: null };
    for (const section of Object.keys(PROFILE_SECTION_COLUMN)) profile[section] = {};
    return profile;
  }

  // Column map for everything on `students` beyond id/tenant_id/status/
  // created_at/updated_at (which get dedicated handling below, since status
  // has its own lifecycle setters and the others are never user-writable).
  // Same {js, sql, parse?, serialize?} shape as sqlSimpleCollection's
  // `columns` -- kept as its own hand-written mapper rather than reused
  // through that helper because students also needs the archive/withdraw/
  // transfer lifecycle methods sqlSimpleCollection doesn't model.
  const STUDENT_COLUMNS = [
    { js: 'admissionNumber', sql: 'admission_number' },
    { js: 'firstName', sql: 'first_name' },
    { js: 'middleName', sql: 'middle_name' },
    { js: 'lastName', sql: 'last_name' },
    { js: 'dateOfBirth', sql: 'date_of_birth' },
    { js: 'gender', sql: 'gender' },
    { js: 'bloodGroup', sql: 'blood_group' },
    { js: 'nationality', sql: 'nationality' },
    { js: 'aadhaarNumber', sql: 'aadhaar_number' },
    { js: 'studentEmail', sql: 'student_email' },
    { js: 'guardians', sql: 'guardians', parse: safeParseJson, serialize: (v) => JSON.stringify(v || {}) },
    { js: 'academicYear', sql: 'academic_year' },
    { js: 'className', sql: 'class_name' },
    { js: 'section', sql: 'section' },
    { js: 'rollNumber', sql: 'roll_number' },
    { js: 'admissionDate', sql: 'admission_date' },
    { js: 'admissionType', sql: 'admission_type' },
    { js: 'previousSchool', sql: 'previous_school' },
    { js: 'previousClass', sql: 'previous_class' },
    { js: 'house', sql: 'house' },
    { js: 'category', sql: 'category' },
    { js: 'transportRequired', sql: 'transport_required', parse: (v) => !!v, serialize: (v) => (v ? 1 : 0) },
    { js: 'withdrawal', sql: 'withdrawal', parse: safeParseJson, serialize: (v) => (v ? JSON.stringify(v) : null) },
    { js: 'transfer', sql: 'transfer', parse: safeParseJson, serialize: (v) => (v ? JSON.stringify(v) : null) },
  ];
  const studentRow = (r) => {
    if (!r) return null;
    const obj = { id: r.id, tenantId: r.tenant_id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
    for (const c of STUDENT_COLUMNS) obj[c.js] = c.parse ? c.parse(r[c.sql]) : r[c.sql];
    return obj;
  };
  // Teachers & Staff -- same {js, sql, parse?, serialize?} column-map
  // pattern as STUDENT_COLUMNS above.
  const STAFF_COLUMNS = [
    { js: 'employeeId', sql: 'employee_id' },
    { js: 'firstName', sql: 'first_name' },
    { js: 'lastName', sql: 'last_name' },
    { js: 'gender', sql: 'gender' },
    { js: 'dateOfBirth', sql: 'date_of_birth' },
    { js: 'idNumber', sql: 'id_number' },
    { js: 'personalEmail', sql: 'personal_email' },
    { js: 'workEmail', sql: 'work_email' },
    { js: 'phone', sql: 'phone' },
    { js: 'address', sql: 'address' },
    { js: 'staffType', sql: 'staff_type' },
    { js: 'designation', sql: 'designation' },
    { js: 'department', sql: 'department' },
    { js: 'employmentType', sql: 'employment_type' },
    { js: 'joiningDate', sql: 'joining_date' },
    { js: 'reportsTo', sql: 'reports_to' },
    { js: 'weeklyPeriodCapacity', sql: 'weekly_period_capacity' },
    { js: 'isClassTeacher', sql: 'is_class_teacher', parse: (v) => !!v, serialize: (v) => (v ? 1 : 0) },
    { js: 'classTeacherOf', sql: 'class_teacher_of' },
    { js: 'notes', sql: 'notes' },
    { js: 'offboarding', sql: 'offboarding', parse: safeParseJson, serialize: (v) => (v ? JSON.stringify(v) : null) },
  ];
  const staffRow = (r) => {
    if (!r) return null;
    const obj = { id: r.id, tenantId: r.tenant_id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
    for (const c of STAFF_COLUMNS) obj[c.js] = c.parse ? c.parse(r[c.sql]) : r[c.sql];
    return obj;
  };
  const staffAssignmentRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, staffId: r.staff_id, subject: r.subject,
    className: r.class_name, section: r.section, periodsPerWeek: r.periods_per_week, role: r.role, createdAt: r.created_at,
  });
  const staffLeaveRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, staffId: r.staff_id, leaveType: r.leave_type,
    startDate: r.start_date, endDate: r.end_date, daysCount: Number(r.days_count), reason: r.reason,
    status: r.status, decidedBy: r.decided_by, decidedAt: r.decided_at, createdAt: r.created_at,
  });
  const attendanceRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, studentId: r.student_id, date: r.date,
    className: r.class_name, section: r.section, status: r.status, remark: r.remark,
    createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at,
  });

  const correctionRequestRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, studentId: r.student_id, date: r.date, className: r.class_name, section: r.section,
    previousStatus: r.previous_status, previousRemark: r.previous_remark, requestedStatus: r.requested_status,
    requestedRemark: r.requested_remark, reason: r.reason, status: r.status, requestedBy: r.requested_by,
    requestedAt: r.requested_at, decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note,
  });

  const attendancePeriodRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, studentId: r.student_id, date: r.date, slotId: r.slot_id, className: r.class_name,
    section: r.section, subject: r.subject, status: r.status, remark: r.remark, createdBy: r.created_by,
    createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at,
  });
  const timetableVersionRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, versionNumber: r.version_number, state: r.state, note: r.note,
    sourceRunId: r.source_run_id, createdBy: r.created_by, createdAt: r.created_at,
    publishedAt: r.published_at, effectiveFrom: r.effective_from,
  });
  const timetableEntryRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, versionId: r.version_id, className: r.class_name, section: r.section,
    day: r.day, slotId: r.slot_id, subject: r.subject, staffId: r.staff_id, venueId: r.venue_id,
    source: r.source, createdAt: r.created_at,
  });
  const timetableRunRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, versionId: r.version_id, hardRules: safeParseJson(r.hard_rules),
    softRules: safeParseJson(r.soft_rules), totalPeriods: r.total_periods, placedPeriods: r.placed_periods,
    note: r.note, createdBy: r.created_by, createdAt: r.created_at,
  });
  const examSessionRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, className: r.class_name, examDate: r.exam_date, session: r.session,
    subject: r.subject, venue: r.venue, seats: r.seats, invigilatorStaffId: r.invigilator_staff_id,
    termLabel: r.term_label, cycleId: r.cycle_id, periodSlotId: r.period_slot_id,
    durationMinutes: r.duration_minutes, sectionsIncluded: safeParseJson(r.sections_included) ?? [],
    createdAt: r.created_at,
  });
  // Parent Registry -- see modules/parents/service.js's header.
  const parentLinkRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, parentId: r.parent_id, studentId: r.student_id,
    relationship: r.relationship, isPrimaryContact: Boolean(r.is_primary_contact),
    isEmergencyContact: Boolean(r.is_emergency_contact), createdAt: r.created_at,
  });
  const timetableReliefRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, reliefDate: r.relief_date, slotId: r.slot_id, className: r.class_name,
    section: r.section, subject: r.subject, absentStaffId: r.absent_staff_id, coverStaffId: r.cover_staff_id,
    status: r.status, note: r.note, notifiedAt: r.notified_at, createdAt: r.created_at,
  });

  const classLevelRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, name: r.name, phase: r.phase, orderIndex: r.order_index,
    languageOfInstruction: r.language_of_instruction, defaultCapacity: r.default_capacity, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const classSectionRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, classLevelId: r.class_level_id, letter: r.letter, capacity: r.capacity,
    room: r.room, createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const classPromotionRunRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, fromYear: r.from_year, toYear: r.to_year, movedCount: r.moved_count,
    repeatCount: r.repeat_count, graduatedCount: r.graduated_count, snapshot: safeParseJson(r.snapshot),
    rolledBack: Boolean(r.rolled_back), executedBy: r.executed_by, createdAt: r.created_at,
  });


  // Fees & Payments module additions (see schema.sql's header). fee_types
  // (School Setup) is untouched and unrelated -- this is a separate,
  // richer, versioned model, per the project plan doc.
  const feeStructureRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, version: r.version, status: r.status,
    publishedAt: r.published_at, createdBy: r.created_by, createdAt: r.created_at,
  });
  const feeInvoiceRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, invoiceNo: r.invoice_no, studentId: r.student_id,
    className: r.class_name, section: r.section, termLabel: r.term_label, dueDate: r.due_date,
    structureVersion: r.structure_version, raisedBy: r.raised_by, raisedAt: r.raised_at,
  });
  const feePaymentRow = (r) => r && ({
    id: r.id, tenantId: r.tenant_id, studentId: r.student_id, amountReceived: Number(r.amount_received),
    dateReceived: r.date_received, method: r.method, bankReference: r.bank_reference,
    proofDocumentId: r.proof_document_id, confirmed: !!r.confirmed, recordedBy: r.recorded_by, recordedAt: r.recorded_at,
  });

  return {
    driver: 'mysql',
    async ready() { await pool.query('SELECT 1'); },

    schools: {
      async list() {
        const [rows] = await pool.query('SELECT * FROM schools ORDER BY name');
        return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, active: !!r.active }));
      },
      async findById(schoolId) {
        const [rows] = await pool.query('SELECT * FROM schools WHERE id = ?', [schoolId]);
        const r = row(rows);
        return r && { id: r.id, name: r.name, slug: r.slug, active: !!r.active };
      },
      async findBySlug(slug) {
        const [rows] = await pool.query('SELECT * FROM schools WHERE slug = ?', [slug]);
        const r = row(rows);
        return r && { id: r.id, name: r.name, slug: r.slug, active: !!r.active };
      },
      async create({ name, slug }) {
        const schoolId = id();
        await pool.query('INSERT INTO schools (id, name, slug, active) VALUES (?, ?, ?, 1)', [schoolId, name, slug]);
        return { id: schoolId, name, slug, active: true };
      },
    },

    roles: {
      async list(tenantId) {
        const [rows] = await pool.query('SELECT * FROM roles WHERE tenant_id = ? OR tenant_id IS NULL', [tenantId]);
        return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, key: r.key, name: r.name, permissions: JSON.parse(r.permissions), isSystem: !!r.is_system }));
      },
      async findByKey(tenantId, key) {
        const [rows] = await pool.query('SELECT * FROM roles WHERE `key` = ? AND (tenant_id = ? OR tenant_id IS NULL) LIMIT 1', [key, tenantId]);
        const r = row(rows);
        return r && { id: r.id, tenantId: r.tenant_id, key: r.key, name: r.name, permissions: JSON.parse(r.permissions), isSystem: !!r.is_system };
      },
      async permissionsForKeys(tenantId, keys) {
        if (!keys.length) return [];
        const placeholders = keys.map(() => '?').join(',');
        const [rows] = await pool.query(
          `SELECT permissions FROM roles WHERE \`key\` IN (${placeholders}) AND (tenant_id = ? OR tenant_id IS NULL)`,
          [...keys, tenantId],
        );
        return [...new Set(rows.flatMap((r) => JSON.parse(r.permissions)))];
      },
      async create({ tenantId, key, name, permissions, isSystem = false }) {
        const roleId = id();
        await pool.query('INSERT INTO roles (id, tenant_id, `key`, name, permissions, is_system) VALUES (?, ?, ?, ?, ?, ?)', [roleId, tenantId, key, name, JSON.stringify(permissions), isSystem ? 1 : 0]);
        return { id: roleId, tenantId, key, name, permissions, isSystem };
      },
      async updatePermissions(tenantId, key, permissions) {
        await pool.query('UPDATE roles SET permissions = ? WHERE `key` = ? AND tenant_id = ?', [JSON.stringify(permissions), key, tenantId]);
        return this.findByKey(tenantId, key);
      },
    },

    schoolEntitlements: {
      async list(tenantId) {
        const [rows] = await pool.query('SELECT * FROM school_entitlements WHERE tenant_id = ?', [tenantId]);
        return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, featureKey: r.feature_key, enabled: !!r.enabled, updatedBy: r.updated_by, updatedAt: r.updated_at }));
      },
      async listAll() {
        const [rows] = await pool.query('SELECT * FROM school_entitlements');
        return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, featureKey: r.feature_key, enabled: !!r.enabled, updatedBy: r.updated_by, updatedAt: r.updated_at }));
      },
      async upsert({ tenantId, featureKey, enabled, updatedBy }) {
        const [existing] = await pool.query('SELECT id FROM school_entitlements WHERE tenant_id = ? AND feature_key = ?', [tenantId, featureKey]);
        if (existing.length) {
          await pool.query('UPDATE school_entitlements SET enabled = ?, updated_by = ? WHERE id = ?', [enabled ? 1 : 0, updatedBy, existing[0].id]);
        } else {
          await pool.query('INSERT INTO school_entitlements (id, tenant_id, feature_key, enabled, updated_by) VALUES (?, ?, ?, ?, ?)', [id(), tenantId, featureKey, enabled ? 1 : 0, updatedBy]);
        }
        const [rows] = await pool.query('SELECT * FROM school_entitlements WHERE tenant_id = ? AND feature_key = ?', [tenantId, featureKey]);
        const r = rows[0];
        return { id: r.id, tenantId: r.tenant_id, featureKey: r.feature_key, enabled: !!r.enabled, updatedBy: r.updated_by, updatedAt: r.updated_at };
      },
    },

    users: {
      async findByEmail(email) {
        const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
        const r = row(rows);
        return r && { id: r.id, tenantId: r.tenant_id, email: r.email, passwordHash: r.password_hash, fullName: r.full_name, phone: r.phone, roleKeys: JSON.parse(r.role_keys), status: r.status, lastLoginAt: r.last_login_at, failedLoginAttempts: r.failed_login_attempts, lockedUntil: r.locked_until };
      },
      async findById(userId) {
        const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
        const r = row(rows);
        return r && { id: r.id, tenantId: r.tenant_id, email: r.email, passwordHash: r.password_hash, fullName: r.full_name, phone: r.phone, roleKeys: JSON.parse(r.role_keys), status: r.status, lastLoginAt: r.last_login_at, failedLoginAttempts: r.failed_login_attempts, lockedUntil: r.locked_until };
      },
      async listByTenant(tenantId) {
        const [rows] = await pool.query('SELECT * FROM users WHERE tenant_id = ? ORDER BY full_name', [tenantId]);
        return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, email: r.email, fullName: r.full_name, phone: r.phone, roleKeys: JSON.parse(r.role_keys), status: r.status, lastLoginAt: r.last_login_at }));
      },
      async create({ tenantId, email, passwordHash, fullName, roleKeys, status = 'active' }) {
        const userId = id();
        await pool.query('INSERT INTO users (id, tenant_id, email, password_hash, full_name, role_keys, status) VALUES (?, ?, ?, ?, ?, ?, ?)', [userId, tenantId, email.toLowerCase(), passwordHash, fullName, JSON.stringify(roleKeys), status]);
        return { id: userId, tenantId, email: email.toLowerCase(), fullName, phone: null, roleKeys, status, lastLoginAt: null, failedLoginAttempts: 0, lockedUntil: null };
      },
      // A successful login clears any lockout state, same call as
      // recording the login timestamp -- see auth/service.js's login().
      async recordLogin(userId) {
        await pool.query('UPDATE users SET last_login_at = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?', [now(), userId]);
      },
      async setStatus(tenantId, userId, status) {
        await pool.query('UPDATE users SET status = ? WHERE id = ? AND tenant_id = ?', [status, userId, tenantId]);
        return this.findById(userId);
      },
      async setRoles(tenantId, userId, roleKeys) {
        await pool.query('UPDATE users SET role_keys = ? WHERE id = ? AND tenant_id = ?', [JSON.stringify(roleKeys), userId, tenantId]);
        return this.findById(userId);
      },
      // My Account (Settings module) -- editable self-service profile
      // fields, scoped by tenantId same as setStatus/setRoles above.
      async updateProfile(tenantId, userId, patch) {
        const sets = [];
        const params = [];
        if (patch.fullName !== undefined) { sets.push('full_name = ?'); params.push(patch.fullName); }
        if (patch.phone !== undefined) { sets.push('phone = ?'); params.push(patch.phone); }
        if (!sets.length) return this.findById(userId);
        params.push(userId, tenantId);
        await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
        return this.findById(userId);
      },
      // Password/lockout fields -- scoped by userId only, same precedent
      // as recordLogin above.
      async updateSecurity(userId, patch) {
        const sets = [];
        const params = [];
        if (patch.passwordHash !== undefined) { sets.push('password_hash = ?'); params.push(patch.passwordHash); }
        if (patch.failedLoginAttempts !== undefined) { sets.push('failed_login_attempts = ?'); params.push(patch.failedLoginAttempts); }
        if (patch.lockedUntil !== undefined) { sets.push('locked_until = ?'); params.push(patch.lockedUntil); }
        if (!sets.length) return this.findById(userId);
        params.push(userId);
        await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
        return this.findById(userId);
      },
    },

    students: {
      async list(tenantId, { query = '', className, section, status, academicYear } = {}) {
        const clauses = ['tenant_id = ?'];
        const params = [tenantId];
        if (className) { clauses.push('class_name = ?'); params.push(className); }
        if (section) { clauses.push('section = ?'); params.push(section); }
        if (status) { clauses.push('status = ?'); params.push(status); }
        if (academicYear) { clauses.push('academic_year = ?'); params.push(academicYear); }
        if (query) { clauses.push('(first_name LIKE ? OR last_name LIKE ? OR admission_number LIKE ?)'); params.push(`%${query}%`, `%${query}%`, `%${query}%`); }
        const [rows] = await pool.query(`SELECT * FROM students WHERE ${clauses.join(' AND ')} ORDER BY first_name`, params);
        return rows.map(studentRow);
      },
      async findById(tenantId, studentId) {
        const [rows] = await pool.query('SELECT * FROM students WHERE id = ? AND tenant_id = ?', [studentId, tenantId]);
        return studentRow(row(rows));
      },
      async findByClassSection(tenantId, className, section) {
        const [rows] = await pool.query("SELECT * FROM students WHERE tenant_id = ? AND status = 'active' AND class_name = ? AND section = ?", [tenantId, className, section]);
        return rows.map(studentRow);
      },
      async existsByAdmissionNumber(tenantId, admissionNumber) {
        const [rows] = await pool.query('SELECT id FROM students WHERE tenant_id = ? AND admission_number = ?', [tenantId, admissionNumber]);
        return rows.length > 0;
      },
      async create(student) {
        const studentId = id();
        const cols = ['id', 'tenant_id', 'status', ...STUDENT_COLUMNS.map((c) => c.sql)];
        const values = [studentId, student.tenantId, 'active', ...STUDENT_COLUMNS.map((c) => {
          const value = student[c.js];
          if (c.serialize) return c.serialize(value);
          return value === undefined ? null : value;
        })];
        await pool.query(`INSERT INTO students (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, values);
        return this.findById(student.tenantId, studentId);
      },
      async update(tenantId, studentId, patch) {
        const setCols = STUDENT_COLUMNS.filter((c) => patch[c.js] !== undefined);
        if (setCols.length) {
          const setClause = [...setCols.map((c) => `${c.sql} = ?`), 'updated_at = ?'].join(', ');
          const values = [...setCols.map((c) => (c.serialize ? c.serialize(patch[c.js]) : patch[c.js])), now()];
          await pool.query(`UPDATE students SET ${setClause} WHERE id = ? AND tenant_id = ?`, [...values, studentId, tenantId]);
        }
        return this.findById(tenantId, studentId);
      },
      async archive(tenantId, studentId) {
        await pool.query("UPDATE students SET status = 'archived', updated_at = ? WHERE id = ? AND tenant_id = ?", [now(), studentId, tenantId]);
        return this.findById(tenantId, studentId);
      },
      async withdraw(tenantId, studentId, withdrawal) {
        await pool.query("UPDATE students SET status = 'withdrawn', withdrawal = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [JSON.stringify(withdrawal), now(), studentId, tenantId]);
        return this.findById(tenantId, studentId);
      },
      async transfer(tenantId, studentId, transfer) {
        await pool.query("UPDATE students SET status = 'transferred', transfer = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [JSON.stringify(transfer), now(), studentId, tenantId]);
        return this.findById(tenantId, studentId);
      },
    },

    staff: {
      async list(tenantId, { query = '', department, staffType, status } = {}) {
        const clauses = ['tenant_id = ?'];
        const params = [tenantId];
        if (department) { clauses.push('department = ?'); params.push(department); }
        if (staffType) { clauses.push('staff_type = ?'); params.push(staffType); }
        if (status) { clauses.push('status = ?'); params.push(status); }
        if (query) { clauses.push('(first_name LIKE ? OR last_name LIKE ? OR employee_id LIKE ?)'); params.push(`%${query}%`, `%${query}%`, `%${query}%`); }
        const [rows] = await pool.query(`SELECT * FROM staff WHERE ${clauses.join(' AND ')} ORDER BY first_name`, params);
        return rows.map(staffRow);
      },
      async findById(tenantId, staffId) {
        const [rows] = await pool.query('SELECT * FROM staff WHERE id = ? AND tenant_id = ?', [staffId, tenantId]);
        return staffRow(row(rows));
      },
      async existsByEmployeeId(tenantId, employeeId) {
        const [rows] = await pool.query('SELECT id FROM staff WHERE tenant_id = ? AND employee_id = ?', [tenantId, employeeId]);
        return rows.length > 0;
      },
      async create(staffMember) {
        const staffId = id();
        const cols = ['id', 'tenant_id', 'status', ...STAFF_COLUMNS.map((c) => c.sql)];
        const values = [staffId, staffMember.tenantId, 'active', ...STAFF_COLUMNS.map((c) => {
          const value = staffMember[c.js];
          if (c.serialize) return c.serialize(value);
          return value === undefined ? null : value;
        })];
        await pool.query(`INSERT INTO staff (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, values);
        return this.findById(staffMember.tenantId, staffId);
      },
      async update(tenantId, staffId, patch) {
        const setCols = STAFF_COLUMNS.filter((c) => patch[c.js] !== undefined);
        if (setCols.length) {
          const setClause = [...setCols.map((c) => `${c.sql} = ?`), 'updated_at = ?'].join(', ');
          const values = [...setCols.map((c) => (c.serialize ? c.serialize(patch[c.js]) : patch[c.js])), now()];
          await pool.query(`UPDATE staff SET ${setClause} WHERE id = ? AND tenant_id = ?`, [...values, staffId, tenantId]);
        }
        return this.findById(tenantId, staffId);
      },
      async archive(tenantId, staffId) {
        await pool.query("UPDATE staff SET status = 'inactive', updated_at = ? WHERE id = ? AND tenant_id = ?", [now(), staffId, tenantId]);
        return this.findById(tenantId, staffId);
      },
      async offboard(tenantId, staffId, offboarding) {
        await pool.query("UPDATE staff SET status = 'resigned', offboarding = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [JSON.stringify(offboarding), now(), staffId, tenantId]);
        return this.findById(tenantId, staffId);
      },
    },

    staffAssignments: {
      async listForStaff(tenantId, staffId) {
        const [rows] = await pool.query('SELECT * FROM staff_assignments WHERE tenant_id = ? AND staff_id = ? ORDER BY created_at', [tenantId, staffId]);
        return rows.map(staffAssignmentRow);
      },
      async listForTenant(tenantId) {
        const [rows] = await pool.query('SELECT * FROM staff_assignments WHERE tenant_id = ? ORDER BY created_at', [tenantId]);
        return rows.map(staffAssignmentRow);
      },
      async findById(tenantId, assignmentId) {
        const [rows] = await pool.query('SELECT * FROM staff_assignments WHERE id = ? AND tenant_id = ?', [assignmentId, tenantId]);
        return staffAssignmentRow(row(rows));
      },
      async create(assignment) {
        const assignmentId = id();
        await pool.query(
          'INSERT INTO staff_assignments (id, tenant_id, staff_id, subject, class_name, section, periods_per_week, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [assignmentId, assignment.tenantId, assignment.staffId, assignment.subject, assignment.className, assignment.section, assignment.periodsPerWeek || 1, assignment.role || 'Subject'],
        );
        return this.findById(assignment.tenantId, assignmentId);
      },
      async update(tenantId, assignmentId, patch) {
        const map = { subject: 'subject', className: 'class_name', section: 'section', periodsPerWeek: 'periods_per_week', role: 'role' };
        const setCols = Object.entries(map).filter(([js]) => patch[js] !== undefined);
        if (setCols.length) {
          const setClause = setCols.map(([, sql]) => `${sql} = ?`).join(', ');
          const values = setCols.map(([js]) => patch[js]);
          await pool.query(`UPDATE staff_assignments SET ${setClause} WHERE id = ? AND tenant_id = ?`, [...values, assignmentId, tenantId]);
        }
        return this.findById(tenantId, assignmentId);
      },
      async remove(tenantId, assignmentId) {
        const [result] = await pool.query('DELETE FROM staff_assignments WHERE id = ? AND tenant_id = ?', [assignmentId, tenantId]);
        return result.affectedRows > 0;
      },
    },

    staffLeave: {
      async list(tenantId, { staffId, status } = {}) {
        const clauses = ['tenant_id = ?'];
        const params = [tenantId];
        if (staffId) { clauses.push('staff_id = ?'); params.push(staffId); }
        if (status) { clauses.push('status = ?'); params.push(status); }
        const [rows] = await pool.query(`SELECT * FROM staff_leave WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params);
        return rows.map(staffLeaveRow);
      },
      async findById(tenantId, leaveId) {
        const [rows] = await pool.query('SELECT * FROM staff_leave WHERE id = ? AND tenant_id = ?', [leaveId, tenantId]);
        return staffLeaveRow(row(rows));
      },
      async create(leave) {
        const leaveId = id();
        await pool.query(
          'INSERT INTO staff_leave (id, tenant_id, staff_id, leave_type, start_date, end_date, days_count, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [leaveId, leave.tenantId, leave.staffId, leave.leaveType, leave.startDate, leave.endDate, leave.daysCount, leave.reason || null, 'pending'],
        );
        return this.findById(leave.tenantId, leaveId);
      },
      async decide(tenantId, leaveId, { status, decidedBy }) {
        await pool.query('UPDATE staff_leave SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND tenant_id = ?', [status, decidedBy, now(), leaveId, tenantId]);
        return this.findById(tenantId, leaveId);
      },
    },

    attendance: {
      async findMatching(tenantId, date, className, section) {
        const [rows] = await pool.query('SELECT * FROM attendance WHERE tenant_id = ? AND date = ? AND class_name = ? AND section = ?', [tenantId, date, className, section]);
        return rows.map(attendanceRow);
      },
      async findByStudent(tenantId, studentId) {
        const [rows] = await pool.query('SELECT * FROM attendance WHERE tenant_id = ? AND student_id = ? ORDER BY date DESC', [tenantId, studentId]);
        return rows.map(attendanceRow);
      },
      async summary(tenantId, { date, className, section }) {
        const clauses = ['tenant_id = ?', 'date = ?'];
        const params = [tenantId, date];
        if (className) { clauses.push('class_name = ?'); params.push(className); }
        if (section) { clauses.push('section = ?'); params.push(section); }
        const [rows] = await pool.query(`SELECT * FROM attendance WHERE ${clauses.join(' AND ')}`, params);
        return rows.map(attendanceRow);
      },
      async upsertMany(tenantId, { date, className, section, records, actorId }) {
        const saved = [];
        for (const item of records) {
          const [existingRows] = await pool.query('SELECT * FROM attendance WHERE tenant_id = ? AND student_id = ? AND date = ?', [tenantId, item.studentId, date]);
          const existing = row(existingRows);
          const timestamp = now();
          const recordId = existing?.id || id();
          if (existing) {
            await pool.query('UPDATE attendance SET status = ?, remark = ?, updated_by = ?, updated_at = ? WHERE id = ?', [item.status, item.remark?.trim() || '', actorId, timestamp, recordId]);
          } else {
            await pool.query(
              'INSERT INTO attendance (id, tenant_id, student_id, date, class_name, section, status, remark, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [recordId, tenantId, item.studentId, date, className, section, item.status, item.remark?.trim() || '', actorId, timestamp, actorId, timestamp],
            );
          }
          const after = { id: recordId, tenantId, date, className, section, studentId: item.studentId, status: item.status, remark: item.remark?.trim() || '', createdBy: existing?.created_by || actorId, createdAt: existing?.created_at || timestamp, updatedBy: actorId, updatedAt: timestamp };
          await pool.query(
            'INSERT INTO attendance_history (id, tenant_id, attendance_id, action, actor_id, before_json, after_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [id(), tenantId, recordId, existing ? 'updated' : 'created', actorId, existing ? JSON.stringify(attendanceRow(existing)) : null, JSON.stringify(after), timestamp],
          );
          saved.push(after);
        }
        return saved;
      },
      async history(tenantId) {
        const [rows] = await pool.query('SELECT * FROM attendance_history WHERE tenant_id = ? ORDER BY at DESC', [tenantId]);
        return rows.map((r) => ({
          id: r.id, tenantId: r.tenant_id, attendanceId: r.attendance_id, action: r.action, actorId: r.actor_id,
          before: r.before_json ? JSON.parse(r.before_json) : null, after: JSON.parse(r.after_json), at: r.at,
        }));
      },
    },

    attendanceCorrectionRequests: {
      async list(tenantId, { status } = {}) {
        const clauses = ['tenant_id = ?'];
        const params = [tenantId];
        if (status) { clauses.push('status = ?'); params.push(status); }
        const [rows] = await pool.query(`SELECT * FROM attendance_correction_requests WHERE ${clauses.join(' AND ')} ORDER BY requested_at DESC`, params);
        return rows.map(correctionRequestRow);
      },
      async findById(tenantId, requestId) {
        const [rows] = await pool.query('SELECT * FROM attendance_correction_requests WHERE id = ? AND tenant_id = ?', [requestId, tenantId]);
        return correctionRequestRow(row(rows));
      },
      async create(payload) {
        const requestId = id();
        await pool.query(
          `INSERT INTO attendance_correction_requests
           (id, tenant_id, student_id, date, class_name, section, previous_status, previous_remark, requested_status, requested_remark, reason, status, requested_by, requested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          [requestId, payload.tenantId, payload.studentId, payload.date, payload.className, payload.section,
            payload.previousStatus ?? null, payload.previousRemark ?? null, payload.requestedStatus, payload.requestedRemark,
            payload.reason, payload.requestedBy, payload.requestedAt],
        );
        return this.findById(payload.tenantId, requestId);
      },
      async decide(tenantId, requestId, { status, decidedBy, decisionNote }) {
        await pool.query(
          'UPDATE attendance_correction_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND tenant_id = ?',
          [status, decidedBy, now(), decisionNote || null, requestId, tenantId],
        );
        return this.findById(tenantId, requestId);
      },
    },

    attendancePeriods: {
      async findForDay(tenantId, date, className, section) {
        const [rows] = await pool.query(
          'SELECT * FROM attendance_periods WHERE tenant_id = ? AND date = ? AND class_name = ? AND section = ?',
          [tenantId, date, className, section],
        );
        return rows.map(attendancePeriodRow);
      },
      async upsertMany(tenantId, { date, slotId, className, section, subject, records, actorId }) {
        const saved = [];
        for (const item of records) {
          const [existingRows] = await pool.query(
            'SELECT * FROM attendance_periods WHERE tenant_id = ? AND student_id = ? AND date = ? AND slot_id = ?',
            [tenantId, item.studentId, date, slotId],
          );
          const existing = row(existingRows);
          const timestamp = now();
          const recordId = existing?.id || id();
          if (existing) {
            await pool.query(
              'UPDATE attendance_periods SET status = ?, remark = ?, subject = ?, updated_by = ?, updated_at = ? WHERE id = ?',
              [item.status, item.remark?.trim() || '', subject, actorId, timestamp, recordId],
            );
          } else {
            await pool.query(
              `INSERT INTO attendance_periods (id, tenant_id, student_id, date, slot_id, class_name, section, subject, status, remark, created_by, created_at, updated_by, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [recordId, tenantId, item.studentId, date, slotId, className, section, subject, item.status, item.remark?.trim() || '', actorId, timestamp, actorId, timestamp],
            );
          }
          saved.push({
            id: recordId, tenantId, date, slotId, className, section, subject, studentId: item.studentId,
            status: item.status, remark: item.remark?.trim() || '', createdBy: existing?.created_by || actorId,
            createdAt: existing?.created_at || timestamp, updatedBy: actorId, updatedAt: timestamp,
          });
        }
        return saved;
      },
    },

    // Parent Registry -- see modules/parents/service.js's header for the
    // full design rationale. parentStudentLinks needs a hand-written list()
    // because callers filter by EITHER parentId OR studentId --
    // sqlSimpleCollection's extraFilterColumn only supports one fixed
    // column, not either-of-two.
    parents: sqlSimpleCollection('parents', [
      { js: 'fullName', sql: 'full_name' },
      { js: 'phone', sql: 'phone' },
      { js: 'email', sql: 'email' },
      { js: 'address', sql: 'address' },
      { js: 'occupation', sql: 'occupation' },
      { js: 'portalAccess', sql: 'portal_access', parse: (v) => Boolean(v), serialize: (v) => (v ? 1 : 0) },
      { js: 'status', sql: 'status' },
      { js: 'mergedInto', sql: 'merged_into' },
      { js: 'updatedAt', sql: 'updated_at' },
    ]),

    parentStudentLinks: {
      async list(tenantId, { parentId, studentId } = {}) {
        const clauses = ['tenant_id = ?'];
        const params = [tenantId];
        if (parentId) { clauses.push('parent_id = ?'); params.push(parentId); }
        if (studentId) { clauses.push('student_id = ?'); params.push(studentId); }
        const [rows] = await pool.query(`SELECT * FROM parent_student_links WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params);
        return rows.map(parentLinkRow);
      },
      async findById(tenantId, linkId) {
        const [rows] = await pool.query('SELECT * FROM parent_student_links WHERE id = ? AND tenant_id = ?', [linkId, tenantId]);
        return parentLinkRow(row(rows));
      },
      async create(payload) {
        const linkId = id();
        await pool.query(
          'INSERT INTO parent_student_links (id, tenant_id, parent_id, student_id, relationship, is_primary_contact, is_emergency_contact) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [linkId, payload.tenantId, payload.parentId, payload.studentId, payload.relationship, payload.isPrimaryContact ? 1 : 0, payload.isEmergencyContact ? 1 : 0],
        );
        return this.findById(payload.tenantId, linkId);
      },
      async update(tenantId, linkId, patch) {
        const map = { parentId: 'parent_id', relationship: 'relationship', isPrimaryContact: 'is_primary_contact', isEmergencyContact: 'is_emergency_contact' };
        const sets = []; const values = [];
        for (const [k, v] of Object.entries(patch)) {
          if (!map[k]) continue;
          sets.push(`${map[k]} = ?`);
          values.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
        }
        if (sets.length) await pool.query(`UPDATE parent_student_links SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`, [...values, linkId, tenantId]);
        return this.findById(tenantId, linkId);
      },
      async remove(tenantId, linkId) {
        const [result] = await pool.query('DELETE FROM parent_student_links WHERE id = ? AND tenant_id = ?', [linkId, tenantId]);
        return result.affectedRows > 0;
      },
    },

    attendanceInterventions: sqlSimpleCollection('attendance_interventions', [
      { js: 'studentId', sql: 'student_id' },
      { js: 'type', sql: 'type' },
      { js: 'note', sql: 'note' },
      { js: 'createdBy', sql: 'created_by' },
    ], { js: 'studentId', sql: 'student_id' }),

    // Examinations (designs/Teacher feature UI mockup/Examinations.dc.html).
    // exam_sessions itself (the Datesheet, screen 3) is extended above, not
    // duplicated -- see this file's examSessionRow/examSessions block.
    examCycles: sqlSimpleCollection('exam_cycles', [
      { js: 'name', sql: 'name' },
      { js: 'academicTerm', sql: 'academic_term' },
      { js: 'examType', sql: 'exam_type' },
      { js: 'windowOpens', sql: 'window_opens' },
      { js: 'windowCloses', sql: 'window_closes' },
      { js: 'weightInTermMark', sql: 'weight_in_term_mark', parse: (v) => Number(v) },
      { js: 'classNames', sql: 'class_names', parse: safeParseJson, serialize: (v) => JSON.stringify(v || []) },
      { js: 'marksEntryCloses', sql: 'marks_entry_closes' },
      { js: 'entryRolePolicy', sql: 'entry_role_policy' },
      { js: 'stage', sql: 'stage' },
      { js: 'copiedFromCycleId', sql: 'copied_from_cycle_id' },
      { js: 'publishSettings', sql: 'publish_settings', parse: safeParseJson, serialize: (v) => (v ? JSON.stringify(v) : null) },
      { js: 'createdBy', sql: 'created_by' },
      { js: 'updatedAt', sql: 'updated_at' },
    ]),

    examStructure: {
      ...sqlSimpleCollection('exam_structure', [
        { js: 'cycleId', sql: 'cycle_id' },
        { js: 'className', sql: 'class_name' },
        { js: 'subjectName', sql: 'subject_name' },
        { js: 'maxMarks', sql: 'max_marks', parse: (v) => Number(v) },
        { js: 'passMarks', sql: 'pass_marks', parse: (v) => Number(v) },
        { js: 'weight', sql: 'weight', parse: (v) => Number(v) },
        { js: 'updatedAt', sql: 'updated_at' },
      ], { js: 'cycleId', sql: 'cycle_id' }),
      async findOne(tenantId, { cycleId, className, subjectName }) {
        const rows = await this.list(tenantId, { cycleId });
        return rows.find((s) => s.className === className && s.subjectName === subjectName) || null;
      },
    },

    examStructureComponents: sqlSimpleCollection('exam_structure_components', [
      { js: 'structureId', sql: 'structure_id' },
      { js: 'name', sql: 'name' },
      { js: 'maxMarks', sql: 'max_marks', parse: (v) => Number(v) },
      { js: 'passMarks', sql: 'pass_marks', parse: (v) => Number(v) },
      { js: 'orderIndex', sql: 'order_index', parse: (v) => Number(v) },
    ], { js: 'structureId', sql: 'structure_id' }),

    examMarksheets: {
      ...sqlSimpleCollection('exam_marksheets', [
        { js: 'cycleId', sql: 'cycle_id' },
        { js: 'className', sql: 'class_name' },
        { js: 'section', sql: 'section' },
        { js: 'subjectName', sql: 'subject_name' },
        { js: 'teacherStaffId', sql: 'teacher_staff_id' },
        { js: 'status', sql: 'status' },
        { js: 'submittedBy', sql: 'submitted_by' },
        { js: 'submittedAt', sql: 'submitted_at' },
        { js: 'decidedBy', sql: 'decided_by' },
        { js: 'decidedAt', sql: 'decided_at' },
        { js: 'reviewerNote', sql: 'reviewer_note' },
        { js: 'mean', sql: 'mean', parse: (v) => (v === null ? null : Number(v)) },
        { js: 'passRatePct', sql: 'pass_rate_pct', parse: (v) => (v === null ? null : Number(v)) },
        { js: 'flags', sql: 'flags', parse: safeParseJson, serialize: (v) => JSON.stringify(v || []) },
        { js: 'updatedAt', sql: 'updated_at' },
      ], { js: 'cycleId', sql: 'cycle_id' }),
      async findOne(tenantId, { cycleId, className, section, subjectName }) {
        const rows = await this.list(tenantId, { cycleId });
        return rows.find((m) => m.className === className && m.section === section && m.subjectName === subjectName) || null;
      },
    },

    examMarks: {
      ...sqlSimpleCollection('exam_marks', [
        { js: 'marksheetId', sql: 'marksheet_id' },
        { js: 'studentId', sql: 'student_id' },
        { js: 'componentMarks', sql: 'component_marks', parse: safeParseJson, serialize: (v) => JSON.stringify(v || {}) },
        { js: 'total', sql: 'total', parse: (v) => (v === null ? null : Number(v)) },
        { js: 'grade', sql: 'grade' },
        { js: 'flag', sql: 'flag' },
        { js: 'remark', sql: 'remark' },
        { js: 'updatedAt', sql: 'updated_at' },
      ], { js: 'marksheetId', sql: 'marksheet_id' }),
      async findOne(tenantId, { marksheetId, studentId }) {
        const rows = await this.list(tenantId, { marksheetId });
        return rows.find((m) => m.studentId === studentId) || null;
      },
    },

    // One row per cycle+student -- upsert-by-lookup, same reasoning as the
    // memory adapter's version.
    examReportComments: {
      async list(tenantId, { cycleId } = {}) {
        const clauses = ['tenant_id = ?'];
        const params = [tenantId];
        if (cycleId) { clauses.push('cycle_id = ?'); params.push(cycleId); }
        const [rows] = await pool.query(`SELECT * FROM exam_report_comments WHERE ${clauses.join(' AND ')}`, params);
        return rows.map((r) => ({
          id: r.id, tenantId: r.tenant_id, cycleId: r.cycle_id, className: r.class_name, studentId: r.student_id,
          comment: r.comment, classTeacherStaffId: r.class_teacher_staff_id, updatedAt: r.updated_at,
        }));
      },
      async upsert(tenantId, { cycleId, studentId, className, comment, classTeacherStaffId = null }) {
        const [existingRows] = await pool.query('SELECT id FROM exam_report_comments WHERE tenant_id = ? AND cycle_id = ? AND student_id = ?', [tenantId, cycleId, studentId]);
        const existing = row(existingRows);
        if (existing) {
          await pool.query('UPDATE exam_report_comments SET comment = ?, class_teacher_staff_id = ?, updated_at = ? WHERE id = ?', [comment, classTeacherStaffId, now(), existing.id]);
        } else {
          await pool.query(
            'INSERT INTO exam_report_comments (id, tenant_id, cycle_id, class_name, student_id, comment, class_teacher_staff_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [id(), tenantId, cycleId, className, studentId, comment, classTeacherStaffId, now()],
          );
        }
        const [rows] = await pool.query('SELECT * FROM exam_report_comments WHERE tenant_id = ? AND cycle_id = ? AND student_id = ?', [tenantId, cycleId, studentId]);
        const r = row(rows);
        return r && {
          id: r.id, tenantId: r.tenant_id, cycleId: r.cycle_id, className: r.class_name, studentId: r.student_id,
          comment: r.comment, classTeacherStaffId: r.class_teacher_staff_id, updatedAt: r.updated_at,
        };
      },
    },

    // Append-only -- mirrors attendance_history's before/after/actor/at
    // shape, scoped by an optional cycleId. See schema.sql's comment.
    examAuditLog: {
      async record({ event, actorId, target = null, tenantId, cycleId = null, detail = '', beforeJson = null, afterJson = null }) {
        await pool.query(
          'INSERT INTO exam_audit_log (id, tenant_id, cycle_id, event, actor_id, target, detail, before_json, after_json, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id(), tenantId, cycleId, event, actorId, target, detail, beforeJson ? JSON.stringify(beforeJson) : null, afterJson ? JSON.stringify(afterJson) : null, now()],
        );
      },
      async list(tenantId, { cycleId } = {}) {
        const clauses = ['tenant_id = ?'];
        const params = [tenantId];
        if (cycleId) { clauses.push('cycle_id = ?'); params.push(cycleId); }
        const [rows] = await pool.query(`SELECT * FROM exam_audit_log WHERE ${clauses.join(' AND ')} ORDER BY at DESC`, params);
        return rows.map((r) => ({
          id: r.id, tenantId: r.tenant_id, cycleId: r.cycle_id, event: r.event, actorId: r.actor_id, target: r.target,
          detail: r.detail, beforeJson: r.before_json ? JSON.parse(r.before_json) : null, afterJson: r.after_json ? JSON.parse(r.after_json) : null, at: r.at,
        }));
      },
    },

    attendanceSettings: {
      async get(tenantId) {
        const [rows] = await pool.query('SELECT * FROM attendance_settings WHERE tenant_id = ?', [tenantId]);
        const r = row(rows);
        return r && {
          tenantId: r.tenant_id, registerLockTime: r.register_lock_time, backdateWindowDays: r.backdate_window_days,
          atRiskThreshold: r.at_risk_threshold, consecutiveAbsenceTrigger: r.consecutive_absence_trigger,
          leaveNeedsNote: !!r.leave_needs_note, periodMarkingPhases: JSON.parse(r.period_marking_phases || '[]'),
          notifyRules: JSON.parse(r.notify_rules || '[]'), updatedAt: r.updated_at,
        };
      },
      async upsert(tenantId, patch) {
        const existing = await this.get(tenantId);
        const merged = { ...existing, ...patch };
        if (!existing) {
          await pool.query(
            `INSERT INTO attendance_settings (tenant_id, register_lock_time, backdate_window_days, at_risk_threshold, consecutive_absence_trigger, leave_needs_note, period_marking_phases, notify_rules)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [tenantId, merged.registerLockTime ?? '10:00', merged.backdateWindowDays ?? 7, merged.atRiskThreshold ?? 75,
              merged.consecutiveAbsenceTrigger ?? 3, merged.leaveNeedsNote ?? true ? 1 : 0,
              JSON.stringify(merged.periodMarkingPhases ?? []), JSON.stringify(merged.notifyRules ?? [])],
          );
        } else {
          await pool.query(
            `UPDATE attendance_settings SET register_lock_time = ?, backdate_window_days = ?, at_risk_threshold = ?, consecutive_absence_trigger = ?, leave_needs_note = ?, period_marking_phases = ?, notify_rules = ?, updated_at = ? WHERE tenant_id = ?`,
            [merged.registerLockTime, merged.backdateWindowDays, merged.atRiskThreshold, merged.consecutiveAbsenceTrigger,
              merged.leaveNeedsNote ? 1 : 0, JSON.stringify(merged.periodMarkingPhases ?? []), JSON.stringify(merged.notifyRules ?? []), now(), tenantId],
          );
        }
        return this.get(tenantId);
      },
    },

    schoolProfile: {
      async get(tenantId) {
        const [rows] = await pool.query('SELECT * FROM school_profiles WHERE tenant_id = ?', [tenantId]);
        const r = row(rows);
        if (!r) return emptyProfile(tenantId);
        const profile = { tenantId: r.tenant_id, updatedAt: r.updated_at };
        for (const [section, column] of Object.entries(PROFILE_SECTION_COLUMN)) profile[section] = safeParseJson(r[column]);
        return profile;
      },
      async updateSection(tenantId, section, data) {
        const column = PROFILE_SECTION_COLUMN[section];
        const [existingRows] = await pool.query('SELECT tenant_id FROM school_profiles WHERE tenant_id = ?', [tenantId]);
        const timestamp = now();
        if (row(existingRows)) {
          await pool.query(`UPDATE school_profiles SET ${column} = ?, updated_at = ? WHERE tenant_id = ?`, [JSON.stringify(data), timestamp, tenantId]);
        } else {
          await pool.query(`INSERT INTO school_profiles (tenant_id, ${column}, updated_at) VALUES (?, ?, ?)`, [tenantId, JSON.stringify(data), timestamp]);
        }
        return this.get(tenantId);
      },
    },

    academicYears: {
      ...sqlSimpleCollection('academic_years', [
        { js: 'label', sql: 'label' },
        { js: 'startDate', sql: 'start_date' },
        { js: 'endDate', sql: 'end_date' },
        { js: 'status', sql: 'status' },
      ]),
      async setCurrent(tenantId, yearId) {
        const [rows] = await pool.query('SELECT id FROM academic_years WHERE id = ? AND tenant_id = ?', [yearId, tenantId]);
        if (!row(rows)) return null;
        await pool.query("UPDATE academic_years SET status = 'closed' WHERE tenant_id = ? AND status = 'current'", [tenantId]);
        await pool.query("UPDATE academic_years SET status = 'current' WHERE id = ? AND tenant_id = ?", [yearId, tenantId]);
        const [after] = await pool.query('SELECT * FROM academic_years WHERE id = ? AND tenant_id = ?', [yearId, tenantId]);
        const r = row(after);
        return r && { id: r.id, tenantId: r.tenant_id, label: r.label, startDate: r.start_date, endDate: r.end_date, status: r.status, createdAt: r.created_at };
      },
    },

    academicTerms: sqlSimpleCollection('academic_terms', [
      { js: 'academicYearId', sql: 'academic_year_id' },
      { js: 'name', sql: 'name' },
      { js: 'startDate', sql: 'start_date' },
      { js: 'endDate', sql: 'end_date' },
    ], { js: 'academicYearId', sql: 'academic_year_id' }),

    subjects: sqlSimpleCollection('subjects', [
      { js: 'name', sql: 'name' },
      { js: 'code', sql: 'code' },
      { js: 'applicableClasses', sql: 'applicable_classes' },
    ]),

    holidays: sqlSimpleCollection('holidays', [
      { js: 'name', sql: 'name' },
      { js: 'startDate', sql: 'start_date' },
      { js: 'endDate', sql: 'end_date' },
      { js: 'type', sql: 'type' },
    ]),

    grades: sqlSimpleCollection('grades', [
      { js: 'grade', sql: 'grade' },
      { js: 'minMarks', sql: 'min_marks', parse: (v) => Number(v) },
      { js: 'maxMarks', sql: 'max_marks', parse: (v) => Number(v) },
      { js: 'gradePoint', sql: 'grade_point', parse: (v) => Number(v) },
      { js: 'descriptor', sql: 'descriptor' },
    ]),

    feeTypes: sqlSimpleCollection('fee_types', [
      { js: 'name', sql: 'name' },
      { js: 'frequency', sql: 'frequency' },
      { js: 'applicableClasses', sql: 'applicable_classes' },
      { js: 'amount', sql: 'amount', parse: (v) => (v === null ? null : Number(v)) },
    ]),

    // Timetable -- same contract as memoryAdapter.js; see that file's
    // comments for the reasoning behind each shape.
    timetableConfig: {
      async get(tenantId) {
        const [rows] = await pool.query('SELECT * FROM timetable_config WHERE tenant_id = ?', [tenantId]);
        const r = row(rows);
        if (!r) return null;
        return {
          tenantId: r.tenant_id, cycleDays: r.cycle_days, cycleAnchor: r.cycle_anchor,
          slots: safeParseJson(r.slots), hardRules: safeParseJson(r.hard_rules), softRules: safeParseJson(r.soft_rules),
          updatedAt: r.updated_at,
        };
      },
      async upsert(tenantId, patch) {
        const existing = await this.get(tenantId);
        const timestamp = now();
        const merged = { ...(existing || { cycleDays: 6, cycleAnchor: '2026-09-14', slots: [], hardRules: [], softRules: [] }), ...patch };
        if (existing) {
          await pool.query(
            'UPDATE timetable_config SET cycle_days = ?, cycle_anchor = ?, slots = ?, hard_rules = ?, soft_rules = ?, updated_at = ? WHERE tenant_id = ?',
            [merged.cycleDays, merged.cycleAnchor, JSON.stringify(merged.slots), JSON.stringify(merged.hardRules), JSON.stringify(merged.softRules), timestamp, tenantId],
          );
        } else {
          await pool.query(
            'INSERT INTO timetable_config (tenant_id, cycle_days, cycle_anchor, slots, hard_rules, soft_rules, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [tenantId, merged.cycleDays, merged.cycleAnchor, JSON.stringify(merged.slots), JSON.stringify(merged.hardRules), JSON.stringify(merged.softRules), timestamp],
          );
        }
        return this.get(tenantId);
      },
    },

    timetableVenues: sqlSimpleCollection('timetable_venues', [
      { js: 'name', sql: 'name' },
      { js: 'capacity', sql: 'capacity' },
      { js: 'subjects', sql: 'subjects' },
    ]),

    timetableVersions: {
      async list(tenantId) {
        const [rows] = await pool.query('SELECT * FROM timetable_versions WHERE tenant_id = ? ORDER BY version_number DESC', [tenantId]);
        return rows.map(timetableVersionRow);
      },
      async findById(tenantId, versionId) {
        const [rows] = await pool.query('SELECT * FROM timetable_versions WHERE id = ? AND tenant_id = ?', [versionId, tenantId]);
        return timetableVersionRow(row(rows));
      },
      async getLive(tenantId) {
        const [rows] = await pool.query("SELECT * FROM timetable_versions WHERE tenant_id = ? AND state = 'live'", [tenantId]);
        return timetableVersionRow(row(rows));
      },
      async create({ tenantId, note = '', sourceRunId = null, createdBy }) {
        const [rows] = await pool.query('SELECT COALESCE(MAX(version_number), 0) AS maxVersion FROM timetable_versions WHERE tenant_id = ?', [tenantId]);
        const versionNumber = (row(rows)?.maxVersion || 0) + 1;
        const versionId = id();
        await pool.query(
          'INSERT INTO timetable_versions (id, tenant_id, version_number, state, note, source_run_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [versionId, tenantId, versionNumber, 'draft', note, sourceRunId, createdBy],
        );
        return this.findById(tenantId, versionId);
      },
      async publish(tenantId, versionId, { effectiveFrom } = {}) {
        const version = await this.findById(tenantId, versionId);
        if (!version) return null;
        await pool.query("UPDATE timetable_versions SET state = 'archived' WHERE tenant_id = ? AND state = 'live'", [tenantId]);
        await pool.query("UPDATE timetable_versions SET state = 'live', published_at = ?, effective_from = ? WHERE id = ? AND tenant_id = ?", [now(), effectiveFrom || null, versionId, tenantId]);
        return this.findById(tenantId, versionId);
      },
    },

    timetableEntries: {
      async listForVersion(tenantId, versionId) {
        const [rows] = await pool.query('SELECT * FROM timetable_entries WHERE tenant_id = ? AND version_id = ?', [tenantId, versionId]);
        return rows.map(timetableEntryRow);
      },
      async replaceForVersion(tenantId, versionId, entries) {
        await pool.query('DELETE FROM timetable_entries WHERE tenant_id = ? AND version_id = ?', [tenantId, versionId]);
        const records = [];
        for (const e of entries) {
          const entryId = id();
          await pool.query(
            'INSERT INTO timetable_entries (id, tenant_id, version_id, class_name, section, day, slot_id, subject, staff_id, venue_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [entryId, tenantId, versionId, e.className, e.section, e.day, e.slotId, e.subject, e.staffId, e.venueId || null, e.source || 'generated'],
          );
          records.push({ id: entryId, tenantId, versionId, createdAt: new Date().toISOString(), ...e });
        }
        return records;
      },
      async upsertOne(tenantId, versionId, entry) {
        const [existingRows] = await pool.query(
          'SELECT id FROM timetable_entries WHERE tenant_id = ? AND version_id = ? AND class_name = ? AND section = ? AND day = ? AND slot_id = ?',
          [tenantId, versionId, entry.className, entry.section, entry.day, entry.slotId],
        );
        const existing = row(existingRows);
        const entryId = existing?.id || id();
        if (existing) {
          await pool.query(
            'UPDATE timetable_entries SET subject = ?, staff_id = ?, venue_id = ?, source = ? WHERE id = ?',
            [entry.subject, entry.staffId, entry.venueId || null, entry.source || 'manual', entryId],
          );
        } else {
          await pool.query(
            'INSERT INTO timetable_entries (id, tenant_id, version_id, class_name, section, day, slot_id, subject, staff_id, venue_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [entryId, tenantId, versionId, entry.className, entry.section, entry.day, entry.slotId, entry.subject, entry.staffId, entry.venueId || null, entry.source || 'manual'],
          );
        }
        const [rows] = await pool.query('SELECT * FROM timetable_entries WHERE id = ?', [entryId]);
        return timetableEntryRow(row(rows));
      },
      async removeOne(tenantId, versionId, { className, section, day, slotId }) {
        const [result] = await pool.query(
          'DELETE FROM timetable_entries WHERE tenant_id = ? AND version_id = ? AND class_name = ? AND section = ? AND day = ? AND slot_id = ?',
          [tenantId, versionId, className, section, day, slotId],
        );
        return result.affectedRows > 0;
      },
    },

    timetableRuns: {
      async list(tenantId) {
        const [rows] = await pool.query('SELECT * FROM timetable_runs WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]);
        return rows.map(timetableRunRow);
      },
      async create(run) {
        const runId = id();
        await pool.query(
          'INSERT INTO timetable_runs (id, tenant_id, version_id, hard_rules, soft_rules, total_periods, placed_periods, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [runId, run.tenantId, run.versionId, JSON.stringify(run.hardRules), JSON.stringify(run.softRules), run.totalPeriods, run.placedPeriods, run.note || '', run.createdBy],
        );
        const [rows] = await pool.query('SELECT * FROM timetable_runs WHERE id = ?', [runId]);
        return timetableRunRow(row(rows));
      },
    },

    examSessions: {
      async list(tenantId, { className } = {}) {
        const clauses = ['tenant_id = ?'];
        const params = [tenantId];
        if (className) { clauses.push('class_name = ?'); params.push(className); }
        const [rows] = await pool.query(`SELECT * FROM exam_sessions WHERE ${clauses.join(' AND ')} ORDER BY exam_date, session`, params);
        return rows.map(examSessionRow);
      },
      async findById(tenantId, examId) {
        const [rows] = await pool.query('SELECT * FROM exam_sessions WHERE id = ? AND tenant_id = ?', [examId, tenantId]);
        return examSessionRow(row(rows));
      },
      async create(exam) {
        const examId = id();
        await pool.query(
          `INSERT INTO exam_sessions (id, tenant_id, class_name, exam_date, session, subject, venue, seats, invigilator_staff_id, term_label, cycle_id, period_slot_id, duration_minutes, sections_included)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [examId, exam.tenantId, exam.className, exam.examDate, exam.session, exam.subject, exam.venue || '', exam.seats || 0, exam.invigilatorStaffId || null, exam.termLabel || '',
            exam.cycleId || null, exam.periodSlotId || null, exam.durationMinutes ?? null, JSON.stringify(exam.sectionsIncluded || [])],
        );
        return this.findById(exam.tenantId, examId);
      },
      async update(tenantId, examId, patch) {
        const map = {
          className: 'class_name', examDate: 'exam_date', session: 'session', subject: 'subject', venue: 'venue', seats: 'seats',
          invigilatorStaffId: 'invigilator_staff_id', termLabel: 'term_label', cycleId: 'cycle_id', periodSlotId: 'period_slot_id',
          durationMinutes: 'duration_minutes',
        };
        const setCols = Object.entries(map).filter(([js]) => patch[js] !== undefined);
        if (setCols.length) {
          const setClause = setCols.map(([, sql]) => `${sql} = ?`).join(', ');
          const values = setCols.map(([js]) => patch[js]);
          await pool.query(`UPDATE exam_sessions SET ${setClause} WHERE id = ? AND tenant_id = ?`, [...values, examId, tenantId]);
        }
        if (patch.sectionsIncluded !== undefined) {
          await pool.query('UPDATE exam_sessions SET sections_included = ? WHERE id = ? AND tenant_id = ?', [JSON.stringify(patch.sectionsIncluded || []), examId, tenantId]);
        }
        return this.findById(tenantId, examId);
      },
      async remove(tenantId, examId) {
        const [result] = await pool.query('DELETE FROM exam_sessions WHERE id = ? AND tenant_id = ?', [examId, tenantId]);
        return result.affectedRows > 0;
      },
    },

    timetableRelief: {
      async listForDate(tenantId, reliefDate) {
        const [rows] = await pool.query('SELECT * FROM timetable_relief WHERE tenant_id = ? AND relief_date = ?', [tenantId, reliefDate]);
        return rows.map(timetableReliefRow);
      },
      async findById(tenantId, reliefId) {
        const [rows] = await pool.query('SELECT * FROM timetable_relief WHERE id = ? AND tenant_id = ?', [reliefId, tenantId]);
        return timetableReliefRow(row(rows));
      },
      async ensure(tenantId, r) {
        const [existingRows] = await pool.query(
          'SELECT * FROM timetable_relief WHERE tenant_id = ? AND relief_date = ? AND slot_id = ? AND class_name = ? AND section = ?',
          [tenantId, r.reliefDate, r.slotId, r.className, r.section],
        );
        const existing = row(existingRows);
        if (existing) return timetableReliefRow(existing);
        const reliefId = id();
        await pool.query(
          'INSERT INTO timetable_relief (id, tenant_id, relief_date, slot_id, class_name, section, subject, absent_staff_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [reliefId, tenantId, r.reliefDate, r.slotId, r.className, r.section, r.subject, r.absentStaffId, 'open'],
        );
        return this.findById(tenantId, reliefId);
      },
      async assign(tenantId, reliefId, { coverStaffId, note = '' }) {
        await pool.query(
          "UPDATE timetable_relief SET cover_staff_id = ?, status = ?, note = CASE WHEN ? <> '' THEN ? ELSE note END WHERE id = ? AND tenant_id = ?",
          [coverStaffId, coverStaffId ? 'covered' : 'open', note, note, reliefId, tenantId],
        );
        return this.findById(tenantId, reliefId);
      },
      async markNotified(tenantId, ids) {
        if (!ids.length) return [];
        const placeholders = ids.map(() => '?').join(', ');
        await pool.query(`UPDATE timetable_relief SET notified_at = ? WHERE tenant_id = ? AND id IN (${placeholders})`, [now(), tenantId, ...ids]);
        const [rows] = await pool.query(`SELECT * FROM timetable_relief WHERE tenant_id = ? AND id IN (${placeholders})`, [tenantId, ...ids]);
        return rows.map(timetableReliefRow);
      },
    },

    // Classes & Sections (designs/Teacher feature UI mockup/
    // Classes and Sections.dc.html). Class teacher is deliberately NOT
    // stored here -- staff.class_teacher_of is the single source of
    // truth; see classes/routes.js.
    classLevels: {
      async list(tenantId) {
        const [rows] = await pool.query('SELECT * FROM class_levels WHERE tenant_id = ? ORDER BY order_index ASC', [tenantId]);
        return rows.map(classLevelRow);
      },
      async findById(tenantId, levelId) {
        const [rows] = await pool.query('SELECT * FROM class_levels WHERE id = ? AND tenant_id = ?', [levelId, tenantId]);
        return classLevelRow(row(rows));
      },
      async findByName(tenantId, name) {
        const [rows] = await pool.query('SELECT * FROM class_levels WHERE tenant_id = ? AND name = ?', [tenantId, name]);
        return classLevelRow(row(rows));
      },
      async create(level) {
        const levelId = id();
        await pool.query(
          'INSERT INTO class_levels (id, tenant_id, name, phase, order_index, language_of_instruction, default_capacity, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [levelId, level.tenantId, level.name, level.phase, level.orderIndex, level.languageOfInstruction, level.defaultCapacity, level.status || 'active'],
        );
        return this.findById(level.tenantId, levelId);
      },
      async update(tenantId, levelId, patch) {
        const cols = { name: 'name', phase: 'phase', orderIndex: 'order_index', languageOfInstruction: 'language_of_instruction', defaultCapacity: 'default_capacity', status: 'status' };
        const setCols = Object.keys(cols).filter((k) => patch[k] !== undefined);
        if (setCols.length) {
          const setClause = setCols.map((k) => `${cols[k]} = ?`).join(', ') + ', updated_at = ?';
          const values = setCols.map((k) => patch[k]);
          await pool.query(`UPDATE class_levels SET ${setClause} WHERE id = ? AND tenant_id = ?`, [...values, now(), levelId, tenantId]);
        }
        return this.findById(tenantId, levelId);
      },
      async remove(tenantId, levelId) {
        const [result] = await pool.query('DELETE FROM class_levels WHERE id = ? AND tenant_id = ?', [levelId, tenantId]);
        return result.affectedRows > 0;
      },
    },

    classSections: {
      async list(tenantId, { classLevelId } = {}) {
        const clauses = ['tenant_id = ?'];
        const params = [tenantId];
        if (classLevelId) { clauses.push('class_level_id = ?'); params.push(classLevelId); }
        const [rows] = await pool.query(`SELECT * FROM class_sections WHERE ${clauses.join(' AND ')} ORDER BY letter ASC`, params);
        return rows.map(classSectionRow);
      },
      async findById(tenantId, sectionId) {
        const [rows] = await pool.query('SELECT * FROM class_sections WHERE id = ? AND tenant_id = ?', [sectionId, tenantId]);
        return classSectionRow(row(rows));
      },
      async create(section) {
        const sectionId = id();
        await pool.query(
          'INSERT INTO class_sections (id, tenant_id, class_level_id, letter, capacity, room) VALUES (?, ?, ?, ?, ?, ?)',
          [sectionId, section.tenantId, section.classLevelId, section.letter, section.capacity, section.room || ''],
        );
        return this.findById(section.tenantId, sectionId);
      },
      async update(tenantId, sectionId, patch) {
        const cols = { letter: 'letter', capacity: 'capacity', room: 'room' };
        const setCols = Object.keys(cols).filter((k) => patch[k] !== undefined);
        if (setCols.length) {
          const setClause = setCols.map((k) => `${cols[k]} = ?`).join(', ') + ', updated_at = ?';
          const values = setCols.map((k) => patch[k]);
          await pool.query(`UPDATE class_sections SET ${setClause} WHERE id = ? AND tenant_id = ?`, [...values, now(), sectionId, tenantId]);
        }
        return this.findById(tenantId, sectionId);
      },
      async remove(tenantId, sectionId) {
        const [result] = await pool.query('DELETE FROM class_sections WHERE id = ? AND tenant_id = ?', [sectionId, tenantId]);
        return result.affectedRows > 0;
      },
    },

    classWaitlist: sqlSimpleCollection('class_waitlist', [
      { js: 'className', sql: 'class_name' },
      { js: 'learnerName', sql: 'learner_name' },
      { js: 'note', sql: 'note' },
    ], { js: 'className', sql: 'class_name' }),

    classCurriculum: sqlSimpleCollection('class_curriculum', [
      { js: 'subjectName', sql: 'subject_name' },
      { js: 'className', sql: 'class_name' },
      { js: 'periodsPerCycle', sql: 'periods_per_cycle' },
    ], { js: 'className', sql: 'class_name' }),

    classPromotionRuns: {
      async list(tenantId) {
        const [rows] = await pool.query('SELECT * FROM class_promotion_runs WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]);
        return rows.map(classPromotionRunRow);
      },
      async findById(tenantId, runId) {
        const [rows] = await pool.query('SELECT * FROM class_promotion_runs WHERE id = ? AND tenant_id = ?', [runId, tenantId]);
        return classPromotionRunRow(row(rows));
      },
      async create(runPayload) {
        const runId = id();
        await pool.query(
          'INSERT INTO class_promotion_runs (id, tenant_id, from_year, to_year, moved_count, repeat_count, graduated_count, snapshot, executed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [runId, runPayload.tenantId, runPayload.fromYear, runPayload.toYear, runPayload.movedCount, runPayload.repeatCount, runPayload.graduatedCount, JSON.stringify(runPayload.snapshot), runPayload.executedBy || null],
        );
        return this.findById(runPayload.tenantId, runId);
      },
      async markRolledBack(tenantId, runId) {
        await pool.query('UPDATE class_promotion_runs SET rolled_back = 1 WHERE id = ? AND tenant_id = ?', [runId, tenantId]);
        return this.findById(tenantId, runId);
      },
    },

    classStructureSettings: {
      async get(tenantId) {
        const [rows] = await pool.query('SELECT * FROM class_structure_settings WHERE tenant_id = ?', [tenantId]);
        const r = row(rows);
        return r && { tenantId: r.tenant_id, sectionLetters: r.section_letters, defaultSeats: r.default_seats, defaultSeatsEarlyYears: r.default_seats_early_years, updatedAt: r.updated_at };
      },
      async upsert(tenantId, patch) {
        const existing = await this.get(tenantId);
        if (!existing) {
          await pool.query(
            'INSERT INTO class_structure_settings (tenant_id, section_letters, default_seats, default_seats_early_years) VALUES (?, ?, ?, ?)',
            [tenantId, patch.sectionLetters ?? 'A,B,C,D,E', patch.defaultSeats ?? 35, patch.defaultSeatsEarlyYears ?? 30],
          );
        } else {
          await pool.query(
            'UPDATE class_structure_settings SET section_letters = ?, default_seats = ?, default_seats_early_years = ?, updated_at = ? WHERE tenant_id = ?',
            [patch.sectionLetters ?? existing.sectionLetters, patch.defaultSeats ?? existing.defaultSeats, patch.defaultSeatsEarlyYears ?? existing.defaultSeatsEarlyYears, now(), tenantId],
          );
        }
        return this.get(tenantId);
      },
    },

    // Settings module -- Security Policy, one row per tenant.
    securityPolicies: {
      async get(tenantId) {
        const [rows] = await pool.query('SELECT * FROM security_policies WHERE tenant_id = ?', [tenantId]);
        const r = row(rows);
        return r && {
          tenantId: r.tenant_id,
          minPasswordLength: r.min_password_length,
          requireUppercase: Boolean(r.require_uppercase),
          requireNumber: Boolean(r.require_number),
          requireSymbol: Boolean(r.require_symbol),
          passwordExpiryDays: r.password_expiry_days,
          sessionTimeoutMinutes: r.session_timeout_minutes,
          maxFailedLoginAttempts: r.max_failed_login_attempts,
          lockoutDurationMinutes: r.lockout_duration_minutes,
          updatedAt: r.updated_at,
        };
      },
      async upsert(tenantId, patch) {
        const existing = await this.get(tenantId);
        const merged = { ...existing, ...patch };
        if (!existing) {
          await pool.query(
            'INSERT INTO security_policies (tenant_id, min_password_length, require_uppercase, require_number, require_symbol, password_expiry_days, session_timeout_minutes, max_failed_login_attempts, lockout_duration_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [tenantId, merged.minPasswordLength ?? 8, merged.requireUppercase ?? false, merged.requireNumber ?? false, merged.requireSymbol ?? false, merged.passwordExpiryDays ?? 0, merged.sessionTimeoutMinutes ?? 480, merged.maxFailedLoginAttempts ?? 5, merged.lockoutDurationMinutes ?? 15],
          );
        } else {
          await pool.query(
            'UPDATE security_policies SET min_password_length = ?, require_uppercase = ?, require_number = ?, require_symbol = ?, password_expiry_days = ?, session_timeout_minutes = ?, max_failed_login_attempts = ?, lockout_duration_minutes = ?, updated_at = ? WHERE tenant_id = ?',
            [merged.minPasswordLength, merged.requireUppercase, merged.requireNumber, merged.requireSymbol, merged.passwordExpiryDays, merged.sessionTimeoutMinutes, merged.maxFailedLoginAttempts, merged.lockoutDurationMinutes, now(), tenantId],
          );
        }
        return this.get(tenantId);
      },
    },

    // Fees & Payments module additions. A RECORD of an offline collection
    // process (see schema.sql header) -- fee_types/School Setup is
    // untouched and unrelated.
    feeStructures: {
      async list(tenantId) {
        const [rows] = await pool.query('SELECT * FROM fee_structures WHERE tenant_id = ? ORDER BY version DESC', [tenantId]);
        return rows.map(feeStructureRow);
      },
      async findById(tenantId, structureId) {
        const [rows] = await pool.query('SELECT * FROM fee_structures WHERE id = ? AND tenant_id = ?', [structureId, tenantId]);
        return feeStructureRow(row(rows));
      },
      async findPublished(tenantId) {
        const [rows] = await pool.query("SELECT * FROM fee_structures WHERE tenant_id = ? AND status = 'published'", [tenantId]);
        return feeStructureRow(row(rows));
      },
      async createDraft(tenantId, { createdBy }) {
        const [rows] = await pool.query('SELECT COALESCE(MAX(version), 0) AS maxVersion FROM fee_structures WHERE tenant_id = ?', [tenantId]);
        const version = (row(rows)?.maxVersion || 0) + 1;
        const structureId = id();
        await pool.query('INSERT INTO fee_structures (id, tenant_id, version, status, created_by) VALUES (?, ?, ?, ?, ?)', [structureId, tenantId, version, 'draft', createdBy]);
        return this.findById(tenantId, structureId);
      },
      // Publishing a draft archives whichever version was previously
      // published -- exactly one published version prices new invoices at
      // a time, the same one-live-at-a-time rule as timetable_versions.
      async publish(tenantId, structureId) {
        await pool.query("UPDATE fee_structures SET status = 'archived' WHERE tenant_id = ? AND status = 'published'", [tenantId]);
        await pool.query("UPDATE fee_structures SET status = 'published', published_at = ? WHERE id = ? AND tenant_id = ?", [now(), structureId, tenantId]);
        return this.findById(tenantId, structureId);
      },
    },

    feeStructureHeads: {
      ...sqlSimpleCollection('fee_structure_heads', [
        { js: 'structureId', sql: 'structure_id' },
        { js: 'name', sql: 'name' },
        { js: 'type', sql: 'type' },
        { js: 'cycle', sql: 'cycle' },
        { js: 'amountEarlyYears', sql: 'amount_early_years', parse: (v) => (v === null ? null : Number(v)) },
        { js: 'amountPrimary', sql: 'amount_primary', parse: (v) => (v === null ? null : Number(v)) },
        { js: 'amountSecondary', sql: 'amount_secondary', parse: (v) => (v === null ? null : Number(v)) },
        { js: 'appliesTo', sql: 'applies_to' },
        { js: 'orderIndex', sql: 'order_index' },
      ], { js: 'structureId', sql: 'structure_id' }),
      // The Fee structure screen saves the whole grid at once -- replace
      // is simpler and safer than diffing individual head edits, matching
      // how class_curriculum's PUT already replaces its rows wholesale.
      async replaceForStructure(tenantId, structureId, heads) {
        await pool.query('DELETE FROM fee_structure_heads WHERE tenant_id = ? AND structure_id = ?', [tenantId, structureId]);
        const created = [];
        let index = 0;
        for (const h of heads) {
          created.push(await this.create({ tenantId, structureId, orderIndex: index, ...h }));
          index += 1;
        }
        return created;
      },
    },

    feeBillingSchedule: sqlSimpleCollection('fee_billing_schedule', [
      { js: 'termLabel', sql: 'term_label' },
      { js: 'dueDate', sql: 'due_date' },
      { js: 'sharePercent', sql: 'share_percent', parse: Number },
      { js: 'note', sql: 'note' },
      { js: 'orderIndex', sql: 'order_index' },
    ]),

    feeStructureRules: {
      async get(tenantId) {
        const [rows] = await pool.query('SELECT * FROM fee_structure_rules WHERE tenant_id = ?', [tenantId]);
        const r = row(rows);
        return r && {
          tenantId: r.tenant_id, siblingDiscountPercent: Number(r.sibling_discount_percent),
          earlySettlementDiscountPercent: Number(r.early_settlement_discount_percent),
          latePaymentInterestPercent: Number(r.late_payment_interest_percent),
          proRataEnabled: !!r.pro_rata_enabled, updatedAt: r.updated_at,
        };
      },
      async upsert(tenantId, patch) {
        const existing = await this.get(tenantId);
        const merged = { ...existing, ...patch };
        if (!existing) {
          await pool.query(
            'INSERT INTO fee_structure_rules (tenant_id, sibling_discount_percent, early_settlement_discount_percent, late_payment_interest_percent, pro_rata_enabled) VALUES (?, ?, ?, ?, ?)',
            [tenantId, merged.siblingDiscountPercent ?? 10, merged.earlySettlementDiscountPercent ?? 5, merged.latePaymentInterestPercent ?? 2, merged.proRataEnabled ? 1 : 0],
          );
        } else {
          await pool.query(
            'UPDATE fee_structure_rules SET sibling_discount_percent = ?, early_settlement_discount_percent = ?, late_payment_interest_percent = ?, pro_rata_enabled = ?, updated_at = ? WHERE tenant_id = ?',
            [merged.siblingDiscountPercent, merged.earlySettlementDiscountPercent, merged.latePaymentInterestPercent, merged.proRataEnabled ? 1 : 0, now(), tenantId],
          );
        }
        return this.get(tenantId);
      },
    },

    feeInvoices: {
      async list(tenantId, { studentId, termLabel } = {}) {
        const clauses = ['tenant_id = ?'];
        const params = [tenantId];
        if (studentId) { clauses.push('student_id = ?'); params.push(studentId); }
        if (termLabel) { clauses.push('term_label = ?'); params.push(termLabel); }
        const [rows] = await pool.query(`SELECT * FROM fee_invoices WHERE ${clauses.join(' AND ')} ORDER BY raised_at DESC`, params);
        return rows.map(feeInvoiceRow);
      },
      async findById(tenantId, invoiceId) {
        const [rows] = await pool.query('SELECT * FROM fee_invoices WHERE id = ? AND tenant_id = ?', [invoiceId, tenantId]);
        return feeInvoiceRow(row(rows));
      },
      async findByInvoiceNo(tenantId, invoiceNo) {
        const [rows] = await pool.query('SELECT * FROM fee_invoices WHERE tenant_id = ? AND invoice_no = ?', [tenantId, invoiceNo]);
        return feeInvoiceRow(row(rows));
      },
      async existsForStudentTerm(tenantId, studentId, termLabel) {
        const [rows] = await pool.query('SELECT id FROM fee_invoices WHERE tenant_id = ? AND student_id = ? AND term_label = ?', [tenantId, studentId, termLabel]);
        return rows.length > 0;
      },
      async create(payload) {
        const invoiceId = id();
        await pool.query(
          'INSERT INTO fee_invoices (id, tenant_id, invoice_no, student_id, class_name, section, term_label, due_date, structure_version, raised_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [invoiceId, payload.tenantId, payload.invoiceNo, payload.studentId, payload.className, payload.section, payload.termLabel, payload.dueDate, payload.structureVersion, payload.raisedBy],
        );
        return this.findById(payload.tenantId, invoiceId);
      },
    },

    feeInvoiceLines: {
      ...sqlSimpleCollection('fee_invoice_lines', [
        { js: 'invoiceId', sql: 'invoice_id' },
        { js: 'kind', sql: 'kind' },
        { js: 'label', sql: 'label' },
        { js: 'note', sql: 'note' },
        { js: 'qty', sql: 'qty' },
        { js: 'rate', sql: 'rate', parse: (v) => (v === null ? null : Number(v)) },
        { js: 'amount', sql: 'amount', parse: Number },
      ], { js: 'invoiceId', sql: 'invoice_id' }),
      async createMany(tenantId, invoiceId, lines) {
        const created = [];
        for (const l of lines) created.push(await this.create({ tenantId, invoiceId, ...l }));
        return created;
      },
    },

    feePayments: {
      async list(tenantId, { studentId } = {}) {
        const clauses = ['tenant_id = ?'];
        const params = [tenantId];
        if (studentId) { clauses.push('student_id = ?'); params.push(studentId); }
        const [rows] = await pool.query(`SELECT * FROM fee_payments WHERE ${clauses.join(' AND ')} ORDER BY recorded_at DESC`, params);
        return rows.map(feePaymentRow);
      },
      async findById(tenantId, paymentId) {
        const [rows] = await pool.query('SELECT * FROM fee_payments WHERE id = ? AND tenant_id = ?', [paymentId, tenantId]);
        return feePaymentRow(row(rows));
      },
      async create(payload) {
        const paymentId = id();
        await pool.query(
          'INSERT INTO fee_payments (id, tenant_id, student_id, amount_received, date_received, method, bank_reference, proof_document_id, confirmed, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [paymentId, payload.tenantId, payload.studentId, payload.amountReceived, payload.dateReceived, payload.method, payload.bankReference || '', payload.proofDocumentId || null, payload.confirmed ? 1 : 0, payload.recordedBy],
        );
        return this.findById(payload.tenantId, paymentId);
      },
      async markConfirmed(tenantId, paymentId) {
        await pool.query('UPDATE fee_payments SET confirmed = 1 WHERE id = ? AND tenant_id = ?', [paymentId, tenantId]);
        return this.findById(tenantId, paymentId);
      },
    },

    feePaymentAllocations: {
      ...sqlSimpleCollection('fee_payment_allocations', [
        { js: 'paymentId', sql: 'payment_id' },
        { js: 'invoiceId', sql: 'invoice_id' },
        { js: 'amount', sql: 'amount', parse: Number },
      ], { js: 'invoiceId', sql: 'invoice_id' }),
      async createMany(tenantId, paymentId, allocations) {
        const created = [];
        for (const a of allocations) created.push(await this.create({ tenantId, paymentId, ...a }));
        return created;
      },
      async listForPayment(tenantId, paymentId) {
        const [rows] = await pool.query('SELECT * FROM fee_payment_allocations WHERE tenant_id = ? AND payment_id = ?', [tenantId, paymentId]);
        return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, paymentId: r.payment_id, invoiceId: r.invoice_id, amount: Number(r.amount), createdAt: r.created_at }));
      },
    },

    feePaymentPlans: sqlSimpleCollection('fee_payment_plans', [
      { js: 'studentId', sql: 'student_id' },
      { js: 'totalAmount', sql: 'total_amount', parse: Number },
      { js: 'instalmentAmount', sql: 'instalment_amount', parse: Number },
      { js: 'instalmentCount', sql: 'instalment_count' },
      { js: 'startDate', sql: 'start_date' },
      { js: 'nextDueDate', sql: 'next_due_date' },
      { js: 'invoiceIds', sql: 'invoice_ids', parse: (v) => JSON.parse(v || '[]'), serialize: (v) => JSON.stringify(v || []) },
      { js: 'status', sql: 'status' },
      { js: 'createdBy', sql: 'created_by' },
    ], { js: 'studentId', sql: 'student_id' }),

    // Bank lines entered by hand (see schema.sql header -- no statement
    // upload this pass). setMatch is called by the real matching engine
    // in modules/fees/service.js, never directly by the person entering
    // the line.
    bankStatementLines: {
      ...sqlSimpleCollection('bank_statement_lines', [
        { js: 'date', sql: 'line_date' },
        { js: 'reference', sql: 'reference' },
        { js: 'amount', sql: 'amount', parse: Number },
        { js: 'matchedPaymentId', sql: 'matched_payment_id' },
        { js: 'confidence', sql: 'confidence' },
        { js: 'reviewedBy', sql: 'reviewed_by' },
        { js: 'reviewedAt', sql: 'reviewed_at' },
        { js: 'createdBy', sql: 'created_by' },
      ]),
      async setMatch(tenantId, lineId, { paymentId, confidence, reviewedBy }) {
        await pool.query('UPDATE bank_statement_lines SET matched_payment_id = ?, confidence = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND tenant_id = ?', [paymentId, confidence, reviewedBy, now(), lineId, tenantId]);
        return this.findById(tenantId, lineId);
      },
    },

    feeDisbursements: {
      ...sqlSimpleCollection('fee_disbursements', [
        { js: 'reference', sql: 'reference' },
        { js: 'date', sql: 'disb_date' },
        { js: 'payeeName', sql: 'payee_name' },
        { js: 'reason', sql: 'reason' },
        { js: 'amount', sql: 'amount', parse: Number },
        { js: 'method', sql: 'method' },
        { js: 'state', sql: 'state' },
        { js: 'proofDocumentId', sql: 'proof_document_id' },
        { js: 'requestedBy', sql: 'requested_by' },
        { js: 'approvedBy', sql: 'approved_by' },
        { js: 'decidedAt', sql: 'decided_at' },
      ]),
      async decide(tenantId, disbursementId, { state, approvedBy }) {
        await pool.query('UPDATE fee_disbursements SET state = ?, approved_by = ?, decided_at = ? WHERE id = ? AND tenant_id = ?', [state, approvedBy, now(), disbursementId, tenantId]);
        return this.findById(tenantId, disbursementId);
      },
    },

    // Escalation ladder log (screen 7) -- see schema.sql header: automatic
    // reminder counts are derived live from invoice ageing in service.js;
    // this table only logs the two MANUAL steps for real.
    feeEscalationEvents: sqlSimpleCollection('fee_escalation_events', [
      { js: 'studentId', sql: 'student_id' },
      { js: 'invoiceId', sql: 'invoice_id' },
      { js: 'step', sql: 'step' },
      { js: 'note', sql: 'note' },
      { js: 'createdBy', sql: 'created_by' },
    ], { js: 'studentId', sql: 'student_id' }),

    feeSettings: {
      async get(tenantId) {
        const [rows] = await pool.query('SELECT * FROM fee_settings WHERE tenant_id = ?', [tenantId]);
        const r = row(rows);
        return r && {
          tenantId: r.tenant_id, acceptedChannels: JSON.parse(r.accepted_channels || '[]'),
          referenceFormat: r.reference_format, notifyRules: JSON.parse(r.notify_rules || '[]'), updatedAt: r.updated_at,
        };
      },
      async upsert(tenantId, patch) {
        const existing = await this.get(tenantId);
        const merged = { ...existing, ...patch };
        if (!existing) {
          await pool.query(
            'INSERT INTO fee_settings (tenant_id, accepted_channels, reference_format, notify_rules) VALUES (?, ?, ?, ?)',
            [tenantId, JSON.stringify(merged.acceptedChannels ?? []), merged.referenceFormat ?? 'SURNAME + class, e.g. BOTHA9A', JSON.stringify(merged.notifyRules ?? [])],
          );
        } else {
          await pool.query(
            'UPDATE fee_settings SET accepted_channels = ?, reference_format = ?, notify_rules = ?, updated_at = ? WHERE tenant_id = ?',
            [JSON.stringify(merged.acceptedChannels ?? []), merged.referenceFormat, JSON.stringify(merged.notifyRules ?? []), now(), tenantId],
          );
        }
        return this.get(tenantId);
      },
    },

    documents: {
      async create(doc) {
        const documentId = id();
        await pool.query(
          'INSERT INTO documents (id, tenant_id, entity_type, entity_id, document_type, file_name, storage_key, mime_type, size_bytes, uploaded_by, expiry_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [documentId, doc.tenantId, doc.entityType, doc.entityId, doc.documentType, doc.fileName, doc.storageKey, doc.mimeType, doc.sizeBytes, doc.uploadedBy, doc.expiryDate ?? null],
        );
        return { id: documentId, createdAt: new Date().toISOString(), ...doc };
      },
      async listForEntity(tenantId, entityType, entityId) {
        const [rows] = await pool.query('SELECT * FROM documents WHERE tenant_id = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC', [tenantId, entityType, entityId]);
        return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, entityType: r.entity_type, entityId: r.entity_id, documentType: r.document_type, fileName: r.file_name, storageKey: r.storage_key, mimeType: r.mime_type, sizeBytes: r.size_bytes, uploadedBy: r.uploaded_by, expiryDate: r.expiry_date, createdAt: r.created_at }));
      },
      async listForEntityType(tenantId, entityType) {
        const [rows] = await pool.query('SELECT * FROM documents WHERE tenant_id = ? AND entity_type = ? ORDER BY created_at DESC', [tenantId, entityType]);
        return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, entityType: r.entity_type, entityId: r.entity_id, documentType: r.document_type, fileName: r.file_name, storageKey: r.storage_key, mimeType: r.mime_type, sizeBytes: r.size_bytes, uploadedBy: r.uploaded_by, expiryDate: r.expiry_date, createdAt: r.created_at }));
      },
      async findById(tenantId, documentId) {
        const [rows] = await pool.query('SELECT * FROM documents WHERE id = ? AND tenant_id = ?', [documentId, tenantId]);
        const r = row(rows);
        return r && { id: r.id, tenantId: r.tenant_id, storageKey: r.storage_key, fileName: r.file_name, mimeType: r.mime_type };
      },
      async remove(tenantId, documentId) {
        const [result] = await pool.query('DELETE FROM documents WHERE id = ? AND tenant_id = ?', [documentId, tenantId]);
        return result.affectedRows > 0;
      },
    },

    // Notices & Communication (edusphere-notices-communication-module-plan-
    // 2026-09-22.md). Status is computed by modules/notices/service.js from
    // publish_at/expiry_at/is_draft/is_archived, never stored here.
    notices: {
      noticeRow(r) {
        return r && {
          id: r.id, tenantId: r.tenant_id, title: r.title, category: r.category, description: r.description,
          audienceType: r.audience_type, audienceRole: r.audience_role, audienceClassName: r.audience_class_name,
          audienceSection: r.audience_section, audienceRecipientType: r.audience_recipient_type, audienceRecipientId: r.audience_recipient_id,
          publishAt: r.publish_at, expiryAt: r.expiry_at, isDraft: !!r.is_draft, isArchived: !!r.is_archived,
          createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
        };
      },
      async list(tenantId, { category, audienceType, className, search } = {}) {
        const clauses = ['tenant_id = ?'];
        const params = [tenantId];
        if (category) { clauses.push('category = ?'); params.push(category); }
        if (audienceType) { clauses.push('audience_type = ?'); params.push(audienceType); }
        if (className) { clauses.push('audience_class_name = ?'); params.push(className); }
        if (search) { clauses.push('(title LIKE ? OR description LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
        const [rows] = await pool.query(`SELECT * FROM notices WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params);
        return rows.map(this.noticeRow);
      },
      async findById(tenantId, noticeId) {
        const [rows] = await pool.query('SELECT * FROM notices WHERE id = ? AND tenant_id = ?', [noticeId, tenantId]);
        return this.noticeRow(row(rows));
      },
      async create(notice) {
        const noticeId = id();
        await pool.query(
          `INSERT INTO notices (id, tenant_id, title, category, description, audience_type, audience_role, audience_class_name,
            audience_section, audience_recipient_type, audience_recipient_id, publish_at, expiry_at, is_draft, is_archived, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [noticeId, notice.tenantId, notice.title, notice.category, notice.description, notice.audienceType,
            notice.audienceRole ?? null, notice.audienceClassName ?? null, notice.audienceSection ?? null,
            notice.audienceRecipientType ?? null, notice.audienceRecipientId ?? null, notice.publishAt,
            notice.expiryAt ?? null, notice.isDraft ? 1 : 0, notice.isArchived ? 1 : 0, notice.createdBy],
        );
        return this.findById(notice.tenantId, noticeId);
      },
      async update(tenantId, noticeId, patch) {
        const existing = await this.findById(tenantId, noticeId);
        if (!existing) return null;
        const merged = { ...existing, ...patch };
        await pool.query(
          `UPDATE notices SET title = ?, category = ?, description = ?, audience_type = ?, audience_role = ?,
            audience_class_name = ?, audience_section = ?, audience_recipient_type = ?, audience_recipient_id = ?,
            publish_at = ?, expiry_at = ?, is_draft = ?, is_archived = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
          [merged.title, merged.category, merged.description, merged.audienceType, merged.audienceRole ?? null,
            merged.audienceClassName ?? null, merged.audienceSection ?? null, merged.audienceRecipientType ?? null,
            merged.audienceRecipientId ?? null, merged.publishAt, merged.expiryAt ?? null, merged.isDraft ? 1 : 0,
            merged.isArchived ? 1 : 0, now(), noticeId, tenantId],
        );
        return this.findById(tenantId, noticeId);
      },
      async remove(tenantId, noticeId) {
        const [result] = await pool.query('DELETE FROM notices WHERE id = ? AND tenant_id = ?', [noticeId, tenantId]);
        return result.affectedRows > 0;
      },
    },

    noticeAcknowledgements: {
      async listForNotice(tenantId, noticeId) {
        const [rows] = await pool.query('SELECT * FROM notice_acknowledgements WHERE tenant_id = ? AND notice_id = ? ORDER BY recorded_at DESC', [tenantId, noticeId]);
        return rows.map((r) => ({
          id: r.id, tenantId: r.tenant_id, noticeId: r.notice_id, recipientLabel: r.recipient_label,
          method: r.method, note: r.note, recordedBy: r.recorded_by, recordedAt: r.recorded_at,
        }));
      },
      async create(ack) {
        const ackId = id();
        await pool.query(
          'INSERT INTO notice_acknowledgements (id, tenant_id, notice_id, recipient_label, method, note, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [ackId, ack.tenantId, ack.noticeId, ack.recipientLabel, ack.method, ack.note || '', ack.recordedBy],
        );
        const [rows] = await pool.query('SELECT * FROM notice_acknowledgements WHERE id = ?', [ackId]);
        const r = row(rows);
        return r && { id: r.id, tenantId: r.tenant_id, noticeId: r.notice_id, recipientLabel: r.recipient_label, method: r.method, note: r.note, recordedBy: r.recorded_by, recordedAt: r.recorded_at };
      },
    },

    // Payroll (see schema.sql's Payroll header).
    payProfiles: (() => {
      const base = sqlSimpleCollection('staff_pay_profiles', [
        { js: 'staffId', sql: 'staff_id' },
        { js: 'basicSalary', sql: 'basic_salary', parse: (v) => (v === null || v === undefined ? 0 : Number(v)) },
        { js: 'allowances', sql: 'allowances', parse: safeParseJson, serialize: (v) => (v === undefined || v === null ? null : JSON.stringify(v)) },
        { js: 'deductions', sql: 'deductions', parse: safeParseJson, serialize: (v) => (v === undefined || v === null ? null : JSON.stringify(v)) },
        { js: 'bank', sql: 'bank', parse: safeParseJson, serialize: (v) => (v === undefined || v === null ? null : JSON.stringify(v)) },
        { js: 'updatedBy', sql: 'updated_by' },
        { js: 'updatedAt', sql: 'updated_at' },
      ], { js: 'staffId', sql: 'staff_id' });
      return {
        ...base,
        async findByStaff(tenantId, staffId) {
          const rows = await base.list(tenantId, { staffId });
          return rows[0] || null;
        },
        async upsert(tenantId, staffId, patch) {
          const existing = await this.findByStaff(tenantId, staffId);
          if (existing) return base.update(tenantId, existing.id, patch);
          return base.create({ tenantId, staffId, ...patch });
        },
      };
    })(),
    payrollRuns: (() => {
      const base = sqlSimpleCollection('payroll_runs', [
        { js: 'period', sql: 'period' },
        { js: 'status', sql: 'status' },
        { js: 'totals', sql: 'totals', parse: safeParseJson, serialize: (v) => (v === undefined || v === null ? null : JSON.stringify(v)) },
        { js: 'missingProfiles', sql: 'missing_profiles', parse: safeParseJson, serialize: (v) => (v === undefined || v === null ? null : JSON.stringify(v)) },
        { js: 'createdBy', sql: 'created_by' },
        { js: 'calculatedAt', sql: 'calculated_at' },
        { js: 'finalisedBy', sql: 'finalised_by' },
        { js: 'finalisedAt', sql: 'finalised_at' },
        { js: 'paidBy', sql: 'paid_by' },
        { js: 'paidAt', sql: 'paid_at' },
        { js: 'paidOn', sql: 'paid_on' },
        { js: 'paidReference', sql: 'paid_reference' },
      ], { js: 'period', sql: 'period' });
      return {
        ...base,
        async findByPeriod(tenantId, period) {
          const rows = await base.list(tenantId, { period });
          return rows[0] || null;
        },
      };
    })(),
    payslips: (() => {
      const base = sqlSimpleCollection('payroll_payslips', [
        { js: 'runId', sql: 'run_id' },
        { js: 'staffId', sql: 'staff_id' },
        { js: 'period', sql: 'period' },
        { js: 'staffName', sql: 'staff_name' },
        { js: 'employeeId', sql: 'employee_id' },
        { js: 'department', sql: 'department' },
        { js: 'designation', sql: 'designation' },
        { js: 'basicSalary', sql: 'basic_salary', parse: (v) => (v === null || v === undefined ? 0 : Number(v)) },
        { js: 'allowances', sql: 'allowances', parse: safeParseJson, serialize: (v) => (v === undefined || v === null ? null : JSON.stringify(v)) },
        { js: 'grossPay', sql: 'gross_pay', parse: (v) => (v === null || v === undefined ? 0 : Number(v)) },
        { js: 'unpaidLeaveDays', sql: 'unpaid_leave_days', parse: (v) => (v === null || v === undefined ? 0 : Number(v)) },
        { js: 'leaveDeduction', sql: 'leave_deduction', parse: (v) => (v === null || v === undefined ? 0 : Number(v)) },
        { js: 'deductions', sql: 'deductions', parse: safeParseJson, serialize: (v) => (v === undefined || v === null ? null : JSON.stringify(v)) },
        { js: 'totalDeductions', sql: 'total_deductions', parse: (v) => (v === null || v === undefined ? 0 : Number(v)) },
        { js: 'netPay', sql: 'net_pay', parse: (v) => (v === null || v === undefined ? 0 : Number(v)) },
        { js: 'bankVerified', sql: 'bank_verified', parse: (v) => Boolean(v), serialize: (v) => (v ? 1 : 0) },
        { js: 'bankSummary', sql: 'bank_summary' },
        { js: 'exceptions', sql: 'exceptions', parse: safeParseJson, serialize: (v) => (v === undefined || v === null ? null : JSON.stringify(v)) },
      ], { js: 'runId', sql: 'run_id' });
      return {
        ...base,
        async listByStaff(tenantId, staffId) {
          const [rows] = await pool.query('SELECT id FROM payroll_payslips WHERE tenant_id = ? AND staff_id = ? ORDER BY period DESC', [tenantId, staffId]);
          return Promise.all(rows.map((r) => base.findById(tenantId, r.id)));
        },
        async removeByRun(tenantId, runId) {
          await pool.query('DELETE FROM payroll_payslips WHERE tenant_id = ? AND run_id = ?', [tenantId, runId]);
          return true;
        },
      };
    })(),

    audit: {
      async record({ event, actorId, target, tenantId, summary = {} }) {
        await pool.query('INSERT INTO audit_logs (id, tenant_id, event, actor_id, target, summary, at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id(), tenantId, event, actorId, target ?? null, JSON.stringify(summary), now()]);
      },
      async list(tenantId) {
        const [rows] = await pool.query('SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY at DESC', [tenantId]);
        return rows.map((r) => ({ id: r.id, event: r.event, actorId: r.actor_id, target: r.target, tenantId: r.tenant_id, summary: JSON.parse(r.summary ?? '{}'), at: r.at }));
      },
    },
  };
}
