import { db } from '../../db/index.js';
import { getConfig, cycleDayForDate, resolveVersion } from '../timetable/routes.js';
import { computePercentage } from '../attendance/service.js';
import { storage } from '../storage/localStorageAdapter.js';
import { badRequest, notFound } from '../../core/errors.js';
import PDFDocument from 'pdfkit';

// Examinations (designs/Teacher feature UI mockup/Examinations.dc.html).
// See the project plan doc (edusphere-examinations-module-plan-2026-09-20.md)
// for the four binding decisions this module builds against:
//  1. The Datesheet (screen 3) IS exam_sessions (extended), not a parallel
//     table -- see datesheetRows() below.
//  2. The grading scale (screen 9) IS the `grades` table (extended with
//     `descriptor`), not a new multi-scale model -- see gradeForPercentage().
//  3. Marks entry/moderation are gated by exams:marks-entry:update /
//     exams:moderation:update held by admin-level roles only (see
//     core/permissionsV2.js's exams FEATURE_CATALOG entry for the full
//     new-format permission breakdown). teacherStaffId/classTeacherStaffId
//     fields throughout are informational labels (looked up from
//     staff_assignments/staff.classTeacherOf), never an access check --
//     there is no teacher-login concept anywhere in this codebase.
//  4. Report cards generate real per-learner PDF files this pass (via
//     pdfkit), stored through the existing documents/storage adapter --
//     see generateReportCardPdf() below.

export const todayStr = () => new Date().toISOString().slice(0, 10);

// --- Grading scale (extended `grades` table, decision 2) ---

export async function gradeForPercentage(tenantId, pct) {
  if (pct == null) return null;
  const scale = await db.grades.list(tenantId);
  const match = scale.find((g) => pct >= Number(g.minMarks) && pct <= Number(g.maxMarks));
  return match ? match.grade : null;
}

// --- Class/section registry + staff lookups (real, not hardcoded) ---

export async function allClassSections(tenantId) {
  const levels = await db.classLevels.list(tenantId);
  const sectionLists = await Promise.all(levels.map((l) => db.classSections.list(tenantId, { classLevelId: l.id })));
  return levels.map((level, i) => ({ className: level.name, phase: level.phase, sections: sectionLists[i].map((s) => s.letter) }));
}

// Informational only (decision 3) -- looked up for display, never checked
// as an access boundary. Returns null (not a fabricated name) when no
// assignment row matches, which is a real, common state for a brand-new
// subject/class combination.
export async function assignedTeacherFor(tenantId, className, section, subjectName) {
  const assignments = await db.staffAssignments.listForTenant(tenantId);
  const match = assignments.find((a) => a.className === className && a.section === section && a.subject === subjectName);
  if (!match) return null;
  const staff = await db.staff.findById(tenantId, match.staffId);
  return staff ? { staffId: staff.id, name: `${staff.firstName} ${staff.lastName}` } : null;
}

export async function classTeacherFor(tenantId, className, section) {
  const label = `${className} · ${section}`;
  const allStaff = await db.staff.list(tenantId, {});
  const match = allStaff.find((s) => s.classTeacherOf === label);
  return match ? { staffId: match.id, name: `${match.firstName} ${match.lastName}` } : null;
}

// --- Paper & marks structure (screen 4) ---

// A subject's marks entry only opens once its components' maxes sum to the
// subject's own max -- computed live every time, never stored as a
// boolean, so it can never go stale relative to the components underneath.
export async function structureWithStatus(tenantId, structure) {
  const components = await db.examStructureComponents.list(tenantId, { structureId: structure.id });
  const componentsTotal = components.reduce((sum, c) => sum + Number(c.maxMarks), 0);
  const open = components.length > 0 && Math.abs(componentsTotal - Number(structure.maxMarks)) < 0.01;
  return { ...structure, components: components.sort((a, b) => a.orderIndex - b.orderIndex), componentsTotal, entryOpen: open };
}

export async function isEntryOpen(tenantId, cycleId, className, subjectName) {
  const structure = await db.examStructure.findOne(tenantId, { cycleId, className, subjectName });
  if (!structure) return false;
  const withStatus = await structureWithStatus(tenantId, structure);
  return withStatus.entryOpen;
}

// --- Datesheet (screen 3) -- reads/writes exam_sessions directly (decision 1) ---

export async function datesheetRows(tenantId, cycleId, className) {
  const [sessions, structures] = await Promise.all([
    db.examSessions.list(tenantId, className ? { className } : {}),
    db.examStructure.list(tenantId, { cycleId }),
  ]);
  const cycleSessions = sessions.filter((s) => s.cycleId === cycleId && (!className || s.className === className));
  const config = await getConfig(tenantId);
  const version = await resolveVersion(tenantId, null);
  const entries = version ? await db.timetableEntries.listForVersion(tenantId, version.id) : [];

  const rows = await Promise.all(cycleSessions.map(async (session) => {
    // Double-booked: another paper for the same class on the same date/session.
    const doubleBooked = cycleSessions.some((other) => other.id !== session.id && other.className === session.className && other.examDate === session.examDate && other.session === session.session);
    // Invigilator clash: they're normally teaching at that exact cycle-day/slot per the live timetable.
    let invigilatorClash = false;
    if (session.invigilatorStaffId && session.periodSlotId) {
      const dayIndex = cycleDayForDate(session.examDate, config);
      invigilatorClash = entries.some((e) => e.staffId === session.invigilatorStaffId && e.day === dayIndex && e.slotId === session.periodSlotId);
    }
    let invigilatorName = null;
    if (session.invigilatorStaffId) {
      const staff = await db.staff.findById(tenantId, session.invigilatorStaffId);
      invigilatorName = staff ? `${staff.firstName} ${staff.lastName}` : null;
    }
    return {
      ...session,
      cycleDay: cycleDayForDate(session.examDate, config),
      invigilatorName,
      status: doubleBooked || invigilatorClash ? 'Clash' : 'Set',
    };
  }));

  // Subjects with structure but no scheduled paper yet -- real,
  // "Unscheduled" rows, not silently missing from the screen.
  const scheduledSubjects = new Set(cycleSessions.map((s) => s.subject));
  const unscheduled = structures
    .filter((s) => (!className || s.className === className) && !scheduledSubjects.has(s.subjectName))
    .map((s) => ({
      id: null, tenantId, className: s.className, examDate: null, session: null, subject: s.subjectName,
      cycleDay: null, periodSlotId: null, durationMinutes: null, sectionsIncluded: [],
      invigilatorStaffId: null, invigilatorName: 'Unassigned', status: 'Unscheduled',
    }));

  return [...rows, ...unscheduled].sort((a, b) => (a.examDate || '9999').localeCompare(b.examDate || '9999'));
}

// --- Marksheets & marks (screens 5, 6) ---

export function computeMarksheetStats(marksRows) {
  const scored = marksRows.filter((m) => m.total != null);
  const mean = scored.length ? Number((scored.reduce((s, m) => s + Number(m.total), 0) / scored.length).toFixed(2)) : null;
  const flags = [];
  const outliers = marksRows.filter((m) => m.flag === 'outlier').length;
  const blanks = marksRows.filter((m) => m.flag === 'not_entered').length;
  const absents = marksRows.filter((m) => m.flag === 'absent').length;
  if (outliers) flags.push(`${outliers} outlier${outliers > 1 ? 's' : ''}`);
  if (blanks) flags.push(`${blanks} blank`);
  if (absents) flags.push(`${absents} absent`);
  return { mean, scoredCount: scored.length, flags };
}

export function passRateFor(marksRows, passMarks) {
  const scored = marksRows.filter((m) => m.total != null);
  if (!scored.length) return null;
  const passed = scored.filter((m) => Number(m.total) >= passMarks).length;
  return Number((passed * 100 / scored.length).toFixed(1));
}

// Shared by the JSON marks-entry route (PUT /cycles/:id/marks) and the CSV
// import route (POST /cycles/:id/marks/import) -- both ultimately just
// produce the same `records` shape ({studentId, componentMarks, absent,
// remark}), so the actual validation/flagging/save logic lives here once
// rather than drifting between two copies (exactly the kind of duplication
// that produced this module's own VS-GRADE bug during smoke testing).
export async function applyMarksEntry(tenantId, { structure, structureFull, marksheet, roster, records }) {
  const allowed = new Set(roster.map((s) => s.id));
  const hist = await historicalStats(tenantId, marksheet.className, marksheet.subjectName, marksheet.cycleId);

  for (const record of records) {
    if (!record?.studentId || !allowed.has(record.studentId)) throw badRequest('Every record must reference an active student in this class/section');
    let total = null; let flag = null;
    if (record.absent) {
      flag = 'absent';
    } else {
      const values = structureFull.components.map((c) => {
        const v = record.componentMarks?.[c.name];
        if (v === null || v === undefined || v === '') return null;
        const num = Number(v);
        if (Number.isNaN(num) || num < 0 || num > c.maxMarks) throw badRequest(`${c.name} must be between 0 and ${c.maxMarks} for ${record.studentId}`);
        return num;
      });
      const anyEntered = values.some((v) => v != null);
      if (!anyEntered) {
        flag = 'not_entered';
      } else if (values.every((v) => v != null)) {
        total = Number(values.reduce((a, b) => a + b, 0).toFixed(2));
        if (total < structure.passMarks) flag = 'below_pass';
        if (hist && flag == null) {
          const z = (total - hist.mean) / (hist.stdDev || 1);
          if (Math.abs(z) > 2) flag = 'outlier';
        }
      }
      // partially entered (some but not all components) is left with
      // total: null and no flag -- a real, visible "in progress" row, not
      // silently treated as complete.
    }
    const grade = total != null ? await gradeForPercentage(tenantId, (total / structure.maxMarks) * 100) : null;
    const existingMark = await db.examMarks.findOne(tenantId, { marksheetId: marksheet.id, studentId: record.studentId });
    const patch = { componentMarks: record.absent ? {} : (record.componentMarks || {}), total, grade, flag, remark: record.remark?.trim() || '', updatedAt: new Date().toISOString() };
    if (existingMark) await db.examMarks.update(tenantId, existingMark.id, patch);
    else await db.examMarks.create({ tenantId, marksheetId: marksheet.id, studentId: record.studentId, ...patch });
  }

  const allMarks = await db.examMarks.list(tenantId, { marksheetId: marksheet.id });
  const stats = computeMarksheetStats(allMarks);
  const passRatePct = passRateFor(allMarks, structure.passMarks);
  await db.examMarksheets.update(tenantId, marksheet.id, { mean: stats.mean, passRatePct, flags: stats.flags, updatedAt: new Date().toISOString() });
  return { marksheetId: marksheet.id, saved: records.length, mean: stats.mean, passRatePct };
}

// >2 std-dev vs a genuine multi-year mean for this class+subject. Needs
// real prior YEARS (not just prior cycles within the same year) of
// APPROVED marks to mean anything -- returns null (no claim made, no
// fabricated baseline) whenever fewer than 3 distinct years of approved
// history exist yet, which is the honest, expected state for a fresh
// tenant's first cycles.
export async function historicalStats(tenantId, className, subjectName, excludeCycleId) {
  const cycles = (await db.examCycles.list(tenantId)).filter((c) => c.id !== excludeCycleId);
  const years = new Set(cycles.map((c) => (c.windowOpens || '').slice(0, 4)).filter(Boolean));
  if (years.size < 3) return null;

  const values = [];
  for (const cycle of cycles) {
    const sheets = (await db.examMarksheets.list(tenantId, { cycleId: cycle.id }))
      .filter((m) => m.className === className && m.subjectName === subjectName && m.status === 'approved');
    for (const sheet of sheets) {
      const marks = await db.examMarks.list(tenantId, { marksheetId: sheet.id });
      marks.forEach((m) => { if (m.total != null) values.push(Number(m.total)); });
    }
  }
  if (values.length < 5) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance), sampleSize: values.length };
}

// --- Results & analysis (screen 7) ---
// "VS GRADE" is the SAME cycle's mean for this subject across every OTHER
// section of the same class, not a comparison against a prior cycle (see
// the plan doc's correction note) -- no historical dependency, works from
// the very first cycle a tenant ever runs.
export async function gradeWideMean(tenantId, cycleId, className, subjectName, excludeSection) {
  const sheets = (await db.examMarksheets.list(tenantId, { cycleId }))
    .filter((m) => m.className === className && m.subjectName === subjectName && m.section !== excludeSection && m.status === 'approved');
  if (!sheets.length) return null;
  const values = [];
  for (const sheet of sheets) {
    const marks = await db.examMarks.list(tenantId, { marksheetId: sheet.id });
    marks.forEach((m) => { if (m.total != null) values.push(Number(m.total)); });
  }
  if (!values.length) return null;
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
}

// Shared by GET /cycles/:id/results (screen 7's own JSON) and
// GET /cycles/:id/results/export (its "Export CSV" button) so the two can
// never drift the way two independently-written copies of the same
// aggregation eventually do.
export async function computeResults(tenantId, cycleId, className) {
  const cycle = await db.examCycles.findById(tenantId, cycleId);
  if (!cycle) throw notFound('Exam cycle not found');
  if (!className) throw badRequest('className is required');

  const allSheets = (await db.examMarksheets.list(tenantId, { cycleId })).filter((m) => m.className === className);
  const approvedSheets = allSheets.filter((m) => m.status === 'approved');
  const structures = (await db.examStructure.list(tenantId, { cycleId })).filter((s) => s.className === className);
  const structureByName = new Map(structures.map((s) => [s.subjectName, s]));

  const subjectAnalysis = [];
  for (const sheet of approvedSheets) {
    const marks = await db.examMarks.list(tenantId, { marksheetId: sheet.id });
    const scored = marks.filter((m) => m.total != null);
    if (!scored.length) continue;
    const values = scored.map((m) => Number(m.total));
    const mean = Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
    const structure = structureByName.get(sheet.subjectName);
    const fails = scored.filter((m) => structure && Number(m.total) < structure.passMarks).length;
    // Excludes this sheet's OWN section -- see gradeWideMean's header.
    const gradeMean = await gradeWideMean(tenantId, cycleId, className, sheet.subjectName, sheet.section);
    subjectAnalysis.push({
      subject: sheet.subjectName, section: sheet.section, mean, high: Math.max(...values), low: Math.min(...values), fails,
      gradeWideMean: gradeMean, delta: gradeMean != null ? Number((mean - gradeMean).toFixed(1)) : null,
    });
  }

  // Per-learner aggregate across this learner's OWN section's approved
  // subjects only.
  const students = await db.students.list(tenantId, { className, status: 'active' });
  const learnerRows = [];
  for (const student of students) {
    let scoredMax = 0; let scoredTotal = 0; const failedSubjects = [];
    for (const sheet of approvedSheets.filter((s) => s.section === student.section)) {
      const structure = structureByName.get(sheet.subjectName);
      if (!structure) continue;
      const mark = (await db.examMarks.list(tenantId, { marksheetId: sheet.id })).find((m) => m.studentId === student.id);
      if (!mark || mark.total == null) continue;
      scoredMax += Number(structure.maxMarks);
      scoredTotal += Number(mark.total);
      if (Number(mark.total) < structure.passMarks) failedSubjects.push(sheet.subjectName);
    }
    const aggregatePct = scoredMax ? Number((scoredTotal * 100 / scoredMax).toFixed(1)) : null;
    const grade = aggregatePct != null ? await gradeForPercentage(tenantId, aggregatePct) : null;
    learnerRows.push({ studentId: student.id, name: `${student.firstName} ${student.lastName}`, section: student.section, total: scoredTotal, maxTotal: scoredMax, aggregatePct, grade, failedSubjects });
  }
  learnerRows.sort((a, b) => (b.aggregatePct ?? -1) - (a.aggregatePct ?? -1));
  learnerRows.forEach((r, i) => { r.rank = i + 1; });

  const scoredLearners = learnerRows.filter((r) => r.aggregatePct != null);
  const classMean = scoredLearners.length ? Number((scoredLearners.reduce((a, r) => a + r.aggregatePct, 0) / scoredLearners.length).toFixed(1)) : null;
  const passRate = scoredLearners.length ? Number((scoredLearners.filter((r) => r.failedSubjects.length === 0).length * 100 / scoredLearners.length).toFixed(1)) : null;
  const distinctions = scoredLearners.filter((r) => r.aggregatePct >= 80).length;
  const atRisk = scoredLearners.filter((r) => r.failedSubjects.length >= 2).length;

  const distByGrade = {};
  for (const r of scoredLearners) { if (r.grade) distByGrade[r.grade] = (distByGrade[r.grade] || 0) + 1; }

  const sheetStates = allSheets.map((s) => ({ subject: s.subjectName, section: s.section, state: s.status }));
  const outstanding = allSheets.filter((s) => s.status !== 'approved');

  return {
    cycle, className,
    metrics: { classMean, passRate, distinctions, atRisk },
    distribution: distByGrade,
    subjectAnalysis, learners: learnerRows, sheetStates,
    blockedForReportCards: outstanding.length > 0,
    outstandingCount: outstanding.length,
  };
}

// --- Report cards (screen 8) -- real PDF generation, decision 4 ---

export async function generateReportCardPdf({ tenant, cycle, student, className, section, rows, aggregatePct, position, totalLearners, attendancePct, classTeacherName, classTeacherComment, reportNo }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.fontSize(16).fillColor('#1E2D42').text(tenant?.name || 'School', { continued: false });
  doc.fontSize(10).fillColor('#6366F1').text(`${cycle.name.toUpperCase()} REPORT`);
  doc.moveDown(0.5);
  doc.fontSize(9).fillColor('#64748B').text(`Issued ${todayStr()} · Report no. ${reportNo}`, { align: 'right' });
  doc.moveDown(1);

  doc.fontSize(10).fillColor('#13213B');
  doc.text(`Learner: ${student.firstName} ${student.lastName}`);
  doc.text(`Admission no.: ${student.admissionNumber}`);
  doc.text(`Class: ${className} · ${section}`);
  doc.text(`Class teacher: ${classTeacherName || 'Unassigned'}`);
  doc.moveDown(1);

  doc.fontSize(9).fillColor('#64748B');
  doc.text('SUBJECT', 40, doc.y, { continued: true, width: 160 });
  doc.text('MARK', 200, doc.y, { continued: true, width: 70 });
  doc.text('GRADE', 270, doc.y, { continued: true, width: 60 });
  doc.text('CLASS MEAN', 330, doc.y, { continued: true, width: 80 });
  doc.text('COMMENT', 410, doc.y, { width: 145 });
  doc.moveDown(0.3);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).strokeColor('#E4EBF5').stroke();
  doc.moveDown(0.3);

  for (const r of rows) {
    const y = doc.y;
    doc.fontSize(9).fillColor('#13213B');
    doc.text(r.subject, 40, y, { width: 160 });
    doc.text(r.mark, 200, y, { width: 70 });
    doc.text(r.grade, 270, y, { width: 60 });
    doc.text(r.mean, 330, y, { width: 80 });
    doc.fontSize(8).fillColor('#64748B').text(r.comment || '', 410, y, { width: 145 });
    doc.moveDown(0.6);
  }

  doc.moveDown(0.5);
  doc.fontSize(9).fillColor('#13213B');
  doc.text(`Aggregate: ${aggregatePct == null ? '—' : aggregatePct + '%'}    Position: ${position == null ? '—' : `${position} of ${totalLearners}`}    Attendance: ${attendancePct == null ? '—' : attendancePct + '%'}`);
  doc.moveDown(1);

  doc.fontSize(9).fillColor('#64748B').text('CLASS TEACHER', { continued: false });
  doc.fontSize(9).fillColor('#13213B').text(classTeacherComment || 'No comment recorded.', { width: 515 });
  doc.moveDown(2);

  const sigY = doc.y;
  doc.fontSize(8).fillColor('#64748B');
  doc.moveTo(40, sigY).lineTo(190, sigY).strokeColor('#C7D3E6').stroke();
  doc.text(`Class teacher · ${classTeacherName || ''}`, 40, sigY + 4, { width: 150 });
  doc.moveTo(220, sigY).lineTo(370, sigY).strokeColor('#C7D3E6').stroke();
  doc.text('Principal', 220, sigY + 4, { width: 150 });
  doc.moveTo(400, sigY).lineTo(555, sigY).strokeColor('#C7D3E6').stroke();
  doc.text('Parent / guardian', 400, sigY + 4, { width: 150 });

  doc.end();
  return done;
}

export async function storeReportCardPdf(tenantId, studentId, buffer, uploadedBy) {
  const fileName = `report-card-${studentId}.pdf`;
  const storageKey = await storage.save({ tenantId, entityType: 'examReportCard', entityId: studentId, fileName, buffer });
  return db.documents.create({
    tenantId, entityType: 'examReportCard', entityId: studentId, documentType: 'Report card',
    fileName, storageKey, mimeType: 'application/pdf', sizeBytes: buffer.length, uploadedBy, expiryDate: null,
  });
}

// --- Datesheet PDF export (screen 3's "Export PDF" action) ---

export async function generateDatesheetPdf({ tenant, cycle, rows }) {
  const doc = new PDFDocument({ size: 'A4', margin: 30, layout: 'landscape' });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.fontSize(16).fillColor('#1E2D42').text(tenant?.name || 'School');
  doc.fontSize(10).fillColor('#6366F1').text(`${cycle.name.toUpperCase()} — DATESHEET`);
  doc.fontSize(9).fillColor('#64748B').text(`Generated ${todayStr()}`, { align: 'right' });
  doc.moveDown(1);

  const cols = [
    { label: 'DATE', x: 30, width: 62 },
    { label: 'CYCLE DAY', x: 92, width: 55 },
    { label: 'CLASS', x: 147, width: 62 },
    { label: 'PAPER', x: 209, width: 105 },
    { label: 'SESSION', x: 314, width: 50 },
    { label: 'DURATION', x: 364, width: 55 },
    { label: 'VENUE', x: 419, width: 90 },
    { label: 'INVIGILATOR', x: 509, width: 115 },
    { label: 'STATUS', x: 624, width: 70 },
  ];
  doc.fontSize(8).fillColor('#64748B');
  for (const c of cols) doc.text(c.label, c.x, doc.y, { width: c.width });
  doc.moveDown(0.3);
  doc.moveTo(30, doc.y).lineTo(760, doc.y).strokeColor('#E4EBF5').stroke();
  doc.moveDown(0.3);

  for (const r of rows) {
    const y = doc.y;
    doc.fontSize(8).fillColor('#13213B');
    doc.text(r.examDate || '—', cols[0].x, y, { width: cols[0].width });
    doc.text(r.cycleDay != null ? String(r.cycleDay) : '—', cols[1].x, y, { width: cols[1].width });
    doc.text(r.className, cols[2].x, y, { width: cols[2].width });
    doc.text(r.subject, cols[3].x, y, { width: cols[3].width });
    doc.text(r.session || '—', cols[4].x, y, { width: cols[4].width });
    doc.text(r.durationMinutes ? `${r.durationMinutes}m` : '—', cols[5].x, y, { width: cols[5].width });
    doc.text(r.venue || '—', cols[6].x, y, { width: cols[6].width });
    doc.text(r.invigilatorName || 'Unassigned', cols[7].x, y, { width: cols[7].width });
    doc.text(r.status, cols[8].x, y, { width: cols[8].width });
    doc.moveDown(0.6);
  }

  doc.end();
  return done;
}

// --- Per-student exam summary (Student profile > Exams tab) ---
//
// One learner's view across every exam cycle that covers their class:
// per subject, the mark and grade ONLY once that subject's marksheet is
// approved (the same "released" rule the parent preview uses -- a draft
// or submitted mark is never shown as if it were final), plus the
// learner's upcoming papers from the datesheet. Read-only; no new data.
export async function studentExamSummary(tenantId, student) {
  const today = todayStr();
  const [cycles, sessions] = await Promise.all([
    db.examCycles.list(tenantId),
    db.examSessions.list(tenantId, { className: student.className }),
  ]);

  const inSection = (s) => !Array.isArray(s.sectionsIncluded) || s.sectionsIncluded.length === 0 || s.sectionsIncluded.includes(student.section);
  const cycleById = new Map(cycles.map((c) => [c.id, c]));

  const upcoming = sessions
    .filter((s) => s.examDate && s.examDate >= today && inSection(s))
    .map((s) => ({
      examDate: s.examDate, session: s.session || null, subject: s.subject, venue: s.venue || null,
      cycleName: cycleById.get(s.cycleId)?.name || null,
    }));

  const summaries = [];
  for (const cycle of cycles) {
    const structures = (await db.examStructure.list(tenantId, { cycleId: cycle.id })).filter((s) => s.className === student.className);
    if (!structures.length) continue;
    const sheets = (await db.examMarksheets.list(tenantId, { cycleId: cycle.id }))
      .filter((m) => m.className === student.className && m.section === student.section);
    const sheetBySubject = new Map(sheets.map((m) => [m.subjectName, m]));

    let scoredTotal = 0; let scoredMax = 0;
    const subjects = [];
    for (const structure of structures) {
      const sheet = sheetBySubject.get(structure.subjectName);
      const released = sheet?.status === 'approved';
      const mark = released ? await db.examMarks.findOne(tenantId, { marksheetId: sheet.id, studentId: student.id }) : null;
      const total = mark?.total ?? null;
      const maxMarks = Number(structure.maxMarks) || null;
      if (total != null && maxMarks) { scoredTotal += Number(total); scoredMax += maxMarks; }
      subjects.push({
        subject: structure.subjectName,
        released,
        sheetStatus: sheet?.status || 'not_started',
        total,
        maxMarks,
        passMarks: structure.passMarks ?? null,
        grade: mark?.grade ?? (total != null && maxMarks ? await gradeForPercentage(tenantId, Number(total) * 100 / maxMarks) : null),
        passed: total != null && structure.passMarks != null ? Number(total) >= Number(structure.passMarks) : null,
      });
    }
    subjects.sort((a, b) => a.subject.localeCompare(b.subject));
    const aggregatePct = scoredMax ? Number((scoredTotal * 100 / scoredMax).toFixed(1)) : null;
    summaries.push({
      id: cycle.id, name: cycle.name, examType: cycle.examType || null, stage: cycle.stage,
      windowOpens: cycle.windowOpens || null, windowCloses: cycle.windowCloses || null,
      releasedCount: subjects.filter((s) => s.released).length,
      subjectCount: subjects.length,
      total: scoredMax ? scoredTotal : null, maxTotal: scoredMax || null, aggregatePct,
      grade: aggregatePct != null ? await gradeForPercentage(tenantId, aggregatePct) : null,
      subjects,
    });
  }
  summaries.sort((a, b) => String(b.windowOpens || '').localeCompare(String(a.windowOpens || '')));

  return { cycles: summaries, upcoming };
}
