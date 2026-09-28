import { Router } from 'express';
import { authenticate, tenantScope, permit } from '../../core/middleware.js';
import { asyncRoute, badRequest, conflict, notFound } from '../../core/errors.js';
import { db } from '../../db/index.js';
import { buildCrudRouter } from '../../core/crudRoutes.js';
import { teachingSlots, DEFAULT_SLOTS, DEFAULT_CYCLE_DAYS } from '../../core/timetableGenerator.js';

// Classes & Sections (designs/Teacher feature UI mockup/
// Classes and Sections.dc.html, 9 screens). This module becomes the real
// class/section registry: class_levels + class_sections are the
// authoritative list, and every place elsewhere in this codebase that
// still takes a free-text or hardcoded class name (Students' add/edit
// form, School Setup Subjects' applicableClasses, Fee Types'
// applicableClasses) is a deliberate, documented "migration due" rather
// than something this pass silently leaves inconsistent -- see the
// `/settings` endpoint's `consumers` list below for exactly which is
// which. Permissions here use the new-format classes:<page>:<action>
// catalog (core/permissionsV2.js) -- see that file's FEATURE_CATALOG
// entry for the full page/action breakdown and disclosed judgment
// calls (Levels+Sections as one page, Waitlist folded into Capacity).
//
// Class teacher is NOT a field on class_sections -- staff.classTeacherOf
// (free text "Class 9 · A", already written by the Staff module's Add
// Staff wizard) is the single source of truth, so "assign a class
// teacher" here is really "write staff.classTeacherOf", with this module
// enforcing the one-teacher-per-section invariant the Staff module's own
// free-text field never could on its own.
//
// Curriculum plan (screen 6) is real and persisted, but does NOT yet
// drive Timetable's auto-generate -- that generator still derives its
// demand from staff_assignments (see core/timetableGenerator.js). Wiring
// the generator to read class_curriculum instead is a follow-on change to
// an already-shipped module, not part of this pass -- the mockup itself
// flags this same gap ("once this registry is live, that field should
// reference these levels instead").
export const classesRouter = Router();

const PHASE_ORDER = ['Early years', 'Primary', 'Secondary'];

function classLabel(className, letter) {
  return `${className} · ${letter}`;
}

function splitClassLabel(label) {
  const [className, letter] = String(label).split('·').map((p) => p.trim());
  return { className, letter };
}

async function crossModuleReferenceCounts(tenantId, className) {
  // Timetable's real live dependency on a class is staff_assignments (the
  // generator's own demand input, see core/timetableGenerator.js) -- not
  // generated timetable_entries, which are versioned snapshots (draft/live
  // /archived). Counting or rewriting entries here would silently mutate
  // already-published timetable versions, so entries are deliberately left
  // alone; assignmentRows is the honest signal for "Timetable depends on
  // this class".
  const [students, assignments, exams, curriculum, waitlist] = await Promise.all([
    db.students.list(tenantId, { className }),
    db.staffAssignments.listForTenant(tenantId),
    db.examSessions.list(tenantId, { className }),
    db.classCurriculum.list(tenantId, { className }),
    db.classWaitlist.list(tenantId, { className }),
  ]);
  const activeStudents = students.filter((s) => s.status === 'active');
  return {
    students: activeStudents.length,
    examSittings: exams.length,
    curriculumRows: curriculum.length,
    waitlisted: waitlist.length,
    assignmentRows: assignments.filter((a) => a.className === className).length,
  };
}

async function renameClassEverywhere(tenantId, oldName, newName) {
  // Deliberately does NOT touch timetable_entries -- those are versioned,
  // generated snapshots (see the note in crossModuleReferenceCounts above)
  // and rewriting a published version's entries out from under it would be
  // a correctness bug, not a convenience. staff_assignments is Timetable's
  // real live input and is safe (and correct) to rename in place.
  if (oldName === newName) return;
  const [students, assignments, exams, curriculum, waitlist] = await Promise.all([
    db.students.list(tenantId, { className: oldName }),
    db.staffAssignments.listForTenant(tenantId),
    db.examSessions.list(tenantId, { className: oldName }),
    db.classCurriculum.list(tenantId, { className: oldName }),
    db.classWaitlist.list(tenantId, { className: oldName }),
  ]);
  await Promise.all([
    ...students.map((s) => db.students.update(tenantId, s.id, { className: newName })),
    ...assignments.filter((a) => a.className === oldName).map((a) => db.staffAssignments.update(tenantId, a.id, { className: newName })),
    ...exams.map((e) => db.examSessions.update(tenantId, e.id, { className: newName })),
    ...curriculum.map((c) => db.classCurriculum.update(tenantId, c.id, { className: newName })),
    ...waitlist.map((w) => db.classWaitlist.update(tenantId, w.id, { className: newName })),
  ]);
}

async function enrichLevel(tenantId, level, sections, staff, assignments) {
  const sectionRows = await Promise.all(sections.map(async (section) => {
    const roster = await db.students.findByClassSection(tenantId, level.name, section.letter);
    const teacher = staff.find((s) => s.isClassTeacher && s.classTeacherOf === classLabel(level.name, section.letter));
    return {
      id: section.id, letter: section.letter, capacity: section.capacity, room: section.room,
      enrolled: roster.length,
      classTeacherStaffId: teacher?.id ?? null,
      classTeacherName: teacher ? `${teacher.firstName} ${teacher.lastName}` : null,
    };
  }));
  const enrolled = sectionRows.reduce((sum, s) => sum + s.enrolled, 0);
  const capacity = sectionRows.reduce((sum, s) => sum + s.capacity, 0);
  const own = assignments.filter((a) => a.className === level.name);
  const teacherCount = new Set(own.map((a) => a.staffId)).size;
  const subjectCount = new Set(own.map((a) => a.subject)).size;
  const sectionsWithTeacher = sectionRows.filter((s) => s.classTeacherStaffId).length;
  return {
    id: level.id, name: level.name, phase: level.phase, orderIndex: level.orderIndex,
    languageOfInstruction: level.languageOfInstruction, defaultCapacity: level.defaultCapacity, status: level.status,
    sections: sectionRows, enrolled, capacity,
    sectionsWithTeacher, sectionsTotal: sectionRows.length,
    teacherCount, subjectCount,
  };
}

async function neighborLevels(tenantId, level) {
  const all = await db.classLevels.list(tenantId);
  const sorted = [...all].sort((a, b) => a.orderIndex - b.orderIndex);
  const index = sorted.findIndex((l) => l.id === level.id);
  return {
    promotesFrom: index > 0 ? sorted[index - 1] : null,
    promotesTo: index >= 0 && index < sorted.length - 1 ? sorted[index + 1] : null,
  };
}

// --- Levels (screens 1, 2, 4) ---

classesRouter.get('/levels', authenticate, tenantScope, permit('classes:levels:read'), asyncRoute(async (req, res) => {
  const [levels, staff, assignments] = await Promise.all([
    db.classLevels.list(req.tenantId),
    db.staff.list(req.tenantId, {}),
    db.staffAssignments.listForTenant(req.tenantId),
  ]);
  const data = await Promise.all(levels.map(async (level) => {
    const sections = await db.classSections.list(req.tenantId, { classLevelId: level.id });
    return enrichLevel(req.tenantId, level, sections, staff, assignments);
  }));
  res.json({ data });
}));

classesRouter.get('/levels/:id', authenticate, tenantScope, permit('classes:levels:read'), asyncRoute(async (req, res) => {
  const level = await db.classLevels.findById(req.tenantId, req.params.id);
  if (!level) throw notFound('Class level not found');
  const [sections, staff, assignments, subjects, curriculum, students] = await Promise.all([
    db.classSections.list(req.tenantId, { classLevelId: level.id }),
    db.staff.list(req.tenantId, {}),
    db.staffAssignments.listForTenant(req.tenantId),
    db.subjects.list(req.tenantId),
    db.classCurriculum.list(req.tenantId, { className: level.name }),
    db.students.list(req.tenantId, { className: level.name }),
  ]);
  const enriched = await enrichLevel(req.tenantId, level, sections, staff, assignments);
  const neighbors = await neighborLevels(req.tenantId, level);
  const own = assignments.filter((a) => a.className === level.name);

  const subjectNames = new Set([...curriculum.map((c) => c.subjectName), ...own.map((a) => a.subject)]);
  const subjectRows = [...subjectNames].sort().map((name) => {
    const subjectMeta = subjects.find((s) => s.name === name);
    const subjectAssignments = own.filter((a) => a.subject === name);
    const staffedSections = new Set(subjectAssignments.map((a) => a.section)).size;
    const totalSections = sections.length;
    const curriculumRow = curriculum.find((c) => c.subjectName === name);
    const teacherNames = [...new Set(subjectAssignments.map((a) => {
      const t = staff.find((s) => s.id === a.staffId);
      return t ? `${t.firstName} ${t.lastName}` : null;
    }).filter(Boolean))];
    return {
      name,
      type: subjectMeta?.applicableClasses?.toLowerCase().includes('core') ? 'Core' : (subjectMeta ? 'Elective' : 'Elective'),
      periodsPerCycle: curriculumRow?.periodsPerCycle ?? (subjectAssignments[0]?.periodsPerWeek ?? null),
      teacher: teacherNames.length === 0 ? 'Unassigned' : teacherNames.length === 1 ? teacherNames[0] : `${staffedSections} of ${totalSections} sections staffed`,
      status: staffedSections === 0 ? 'No teacher' : staffedSections < totalSections ? 'Partially staffed' : 'Staffed',
    };
  });

  const activeStudents = students.filter((s) => s.status === 'active');
  const genderCounts = activeStudents.reduce((acc, s) => {
    const key = s.gender || 'Unspecified';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const newThisYear = activeStudents.filter((s) => s.admissionType === 'new' || !s.admissionType).length;
  const referenced = await crossModuleReferenceCounts(req.tenantId, level.name);

  res.json({
    data: {
      ...enriched,
      promotesFrom: neighbors.promotesFrom?.name ?? null,
      promotesTo: neighbors.promotesTo?.name ?? 'Graduated',
      subjects: subjectRows,
      learnerMix: Object.entries(genderCounts).map(([label, value]) => ({ label, value, pct: activeStudents.length ? Math.round((value / activeStudents.length) * 100) : 0 })),
      usedBy: [
        { icon: 'people_alt', label: 'Students placed', value: referenced.students },
        { icon: 'calendar_month', label: 'Timetable references', value: referenced.assignmentRows },
        { icon: 'assignment', label: 'Exam sittings', value: referenced.examSittings },
        { icon: 'view_module', label: 'Curriculum rows', value: referenced.curriculumRows },
      ],
    },
  });
}));

classesRouter.post('/levels', authenticate, tenantScope, permit('classes:levels:write'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (typeof body.name !== 'string' || !body.name.trim()) throw badRequest('name is required');
  if (await db.classLevels.findByName(req.tenantId, body.name.trim())) throw conflict('A class level with this name already exists');
  const existing = await db.classLevels.list(req.tenantId);
  const orderIndex = Number.isFinite(body.orderIndex) ? body.orderIndex : existing.length;
  const level = await db.classLevels.create({
    tenantId: req.tenantId,
    name: body.name.trim(),
    phase: body.phase || 'Primary',
    orderIndex,
    languageOfInstruction: body.languageOfInstruction || 'English',
    defaultCapacity: Number.isFinite(body.defaultCapacity) ? body.defaultCapacity : 35,
    status: body.status === 'provisional' ? 'provisional' : 'active',
  });
  const sectionsIn = Array.isArray(body.sections) ? body.sections : [];
  for (const s of sectionsIn) {
    if (!s.letter) continue;
    await db.classSections.create({
      tenantId: req.tenantId, classLevelId: level.id, letter: String(s.letter).trim(),
      capacity: Number.isFinite(s.capacity) ? s.capacity : level.defaultCapacity, room: s.room || '',
    });
  }
  await db.audit.record({ event: 'classLevel.created', actorId: req.auth.sub, target: level.id, tenantId: req.tenantId });
  res.status(201).json({ data: level });
}));

// Combined level + sections save (screen 4) -- sections are declared as
// the full desired list; anything with an id is updated, anything without
// is created, and anything on the existing level not present in the
// payload is deleted (blocked with 409 if it still has enrolled students,
// matching the mockup's own "Sections with learners cannot be deleted"
// rule).
classesRouter.put('/levels/:id', authenticate, tenantScope, permit('classes:levels:update'), asyncRoute(async (req, res) => {
  const level = await db.classLevels.findById(req.tenantId, req.params.id);
  if (!level) throw notFound('Class level not found');
  const body = req.body || {};
  const newName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : level.name;
  if (newName !== level.name) {
    const clash = await db.classLevels.findByName(req.tenantId, newName);
    if (clash && clash.id !== level.id) throw conflict('A class level with this name already exists');
  }

  const existingSections = await db.classSections.list(req.tenantId, { classLevelId: level.id });
  const sectionsIn = Array.isArray(body.sections) ? body.sections : existingSections;
  const keepIds = new Set(sectionsIn.filter((s) => s.id).map((s) => s.id));
  const toDelete = existingSections.filter((s) => !keepIds.has(s.id));
  for (const section of toDelete) {
    const roster = await db.students.findByClassSection(req.tenantId, level.name, section.letter);
    if (roster.length > 0) throw conflict(`Section ${section.letter} has ${roster.length} learner(s) enrolled -- move or promote them before deleting it`);
  }

  if (newName !== level.name) await renameClassEverywhere(req.tenantId, level.name, newName);

  const updated = await db.classLevels.update(req.tenantId, level.id, {
    name: newName,
    phase: body.phase ?? level.phase,
    orderIndex: Number.isFinite(body.orderIndex) ? body.orderIndex : level.orderIndex,
    languageOfInstruction: body.languageOfInstruction ?? level.languageOfInstruction,
    defaultCapacity: Number.isFinite(body.defaultCapacity) ? body.defaultCapacity : level.defaultCapacity,
    status: body.status ?? level.status,
  });

  for (const section of toDelete) await db.classSections.remove(req.tenantId, section.id);
  for (const s of sectionsIn) {
    if (s.id) {
      await db.classSections.update(req.tenantId, s.id, {
        letter: s.letter ?? existingSections.find((e) => e.id === s.id)?.letter,
        capacity: Number.isFinite(s.capacity) ? s.capacity : undefined,
        room: s.room,
      });
    } else if (s.letter) {
      await db.classSections.create({
        tenantId: req.tenantId, classLevelId: level.id, letter: String(s.letter).trim(),
        capacity: Number.isFinite(s.capacity) ? s.capacity : updated.defaultCapacity, room: s.room || '',
      });
    }
    if (s.letter && s.classTeacherStaffId !== undefined) {
      await assignClassTeacher(req.tenantId, newName, s.letter, s.classTeacherStaffId || null);
    }
  }

  await db.audit.record({ event: 'classLevel.updated', actorId: req.auth.sub, target: level.id, tenantId: req.tenantId });
  const freshSections = await db.classSections.list(req.tenantId, { classLevelId: level.id });
  const staff = await db.staff.list(req.tenantId, {});
  const assignments = await db.staffAssignments.listForTenant(req.tenantId);
  res.json({ data: await enrichLevel(req.tenantId, updated, freshSections, staff, assignments) });
}));

classesRouter.delete('/levels/:id', authenticate, tenantScope, permit('classes:levels:delete'), asyncRoute(async (req, res) => {
  const level = await db.classLevels.findById(req.tenantId, req.params.id);
  if (!level) throw notFound('Class level not found');
  const sections = await db.classSections.list(req.tenantId, { classLevelId: level.id });
  const referenced = await crossModuleReferenceCounts(req.tenantId, level.name);
  const blockers = [];
  if (sections.length > 0) blockers.push(`${sections.length} section(s) still exist`);
  if (referenced.students > 0) blockers.push(`${referenced.students} student(s) placed`);
  if (referenced.assignmentRows > 0) blockers.push(`${referenced.assignmentRows} staff assignment row(s)`);
  if (referenced.examSittings > 0) blockers.push(`${referenced.examSittings} exam sitting(s)`);
  if (referenced.curriculumRows > 0) blockers.push(`${referenced.curriculumRows} curriculum row(s)`);
  if (blockers.length > 0) throw conflict(`Cannot delete ${level.name} -- ${blockers.join(', ')}`);
  await db.classLevels.remove(req.tenantId, level.id);
  await db.audit.record({ event: 'classLevel.deleted', actorId: req.auth.sub, target: level.id, tenantId: req.tenantId });
  res.status(204).end();
}));

// --- Sections (screens 2, 3) ---

classesRouter.post('/levels/:id/sections', authenticate, tenantScope, permit('classes:levels:write'), asyncRoute(async (req, res) => {
  const level = await db.classLevels.findById(req.tenantId, req.params.id);
  if (!level) throw notFound('Class level not found');
  const body = req.body || {};
  if (typeof body.letter !== 'string' || !body.letter.trim()) throw badRequest('letter is required');
  const existing = await db.classSections.list(req.tenantId, { classLevelId: level.id });
  if (existing.some((s) => s.letter === body.letter.trim())) throw conflict(`Section ${body.letter} already exists on ${level.name}`);
  const section = await db.classSections.create({
    tenantId: req.tenantId, classLevelId: level.id, letter: body.letter.trim(),
    capacity: Number.isFinite(body.capacity) ? body.capacity : level.defaultCapacity, room: body.room || '',
  });
  await db.audit.record({ event: 'classSection.created', actorId: req.auth.sub, target: section.id, tenantId: req.tenantId });
  res.status(201).json({ data: section });
}));

classesRouter.delete('/sections/:id', authenticate, tenantScope, permit('classes:levels:delete'), asyncRoute(async (req, res) => {
  const section = await db.classSections.findById(req.tenantId, req.params.id);
  if (!section) throw notFound('Section not found');
  const level = await db.classLevels.findById(req.tenantId, section.classLevelId);
  const roster = await db.students.findByClassSection(req.tenantId, level.name, section.letter);
  if (roster.length > 0) throw conflict(`Section ${section.letter} has ${roster.length} learner(s) enrolled -- move or promote them before deleting it`);
  await db.classSections.remove(req.tenantId, section.id);
  await db.audit.record({ event: 'classSection.deleted', actorId: req.auth.sub, target: section.id, tenantId: req.tenantId });
  res.status(204).end();
}));

classesRouter.get('/sections/:id/roster', authenticate, tenantScope, permit('classes:levels:read'), asyncRoute(async (req, res) => {
  const section = await db.classSections.findById(req.tenantId, req.params.id);
  if (!section) throw notFound('Section not found');
  const level = await db.classLevels.findById(req.tenantId, section.classLevelId);
  const { q = '', status } = req.query;
  const all = await db.students.list(req.tenantId, { className: level.name, section: section.letter, query: q, status });
  res.json({ data: all, meta: { level: level.name, section: section.letter, classTeacherLabel: classLabel(level.name, section.letter) } });
}));

classesRouter.post('/sections/:id/move', authenticate, tenantScope, permit('classes:levels:update'), asyncRoute(async (req, res) => {
  const section = await db.classSections.findById(req.tenantId, req.params.id);
  if (!section) throw notFound('Section not found');
  const { studentIds, toClassName, toSection } = req.body || {};
  if (!Array.isArray(studentIds) || studentIds.length === 0) throw badRequest('studentIds must be a non-empty array');
  if (!toClassName || !toSection) throw badRequest('toClassName and toSection are required');
  let moved = 0;
  for (const studentId of studentIds) {
    const student = await db.students.findById(req.tenantId, studentId);
    if (!student) continue;
    await db.students.update(req.tenantId, studentId, { className: toClassName, section: toSection });
    moved += 1;
  }
  const targetLevel = await db.classLevels.findByName(req.tenantId, toClassName);
  const targetSection = targetLevel ? (await db.classSections.list(req.tenantId, { classLevelId: targetLevel.id })).find((s) => s.letter === toSection) : null;
  const targetRoster = targetSection ? await db.students.findByClassSection(req.tenantId, toClassName, toSection) : [];
  await db.audit.record({ event: 'classSection.studentsMoved', actorId: req.auth.sub, target: section.id, tenantId: req.tenantId });
  res.json({
    data: {
      moved,
      overCapacity: targetSection ? targetRoster.length > targetSection.capacity : false,
      targetEnrolled: targetRoster.length,
      targetCapacity: targetSection?.capacity ?? null,
    },
  });
}));

// --- Capacity & allocation (screen 5) ---

classesRouter.get('/capacity', authenticate, tenantScope, permit('classes:capacity:read'), asyncRoute(async (req, res) => {
  const levels = await db.classLevels.list(req.tenantId);
  const rows = await Promise.all(levels.map(async (level) => {
    const sections = await db.classSections.list(req.tenantId, { classLevelId: level.id });
    const rosters = await Promise.all(sections.map((s) => db.students.findByClassSection(req.tenantId, level.name, s.letter)));
    const enrolled = rosters.reduce((sum, r) => sum + r.length, 0);
    const capacity = sections.reduce((sum, s) => sum + s.capacity, 0);
    const waitlist = await db.classWaitlist.list(req.tenantId, { className: level.name });
    const pct = capacity === 0 ? 0 : Math.round((enrolled / capacity) * 100);
    const state = pct > 100 ? 'Over' : pct >= 95 ? 'Near full' : pct < 75 ? 'Under-used' : 'Healthy';
    return { name: level.name, enrolled, capacity, open: Math.max(0, capacity - enrolled), pct, state, waitlisted: waitlist.length };
  }));
  const totalSeats = rows.reduce((s, r) => s + r.capacity, 0);
  const placed = rows.reduce((s, r) => s + r.enrolled, 0);
  const waitlisted = rows.reduce((s, r) => s + r.waitlisted, 0);
  const overCapacityCount = rows.filter((r) => r.state === 'Over').length;
  res.json({
    data: {
      rows,
      stats: { totalSeats, placed, openSeats: Math.max(0, totalSeats - placed), waitlisted, overCapacitySections: overCapacityCount },
    },
  });
}));

classesRouter.use('/waitlist', buildCrudRouter({
  collection: 'classWaitlist',
  viewPermission: 'classes:capacity:read',
  managePermission: 'classes:capacity:write',
  event: 'classWaitlist',
  extraListFilter: (req) => (req.query.className ? { className: req.query.className } : {}),
  validate: async (body) => {
    if (typeof body.className !== 'string' || !body.className.trim()) throw badRequest('className is required');
    if (typeof body.learnerName !== 'string' || !body.learnerName.trim()) throw badRequest('learnerName is required');
    return { className: body.className.trim(), learnerName: body.learnerName.trim(), note: (body.note || '').trim() };
  },
}));

async function computeRebalancePlan(tenantId, level) {
  const sections = await db.classSections.list(tenantId, { classLevelId: level.id });
  const withRoster = await Promise.all(sections.map(async (s) => ({
    section: s, roster: await db.students.findByClassSection(tenantId, level.name, s.letter),
  })));
  const moves = [];
  const over = withRoster.filter((x) => x.roster.length > x.section.capacity);
  const under = withRoster.filter((x) => x.roster.length < x.section.capacity)
    .map((x) => ({ ...x, spare: x.section.capacity - x.roster.length }));
  for (const source of over) {
    let excess = source.roster.length - source.section.capacity;
    let movable = [...source.roster];
    for (const target of under) {
      while (excess > 0 && target.spare > 0 && movable.length > 0) {
        const student = movable.pop();
        moves.push({ studentId: student.id, studentName: `${student.firstName} ${student.lastName}`, fromSection: source.section.letter, toSection: target.section.letter });
        excess -= 1;
        target.spare -= 1;
      }
    }
  }
  return moves;
}

classesRouter.post('/levels/:id/rebalance/preview', authenticate, tenantScope, permit('classes:capacity:read'), asyncRoute(async (req, res) => {
  const level = await db.classLevels.findById(req.tenantId, req.params.id);
  if (!level) throw notFound('Class level not found');
  res.json({ data: { moves: await computeRebalancePlan(req.tenantId, level) } });
}));

classesRouter.post('/levels/:id/rebalance/execute', authenticate, tenantScope, permit('classes:capacity:update'), asyncRoute(async (req, res) => {
  const level = await db.classLevels.findById(req.tenantId, req.params.id);
  if (!level) throw notFound('Class level not found');
  const moves = await computeRebalancePlan(req.tenantId, level);
  for (const move of moves) await db.students.update(req.tenantId, move.studentId, { section: move.toSection });
  await db.audit.record({ event: 'classLevel.rebalanced', actorId: req.auth.sub, target: level.id, tenantId: req.tenantId });
  res.json({ data: { moved: moves.length, moves } });
}));

// --- Curriculum plan (screen 6) ---

classesRouter.get('/curriculum', authenticate, tenantScope, permit('classes:curriculum:read'), asyncRoute(async (req, res) => {
  const [levels, subjects, curriculum, assignments, config] = await Promise.all([
    db.classLevels.list(req.tenantId),
    db.subjects.list(req.tenantId),
    db.classCurriculum.list(req.tenantId, {}),
    db.staffAssignments.listForTenant(req.tenantId),
    db.timetableConfig.get(req.tenantId),
  ]);
  const slots = config?.slots ?? DEFAULT_SLOTS;
  const cycleDays = config?.cycleDays ?? DEFAULT_CYCLE_DAYS;
  const periodsPerCycle = teachingSlots(slots).length * cycleDays;

  const rows = subjects.map((subject) => {
    const perLevel = Object.fromEntries(levels.map((level) => {
      const row = curriculum.find((c) => c.subjectName === subject.name && c.className === level.name);
      return [level.name, row?.periodsPerCycle ?? null];
    }));
    return { subject: subject.name, type: subject.applicableClasses?.toLowerCase().includes('core') ? 'Core' : 'Elective', perLevel };
  });
  const totals = Object.fromEntries(levels.map((level) => [
    level.name, rows.reduce((sum, r) => sum + (r.perLevel[level.name] || 0), 0),
  ]));

  const notes = [];
  const heaviest = levels.reduce((max, l) => (totals[l.name] > (totals[max?.name] ?? -1) ? l : max), null);
  if (heaviest) {
    if (totals[heaviest.name] > periodsPerCycle) {
      notes.push({ icon: 'error', label: `${heaviest.name} plans more periods than the cycle has`, note: `${totals[heaviest.name]} planned against ${periodsPerCycle} available per cycle.` });
    } else {
      notes.push({ icon: 'check_circle', label: 'Every level sits inside the cycle', note: `${heaviest.name} is heaviest at ${totals[heaviest.name]} of ${periodsPerCycle}.` });
    }
  }
  for (const subject of subjects) {
    for (const level of levels) {
      const planned = curriculum.find((c) => c.subjectName === subject.name && c.className === level.name)?.periodsPerCycle;
      if (!planned) continue;
      const staffedPeriods = assignments.filter((a) => a.className === level.name && a.subject === subject.name).reduce((s, a) => s + a.periodsPerWeek, 0);
      if (staffedPeriods === 0) {
        notes.push({ icon: 'error', label: `${subject.name} has no appointed teacher in ${level.name}`, note: `${planned} period(s) a cycle unstaffed.` });
      }
    }
  }

  res.json({ data: { rows, totals, periodsPerCycle, notes: notes.slice(0, 6), levels: levels.map((l) => l.name) } });
}));

classesRouter.put('/curriculum', authenticate, tenantScope, permit('classes:curriculum:update'), asyncRoute(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const existing = await db.classCurriculum.list(req.tenantId, {});
  for (const r of rows) {
    if (!r.subjectName || !r.className) continue;
    const found = existing.find((e) => e.subjectName === r.subjectName && e.className === r.className);
    const periodsPerCycle = Number.isFinite(r.periodsPerCycle) ? r.periodsPerCycle : 0;
    if (found) {
      await db.classCurriculum.update(req.tenantId, found.id, { periodsPerCycle });
    } else if (periodsPerCycle > 0) {
      await db.classCurriculum.create({ tenantId: req.tenantId, subjectName: r.subjectName, className: r.className, periodsPerCycle });
    }
  }
  await db.audit.record({ event: 'classCurriculum.updated', actorId: req.auth.sub, target: req.tenantId, tenantId: req.tenantId });
  res.json({ data: await db.classCurriculum.list(req.tenantId, {}) });
}));

// --- Class teacher assignment (screen 7) ---

async function assignClassTeacher(tenantId, className, letter, staffId) {
  const label = classLabel(className, letter);
  const staff = await db.staff.list(tenantId, {});
  const previousHolder = staff.find((s) => s.isClassTeacher && s.classTeacherOf === label && s.id !== staffId);
  if (previousHolder) await db.staff.update(tenantId, previousHolder.id, { isClassTeacher: false, classTeacherOf: null });
  if (staffId) {
    const priorAssignment = staff.find((s) => s.id === staffId);
    if (priorAssignment?.isClassTeacher && priorAssignment.classTeacherOf && priorAssignment.classTeacherOf !== label) {
      // A teacher can only be the class teacher of one section -- moving
      // them here vacates whatever section they held before.
    }
    await db.staff.update(tenantId, staffId, { isClassTeacher: true, classTeacherOf: label });
  }
}

classesRouter.get('/staff-assignments', authenticate, tenantScope, permit('classes:class-teacher:read'), asyncRoute(async (req, res) => {
  const [levels, staff, assignments] = await Promise.all([
    db.classLevels.list(req.tenantId),
    db.staff.list(req.tenantId, {}),
    db.staffAssignments.listForTenant(req.tenantId),
  ]);
  const rows = [];
  for (const level of levels) {
    const sections = await db.classSections.list(req.tenantId, { classLevelId: level.id });
    for (const section of sections) {
      const label = classLabel(level.name, section.letter);
      const teacher = staff.find((s) => s.isClassTeacher && s.classTeacherOf === label);
      const roster = await db.students.findByClassSection(req.tenantId, level.name, section.letter);
      if (!teacher) {
        rows.push({ className: level.name, section: section.letter, sectionId: section.id, teacherStaffId: null, teacher: 'Not assigned', department: null, load: null, note: `Section has ${roster.length} learner(s)`, status: 'Vacant' });
        continue;
      }
      const own = assignments.filter((a) => a.staffId === teacher.id);
      const periods = own.reduce((s, a) => s + a.periodsPerWeek, 0);
      const classes = new Set(own.map((a) => `${a.className}-${a.section}`)).size;
      rows.push({
        className: level.name, section: section.letter, sectionId: section.id, teacherStaffId: teacher.id,
        teacher: `${teacher.firstName} ${teacher.lastName}`, department: teacher.department,
        load: `${periods} / ${teacher.weeklyPeriodCapacity}`,
        note: `Teaches ${classes} class${classes === 1 ? '' : 'es'}`,
        status: periods > teacher.weeklyPeriodCapacity ? 'Over ceiling' : 'Assigned',
      });
    }
  }
  res.json({ data: rows, meta: { vacancies: rows.filter((r) => r.status === 'Vacant').length } });
}));

classesRouter.get('/staff-assignments/candidates', authenticate, tenantScope, permit('classes:class-teacher:read'), asyncRoute(async (req, res) => {
  const { sectionId } = req.query;
  const [staff, assignments] = await Promise.all([db.staff.list(req.tenantId, {}), db.staffAssignments.listForTenant(req.tenantId)]);
  const candidates = staff
    .filter((s) => s.staffType === 'Teaching' && !s.isClassTeacher)
    .map((s) => {
      const periods = assignments.filter((a) => a.staffId === s.id).reduce((sum, a) => sum + a.periodsPerWeek, 0);
      const spare = s.weeklyPeriodCapacity - periods;
      const label = spare >= 8 ? 'Best fit' : spare > 0 ? 'Tight' : 'Not eligible';
      return {
        staffId: s.id, name: `${s.firstName} ${s.lastName}`, department: s.department,
        load: `${periods} / ${s.weeklyPeriodCapacity} periods`,
        label, eligible: label !== 'Not eligible',
      };
    })
    .filter((c) => c.eligible)
    .sort((a, b) => (b.label === 'Best fit') - (a.label === 'Best fit'));
  res.json({ data: candidates.slice(0, 6), meta: { sectionId } });
}));

classesRouter.post('/sections/:id/assign-teacher', authenticate, tenantScope, permit('classes:class-teacher:update'), asyncRoute(async (req, res) => {
  const section = await db.classSections.findById(req.tenantId, req.params.id);
  if (!section) throw notFound('Section not found');
  const level = await db.classLevels.findById(req.tenantId, section.classLevelId);
  const { staffId } = req.body || {};
  if (staffId) {
    const staffMember = await db.staff.findById(req.tenantId, staffId);
    if (!staffMember) throw badRequest('Unknown staff member');
    if (staffMember.staffType !== 'Teaching') throw badRequest('Only teaching staff can be a class teacher');
  }
  await assignClassTeacher(req.tenantId, level.name, section.letter, staffId || null);
  await db.audit.record({ event: 'classSection.teacherAssigned', actorId: req.auth.sub, target: section.id, tenantId: req.tenantId });
  res.json({ data: { className: level.name, section: section.letter, staffId: staffId || null } });
}));

// --- Promotion & year rollover (screen 8) ---

classesRouter.get('/promotion/runs', authenticate, tenantScope, permit('classes:promotion:read'), asyncRoute(async (req, res) => {
  res.json({ data: await db.classPromotionRuns.list(req.tenantId) });
}));

classesRouter.get('/promotion/preview', authenticate, tenantScope, permit('classes:promotion:read'), asyncRoute(async (req, res) => {
  const levels = await db.classLevels.list(req.tenantId);
  const sorted = [...levels].sort((a, b) => a.orderIndex - b.orderIndex);
  const rows = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const from = sorted[i];
    const to = sorted[i + 1] || null;
    const students = (await db.students.list(req.tenantId, { className: from.name })).filter((s) => s.status === 'active');
    if (students.length === 0) continue;
    let capacityShort = false;
    if (to) {
      const toSections = await db.classSections.list(req.tenantId, { classLevelId: to.id });
      const toCapacity = toSections.reduce((s, x) => s + x.capacity, 0);
      const toEnrolled = (await db.students.list(req.tenantId, { className: to.name })).filter((s) => s.status === 'active').length;
      capacityShort = toEnrolled + students.length > toCapacity;
    }
    rows.push({
      from: from.name, to: to ? to.name : 'Graduated', fromId: from.id, toId: to?.id ?? null,
      learners: students.length, capacityShort,
      status: to === null ? 'Exit cohort' : capacityShort ? 'Capacity short' : 'Ready',
    });
  }
  const overCapacityLevel = await Promise.all(levels.map(async (level) => {
    const sections = await db.classSections.list(req.tenantId, { classLevelId: level.id });
    const capacity = sections.reduce((s, x) => s + x.capacity, 0);
    const enrolled = (await db.students.list(req.tenantId, { className: level.name })).filter((s) => s.status === 'active').length;
    return enrolled > capacity ? level.name : null;
  }));
  const blockers = overCapacityLevel.filter(Boolean).map((name) => `${name} is over capacity -- rebalance it before running promotion`);
  res.json({
    data: {
      rows,
      totals: {
        learners: rows.reduce((s, r) => s + r.learners, 0),
      },
      blockers,
    },
  });
}));

classesRouter.post('/promotion/execute', authenticate, tenantScope, permit('classes:promotion:write'), asyncRoute(async (req, res) => {
  const { toAcademicYearLabel = '', repeatStudentIds = [] } = req.body || {};
  const levels = await db.classLevels.list(req.tenantId);
  const sorted = [...levels].sort((a, b) => a.orderIndex - b.orderIndex);
  const repeatSet = new Set(repeatStudentIds);
  const snapshot = [];
  let movedCount = 0;
  let repeatCount = 0;
  let graduatedCount = 0;

  // Every level's active cohort is read up front, before any writes
  // happen. Without this, a student promoted from Class 3 into Class 4
  // earlier in this same loop would be picked up again once the loop
  // reaches "from = Class 4" and re-promoted -- cascading one student
  // through every subsequent grade in a single run instead of moving them
  // up exactly one level.
  const cohorts = await Promise.all(sorted.map(async (from) => ({
    from,
    students: (await db.students.list(req.tenantId, { className: from.name })).filter((s) => s.status === 'active'),
  })));

  for (let i = 0; i < sorted.length; i += 1) {
    const to = sorted[i + 1] || null;
    const { students } = cohorts[i];
    for (const student of students) {
      if (repeatSet.has(student.id)) { repeatCount += 1; continue; }
      snapshot.push({ studentId: student.id, previousClassName: student.className, previousSection: student.section, previousStatus: student.status });
      if (to) {
        await db.students.update(req.tenantId, student.id, { className: to.name, section: student.section });
        movedCount += 1;
      } else {
        await db.students.update(req.tenantId, student.id, { status: 'graduated' });
        graduatedCount += 1;
      }
    }
  }

  const currentYears = await db.academicYears.list(req.tenantId);
  const fromYear = currentYears.find((y) => y.status === 'current')?.label ?? 'current';
  const run = await db.classPromotionRuns.create({
    tenantId: req.tenantId, fromYear, toYear: toAcademicYearLabel || 'next', movedCount, repeatCount, graduatedCount,
    snapshot, executedBy: req.auth.sub,
  });
  await db.audit.record({ event: 'classPromotion.executed', actorId: req.auth.sub, target: run.id, tenantId: req.tenantId });
  res.status(201).json({ data: run });
}));

classesRouter.post('/promotion/:runId/rollback', authenticate, tenantScope, permit('classes:promotion:update'), asyncRoute(async (req, res) => {
  const run = await db.classPromotionRuns.findById(req.tenantId, req.params.runId);
  if (!run) throw notFound('Promotion run not found');
  if (run.rolledBack) throw conflict('This run has already been rolled back');
  for (const entry of run.snapshot) {
    await db.students.update(req.tenantId, entry.studentId, {
      className: entry.previousClassName, section: entry.previousSection, status: entry.previousStatus,
    });
  }
  const updated = await db.classPromotionRuns.markRolledBack(req.tenantId, run.id);
  await db.audit.record({ event: 'classPromotion.rolledBack', actorId: req.auth.sub, target: run.id, tenantId: req.tenantId });
  res.json({ data: updated });
}));

// --- Structure settings (screen 9) ---

classesRouter.get('/settings', authenticate, tenantScope, permit('classes:settings:read'), asyncRoute(async (req, res) => {
  const [settings, levels, years] = await Promise.all([
    db.classStructureSettings.get(req.tenantId),
    db.classLevels.list(req.tenantId),
    db.academicYears.list(req.tenantId),
  ]);
  const currentYear = years.find((y) => y.status === 'current');
  const phases = PHASE_ORDER.map((phase) => {
    const inPhase = levels.filter((l) => l.phase === phase).sort((a, b) => a.orderIndex - b.orderIndex);
    if (inPhase.length === 0) return null;
    const seats = new Set(inPhase.map((l) => l.defaultCapacity));
    return {
      name: phase, levels: inPhase.map((l) => l.name).join(', '),
      seats: seats.size === 1 ? `${[...seats][0]} per section` : 'Mixed seats per section',
    };
  }).filter(Boolean);

  res.json({
    data: {
      sectionLetters: settings?.sectionLetters ?? 'A,B,C,D,E',
      defaultSeats: settings?.defaultSeats ?? 35,
      defaultSeatsEarlyYears: settings?.defaultSeatsEarlyYears ?? 30,
      levelNames: levels.sort((a, b) => a.orderIndex - b.orderIndex).map((l) => l.name),
      academicYear: currentYear?.label ?? null,
      phases,
      consumers: [
        { icon: 'people_alt', name: 'Students', note: 'Admission wizard, list filters, profile edit', state: 'Migration due' },
        { icon: 'calendar_month', name: 'Timetable', note: 'Class grids, assignment matrix, print sheets', state: 'Migration due' },
        { icon: 'fact_check', name: 'Attendance', note: 'Daily register per section', state: 'Migration due' },
        { icon: 'assignment', name: 'Examinations', note: 'Sittings and mark sheets', state: 'Migration due' },
        { icon: 'settings_suggest', name: 'School Setup — Subjects', note: 'applicableClasses is still free text', state: 'Migration due' },
        { icon: 'account_balance_wallet', name: 'Fees & Payments', note: 'Fee structure per level (applicableClasses is free text)', state: 'Migration due' },
      ],
    },
  });
}));

classesRouter.put('/settings', authenticate, tenantScope, permit('classes:settings:update'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (typeof body.sectionLetters === 'string') patch.sectionLetters = body.sectionLetters;
  if (Number.isFinite(body.defaultSeats)) patch.defaultSeats = body.defaultSeats;
  if (Number.isFinite(body.defaultSeatsEarlyYears)) patch.defaultSeatsEarlyYears = body.defaultSeatsEarlyYears;
  const settings = await db.classStructureSettings.upsert(req.tenantId, patch);
  await db.audit.record({ event: 'classSettings.updated', actorId: req.auth.sub, target: req.tenantId, tenantId: req.tenantId });
  res.json({ data: settings });
}));
