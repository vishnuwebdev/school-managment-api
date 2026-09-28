import { Router } from 'express';
import { authenticate, tenantScope, permit, validDate } from '../../core/middleware.js';
import { asyncRoute, badRequest, notFound } from '../../core/errors.js';
import { db } from '../../db/index.js';
import { toCsv, parseCsv } from '../../core/csv.js';
import { generateTabularReportPdf } from '../../core/reportPdf.js';
import {
  buildRoster, countByStatus, STATUSES, todayStr, daysBack, getAttendanceSettings,
  computePercentage, consecutiveAbsences, resolvePeriodsForDay,
} from './service.js';

// Attendance (designs/Teacher feature UI mockup/Attendance.dc.html, 9
// screens). Screen 2 (Daily register) already shipped before this module
// existed; these 9 screens close the 3 gaps the mockup's own intro calls
// out -- percentage fetched-but-never-rendered, an append-only correction
// history nothing reads, and free-text class/section instead of the
// Classes & Sections registry -- plus build the 7 genuinely new screens
// around it.
//
// Scope decisions made with Vishnu before writing this (see the project
// doc "Attendance module -- implementation plan"), not silently assumed:
//  - Corrections backdated past the settings window need a dedicated
//    permission (attendance:corrections:update, formerly the flat
//    attendance.correction.approve) rather than reusing an existing role --
//    granted to school_admin by default (see SCHOOL_ADMIN_PERMISSIONS in
//    db/seed.js), reassignable via the existing Users & Roles permission
//    editor.
//  - Guardian notification toggles (screen 9) are saved for real but wired
//    to nothing -- there's no Notices & Communication backend anywhere in
//    this codebase (reserved permission strings + a placeholder nav entry
//    only).
//  - Reports & export (screen 8): the selection UI and trend/phase-rate
//    data are real; actual PDF/CSV file generation is a follow-up, not
//    this pass.
//  - Defaulter/profile "actions" (warning letter, guardian meeting,
//    support referral) are a real tracked intervention log (who, when,
//    what stage) -- no letter/SMS/email is actually sent, but the action
//    taken is genuinely recorded and queryable, and feeds the defaulter's
//    computed policy "stage" below.
export const attendanceRouter = Router();

// --- Daily register (screen 2) -- existing, now percentage-aware and
// backdate/correction-aware ---

attendanceRouter.get('/', authenticate, tenantScope, permit('attendance:daily-register:read'), asyncRoute(async (req, res) => {
  const { date, className, section } = req.query;
  if (![date, className, section].every(Boolean) || !validDate(date)) {
    throw badRequest('A valid date, className and section are required');
  }
  const roster = await buildRoster(req.tenantId, date, className, section);
  const counts = countByStatus(roster);
  const marked = Object.values(counts).reduce((a, b) => a + b, 0);
  res.json({ data: { date, className, section, roster, summary: { ...counts, total: roster.length, marked } } });
}));

attendanceRouter.put('/', authenticate, tenantScope, asyncRoute(async (req, res, next) => {
  const { date, className, section } = req.body || {};
  const existing = date && className && section ? await db.attendance.findMatching(req.tenantId, date, className, section) : [];
  return permit(existing.length ? 'attendance:daily-register:update' : 'attendance:daily-register:write')(req, res, next);
}), asyncRoute(async (req, res) => {
  const { date, className, section, records } = req.body;
  if (![date, className, section].every(Boolean) || !validDate(date) || !Array.isArray(records) || !records.length) {
    throw badRequest('A valid date, className, section and non-empty records array are required');
  }
  if (daysBack(date) < 0) throw badRequest('Cannot mark attendance for a future date');

  const roster = await db.students.findByClassSection(req.tenantId, className, section);
  const allowed = new Set(roster.map((student) => student.id));
  const seen = new Set();
  const invalid = records.some((item) =>
    !item?.studentId || seen.has(item.studentId) || !allowed.has(item.studentId) || !STATUSES.has(item.status) ||
    (item.remark != null && (typeof item.remark !== 'string' || item.remark.length > 500)));
  if (invalid) throw badRequest('Records must be unique active students in this class/section with a valid status and a remark up to 500 characters');
  records.forEach((item) => seen.add(item.studentId));

  const settings = await getAttendanceSettings(req.tenantId);
  const existing = await db.attendance.findMatching(req.tenantId, date, className, section);
  const existingByStudent = new Map(existing.map((row) => [row.studentId, row]));
  const backdated = daysBack(date) > settings.backdateWindowDays;

  // A correction to an ALREADY-marked day beyond the backdate window needs
  // approval and doesn't apply yet -- everything else (a first mark for
  // any day, or an edit within the window) applies immediately, same as
  // before. This is what makes "backdating a correction" and "filling in
  // a day that was simply never marked" behave differently, per the
  // mockup's own corrNotes.
  const immediate = [];
  const pendingRequests = [];
  for (const item of records) {
    const prior = existingByStudent.get(item.studentId);
    const isRealChange = prior && (prior.status !== item.status || (item.remark ?? '') !== (prior.remark ?? ''));
    if (prior && isRealChange && !item.remark?.trim()) {
      throw badRequest(`A reason is required to correct an already-marked day for student ${item.studentId}`);
    }
    if (prior && isRealChange && backdated) {
      pendingRequests.push({ item, prior });
    } else {
      immediate.push(item);
    }
  }

  if (immediate.length) {
    await db.attendance.upsertMany(req.tenantId, { date, className, section, records: immediate, actorId: req.auth.sub });
    await db.audit.record({ event: 'attendance.saved', actorId: req.auth.sub, target: `${date}:${className}:${section}`, tenantId: req.tenantId, summary: { records: immediate.length } });
  }

  const createdRequests = [];
  for (const { item, prior } of pendingRequests) {
    const request = await db.attendanceCorrectionRequests.create({
      tenantId: req.tenantId, studentId: item.studentId, date, className, section,
      previousStatus: prior.status, previousRemark: prior.remark,
      requestedStatus: item.status, requestedRemark: item.remark.trim(),
      reason: item.remark.trim(), requestedBy: req.auth.sub, requestedAt: new Date().toISOString(),
    });
    createdRequests.push(request);
  }
  if (createdRequests.length) {
    await db.audit.record({
      event: 'attendance.correctionRequested', actorId: req.auth.sub, target: `${date}:${className}:${section}`,
      tenantId: req.tenantId, summary: { count: createdRequests.length },
    });
  }

  res.json({
    data: {
      date, className, section, roster: await buildRoster(req.tenantId, date, className, section),
      pendingCorrections: createdRequests.length,
    },
  });
}));

attendanceRouter.get('/summary', authenticate, tenantScope, permit('attendance:daily-register:read'), asyncRoute(async (req, res) => {
  const { date, className, section } = req.query;
  if (!date || !validDate(date)) throw badRequest('A valid date is required');
  const records = await db.attendance.summary(req.tenantId, { date, className, section });
  const counts = countByStatus(records);
  res.json({ data: { date, ...counts, marked: records.length } });
}));

// --- Attendance today (screen 1) ---

attendanceRouter.get('/today', authenticate, tenantScope, permit('attendance:today:read'), asyncRoute(async (req, res) => {
  const date = validDate(req.query.date) ? req.query.date : todayStr();
  const [levels, students, settings] = await Promise.all([
    db.classLevels.list(req.tenantId),
    db.students.list(req.tenantId, { status: 'active' }),
    getAttendanceSettings(req.tenantId),
  ]);
  const levelById = new Map(levels.map((l) => [l.id, l]));
  const sectionLists = await Promise.all(levels.map((l) => db.classSections.list(req.tenantId, { classLevelId: l.id })));
  const sections = sectionLists.flat().map((s) => ({ ...s, className: levelById.get(s.classLevelId)?.name }));

  const openRegisters = [];
  const todaysRecords = [];
  for (const section of sections) {
    if (!section.className) continue;
    const marked = await db.attendance.findMatching(req.tenantId, date, section.className, section.letter);
    if (!marked.length) openRegisters.push({ cls: `${section.className} · ${section.letter}`, note: 'Register not submitted yet' });
    todaysRecords.push(...marked);
  }

  const absentNoRemark = todaysRecords.filter((r) => r.status === 'absent' && !r.remark).length;

  let consecutive = 0;
  let belowThreshold = 0;
  for (const student of students) {
    const history = await db.attendance.findByStudent(req.tenantId, student.id);
    if (!history.length) continue;
    if (consecutiveAbsences(history) >= settings.consecutiveAbsenceTrigger) consecutive += 1;
    const pct = computePercentage(history);
    if (pct != null && pct < settings.atRiskThreshold) belowThreshold += 1;
  }

  const pendingCorrections = await db.attendanceCorrectionRequests.list(req.tenantId, { status: 'pending' });

  res.json({
    data: {
      date,
      openRegisters,
      followUp: [
        { key: 'absentNoRemark', label: 'Absent with no reason', value: absentNoRemark },
        { key: 'consecutive', label: `${settings.consecutiveAbsenceTrigger}+ consecutive absences`, value: consecutive },
        { key: 'belowThreshold', label: `Below ${settings.atRiskThreshold}% this term`, value: belowThreshold },
        { key: 'pendingCorrections', label: 'Corrections awaiting approval', value: pendingCorrections.length },
      ],
    },
  });
}));

// --- Period-wise register (screen 3) ---
// Opt-in per phase via attendance_settings.period_marking_phases -- most
// schools only need the daily register (mockup's own settings screen
// defaults this OFF). A period with no timetable entry (no teacher
// appointed) can never be marked -- it's a real, expected gap, not an
// error to fill in.

attendanceRouter.get('/periods', authenticate, tenantScope, permit('attendance:period-register:read'), asyncRoute(async (req, res) => {
  const { date, className, section } = req.query;
  if (![date, className, section].every(Boolean) || !validDate(date)) throw badRequest('A valid date, className and section are required');

  const [level, settings, students, periods] = await Promise.all([
    db.classLevels.findByName(req.tenantId, className),
    getAttendanceSettings(req.tenantId),
    db.students.findByClassSection(req.tenantId, className, section),
    db.attendancePeriods.findForDay(req.tenantId, date, className, section),
  ]);
  const phase = level?.phase;
  if (!phase || !settings.periodMarkingPhases.includes(phase)) {
    throw badRequest(`Period-wise marking is off for the ${phase ?? 'unknown'} phase -- turn it on from Attendance settings first`);
  }

  const periodsToday = await resolvePeriodsForDay(req.tenantId, date, className, section);
  const periodHead = periodsToday.map((p) => ({ slotId: p.slotId, subject: p.subject }));

  const periodRows = students.map((student) => ({
    studentId: student.id,
    name: `${student.firstName} ${student.lastName}`,
    cells: periodsToday.map((p) => {
      const mark = periods.find((row) => row.slotId === p.slotId && row.studentId === student.id);
      return { slotId: p.slotId, status: mark?.status ?? null, remark: mark?.remark ?? '' };
    }),
  }));

  res.json({ data: { date, className, section, periodHead, periodRows } });
}));

attendanceRouter.put('/periods', authenticate, tenantScope, permit('attendance:period-register:write'), asyncRoute(async (req, res) => {
  const { date, className, section, slotId, records } = req.body || {};
  if (![date, className, section, slotId].every(Boolean) || !validDate(date) || !Array.isArray(records) || !records.length) {
    throw badRequest('A valid date, className, section, slotId and non-empty records array are required');
  }
  const periodsToday = await resolvePeriodsForDay(req.tenantId, date, className, section);
  const period = periodsToday.find((p) => p.slotId === slotId);
  if (!period) throw badRequest(`No timetable entry for ${slotId} on this class/section/day -- nothing to mark`);

  const roster = await db.students.findByClassSection(req.tenantId, className, section);
  const allowed = new Set(roster.map((s) => s.id));
  const invalid = records.some((item) => !item?.studentId || !allowed.has(item.studentId) || !STATUSES.has(item.status));
  if (invalid) throw badRequest('Records must be active students in this class/section with a valid status');

  const saved = await db.attendancePeriods.upsertMany(req.tenantId, {
    date, slotId, className, section, subject: period.subject, records, actorId: req.auth.sub,
  });
  await db.audit.record({ event: 'attendance.periodSaved', actorId: req.auth.sub, target: `${date}:${className}:${section}:${slotId}`, tenantId: req.tenantId, summary: { records: saved.length } });
  res.json({ data: { date, className, section, slotId, saved: saved.length } });
}));

// --- Monthly summary (screen 4) ---
// School days = weekdays in the month up to today (no holiday calendar is
// wired into Attendance yet, so a public holiday still counts as a
// "school day" here unless a register happens to be empty for it) --
// documented simplification, not a silent one.

attendanceRouter.get('/monthly', authenticate, tenantScope, permit('attendance:monthly-summary:read'), asyncRoute(async (req, res) => {
  const { month, className, section } = req.query; // month = 'YYYY-MM'
  if (!/^\d{4}-\d{2}$/.test(month || '') || !className || !section) throw badRequest('A valid month (YYYY-MM), className and section are required');

  const [year, mon] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  const today = todayStr();
  const students = await db.students.findByClassSection(req.tenantId, className, section);

  const monthRows = [];
  let sumPct = 0;
  let perfectMonth = 0;
  let below = 0;
  for (const student of students) {
    const history = await db.attendance.findByStudent(req.tenantId, student.id);
    const byDate = new Map(history.map((r) => [r.date, r]));
    const cells = [];
    const monthRecords = [];
    for (let day = 1; day <= daysInMonth; day += 1) {
      const dateStr = `${month}-${String(day).padStart(2, '0')}`;
      if (dateStr > today) { cells.push(null); continue; }
      const weekday = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) { cells.push('holiday'); continue; }
      const record = byDate.get(dateStr);
      cells.push(record ? record.status : 'unmarked');
      if (record) monthRecords.push(record);
    }
    const pct = computePercentage(monthRecords);
    if (pct != null) {
      sumPct += pct;
      if (pct === 100) perfectMonth += 1;
    }
    monthRows.push({ studentId: student.id, name: `${student.firstName} ${student.lastName}`, percentage: pct, cells });
  }
  const settings = await getAttendanceSettings(req.tenantId);
  monthRows.forEach((row) => { if (row.percentage != null && row.percentage < settings.atRiskThreshold) below += 1; });

  const historyThisMonth = (await db.attendance.history(req.tenantId)).filter((h) => h.action === 'updated' && h.after.date?.startsWith(month) && h.after.className === className && h.after.section === section);

  res.json({
    data: {
      month, className, section, daysInMonth, monthRows,
      stats: {
        schoolDays: monthRows[0]?.cells.filter((c) => c && c !== 'holiday').length ?? 0,
        classAverage: students.length ? Number((sumPct / students.length).toFixed(1)) : null,
        belowThreshold: below,
        perfectMonth,
        corrections: historyThisMonth.length,
      },
    },
  });
}));

// --- Corrections history + backdated-correction approval queue (screens 1, 7, 9) ---

attendanceRouter.get('/correction-requests', authenticate, tenantScope, permit('attendance:corrections:read'), asyncRoute(async (req, res) => {
  const { status } = req.query;
  const requests = await db.attendanceCorrectionRequests.list(req.tenantId, { status });
  const enriched = await Promise.all(requests.map(async (r) => {
    const student = await db.students.findById(req.tenantId, r.studentId);
    return { ...r, studentName: student ? `${student.firstName} ${student.lastName}` : 'Unknown learner' };
  }));
  res.json({ data: enriched });
}));

attendanceRouter.patch('/correction-requests/:id/decide', authenticate, tenantScope, permit('attendance:corrections:update'), asyncRoute(async (req, res) => {
  const { status, note } = req.body || {};
  if (!['approved', 'declined'].includes(status)) throw badRequest('status must be "approved" or "declined"');
  const request = await db.attendanceCorrectionRequests.findById(req.tenantId, req.params.id);
  if (!request) throw notFound('Correction request not found');
  if (request.status !== 'pending') throw badRequest('This request has already been decided');

  if (status === 'approved') {
    await db.attendance.upsertMany(req.tenantId, {
      date: request.date, className: request.className, section: request.section,
      records: [{ studentId: request.studentId, status: request.requestedStatus, remark: request.requestedRemark }],
      actorId: req.auth.sub,
    });
  }
  const decided = await db.attendanceCorrectionRequests.decide(req.tenantId, req.params.id, { status, decidedBy: req.auth.sub, decisionNote: note });
  await db.audit.record({
    event: status === 'approved' ? 'attendance.correctionApproved' : 'attendance.correctionDeclined',
    actorId: req.auth.sub, target: request.id, tenantId: req.tenantId,
    summary: { studentId: request.studentId, date: request.date, className: request.className, section: request.section },
  });
  res.json({ data: decided });
}));

attendanceRouter.get('/corrections', authenticate, tenantScope, permit('attendance:corrections:read'), asyncRoute(async (req, res) => {
  const [history, pending, allRequests, students] = await Promise.all([
    db.attendance.history(req.tenantId),
    db.attendanceCorrectionRequests.list(req.tenantId, { status: 'pending' }),
    db.attendanceCorrectionRequests.list(req.tenantId),
    db.students.list(req.tenantId, {}),
  ]);
  const studentById = new Map(students.map((s) => [s.id, s]));
  const nameFor = (id) => { const s = studentById.get(id); return s ? `${s.firstName} ${s.lastName}` : 'Unknown learner'; };

  // A "correction" is an edit to an already-marked day (action:'updated');
  // the very first mark for a day (action:'created') isn't a correction.
  const rows = history.filter((h) => h.action === 'updated').map((h) => ({
    id: h.id, when: h.at, who: h.actorId, learner: nameFor(h.after.studentId), studentId: h.after.studentId,
    className: h.after.className, section: h.after.section, date: h.after.date,
    from: h.before?.status ?? null, to: h.after.status, reason: h.after.remark, state: 'applied',
  }));
  const pendingRows = pending.map((r) => ({
    id: r.id, when: r.requestedAt, who: r.requestedBy, learner: nameFor(r.studentId), studentId: r.studentId,
    className: r.className, section: r.section, date: r.date,
    from: r.previousStatus, to: r.requestedStatus, reason: r.reason, state: 'pending',
  }));

  const now = new Date();
  const thisMonthKey = now.toISOString().slice(0, 7);
  const thisMonthCount = rows.filter((r) => r.when.startsWith(thisMonthKey)).length + pendingRows.filter((r) => r.when.startsWith(thisMonthKey)).length;
  const backdated7Plus = allRequests.length; // every correction-request row exists only because it crossed the backdate window
  const byClass = {};
  [...rows, ...pendingRows].forEach((r) => { const key = `${r.className} · ${r.section}`; byClass[key] = (byClass[key] || 0) + 1; });
  const mostCorrected = Object.entries(byClass).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  res.json({
    data: { pending: pendingRows, history: rows },
    meta: {
      thisMonth: thisMonthCount,
      awaitingApproval: pending.length,
      backdated7Plus,
      mostCorrected,
    },
  });
}));

// --- At-risk & defaulters (screen 6) ---

attendanceRouter.get('/defaulters', authenticate, tenantScope, permit('attendance:defaulters:read'), asyncRoute(async (req, res) => {
  const settings = await getAttendanceSettings(req.tenantId);
  const students = await db.students.list(req.tenantId, { status: 'active' });
  const rows = [];
  for (const student of students) {
    const history = await db.attendance.findByStudent(req.tenantId, student.id); // newest first
    const pct = computePercentage(history);
    if (pct == null || pct >= settings.atRiskThreshold) continue;
    const consec = consecutiveAbsences(history);
    const interventions = await db.attendanceInterventions.list(req.tenantId, { studentId: student.id });
    const stage = interventions.some((i) => i.type === 'support_referral') ? 'Support referral'
      : interventions.some((i) => i.type === 'guardian_meeting') ? 'Meeting requested'
      : interventions.some((i) => i.type === 'warning_letter') ? 'Letter sent'
      : 'Monitoring';
    const half = Math.floor(history.length / 2) || 1;
    const recentPct = computePercentage(history.slice(0, half));
    const olderPct = computePercentage(history.slice(half));
    const improving = recentPct != null && olderPct != null && recentPct > olderPct;
    rows.push({
      studentId: student.id, name: `${student.firstName} ${student.lastName}`,
      className: student.className, section: student.section,
      percentage: pct, absentCount: history.filter((r) => r.status === 'absent').length,
      consecutiveAbsences: consec, lastAbsence: history.find((r) => r.status === 'absent')?.date ?? null,
      stage, improving,
    });
  }
  rows.sort((a, b) => a.percentage - b.percentage);

  res.json({
    data: rows,
    meta: {
      below: rows.filter((r) => r.percentage < settings.atRiskThreshold).length,
      below60: rows.filter((r) => r.percentage < 60).length,
      consecutive3Plus: rows.filter((r) => r.consecutiveAbsences >= settings.consecutiveAbsenceTrigger).length,
      lettersDue: rows.filter((r) => r.stage === 'Monitoring').length,
      improving: rows.filter((r) => r.improving).length,
    },
  });
}));

// --- Interventions (screens 5, 6) -- a real tracked action log; no
// letter/SMS/email is actually sent (see module header). ---

attendanceRouter.get('/interventions', authenticate, tenantScope, permit('attendance:interventions:read'), asyncRoute(async (req, res) => {
  const { studentId } = req.query;
  if (!studentId) throw badRequest('studentId is required');
  const rows = await db.attendanceInterventions.list(req.tenantId, { studentId });
  res.json({ data: rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) });
}));

const INTERVENTION_TYPES = new Set(['warning_letter', 'guardian_meeting', 'support_referral']);

attendanceRouter.post('/interventions', authenticate, tenantScope, permit('attendance:interventions:write'), asyncRoute(async (req, res) => {
  const { studentId, type, note } = req.body || {};
  if (!studentId || !INTERVENTION_TYPES.has(type)) throw badRequest('studentId and a valid type are required');
  const student = await db.students.findById(req.tenantId, studentId);
  if (!student) throw notFound('Student not found');
  const record = await db.attendanceInterventions.create({ tenantId: req.tenantId, studentId, type, note: note?.trim() || '', createdBy: req.auth.sub, createdAt: new Date().toISOString() });
  await db.audit.record({ event: 'attendance.interventionLogged', actorId: req.auth.sub, target: studentId, tenantId: req.tenantId, summary: { type } });
  res.status(201).json({ data: record });
}));

attendanceRouter.post('/interventions/bulk', authenticate, tenantScope, permit('attendance:interventions:write'), asyncRoute(async (req, res) => {
  const { studentIds, type, note } = req.body || {};
  if (!Array.isArray(studentIds) || !studentIds.length || !INTERVENTION_TYPES.has(type)) {
    throw badRequest('studentIds (non-empty array) and a valid type are required');
  }
  const created = [];
  for (const studentId of studentIds) {
    const student = await db.students.findById(req.tenantId, studentId);
    if (!student) continue;
    created.push(await db.attendanceInterventions.create({ tenantId: req.tenantId, studentId, type, note: note?.trim() || '', createdBy: req.auth.sub, createdAt: new Date().toISOString() }));
  }
  await db.audit.record({ event: 'attendance.interventionLogged', actorId: req.auth.sub, target: 'bulk', tenantId: req.tenantId, summary: { type, count: created.length } });
  res.status(201).json({ data: created });
}));

// --- Settings (screen 9) ---

attendanceRouter.get('/settings', authenticate, tenantScope, permit('attendance:settings:read'), asyncRoute(async (req, res) => {
  res.json({ data: await getAttendanceSettings(req.tenantId) });
}));

attendanceRouter.put('/settings', authenticate, tenantScope, permit('attendance:settings:update'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.registerLockTime != null) patch.registerLockTime = String(body.registerLockTime);
  if (body.backdateWindowDays != null) patch.backdateWindowDays = Math.max(0, Number(body.backdateWindowDays) || 0);
  if (body.atRiskThreshold != null) patch.atRiskThreshold = Math.max(0, Math.min(100, Number(body.atRiskThreshold) || 0));
  if (body.consecutiveAbsenceTrigger != null) patch.consecutiveAbsenceTrigger = Math.max(1, Number(body.consecutiveAbsenceTrigger) || 1);
  if (body.leaveNeedsNote != null) patch.leaveNeedsNote = !!body.leaveNeedsNote;
  if (Array.isArray(body.periodMarkingPhases)) patch.periodMarkingPhases = body.periodMarkingPhases;
  if (Array.isArray(body.notifyRules)) patch.notifyRules = body.notifyRules;
  await db.attendanceSettings.upsert(req.tenantId, patch);
  await db.audit.record({ event: 'attendance.settingsUpdated', actorId: req.auth.sub, target: req.tenantId, tenantId: req.tenantId, summary: patch });
  res.json({ data: await getAttendanceSettings(req.tenantId) });
}));

// --- Reports & export (screen 8) -- trend/phase-rate data is real; actual
// PDF/CSV generation is a follow-up (agreed scope cut), so there is no
// export endpoint yet -- the Flutter screen surfaces this honestly rather
// than faking a download. ---

attendanceRouter.get('/trends', authenticate, tenantScope, permit('attendance:reports:read'), asyncRoute(async (req, res) => {
  const weeks = Math.min(26, Math.max(1, Number(req.query.weeks) || 8));
  const allRecords = (await db.students.list(req.tenantId, { status: 'active' }));
  const perStudentHistory = await Promise.all(allRecords.map((s) => db.attendance.findByStudent(req.tenantId, s.id)));
  const flat = perStudentHistory.flat();

  const today = new Date(`${todayStr()}T00:00:00Z`);
  const points = [];
  for (let w = weeks - 1; w >= 0; w -= 1) {
    const end = new Date(today); end.setUTCDate(end.getUTCDate() - w * 7);
    const start = new Date(end); start.setUTCDate(start.getUTCDate() - 6);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);
    const weekRecords = flat.filter((r) => r.date >= startStr && r.date <= endStr);
    points.push({ label: endStr, percentage: computePercentage(weekRecords) });
  }
  res.json({ data: points });
}));

attendanceRouter.get('/phase-rates', authenticate, tenantScope, permit('attendance:reports:read'), asyncRoute(async (req, res) => {
  const levels = await db.classLevels.list(req.tenantId);
  const students = await db.students.list(req.tenantId, { status: 'active' });
  const phaseOf = new Map(levels.map((l) => [l.name, l.phase]));
  const rows = [];
  for (const phase of [...new Set(levels.map((l) => l.phase))]) {
    const inPhase = students.filter((s) => phaseOf.get(s.className) === phase);
    const histories = await Promise.all(inPhase.map((s) => db.attendance.findByStudent(req.tenantId, s.id)));
    rows.push({ phase, percentage: computePercentage(histories.flat()) });
  }
  res.json({ data: rows });
}));

// --- Cross-class report exports (Filter -> View -> Export Excel ->
// Export PDF -> Print, requirement/rquiremnt phase 1.md #31;
// edusphere-reports-module-plan-2026-09-22.md). The existing Reports &
// export screen (its 6 tiles above, GET /trends and /phase-rates) stays
// exactly as it is -- untouched by this change. These two are the spec's
// "Daily attendance" and "Class attendance" report types, which had no
// real screen behind them: Daily register (GET /) only ever showed one
// class/section at a time, never the whole school for one date, and
// Monthly summary is per-student, not a class-vs-class comparison. Both
// reuse db.attendance.summary(), which already supports an optional
// className/section filter -- calling it with just a date returns every
// attendance row tenant-wide for that day, exactly what "Daily
// attendance" needs, with zero new database access needed. Gated on the
// SAME attendance:reports:read permission the existing Reports & export
// screen already uses -- not a new permission, since this is still "the
// Reports page" as far as RBAC is concerned, just two more report types.
attendanceRouter.get('/reports/export/:type', authenticate, tenantScope, permit('attendance:reports:read'), asyncRoute(async (req, res) => {
  const { type } = req.params;
  if (!['daily', 'class'].includes(type)) throw notFound(`Unknown report type "${type}"`);
  const students = await db.students.list(req.tenantId, {});
  const studentById = new Map(students.map((s) => [s.id, s]));

  let csv;
  let filename;
  let title;

  if (type === 'daily') {
    const { date } = req.query;
    if (!validDate(date)) throw badRequest('A valid date is required');
    title = `Daily Attendance Report - ${date}`;
    filename = `daily_attendance_${date}`;
    const rows = (await db.attendance.summary(req.tenantId, { date }))
      .map((r) => {
        const student = studentById.get(r.studentId);
        return {
          className: r.className, section: r.section, admissionNumber: student?.admissionNumber || '',
          name: student ? `${student.firstName} ${student.lastName}` : 'Unknown learner', status: r.status, remark: r.remark || '',
        };
      })
      .sort((a, b) => (a.className === b.className ? (a.section === b.section ? a.name.localeCompare(b.name) : a.section.localeCompare(b.section)) : a.className.localeCompare(b.className)));
    csv = toCsv(['className', 'section', 'admissionNumber', 'name', 'status', 'remark'], rows);
  } else {
    // 'class' -- attendance rate per class+section across a month, the
    // same weekday-skipping window Monthly Summary already uses, just
    // aggregated by class instead of by student.
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : todayStr().slice(0, 7);
    title = `Class Attendance Report - ${month}`;
    filename = `class_attendance_${month}`;
    const [year, mon] = month.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    const today = todayStr();
    const byClass = new Map();
    for (let day = 1; day <= daysInMonth; day += 1) {
      const dateStr = `${month}-${String(day).padStart(2, '0')}`;
      if (dateStr > today) continue;
      const weekday = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const dayRows = await db.attendance.summary(req.tenantId, { date: dateStr });
      for (const r of dayRows) {
        const key = `${r.className}|${r.section}`;
        if (!byClass.has(key)) byClass.set(key, []);
        byClass.get(key).push(r);
      }
    }
    const rows = [...byClass.entries()]
      .map(([key, records]) => {
        const [className, section] = key.split('|');
        return { className, section, daysMarked: new Set(records.map((r) => r.date)).size, recordsMarked: records.length, attendanceRate: computePercentage(records) };
      })
      .sort((a, b) => (a.className === b.className ? a.section.localeCompare(b.section) : a.className.localeCompare(b.className)));
    csv = toCsv(['className', 'section', 'daysMarked', 'recordsMarked', 'attendanceRate'], rows);
  }

  await db.audit.record({ event: 'attendance.reportGenerated', actorId: req.auth.sub, target: type, tenantId: req.tenantId });

  if (req.query.format === 'pdf') {
    const school = await db.schools.findById(req.tenantId);
    const [headerLine] = csv.split('\r\n');
    const columns = headerLine.split(',').map((key) => ({ label: key, key }));
    const rows = parseCsv(csv);
    const pdf = await generateTabularReportPdf({ tenant: school, title, columns, rows });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    res.send(pdf);
    return;
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  res.send(csv);
}));

export const studentAttendanceRouter = Router();

studentAttendanceRouter.get('/:id/attendance', authenticate, tenantScope, permit('attendance:learner-record:read'), asyncRoute(async (req, res) => {
  const student = await db.students.findById(req.tenantId, req.params.id);
  if (!student) throw notFound('Student not found');
  const data = await db.attendance.findByStudent(req.tenantId, student.id);
  const presentLike = data.filter((record) => ['present', 'late'].includes(record.status)).length;
  res.json({ data, meta: { total: data.length, presentLike, percentage: data.length ? Number((presentLike * 100 / data.length).toFixed(1)) : null } });
}));

studentAttendanceRouter.get('/:id/attendance/interventions', authenticate, tenantScope, permit('attendance:interventions:read'), asyncRoute(async (req, res) => {
  const student = await db.students.findById(req.tenantId, req.params.id);
  if (!student) throw notFound('Student not found');
  const rows = await db.attendanceInterventions.list(req.tenantId, { studentId: student.id });
  res.json({ data: rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) });
}));
