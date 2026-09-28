import { Router } from 'express';
import multer from 'multer';
import { authenticate, tenantScope, permit, validDate } from '../../core/middleware.js';
import { asyncRoute, badRequest, notFound, conflict } from '../../core/errors.js';
import { parseCsv, toCsv } from '../../core/csv.js';
import { db } from '../../db/index.js';
import { computePercentage } from '../attendance/service.js';
import {
  todayStr, gradeForPercentage, allClassSections, assignedTeacherFor, classTeacherFor,
  structureWithStatus, isEntryOpen, datesheetRows,
  historicalStats, gradeWideMean, generateReportCardPdf, storeReportCardPdf,
  applyMarksEntry, computeResults, generateDatesheetPdf, studentExamSummary,
} from './service.js';

const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

// Examinations (designs/Teacher feature UI mockup/Examinations.dc.html, 9
// screens). See db/schema.sql's Examinations header and the project plan
// doc (edusphere-examinations-module-plan-2026-09-20.md) for the four
// binding decisions this module builds against -- most visibly: the
// Datesheet below reads/writes the SAME exam_sessions table Timetable's
// own Exam timetable screen already uses, not a parallel one. Permissions
// here use the new-format exams:<page>:<action> catalog
// (core/permissionsV2.js) -- see that file's FEATURE_CATALOG entry for
// the full page/action breakdown, including why 'datesheet-publish',
// 'moderation' and 'publish' stay separately grantable from ordinary
// create/update (mirroring the old exams.publish key's own distinct
// role).
export const examsRouter = Router();

const EXAM_TYPES = new Set(['Class test', 'Mid-term', 'Term final', 'Practical', 'Mock']);
const ENTRY_ROLE_POLICIES = new Set(['assigned_teacher', 'assigned_or_class_teacher', 'exam_officer']);
const ACTIVE_STAGES = new Set(['datesheet_draft', 'marking']);

async function requireCycle(tenantId, cycleId) {
  const cycle = await db.examCycles.findById(tenantId, cycleId);
  if (!cycle) throw notFound('Exam cycle not found');
  return cycle;
}

// --- Overview (screen 1) ---

examsRouter.get('/overview', authenticate, tenantScope, permit('exams:overview:read'), asyncRoute(async (req, res) => {
  const cycles = await db.examCycles.list(req.tenantId);
  const activeCycles = cycles.filter((c) => ACTIVE_STAGES.has(c.stage));

  let marksheetsTotal = 0, marksheetsSubmittedOrLater = 0, awaitingModeration = 0, papersWritten = 0, papersTotal = 0, reportCardsGenerated = 0;
  const blockers = { unsubmitted: 0, moderation: 0, returned: 0, commentsMissing: 0, structureIncomplete: 0 };

  for (const cycle of activeCycles) {
    // This cycle's real active roster -- used below both to find missing
    // comments against the actual class list (not just whichever rows
    // happen to have been saved) and to count generated report cards.
    const cycleStudents = (await Promise.all(
      cycle.classNames.map((cn) => db.students.list(req.tenantId, { className: cn, status: 'active' })),
    )).flat();

    const structures = await db.examStructure.list(req.tenantId, { cycleId: cycle.id });
    for (const s of structures) {
      const withStatus = await structureWithStatus(req.tenantId, s);
      if (!withStatus.entryOpen) blockers.structureIncomplete += 1;
    }
    const sessions = (await db.examSessions.list(req.tenantId, {})).filter((e) => e.cycleId === cycle.id);
    papersTotal += structures.length;
    papersWritten += sessions.filter((e) => e.examDate && e.examDate <= todayStr()).length;

    const sheets = await db.examMarksheets.list(req.tenantId, { cycleId: cycle.id });
    marksheetsTotal += sheets.length;
    marksheetsSubmittedOrLater += sheets.filter((m) => m.status !== 'draft').length;
    awaitingModeration += sheets.filter((m) => m.status === 'submitted').length;
    blockers.moderation += sheets.filter((m) => m.status === 'submitted').length;
    blockers.returned += sheets.filter((m) => m.status === 'returned').length;
    blockers.unsubmitted += sheets.filter((m) => m.status === 'draft').length;

    // A student with no comment row at all is just as "missing" as one
    // whose saved comment is blank -- checked against the real roster,
    // not only against rows that happen to already exist.
    const comments = await db.examReportComments.list(req.tenantId, { cycleId: cycle.id });
    const missing = cycleStudents.filter((s) => !comments.find((c) => c.studentId === s.id)?.comment?.trim()).length;
    blockers.commentsMissing += missing;

    // Report card documents are stored per-student (entityId: studentId),
    // matching the generic storage/documents pattern used everywhere else
    // in this codebase, so there is no direct cycle->document lookup.
    // Counting per active cycle's own roster is a close, honest
    // approximation rather than an exact one -- it can double count a
    // student's card if two cycles are active at once and both generated
    // one for them, an edge case rare enough not to warrant a schema
    // change to store cycleId on every document row.
    for (const student of cycleStudents) {
      reportCardsGenerated += (await db.documents.listForEntity(req.tenantId, 'examReportCard', student.id)).length;
    }
  }

  res.json({
    data: {
      metrics: {
        marksheetsSubmitted: marksheetsSubmittedOrLater, marksheetsTotal,
        awaitingModeration, papersWritten, papersTotal, reportCardsGenerated,
      },
      cycles: cycles.map((c) => ({ ...c, isActive: ACTIVE_STAGES.has(c.stage) })),
      blockers,
    },
  });
}));

// --- Cycles (screen 2) ---

examsRouter.get('/cycles', authenticate, tenantScope, permit('exams:cycles:read'), asyncRoute(async (req, res) => {
  const { stage } = req.query;
  const cycles = await db.examCycles.list(req.tenantId);
  res.json({ data: stage ? cycles.filter((c) => c.stage === stage) : cycles });
}));

examsRouter.get('/cycles/:id', authenticate, tenantScope, permit('exams:cycles:read'), asyncRoute(async (req, res) => {
  res.json({ data: await requireCycle(req.tenantId, req.params.id) });
}));

function validateCyclePayload(body) {
  const { name, academicTerm = '', examType, windowOpens, windowCloses, weightInTermMark = 0, classNames, marksEntryCloses = null, entryRolePolicy = 'assigned_teacher' } = body;
  if (!name || typeof name !== 'string' || !name.trim()) throw badRequest('name is required');
  if (!EXAM_TYPES.has(examType)) throw badRequest(`examType must be one of: ${[...EXAM_TYPES].join(', ')}`);
  if (!validDate(windowOpens) || !validDate(windowCloses) || windowOpens > windowCloses) throw badRequest('windowOpens and windowCloses must be valid dates, with windowOpens on or before windowCloses');
  if (!Array.isArray(classNames) || !classNames.length || !classNames.every((c) => typeof c === 'string' && c.trim())) throw badRequest('classNames must be a non-empty array of class names');
  if (!ENTRY_ROLE_POLICIES.has(entryRolePolicy)) throw badRequest(`entryRolePolicy must be one of: ${[...ENTRY_ROLE_POLICIES].join(', ')}`);
  const weight = Number(weightInTermMark);
  if (Number.isNaN(weight) || weight < 0 || weight > 100) throw badRequest('weightInTermMark must be a number between 0 and 100');
  return { name: name.trim(), academicTerm: academicTerm.trim(), examType, windowOpens, windowCloses, weightInTermMark: weight, classNames, marksEntryCloses, entryRolePolicy };
}

examsRouter.post('/cycles', authenticate, tenantScope, permit('exams:cycles:write'), asyncRoute(async (req, res) => {
  const payload = validateCyclePayload(req.body || {});
  const cycle = await db.examCycles.create({ tenantId: req.tenantId, ...payload, stage: 'planned', createdBy: req.auth.sub });
  await db.audit.record({ event: 'exams.cycleCreated', actorId: req.auth.sub, target: cycle.id, tenantId: req.tenantId, summary: { name: cycle.name } });
  await db.examAuditLog.record({ event: 'Cycle created', actorId: req.auth.sub, target: cycle.id, tenantId: req.tenantId, cycleId: cycle.id, detail: `${cycle.name} created` });
  res.status(201).json({ data: cycle });
}));

examsRouter.put('/cycles/:id', authenticate, tenantScope, permit('exams:cycles:update'), asyncRoute(async (req, res) => {
  await requireCycle(req.tenantId, req.params.id);
  const payload = validateCyclePayload(req.body || {});
  const cycle = await db.examCycles.update(req.tenantId, req.params.id, { ...payload, updatedAt: new Date().toISOString() });
  await db.audit.record({ event: 'exams.cycleUpdated', actorId: req.auth.sub, target: cycle.id, tenantId: req.tenantId });
  res.json({ data: cycle });
}));

// "Copy from a previous cycle" (screen 2) -- carries over paper structure
// (max/pass/weight + components) only, never the datesheet or marks.
examsRouter.post('/cycles/:id/copy-structure', authenticate, tenantScope, permit('exams:cycles:write'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const { fromCycleId } = req.body || {};
  const source = await requireCycle(req.tenantId, fromCycleId);
  const sourceStructures = await db.examStructure.list(req.tenantId, { cycleId: source.id });
  const created = [];
  for (const s of sourceStructures) {
    if (!cycle.classNames.includes(s.className)) continue;
    const structure = await db.examStructure.create({
      tenantId: req.tenantId, cycleId: cycle.id, className: s.className, subjectName: s.subjectName,
      maxMarks: s.maxMarks, passMarks: s.passMarks, weight: s.weight,
    });
    const components = await db.examStructureComponents.list(req.tenantId, { structureId: s.id });
    for (const c of components) {
      await db.examStructureComponents.create({ tenantId: req.tenantId, structureId: structure.id, name: c.name, maxMarks: c.maxMarks, passMarks: c.passMarks, orderIndex: c.orderIndex });
    }
    created.push(structure.id);
  }
  await db.audit.record({ event: 'exams.structureCopied', actorId: req.auth.sub, target: cycle.id, tenantId: req.tenantId, summary: { fromCycleId, count: created.length } });
  res.status(201).json({ data: { copied: created.length } });
}));

// --- Datesheet (screen 3) -- reads/writes exam_sessions directly ---

examsRouter.get('/cycles/:id/datesheet', authenticate, tenantScope, permit('exams:datesheet:read'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const rows = await datesheetRows(req.tenantId, cycle.id, req.query.className);
  res.json({ data: rows });
}));

// "Export PDF" (screen 3) -- a real PDF of the same rows the screen just
// showed (Set/Clash/Unscheduled statuses included), via pdfkit like the
// report cards below.
examsRouter.get('/cycles/:id/datesheet/export', authenticate, tenantScope, permit('exams:datesheet:read'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const rows = await datesheetRows(req.tenantId, cycle.id, req.query.className);
  const school = await db.schools.findById(req.tenantId);
  const buffer = await generateDatesheetPdf({ tenant: school, cycle, rows });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="datesheet-${cycle.name.replace(/\s+/g, '-')}.pdf"`);
  res.send(buffer);
}));

examsRouter.post('/cycles/:id/datesheet', authenticate, tenantScope, permit('exams:datesheet:write'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const { className, examDate, session, subject, venue = '', seats = 0, invigilatorStaffId = null, periodSlotId = null, durationMinutes = null, sectionsIncluded = [] } = req.body || {};
  if (!className || !cycle.classNames.includes(className)) throw badRequest('className must be one of this cycle\'s classes');
  if (!validDate(examDate)) throw badRequest('examDate must be a valid date');
  if (!['AM', 'PM'].includes(session)) throw badRequest('session must be AM or PM');
  if (!subject || typeof subject !== 'string' || !subject.trim()) throw badRequest('subject is required');
  const paper = await db.examSessions.create({
    tenantId: req.tenantId, cycleId: cycle.id, className, examDate, session, subject: subject.trim(),
    venue: (venue || '').trim(), seats: Number(seats) || 0, invigilatorStaffId: invigilatorStaffId || null,
    termLabel: cycle.name, periodSlotId, durationMinutes: durationMinutes != null ? Number(durationMinutes) : null, sectionsIncluded,
  });
  if (cycle.stage === 'planned') await db.examCycles.update(req.tenantId, cycle.id, { stage: 'datesheet_draft', updatedAt: new Date().toISOString() });
  await db.audit.record({ event: 'exams.paperAdded', actorId: req.auth.sub, target: paper.id, tenantId: req.tenantId, summary: { subject: paper.subject, className } });
  res.status(201).json({ data: paper });
}));

examsRouter.put('/datesheet/:examId', authenticate, tenantScope, permit('exams:datesheet:update'), asyncRoute(async (req, res) => {
  const existing = await db.examSessions.findById(req.tenantId, req.params.examId);
  if (!existing) throw notFound('Paper not found');
  const { examDate, session, subject, venue, seats, invigilatorStaffId, periodSlotId, durationMinutes, sectionsIncluded } = req.body || {};
  const patch = {};
  if (examDate !== undefined) { if (!validDate(examDate)) throw badRequest('examDate must be a valid date'); patch.examDate = examDate; }
  if (session !== undefined) { if (!['AM', 'PM'].includes(session)) throw badRequest('session must be AM or PM'); patch.session = session; }
  if (subject !== undefined) patch.subject = String(subject).trim();
  if (venue !== undefined) patch.venue = String(venue).trim();
  if (seats !== undefined) patch.seats = Number(seats) || 0;
  if (invigilatorStaffId !== undefined) patch.invigilatorStaffId = invigilatorStaffId || null;
  if (periodSlotId !== undefined) patch.periodSlotId = periodSlotId || null;
  if (durationMinutes !== undefined) patch.durationMinutes = durationMinutes != null ? Number(durationMinutes) : null;
  if (sectionsIncluded !== undefined) patch.sectionsIncluded = sectionsIncluded;
  const paper = await db.examSessions.update(req.tenantId, req.params.examId, patch);
  await db.audit.record({ event: 'exams.paperUpdated', actorId: req.auth.sub, target: paper.id, tenantId: req.tenantId });
  res.json({ data: paper });
}));

examsRouter.delete('/datesheet/:examId', authenticate, tenantScope, permit('exams:datesheet:delete'), asyncRoute(async (req, res) => {
  const existing = await db.examSessions.findById(req.tenantId, req.params.examId);
  if (!existing) throw notFound('Paper not found');
  await db.examSessions.remove(req.tenantId, req.params.examId);
  await db.audit.record({ event: 'exams.paperRemoved', actorId: req.auth.sub, target: req.params.examId, tenantId: req.tenantId });
  res.status(204).end();
}));

// Publishing is allowed with open conflicts -- the mockup is explicit that
// a warning strip persists for parents rather than hard-blocking. This
// just opens marks entry (stage -> marking); it never refuses on Clash
// rows.
examsRouter.post('/cycles/:id/datesheet/publish', authenticate, tenantScope, permit('exams:datesheet-publish:update'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const updated = await db.examCycles.update(req.tenantId, cycle.id, { stage: 'marking', updatedAt: new Date().toISOString() });
  await db.audit.record({ event: 'exams.datesheetPublished', actorId: req.auth.sub, target: cycle.id, tenantId: req.tenantId });
  await db.examAuditLog.record({ event: 'Datesheet published', actorId: req.auth.sub, target: cycle.id, tenantId: req.tenantId, cycleId: cycle.id, detail: 'Marks entry is now open' });
  res.json({ data: updated });
}));

// --- Paper & marks structure (screen 4) ---

examsRouter.get('/cycles/:id/structure', authenticate, tenantScope, permit('exams:structure:read'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const { className } = req.query;
  const rows = (await db.examStructure.list(req.tenantId, { cycleId: cycle.id })).filter((s) => !className || s.className === className);
  const enriched = await Promise.all(rows.map((s) => structureWithStatus(req.tenantId, s)));
  res.json({ data: enriched });
}));

examsRouter.post('/cycles/:id/structure', authenticate, tenantScope, permit('exams:structure:write'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const { className, subjectName, maxMarks, passMarks, weight = 1, components = [] } = req.body || {};
  if (!className || !cycle.classNames.includes(className)) throw badRequest('className must be one of this cycle\'s classes');
  if (!subjectName || typeof subjectName !== 'string' || !subjectName.trim()) throw badRequest('subjectName is required');
  const existing = await db.examStructure.findOne(req.tenantId, { cycleId: cycle.id, className, subjectName: subjectName.trim() });
  if (existing) throw conflict('This subject already has a structure for this class in this cycle -- edit it instead');
  const max = Number(maxMarks), pass = Number(passMarks);
  if (Number.isNaN(max) || max <= 0) throw badRequest('maxMarks must be a positive number');
  if (Number.isNaN(pass) || pass < 0 || pass > max) throw badRequest('passMarks must be between 0 and maxMarks');
  const structure = await db.examStructure.create({ tenantId: req.tenantId, cycleId: cycle.id, className, subjectName: subjectName.trim(), maxMarks: max, passMarks: pass, weight: Number(weight) || 1 });
  for (const [i, c] of components.entries()) {
    if (!c?.name) continue;
    await db.examStructureComponents.create({ tenantId: req.tenantId, structureId: structure.id, name: String(c.name).trim(), maxMarks: Number(c.maxMarks) || 0, passMarks: Number(c.passMarks) || 0, orderIndex: i });
  }
  await db.audit.record({ event: 'exams.structureCreated', actorId: req.auth.sub, target: structure.id, tenantId: req.tenantId, summary: { className, subjectName } });
  res.status(201).json({ data: await structureWithStatus(req.tenantId, structure) });
}));

examsRouter.put('/structure/:id', authenticate, tenantScope, permit('exams:structure:update'), asyncRoute(async (req, res) => {
  const structure = await db.examStructure.findById(req.tenantId, req.params.id);
  if (!structure) throw notFound('Structure not found');

  // Changing a max after marks exist invalidates entered marks and reopens
  // the sheet to the teacher -- the mockup's own warning, kept real: any
  // marksheet using this structure's subject is reset to draft and its
  // marks' totals/grades are cleared (component values themselves are
  // kept so nothing typed is silently lost, only recomputed).
  const { maxMarks, passMarks, weight, components } = req.body || {};
  const maxChanged = maxMarks !== undefined && Number(maxMarks) !== Number(structure.maxMarks);
  const patch = {};
  if (maxMarks !== undefined) patch.maxMarks = Number(maxMarks);
  if (passMarks !== undefined) patch.passMarks = Number(passMarks);
  if (weight !== undefined) patch.weight = Number(weight);
  patch.updatedAt = new Date().toISOString();
  const updated = await db.examStructure.update(req.tenantId, structure.id, patch);

  if (Array.isArray(components)) {
    const existingComponents = await db.examStructureComponents.list(req.tenantId, { structureId: structure.id });
    for (const old of existingComponents) await db.examStructureComponents.remove(req.tenantId, old.id);
    for (const [i, c] of components.entries()) {
      if (!c?.name) continue;
      await db.examStructureComponents.create({ tenantId: req.tenantId, structureId: structure.id, name: String(c.name).trim(), maxMarks: Number(c.maxMarks) || 0, passMarks: Number(c.passMarks) || 0, orderIndex: i });
    }
  }

  if (maxChanged) {
    const affected = (await db.examMarksheets.list(req.tenantId, { cycleId: structure.cycleId }))
      .filter((m) => m.className === structure.className && m.subjectName === structure.subjectName && m.status !== 'draft');
    for (const sheet of affected) {
      await db.examMarksheets.update(req.tenantId, sheet.id, { status: 'draft', mean: null, passRatePct: null, flags: [], updatedAt: new Date().toISOString() });
      const marks = await db.examMarks.list(req.tenantId, { marksheetId: sheet.id });
      for (const m of marks) await db.examMarks.update(req.tenantId, m.id, { total: null, grade: null, flag: null, updatedAt: new Date().toISOString() });
    }
    await db.examAuditLog.record({ event: 'Structure edited', actorId: req.auth.sub, cycleId: structure.cycleId, tenantId: req.tenantId, target: structure.id, detail: `${structure.subjectName} maximum changed -- ${affected.length} marksheet(s) reopened for entry` });
  }

  await db.audit.record({ event: 'exams.structureUpdated', actorId: req.auth.sub, target: structure.id, tenantId: req.tenantId });
  res.json({ data: await structureWithStatus(req.tenantId, structure.id ? { ...structure, ...patch } : structure) });
}));

examsRouter.delete('/structure/:id', authenticate, tenantScope, permit('exams:structure:delete'), asyncRoute(async (req, res) => {
  const structure = await db.examStructure.findById(req.tenantId, req.params.id);
  if (!structure) throw notFound('Structure not found');
  const components = await db.examStructureComponents.list(req.tenantId, { structureId: structure.id });
  for (const c of components) await db.examStructureComponents.remove(req.tenantId, c.id);
  await db.examStructure.remove(req.tenantId, structure.id);
  await db.audit.record({ event: 'exams.structureDeleted', actorId: req.auth.sub, target: req.params.id, tenantId: req.tenantId });
  res.status(204).end();
}));

// --- Marks entry (screen 5) ---

examsRouter.get('/cycles/:id/marks', authenticate, tenantScope, permit('exams:marks-entry:read'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const { className, section, subjectName } = req.query;
  if (![className, section, subjectName].every(Boolean)) throw badRequest('className, section and subjectName are required');

  const structure = await db.examStructure.findOne(req.tenantId, { cycleId: cycle.id, className, subjectName });
  if (!structure) throw notFound('No paper structure defined yet for this class/subject in this cycle');
  const structureFull = await structureWithStatus(req.tenantId, structure);

  let marksheet = await db.examMarksheets.findOne(req.tenantId, { cycleId: cycle.id, className, section, subjectName });
  if (!marksheet) {
    const teacher = await assignedTeacherFor(req.tenantId, className, section, subjectName);
    marksheet = await db.examMarksheets.create({ tenantId: req.tenantId, cycleId: cycle.id, className, section, subjectName, teacherStaffId: teacher?.staffId ?? null, status: 'draft' });
  }

  const students = await db.students.findByClassSection(req.tenantId, className, section);
  const existingMarks = await db.examMarks.list(req.tenantId, { marksheetId: marksheet.id });
  const hist = await historicalStats(req.tenantId, className, subjectName, cycle.id);

  const rows = await Promise.all(students.map(async (student, index) => {
    const mark = existingMarks.find((m) => m.studentId === student.id);
    return {
      studentId: student.id, admissionNumber: student.admissionNumber, name: `${student.firstName} ${student.lastName}`, rollNumber: index + 1,
      componentMarks: mark?.componentMarks ?? {}, total: mark?.total ?? null, grade: mark?.grade ?? null, flag: mark?.flag ?? null, remark: mark?.remark ?? '',
    };
  }));

  const teacher = marksheet.teacherStaffId ? await db.staff.findById(req.tenantId, marksheet.teacherStaffId) : null;
  res.json({
    data: {
      marksheet, structure: structureFull, rows,
      teacherLabel: teacher ? `${teacher.firstName} ${teacher.lastName}` : 'Unassigned',
      historicalMean: hist?.mean ?? null, historicalStdDev: hist?.stdDev ?? null,
      enteredCount: rows.filter((r) => r.total != null).length,
      absentCount: rows.filter((r) => r.flag === 'absent').length,
      blankCount: rows.filter((r) => r.flag === 'not_entered').length,
    },
  });
}));

examsRouter.put('/cycles/:id/marks', authenticate, tenantScope, permit('exams:marks-entry:update'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const { className, section, subjectName, records } = req.body || {};
  if (![className, section, subjectName].every(Boolean) || !Array.isArray(records)) throw badRequest('className, section, subjectName and a records array are required');

  const structure = await db.examStructure.findOne(req.tenantId, { cycleId: cycle.id, className, subjectName });
  if (!structure) throw notFound('No paper structure defined yet for this class/subject');
  const structureFull = await structureWithStatus(req.tenantId, structure);
  if (!structureFull.entryOpen) throw badRequest(`Marks entry is not open for ${subjectName} yet -- its components (${structureFull.componentsTotal}) must sum to the subject maximum (${structure.maxMarks}) first`);

  const marksheet = await db.examMarksheets.findOne(req.tenantId, { cycleId: cycle.id, className, section, subjectName });
  if (!marksheet) throw notFound('Marksheet not found -- open the marks entry screen first');
  if (!['draft', 'returned'].includes(marksheet.status)) throw conflict(`This sheet is ${marksheet.status} and can no longer be edited directly`);

  const roster = await db.students.findByClassSection(req.tenantId, className, section);
  const result = await applyMarksEntry(req.tenantId, { structure, structureFull, marksheet, roster, records });
  await db.audit.record({ event: 'exams.marksSaved', actorId: req.auth.sub, target: marksheet.id, tenantId: req.tenantId, summary: { records: records.length } });
  res.json({ data: result });
}));

// CSV import (screen 5's "Import CSV" action) -- columns are
// admissionNumber, one column per this subject's real components (named
// exactly as configured in Structure), plus absent (yes/no) and remark.
// Reuses the exact same validation/flagging path as the JSON PUT above via
// applyMarksEntry, so a CSV upload can never behave differently from
// typing the same values into the grid by hand.
examsRouter.post('/cycles/:id/marks/import', authenticate, tenantScope, permit('exams:marks-entry:update'), upload.single('file'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const { className, section, subjectName } = req.body || {};
  if (![className, section, subjectName].every(Boolean)) throw badRequest('className, section and subjectName are required');
  if (!req.file) throw badRequest('A CSV file is required');

  const structure = await db.examStructure.findOne(req.tenantId, { cycleId: cycle.id, className, subjectName });
  if (!structure) throw notFound('No paper structure defined yet for this class/subject');
  const structureFull = await structureWithStatus(req.tenantId, structure);
  if (!structureFull.entryOpen) throw badRequest(`Marks entry is not open for ${subjectName} yet -- its components (${structureFull.componentsTotal}) must sum to the subject maximum (${structure.maxMarks}) first`);

  const marksheet = await db.examMarksheets.findOne(req.tenantId, { cycleId: cycle.id, className, section, subjectName });
  if (!marksheet) throw notFound('Marksheet not found -- open the marks entry screen first');
  if (!['draft', 'returned'].includes(marksheet.status)) throw conflict(`This sheet is ${marksheet.status} and can no longer be edited directly`);

  const roster = await db.students.findByClassSection(req.tenantId, className, section);
  const byAdmission = new Map(roster.map((s) => [s.admissionNumber, s]));
  const parsedRows = parseCsv(req.file.buffer.toString('utf-8'));
  const records = [];
  const errors = [];
  parsedRows.forEach((row, i) => {
    const student = byAdmission.get((row.admissionNumber || '').trim());
    if (!student) { errors.push(`Row ${i + 2}: admission number "${row.admissionNumber || ''}" is not on this class/section's active roster`); return; }
    const absent = String(row.absent || '').trim().toLowerCase() === 'yes';
    const componentMarks = {};
    for (const c of structureFull.components) {
      const raw = row[c.name];
      if (raw !== undefined && raw !== '') componentMarks[c.name] = Number(raw);
    }
    records.push({ studentId: student.id, componentMarks, absent, remark: row.remark || '' });
  });
  if (errors.length) throw badRequest(`CSV import failed: ${errors.join('; ')}`);

  const result = await applyMarksEntry(req.tenantId, { structure, structureFull, marksheet, roster, records });
  await db.audit.record({ event: 'exams.marksImported', actorId: req.auth.sub, target: marksheet.id, tenantId: req.tenantId, summary: { rows: records.length } });
  res.status(201).json({ data: result });
}));

examsRouter.post('/cycles/:id/marks/submit', authenticate, tenantScope, permit('exams:marks-entry:update'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const { className, section, subjectName } = req.body || {};
  const marksheet = await db.examMarksheets.findOne(req.tenantId, { cycleId: cycle.id, className, section, subjectName });
  if (!marksheet) throw notFound('Marksheet not found');
  if (!['draft', 'returned'].includes(marksheet.status)) throw conflict(`This sheet is already ${marksheet.status}`);
  const marks = await db.examMarks.list(req.tenantId, { marksheetId: marksheet.id });
  if (!marks.length) throw badRequest('Nothing has been entered on this sheet yet');
  const updated = await db.examMarksheets.update(req.tenantId, marksheet.id, { status: 'submitted', submittedBy: req.auth.sub, submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await db.audit.record({ event: 'exams.sheetSubmitted', actorId: req.auth.sub, target: marksheet.id, tenantId: req.tenantId, summary: { className, section, subjectName } });
  await db.examAuditLog.record({ event: 'Sheet submitted', actorId: req.auth.sub, cycleId: cycle.id, tenantId: req.tenantId, target: marksheet.id, detail: `${className}·${section} ${subjectName} submitted` });
  res.json({ data: updated });
}));

// --- Moderation & approval (screen 6) ---

examsRouter.get('/cycles/:id/moderation', authenticate, tenantScope, permit('exams:moderation:read'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const { status } = req.query;
  const sheets = (await db.examMarksheets.list(req.tenantId, { cycleId: cycle.id })).filter((m) => m.status !== 'draft' && (!status || m.status === status));
  const enriched = await Promise.all(sheets.map(async (sheet) => {
    const teacher = sheet.teacherStaffId ? await db.staff.findById(req.tenantId, sheet.teacherStaffId) : null;
    return { ...sheet, teacherName: teacher ? `${teacher.firstName} ${teacher.lastName}` : 'Unassigned' };
  }));
  res.json({ data: enriched });
}));

examsRouter.post('/marksheets/:id/approve', authenticate, tenantScope, permit('exams:moderation:update'), asyncRoute(async (req, res) => {
  const sheet = await db.examMarksheets.findById(req.tenantId, req.params.id);
  if (!sheet) throw notFound('Marksheet not found');
  if (sheet.status !== 'submitted') throw conflict('Only a submitted sheet can be approved');
  const updated = await db.examMarksheets.update(req.tenantId, sheet.id, { status: 'approved', decidedBy: req.auth.sub, decidedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await db.audit.record({ event: 'exams.sheetApproved', actorId: req.auth.sub, target: sheet.id, tenantId: req.tenantId });
  await db.examAuditLog.record({ event: 'Sheet approved', actorId: req.auth.sub, cycleId: sheet.cycleId, tenantId: req.tenantId, target: sheet.id, detail: `${sheet.className}·${sheet.section} ${sheet.subjectName} approved` });
  res.json({ data: updated });
}));

examsRouter.post('/marksheets/:id/return', authenticate, tenantScope, permit('exams:moderation:update'), asyncRoute(async (req, res) => {
  const sheet = await db.examMarksheets.findById(req.tenantId, req.params.id);
  if (!sheet) throw notFound('Marksheet not found');
  if (sheet.status !== 'submitted') throw conflict('Only a submitted sheet can be returned');
  const { note } = req.body || {};
  if (!note?.trim()) throw badRequest('A note is required when returning a sheet');
  const updated = await db.examMarksheets.update(req.tenantId, sheet.id, { status: 'returned', decidedBy: req.auth.sub, decidedAt: new Date().toISOString(), reviewerNote: note.trim(), updatedAt: new Date().toISOString() });
  await db.audit.record({ event: 'exams.sheetReturned', actorId: req.auth.sub, target: sheet.id, tenantId: req.tenantId });
  await db.examAuditLog.record({ event: 'Sheet returned', actorId: req.auth.sub, cycleId: sheet.cycleId, tenantId: req.tenantId, target: sheet.id, detail: `${sheet.className}·${sheet.section} ${sheet.subjectName} returned -- ${note.trim()}` });
  res.json({ data: updated });
}));

examsRouter.post('/moderation/bulk-approve', authenticate, tenantScope, permit('exams:moderation:update'), asyncRoute(async (req, res) => {
  const { marksheetIds } = req.body || {};
  if (!Array.isArray(marksheetIds) || !marksheetIds.length) throw badRequest('marksheetIds (non-empty array) is required');
  const approved = [];
  for (const sheetId of marksheetIds) {
    const sheet = await db.examMarksheets.findById(req.tenantId, sheetId);
    if (!sheet || sheet.status !== 'submitted') continue;
    approved.push(await db.examMarksheets.update(req.tenantId, sheet.id, { status: 'approved', decidedBy: req.auth.sub, decidedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    await db.examAuditLog.record({ event: 'Sheet approved', actorId: req.auth.sub, cycleId: sheet.cycleId, tenantId: req.tenantId, target: sheet.id, detail: `${sheet.className}·${sheet.section} ${sheet.subjectName} approved (bulk)` });
  }
  await db.audit.record({ event: 'exams.sheetApproved', actorId: req.auth.sub, target: 'bulk', tenantId: req.tenantId, summary: { count: approved.length } });
  res.status(201).json({ data: approved });
}));

// --- Results & analysis (screen 7) ---

examsRouter.get('/cycles/:id/results', authenticate, tenantScope, permit('exams:results:read'), asyncRoute(async (req, res) => {
  const result = await computeResults(req.tenantId, req.params.id, req.query.className);
  const { cycle, className, ...data } = result;
  res.json({ data });
}));

// "Export CSV" (screen 7) -- the ranked learner table, computed through
// the exact same computeResults() the JSON view above uses, so the
// download can never disagree with what the screen just showed.
examsRouter.get('/cycles/:id/results/export', authenticate, tenantScope, permit('exams:results:read'), asyncRoute(async (req, res) => {
  const result = await computeResults(req.tenantId, req.params.id, req.query.className);
  const csv = toCsv(
    ['rank', 'name', 'section', 'total', 'maxTotal', 'aggregatePct', 'grade', 'failedSubjects'],
    result.learners.map((l) => ({ ...l, failedSubjects: l.failedSubjects.join('; ') })),
  );
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="results-${String(req.query.className || '').replace(/\s+/g, '')}.csv"`);
  res.send(csv);
}));

// --- Report cards (screen 8) ---

examsRouter.get('/cycles/:id/report-comments', authenticate, tenantScope, permit('exams:report-cards:read'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const { className } = req.query;
  const rows = (await db.examReportComments.list(req.tenantId, { cycleId: cycle.id })).filter((c) => !className || c.className === className);
  res.json({ data: rows });
}));

examsRouter.put('/report-comments', authenticate, tenantScope, permit('exams:report-cards:update'), asyncRoute(async (req, res) => {
  const { cycleId, className, section, studentId, comment } = req.body || {};
  if (!cycleId || !className || !studentId) throw badRequest('cycleId, className and studentId are required');
  await requireCycle(req.tenantId, cycleId);
  const teacher = section ? await classTeacherFor(req.tenantId, className, section) : null;
  const row = await db.examReportComments.upsert(req.tenantId, { cycleId, studentId, className, comment: (comment || '').trim(), classTeacherStaffId: teacher?.staffId ?? null });
  await db.audit.record({ event: 'exams.reportCommentSaved', actorId: req.auth.sub, target: studentId, tenantId: req.tenantId });
  res.json({ data: row });
}));

// Real per-learner PDF generation (decision 4) via pdfkit, stored through
// the existing documents/storage adapter -- the batch refuses to run
// while any comment or unapproved sheet blocks it, matching the mockup's
// own stated rule, stated as a concrete reason rather than a bare 423.
examsRouter.post('/cycles/:id/report-cards/:className/generate', authenticate, tenantScope, permit('exams:report-cards:write'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const className = req.params.className;
  const school = await db.schools.findById(req.tenantId);

  const allSheets = (await db.examMarksheets.list(req.tenantId, { cycleId: cycle.id })).filter((m) => m.className === className);
  const unapproved = allSheets.filter((m) => m.status !== 'approved');
  const students = await db.students.list(req.tenantId, { className, status: 'active' });
  const comments = await db.examReportComments.list(req.tenantId, { cycleId: cycle.id });
  const missingComments = students.filter((s) => !comments.find((c) => c.studentId === s.id)?.comment?.trim());

  if (unapproved.length || missingComments.length) {
    const parts = [];
    if (missingComments.length) parts.push(`${missingComments.length} class-teacher comment(s) outstanding`);
    if (unapproved.length) parts.push(`${unapproved.length} marksheet(s) unapproved`);
    throw badRequest(`Blocked: ${parts.join(' and ')}.`);
  }

  const structures = (await db.examStructure.list(req.tenantId, { cycleId: cycle.id })).filter((s) => s.className === className);
  const structureByName = new Map(structures.map((s) => [s.subjectName, s]));
  const generated = [];
  let reportCounter = 1;

  for (const student of students) {
    const rows = [];
    let scoredMax = 0, scoredTotal = 0;
    // Only this learner's OWN section's sheet per subject -- allSheets
    // above spans every section in the class (needed for the "is
    // everything approved yet" check above), but a report card must never
    // show another section's marksheet as one of this student's rows.
    const ownSheets = allSheets.filter((s) => s.section === student.section);
    for (const sheet of ownSheets) {
      const structure = structureByName.get(sheet.subjectName);
      if (!structure) continue;
      const mark = (await db.examMarks.list(req.tenantId, { marksheetId: sheet.id })).find((m) => m.studentId === student.id);
      const gradeMean = await gradeWideMean(req.tenantId, cycle.id, className, sheet.subjectName, sheet.section);
      rows.push({
        subject: sheet.subjectName,
        mark: mark?.total != null ? `${mark.total} / ${structure.maxMarks}` : (mark?.flag === 'absent' ? 'Absent' : 'Pending'),
        grade: mark?.grade || '—', mean: gradeMean != null ? String(gradeMean) : '—', comment: mark?.remark || '',
      });
      if (mark?.total != null) { scoredMax += Number(structure.maxMarks); scoredTotal += Number(mark.total); }
    }
    const aggregatePct = scoredMax ? Number((scoredTotal * 100 / scoredMax).toFixed(1)) : null;
    const history = await db.attendance.findByStudent(req.tenantId, student.id);
    const attendancePct = computePercentage(history);
    const comment = comments.find((c) => c.studentId === student.id);
    const classTeacher = comment?.classTeacherStaffId ? await db.staff.findById(req.tenantId, comment.classTeacherStaffId) : null;

    const buffer = await generateReportCardPdf({
      tenant: school, cycle, student, className, section: student.section, rows,
      aggregatePct, position: null, totalLearners: students.length, attendancePct,
      classTeacherName: classTeacher ? `${classTeacher.firstName} ${classTeacher.lastName}` : null,
      classTeacherComment: comment?.comment || '', reportNo: `R-${className.replace(/\s+/g, '')}-${String(reportCounter).padStart(3, '0')}`,
    });
    reportCounter += 1;
    const document = await storeReportCardPdf(req.tenantId, student.id, buffer, req.auth.sub);
    generated.push({ studentId: student.id, name: `${student.firstName} ${student.lastName}`, documentId: document.id });
  }

  await db.audit.record({ event: 'exams.reportCardsGenerated', actorId: req.auth.sub, target: cycle.id, tenantId: req.tenantId, summary: { className, count: generated.length } });
  await db.examAuditLog.record({ event: 'Report cards generated', actorId: req.auth.sub, cycleId: cycle.id, tenantId: req.tenantId, target: cycle.id, detail: `${generated.length} report card(s) generated for ${className}` });
  res.status(201).json({ data: generated });
}));

// --- Publish, grading scale & audit (screen 9) ---

examsRouter.post('/cycles/:id/publish', authenticate, tenantScope, permit('exams:publish:update'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const approvedCount = (await db.examMarksheets.list(req.tenantId, { cycleId: cycle.id })).filter((m) => m.status === 'approved').length;
  if (!approvedCount) throw badRequest('Nothing is approved yet -- there is nothing to publish');
  const { toggles = {} } = req.body || {};
  const updated = await db.examCycles.update(req.tenantId, cycle.id, { stage: 'published', publishSettings: toggles, updatedAt: new Date().toISOString() });
  await db.audit.record({ event: 'exams.resultsPublished', actorId: req.auth.sub, target: cycle.id, tenantId: req.tenantId, summary: { approvedCount } });
  await db.examAuditLog.record({ event: 'Results published', actorId: req.auth.sub, cycleId: cycle.id, tenantId: req.tenantId, target: cycle.id, detail: `${cycle.name} released to parent portal (${approvedCount} approved marksheets)` });
  res.json({ data: updated });
}));

examsRouter.get('/cycles/:id/audit', authenticate, tenantScope, permit('exams:publish:read'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  res.json({ data: await db.examAuditLog.list(req.tenantId, { cycleId: cycle.id }) });
}));

// A real, read-only render of what a parent will see once published --
// approved subjects only, honestly labelling anything still pending.
examsRouter.get('/cycles/:id/parent-preview/:studentId', authenticate, tenantScope, permit('exams:publish:read'), asyncRoute(async (req, res) => {
  const cycle = await requireCycle(req.tenantId, req.params.id);
  const student = await db.students.findById(req.tenantId, req.params.studentId);
  if (!student) throw notFound('Student not found');
  const sheets = (await db.examMarksheets.list(req.tenantId, { cycleId: cycle.id })).filter((m) => m.className === student.className && m.section === student.section);
  const rows = [];
  for (const sheet of sheets) {
    const visible = sheet.status === 'approved';
    const mark = visible ? (await db.examMarks.list(req.tenantId, { marksheetId: sheet.id })).find((m) => m.studentId === student.id) : null;
    rows.push({ subject: sheet.subjectName, visible, mark: mark?.total ?? null, grade: mark?.grade ?? null, status: visible ? 'Released' : 'Not yet released' });
  }
  res.json({ data: { cycleName: cycle.name, studentName: `${student.firstName} ${student.lastName}`, rows } });
}));

// A single learner's exams across every cycle (Student profile > Exams
// tab) -- mounted on /api/students like GET /api/students/:id/fees.
// Marks appear only for approved (released) marksheets.
export const studentExamsRouter = Router();

studentExamsRouter.get('/:id/exams', authenticate, tenantScope, permit('exams:results:read'), asyncRoute(async (req, res) => {
  const student = await db.students.findById(req.tenantId, req.params.id);
  if (!student) throw notFound('Student not found');
  res.json({ data: await studentExamSummary(req.tenantId, student) });
}));
