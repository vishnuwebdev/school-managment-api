import { Router } from 'express';
import multer from 'multer';
import { authenticate, tenantScope, permit, validDate } from '../../core/middleware.js';
import { asyncRoute, badRequest, conflict, notFound } from '../../core/errors.js';
import { db } from '../../db/index.js';
import { parseCsv, toCsv } from '../../core/csv.js';
import { generateTabularReportPdf } from '../../core/reportPdf.js';

// Teachers & Staff (designs/Teacher feature UI mockup/Teachers & Staff.dc.html,
// 9 screens). Follows the students module's shape closely -- see
// schema.sql's staff/staff_assignments/staff_leave table comments for the
// scope cuts this build makes relative to the design (no real Timetable,
// no clash-detection/auto-balance/substitutions, no daily attendance
// heatmap, CSV import uses the same fixed-template pattern as Students
// rather than the design's generic column-mapper).
//
// RBAC rewrite: migrated to the new feature:page:action permission model
// (core/permissionsV2.js's 'staff' entry) -- the old staff.view/create/
// update/archive/import keys still work via the OLD_TO_NEW compat bridge.
// Assignment CRUD (POST/PUT/DELETE /:id/assignments) now has its own
// 'assignments' page rather than folding into 'profile', since it's a
// genuinely separate sub-resource reached from its own screen (Assignments
// & Workload) as well as the Profile's Subjects & Classes tab. Archive
// (PATCH /:id/archive, a soft deactivate) and Offboard (PATCH
// /:id/offboard, records an exit date/reason without removing the record)
// used to share one 'staff.archive' key for two materially different real
// buttons -- split into 'archive:delete'/'offboarding:update' here, same
// move Students made splitting students.archive into archive/
// withdraw-transfer. There's still no self-service teacher portal, so
// every action here remains an admin acting on someone else's record, same
// trust boundary as before.
export const staffRouter = Router();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

const GENDERS = new Set(['Male', 'Female', 'Other']);
const STAFF_TYPES = new Set(['Teaching', 'Non-teaching']);
const ASSIGNMENT_ROLES = new Set(['Class teacher', 'Subject', 'Relief']);
const REPORT_TYPES = new Set(['directory', 'compliance', 'leave-summary']);
// Compliance register (screen 9) checks presence/expiry of these document
// types against api/src/modules/storage (entityType 'staff') -- a fixed,
// code-defined list rather than a configurable "required document types"
// admin screen, which is out of scope for this pass.
const REQUIRED_DOCUMENT_TYPES = ['Qualification', 'Registration', 'Compliance'];

function sanitizeStaffPayload(body, { partial = false } = {}) {
  body = body || {};
  const clean = {};
  const requireString = (key, label) => {
    if (!body[key] || typeof body[key] !== 'string' || !body[key].trim()) throw badRequest(`${label} is required`);
    clean[key] = body[key].trim();
  };

  if (!partial || body.employeeId !== undefined) requireString('employeeId', 'Employee ID');
  if (!partial || body.firstName !== undefined) requireString('firstName', 'First name');
  if (!partial || body.lastName !== undefined) requireString('lastName', 'Last name');
  if (!partial || body.designation !== undefined) requireString('designation', 'Designation');
  if (!partial || body.department !== undefined) requireString('department', 'Department');

  for (const key of ['idNumber', 'personalEmail', 'workEmail', 'phone', 'address', 'employmentType',
    'reportsTo', 'classTeacherOf', 'notes']) {
    if (typeof body[key] === 'string') clean[key] = body[key].trim();
  }

  if (body.dateOfBirth !== undefined) {
    if (body.dateOfBirth && !validDate(body.dateOfBirth)) throw badRequest('dateOfBirth must be a valid YYYY-MM-DD date');
    clean.dateOfBirth = body.dateOfBirth || null;
  }
  if (body.joiningDate !== undefined) {
    if (body.joiningDate && !validDate(body.joiningDate)) throw badRequest('joiningDate must be a valid YYYY-MM-DD date');
    clean.joiningDate = body.joiningDate || null;
  }
  if (body.gender !== undefined) {
    if (body.gender && !GENDERS.has(body.gender)) throw badRequest(`gender must be one of ${[...GENDERS].join(', ')}`);
    clean.gender = body.gender || null;
  }
  if (body.staffType !== undefined) {
    const value = body.staffType || 'Teaching';
    if (!STAFF_TYPES.has(value)) throw badRequest(`staffType must be one of ${[...STAFF_TYPES].join(', ')}`);
    clean.staffType = value;
  }
  if (body.weeklyPeriodCapacity !== undefined) {
    const n = Number(body.weeklyPeriodCapacity);
    if (!Number.isInteger(n) || n <= 0) throw badRequest('weeklyPeriodCapacity must be a positive whole number');
    clean.weeklyPeriodCapacity = n;
  }
  if (body.isClassTeacher !== undefined) clean.isClassTeacher = Boolean(body.isClassTeacher);

  return clean;
}

function sanitizeOffboarding(body) {
  const { date, reason, remarks = '' } = body || {};
  if (!validDate(date)) throw badRequest('date must be a valid YYYY-MM-DD date');
  if (!reason || typeof reason !== 'string') throw badRequest('reason is required');
  if (typeof remarks !== 'string') throw badRequest('remarks must be a string');
  return { date, reason: reason.trim(), remarks: remarks.trim() };
}

function sanitizeAssignmentPayload(body) {
  body = body || {};
  const clean = {};
  for (const [key, label] of [['subject', 'Subject'], ['className', 'Class'], ['section', 'Section']]) {
    if (!body[key] || typeof body[key] !== 'string' || !body[key].trim()) throw badRequest(`${label} is required`);
    clean[key] = body[key].trim();
  }
  const periods = body.periodsPerWeek === undefined ? 1 : Number(body.periodsPerWeek);
  if (!Number.isInteger(periods) || periods <= 0) throw badRequest('periodsPerWeek must be a positive whole number');
  clean.periodsPerWeek = periods;
  const role = body.role || 'Subject';
  if (!ASSIGNMENT_ROLES.has(role)) throw badRequest(`role must be one of ${[...ASSIGNMENT_ROLES].join(', ')}`);
  clean.role = role;
  return clean;
}

staffRouter.get('/', authenticate, tenantScope, permit('staff:profile:read'), asyncRoute(async (req, res) => {
  const { q = '', department, staffType, status } = req.query;
  const data = await db.staff.list(req.tenantId, { query: q, department, staffType, status });
  res.json({ data, meta: { total: data.length, tenantId: req.tenantId } });
}));

// --- Import (ahead of /:id so "import" is never read as a staff id) ---

const IMPORT_TEMPLATE_HEADERS = [
  'employeeId', 'firstName', 'lastName', 'staffType', 'designation', 'department',
  'employmentType', 'joiningDate', 'workEmail', 'personalEmail', 'phone', 'weeklyPeriodCapacity',
];

staffRouter.get('/import/template', authenticate, tenantScope, permit('staff:import:write'), asyncRoute(async (req, res) => {
  const example = {
    employeeId: 'EMP-0231', firstName: 'Nomsa', lastName: 'Mahlangu', staffType: 'Teaching',
    designation: 'Teacher', department: 'Sciences', employmentType: 'Permanent · Full-time',
    joiningDate: '2026-01-12', workEmail: 'n.mahlangu@brightfuture.edu', personalEmail: '',
    phone: '+27 83 000 0000', weeklyPeriodCapacity: '30',
  };
  const csv = toCsv(IMPORT_TEMPLATE_HEADERS, [example]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="staff_import_template.csv"');
  res.send(csv);
}));

staffRouter.post('/import/preview', authenticate, tenantScope, permit('staff:import:write'), upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw badRequest('A CSV file is required');
  const records = parseCsv(req.file.buffer.toString('utf-8'));
  const seenInFile = new Set();
  const rows = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const rowNumber = i + 2;
    const employeeId = (record.employeeId || '').trim();
    const name = `${record.firstName || ''} ${record.lastName || ''}`.trim();
    try {
      if (!employeeId) throw new Error('Employee ID missing');
      if (seenInFile.has(employeeId)) throw new Error('Duplicate employee ID in this file');
      if (await db.staff.existsByEmployeeId(req.tenantId, employeeId)) throw new Error('Employee ID already exists');
      const payload = sanitizeStaffPayload(record);
      if (record.joiningDate && !validDate(record.joiningDate)) throw new Error('Invalid joining date');
      seenInFile.add(employeeId);
      rows.push({ row: rowNumber, employeeId, name, designation: payload.designation, department: payload.department, status: 'Valid', message: null, payload });
    } catch (error) {
      rows.push({ row: rowNumber, employeeId: employeeId || null, name: name || null, designation: record.designation || null, department: record.department || null, status: 'Error', message: error.message, payload: null });
    }
  }
  const validCount = rows.filter((r) => r.status === 'Valid').length;
  res.json({ data: { totalRecords: rows.length, validRecords: validCount, invalidRecords: rows.length - validCount, rows } });
}));

staffRouter.post('/import/commit', authenticate, tenantScope, permit('staff:import:write'), asyncRoute(async (req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) throw badRequest('rows must be a non-empty array of previewed payloads');
  let created = 0;
  const skipped = [];
  for (const payload of rows) {
    if (!payload?.employeeId) { skipped.push({ reason: 'Missing employeeId' }); continue; }
    if (await db.staff.existsByEmployeeId(req.tenantId, payload.employeeId)) {
      skipped.push({ employeeId: payload.employeeId, reason: 'Already exists' });
      continue;
    }
    const clean = sanitizeStaffPayload(payload);
    const staffMember = await db.staff.create({ tenantId: req.tenantId, ...clean });
    await db.audit.record({ event: 'staff.imported', actorId: req.auth.sub, target: staffMember.id, tenantId: req.tenantId });
    created++;
  }
  res.status(201).json({ data: { created, skipped } });
}));

// --- Reports (CSV downloads; also ahead of /:id) ---

staffRouter.get('/reports/:type', authenticate, tenantScope, permit('staff:reports:read'), asyncRoute(async (req, res) => {
  const { type } = req.params;
  if (!REPORT_TYPES.has(type)) throw notFound(`Unknown report type "${type}"`);
  const staff = await db.staff.list(req.tenantId, {});
  let csv;
  let filename;

  if (type === 'directory') {
    filename = 'staff_directory.csv';
    csv = toCsv(
      ['employeeId', 'firstName', 'lastName', 'staffType', 'designation', 'department', 'workEmail', 'phone', 'joiningDate', 'status'],
      staff.map((s) => ({ employeeId: s.employeeId, firstName: s.firstName, lastName: s.lastName, staffType: s.staffType, designation: s.designation, department: s.department, workEmail: s.workEmail, phone: s.phone, joiningDate: s.joiningDate, status: s.status })),
    );
  } else if (type === 'compliance') {
    filename = 'staff_compliance_register.csv';
    const docs = await db.documents.listForEntityType(req.tenantId, 'staff');
    const rows = [];
    for (const s of staff) {
      const staffDocs = docs.filter((d) => d.entityId === s.id);
      for (const docType of REQUIRED_DOCUMENT_TYPES) {
        const match = staffDocs.find((d) => d.documentType === docType);
        let status = 'Missing';
        if (match) {
          status = 'On file';
          if (match.expiryDate) {
            const days = (new Date(match.expiryDate) - new Date()) / 86400000;
            status = days < 0 ? 'Expired' : days <= 60 ? 'Expiring soon' : 'Valid';
          }
        }
        rows.push({ employeeId: s.employeeId, name: `${s.firstName} ${s.lastName}`, documentType: docType, status, expiryDate: match?.expiryDate || '' });
      }
    }
    csv = toCsv(['employeeId', 'name', 'documentType', 'status', 'expiryDate'], rows);
  } else {
    // leave-summary -- the honest "Staff attendance" substitute per
    // edusphere-reports-module-plan-2026-09-22.md: this codebase has never
    // tracked staff daily present/absent, only leave requests
    // (staff_leave), so this reports leave usage rather than fabricating
    // a daily-attendance percentage with no real data behind it.
    filename = 'staff_leave_summary.csv';
    const allLeave = await db.staffLeave.list(req.tenantId, {});
    const rows = staff.map((s) => {
      const mine = allLeave.filter((l) => l.staffId === s.id);
      const approvedDays = mine.filter((l) => l.status === 'approved').reduce((a, l) => a + (l.daysCount || 0), 0);
      const pending = mine.filter((l) => l.status === 'pending').length;
      const mostRecent = [...mine].sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0];
      return {
        employeeId: s.employeeId, name: `${s.firstName} ${s.lastName}`, department: s.department, status: s.status,
        approvedLeaveDays: approvedDays, pendingRequests: pending,
        mostRecentLeaveType: mostRecent?.leaveType || '', mostRecentLeaveDates: mostRecent ? `${mostRecent.startDate} to ${mostRecent.endDate}` : '',
      };
    });
    csv = toCsv(['employeeId', 'name', 'department', 'status', 'approvedLeaveDays', 'pendingRequests', 'mostRecentLeaveType', 'mostRecentLeaveDates'], rows);
  }

  await db.audit.record({ event: 'staff.reportGenerated', actorId: req.auth.sub, target: type, tenantId: req.tenantId });

  if (req.query.format === 'pdf') {
    const school = await db.schools.findById(req.tenantId);
    const [headerLine] = csv.split('\r\n');
    const columns = headerLine.split(',').map((key) => ({ label: key, key }));
    const rows = parseCsv(csv);
    const title = filename.replace(/\.csv$/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const pdf = await generateTabularReportPdf({ tenant: school, title, columns, rows });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/\.csv$/, '.pdf')}"`);
    res.send(pdf);
    return;
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}));

// --- Workload + assignment matrix (ahead of /:id: both are single-segment
// literal paths that would otherwise be swallowed by GET /:id) ---

staffRouter.get('/workload', authenticate, tenantScope, permit('staff:assignments:read'), asyncRoute(async (req, res) => {
  const staff = await db.staff.list(req.tenantId, {});
  const assignments = await db.staffAssignments.listForTenant(req.tenantId);
  const data = staff.map((s) => {
    const own = assignments.filter((a) => a.staffId === s.id);
    const periods = own.reduce((sum, a) => sum + a.periodsPerWeek, 0);
    const classes = new Set(own.map((a) => `${a.className}-${a.section}`)).size;
    const subjects = new Set(own.map((a) => a.subject)).size;
    return {
      staffId: s.id, name: `${s.firstName} ${s.lastName}`, department: s.department,
      periods, capacity: s.weeklyPeriodCapacity, classes, subjects,
      freePeriods: Math.max(0, s.weeklyPeriodCapacity - periods),
    };
  });
  res.json({ data });
}));

staffRouter.get('/assignments/matrix', authenticate, tenantScope, permit('staff:assignments:read'), asyncRoute(async (req, res) => {
  const staff = await db.staff.list(req.tenantId, {});
  const byId = Object.fromEntries(staff.map((s) => [s.id, s]));
  const assignments = await db.staffAssignments.listForTenant(req.tenantId);
  const data = assignments.map((a) => ({
    ...a,
    staffName: byId[a.staffId] ? `${byId[a.staffId].firstName} ${byId[a.staffId].lastName}` : null,
  }));
  res.json({ data });
}));

staffRouter.get('/:id', authenticate, tenantScope, permit('staff:profile:read'), asyncRoute(async (req, res) => {
  const staffMember = await db.staff.findById(req.tenantId, req.params.id);
  if (!staffMember) throw notFound('Staff member not found');
  res.json({ data: staffMember });
}));

staffRouter.post('/', authenticate, tenantScope, permit('staff:profile:write'), asyncRoute(async (req, res) => {
  const clean = sanitizeStaffPayload(req.body);
  if (await db.staff.existsByEmployeeId(req.tenantId, clean.employeeId)) {
    throw conflict('Employee ID already exists for this school');
  }
  const staffMember = await db.staff.create({ tenantId: req.tenantId, ...clean });
  await db.audit.record({ event: 'staff.created', actorId: req.auth.sub, target: staffMember.id, tenantId: req.tenantId });
  res.status(201).json({ data: staffMember });
}));

staffRouter.put('/:id', authenticate, tenantScope, permit('staff:profile:update'), asyncRoute(async (req, res) => {
  const existing = await db.staff.findById(req.tenantId, req.params.id);
  if (!existing) throw notFound('Staff member not found');
  const clean = sanitizeStaffPayload(req.body, { partial: true });
  if (clean.employeeId && clean.employeeId !== existing.employeeId) {
    if (await db.staff.existsByEmployeeId(req.tenantId, clean.employeeId)) throw conflict('Employee ID already exists for this school');
  }
  const staffMember = await db.staff.update(req.tenantId, req.params.id, clean);
  await db.audit.record({ event: 'staff.updated', actorId: req.auth.sub, target: staffMember.id, tenantId: req.tenantId });
  res.json({ data: staffMember });
}));

staffRouter.patch('/:id/archive', authenticate, tenantScope, permit('staff:archive:delete'), asyncRoute(async (req, res) => {
  const staffMember = await db.staff.findById(req.tenantId, req.params.id);
  if (!staffMember) throw notFound('Staff member not found');
  const archived = await db.staff.archive(req.tenantId, req.params.id);
  await db.audit.record({ event: 'staff.archived', actorId: req.auth.sub, target: staffMember.id, tenantId: req.tenantId });
  res.json({ data: archived });
}));

staffRouter.patch('/:id/offboard', authenticate, tenantScope, permit('staff:offboarding:update'), asyncRoute(async (req, res) => {
  const staffMember = await db.staff.findById(req.tenantId, req.params.id);
  if (!staffMember) throw notFound('Staff member not found');
  const offboarding = sanitizeOffboarding(req.body);
  const updated = await db.staff.offboard(req.tenantId, req.params.id, offboarding);
  await db.audit.record({ event: 'staff.offboarded', actorId: req.auth.sub, target: staffMember.id, tenantId: req.tenantId, summary: offboarding });
  res.json({ data: updated });
}));

// --- Subject/class assignments (Profile > Subjects & Classes tab) ---

staffRouter.get('/:id/assignments', authenticate, tenantScope, permit('staff:assignments:read'), asyncRoute(async (req, res) => {
  const staffMember = await db.staff.findById(req.tenantId, req.params.id);
  if (!staffMember) throw notFound('Staff member not found');
  const data = await db.staffAssignments.listForStaff(req.tenantId, req.params.id);
  res.json({ data });
}));

staffRouter.post('/:id/assignments', authenticate, tenantScope, permit('staff:assignments:write'), asyncRoute(async (req, res) => {
  const staffMember = await db.staff.findById(req.tenantId, req.params.id);
  if (!staffMember) throw notFound('Staff member not found');
  const clean = sanitizeAssignmentPayload(req.body);
  const assignment = await db.staffAssignments.create({ tenantId: req.tenantId, staffId: req.params.id, ...clean });
  await db.audit.record({ event: 'staff.assignmentCreated', actorId: req.auth.sub, target: assignment.id, tenantId: req.tenantId });
  res.status(201).json({ data: assignment });
}));

staffRouter.put('/:id/assignments/:assignmentId', authenticate, tenantScope, permit('staff:assignments:update'), asyncRoute(async (req, res) => {
  const assignment = await db.staffAssignments.findById(req.tenantId, req.params.assignmentId);
  if (!assignment || assignment.staffId !== req.params.id) throw notFound('Assignment not found');
  const clean = sanitizeAssignmentPayload({ ...assignment, ...req.body });
  const updated = await db.staffAssignments.update(req.tenantId, req.params.assignmentId, clean);
  res.json({ data: updated });
}));

staffRouter.delete('/:id/assignments/:assignmentId', authenticate, tenantScope, permit('staff:assignments:delete'), asyncRoute(async (req, res) => {
  const assignment = await db.staffAssignments.findById(req.tenantId, req.params.assignmentId);
  if (!assignment || assignment.staffId !== req.params.id) throw notFound('Assignment not found');
  await db.staffAssignments.remove(req.tenantId, req.params.assignmentId);
  await db.audit.record({ event: 'staff.assignmentRemoved', actorId: req.auth.sub, target: req.params.assignmentId, tenantId: req.tenantId });
  res.status(204).send();
}));
