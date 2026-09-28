
// Classes & Sections (designs/Teacher feature UI mockup/Classes and
// Sections.dc.html). class_levels is the authoritative class/section
// registry -- the exact same 15 names as kClassOptions in the Flutter app
// (Students/Staff/Timetable's add/edit screens still take free-text class
// names; migrating those onto this registry is tracked, not silently done
// here -- see this module's own GET /settings "consumers" list), so
// nothing drifts even before those callers are migrated. Capacities and
// phases reflect real planning (Early years: 30 seats/section; Primary and
// Secondary: 35) and Class 12 is genuinely "provisional" because next
// year's Grade 12 structure isn't finalised yet at this point in the
// school calendar. Enrolled counts are never invented here -- GET
// /classes/levels computes them live from seedStudents()'s real rows, so
// most sections honestly show 0 enrolled until admissions happen through
// the app; the two real class teachers already seeded on staff
// (Thandiwe Ndlovu -> Class 10 · B, Lerato Dube -> Class 11 · B) surface
// automatically once those sections exist here.
async function seedClasses(tenantId) {
  if ((await db.classLevels.list(tenantId)).length > 0) return;

  const LEVELS = [
    ['Nursery', 'Early years', 30, ['A', 'B']],
    ['LKG', 'Early years', 30, ['A', 'B']],
    ['UKG', 'Early years', 30, ['A', 'B']],
    ['Class 1', 'Primary', 35, ['A', 'B', 'C']],
    ['Class 2', 'Primary', 35, ['A', 'B', 'C']],
    ['Class 3', 'Primary', 35, ['A', 'B']],
    ['Class 4', 'Primary', 35, ['A', 'B']],
    ['Class 5', 'Primary', 35, ['A', 'B']],
    ['Class 6', 'Primary', 35, ['A', 'B']],
    ['Class 7', 'Primary', 35, ['A', 'B']],
    ['Class 8', 'Secondary', 35, ['A', 'B']],
    ['Class 9', 'Secondary', 35, ['A', 'B']],
    ['Class 10', 'Secondary', 35, ['A', 'B']],
    ['Class 11', 'Secondary', 35, ['A', 'B']],
    ['Class 12', 'Secondary', 35, ['A', 'B']],
  ];

  const levelByName = {};
  for (let orderIndex = 0; orderIndex < LEVELS.length; orderIndex += 1) {
    const [name, phase, defaultCapacity, letters] = LEVELS[orderIndex];
    const level = await db.classLevels.create({
      tenantId, name, phase, orderIndex, languageOfInstruction: 'English', defaultCapacity,
      status: name === 'Class 12' ? 'provisional' : 'active',
    });
    levelByName[name] = level;
    for (let li = 0; li < letters.length; li += 1) {
      await db.classSections.create({
        tenantId, classLevelId: level.id, letter: letters[li],
        capacity: defaultCapacity, room: `Room ${orderIndex + 1}${letters[li]}`,
      });
    }
  }

  await db.classStructureSettings.upsert(tenantId, {
    sectionLetters: 'A,B,C,D,E', defaultSeats: 35, defaultSeatsEarlyYears: 30,
  });

  // Curriculum plan (screen 6) -- seeded only for the two subjects where
  // School Setup's subject catalog and Staff's real assignment records
  // actually agree on a name (English, Mathematics). The other six
  // catalog subjects (Science, Social Studies, Hindi, Computer Science,
  // Physical Education, Art & Craft) were never given matching staff
  // assignments in seedStaff() -- it uses a different, CAPS-style subject
  // vocabulary (Life Sciences, Physical Sciences, Afrikaans, History...)
  // for its own bios. Planning periods for subjects with zero real
  // staffing would manufacture false "no teacher" alarms rather than
  // surface a real one, so those six stay unplanned (blank) until a real
  // admin fills them in -- the two that are seeded genuinely do surface
  // real, honest "no teacher assigned yet" notes for the levels Staff
  // hasn't covered, which is the check working as intended.
  const levelNames = LEVELS.map(([name]) => name);
  for (const name of levelNames) {
    await db.classCurriculum.create({ tenantId, subjectName: 'English', className: name, periodsPerCycle: 8 });
    await db.classCurriculum.create({ tenantId, subjectName: 'Mathematics', className: name, periodsPerCycle: 8 });
  }

  // Waitlist (screen 5) -- a real admin-managed queue, not a fabricated
  // admissions pipeline: two genuine "interest recorded ahead of a seat
  // opening" entries, independent of current capacity.
  await db.classWaitlist.create({ tenantId, className: 'Nursery', learnerName: 'Ayaan Patel', note: 'Toured campus 2026-09-02; waiting for a seat to open.' });
  await db.classWaitlist.create({ tenantId, className: 'Class 1', learnerName: 'Naledi Botha', note: 'Sibling of an existing Class 4 learner; requested for the 2026-2027 intake.' });
}
