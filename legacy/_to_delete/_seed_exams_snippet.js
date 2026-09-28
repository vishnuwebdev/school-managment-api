
// Examinations (designs/Teacher feature UI mockup/Examinations.dc.html,
// screens 1-9). See db/schema.sql's Examinations header and the project
// plan doc (edusphere-examinations-module-plan-2026-09-20.md) for the four
// binding decisions this module builds against.
//
// Class 5 is used throughout because among the twelve students seeded in
// seedStudents() it is the only class level with more than one populated,
// active section (three in A, one in B) -- see that function's own header
// note on className/section still being free text, not a real FK yet.
// Three genuine staff_assignments rows are added below (English,
// Mathematics, Science) so every teacher/class-teacher label in this
// module is a real lookup, never a fabricated name -- the same call
// seedClasses() already made for curriculum data, extended here to the
// two sections this module actually needs.
//
// Two cycles are seeded: an older one carried all the way through to
// Published (report cards generated, results released) so screens 7-9
// have real completed data to show, and a current one still mid-flight
// across Datesheet/Structure/Marks entry/Moderation (a draft, a
// submission, an approval and a returned sheet, plus a genuine absent and
// a genuine not-entered mark) so screens 3-6 show every real status a
// sheet or a mark can be in. A fourth subject on the current cycle
// (Hindi) is left with an incomplete component split and no scheduled
// paper on purpose -- a real, honest "entry closed / unscheduled" state,
// not a gap that was missed.
async function seedExams(tenantId) {
  if ((await db.examCycles.list(tenantId)).length > 0) return;

  const CLASS = 'Class 5';
  const allStaff = await db.staff.list(tenantId, {});
  const byEmp = Object.fromEntries(allStaff.map((s) => [s.employeeId, s]));

  const ensureAssignment = async (employeeId, subject, section, periodsPerWeek, role = 'Subject') => {
    const staffMember = byEmp[employeeId];
    if (!staffMember) return;
    const existing = await db.staffAssignments.listForStaff(tenantId, staffMember.id);
    if (existing.some((a) => a.className === CLASS && a.section === section && a.subject === subject)) return;
    await db.staffAssignments.create({ tenantId, staffId: staffMember.id, subject, className: CLASS, section, periodsPerWeek, role });
  };
  await ensureAssignment('EMP-0156', 'English', 'A', 6);
  await ensureAssignment('EMP-0156', 'English', 'B', 6);
  await ensureAssignment('EMP-0188', 'Mathematics', 'A', 8, 'Class teacher');
  await ensureAssignment('EMP-0188', 'Mathematics', 'B', 8);
  await ensureAssignment('EMP-0163', 'Science', 'A', 6);
  await ensureAssignment('EMP-0163', 'Science', 'B', 6);
  const naledi = byEmp['EMP-0188'];
  if (naledi && naledi.classTeacherOf !== `${CLASS} · A`) {
    await db.staff.update(tenantId, naledi.id, { isClassTeacher: true, classTeacherOf: `${CLASS} · A` });
  }

  const studentsA = await db.students.findByClassSection(tenantId, CLASS, 'A');
  const studentsB = await db.students.findByClassSection(tenantId, CLASS, 'B');
  const byFirstName = (list, first) => list.find((s) => s.firstName === first);
  const aarav = byFirstName(studentsA, 'Aarav');
  const meera = byFirstName(studentsA, 'Meera');
  const ananya = byFirstName(studentsA, 'Ananya');
  const diya = byFirstName(studentsB, 'Diya');

  const school = await db.schools.findById(tenantId);
  const fatima = byEmp['EMP-0194'];
  const bongani = byEmp['EMP-0201'];

  const makeStructure = async (cycleId, subjectName, maxMarks, passMarks, components) => {
    const structure = await db.examStructure.create({ tenantId, cycleId, className: CLASS, subjectName, maxMarks, passMarks, weight: 1 });
    for (const [i, c] of components.entries()) {
      await db.examStructureComponents.create({ tenantId, structureId: structure.id, name: c.name, maxMarks: c.maxMarks, passMarks: c.passMarks ?? 0, orderIndex: i });
    }
    return structure;
  };

  // Mirrors the real PUT /cycles/:id/marks logic closely enough for seed
  // purposes: a student passed with no components entered gets a genuine
  // "not_entered" row (not silently skipped), `absent: true` gets a real
  // "absent" row, and a below-pass total gets flagged exactly like the
  // live route would.
  const enterMarks = async (marksheet, structure, entries) => {
    for (const { student, componentMarks = {}, absent } of entries) {
      let total = null; let flag = null;
      if (absent) {
        flag = 'absent';
      } else {
        const values = Object.values(componentMarks);
        if (!values.length) {
          flag = 'not_entered';
        } else {
          total = values.reduce((a, b) => a + b, 0);
          if (total < structure.passMarks) flag = 'below_pass';
        }
      }
      const grade = total != null ? await gradeForPercentage(tenantId, (total / structure.maxMarks) * 100) : null;
      await db.examMarks.create({ tenantId, marksheetId: marksheet.id, studentId: student.id, componentMarks: absent ? {} : componentMarks, total, grade, flag, remark: '' });
    }
    const allMarks = await db.examMarks.list(tenantId, { marksheetId: marksheet.id });
    const stats = computeMarksheetStats(allMarks);
    const passRatePct = passRateFor(allMarks, structure.passMarks);
    await db.examMarksheets.update(tenantId, marksheet.id, { mean: stats.mean, passRatePct, flags: stats.flags });
  };

  // ---- Cycle 1: completed & published -- real results/report cards/audit/parent-preview data ----
  const cycle1 = await db.examCycles.create({
    tenantId, name: 'Unit Test 1', academicTerm: 'Term 2', examType: 'Class test',
    windowOpens: '2026-06-01', windowCloses: '2026-06-05', weightInTermMark: 10,
    classNames: [CLASS], marksEntryCloses: '2026-06-12', entryRolePolicy: 'assigned_teacher',
    stage: 'marking', createdBy: null,
  });
  await db.examAuditLog.record({ event: 'Cycle created', actorId: null, target: cycle1.id, tenantId, cycleId: cycle1.id, detail: `${cycle1.name} created` });

  const c1English = await makeStructure(cycle1.id, 'English', 100, 35, [{ name: 'Theory', maxMarks: 80 }, { name: 'Practical', maxMarks: 20 }]);
  const c1Math = await makeStructure(cycle1.id, 'Mathematics', 100, 35, [{ name: 'Theory', maxMarks: 80 }, { name: 'Practical', maxMarks: 20 }]);

  await db.examSessions.create({ tenantId, cycleId: cycle1.id, className: CLASS, examDate: '2026-06-02', session: 'AM', subject: 'English', venue: 'Hall A', seats: 40, invigilatorStaffId: fatima?.id ?? null, termLabel: cycle1.name, periodSlotId: 'P1', durationMinutes: 90, sectionsIncluded: ['A', 'B'] });
  await db.examSessions.create({ tenantId, cycleId: cycle1.id, className: CLASS, examDate: '2026-06-04', session: 'AM', subject: 'Mathematics', venue: 'Hall A', seats: 40, invigilatorStaffId: bongani?.id ?? null, termLabel: cycle1.name, periodSlotId: 'P1', durationMinutes: 90, sectionsIncluded: ['A', 'B'] });

  const c1EnglishA = await db.examMarksheets.create({ tenantId, cycleId: cycle1.id, className: CLASS, section: 'A', subjectName: 'English', teacherStaffId: byEmp['EMP-0156']?.id ?? null, status: 'draft' });
  await enterMarks(c1EnglishA, c1English, [
    { student: aarav, componentMarks: { Theory: 62, Practical: 16 } },
    { student: meera, componentMarks: { Theory: 68, Practical: 17 } },
    { student: ananya, componentMarks: { Theory: 42, Practical: 13 } },
  ]);
  const c1EnglishB = await db.examMarksheets.create({ tenantId, cycleId: cycle1.id, className: CLASS, section: 'B', subjectName: 'English', teacherStaffId: byEmp['EMP-0156']?.id ?? null, status: 'draft' });
  await enterMarks(c1EnglishB, c1English, [{ student: diya, componentMarks: { Theory: 72, Practical: 18 } }]);

  const c1MathA = await db.examMarksheets.create({ tenantId, cycleId: cycle1.id, className: CLASS, section: 'A', subjectName: 'Mathematics', teacherStaffId: byEmp['EMP-0188']?.id ?? null, status: 'draft' });
  await enterMarks(c1MathA, c1Math, [
    { student: aarav, componentMarks: { Theory: 70, Practical: 18 } },
    { student: meera, componentMarks: { Theory: 60, Practical: 16 } },
    { student: ananya, componentMarks: { Theory: 22, Practical: 8 } }, // 30 -- below the 35 pass mark
  ]);
  const c1MathB = await db.examMarksheets.create({ tenantId, cycleId: cycle1.id, className: CLASS, section: 'B', subjectName: 'Mathematics', teacherStaffId: byEmp['EMP-0188']?.id ?? null, status: 'draft' });
  await enterMarks(c1MathB, c1Math, [{ student: diya, componentMarks: { Theory: 76, Practical: 19 } }]);

  for (const sheet of [c1EnglishA, c1EnglishB, c1MathA, c1MathB]) {
    await db.examMarksheets.update(tenantId, sheet.id, { status: 'submitted', submittedBy: null, submittedAt: '2026-06-06T09:00:00.000Z' });
    await db.examMarksheets.update(tenantId, sheet.id, { status: 'approved', decidedBy: null, decidedAt: '2026-06-07T09:00:00.000Z' });
    await db.examAuditLog.record({ event: 'Sheet approved', actorId: null, cycleId: cycle1.id, tenantId, target: sheet.id, detail: `${sheet.className}·${sheet.section} ${sheet.subjectName} approved` });
  }

  // Class-teacher comments -- Class 5 A has a real class teacher (Naledi,
  // assigned above); Class 5 B genuinely has none yet, so her comment
  // there is filed with no classTeacherStaffId -- the same honest gap
  // documented everywhere else in this codebase rather than a fabricated
  // link.
  const comments1 = [
    [aarav, 'Consistent effort all term; keep practising mental maths.'],
    [meera, 'Excellent participation in class discussions.'],
    [ananya, 'Struggling with core Maths concepts -- recommend extra support sessions.'],
    [diya, 'Settling in well this term, good improvement in written work.'],
  ];
  for (const [student, comment] of comments1) {
    const teacher = await classTeacherFor(tenantId, CLASS, student.section);
    await db.examReportComments.upsert(tenantId, { cycleId: cycle1.id, studentId: student.id, className: CLASS, comment, classTeacherStaffId: teacher?.staffId ?? null });
  }

  // Real per-learner PDFs, generated exactly the way the API's own
  // report-cards/generate route does (same service functions).
  const allC1Students = [...studentsA, ...studentsB];
  const allC1Comments = await db.examReportComments.list(tenantId, { cycleId: cycle1.id });
  let reportCounter = 1;
  for (const student of allC1Students) {
    const rows = [];
    let scoredMax = 0; let scoredTotal = 0;
    for (const [structure, sheetA, sheetB] of [[c1English, c1EnglishA, c1EnglishB], [c1Math, c1MathA, c1MathB]]) {
      const sheet = student.section === 'A' ? sheetA : sheetB;
      const marks = await db.examMarks.list(tenantId, { marksheetId: sheet.id });
      const mark = marks.find((m) => m.studentId === student.id);
      const gradeMean = await gradeWideMean(tenantId, cycle1.id, CLASS, structure.subjectName, null);
      rows.push({
        subject: structure.subjectName,
        mark: mark?.total != null ? `${mark.total} / ${structure.maxMarks}` : 'Pending',
        grade: mark?.grade || '—', mean: gradeMean != null ? String(gradeMean) : '—', comment: mark?.remark || '',
      });
      if (mark?.total != null) { scoredMax += structure.maxMarks; scoredTotal += Number(mark.total); }
    }
    const aggregatePct = scoredMax ? Number((scoredTotal * 100 / scoredMax).toFixed(1)) : null;
    const history = await db.attendance.findByStudent(tenantId, student.id);
    const attendancePct = computePercentage(history);
    const own = allC1Comments.find((c) => c.studentId === student.id);
    const classTeacher = own?.classTeacherStaffId ? await db.staff.findById(tenantId, own.classTeacherStaffId) : null;
    const buffer = await generateReportCardPdf({
      tenant: school, cycle: cycle1, student, className: CLASS, section: student.section, rows,
      aggregatePct, position: null, totalLearners: allC1Students.length, attendancePct,
      classTeacherName: classTeacher ? `${classTeacher.firstName} ${classTeacher.lastName}` : null,
      classTeacherComment: own?.comment || '', reportNo: `R-Class5-${String(reportCounter).padStart(3, '0')}`,
    });
    reportCounter += 1;
    await storeReportCardPdf(tenantId, student.id, buffer, null);
  }
  await db.examAuditLog.record({ event: 'Report cards generated', actorId: null, cycleId: cycle1.id, tenantId, target: cycle1.id, detail: `${allC1Students.length} report card(s) generated for ${CLASS}` });

  await db.examCycles.update(tenantId, cycle1.id, { stage: 'published', publishSettings: { showGradeWideAverage: true, showAttendance: true }, updatedAt: new Date().toISOString() });
  await db.examAuditLog.record({ event: 'Results published', actorId: null, cycleId: cycle1.id, tenantId, target: cycle1.id, detail: `${cycle1.name} released to parent portal (4 approved marksheets)` });
  await db.audit.record({ event: 'exams.resultsPublished', actorId: null, target: cycle1.id, tenantId, summary: { approvedCount: 4 } });

  // ---- Cycle 2: current, mid-flight -- real Datesheet/Structure/Marks entry/Moderation data ----
  const cycle2 = await db.examCycles.create({
    tenantId, name: 'Mid-Term Examination', academicTerm: 'Term 2', examType: 'Mid-term',
    windowOpens: '2026-09-01', windowCloses: '2026-09-15', weightInTermMark: 30,
    classNames: [CLASS], marksEntryCloses: '2026-09-30', entryRolePolicy: 'assigned_teacher',
    stage: 'marking', createdBy: null,
  });
  await db.examAuditLog.record({ event: 'Cycle created', actorId: null, target: cycle2.id, tenantId, cycleId: cycle2.id, detail: `${cycle2.name} created` });

  const c2English = await makeStructure(cycle2.id, 'English', 100, 35, [{ name: 'Theory', maxMarks: 80 }, { name: 'Practical', maxMarks: 20 }]);
  const c2Math = await makeStructure(cycle2.id, 'Mathematics', 100, 35, [{ name: 'Theory', maxMarks: 80 }, { name: 'Practical', maxMarks: 20 }]);
  const c2Science = await makeStructure(cycle2.id, 'Science', 50, 18, [{ name: 'Theory', maxMarks: 35 }, { name: 'Practical', maxMarks: 15 }]);
  // Hindi's components are left deliberately short of its own maximum (30
  // of 50) -- a real, still-incomplete structure, so Overview's "structure
  // incomplete" blocker and the Datesheet's "Unscheduled" row both have
  // something genuine to show, exactly like an admin who hasn't finished
  // setting it up yet.
  await makeStructure(cycle2.id, 'Hindi', 50, 18, [{ name: 'Written', maxMarks: 30 }]);

  await db.examSessions.create({ tenantId, cycleId: cycle2.id, className: CLASS, examDate: '2026-09-08', session: 'AM', subject: 'English', venue: 'Hall A', seats: 40, invigilatorStaffId: fatima?.id ?? null, termLabel: cycle2.name, periodSlotId: 'P1', durationMinutes: 90, sectionsIncluded: ['A', 'B'] });
  await db.examSessions.create({ tenantId, cycleId: cycle2.id, className: CLASS, examDate: '2026-09-10', session: 'AM', subject: 'Mathematics', venue: 'Hall A', seats: 40, invigilatorStaffId: bongani?.id ?? null, termLabel: cycle2.name, periodSlotId: 'P1', durationMinutes: 90, sectionsIncluded: ['A', 'B'] });
  await db.examSessions.create({ tenantId, cycleId: cycle2.id, className: CLASS, examDate: '2026-09-12', session: 'PM', subject: 'Science', venue: 'Lab 1', seats: 40, invigilatorStaffId: fatima?.id ?? null, termLabel: cycle2.name, periodSlotId: 'P6', durationMinutes: 60, sectionsIncluded: ['A', 'B'] });
  await db.examAuditLog.record({ event: 'Datesheet published', actorId: null, target: cycle2.id, tenantId, cycleId: cycle2.id, detail: 'Marks entry is now open' });

  const c2EnglishA = await db.examMarksheets.create({ tenantId, cycleId: cycle2.id, className: CLASS, section: 'A', subjectName: 'English', teacherStaffId: byEmp['EMP-0156']?.id ?? null, status: 'draft' });
  await enterMarks(c2EnglishA, c2English, [
    { student: aarav, componentMarks: { Theory: 65, Practical: 17 } },
    { student: meera, componentMarks: { Theory: 70, Practical: 18 } },
    { student: ananya, componentMarks: { Theory: 45, Practical: 14 } },
  ]);
  await db.examMarksheets.update(tenantId, c2EnglishA.id, { status: 'submitted', submittedBy: null, submittedAt: '2026-09-13T09:00:00.000Z' });
  await db.examMarksheets.update(tenantId, c2EnglishA.id, { status: 'approved', decidedBy: null, decidedAt: '2026-09-14T09:00:00.000Z' });
  await db.examAuditLog.record({ event: 'Sheet approved', actorId: null, cycleId: cycle2.id, tenantId, target: c2EnglishA.id, detail: `${CLASS}·A English approved` });

  const c2EnglishB = await db.examMarksheets.create({ tenantId, cycleId: cycle2.id, className: CLASS, section: 'B', subjectName: 'English', teacherStaffId: byEmp['EMP-0156']?.id ?? null, status: 'draft' });
  await enterMarks(c2EnglishB, c2English, [{ student: diya, componentMarks: { Theory: 74, Practical: 19 } }]);
  await db.examMarksheets.update(tenantId, c2EnglishB.id, { status: 'submitted', submittedBy: null, submittedAt: '2026-09-13T10:00:00.000Z' });
  await db.examAuditLog.record({ event: 'Sheet submitted', actorId: null, cycleId: cycle2.id, tenantId, target: c2EnglishB.id, detail: `${CLASS}·B English submitted` });

  const c2MathA = await db.examMarksheets.create({ tenantId, cycleId: cycle2.id, className: CLASS, section: 'A', subjectName: 'Mathematics', teacherStaffId: byEmp['EMP-0188']?.id ?? null, status: 'draft' });
  await enterMarks(c2MathA, c2Math, [
    { student: aarav, componentMarks: { Theory: 72, Practical: 18 } },
    { student: meera, componentMarks: { Theory: 58, Practical: 15 } },
    { student: ananya, componentMarks: {}, absent: true },
  ]);
  await db.examMarksheets.update(tenantId, c2MathA.id, { status: 'submitted', submittedBy: null, submittedAt: '2026-09-13T11:00:00.000Z' });
  await db.examMarksheets.update(tenantId, c2MathA.id, { status: 'returned', decidedBy: null, decidedAt: '2026-09-14T09:30:00.000Z', reviewerNote: 'Please confirm Ananya’s absent mark against the invigilator’s sheet before resubmitting.' });
  await db.examAuditLog.record({ event: 'Sheet returned', actorId: null, cycleId: cycle2.id, tenantId, target: c2MathA.id, detail: `${CLASS}·A Mathematics returned -- confirm Ananya's absence` });

  // Mathematics B is left in draft -- the teacher hasn't submitted yet, a
  // real, ordinary "still being marked" state.
  const c2MathB = await db.examMarksheets.create({ tenantId, cycleId: cycle2.id, className: CLASS, section: 'B', subjectName: 'Mathematics', teacherStaffId: byEmp['EMP-0188']?.id ?? null, status: 'draft' });
  await enterMarks(c2MathB, c2Math, [{ student: diya, componentMarks: { Theory: 66, Practical: 17 } }]);

  // Ananya's Science mark is entered as a genuine explicit blank
  // ("not_entered", distinct from "absent") so the Marks entry screen's
  // blank count has something real to show.
  const c2ScienceA = await db.examMarksheets.create({ tenantId, cycleId: cycle2.id, className: CLASS, section: 'A', subjectName: 'Science', teacherStaffId: byEmp['EMP-0163']?.id ?? null, status: 'draft' });
  await enterMarks(c2ScienceA, c2Science, [
    { student: aarav, componentMarks: { Theory: 26, Practical: 11 } },
    { student: meera, componentMarks: { Theory: 30, Practical: 12 } },
    { student: ananya, componentMarks: {} },
  ]);
  await db.examMarksheets.update(tenantId, c2ScienceA.id, { status: 'submitted', submittedBy: null, submittedAt: '2026-09-13T12:00:00.000Z' });
  await db.examAuditLog.record({ event: 'Sheet submitted', actorId: null, cycleId: cycle2.id, tenantId, target: c2ScienceA.id, detail: `${CLASS}·A Science submitted` });

  // Science B genuinely has nothing entered yet -- a plain, still-open
  // draft, left exactly as the GET marks endpoint would first create it.
  await db.examMarksheets.create({ tenantId, cycleId: cycle2.id, className: CLASS, section: 'B', subjectName: 'Science', teacherStaffId: byEmp['EMP-0163']?.id ?? null, status: 'draft' });
}
