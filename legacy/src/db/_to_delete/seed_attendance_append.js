

// Attendance (designs/Teacher feature UI mockup/Attendance.dc.html, 9
// screens). The earlier decision not to seed attendance history (see
// seedStudents' header comment) was right when only the daily register
// screen existed -- there was nothing honest to show with it. Now that
// Monthly summary, Defaulters, Corrections and Trends are real screens
// whose entire point is analysing history, an empty history makes them
// impossible to verify. So this seeds five school weeks of REAL daily
// register rows (one attendance_history entry per mark, exactly as if a
// teacher had taken the register each day) for every active student, up
// to and including YESTERDAY -- today itself is deliberately left
// unmarked for every class, so "Attendance today" (screen 1) still shows
// genuine open registers rather than a fabricated "already submitted"
// state.
//
// Two students are seeded as real defaulters (below the 75% at-risk
// threshold, one with a live 3+ day absence streak) so the At-risk screen
// and its computed policy "stage" have something real to show; one of
// them already has a warning_letter intervention logged, the other is
// still at the initial "Monitoring" stage. A same-day correction and a
// backdated (8-day-old) correction request are also seeded so Corrections
// History has both an already-applied row and one sitting in the approval
// queue. actorId is left null throughout, matching how seedTimetable
// marks its own generated versions (createdBy: null) -- these are seeded
// rows, not a real person's action.
async function seedAttendance(tenantId) {
  const students = await db.students.list(tenantId, { status: 'active' });
  if (!students.length) return;

  const already = await db.attendance.findByStudent(tenantId, students[0].id);
  if (already.length) return; // idempotent across restarts, same as the other seed*() functions

  const sorted = [...students].sort((a, b) => a.admissionNumber.localeCompare(b.admissionNumber));
  const defaulterA = sorted[0]; // ends with a live 3+ day absence streak, no intervention yet -- "Monitoring"
  const defaulterB = sorted[1]; // ends present, but term percentage stays under threshold -- "Letter sent"

  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const weekdays = [];
  for (let back = 1; weekdays.length < 25; back += 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - back);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) weekdays.push(d.toISOString().slice(0, 10));
  }
  weekdays.reverse(); // oldest first, so "last 3" below really means most recent

  const mark = async (student, date, status, remark = '') => {
    await db.attendance.upsertMany(tenantId, {
      date, className: student.className, section: student.section,
      records: [{ studentId: student.id, status, remark }], actorId: null,
    });
  };

  for (const student of students) {
    const isDefaulterA = student.id === defaulterA.id;
    const isDefaulterB = student.id === defaulterB.id;
    for (let i = 0; i < weekdays.length; i += 1) {
      const date = weekdays[i];
      let status = 'present';
      if (isDefaulterA) {
        // Mostly absent, and absent for the final 4 marked days -- a real,
        // live consecutive-absence streak as of "today".
        const last4 = i >= weekdays.length - 4;
        status = last4 ? 'absent' : (i % 3 === 0 ? 'present' : 'absent');
      } else if (isDefaulterB) {
        // Chronically under the threshold without an active streak --
        // roughly half absent/late, spread through the term.
        status = i % 2 === 0 ? 'present' : (i % 4 === 1 ? 'late' : 'absent');
      } else {
        const roll = i % 10;
        status = roll < 8 ? 'present' : roll === 8 ? 'late' : 'absent';
      }
      await mark(student, date, status, status === 'absent' && Math.random() < 0.4 ? 'No note from guardian' : '');
    }
  }

  // A same-day-window correction (applied immediately, lands straight in
  // attendance_history as a real 'updated' row) -- the student was marked
  // absent, corrected to late once a guardian note arrived.
  const correctionDate = weekdays[weekdays.length - 3];
  await mark(sorted[2], correctionDate, 'absent');
  await mark(sorted[2], correctionDate, 'late', 'Guardian called in — bus delay, arrived at 9:40');

  // A backdated correction (8 days back, past the default 7-day window) --
  // seeded straight into the approval queue exactly as PUT /api/attendance
  // would have routed it, so the pending queue isn't empty on first run.
  const backdatedDate = weekdays[weekdays.length - 9];
  const priorRecords = await db.attendance.findMatching(tenantId, backdatedDate, sorted[3].className, sorted[3].section);
  const prior = priorRecords.find((r) => r.studentId === sorted[3].id);
  if (prior) {
    await db.attendanceCorrectionRequests.create({
      tenantId, studentId: sorted[3].id, date: backdatedDate, className: sorted[3].className, section: sorted[3].section,
      previousStatus: prior.status, previousRemark: prior.remark,
      requestedStatus: 'leave', requestedRemark: 'Family medical emergency — leave form submitted late',
      reason: 'Family medical emergency — leave form submitted late', requestedBy: null, requestedAt: new Date().toISOString(),
    });
  }

  // Defaulter B already has a warning letter on record; Defaulter A is
  // still at the very first policy stage with nothing logged yet.
  await db.attendanceInterventions.create({
    tenantId, studentId: defaulterB.id, type: 'warning_letter',
    note: 'First attendance warning letter sent home.', createdBy: null, createdAt: new Date().toISOString(),
  });

  // Settings: period-wise marking turned on for the Secondary phase only
  // (Class 8-12), matching the mockup's own "off by default, opt in per
  // phase" default -- everything else keeps the built-in defaults.
  await db.attendanceSettings.upsert(tenantId, { periodMarkingPhases: ['Secondary'] });
}
