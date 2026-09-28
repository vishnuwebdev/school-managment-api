import { Router } from 'express';
import multer from 'multer';
import { authenticate, tenantScope, permit, validDate } from '../../core/middleware.js';
import { asyncRoute, badRequest, conflict, notFound } from '../../core/errors.js';
import { db } from '../../db/index.js';
import { parseCsv, toCsv } from '../../core/csv.js';
import { generateTabularReportPdf } from '../../core/reportPdf.js';
import { storage } from '../storage/localStorageAdapter.js';

// Student Management (designs/Student managment system.png, 12 screens).
// Father/mother/guardian contact info entered here is per-student "who do
// we call" data, not a Parent Management account -- that's the separate,
// still-unbuilt parents.* module (its own sidebar entry/permissions are
// already reserved), kept out of scope on purpose, same call as excluding
// Classes & Sections from the School Setup build.
export const studentsRouter = Router();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

const GENDERS = new Set(['Male', 'Female', 'Other']);
const ADMISSION_TYPES = new Set(['New Admission', 'Transfer', 'Re-admission']);
const CATEGORIES = new Set(['General', 'OBC', 'SC', 'ST', 'EWS', 'Other']);
const REPORT_TYPES = new Set(['list', 'class-strength', 'gender-strength', 'admissions', 'withdrawals', 'transfers', 'details']);

function sanitizeGuardianContact(contact) {
  if (typeof contact !== 'object' || contact === null) return {};
  const clean = {};
  for (const key of ['name', 'phone', 'email', 'address']) {
    if (typeof contact[key] === 'string' && contact[key].trim()) clean[key] = contact[key].trim();
  }
  return clean;
}

function sanitizeGuardians(guardians) {
  if (typeof guardians !== 'object' || guardians === null) return {};
  return {
    father: sanitizeGuardianContact(guardians.father),
    mother: sanitizeGuardianContact(guardians.mother),
    guardian: sanitizeGuardianContact(guardians.guardian),
  };
}

// `partial: true` (used by PUT /:id) only validates/returns fields that
// were actually sent, so a profile tab can save just its own section
// (matching the "one form, one Save Changes button" School Setup pattern)
// without needing to resend the whole student. POST always requires the
// five core fields regardless.
function sanitizeStudentPayload(body, { partial = false } = {}) {
  body = body || {};
  const clean = {};
  const requireString = (key, label) => {
    if (!body[key] || typeof body[key] !== 'string' || !body[key].trim()) throw badRequest(`${label} is required`);
    clean[key] = body[key].trim();
  };

  if (!partial || body.admissionNumber !== undefined) requireString('admissionNumber', 'Admission number');
  if (!partial || body.firstName !== undefined) requireString('firstName', 'First name');
  if (!partial || body.lastName !== undefined) requireString('lastName', 'Last name');
  if (!partial || body.className !== undefined) requireString('className', 'Class');
  if (!partial || body.section !== undefined) requireString('section', 'Section');

  for (const key of ['middleName', 'nationality', 'aadhaarNumber', 'studentEmail', 'academicYear',
    'rollNumber', 'previousSchool', 'previousClass', 'house', 'bloodGroup']) {
    if (typeof body[key] === 'string') clean[key] = body[key].trim();
  }

  if (body.dateOfBirth !== undefined) {
    if (body.dateOfBirth && !validDate(body.dateOfBirth)) throw badRequest('dateOfBirth must be a valid YYYY-MM-DD date');
    clean.dateOfBirth = body.dateOfBirth || null;
  }
  if (body.admissionDate !== undefined) {
    if (body.admissionDate && !validDate(body.admissionDate)) throw badRequest('admissionDate must be a valid YYYY-MM-DD date');
    clean.admissionDate = body.admissionDate || null;
  }
  if (body.gender !== undefined) {
    if (body.gender && !GENDERS.has(body.gender)) throw badRequest(`gender must be one of ${[...GENDERS].join(', ')}`);
    clean.gender = body.gender || null;
  }
  if (body.admissionType !== undefined) {
    const value = body.admissionType || 'New Admission';
    if (!ADMISSION_TYPES.has(value)) throw badRequest(`admissionType must be one of ${[...ADMISSION_TYPES].join(', ')}`);
    clean.admissionType = value;
  }
  if (body.category !== undefined) {
    if (body.category && !CATEGORIES.has(body.category)) throw badRequest(`category must be one of ${[...CATEGORIES].join(', ')}`);
    clean.category = body.category || null;
  }
  if (body.transportRequired !== undefined) clean.transportRequired = Boolean(body.transportRequired);
  if (body.guardians !== undefined) clean.guardians = sanitizeGuardians(body.guardians);

  return clean;
}

function sanitizeWithdrawal(body) {
  const { date, reason, remarks = '' } = body || {};
  if (!validDate(date)) throw badRequest('date must be a valid YYYY-MM-DD date');
  if (!reason || typeof reason !== 'string') throw badRequest('reason is required');
  if (typeof remarks !== 'string') throw badRequest('remarks must be a string');
  return { date, reason: reason.trim(), remarks: remarks.trim() };
}

function sanitizeTransfer(body) {
  const { date, transferTo, reason, remarks = '' } = body || {};
  if (!validDate(date)) throw badRequest('date must be a valid YYYY-MM-DD date');
  if (!transferTo || typeof transferTo !== 'string') throw badRequest('transferTo is required');
  if (!reason || typeof reason !== 'string') throw badRequest('reason is required');
  if (typeof remarks !== 'string') throw badRequest('remarks must be a string');
  return { date, transferTo: transferTo.trim(), reason: reason.trim(), remarks: remarks.trim() };
}

studentsRouter.get('/', authenticate, tenantScope, permit('students:profile:read'), asyncRoute(async (req, res) => {
  const { q = '', className, section, status, academicYear } = req.query;
  const data = await db.students.list(req.tenantId, { query: q, className, section, status, academicYear });
  res.json({ data, meta: { total: data.length, tenantId: req.tenantId } });
}));

// --- Import (ahead of /:id so "import" is never read as a student id) ---

const IMPORT_TEMPLATE_HEADERS = [
  'admissionNumber', 'firstName', 'middleName', 'lastName', 'dateOfBirth', 'gender',
  'className', 'section', 'academicYear', 'admissionDate',
];

studentsRouter.get('/import/template', authenticate, tenantScope, permit('students:import:write'), asyncRoute(async (req, res) => {
  const example = {
    admissionNumber: 'BFIS0100', firstName: 'Ananya', middleName: '', lastName: 'Iyer',
    dateOfBirth: '2016-04-12', gender: 'Female', className: 'Class 3', section: 'B',
    academicYear: '2025-2026', admissionDate: '2026-04-01',
  };
  const csv = toCsv(IMPORT_TEMPLATE_HEADERS, [example]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="student_import_template.csv"');
  res.send(csv);
}));

studentsRouter.post('/import/preview', authenticate, tenantScope, permit('students:import:write'), upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw badRequest('A CSV file is required');
  const records = parseCsv(req.file.buffer.toString('utf-8'));
  const seenInFile = new Set();
  const rows = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const rowNumber = i + 2; // +1 for header row, +1 for 1-indexing
    const admissionNo = (record.admissionNumber || '').trim();
    const name = `${record.firstName || ''} ${record.lastName || ''}`.trim();
    try {
      if (!admissionNo) throw new Error('Admission number missing');
      if (seenInFile.has(admissionNo)) throw new Error('Duplicate admission number in this file');
      if (await db.students.existsByAdmissionNumber(req.tenantId, admissionNo)) throw new Error('Admission number already exists');
      const payload = sanitizeStudentPayload(record);
      if (record.dateOfBirth && !validDate(record.dateOfBirth)) throw new Error('Invalid date of birth');
      seenInFile.add(admissionNo);
      rows.push({ row: rowNumber, admissionNo, name, className: payload.className, section: payload.section, status: 'Valid', message: null, payload });
    } catch (error) {
      rows.push({ row: rowNumber, admissionNo: admissionNo || null, name: name || null, className: record.className || null, section: record.section || null, status: 'Error', message: error.message, payload: null });
    }
  }
  const validCount = rows.filter((r) => r.status === 'Valid').length;
  res.json({ data: { totalRecords: rows.length, validRecords: validCount, invalidRecords: rows.length - validCount, rows } });
}));

studentsRouter.post('/import/commit', authenticate, tenantScope, permit('students:import:write'), asyncRoute(async (req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || rows.length === 0) throw badRequest('rows must be a non-empty array of previewed payloads');
  let created = 0;
  const skipped = [];
  for (const payload of rows) {
    if (!payload?.admissionNumber) { skipped.push({ reason: 'Missing admissionNumber' }); continue; }
    if (await db.students.existsByAdmissionNumber(req.tenantId, payload.admissionNumber)) {
      skipped.push({ admissionNumber: payload.admissionNumber, reason: 'Already exists' });
      continue;
    }
    const clean = sanitizeStudentPayload(payload);
    const student = await db.students.create({ tenantId: req.tenantId, ...clean });
    await db.audit.record({ event: 'student.imported', actorId: req.auth.sub, target: student.id, tenantId: req.tenantId });
    created++;
  }
  res.status(201).json({ data: { created, skipped } });
}));

// --- Reports (CSV downloads; also ahead of /:id) ---

studentsRouter.get('/reports/:type', authenticate, tenantScope, permit('students:reports:read'), asyncRoute(async (req, res) => {
  const { type } = req.params;
  if (!REPORT_TYPES.has(type)) throw notFound(`Unknown report type "${type}"`);
  // 'list' honors the same filters the Student List screen's Export button
  // is applied to, so what's exported matches what was on screen.
  const listFilters = type === 'list'
    ? { className: req.query.className, section: req.query.section, status: req.query.status, academicYear: req.query.academicYear }
    : {};
  const students = await db.students.list(req.tenantId, listFilters);
  let csv;
  let filename;

  if (type === 'list') {
    filename = 'student_list.csv';
    csv = toCsv(
      ['admissionNumber', 'firstName', 'lastName', 'className', 'section', 'status'],
      students.map((s) => ({ admissionNumber: s.admissionNumber, firstName: s.firstName, lastName: s.lastName, className: s.className, section: s.section, status: s.status })),
    );
  } else if (type === 'class-strength') {
    filename = 'class_wise_strength.csv';
    const counts = new Map();
    for (const s of students.filter((s) => s.status === 'active')) {
      const key = `${s.className}|${s.section}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const rows = [...counts.entries()].map(([key, count]) => {
      const [className, section] = key.split('|');
      return { className, section, studentCount: count };
    });
    csv = toCsv(['className', 'section', 'studentCount'], rows);
  } else if (type === 'gender-strength') {
    // Spec item (requirement/rquiremnt phase 1.md #31) that had no report
    // behind it at all before this -- the other five Students reports
    // (list/class-strength/admissions/withdrawals/transfers) were already
    // built; this was the one genuinely missing tile, per
    // edusphere-reports-module-plan-2026-09-22.md.
    filename = 'gender_wise_strength.csv';
    const counts = new Map();
    for (const s of students.filter((s) => s.status === 'active')) {
      const key = `${s.className}|${s.section}|${s.gender || 'Unspecified'}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const rows = [...counts.entries()].map(([key, count]) => {
      const [className, section, gender] = key.split('|');
      return { className, section, gender, studentCount: count };
    });
    rows.sort((a, b) => (a.className === b.className ? (a.section === b.section ? a.gender.localeCompare(b.gender) : a.section.localeCompare(b.section)) : a.className.localeCompare(b.className)));
    csv = toCsv(['className', 'section', 'gender', 'studentCount'], rows);
  } else if (type === 'admissions') {
    filename = 'admission_report.csv';
    const { from, to } = req.query;
    const rows = students.filter((s) => s.admissionDate && (!from || s.admissionDate >= from) && (!to || s.admissionDate <= to));
    csv = toCsv(
      ['admissionNumber', 'firstName', 'lastName', 'className', 'section', 'admissionDate', 'admissionType'],
      rows.map((s) => ({ admissionNumber: s.admissionNumber, firstName: s.firstName, lastName: s.lastName, className: s.className, section: s.section, admissionDate: s.admissionDate, admissionType: s.admissionType })),
    );
  } else if (type === 'withdrawals') {
    filename = 'withdrawal_report.csv';
    const rows = students.filter((s) => s.status === 'withdrawn');
    csv = toCsv(
      ['admissionNumber', 'firstName', 'lastName', 'className', 'section', 'withdrawalDate', 'reason', 'remarks'],
      rows.map((s) => ({ admissionNumber: s.admissionNumber, firstName: s.firstName, lastName: s.lastName, className: s.className, section: s.section, withdrawalDate: s.withdrawal?.date, reason: s.withdrawal?.reason, remarks: s.withdrawal?.remarks })),
    );
  } else if (type === 'transfers') {
    filename = 'transfer_report.csv';
    const rows = students.filter((s) => s.status === 'transferred');
    csv = toCsv(
      ['admissionNumber', 'firstName', 'lastName', 'className', 'section', 'transferDate', 'transferTo', 'reason', 'remarks'],
      rows.map((s) => ({ admissionNumber: s.admissionNumber, firstName: s.firstName, lastName: s.lastName, className: s.className, section: s.section, transferDate: s.transfer?.date, transferTo: s.transfer?.transferTo, reason: s.transfer?.reason, remarks: s.transfer?.remarks })),
    );
  } else {
    filename = 'student_details_report.csv';
    csv = toCsv(
      ['admissionNumber', 'firstName', 'middleName', 'lastName', 'dateOfBirth', 'gender', 'bloodGroup', 'nationality',
        'className', 'section', 'rollNumber', 'academicYear', 'admissionDate', 'admissionType', 'house', 'category',
        'transportRequired', 'fatherName', 'fatherPhone', 'motherName', 'motherPhone', 'status'],
      students.map((s) => ({
        admissionNumber: s.admissionNumber, firstName: s.firstName, middleName: s.middleName, lastName: s.lastName,
        dateOfBirth: s.dateOfBirth, gender: s.gender, bloodGroup: s.bloodGroup, nationality: s.nationality,
        className: s.className, section: s.section, rollNumber: s.rollNumber, academicYear: s.academicYear,
        admissionDate: s.admissionDate, admissionType: s.admissionType, house: s.house, category: s.category,
        transportRequired: s.transportRequired ? 'Yes' : 'No',
        fatherName: s.guardians?.father?.name, fatherPhone: s.guardians?.father?.phone,
        motherName: s.guardians?.mother?.name, motherPhone: s.guardians?.mother?.phone, status: s.status,
      })),
    );
  }

  await db.audit.record({ event: 'student.reportGenerated', actorId: req.auth.sub, target: type, tenantId: req.tenantId });

  if (req.query.format === 'pdf') {
    const school = await db.schools.findById(req.tenantId);
    // The header line's fields are all plain identifiers (admissionNumber,
    // firstName, ...) that never themselves contain a comma, so a plain
    // split is safe here -- toCsv only quotes a field when the *value*
    // needs it, never a header we control ourselves.
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

studentsRouter.get('/:id', authenticate, tenantScope, permit('students:profile:read'), asyncRoute(async (req, res) => {
  const student = await db.students.findById(req.tenantId, req.params.id);
  if (!student) throw notFound('Student not found');
  res.json({ data: student });
}));

studentsRouter.post('/', authenticate, tenantScope, permit('students:profile:write'), asyncRoute(async (req, res) => {
  const clean = sanitizeStudentPayload(req.body);
  if (await db.students.existsByAdmissionNumber(req.tenantId, clean.admissionNumber)) {
    throw conflict('Admission number already exists for this school');
  }
  const student = await db.students.create({ tenantId: req.tenantId, ...clean });
  await db.audit.record({ event: 'student.created', actorId: req.auth.sub, target: student.id, tenantId: req.tenantId });
  res.status(201).json({ data: student });
}));

studentsRouter.put('/:id', authenticate, tenantScope, permit('students:profile:update'), asyncRoute(async (req, res) => {
  const existing = await db.students.findById(req.tenantId, req.params.id);
  if (!existing) throw notFound('Student not found');
  const clean = sanitizeStudentPayload(req.body, { partial: true });
  if (clean.admissionNumber && clean.admissionNumber !== existing.admissionNumber) {
    if (await db.students.existsByAdmissionNumber(req.tenantId, clean.admissionNumber)) throw conflict('Admission number already exists for this school');
  }
  const student = await db.students.update(req.tenantId, req.params.id, clean);
  await db.audit.record({ event: 'student.updated', actorId: req.auth.sub, target: student.id, tenantId: req.tenantId });
  res.json({ data: student });
}));

studentsRouter.patch('/:id/archive', authenticate, tenantScope, permit('students:archive:delete'), asyncRoute(async (req, res) => {
  const student = await db.students.findById(req.tenantId, req.params.id);
  if (!student) throw notFound('Student not found');
  const archived = await db.students.archive(req.tenantId, req.params.id);
  await db.audit.record({ event: 'student.archived', actorId: req.auth.sub, target: student.id, tenantId: req.tenantId });
  res.json({ data: archived });
}));

studentsRouter.patch('/:id/withdraw', authenticate, tenantScope, permit('students:withdraw-transfer:update'), asyncRoute(async (req, res) => {
  const student = await db.students.findById(req.tenantId, req.params.id);
  if (!student) throw notFound('Student not found');
  const withdrawal = sanitizeWithdrawal(req.body);
  const updated = await db.students.withdraw(req.tenantId, req.params.id, withdrawal);
  await db.audit.record({ event: 'student.withdrawn', actorId: req.auth.sub, target: student.id, tenantId: req.tenantId, summary: withdrawal });
  res.json({ data: updated });
}));

studentsRouter.patch('/:id/transfer', authenticate, tenantScope, permit('students:withdraw-transfer:update'), asyncRoute(async (req, res) => {
  const student = await db.students.findById(req.tenantId, req.params.id);
  if (!student) throw notFound('Student not found');
  const transfer = sanitizeTransfer(req.body);
  const updated = await db.students.transfer(req.tenantId, req.params.id, transfer);
  await db.audit.record({ event: 'student.transferred', actorId: req.auth.sub, target: student.id, tenantId: req.tenantId, summary: transfer });
  res.json({ data: updated });
}));

// Per-student calendar summary for Profile > Attendance (designs panel 8) --
// built from the same attendance records the class-wise Attendance module
// already writes (api/src/modules/attendance), just sliced to one student
// and one month rather than one class and one day.
studentsRouter.get('/:id/attendance-summary', authenticate, tenantScope, permit('attendance:learner-record:read'), asyncRoute(async (req, res) => {
  const student = await db.students.findById(req.tenantId, req.params.id);
  if (!student) throw notFound('Student not found');
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const all = await db.attendance.findByStudent(req.tenantId, req.params.id);
  const records = all.filter((a) => a.date.startsWith(month));
  const days = Object.fromEntries(records.map((r) => [r.date, r.status]));
  const counts = { present: 0, absent: 0, leave: 0, late: 0 };
  for (const r of records) if (counts[r.status] !== undefined) counts[r.status]++;
  res.json({ data: { studentId: req.params.id, month, days, counts } });
}));

// --- Documents (dedicated Students-scoped permissions -- RBAC plan doc)
//
// Deliberately its own students:documents:* permission rather than
// reusing the platform-wide documents.view/upload from modules/storage,
// so a role can be scoped to "documents for students only" -- which
// wasn't possible before this migration (the generic route trusts a
// client-supplied entityType/entityId; here entityType is hardcoded to
// 'student' server-side instead). Reuses the same underlying storage
// adapter + db.documents collection as the generic routes, so nothing
// about how a file is actually stored changes.
//
// The Add Student wizard's own document-upload step (add_student_screen)
// deliberately still goes through the generic /api/documents route
// (documents.upload), unchanged -- it's a one-time step inside student
// creation itself, not this profile tab, and requiring
// students:documents:write on top of students:profile:write for that one
// atomic "create a student with their documents" action would be more
// friction than the real access-control need calls for. A disclosed
// scope boundary, not an oversight.
studentsRouter.get('/:id/documents', authenticate, tenantScope, permit('students:documents:read'), asyncRoute(async (req, res) => {
  const student = await db.students.findById(req.tenantId, req.params.id);
  if (!student) throw notFound('Student not found');
  res.json({ data: await db.documents.listForEntity(req.tenantId, 'student', req.params.id) });
}));

studentsRouter.post('/:id/documents', authenticate, tenantScope, permit('students:documents:write'), upload.single('file'), asyncRoute(async (req, res) => {
  const student = await db.students.findById(req.tenantId, req.params.id);
  if (!student) throw notFound('Student not found');
  const { documentType, expiryDate } = req.body || {};
  if (!req.file) throw badRequest('A file is required');
  if (!documentType) throw badRequest('documentType is required');
  const storageKey = await storage.save({
    tenantId: req.tenantId, entityType: 'student', entityId: req.params.id, fileName: req.file.originalname, buffer: req.file.buffer,
  });
  const document = await db.documents.create({
    tenantId: req.tenantId, entityType: 'student', entityId: req.params.id, documentType,
    fileName: req.file.originalname, storageKey, mimeType: req.file.mimetype, sizeBytes: req.file.size, uploadedBy: req.auth.sub,
    expiryDate: expiryDate || null,
  });
  await db.audit.record({ event: 'student.documentUploaded', actorId: req.auth.sub, target: student.id, tenantId: req.tenantId, summary: { documentType } });
  res.status(201).json({ data: document });
}));

studentsRouter.delete('/:id/documents/:documentId', authenticate, tenantScope, permit('students:documents:delete'), asyncRoute(async (req, res) => {
  const document = await db.documents.findById(req.tenantId, req.params.documentId);
  if (!document || document.entityType !== 'student' || document.entityId !== req.params.id) throw notFound('Document not found');
  await storage.remove(document.storageKey);
  await db.documents.remove(req.tenantId, document.id);
  await db.audit.record({ event: 'student.documentRemoved', actorId: req.auth.sub, target: req.params.id, tenantId: req.tenantId, summary: { documentType: document.documentType, fileName: document.fileName } });
  res.status(204).send();
}));
