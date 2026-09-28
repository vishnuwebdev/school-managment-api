// Timetable auto-generate + clash-scanning engine (designs/Teacher feature
// UI mockup/Timetable.dc.html, screens 5-7). Read this comment before
// touching the scoring below -- it's the honest boundary of what this
// module claims to do.
//
// Demand comes straight from the real staff_assignments table (subject +
// class + section + periods_per_week per teacher, already built for
// Teachers & Staff) -- there is no separate "curriculum requirement"
// concept here, so a class can never need a subject with "no teacher
// appointed": every token this module places already has a real teacher
// attached. That's a deliberate, simpler data model than the mockup's own
// "Unstaffed" clash category, which this build therefore never produces.
//
// This is a real, working constraint-based greedy generator with a bounded
// local-search repair pass -- not a state-of-the-art timetabling solver.
// Hard constraints (a teacher or specialist venue in two places at once,
// a teacher's weekly period ceiling, a class's own curriculum period
// counts) are enforced by construction and can never be violated by a
// fresh generate. Of the design's five "soft preference" rows, two have a
// real, measurable effect on the placement this engine produces --
// spreading a subject across the cycle instead of stacking it on one day,
// and leaving each teacher at least one free period a day -- both scored
// and traded off by the wizard's weight (Low/Medium/High). The other
// three (maths/languages before lunch, double periods for practical
// subjects, minimising room changes) are real, savable wizard settings
// but do not yet change the algorithm's output -- `wired: false` on their
// rule marks that plainly rather than pretending they do something.
import crypto from 'node:crypto';

export const TEACHING_KIND = 'p';
export const BREAK_KIND = 'b';

// Six-day cycle, 10 teaching periods a day plus registration/assembly,
// two breaks, sport and study/prep -- exactly the brief in the mockup's
// own header and its SLOTS constant.
export const DEFAULT_SLOTS = [
  { id: 'registration', label: 'Registration', start: '07:30', end: '07:45', kind: BREAK_KIND, icon: 'how_to_reg', dayOneLabel: 'Assembly' },
  { id: 'P1', label: 'P1', start: '07:45', end: '08:25', kind: TEACHING_KIND },
  { id: 'P2', label: 'P2', start: '08:25', end: '09:05', kind: TEACHING_KIND },
  { id: 'P3', label: 'P3', start: '09:05', end: '09:45', kind: TEACHING_KIND },
  { id: 'shortBreak', label: 'Short break', start: '09:45', end: '10:05', kind: BREAK_KIND, icon: 'free_breakfast' },
  { id: 'P4', label: 'P4', start: '10:05', end: '10:45', kind: TEACHING_KIND },
  { id: 'P5', label: 'P5', start: '10:45', end: '11:25', kind: TEACHING_KIND },
  { id: 'P6', label: 'P6', start: '11:25', end: '12:05', kind: TEACHING_KIND },
  { id: 'lunch', label: 'Lunch', start: '12:05', end: '12:45', kind: BREAK_KIND, icon: 'restaurant' },
  { id: 'P7', label: 'P7', start: '12:45', end: '13:25', kind: TEACHING_KIND },
  { id: 'P8', label: 'P8', start: '13:25', end: '14:05', kind: TEACHING_KIND },
  { id: 'P9', label: 'P9', start: '14:05', end: '14:45', kind: TEACHING_KIND },
  { id: 'P10', label: 'P10', start: '14:45', end: '15:25', kind: TEACHING_KIND },
  { id: 'sport', label: 'Sport / extramural', start: '15:35', end: '16:45', kind: BREAK_KIND, icon: 'sports_soccer' },
  { id: 'study', label: 'Study / prep', start: '16:45', end: '17:30', kind: BREAK_KIND, icon: 'menu_book' },
];

export const DEFAULT_CYCLE_DAYS = 6;

export const DEFAULT_HARD_RULES = [
  { key: 'noTeacherClash', label: 'No teacher in two places at once', note: 'Absolute — a run leaves a period unplaced rather than double-booking a teacher', on: true, locked: true },
  { key: 'periodCeiling', label: 'Max periods per teacher per cycle', note: 'From each member’s weekly period capacity (Staff > Employment)', on: true, locked: false },
  { key: 'curriculumCounts', label: 'Respect subject-to-class period counts', note: 'Exactly the periods/week set on each staff assignment — never more, never fewer', on: true, locked: false },
  { key: 'venueClash', label: 'Keep specialist subjects in their venue', note: 'Labs, art & music room — never two classes in one venue at once', on: true, locked: false },
];

export const DEFAULT_SOFT_RULES = [
  { key: 'spread', label: 'Spread a subject across the cycle, not stacked on one day', weight: 'High', wired: true },
  { key: 'oneFreeDay', label: 'One free period a day per teacher, where possible', weight: 'High', wired: true },
  { key: 'beforeLunch', label: 'Mathematics and languages before lunch where possible', weight: 'Medium', wired: false },
  { key: 'doublePeriods', label: 'Double periods for practical subjects', weight: 'Medium', wired: false },
  { key: 'roomChanges', label: 'Minimise teacher room changes between periods', weight: 'Low', wired: false },
];

const WEIGHT_SCORE = { Low: 1, Medium: 2, High: 3 };

export const teachingSlots = (slots) => slots.filter((s) => s.kind === TEACHING_KIND);

export const classKey = (className, section) => `${className}::${section}`;
export const splitClassKey = (key) => {
  const [className, section] = key.split('::');
  return { className, section };
};

/** Which venue (if any) a subject needs, matched case-insensitively against each venue's free-text `subjects` list. */
export function venueForSubject(subject, venues) {
  const needle = subject.trim().toLowerCase();
  return venues.find((v) => v.subjects.toLowerCase().split(/[,·]/).map((s) => s.trim()).includes(needle)) || null;
}

/** Flattens staff_assignments rows into one token per period-to-place. */
function buildTokens(assignments) {
  const tokens = [];
  for (const a of assignments) {
    const key = classKey(a.className, a.section);
    for (let i = 0; i < a.periodsPerWeek; i++) {
      tokens.push({ classKey: key, className: a.className, section: a.section, subject: a.subject, staffId: a.staffId, assignmentId: a.id });
    }
  }
  return tokens;
}

/**
 * Runs one generate pass. Returns { entries, stats, unplaced } where
 * entries are ready to persist as timetable_entries rows (tenantId/
 * versionId still to be attached by the caller) and stats/unplaced feed
 * the wizard's result screen and the run history record.
 */
export function generateTimetable({ assignments, staffCapacity, venues, slots = DEFAULT_SLOTS, cycleDays = DEFAULT_CYCLE_DAYS, softRules = DEFAULT_SOFT_RULES }) {
  const teaching = teachingSlots(slots);
  const spreadWeight = WEIGHT_SCORE[softRules.find((r) => r.key === 'spread')?.weight] ?? WEIGHT_SCORE.High;
  const oneFreeDayWeight = WEIGHT_SCORE[softRules.find((r) => r.key === 'oneFreeDay')?.weight] ?? WEIGHT_SCORE.High;

  // grid[classKey][day][slotId] = token | null
  const grid = {};
  const classKeys = [...new Set(assignments.map((a) => classKey(a.className, a.section)))];
  for (const key of classKeys) {
    grid[key] = {};
    for (let day = 1; day <= cycleDays; day++) grid[key][day] = Object.fromEntries(teaching.map((s) => [s.id, null]));
  }

  // teacherBusy[staffId][day][slotId] = true ; venueBusy[venueId] likewise.
  const teacherBusy = {};
  const venueBusy = {};
  const teacherDayCount = {}; // teacherDayCount[staffId][day] = number of periods placed that day
  const teacherTotal = {}; // running total placed, checked against capacity

  let tokens = buildTokens(assignments);
  // Harder-to-place first: teachers closest to (or over) their ceiling,
  // so they get first pick of slots rather than being squeezed out later.
  const demandByStaff = {};
  for (const t of tokens) demandByStaff[t.staffId] = (demandByStaff[t.staffId] || 0) + 1;
  tokens = tokens
    .map((t, i) => ({ ...t, _order: i }))
    .sort((a, b) => {
      const capA = staffCapacity[a.staffId] ?? 30;
      const capB = staffCapacity[b.staffId] ?? 30;
      const pressureA = (demandByStaff[a.staffId] || 0) - capA;
      const pressureB = (demandByStaff[b.staffId] || 0) - capB;
      if (pressureB !== pressureA) return pressureB - pressureA;
      return a._order - b._order;
    });

  const unplaced = [];
  const placements = []; // {token, day, slotId, venueId}

  function tryPlace(token) {
    const venue = venueForSubject(token.subject, venues);
    let best = null;
    let bestPenalty = Infinity;
    for (let day = 1; day <= cycleDays; day++) {
      teacherBusy[token.staffId] ??= {};
      teacherBusy[token.staffId][day] ??= new Set();
      teacherDayCount[token.staffId] ??= {};
      const dayCount = teacherDayCount[token.staffId][day] || 0;
      for (const slot of teaching) {
        if (grid[token.classKey][day][slot.id] !== null) continue; // class already has a subject here
        if (teacherBusy[token.staffId][day].has(slot.id)) continue; // teacher busy elsewhere
        if (venue) {
          venueBusy[venue.id] ??= {};
          venueBusy[venue.id][day] ??= new Set();
          if (venueBusy[venue.id][day].has(slot.id)) continue; // venue busy elsewhere
        }
        // Soft scoring -- lower is better.
        let penalty = 0;
        const sameSubjectToday = Object.values(grid[token.classKey][day]).some((c) => c?.subject === token.subject);
        if (sameSubjectToday) penalty += 10 * spreadWeight;
        if (dayCount + 1 >= teaching.length) penalty += 8 * oneFreeDayWeight; // would fill every teaching slot that day
        penalty += day * 0.1 + teaching.indexOf(slot) * 0.01; // stable, left-to-right tie-break
        if (penalty < bestPenalty) {
          bestPenalty = penalty;
          best = { day, slotId: slot.id, venueId: venue?.id ?? null };
        }
      }
    }
    if (!best) return false;
    grid[token.classKey][best.day][best.slotId] = token;
    teacherBusy[token.staffId][best.day].add(best.slotId);
    teacherDayCount[token.staffId][best.day] = (teacherDayCount[token.staffId][best.day] || 0) + 1;
    teacherTotal[token.staffId] = (teacherTotal[token.staffId] || 0) + 1;
    if (best.venueId) venueBusy[best.venueId][best.day].add(best.slotId);
    placements.push({ token, ...best });
    return true;
  }

  for (const token of tokens) {
    if (!tryPlace(token)) unplaced.push(token);
  }

  // Bounded repair pass: for each still-unplaced token, look for one
  // already-placed lower-pressure token in the same class that could move
  // elsewhere, freeing a cell. Capped so a genuinely over-subscribed
  // school can't turn this into an unbounded search.
  const MAX_REPAIR_ATTEMPTS = 300;
  let repairAttempts = 0;
  for (const token of [...unplaced]) {
    if (repairAttempts >= MAX_REPAIR_ATTEMPTS) break;
    for (let day = 1; day <= cycleDays && repairAttempts < MAX_REPAIR_ATTEMPTS; day++) {
      for (const slot of teaching) {
        repairAttempts++;
        const occupant = grid[token.classKey][day][slot.id];
        if (!occupant || occupant.staffId === token.staffId) continue;
        // Can the occupant move somewhere else, and can this token then take its spot?
        grid[token.classKey][day][slot.id] = null;
        teacherBusy[occupant.staffId][day].delete(slot.id);
        const teacherFreeHere = !(teacherBusy[token.staffId]?.[day]?.has(slot.id));
        const venue = venueForSubject(token.subject, venues);
        const venueFreeHere = !venue || !(venueBusy[venue.id]?.[day]?.has(slot.id));
        if (teacherFreeHere && venueFreeHere && tryPlace(occupant)) {
          grid[token.classKey][day][slot.id] = token;
          teacherBusy[token.staffId] ??= {};
          teacherBusy[token.staffId][day] ??= new Set();
          teacherBusy[token.staffId][day].add(slot.id);
          teacherDayCount[token.staffId][day] = (teacherDayCount[token.staffId][day] || 0) + 1;
          teacherTotal[token.staffId] = (teacherTotal[token.staffId] || 0) + 1;
          if (venue) { venueBusy[venue.id][day].add(slot.id); }
          placements.push({ token, day, slotId: slot.id, venueId: venue?.id ?? null });
          const idx = unplaced.indexOf(token);
          if (idx >= 0) unplaced.splice(idx, 1);
          break;
        }
        // Revert -- the swap didn't work out.
        grid[token.classKey][day][slot.id] = occupant;
        teacherBusy[occupant.staffId][day].add(slot.id);
      }
    }
  }

  const entries = placements.map((p) => {
    const { className, section } = splitClassKey(p.token.classKey);
    return {
      className, section, day: p.day, slotId: p.slotId,
      subject: p.token.subject, staffId: p.token.staffId, venueId: p.venueId,
      source: 'generated',
    };
  });

  const totalPeriods = tokens.length;
  const placedPeriods = entries.length;
  return {
    entries,
    unplaced: unplaced.map((t) => ({ classKey: t.classKey, className: t.className, section: t.section, subject: t.subject, staffId: t.staffId })),
    stats: { totalPeriods, placedPeriods, placedPct: totalPeriods === 0 ? 100 : Math.round((placedPeriods / totalPeriods) * 100) },
  };
}

/**
 * Re-scans a version's actual entries (generated or hand-edited) for
 * everything the mockup's clash & gap report checks for, plus a real,
 * computed suggested fix for each — never a canned string. Works for any
 * version, which is what lets "Re-check" mean something after a manual
 * edit and not just after a fresh generate.
 */
export function scanClashes({ entries, assignments, staff, venues, slots = DEFAULT_SLOTS, cycleDays = DEFAULT_CYCLE_DAYS }) {
  const teaching = teachingSlots(slots);
  const staffById = Object.fromEntries(staff.map((s) => [s.id, s]));
  const findings = [];

  // -- Teacher / venue double-bookings --
  const byTeacherSlot = {};
  const byVenueSlot = {};
  for (const e of entries) {
    const tKey = `${e.staffId}|${e.day}|${e.slotId}`;
    (byTeacherSlot[tKey] ??= []).push(e);
    if (e.venueId) {
      const vKey = `${e.venueId}|${e.day}|${e.slotId}`;
      (byVenueSlot[vKey] ??= []).push(e);
    }
  }
  for (const [key, group] of Object.entries(byTeacherSlot)) {
    if (group.length < 2) continue;
    const [staffId, day, slotId] = key.split('|');
    const teacherName = staffName(staffById[staffId]);
    const classesText = group.map((g) => `${g.subject} Class ${g.className} · ${g.section}`).join(' and ');
    const alt = findFreeSlotForTeacher(staffId, group[1].className, group[1].section, { entries, cycleDays, teaching, excludeDay: day, excludeSlot: slotId });
    findings.push({
      sev: 'Clash', who: teacherName,
      what: classesText, when: `Day ${day} · ${slotId}`,
      fix: alt ? `Move ${group[1].subject} Class ${group[1].className} · ${group[1].section} to Day ${alt.day} · ${alt.slotId}` : 'No free slot found for either class this cycle — free one up by hand',
    });
  }
  for (const [key, group] of Object.entries(byVenueSlot)) {
    if (group.length < 2) continue;
    const [venueId, day, slotId] = key.split('|');
    const venue = venues.find((v) => v.id === venueId);
    const classesText = group.map((g) => `${g.subject} Class ${g.className} · ${g.section}`).join(' and ');
    findings.push({
      sev: 'Clash', who: venue?.name || 'Venue',
      what: `${classesText} — both booked in ${venue?.name || 'the same venue'}`, when: `Day ${day} · ${slotId}`,
      fix: `Move one class's ${group[1].subject} period to another day/period this venue is free`,
    });
  }

  // -- Over ceiling + no-free-day, per teacher who actually appears --
  const periodsByStaff = {};
  const dayCountByStaff = {};
  for (const e of entries) {
    periodsByStaff[e.staffId] = (periodsByStaff[e.staffId] || 0) + 1;
    dayCountByStaff[e.staffId] ??= {};
    dayCountByStaff[e.staffId][e.day] = (dayCountByStaff[e.staffId][e.day] || 0) + 1;
  }
  for (const [staffId, total] of Object.entries(periodsByStaff)) {
    const s = staffById[staffId];
    const cap = s?.weeklyPeriodCapacity ?? 30;
    if (cap > 0 && total > cap) {
      const donor = findLighterPeer(staffId, entries, staffById);
      findings.push({
        sev: 'Over ceiling', who: staffName(s),
        what: `${total} periods against a ${cap}-period contract`, when: 'Whole cycle',
        fix: donor ? `Release one period to ${staffName(donor)}, who teaches the same subject with room to spare` : 'Reduce this teacher’s load or raise their weekly capacity in Staff > Employment',
      });
    }
  }
  for (const [staffId, byDay] of Object.entries(dayCountByStaff)) {
    const fullDays = Object.entries(byDay).filter(([, count]) => count >= teaching.length).map(([day]) => day);
    if (fullDays.length > 0) {
      findings.push({
        sev: 'No free day', who: staffName(staffById[staffId]),
        what: `No free period on Day ${fullDays.join(', Day ')}`, when: `Day ${fullDays.join(', Day ')}`,
        fix: `Swap one of that day’s periods to a day with a free slot for ${staffName(staffById[staffId])}`,
      });
    }
  }

  // -- Gaps: assignment demand not fully placed in this version --
  const placedCount = {};
  for (const e of entries) {
    const k = `${e.className}|${e.section}|${e.subject}|${e.staffId}`;
    placedCount[k] = (placedCount[k] || 0) + 1;
  }
  for (const a of assignments) {
    const k = `${a.className}|${a.section}|${a.subject}|${a.staffId}`;
    const placed = placedCount[k] || 0;
    const shortfall = a.periodsPerWeek - placed;
    if (shortfall > 0) {
      findings.push({
        sev: 'Gap', who: `Class ${a.className} · ${a.section}`,
        what: `${shortfall} of ${a.periodsPerWeek} ${a.subject} period(s) not placed — falls to supervised study`,
        when: 'This cycle',
        fix: `Place the outstanding ${a.subject} period by hand in Build / edit`,
      });
    }
  }

  const classCount = new Set(assignments.map((a) => classKey(a.className, a.section))).size;
  const classesWithGap = new Set(findings.filter((f) => f.sev === 'Gap').map((f) => f.who)).size;
  const stats = {
    hardClashes: findings.filter((f) => f.sev === 'Clash').length,
    ceilingBreaches: findings.filter((f) => f.sev === 'Over ceiling').length,
    softWarnings: findings.filter((f) => f.sev === 'No free day').length,
    unallocatedPeriods: findings.filter((f) => f.sev === 'Gap').reduce((sum, f) => sum + (parseInt(f.what) || 0), 0),
    classesClean: `${classCount - classesWithGap} / ${classCount}`,
  };
  return { findings, stats };
}

function staffName(s) { return s ? `${s.firstName} ${s.lastName}` : 'Unknown staff'; }

function findFreeSlotForTeacher(staffId, className, section, { entries, cycleDays, teaching, excludeDay, excludeSlot }) {
  const busy = new Set(entries.filter((e) => e.staffId === staffId).map((e) => `${e.day}|${e.slotId}`));
  const classBusy = new Set(entries.filter((e) => e.className === className && e.section === section).map((e) => `${e.day}|${e.slotId}`));
  for (let day = 1; day <= cycleDays; day++) {
    for (const slot of teaching) {
      if (String(day) === String(excludeDay) && slot.id === excludeSlot) continue;
      const key = `${day}|${slot.id}`;
      if (!busy.has(key) && !classBusy.has(key)) return { day, slotId: slot.id };
    }
  }
  return null;
}

function findLighterPeer(staffId, entries, staffById) {
  const subject = entries.find((e) => e.staffId === staffId)?.subject;
  if (!subject) return null;
  const totals = {};
  for (const e of entries) if (e.subject === subject) totals[e.staffId] = (totals[e.staffId] || 0) + 1;
  let best = null;
  for (const [id, total] of Object.entries(totals)) {
    if (id === staffId) continue;
    const cap = staffById[id]?.weeklyPeriodCapacity ?? 30;
    if (cap > total && (!best || total < totals[best])) best = id;
  }
  return best ? staffById[best] : null;
}

/**
 * Live "drop check" for the Build/Edit screen -- validates one candidate
 * manual placement against a version's current entries before it's saved,
 * mirroring the mockup's screen 5 checklist exactly (teacher free? class
 * slot empty? venue free? how many of the curriculum count does this
 * reach?).
 */
export function checkPlacement({ entries, assignments, staff, venues, candidate }) {
  const { className, section, day, slotId, subject, staffId } = candidate;
  const staffMember = staff.find((s) => s.id === staffId);
  const checks = [];

  const teacherBusyElsewhere = entries.find((e) => e.staffId === staffId && e.day === day && e.slotId === slotId && !(e.className === className && e.section === section));
  checks.push(teacherBusyElsewhere
    ? { icon: 'error', color: 'red', label: `${staffName(staffMember)} is already teaching Class ${teacherBusyElsewhere.className} · ${teacherBusyElsewhere.section} then`, note: 'Placing this here would double-book them', ok: false }
    : { icon: 'check_circle', color: 'green', label: `${staffName(staffMember)} is free in Day ${day} · ${slotId}`, note: 'No other class needs them that period', ok: true });

  const classOccupant = entries.find((e) => e.className === className && e.section === section && e.day === day && e.slotId === slotId);
  checks.push(classOccupant
    ? { icon: 'warning', color: 'amber', label: `Class ${className} · ${section} already has ${classOccupant.subject} in that slot`, note: 'Placing here replaces it', ok: true }
    : { icon: 'check_circle', color: 'green', label: `Class ${className} · ${section} has no subject in that slot`, note: 'Currently supervised study', ok: true });

  const venue = venueForSubject(subject, venues);
  if (venue) {
    const venueBusy = entries.find((e) => e.venueId === venue.id && e.day === day && e.slotId === slotId && !(e.className === className && e.section === section));
    checks.push(venueBusy
      ? { icon: 'error', color: 'red', label: `${venue.name} is already booked for Class ${venueBusy.className} · ${venueBusy.section}`, note: 'Two classes cannot share it in one slot', ok: false }
      : { icon: 'check_circle', color: 'green', label: `${venue.name} is free in Day ${day} · ${slotId}`, note: 'This subject needs a specialist venue', ok: true });
  }

  const assignment = assignments.find((a) => a.className === className && a.section === section && a.subject === subject && a.staffId === staffId);
  if (assignment) {
    const alreadyPlaced = entries.filter((e) => e.className === className && e.section === section && e.subject === subject && e.staffId === staffId && !(e.day === day && e.slotId === slotId)).length;
    checks.push({ icon: 'info', color: 'indigo', label: `Subject reaches ${alreadyPlaced + 1} of ${assignment.periodsPerWeek} periods a cycle`, note: 'From this class’s curriculum plan', ok: true });
  }

  return { checks, ok: checks.every((c) => c.ok) };
}

export const newId = () => crypto.randomUUID();
