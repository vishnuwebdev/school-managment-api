import { Router } from 'express';
import { authenticate, tenantScope, permit, validDate } from '../../core/middleware.js';
import { asyncRoute, badRequest, conflict, notFound } from '../../core/errors.js';
import { db } from '../../db/index.js';
import { toCsv } from '../../core/csv.js';
import { buildCrudRouter } from '../../core/crudRoutes.js';
import {
  generateTimetable, scanClashes, checkPlacement, teachingSlots,
  DEFAULT_SLOTS, DEFAULT_CYCLE_DAYS, DEFAULT_HARD_RULES, DEFAULT_SOFT_RULES,
} from '../../core/timetableGenerator.js';

// Timetable (designs/Teacher feature UI mockup/Timetable.dc.html, 12
// screens). Migrated onto the feature:page:action model (RBAC rewrite) --
// see core/permissionsV2.js's 'timetable' catalog entry -- including for
// exam sessions (screen 9), which live here (under timetable:exams:*)
// rather than under the separate Examinations module (modules/exams/,
// its own exams:* permissions) added later -- the two intentionally read/
// write the SAME exam_sessions table rather than duplicating it; see
// modules/exams/routes.js's own header. Demand for the generator is read
// straight from staff_assignments; see core/timetableGenerator.js's
// header for exactly what this build's generator does and doesn't claim
// to do.
export const timetableRouter = Router();

const DEFAULT_CYCLE_ANCHOR = '2026-09-14';

export async function getConfig(tenantId) {
  const row = await db.timetableConfig.get(tenantId);
  if (row) return row;
  return {
    tenantId, cycleDays: DEFAULT_CYCLE_DAYS, cycleAnchor: DEFAULT_CYCLE_ANCHOR,
    slots: DEFAULT_SLOTS, hardRules: DEFAULT_HARD_RULES, softRules: DEFAULT_SOFT_RULES,
  };
}

export function cycleDayForDate(dateStr, config) {
  const anchor = new Date(`${config.cycleAnchor || DEFAULT_CYCLE_ANCHOR}T00:00:00Z`);
  const target = new Date(`${dateStr}T00:00:00Z`);
  const diffDays = Math.round((target - anchor) / 86400000);
  const cycleDays = config.cycleDays || DEFAULT_CYCLE_DAYS;
  return ((diffDays % cycleDays) + cycleDays) % cycleDays + 1;
}

export async function resolveVersion(tenantId, versionId) {
  if (versionId) {
    const version = await db.timetableVersions.findById(tenantId, versionId);
    if (!version) throw notFound('Timetable version not found');
    return version;
  }
  const live = await db.timetableVersions.getLive(tenantId);
  if (live) return live;
  const all = await db.timetableVersions.list(tenantId);
  return all[0] || null;
}

function enrichEntries(entries, staffById, venueById) {
  return entries.map((e) => ({
    ...e,
    staffName: staffById[e.staffId] ? `${staffById[e.staffId].firstName} ${staffById[e.staffId].lastName}` : null,
    venueName: e.venueId ? (venueById[e.venueId]?.name ?? null) : null,
  }));
}

// --- Config (screen 4: Period & bell-time setup) ---

timetableRouter.get('/config', authenticate, tenantScope, permit('timetable:config:read'), asyncRoute(async (req, res) => {
  res.json({ data: await getConfig(req.tenantId) });
}));

timetableRouter.put('/config', authenticate, tenantScope, permit('timetable:config:update'), asyncRoute(async (req, res) => {
  const { slots, hardRules, softRules, cycleAnchor } = req.body || {};
  const patch = {};
  if (slots !== undefined) {
    if (!Array.isArray(slots) || slots.length === 0) throw badRequest('slots must be a non-empty array');
    patch.slots = slots;
  }
  if (hardRules !== undefined) patch.hardRules = hardRules;
  if (softRules !== undefined) patch.softRules = softRules;
  if (cycleAnchor !== undefined) {
    if (!validDate(cycleAnchor)) throw badRequest('cycleAnchor must be a valid YYYY-MM-DD date');
    patch.cycleAnchor = cycleAnchor;
  }
  const current = await getConfig(req.tenantId);
  const saved = await db.timetableConfig.upsert(req.tenantId, { cycleDays: current.cycleDays, ...current, ...patch });
  await db.audit.record({ event: 'timetable.configUpdated', actorId: req.auth.sub, target: req.tenantId, tenantId: req.tenantId });
  res.json({ data: saved });
}));

// --- Venues (screen 8) ---

timetableRouter.use('/venues', buildCrudRouter({
  collection: 'timetableVenues',
  viewPermission: 'timetable:venues:read',
  managePermission: 'timetable:venues:write',
  event: 'timetable.venue',
  validate: (body) => {
    const name = (body.name || '').trim();
    if (!name) throw badRequest('name is required');
    return {
      name,
      capacity: (body.capacity || '').toString().trim(),
      subjects: (body.subjects || '').toString().trim(),
    };
  },
}));

// --- Versions (screen 11) ---

timetableRouter.get('/versions', authenticate, tenantScope, permit('timetable:versions:read'), asyncRoute(async (req, res) => {
  res.json({ data: await db.timetableVersions.list(req.tenantId) });
}));

timetableRouter.get('/versions/:id', authenticate, tenantScope, permit('timetable:versions:read'), asyncRoute(async (req, res) => {
  const version = await db.timetableVersions.findById(req.tenantId, req.params.id);
  if (!version) throw notFound('Version not found');
  res.json({ data: version });
}));

timetableRouter.post('/versions/:id/publish', authenticate, tenantScope, permit('timetable:versions:update'), asyncRoute(async (req, res) => {
  const version = await db.timetableVersions.findById(req.tenantId, req.params.id);
  if (!version) throw notFound('Version not found');
  const { effectiveFrom } = req.body || {};
  if (effectiveFrom !== undefined && effectiveFrom && !validDate(effectiveFrom)) throw badRequest('effectiveFrom must be a valid YYYY-MM-DD date');

  const entries = await db.timetableEntries.listForVersion(req.tenantId, version.id);
  const [assignments, staff, venues] = await Promise.all([
    db.staffAssignments.listForTenant(req.tenantId),
    db.staff.list(req.tenantId, {}),
    db.timetableVenues.list(req.tenantId),
  ]);
  const { findings } = scanClashes({ entries, assignments, staff, venues });
  const hardClashes = findings.filter((f) => f.sev === 'Clash');
  if (hardClashes.length > 0) {
    throw conflict(`${hardClashes.length} hard clash(es) must clear before publishing — see the clash & gap report`);
  }

  const published = await db.timetableVersions.publish(req.tenantId, version.id, { effectiveFrom });
  await db.audit.record({ event: 'timetable.published', actorId: req.auth.sub, target: version.id, tenantId: req.tenantId, summary: { versionNumber: version.versionNumber } });
  res.json({ data: published });
}));

// --- Entries / grids (screens 2, 3, 5) ---

timetableRouter.get('/entries', authenticate, tenantScope, permit('timetable:entries:read'), asyncRoute(async (req, res) => {
  const { versionId, className, section, staffId } = req.query;
  const version = await resolveVersion(req.tenantId, versionId);
  if (!version) return res.json({ data: [], meta: { version: null } });
  let entries = await db.timetableEntries.listForVersion(req.tenantId, version.id);
  if (className) entries = entries.filter((e) => e.className === className);
  if (section) entries = entries.filter((e) => e.section === section);
  if (staffId) entries = entries.filter((e) => e.staffId === staffId);
  const [staff, venues] = await Promise.all([db.staff.list(req.tenantId, {}), db.timetableVenues.list(req.tenantId)]);
  const staffById = Object.fromEntries(staff.map((s) => [s.id, s]));
  const venueById = Object.fromEntries(venues.map((v) => [v.id, v]));
  res.json({ data: enrichEntries(entries, staffById, venueById), meta: { version } });
}));

timetableRouter.post('/entries/check', authenticate, tenantScope, permit('timetable:entries:write'), asyncRoute(async (req, res) => {
  const { versionId, className, section, day, slotId, subject, staffId } = req.body || {};
  if (!versionId || !className || !section || !day || !slotId || !subject || !staffId) throw badRequest('versionId, className, section, day, slotId, subject and staffId are required');
  const [entries, assignments, staff, venues] = await Promise.all([
    db.timetableEntries.listForVersion(req.tenantId, versionId),
    db.staffAssignments.listForTenant(req.tenantId),
    db.staff.list(req.tenantId, {}),
    db.timetableVenues.list(req.tenantId),
  ]);
  const result = checkPlacement({ entries, assignments, staff, venues, candidate: { className, section, day, slotId, subject, staffId } });
  res.json({ data: result });
}));

timetableRouter.put('/entries', authenticate, tenantScope, permit('timetable:entries:write'), asyncRoute(async (req, res) => {
  const { versionId, className, section, day, slotId, subject, staffId, venueId } = req.body || {};
  if (!versionId || !className || !section || !day || !slotId || !subject || !staffId) throw badRequest('versionId, className, section, day, slotId, subject and staffId are required');
  const version = await db.timetableVersions.findById(req.tenantId, versionId);
  if (!version) throw notFound('Version not found');
  if (version.state === 'live') throw conflict('The live timetable cannot be edited directly — generate or edit a draft, then publish it');

  const [entries, assignments, staff, venues] = await Promise.all([
    db.timetableEntries.listForVersion(req.tenantId, versionId),
    db.staffAssignments.listForTenant(req.tenantId),
    db.staff.list(req.tenantId, {}),
    db.timetableVenues.list(req.tenantId),
  ]);
  const candidate = { className, section, day: Number(day), slotId, subject, staffId };
  const { checks, ok } = checkPlacement({ entries, assignments, staff, venues, candidate });
  if (!ok) return res.status(409).json({ error: 'This placement clashes with something else', data: { checks } });

  const resolvedVenue = venues.find((v) => v.subjects.toLowerCase().split(/[,·]/).map((s) => s.trim()).includes(subject.trim().toLowerCase()));
  const entry = await db.timetableEntries.upsertOne(req.tenantId, versionId, {
    className, section, day: Number(day), slotId, subject, staffId,
    venueId: venueId !== undefined ? venueId : (resolvedVenue?.id ?? null),
    source: 'manual',
  });
  await db.audit.record({ event: 'timetable.entryPlaced', actorId: req.auth.sub, target: entry.id, tenantId: req.tenantId });
  res.status(201).json({ data: { entry, checks } });
}));

timetableRouter.delete('/entries', authenticate, tenantScope, permit('timetable:entries:delete'), asyncRoute(async (req, res) => {
  const { versionId, className, section, day, slotId } = req.query;
  if (!versionId || !className || !section || !day || !slotId) throw badRequest('versionId, className, section, day and slotId are required');
  const version = await db.timetableVersions.findById(req.tenantId, versionId);
  if (!version) throw notFound('Version not found');
  if (version.state === 'live') throw conflict('The live timetable cannot be edited directly — generate or edit a draft, then publish it');
  const removed = await db.timetableEntries.removeOne(req.tenantId, versionId, { className, section, day: Number(day), slotId });
  if (!removed) throw notFound('Nothing was placed there');
  await db.audit.record({ event: 'timetable.entryCleared', actorId: req.auth.sub, target: `${className}-${section}`, tenantId: req.tenantId });
  res.status(204).send();
}));

// --- Auto-generate (screen 6) ---

timetableRouter.get('/runs', authenticate, tenantScope, permit('timetable:generator:read'), asyncRoute(async (req, res) => {
  res.json({ data: await db.timetableRuns.list(req.tenantId) });
}));

timetableRouter.post('/generate', authenticate, tenantScope, permit('timetable:generator:write'), asyncRoute(async (req, res) => {
  const { note = '', hardRules, softRules } = req.body || {};
  const config = await getConfig(req.tenantId);
  const [assignments, staff, venues] = await Promise.all([
    db.staffAssignments.listForTenant(req.tenantId),
    db.staff.list(req.tenantId, {}),
    db.timetableVenues.list(req.tenantId),
  ]);
  if (assignments.length === 0) throw badRequest('No subject/class assignments exist yet — add them from Teachers & Staff first');
  const staffCapacity = Object.fromEntries(staff.map((s) => [s.id, s.weeklyPeriodCapacity ?? 30]));
  const effectiveSoftRules = softRules || config.softRules || DEFAULT_SOFT_RULES;
  const effectiveHardRules = hardRules || config.hardRules || DEFAULT_HARD_RULES;

  const result = generateTimetable({
    assignments, staffCapacity, venues,
    slots: config.slots || DEFAULT_SLOTS, cycleDays: config.cycleDays || DEFAULT_CYCLE_DAYS,
    softRules: effectiveSoftRules,
  });

  const version = await db.timetableVersions.create({ tenantId: req.tenantId, note: note || `Auto-generate run — ${result.stats.placedPct}% placed`, createdBy: req.auth.sub });
  await db.timetableEntries.replaceForVersion(req.tenantId, version.id, result.entries);
  const run = await db.timetableRuns.create({
    tenantId: req.tenantId, versionId: version.id, hardRules: effectiveHardRules, softRules: effectiveSoftRules,
    totalPeriods: result.stats.totalPeriods, placedPeriods: result.stats.placedPeriods,
    note: `${result.stats.placedPct}% placed · ${result.unplaced.length} unplaced`, createdBy: req.auth.sub,
  });
  // Generated versions stay in draft — publishing is a separate, explicit step (see /versions/:id/publish).
  await db.audit.record({ event: 'timetable.generated', actorId: req.auth.sub, target: version.id, tenantId: req.tenantId, summary: result.stats });
  res.status(201).json({ data: { version, run, stats: result.stats, unplaced: result.unplaced } });
}));

// --- Clash & gap report (screen 7) ---

timetableRouter.get('/clashes', authenticate, tenantScope, permit('timetable:clashes:read'), asyncRoute(async (req, res) => {
  const version = await resolveVersion(req.tenantId, req.query.versionId);
  if (!version) return res.json({ data: { findings: [], stats: {} }, meta: { version: null } });
  const [entries, assignments, staff, venues] = await Promise.all([
    db.timetableEntries.listForVersion(req.tenantId, version.id),
    db.staffAssignments.listForTenant(req.tenantId),
    db.staff.list(req.tenantId, {}),
    db.timetableVenues.list(req.tenantId),
  ]);
  const result = scanClashes({ entries, assignments, staff, venues });
  res.json({ data: result, meta: { version } });
}));

async function applyFix(tenantId, actorId, version, finding, { entries, assignments, staff, venues }) {
  if (finding.sev === 'Clash') {
    const [dayStr, slotId] = finding.when.replace('Day ', '').split(' · ');
    const day = Number(dayStr);
    const group = entries.filter((e) => e.day === day && e.slotId === slotId &&
      (finding.who === (staff.find((s) => s.id === e.staffId) ? `${staff.find((s) => s.id === e.staffId).firstName} ${staff.find((s) => s.id === e.staffId).lastName}` : e.venueId)));
    if (group.length < 2) return false;
    const toMove = group[1];
    const alt = findAltSlotFor(toMove, entries, { day, slotId });
    if (!alt) return false;
    await db.timetableEntries.removeOne(tenantId, version.id, { className: toMove.className, section: toMove.section, day: toMove.day, slotId: toMove.slotId });
    await db.timetableEntries.upsertOne(tenantId, version.id, { ...toMove, day: alt.day, slotId: alt.slotId, source: 'manual' });
    return true;
  }
  if (finding.sev === 'Over ceiling') {
    const overStaff = staff.find((s) => `${s.firstName} ${s.lastName}` === finding.who);
    if (!overStaff) return false;
    const subject = entries.find((e) => e.staffId === overStaff.id)?.subject;
    const totals = {};
    for (const e of entries) if (e.subject === subject) totals[e.staffId] = (totals[e.staffId] || 0) + 1;
    let donorId = null;
    for (const [id, total] of Object.entries(totals)) {
      if (id === overStaff.id) continue;
      const cap = staff.find((s) => s.id === id)?.weeklyPeriodCapacity ?? 30;
      if (cap > total) { donorId = id; break; }
    }
    if (!donorId) return false;
    const toReassign = entries.find((e) => e.staffId === overStaff.id && e.subject === subject);
    if (!toReassign) return false;
    await db.timetableEntries.upsertOne(tenantId, version.id, { ...toReassign, staffId: donorId, source: 'manual' });
    return true;
  }
  return false; // No free day / Gap need a human decision -- see the finding's own `fix` text.
}

function findAltSlotFor(entry, entries, exclude) {
  const teaching = teachingSlots(DEFAULT_SLOTS);
  const busy = new Set(entries.filter((e) => e.staffId === entry.staffId).map((e) => `${e.day}|${e.slotId}`));
  const classBusy = new Set(entries.filter((e) => e.className === entry.className && e.section === entry.section).map((e) => `${e.day}|${e.slotId}`));
  for (let day = 1; day <= DEFAULT_CYCLE_DAYS; day++) {
    for (const slot of teaching) {
      if (day === exclude.day && slot.id === exclude.slotId) continue;
      const key = `${day}|${slot.id}`;
      if (!busy.has(key) && !classBusy.has(key)) return { day, slotId: slot.id };
    }
  }
  return null;
}

timetableRouter.post('/clashes/fix', authenticate, tenantScope, permit('timetable:clashes:update'), asyncRoute(async (req, res) => {
  const { versionId, finding } = req.body || {};
  if (!versionId || !finding) throw badRequest('versionId and finding are required');
  const version = await db.timetableVersions.findById(req.tenantId, versionId);
  if (!version) throw notFound('Version not found');
  const [entries, assignments, staff, venues] = await Promise.all([
    db.timetableEntries.listForVersion(req.tenantId, versionId),
    db.staffAssignments.listForTenant(req.tenantId),
    db.staff.list(req.tenantId, {}),
    db.timetableVenues.list(req.tenantId),
  ]);
  const applied = await applyFix(req.tenantId, req.auth.sub, version, finding, { entries, assignments, staff, venues });
  if (!applied) return res.status(422).json({ error: 'This finding needs a manual fix — see its suggested fix text' });
  await db.audit.record({ event: 'timetable.clashFixed', actorId: req.auth.sub, target: version.id, tenantId: req.tenantId, summary: finding });
  res.json({ data: { fixed: true } });
}));

timetableRouter.post('/clashes/fix-all', authenticate, tenantScope, permit('timetable:clashes:update'), asyncRoute(async (req, res) => {
  const { versionId } = req.body || {};
  if (!versionId) throw badRequest('versionId is required');
  const version = await db.timetableVersions.findById(req.tenantId, versionId);
  if (!version) throw notFound('Version not found');
  let fixed = 0;
  let skipped = 0;
  // Re-scans between each fix, since one applied fix changes what the
  // next scan sees (e.g. resolving a clash can also clear a ceiling).
  for (let i = 0; i < 20; i++) {
    const entries = await db.timetableEntries.listForVersion(req.tenantId, versionId);
    const [assignments, staff, venues] = await Promise.all([
      db.staffAssignments.listForTenant(req.tenantId), db.staff.list(req.tenantId, {}), db.timetableVenues.list(req.tenantId),
    ]);
    const { findings } = scanClashes({ entries, assignments, staff, venues });
    const fixable = findings.find((f) => f.sev === 'Clash' || f.sev === 'Over ceiling');
    if (!fixable) break;
    const applied = await applyFix(req.tenantId, req.auth.sub, version, fixable, { entries, assignments, staff, venues });
    if (applied) fixed++; else { skipped++; break; }
  }
  await db.audit.record({ event: 'timetable.clashesFixedAll', actorId: req.auth.sub, target: version.id, tenantId: req.tenantId, summary: { fixed, skipped } });
  res.json({ data: { fixed, skipped } });
}));

// --- Exam timetable (screen 9) -- these rows are the SAME exam_sessions
// table the separate Examinations module's Datesheet screen reads/writes
// (modules/exams/routes.js), but access here is gated by this module's
// own timetable:exams:read/write, not the Examinations module's
// exams:datesheet:* -- two real, independently-grantable ways to reach
// the same underlying data, matching how each module's own screen
// presents it. ---

timetableRouter.use('/exams', buildCrudRouter({
  collection: 'examSessions',
  viewPermission: 'timetable:exams:read',
  managePermission: 'timetable:exams:write',
  event: 'timetable.exam',
  extraListFilter: (req) => (req.query.className ? { className: req.query.className } : {}),
  validate: (body) => {
    const { className, examDate, session, subject, venue = '', seats = 0, invigilatorStaffId = null, termLabel = '' } = body;
    if (!className) throw badRequest('className is required');
    if (!validDate(examDate)) throw badRequest('examDate must be a valid YYYY-MM-DD date');
    if (!['AM', 'PM'].includes(session)) throw badRequest('session must be AM or PM');
    if (!subject || typeof subject !== 'string' || !subject.trim()) throw badRequest('subject is required');
    const seatsNum = Number(seats) || 0;
    return { className, examDate, session, subject: subject.trim(), venue: (venue || '').trim(), seats: seatsNum, invigilatorStaffId: invigilatorStaffId || null, termLabel: (termLabel || '').trim() };
  },
}));

timetableRouter.get('/exams-checks', authenticate, tenantScope, permit('timetable:exams:read'), asyncRoute(async (req, res) => {
  const { className } = req.query;
  const sessions = await db.examSessions.list(req.tenantId, className ? { className } : {});
  const byDateClass = {};
  for (const s of sessions) {
    const key = `${s.className}|${s.examDate}`;
    (byDateClass[key] ??= []).push(s);
  }
  const doubleBooked = Object.entries(byDateClass).filter(([, group]) => group.length > 1).map(([key, group]) => {
    const [cls, date] = key.split('|');
    return { className: cls, examDate: date, subjects: group.map((g) => g.subject) };
  });
  const missingInvigilator = sessions.filter((s) => !s.invigilatorStaffId);
  res.json({
    data: {
      doubleBooked,
      missingInvigilatorCount: missingInvigilator.length,
      totalSessions: sessions.length,
    },
  });
}));

// --- Substitution & relief (screen 10) ---

timetableRouter.get('/relief', authenticate, tenantScope, permit('timetable:relief:read'), asyncRoute(async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const config = await getConfig(req.tenantId);
  const dayIndex = cycleDayForDate(date, config);
  const teaching = teachingSlots(config.slots || DEFAULT_SLOTS);

  const [leave, staff, version] = await Promise.all([
    db.staffLeave.list(req.tenantId, {}),
    db.staff.list(req.tenantId, {}),
    resolveVersion(req.tenantId, null),
  ]);
  const staffById = Object.fromEntries(staff.map((s) => [s.id, s]));
  const absentLeave = leave.filter((l) => l.status !== 'declined' && l.startDate <= date && l.endDate >= date);
  const entries = version ? (await db.timetableEntries.listForVersion(req.tenantId, version.id)).filter((e) => e.day === dayIndex) : [];

  const absentStaff = [];
  const slotsOut = [];
  for (const l of absentLeave) {
    const teacher = staffById[l.staffId];
    if (!teacher) continue;
    const todaysEntries = entries.filter((e) => e.staffId === l.staffId);
    for (const entry of todaysEntries) {
      const relief = await db.timetableRelief.ensure(req.tenantId, {
        reliefDate: date, slotId: entry.slotId, className: entry.className, section: entry.section,
        subject: entry.subject, absentStaffId: l.staffId,
      });
      slotsOut.push({ relief, entry, teacher });
    }
    absentStaff.push({ leave: l, teacher, uncovered: todaysEntries.filter((e) => !slotsOut.find((s) => s.entry === e && s.relief.status === 'covered')).length });
  }

  const reliefRows = await db.timetableRelief.listForDate(req.tenantId, date);
  const absentIds = new Set(absentLeave.map((l) => l.staffId));
  const reliefPool = staff.filter((s) => s.staffType === 'Teaching' && !absentIds.has(s.id)).map((s) => {
    const bookedToday = entries.filter((e) => e.staffId === s.id).length;
    const freePeriods = Math.max(0, teaching.length - bookedToday);
    const reliefsToday = reliefRows.filter((r) => r.coverStaffId === s.id).length;
    return { staffId: s.id, name: `${s.firstName} ${s.lastName}`, department: s.department, freePeriods, reliefsToday };
  });

  const slots = slotsOut.map(({ relief, entry, teacher }) => {
    const already = reliefRows.find((r) => r.slotId === entry.slotId && r.className === entry.className && r.section === entry.section && r.reliefDate === date);
    const coverStaffId = already?.coverStaffId ?? null;
    let suggestion = null;
    if (!coverStaffId) {
      const candidates = reliefPool.filter((p) => p.freePeriods > 0 && !entries.some((e) => e.staffId === p.staffId && e.slotId === entry.slotId));
      candidates.sort((a, b) => {
        const deptA = a.department === teacher.department ? 0 : 1;
        const deptB = b.department === teacher.department ? 0 : 1;
        if (deptA !== deptB) return deptA - deptB;
        return a.reliefsToday - b.reliefsToday;
      });
      suggestion = candidates[0]?.name ?? null;
    }
    return {
      reliefId: already?.id ?? relief.id, slotId: entry.slotId, className: entry.className, section: entry.section, subject: entry.subject,
      absentStaffName: `${teacher.firstName} ${teacher.lastName}`, coverStaffId, coverStaffName: coverStaffId ? staffById[coverStaffId] ? `${staffById[coverStaffId].firstName} ${staffById[coverStaffId].lastName}` : null : suggestion,
      status: coverStaffId ? 'covered' : 'open',
      note: coverStaffId ? 'Assigned' : (suggestion ? 'Suggested — not yet assigned' : 'No free teacher found in the same department'),
    };
  });

  res.json({
    data: {
      date, dayIndex,
      absentStaff: absentStaff.map((a) => ({
        staffId: a.teacher.id, name: `${a.teacher.firstName} ${a.teacher.lastName}`, leaveType: a.leave.leaveType,
        // startDate/endDate are the real ISO values -- the admin panel formats
        // these per the tenant's Regional Format setting. dateRange stays for
        // any other consumer of this endpoint but is display-only and must
        // never be parsed back.
        startDate: a.leave.startDate, endDate: a.leave.endDate,
        dateRange: a.leave.startDate === a.leave.endDate ? a.leave.startDate : `${a.leave.startDate} – ${a.leave.endDate}`,
        department: a.teacher.department, uncovered: a.uncovered,
      })),
      slots, reliefPool,
    },
  });
}));

timetableRouter.post('/relief/:id/assign', authenticate, tenantScope, permit('timetable:relief:write'), asyncRoute(async (req, res) => {
  const { coverStaffId, note = '' } = req.body || {};
  const relief = await db.timetableRelief.findById(req.tenantId, req.params.id);
  if (!relief) throw notFound('Relief slot not found');
  const updated = await db.timetableRelief.assign(req.tenantId, req.params.id, { coverStaffId: coverStaffId || null, note });
  await db.audit.record({ event: 'timetable.reliefAssigned', actorId: req.auth.sub, target: relief.id, tenantId: req.tenantId, summary: { coverStaffId } });
  res.json({ data: updated });
}));

// Logs a real notification record without sending anything -- there is no
// email/SMS provider configured in this project, same honest-placeholder
// pattern as the Staff module's inert "Invite as user" checkbox.
timetableRouter.post('/relief/notify', authenticate, tenantScope, permit('timetable:relief:write'), asyncRoute(async (req, res) => {
  const { date } = req.body || {};
  if (!date) throw badRequest('date is required');
  const rows = await db.timetableRelief.listForDate(req.tenantId, date);
  const ids = rows.map((r) => r.id);
  const updated = await db.timetableRelief.markNotified(req.tenantId, ids);
  await db.audit.record({ event: 'timetable.reliefNotified', actorId: req.auth.sub, target: date, tenantId: req.tenantId, summary: { count: updated.length } });
  res.json({ data: { notified: updated.length } });
}));

// --- Print / export (screen 12) ---

timetableRouter.get('/export/csv', authenticate, tenantScope, permit('timetable:export:read'), asyncRoute(async (req, res) => {
  const { scope = 'all-classes', className, section, staffId } = req.query;
  const version = await resolveVersion(req.tenantId, req.query.versionId);
  if (!version) throw badRequest('No timetable version exists yet');
  const entries = await db.timetableEntries.listForVersion(req.tenantId, version.id);
  const [staff] = await Promise.all([db.staff.list(req.tenantId, {})]);
  const staffById = Object.fromEntries(staff.map((s) => [s.id, s]));

  let rows = entries;
  let filename = 'timetable_export.csv';
  if (scope === 'class') {
    if (!className || !section) throw badRequest('className and section are required for scope=class');
    rows = entries.filter((e) => e.className === className && e.section === section);
    filename = `timetable_class_${className}_${section}.csv`.replace(/\s+/g, '_');
  } else if (scope === 'teacher') {
    if (!staffId) throw badRequest('staffId is required for scope=teacher');
    rows = entries.filter((e) => e.staffId === staffId);
    filename = `timetable_teacher_${staffId}.csv`;
  }

  const csvRows = rows
    .sort((a, b) => a.day - b.day || a.slotId.localeCompare(b.slotId))
    .map((e) => ({
      day: `Day ${e.day}`, slot: e.slotId, className: e.className, section: e.section, subject: e.subject,
      teacher: staffById[e.staffId] ? `${staffById[e.staffId].firstName} ${staffById[e.staffId].lastName}` : '',
    }));
  const csv = toCsv(['day', 'slot', 'className', 'section', 'subject', 'teacher'], csvRows);
  await db.audit.record({ event: 'timetable.exported', actorId: req.auth.sub, target: version.id, tenantId: req.tenantId, summary: { scope } });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}));
