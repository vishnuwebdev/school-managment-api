import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';

// Real, persistent adapter for teams that prefer MongoDB (context.md asks
// for both MySQL and Mongo to be selectable by configuration). Implements
// the same contract as adapters/memoryAdapter.js / adapters/mysqlAdapter.js.
// Documents use an `id` string field (not Mongo's own ObjectId) so the same
// identifiers work identically across all three adapters. Not yet exercised
// against a live instance in this environment — verify against your own
// Atlas/local instance before relying on it.
export function createMongoAdapter(databaseUrl) {
  const client = new MongoClient(databaseUrl);
  let db;
  const id = () => crypto.randomUUID();
  const col = (name) => db.collection(name);
  const strip = (doc) => { if (!doc) return doc; const { _id, ...rest } = doc; return rest; };

  const PROFILE_SECTIONS = ['basicInfo', 'contact', 'address', 'branding', 'bank', 'registration', 'social', 'promotion', 'preferences'];
  function emptyProfile(tenantId) {
    const profile = { tenantId, updatedAt: null };
    for (const section of PROFILE_SECTIONS) profile[section] = {};
    return profile;
  }

  // Generic CRUD for the six simple tenant-scoped list collections School
  // Setup added (academicYears, academicTerms, subjects, holidays, grades,
  // feeTypes) -- same contract as memoryAdapter.js's simpleCollection.
  function mongoSimpleCollection(collectionName, extraFilterKey) {
    return {
      async list(tenantId, extraFilter = {}) {
        const filter = { tenantId };
        if (extraFilterKey) {
          const value = extraFilter[extraFilterKey];
          if (value !== undefined && value !== null) filter[extraFilterKey] = value;
        }
        return (await col(collectionName).find(filter).sort({ createdAt: -1 }).toArray()).map(strip);
      },
      async findById(tenantId, recordId) { return strip(await col(collectionName).findOne({ id: recordId, tenantId })); },
      async create(payload) {
        const record = { id: id(), createdAt: new Date().toISOString(), ...payload };
        await col(collectionName).insertOne(record);
        return record;
      },
      async update(tenantId, recordId, patch) {
        await col(collectionName).updateOne({ id: recordId, tenantId }, { $set: patch });
        return this.findById(tenantId, recordId);
      },
      async remove(tenantId, recordId) {
        const result = await col(collectionName).deleteOne({ id: recordId, tenantId });
        return result.deletedCount > 0;
      },
    };
  }

  return {
    driver: 'mongo',
    async ready() {
      await client.connect();
      db = client.db();
      await col('schools').createIndex({ slug: 1 }, { unique: true });
      await col('users').createIndex({ email: 1 }, { unique: true });
      await col('students').createIndex({ tenantId: 1, admissionNumber: 1 }, { unique: true });
      await col('attendance').createIndex({ tenantId: 1, studentId: 1, date: 1 }, { unique: true });
      await col('roles').createIndex({ tenantId: 1, key: 1 }, { unique: true });
      await col('schoolEntitlements').createIndex({ tenantId: 1, featureKey: 1 }, { unique: true });
      await col('payProfiles').createIndex({ tenantId: 1, staffId: 1 }, { unique: true });
      await col('payrollRuns').createIndex({ tenantId: 1, period: 1 }, { unique: true });
    },

    schools: {
      async list() { return (await col('schools').find({}).sort({ name: 1 }).toArray()).map(strip); },
      async findById(schoolId) { return strip(await col('schools').findOne({ id: schoolId })); },
      async findBySlug(slug) { return strip(await col('schools').findOne({ slug })); },
      async create({ name, slug }) {
        const school = { id: id(), name, slug, active: true, createdAt: new Date().toISOString() };
        await col('schools').insertOne(school);
        return school;
      },
    },

    roles: {
      async list(tenantId) { return (await col('roles').find({ $or: [{ tenantId }, { tenantId: null }] }).toArray()).map(strip); },
      async findByKey(tenantId, key) { return strip(await col('roles').findOne({ key, $or: [{ tenantId }, { tenantId: null }] })); },
      async permissionsForKeys(tenantId, keys) {
        const roles = await col('roles').find({ key: { $in: keys }, $or: [{ tenantId }, { tenantId: null }] }).toArray();
        return [...new Set(roles.flatMap((r) => r.permissions))];
      },
      async create({ tenantId, key, name, permissions, isSystem = false }) {
        const role = { id: id(), tenantId, key, name, permissions, isSystem };
        await col('roles').insertOne(role);
        return role;
      },
      async updatePermissions(tenantId, key, permissions) {
        await col('roles').updateOne({ tenantId, key }, { $set: { permissions } });
        return this.findByKey(tenantId, key);
      },
    },

    schoolEntitlements: {
      async list(tenantId) { return (await col('schoolEntitlements').find({ tenantId }).toArray()).map(strip); },
      async listAll() { return (await col('schoolEntitlements').find({}).toArray()).map(strip); },
      async upsert({ tenantId, featureKey, enabled, updatedBy }) {
        const updatedAt = new Date().toISOString();
        await col('schoolEntitlements').updateOne(
          { tenantId, featureKey },
          { $set: { enabled, updatedBy, updatedAt }, $setOnInsert: { id: id(), tenantId, featureKey } },
          { upsert: true },
        );
        return strip(await col('schoolEntitlements').findOne({ tenantId, featureKey }));
      },
    },

    users: {
      async findByEmail(email) { return strip(await col('users').findOne({ email: email.toLowerCase() })); },
      async findById(userId) { return strip(await col('users').findOne({ id: userId })); },
      async listByTenant(tenantId) { return (await col('users').find({ tenantId }).sort({ fullName: 1 }).toArray()).map(strip); },
      async create({ tenantId, email, passwordHash, fullName, roleKeys, status = 'active' }) {
        const user = { id: id(), tenantId, email: email.toLowerCase(), passwordHash, fullName, phone: null, roleKeys, status, lastLoginAt: null, failedLoginAttempts: 0, lockedUntil: null, createdAt: new Date().toISOString() };
        await col('users').insertOne(user);
        return user;
      },
      // A successful login clears any lockout state, same call as
      // recording the login timestamp -- see auth/service.js's login().
      async recordLogin(userId) {
        await col('users').updateOne({ id: userId }, { $set: { lastLoginAt: new Date().toISOString(), failedLoginAttempts: 0, lockedUntil: null } });
      },
      async setStatus(tenantId, userId, status) {
        await col('users').updateOne({ id: userId, tenantId }, { $set: { status } });
        return this.findById(userId);
      },
      async setRoles(tenantId, userId, roleKeys) {
        await col('users').updateOne({ id: userId, tenantId }, { $set: { roleKeys } });
        return this.findById(userId);
      },
      // My Account (Settings module) -- editable self-service profile
      // fields, scoped by tenantId same as setStatus/setRoles above.
      async updateProfile(tenantId, userId, patch) {
        await col('users').updateOne({ id: userId, tenantId }, { $set: patch });
        return this.findById(userId);
      },
      // Password/lockout fields -- scoped by userId only, same precedent
      // as recordLogin above.
      async updateSecurity(userId, patch) {
        await col('users').updateOne({ id: userId }, { $set: patch });
        return this.findById(userId);
      },
    },

    students: {
      async list(tenantId, { query = '', className, section, status } = {}) {
        const filter = { tenantId };
        if (className) filter.className = className;
        if (section) filter.section = section;
        if (status) filter.status = status;
        if (query) filter.$or = [
          { firstName: { $regex: query, $options: 'i' } },
          { lastName: { $regex: query, $options: 'i' } },
          { admissionNumber: { $regex: query, $options: 'i' } },
        ];
        return (await col('students').find(filter).toArray()).map(strip);
      },
      async findById(tenantId, studentId) { return strip(await col('students').findOne({ id: studentId, tenantId })); },
      async findByClassSection(tenantId, className, section) {
        return (await col('students').find({ tenantId, status: 'active', className, section }).toArray()).map(strip);
      },
      async existsByAdmissionNumber(tenantId, admissionNumber) {
        return (await col('students').countDocuments({ tenantId, admissionNumber })) > 0;
      },
      async create(student) {
        const record = { id: id(), status: 'active', ...student };
        await col('students').insertOne(record);
        return record;
      },
      async archive(tenantId, studentId) {
        await col('students').updateOne({ id: studentId, tenantId }, { $set: { status: 'archived' } });
        return this.findById(tenantId, studentId);
      },
      async update(tenantId, studentId, patch) {
        await col('students').updateOne({ id: studentId, tenantId }, { $set: { ...patch, updatedAt: new Date().toISOString() } });
        return this.findById(tenantId, studentId);
      },
      async withdraw(tenantId, studentId, withdrawal) {
        await col('students').updateOne({ id: studentId, tenantId }, { $set: { status: 'withdrawn', withdrawal, updatedAt: new Date().toISOString() } });
        return this.findById(tenantId, studentId);
      },
      async transfer(tenantId, studentId, transfer) {
        await col('students').updateOne({ id: studentId, tenantId }, { $set: { status: 'transferred', transfer, updatedAt: new Date().toISOString() } });
        return this.findById(tenantId, studentId);
      },
    },

    staff: {
      async list(tenantId, { query = '', department, staffType, status } = {}) {
        const filter = { tenantId };
        if (department) filter.department = department;
        if (staffType) filter.staffType = staffType;
        if (status) filter.status = status;
        if (query) filter.$or = [
          { firstName: { $regex: query, $options: 'i' } },
          { lastName: { $regex: query, $options: 'i' } },
          { employeeId: { $regex: query, $options: 'i' } },
        ];
        return (await col('staff').find(filter).toArray()).map(strip);
      },
      async findById(tenantId, staffId) { return strip(await col('staff').findOne({ id: staffId, tenantId })); },
      async existsByEmployeeId(tenantId, employeeId) {
        return (await col('staff').countDocuments({ tenantId, employeeId })) > 0;
      },
      async create(staffMember) {
        const record = { id: id(), status: 'active', createdAt: new Date().toISOString(), ...staffMember };
        await col('staff').insertOne(record);
        return record;
      },
      async update(tenantId, staffId, patch) {
        await col('staff').updateOne({ id: staffId, tenantId }, { $set: { ...patch, updatedAt: new Date().toISOString() } });
        return this.findById(tenantId, staffId);
      },
      async archive(tenantId, staffId) {
        await col('staff').updateOne({ id: staffId, tenantId }, { $set: { status: 'inactive', updatedAt: new Date().toISOString() } });
        return this.findById(tenantId, staffId);
      },
      async offboard(tenantId, staffId, offboarding) {
        await col('staff').updateOne({ id: staffId, tenantId }, { $set: { status: 'resigned', offboarding, updatedAt: new Date().toISOString() } });
        return this.findById(tenantId, staffId);
      },
    },

    staffAssignments: {
      async listForStaff(tenantId, staffId) { return (await col('staffAssignments').find({ tenantId, staffId }).toArray()).map(strip); },
      async listForTenant(tenantId) { return (await col('staffAssignments').find({ tenantId }).toArray()).map(strip); },
      async findById(tenantId, assignmentId) { return strip(await col('staffAssignments').findOne({ id: assignmentId, tenantId })); },
      async create(assignment) {
        const record = { id: id(), createdAt: new Date().toISOString(), periodsPerWeek: 1, role: 'Subject', ...assignment };
        await col('staffAssignments').insertOne(record);
        return record;
      },
      async update(tenantId, assignmentId, patch) {
        await col('staffAssignments').updateOne({ id: assignmentId, tenantId }, { $set: patch });
        return this.findById(tenantId, assignmentId);
      },
      async remove(tenantId, assignmentId) {
        const result = await col('staffAssignments').deleteOne({ id: assignmentId, tenantId });
        return result.deletedCount > 0;
      },
    },

    staffLeave: {
      async list(tenantId, { staffId, status } = {}) {
        const filter = { tenantId };
        if (staffId) filter.staffId = staffId;
        if (status) filter.status = status;
        return (await col('staffLeave').find(filter).sort({ createdAt: -1 }).toArray()).map(strip);
      },
      async findById(tenantId, leaveId) { return strip(await col('staffLeave').findOne({ id: leaveId, tenantId })); },
      async create(leave) {
        const record = { id: id(), status: 'pending', createdAt: new Date().toISOString(), reason: null, ...leave };
        await col('staffLeave').insertOne(record);
        return record;
      },
      async decide(tenantId, leaveId, { status, decidedBy }) {
        await col('staffLeave').updateOne({ id: leaveId, tenantId }, { $set: { status, decidedBy, decidedAt: new Date().toISOString() } });
        return this.findById(tenantId, leaveId);
      },
    },

    attendance: {
      async findMatching(tenantId, date, className, section) {
        return (await col('attendance').find({ tenantId, date, className, section }).toArray()).map(strip);
      },
      async findByStudent(tenantId, studentId) {
        return (await col('attendance').find({ tenantId, studentId }).sort({ date: -1 }).toArray()).map(strip);
      },
      async summary(tenantId, { date, className, section }) {
        const filter = { tenantId, date };
        if (className) filter.className = className;
        if (section) filter.section = section;
        return (await col('attendance').find(filter).toArray()).map(strip);
      },
      async upsertMany(tenantId, { date, className, section, records, actorId }) {
        const now = new Date().toISOString();
        const saved = [];
        for (const item of records) {
          const existing = await col('attendance').findOne({ tenantId, studentId: item.studentId, date });
          const after = {
            id: existing?.id || id(), tenantId, date, className, section, studentId: item.studentId,
            status: item.status, remark: item.remark?.trim() || '',
            createdBy: existing?.createdBy || actorId, createdAt: existing?.createdAt || now,
            updatedBy: actorId, updatedAt: now,
          };
          await col('attendance').updateOne({ tenantId, studentId: item.studentId, date }, { $set: after }, { upsert: true });
          await col('attendanceHistory').insertOne({ id: id(), tenantId, attendanceId: after.id, action: existing ? 'updated' : 'created', actorId, before: existing ? strip(existing) : null, after, at: now });
          saved.push(after);
        }
        return saved;
      },
      async history(tenantId) {
        return (await col('attendanceHistory').find({ tenantId }).sort({ at: -1 }).toArray()).map(strip);
      },
    },

    attendanceCorrectionRequests: {
      async list(tenantId, { status } = {}) {
        const filter = { tenantId };
        if (status) filter.status = status;
        return (await col('attendanceCorrectionRequests').find(filter).sort({ requestedAt: -1 }).toArray()).map(strip);
      },
      async findById(tenantId, requestId) { return strip(await col('attendanceCorrectionRequests').findOne({ id: requestId, tenantId })); },
      async create(payload) {
        const record = { id: id(), status: 'pending', ...payload };
        await col('attendanceCorrectionRequests').insertOne(record);
        return record;
      },
      async decide(tenantId, requestId, { status, decidedBy, decisionNote }) {
        await col('attendanceCorrectionRequests').updateOne(
          { id: requestId, tenantId },
          { $set: { status, decidedBy, decidedAt: new Date().toISOString(), decisionNote: decisionNote || null } },
        );
        return this.findById(tenantId, requestId);
      },
    },

    attendancePeriods: {
      async findForDay(tenantId, date, className, section) {
        return (await col('attendancePeriods').find({ tenantId, date, className, section }).toArray()).map(strip);
      },
      async upsertMany(tenantId, { date, slotId, className, section, subject, records, actorId }) {
        const now = new Date().toISOString();
        const saved = [];
        for (const item of records) {
          const existing = await col('attendancePeriods').findOne({ tenantId, studentId: item.studentId, date, slotId });
          const after = {
            id: existing?.id || id(), tenantId, date, slotId, className, section, subject,
            studentId: item.studentId, status: item.status, remark: item.remark?.trim() || '',
            createdBy: existing?.createdBy || actorId, createdAt: existing?.createdAt || now,
            updatedBy: actorId, updatedAt: now,
          };
          await col('attendancePeriods').updateOne({ tenantId, studentId: item.studentId, date, slotId }, { $set: after }, { upsert: true });
          saved.push(after);
        }
        return saved;
      },
    },

    attendanceInterventions: mongoSimpleCollection('attendanceInterventions', 'studentId'),

    // Parent Registry -- see modules/parents/service.js's header for the
    // full design rationale. parentStudentLinks needs a hand-written
    // list() because callers filter by EITHER parentId OR studentId --
    // mongoSimpleCollection's extraFilterKey only supports one fixed key.
    parents: mongoSimpleCollection('parents'),

    parentStudentLinks: {
      async list(tenantId, { parentId, studentId } = {}) {
        const filter = { tenantId };
        if (parentId) filter.parentId = parentId;
        if (studentId) filter.studentId = studentId;
        return (await col('parentStudentLinks').find(filter).sort({ createdAt: -1 }).toArray()).map(strip);
      },
      async findById(tenantId, linkId) { return strip(await col('parentStudentLinks').findOne({ id: linkId, tenantId })); },
      async create(payload) {
        const record = { id: id(), createdAt: new Date().toISOString(), ...payload };
        await col('parentStudentLinks').insertOne(record);
        return record;
      },
      async update(tenantId, linkId, patch) {
        await col('parentStudentLinks').updateOne({ id: linkId, tenantId }, { $set: patch });
        return this.findById(tenantId, linkId);
      },
      async remove(tenantId, linkId) {
        const result = await col('parentStudentLinks').deleteOne({ id: linkId, tenantId });
        return result.deletedCount > 0;
      },
    },

    // Examinations (designs/Teacher feature UI mockup/Examinations.dc.html).
    // exam_sessions itself (the Datesheet, screen 3) needed NO changes here
    // -- create/update already spread the whole payload/patch generically,
    // so the new cycleId/periodSlotId/durationMinutes/sectionsIncluded
    // fields just flow through.
    examCycles: mongoSimpleCollection('examCycles'),

    examStructure: {
      ...mongoSimpleCollection('examStructure', 'cycleId'),
      async findOne(tenantId, { cycleId, className, subjectName }) {
        return strip(await col('examStructure').findOne({ tenantId, cycleId, className, subjectName }));
      },
    },
    examStructureComponents: mongoSimpleCollection('examStructureComponents', 'structureId'),

    examMarksheets: {
      ...mongoSimpleCollection('examMarksheets', 'cycleId'),
      async findOne(tenantId, { cycleId, className, section, subjectName }) {
        return strip(await col('examMarksheets').findOne({ tenantId, cycleId, className, section, subjectName }));
      },
    },
    examMarks: {
      ...mongoSimpleCollection('examMarks', 'marksheetId'),
      async findOne(tenantId, { marksheetId, studentId }) {
        return strip(await col('examMarks').findOne({ tenantId, marksheetId, studentId }));
      },
    },

    // One row per cycle+student -- upsert-by-lookup, same reasoning as the
    // other two adapters' version.
    examReportComments: {
      async list(tenantId, { cycleId } = {}) {
        const filter = { tenantId };
        if (cycleId) filter.cycleId = cycleId;
        return (await col('examReportComments').find(filter).toArray()).map(strip);
      },
      async upsert(tenantId, { cycleId, studentId, className, comment, classTeacherStaffId = null }) {
        await col('examReportComments').updateOne(
          { tenantId, cycleId, studentId },
          { $set: { className, comment, classTeacherStaffId, updatedAt: new Date().toISOString() }, $setOnInsert: { id: id(), tenantId, cycleId, studentId } },
          { upsert: true },
        );
        return strip(await col('examReportComments').findOne({ tenantId, cycleId, studentId }));
      },
    },

    // Append-only -- mirrors attendance_history's before/after/actor/at
    // shape, scoped by an optional cycleId.
    examAuditLog: {
      async record({ event, actorId, target = null, tenantId, cycleId = null, detail = '', beforeJson = null, afterJson = null }) {
        await col('examAuditLog').insertOne({ id: id(), tenantId, cycleId, event, actorId, target, detail, beforeJson, afterJson, at: new Date().toISOString() });
      },
      async list(tenantId, { cycleId } = {}) {
        const filter = { tenantId };
        if (cycleId) filter.cycleId = cycleId;
        return (await col('examAuditLog').find(filter).sort({ at: -1 }).toArray()).map(strip);
      },
    },

    attendanceSettings: {
      async get(tenantId) { return strip(await col('attendanceSettings').findOne({ tenantId })); },
      async upsert(tenantId, patch) {
        await col('attendanceSettings').updateOne(
          { tenantId },
          { $set: { ...patch, updatedAt: new Date().toISOString() }, $setOnInsert: { tenantId } },
          { upsert: true },
        );
        return this.get(tenantId);
      },
    },

    schoolProfile: {
      async get(tenantId) {
        const doc = await col('schoolProfiles').findOne({ tenantId });
        return doc ? strip(doc) : emptyProfile(tenantId);
      },
      async updateSection(tenantId, section, data) {
        await col('schoolProfiles').updateOne(
          { tenantId },
          { $set: { [section]: data, updatedAt: new Date().toISOString() }, $setOnInsert: { tenantId } },
          { upsert: true },
        );
        return this.get(tenantId);
      },
    },

    academicYears: {
      ...mongoSimpleCollection('academicYears'),
      async setCurrent(tenantId, yearId) {
        const year = await col('academicYears').findOne({ id: yearId, tenantId });
        if (!year) return null;
        await col('academicYears').updateMany({ tenantId, status: 'current' }, { $set: { status: 'closed' } });
        await col('academicYears').updateOne({ id: yearId, tenantId }, { $set: { status: 'current' } });
        return strip(await col('academicYears').findOne({ id: yearId, tenantId }));
      },
    },

    academicTerms: mongoSimpleCollection('academicTerms', 'academicYearId'),
    subjects: mongoSimpleCollection('subjects'),
    holidays: mongoSimpleCollection('holidays'),
    grades: mongoSimpleCollection('grades'),
    feeTypes: mongoSimpleCollection('feeTypes'),

    // Timetable -- same contract as memoryAdapter.js; see that file's
    // comments for the reasoning behind each shape.
    timetableConfig: {
      async get(tenantId) { return strip(await col('timetableConfig').findOne({ tenantId })); },
      async upsert(tenantId, patch) {
        await col('timetableConfig').updateOne(
          { tenantId },
          { $set: { ...patch, updatedAt: new Date().toISOString() }, $setOnInsert: { tenantId } },
          { upsert: true },
        );
        return this.get(tenantId);
      },
    },

    timetableVenues: mongoSimpleCollection('timetableVenues'),

    timetableVersions: {
      async list(tenantId) { return (await col('timetableVersions').find({ tenantId }).sort({ versionNumber: -1 }).toArray()).map(strip); },
      async findById(tenantId, versionId) { return strip(await col('timetableVersions').findOne({ id: versionId, tenantId })); },
      async getLive(tenantId) { return strip(await col('timetableVersions').findOne({ tenantId, state: 'live' })); },
      async create({ tenantId, note = '', sourceRunId = null, createdBy }) {
        const existing = await col('timetableVersions').find({ tenantId }).toArray();
        const versionNumber = existing.length === 0 ? 1 : Math.max(...existing.map((v) => v.versionNumber)) + 1;
        const record = {
          id: id(), tenantId, versionNumber, state: 'draft', note, sourceRunId, createdBy,
          createdAt: new Date().toISOString(), publishedAt: null, effectiveFrom: null,
        };
        await col('timetableVersions').insertOne(record);
        return record;
      },
      async publish(tenantId, versionId, { effectiveFrom } = {}) {
        const version = await col('timetableVersions').findOne({ id: versionId, tenantId });
        if (!version) return null;
        await col('timetableVersions').updateMany({ tenantId, state: 'live' }, { $set: { state: 'archived' } });
        await col('timetableVersions').updateOne({ id: versionId, tenantId }, { $set: { state: 'live', publishedAt: new Date().toISOString(), effectiveFrom: effectiveFrom || null } });
        return this.findById(tenantId, versionId);
      },
    },

    timetableEntries: {
      async listForVersion(tenantId, versionId) { return (await col('timetableEntries').find({ tenantId, versionId }).toArray()).map(strip); },
      async replaceForVersion(tenantId, versionId, entries) {
        await col('timetableEntries').deleteMany({ tenantId, versionId });
        const records = entries.map((e) => ({ id: id(), tenantId, versionId, createdAt: new Date().toISOString(), ...e }));
        if (records.length) await col('timetableEntries').insertMany(records);
        return records;
      },
      async upsertOne(tenantId, versionId, entry) {
        const filter = { tenantId, versionId, className: entry.className, section: entry.section, day: entry.day, slotId: entry.slotId };
        const existing = await col('timetableEntries').findOne(filter);
        const record = { id: existing?.id || id(), tenantId, versionId, createdAt: existing?.createdAt || new Date().toISOString(), ...entry };
        await col('timetableEntries').updateOne(filter, { $set: record }, { upsert: true });
        return record;
      },
      async removeOne(tenantId, versionId, { className, section, day, slotId }) {
        const result = await col('timetableEntries').deleteOne({ tenantId, versionId, className, section, day, slotId });
        return result.deletedCount > 0;
      },
    },

    timetableRuns: {
      async list(tenantId) { return (await col('timetableRuns').find({ tenantId }).sort({ createdAt: -1 }).toArray()).map(strip); },
      async create(run) {
        const record = { id: id(), createdAt: new Date().toISOString(), ...run };
        await col('timetableRuns').insertOne(record);
        return record;
      },
    },

    examSessions: {
      async list(tenantId, { className } = {}) {
        const filter = { tenantId };
        if (className) filter.className = className;
        return (await col('examSessions').find(filter).sort({ examDate: 1, session: 1 }).toArray()).map(strip);
      },
      async findById(tenantId, examId) { return strip(await col('examSessions').findOne({ id: examId, tenantId })); },
      async create(exam) {
        const record = { id: id(), createdAt: new Date().toISOString(), ...exam };
        await col('examSessions').insertOne(record);
        return record;
      },
      async update(tenantId, examId, patch) {
        await col('examSessions').updateOne({ id: examId, tenantId }, { $set: patch });
        return this.findById(tenantId, examId);
      },
      async remove(tenantId, examId) {
        const result = await col('examSessions').deleteOne({ id: examId, tenantId });
        return result.deletedCount > 0;
      },
    },

    timetableRelief: {
      async listForDate(tenantId, reliefDate) { return (await col('timetableRelief').find({ tenantId, reliefDate }).toArray()).map(strip); },
      async findById(tenantId, reliefId) { return strip(await col('timetableRelief').findOne({ id: reliefId, tenantId })); },
      async ensure(tenantId, row) {
        const filter = { tenantId, reliefDate: row.reliefDate, slotId: row.slotId, className: row.className, section: row.section };
        const existing = await col('timetableRelief').findOne(filter);
        if (existing) return strip(existing);
        const record = { id: id(), tenantId, status: 'open', coverStaffId: null, note: '', notifiedAt: null, createdAt: new Date().toISOString(), ...row };
        await col('timetableRelief').insertOne(record);
        return record;
      },
      async assign(tenantId, reliefId, { coverStaffId, note = '' }) {
        const patch = { coverStaffId, status: coverStaffId ? 'covered' : 'open' };
        if (note) patch.note = note;
        await col('timetableRelief').updateOne({ id: reliefId, tenantId }, { $set: patch });
        return this.findById(tenantId, reliefId);
      },
      async markNotified(tenantId, ids) {
        const notifiedAt = new Date().toISOString();
        await col('timetableRelief').updateMany({ tenantId, id: { $in: ids } }, { $set: { notifiedAt } });
        return (await col('timetableRelief').find({ tenantId, id: { $in: ids } }).toArray()).map(strip);
      },
    },

    // Classes & Sections (designs/Teacher feature UI mockup/
    // Classes and Sections.dc.html). Class teacher is deliberately NOT
    // stored here -- staff.classTeacherOf is the single source of truth;
    // see classes/routes.js.
    classLevels: {
      async list(tenantId) {
        return (await col('classLevels').find({ tenantId }).sort({ orderIndex: 1 }).toArray()).map(strip);
      },
      async findById(tenantId, levelId) { return strip(await col('classLevels').findOne({ id: levelId, tenantId })); },
      async findByName(tenantId, name) { return strip(await col('classLevels').findOne({ tenantId, name })); },
      async create(level) {
        const record = { id: id(), createdAt: new Date().toISOString(), ...level };
        await col('classLevels').insertOne(record);
        return record;
      },
      async update(tenantId, levelId, patch) {
        await col('classLevels').updateOne({ id: levelId, tenantId }, { $set: { ...patch, updatedAt: new Date().toISOString() } });
        return this.findById(tenantId, levelId);
      },
      async remove(tenantId, levelId) {
        const result = await col('classLevels').deleteOne({ id: levelId, tenantId });
        return result.deletedCount > 0;
      },
    },

    classSections: {
      async list(tenantId, { classLevelId } = {}) {
        const filter = { tenantId };
        if (classLevelId) filter.classLevelId = classLevelId;
        return (await col('classSections').find(filter).sort({ letter: 1 }).toArray()).map(strip);
      },
      async findById(tenantId, sectionId) { return strip(await col('classSections').findOne({ id: sectionId, tenantId })); },
      async create(section) {
        const record = { id: id(), createdAt: new Date().toISOString(), ...section };
        await col('classSections').insertOne(record);
        return record;
      },
      async update(tenantId, sectionId, patch) {
        await col('classSections').updateOne({ id: sectionId, tenantId }, { $set: { ...patch, updatedAt: new Date().toISOString() } });
        return this.findById(tenantId, sectionId);
      },
      async remove(tenantId, sectionId) {
        const result = await col('classSections').deleteOne({ id: sectionId, tenantId });
        return result.deletedCount > 0;
      },
    },

    classWaitlist: mongoSimpleCollection('classWaitlist', 'className'),
    classCurriculum: mongoSimpleCollection('classCurriculum', 'className'),

    classPromotionRuns: {
      async list(tenantId) {
        return (await col('classPromotionRuns').find({ tenantId }).sort({ createdAt: -1 }).toArray()).map(strip);
      },
      async findById(tenantId, runId) { return strip(await col('classPromotionRuns').findOne({ id: runId, tenantId })); },
      async create(run) {
        const record = { id: id(), createdAt: new Date().toISOString(), rolledBack: false, ...run };
        await col('classPromotionRuns').insertOne(record);
        return record;
      },
      async markRolledBack(tenantId, runId) {
        await col('classPromotionRuns').updateOne({ id: runId, tenantId }, { $set: { rolledBack: true } });
        return this.findById(tenantId, runId);
      },
    },

    classStructureSettings: {
      async get(tenantId) { return strip(await col('classStructureSettings').findOne({ tenantId })); },
      async upsert(tenantId, patch) {
        await col('classStructureSettings').updateOne(
          { tenantId },
          { $set: { ...patch, updatedAt: new Date().toISOString() }, $setOnInsert: { tenantId } },
          { upsert: true },
        );
        return this.get(tenantId);
      },
    },

    // Settings module -- Security Policy, one row per tenant.
    securityPolicies: {
      async get(tenantId) { return strip(await col('securityPolicies').findOne({ tenantId })); },
      async upsert(tenantId, patch) {
        await col('securityPolicies').updateOne(
          { tenantId },
          { $set: { ...patch, updatedAt: new Date().toISOString() }, $setOnInsert: { tenantId } },
          { upsert: true },
        );
        return this.get(tenantId);
      },
    },

    // Fees & Payments module additions. A RECORD of an offline collection
    // process (see schema.sql header) -- fee_types/School Setup is
    // untouched and unrelated.
    feeStructures: {
      async list(tenantId) {
        return (await col('feeStructures').find({ tenantId }).sort({ version: -1 }).toArray()).map(strip);
      },
      async findById(tenantId, structureId) { return strip(await col('feeStructures').findOne({ id: structureId, tenantId })); },
      async findPublished(tenantId) { return strip(await col('feeStructures').findOne({ tenantId, status: 'published' })); },
      async createDraft(tenantId, { createdBy }) {
        const existing = await col('feeStructures').find({ tenantId }).toArray();
        const version = existing.length === 0 ? 1 : Math.max(...existing.map((s) => s.version)) + 1;
        const record = { id: id(), tenantId, version, status: 'draft', publishedAt: null, createdBy, createdAt: new Date().toISOString() };
        await col('feeStructures').insertOne(record);
        return record;
      },
      // Publishing a draft archives whichever version was previously
      // published -- exactly one published version prices new invoices at
      // a time, the same one-live-at-a-time rule as timetable_versions.
      async publish(tenantId, structureId) {
        await col('feeStructures').updateMany({ tenantId, status: 'published' }, { $set: { status: 'archived' } });
        await col('feeStructures').updateOne({ id: structureId, tenantId }, { $set: { status: 'published', publishedAt: new Date().toISOString() } });
        return this.findById(tenantId, structureId);
      },
    },

    feeStructureHeads: {
      ...mongoSimpleCollection('feeStructureHeads', 'structureId'),
      // The Fee structure screen saves the whole grid at once -- replace
      // is simpler and safer than diffing individual head edits, matching
      // how class_curriculum's PUT already replaces its rows wholesale.
      async replaceForStructure(tenantId, structureId, heads) {
        await col('feeStructureHeads').deleteMany({ tenantId, structureId });
        const created = heads.map((h, index) => ({ id: id(), tenantId, structureId, orderIndex: index, createdAt: new Date().toISOString(), ...h }));
        if (created.length) await col('feeStructureHeads').insertMany(created);
        return created;
      },
    },

    feeBillingSchedule: mongoSimpleCollection('feeBillingSchedule'),

    feeStructureRules: {
      async get(tenantId) { return strip(await col('feeStructureRules').findOne({ tenantId })); },
      async upsert(tenantId, patch) {
        await col('feeStructureRules').updateOne(
          { tenantId },
          { $set: { ...patch, updatedAt: new Date().toISOString() }, $setOnInsert: { tenantId } },
          { upsert: true },
        );
        return this.get(tenantId);
      },
    },

    feeInvoices: {
      async list(tenantId, { studentId, termLabel } = {}) {
        const filter = { tenantId };
        if (studentId) filter.studentId = studentId;
        if (termLabel) filter.termLabel = termLabel;
        return (await col('feeInvoices').find(filter).sort({ raisedAt: -1 }).toArray()).map(strip);
      },
      async findById(tenantId, invoiceId) { return strip(await col('feeInvoices').findOne({ id: invoiceId, tenantId })); },
      async findByInvoiceNo(tenantId, invoiceNo) { return strip(await col('feeInvoices').findOne({ tenantId, invoiceNo })); },
      async existsForStudentTerm(tenantId, studentId, termLabel) {
        return !!(await col('feeInvoices').findOne({ tenantId, studentId, termLabel }));
      },
      async create(payload) {
        const record = { id: id(), raisedAt: new Date().toISOString(), ...payload };
        await col('feeInvoices').insertOne(record);
        return record;
      },
    },

    feeInvoiceLines: {
      ...mongoSimpleCollection('feeInvoiceLines', 'invoiceId'),
      async createMany(tenantId, invoiceId, lines) {
        const created = lines.map((l) => ({ id: id(), tenantId, invoiceId, createdAt: new Date().toISOString(), ...l }));
        if (created.length) await col('feeInvoiceLines').insertMany(created);
        return created;
      },
    },

    feePayments: {
      async list(tenantId, { studentId } = {}) {
        const filter = { tenantId };
        if (studentId) filter.studentId = studentId;
        return (await col('feePayments').find(filter).sort({ recordedAt: -1 }).toArray()).map(strip);
      },
      async findById(tenantId, paymentId) { return strip(await col('feePayments').findOne({ id: paymentId, tenantId })); },
      async create(payload) {
        const record = { id: id(), confirmed: false, recordedAt: new Date().toISOString(), ...payload };
        await col('feePayments').insertOne(record);
        return record;
      },
      async markConfirmed(tenantId, paymentId) {
        await col('feePayments').updateOne({ id: paymentId, tenantId }, { $set: { confirmed: true } });
        return this.findById(tenantId, paymentId);
      },
    },

    feePaymentAllocations: {
      ...mongoSimpleCollection('feePaymentAllocations', 'invoiceId'),
      async createMany(tenantId, paymentId, allocations) {
        const created = allocations.map((a) => ({ id: id(), tenantId, paymentId, createdAt: new Date().toISOString(), ...a }));
        if (created.length) await col('feePaymentAllocations').insertMany(created);
        return created;
      },
      async listForPayment(tenantId, paymentId) {
        return (await col('feePaymentAllocations').find({ tenantId, paymentId }).toArray()).map(strip);
      },
    },

    feePaymentPlans: mongoSimpleCollection('feePaymentPlans', 'studentId'),

    // Bank lines entered by hand (see schema.sql header -- no statement
    // upload this pass). setMatch is called by the real matching engine
    // in modules/fees/service.js, never directly by the person entering
    // the line.
    bankStatementLines: {
      ...mongoSimpleCollection('bankStatementLines'),
      async setMatch(tenantId, lineId, { paymentId, confidence, reviewedBy }) {
        await col('bankStatementLines').updateOne(
          { id: lineId, tenantId },
          { $set: { matchedPaymentId: paymentId, confidence, reviewedBy, reviewedAt: new Date().toISOString() } },
        );
        return this.findById(tenantId, lineId);
      },
    },

    feeDisbursements: {
      ...mongoSimpleCollection('feeDisbursements'),
      async decide(tenantId, disbursementId, { state, approvedBy }) {
        await col('feeDisbursements').updateOne(
          { id: disbursementId, tenantId },
          { $set: { state, approvedBy, decidedAt: new Date().toISOString() } },
        );
        return this.findById(tenantId, disbursementId);
      },
    },

    // Escalation ladder log (screen 7) -- see schema.sql header: automatic
    // reminder counts are derived live from invoice ageing in service.js;
    // this collection only logs the two MANUAL steps for real.
    feeEscalationEvents: mongoSimpleCollection('feeEscalationEvents', 'studentId'),

    feeSettings: {
      async get(tenantId) { return strip(await col('feeSettings').findOne({ tenantId })); },
      async upsert(tenantId, patch) {
        await col('feeSettings').updateOne(
          { tenantId },
          { $set: { ...patch, updatedAt: new Date().toISOString() }, $setOnInsert: { tenantId } },
          { upsert: true },
        );
        return this.get(tenantId);
      },
    },

    documents: {
      async create(doc) {
        const record = { id: id(), createdAt: new Date().toISOString(), expiryDate: null, ...doc };
        await col('documents').insertOne(record);
        return record;
      },
      async listForEntity(tenantId, entityType, entityId) {
        return (await col('documents').find({ tenantId, entityType, entityId }).sort({ createdAt: -1 }).toArray()).map(strip);
      },
      async listForEntityType(tenantId, entityType) {
        return (await col('documents').find({ tenantId, entityType }).sort({ createdAt: -1 }).toArray()).map(strip);
      },
      async findById(tenantId, documentId) { return strip(await col('documents').findOne({ id: documentId, tenantId })); },
      async remove(tenantId, documentId) {
        const result = await col('documents').deleteOne({ id: documentId, tenantId });
        return result.deletedCount > 0;
      },
    },

    // Notices & Communication (edusphere-notices-communication-module-plan-
    // 2026-09-22.md). Status is computed by modules/notices/service.js from
    // publishAt/expiryAt/isDraft/isArchived, never stored here.
    notices: {
      async list(tenantId, { category, audienceType, className, search } = {}) {
        const filter = { tenantId };
        if (category) filter.category = category;
        if (audienceType) filter.audienceType = audienceType;
        if (className) filter.audienceClassName = className;
        if (search) {
          const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          filter.$or = [{ title: re }, { description: re }];
        }
        return (await col('notices').find(filter).sort({ createdAt: -1 }).toArray()).map(strip);
      },
      async findById(tenantId, noticeId) { return strip(await col('notices').findOne({ id: noticeId, tenantId })); },
      async create(notice) {
        const record = {
          id: id(), createdAt: new Date().toISOString(), updatedAt: null,
          audienceRole: null, audienceClassName: null, audienceSection: null,
          audienceRecipientType: null, audienceRecipientId: null, expiryAt: null,
          ...notice,
        };
        await col('notices').insertOne(record);
        return record;
      },
      async update(tenantId, noticeId, patch) {
        await col('notices').updateOne({ id: noticeId, tenantId }, { $set: { ...patch, updatedAt: new Date().toISOString() } });
        return this.findById(tenantId, noticeId);
      },
      async remove(tenantId, noticeId) {
        const result = await col('notices').deleteOne({ id: noticeId, tenantId });
        return result.deletedCount > 0;
      },
    },

    noticeAcknowledgements: {
      async listForNotice(tenantId, noticeId) {
        return (await col('noticeAcknowledgements').find({ tenantId, noticeId }).sort({ recordedAt: -1 }).toArray()).map(strip);
      },
      async create(ack) {
        const record = { id: id(), recordedAt: new Date().toISOString(), note: '', ...ack };
        await col('noticeAcknowledgements').insertOne(record);
        return record;
      },
    },

    // Payroll (see schema.sql's Payroll header).
    payProfiles: {
      ...mongoSimpleCollection('payProfiles', 'staffId'),
      async findByStaff(tenantId, staffId) { return strip(await col('payProfiles').findOne({ tenantId, staffId })); },
      async upsert(tenantId, staffId, patch) {
        const existing = await col('payProfiles').findOne({ tenantId, staffId });
        if (existing) {
          await col('payProfiles').updateOne({ tenantId, staffId }, { $set: patch });
        } else {
          await col('payProfiles').insertOne({ id: id(), createdAt: new Date().toISOString(), tenantId, staffId, ...patch });
        }
        return strip(await col('payProfiles').findOne({ tenantId, staffId }));
      },
    },
    payrollRuns: {
      ...mongoSimpleCollection('payrollRuns', 'period'),
      async findByPeriod(tenantId, period) { return strip(await col('payrollRuns').findOne({ tenantId, period })); },
    },
    payslips: {
      ...mongoSimpleCollection('payslips', 'runId'),
      async listByStaff(tenantId, staffId) {
        return (await col('payslips').find({ tenantId, staffId }).sort({ period: -1 }).toArray()).map(strip);
      },
      async removeByRun(tenantId, runId) {
        await col('payslips').deleteMany({ tenantId, runId });
        return true;
      },
    },

    audit: {
      async record({ event, actorId, target, tenantId, summary = {} }) {
        await col('auditLogs').insertOne({ id: id(), event, actorId, target, tenantId, summary, at: new Date().toISOString() });
      },
      async list(tenantId) { return (await col('auditLogs').find({ tenantId }).sort({ at: -1 }).toArray()).map(strip); },
    },
  };
}
