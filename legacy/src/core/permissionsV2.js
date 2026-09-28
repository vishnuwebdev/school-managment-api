// The new-format permission catalog: feature:page:action, strictly one of
// read/write/update/delete per capability (see the RBAC plan doc). This
// file is additive during the migration -- core/permissions.js's old flat
// catalog stays in place and stays authoritative for every module that
// hasn't been migrated yet. Only Dashboard and School Setup are modelled
// here so far; a future module's migration adds its own entry to
// FEATURE_CATALOG and nothing else needs to change for it to become
// assignable to a role and checked live by permit().
//
// Dashboard has no dedicated backend endpoints of its own (it composes
// existing students/attendance reads) -- its "page" is a single overview,
// gated by a real (if minimal) GET /api/dashboard/access route added
// alongside this catalog specifically so the permission has a real
// server-side enforcement point rather than being a client-only nav hide.
//
// School Setup's backend already treats the whole profile as one
// resource (GET /profile, PUT /profile/:section) regardless of which of
// the 9 UI tabs is being edited, so this pass keeps that same
// granularity here (one "profile" page) rather than inventing a
// per-tab permission the backend can't actually distinguish -- a
// disclosed simplification, not an oversight.
export const FEATURE_CATALOG = {
  dashboard: {
    label: 'Dashboard',
    pages: {
      overview: { label: 'Overview', actions: ['read'] },
    },
  },
  'school-setup': {
    label: 'School Setup',
    pages: {
      profile: { label: 'School Profile', actions: ['read', 'update'] },
    },
  },
  // Students (Phase 2 pilot -- see the RBAC plan doc). "page" here means
  // whatever the smallest independently-useful capability is, not
  // literally one screen -- the profile's own UI tabs (Overview/Personal)
  // share the read/update backend calls they already share today, so they
  // stay one page; Withdraw and Transfer are one page too because the
  // real app presents them as a single "Withdraw/Transfer" action and
  // nothing in the backend treats them differently. Two real, disclosed
  // changes from today's model: Archive is split out from
  // Withdraw/Transfer (today both ride on one 'students.archive'
  // permission), and Documents + Reports get their OWN Students-scoped
  // permissions instead of borrowing the platform-wide Documents
  // module's -- so restricting a role to "documents for students only"
  // is actually possible, which it wasn't before.
  students: {
    label: 'Students',
    pages: {
      profile: { label: 'Profile (list, view, create, edit)', actions: ['read', 'write', 'update'] },
      archive: { label: 'Archive', actions: ['delete'] },
      'withdraw-transfer': { label: 'Withdraw / Transfer', actions: ['update'] },
      documents: { label: 'Documents', actions: ['read', 'write', 'delete'] },
      import: { label: 'Bulk import', actions: ['write'] },
      reports: { label: 'Reports & export', actions: ['read'] },
    },
  },
  // Attendance (Phase 2). The module already ships all 9 mockup screens
  // with real backend endpoints per screen -- so unlike Students, "page"
  // here maps closely to the actual screens rather than needing to merge
  // several UI tabs onto one shared backend call. Two dedicated
  // permissions the old model already carved out as their own strings
  // (attendance.correction.approve, attendance.settings.manage) become
  // ordinary update actions on their own page here, since the CRUD-only
  // rule has no room for a bespoke ".approve"/".manage" verb.
  // 'learner-record' is deliberately reused, unchanged in spirit, by the
  // Student profile's Attendance tab (see the students feature entry
  // above) -- that tab's data genuinely belongs to Attendance's own
  // access boundary, not a Students-specific one, so it borrows this key
  // rather than getting a duplicate the way Documents did not.
  attendance: {
    label: 'Attendance',
    pages: {
      today: { label: 'Attendance today (dashboard)', actions: ['read'] },
      'daily-register': { label: 'Daily register', actions: ['read', 'write', 'update'] },
      'period-register': { label: 'Period-wise register', actions: ['read', 'write'] },
      'monthly-summary': { label: 'Monthly summary', actions: ['read'] },
      'learner-record': { label: "Learner attendance record", actions: ['read'] },
      defaulters: { label: 'At-risk & defaulters', actions: ['read'] },
      interventions: { label: 'Interventions (warning/meeting/referral log)', actions: ['read', 'write'] },
      corrections: { label: 'Corrections history & approval', actions: ['read', 'update'] },
      settings: { label: 'Attendance settings', actions: ['read', 'update'] },
      reports: { label: 'Reports & export', actions: ['read'] },
    },
  },
  // Timetable (Phase 2). The old model used exactly two keys
  // (timetable.view / timetable.manage) for all 12 mockup screens plus
  // exam sessions -- so, like Attendance, this is mostly a faithful
  // rename, not a redesign. Two disclosed simplifications:
  //  - Venues and Exam sessions are built on the shared buildCrudRouter
  //    helper (core/crudRoutes.js), which gates create/update/delete
  //    under ONE 'manage' permission rather than three separate ones --
  //    preserved here as a single 'write' action per page rather than
  //    inventing a write/update/delete split the backend can't actually
  //    enforce yet (splitting would mean changing that shared helper,
  //    which other not-yet-migrated modules also use).
  //  - Export (screen 12) used to borrow the platform-wide
  //    'documents.generate' permission -- given its own dedicated
  //    'export' page here instead, same "dedicated vs. borrowed" call as
  //    Students' Reports tab, and for the same reason: it's a read, but
  //    letting a role print/download the whole timetable is a real,
  //    separately-grantable capability.
  // (No separate 'overview' page: the /timetable landing screen composes
  // config/versions/clashes/runs, each already gated by its own real
  // endpoint below -- the nav item gates on 'entries:read' as the most
  // representative "can see the timetable at all" capability, rather
  // than inventing a permission with no backend enforcement point.)
  timetable: {
    label: 'Timetable',
    pages: {
      config: { label: 'Period & bell-time setup', actions: ['read', 'update'] },
      venues: { label: 'Venue allocation', actions: ['read', 'write'] },
      versions: { label: 'Publish & versions', actions: ['read', 'update'] },
      entries: { label: 'Build / edit grid (class & teacher views)', actions: ['read', 'write', 'delete'] },
      generator: { label: 'Auto-generate', actions: ['read', 'write'] },
      clashes: { label: 'Clash & gap report', actions: ['read', 'update'] },
      exams: { label: 'Exam timetable', actions: ['read', 'write'] },
      relief: { label: 'Substitution & relief', actions: ['read', 'write'] },
      export: { label: 'Print / export', actions: ['read'] },
    },
  },
  // Classes & Sections (Phase 2). Like Attendance/Timetable, the old
  // model used exactly two keys (classes.view / classes.manage) across
  // every screen, so this is mostly a faithful rename. Two disclosed
  // judgment calls:
  //  - Levels and Sections are one page ('levels') covering screens
  //    1/2/3/4 (registry, level detail, section roster, add/edit form).
  //    The backend already treats a level's sections as an inline
  //    sub-resource of PUT /levels/:id's combined save, and the real
  //    Flutter screens all link back into that one flow -- there's no
  //    independent "sections" screen. POST /levels/:id/sections and
  //    DELETE /sections/:id are real endpoints, migrated faithfully to
  //    'write'/'delete' here, but the current UI never calls them
  //    directly (section create/delete only happens through the
  //    combined form save) -- so there is no client-side button to gate
  //    for those two specifically.
  //  - Waitlist has no screen or route of its own -- it's embedded on
  //    the Capacity & allocation screen (5) alongside rebalance, and the
  //    old model never gave it a separate permission either (its
  //    buildCrudRouter call used the same classes.view/classes.manage
  //    as everything else). So it's folded into the 'capacity' page
  //    rather than becoming its own page. Within that page, the
  //    waitlist's create/update/delete are further bundled under a
  //    single 'write' action (buildCrudRouter gates POST/PUT/DELETE
  //    under one managePermission) -- same shared-helper limitation
  //    already disclosed for Timetable's Venues/Exam sessions. Rebalance
  //    preview stays a 'read' (a pure computation, no writes -- same
  //    read-vs-write distinction the old code already enforced), while
  //    rebalance execute is 'update'.
  // (No separate 'overview' page: the /classes landing screen IS the
  // Levels registry, so the nav item gates on 'levels:read' -- a real,
  // already-enforced endpoint, not an invented permission.)
  classes: {
    label: 'Classes & Sections',
    pages: {
      levels: { label: 'Levels & sections (registry, detail, roster, add/edit)', actions: ['read', 'write', 'update', 'delete'] },
      capacity: { label: 'Capacity, waitlist & rebalance', actions: ['read', 'write', 'update'] },
      curriculum: { label: 'Curriculum plan', actions: ['read', 'update'] },
      'class-teacher': { label: 'Class teacher assignment', actions: ['read', 'update'] },
      promotion: { label: 'Promotion & year rollover', actions: ['read', 'write', 'update'] },
      settings: { label: 'Structure settings', actions: ['read', 'update'] },
    },
  },
  // Examinations (Phase 2). Unlike every module migrated so far, the old
  // model here already used FOUR flat keys -- exams.view / .create /
  // .update / .publish -- not two. That fourth key is a real, deliberate
  // axis of control the original design kept separate from ordinary
  // create/update: every workflow-gating action (opening marks entry,
  // approving/returning a marksheet, releasing results to parents) has
  // always been independently grantable from routine CRUD in this module.
  // This migration preserves that distinction rather than flattening it:
  //  - 'datesheet-publish' is split out as its OWN page, even though its
  //    one action (opening marks entry for the whole cycle) lives as a
  //    button on the same screen as ordinary paper add/edit/delete
  //    (exams_datesheet_screen.dart) -- add/edit/delete already occupy
  //    write/update/delete on the 'datesheet' page, and this is a
  //    materially higher-stakes action (it flips the cycle's stage and
  //    opens marking to every teacher), so it gets carved out rather than
  //    folded into 'datesheet:update'. Same reasoning Attendance applied
  //    when 'attendance.correction.approve' became its own 'corrections'
  //    page rather than joining 'daily-register:update'.
  //  - 'moderation' (approve/return/bulk-approve) and 'publish' (release
  //    results) already sit on their own real screens (6 and 9), so no
  //    page-splitting was needed there -- they simply become that page's
  //    own 'update' action, mirroring corrections:update's precedent of
  //    collapsing approve+reject into one verb when the old model never
  //    distinguished them either.
  //  - 'marks-entry' collapses save/import-CSV/submit into one 'update'
  //    action: the old model used the exact same 'exams.update' key for
  //    all three, so there's no old-model signal favouring a split, and
  //    they're really the same "enter marks" workflow via three input
  //    paths.
  // (No invented 'overview' permission: the /examinations landing screen
  // IS Overview, with its own real GET /api/exams/overview endpoint, so
  // the nav item gates on 'overview:read'.)
  exams: {
    label: 'Examinations',
    pages: {
      overview: { label: 'Overview', actions: ['read'] },
      cycles: { label: 'Exam cycles (list, view, create, edit)', actions: ['read', 'write', 'update'] },
      datesheet: { label: 'Datesheet (papers)', actions: ['read', 'write', 'update', 'delete'] },
      'datesheet-publish': { label: 'Publish datesheet (opens marks entry)', actions: ['update'] },
      structure: { label: 'Paper & marks structure', actions: ['read', 'write', 'update', 'delete'] },
      'marks-entry': { label: 'Marks entry (grid, CSV import, submit)', actions: ['read', 'update'] },
      moderation: { label: 'Moderation & approval', actions: ['read', 'update'] },
      results: { label: 'Results & analysis', actions: ['read'] },
      'report-cards': { label: 'Report cards & comments', actions: ['read', 'write', 'update'] },
      publish: { label: 'Publish results, audit & parent preview', actions: ['read', 'update'] },
    },
  },

  // Fees & Payments' old model used FOUR keys too: fees.view / fees.create /
  // fees.update / fees.refund. That fourth key is preserved the same way
  // Examinations' exams.publish was: 'fees.refund' only ever guarded the
  // disbursement approval workflow (PATCH /disbursements/:id/decide and
  // POST /disbursements/:id/mark-paid), never a literal "give money back"
  // route -- there is no refund endpoint anywhere in this module. Two
  // judgment calls worth flagging:
  //  - The approval routes get their OWN page ('disbursements-approval')
  //    rather than folding into 'disbursements', even though the "Record a
  //    payment out" button and the Approve/Decline/Mark paid actions all
  //    live on the same screen (fee_disbursements_screen.dart) -- same
  //    reasoning as Examinations' datesheet-publish split: the old model
  //    already isolated this as a separately-grantable capability (with a
  //    real two-person-rule check behind it), so the new model keeps that
  //    isolation rather than flattening it back into 'write'/'update'.
  //  - The plan doc's early sample mapping guessed "Refund -> delete" as
  //    the closest of the four CRUD verbs, flagged there as the most
  //    debatable entry and worth re-confirming once the real routes were
  //    in front of us. Having now read them: nothing is deleted by either
  //    route (decide only flips a status field, mark-paid only attaches a
  //    proof reference), so 'update' is the accurate verb -- the same
  //    conclusion already reached for Examinations' moderation approve/
  //    return, which is structurally identical.
  // GET /api/students/:id/fees (a per-student ledger, mounted on the
  // students router) is used only by the Record-a-payment screen once a
  // learner is picked -- not by any Students-module screen -- so it's
  // folded into 'payments:read' rather than 'invoices:read'.
  fees: {
    label: 'Fees & Payments',
    pages: {
      overview: { label: 'Collections overview', actions: ['read'] },
      structure: { label: 'Fee structure, billing schedule & rules', actions: ['read', 'update'] },
      invoices: { label: 'Invoices', actions: ['read', 'write', 'update'] },
      payments: { label: 'Record a payment', actions: ['read', 'write'] },
      reconciliation: { label: 'Bank reconciliation', actions: ['read', 'update'] },
      arrears: { label: 'Arrears & collections', actions: ['read', 'write', 'update'] },
      disbursements: { label: 'Payments made (disbursements)', actions: ['read', 'write'] },
      'disbursements-approval': { label: 'Approve & pay disbursements', actions: ['update'] },
      settings: { label: 'Payment channels & policy', actions: ['read', 'update'] },
      // Reports module (edusphere-reports-module-plan-2026-09-22.md) --
      // Fees had NO exportable report of any kind before this (Overview/
      // Arrears are operational screens, not the spec's Collection/
      // Outstanding/Overdue/Payment history/Daily collection reports), so
      // unlike every other page in this catalog this one is genuinely
      // brand new, not a rename of something that already existed. No
      // OLD_TO_NEW bridge, same "brand-new dedicated permission" call
      // Students' and Staff's own 'reports' pages already made.
      reports: { label: 'Reports & export', actions: ['read'] },
    },
  },

  // Parents' old model has only THREE keys (parents.view/create/update --
  // no fourth "workflow" key like exams/fees had), so no page needed
  // splitting the way datesheet-publish/disbursements-approval did.
  // 'profile' covers all four Parent Profile tabs (overview/contact/comms/
  // portal) as ONE page: the routes.js header groups them as a single
  // "Profile" section, they all read/write the same parent record via one
  // provider, and only 'contact' and 'portal' have any write action at all
  // (overview and comms are pure reads -- comms has no real data source
  // yet, same honest-gap pattern as every other placeholder communication
  // tab in this codebase). 'add-link' and 'import' are both real, separate
  // screens/routes reached from the registry, and both were already
  // sharing the old 'parents.create' key -- kept as two SEPARATE pages
  // here (not merged into one) since they are materially different
  // workflows (create/link one parent interactively vs. bulk CSV import),
  // matching this catalog's page-per-screen default rather than the old
  // model's coarser key.
  // Sub-role note (worth flagging, since it differs from every module
  // migrated so far): db/seed.js's SUB_ADMIN_PERMISSIONS already grants
  // sub_admin 'parents.view' and 'parents.create' (but not
  // 'parents.update') -- unlike Classes/Examinations/Fees, this is NOT a
  // zero-regression migration. Sub_admin keeps registry/profile read and
  // add-link/import write automatically through the OLD_TO_NEW compat
  // bridge (no seed.js change needed), and correctly still lacks merge
  // and profile-update access, exactly as before.
  parents: {
    label: 'Parents',
    pages: {
      registry: { label: 'Parent registry (list & search)', actions: ['read'] },
      'add-link': { label: 'Add / link a parent', actions: ['write'] },
      import: { label: 'Bulk import (CSV, plus the guardian-data backfill)', actions: ['write'] },
      merge: { label: 'Merge duplicate parent records', actions: ['update'] },
      profile: { label: 'Parent profile (overview, contact, comms, portal tabs)', actions: ['read', 'update'] },
    },
  },

  // Teachers & Staff (Phase 2 -- the last module on the old flat model per
  // the RBAC plan doc). Two real route files (staff/routes.js +
  // staffLeave/routes.js) share the SAME five old keys
  // (staff.view/create/update/archive/import) -- the same five-key shape
  // Students used, and this catalog follows Students' precedent closely:
  //  - 'profile' is the unified list/view/create/edit-core-record page
  //    (Directory, Add staff, and the Profile screen's Overview/Personal/
  //    Employment tabs), same "profile" concept Students already used for
  //    the identical view/create/update triple.
  //  - staff.archive covered TWO materially different real buttons on the
  //    Staff Profile header -- "Deactivate" (a real, if soft, archive) and
  //    "Offboard" (records an exit date/reason, does not remove the
  //    record) -- so it's split into 'archive:delete' and
  //    'offboarding:update', the same disclosed move Students made
  //    splitting students.archive into archive/withdraw-transfer for the
  //    same reason (one old key, two distinct real actions).
  //  - 'assignments' is its own page (not folded into 'profile') because
  //    it's reached from a genuinely separate screen (Assignments &
  //    Workload, plus the Profile's own Subjects & Classes tab) backed by
  //    its own sub-resource routes (POST/PUT/DELETE /:id/assignments) --
  //    unlike Personal/Employment, which share PUT /:id with nothing else.
  //  - 'leave' covers the entire staffLeave router (a separate route file,
  //    mounted at /api/staff-leave) as one page: list+balance (read),
  //    record leave (write), and approve/decline (update) -- the old model
  //    never distinguished record-leave from decide, so there's no
  //    old-model signal to split them further, but the new model does
  //    still separate write (create) from update (decide) since they're
  //    materially different actions on the same resource.
  //  - 'reports' is a brand-new dedicated permission for GET
  //    /reports/:type (directory + compliance CSV), replacing the
  //    borrowed platform-wide 'documents.generate' the same way Students'
  //    'reports' page replaced it -- no OLD_TO_NEW entry, so (like
  //    Students) a role holding only the old 'documents.generate' key
  //    does not automatically inherit this; it was the only remaining
  //    live use of 'documents.generate' in the codebase, so after this
  //    migration that old key has no permit() call left anywhere.
  // (No separate 'overview' page: the /staff landing screen IS the
  // Directory list, so the nav item gates on 'profile:read'.)
  staff: {
    label: 'Teachers & Staff',
    pages: {
      profile: { label: 'Directory & profile (list, view, add, personal/employment edit)', actions: ['read', 'write', 'update'] },
      assignments: { label: 'Subjects, classes & workload', actions: ['read', 'write', 'update', 'delete'] },
      archive: { label: 'Deactivate staff member', actions: ['delete'] },
      offboarding: { label: 'Offboard staff member', actions: ['update'] },
      import: { label: 'Bulk import (CSV)', actions: ['write'] },
      leave: { label: 'Leave requests & balances', actions: ['read', 'write', 'update'] },
      reports: { label: 'Directory & compliance reports (CSV export)', actions: ['read'] },
      // Payroll (edusphere-staff-payroll-build-2026-09-24.md): view runs,
      // payslips and pay setups (read), create a month's run (write), edit
      // pay setup / recalculate / finalise / mark paid (update), discard a
      // draft run (delete). No OLD_TO_NEW bridge on purpose -- salary data
      // must be granted explicitly, never inherited from staff.view.
      payroll: { label: 'Payroll (pay setup, monthly runs, payslips)', actions: ['read', 'write', 'update', 'delete'] },
    },
  },

  // User Management / Access & Permissions (RBAC plan doc's final phase --
  // the module that manages the very roles doing the migrating, done
  // last on purpose, per the plan doc's own sequencing). Old model used
  // six keys across two route groups (users.view/create/update/
  // deactivate, roles.view/manage). Two real, disclosed changes:
  //  - 'users.update' was defined in the old catalog but never actually
  //    checked by any route -- there was no way to change an existing
  //    user's role once invited. This migration gives it a real
  //    enforcement point, 'role-assignment:update', backing a brand-new
  //    PATCH /api/users/:id/roles endpoint. Any role that already held
  //    the old (previously inert) key picks up this real capability the
  //    moment this ships, via the OLD_TO_NEW bridge below -- a
  //    deliberate activation of a long-dormant grant, not scope creep.
  //  - 'roles.manage' covered both creating a role and editing one's
  //    permissions under a single key; split here into 'roles:write'
  //    (create a role) and 'roles:update' (edit an existing non-system
  //    role's permissions) since the rewrite's CRUD-only rule has room
  //    for both verbs and they're materially different actions on the
  //    same resource -- mirrors Staff's leave:write vs leave:update
  //    split.
  // Every capability here -- creating a role, editing one's
  // permissions, reassigning a user's role -- independently enforces
  // the existing delegation ceiling (a grantor can never hand out a
  // permission they do not themselves hold; see users/routes.js),
  // which predates this migration and is unchanged by it.
  users: {
    label: 'User Management',
    pages: {
      directory: { label: 'User directory & invite', actions: ['read', 'write'] },
      status: { label: 'Activate / deactivate a user', actions: ['update'] },
      'role-assignment': { label: "Change a user's role", actions: ['update'] },
      roles: { label: 'Roles & permissions (view, create, edit)', actions: ['read', 'write', 'update'] },
    },
  },

  // Notices & Communication (edusphere-notices-communication-module-plan
  // -2026-09-22.md). Brand new, native v2 -- the old flat catalog's
  // 'notices.view'/'notices.create' were reserved placeholders granted to
  // no seeded role and read by no route, so there is nothing real to
  // bridge from OLD_TO_NEW. "Direct & group messaging" is NOT a separate
  // page: this codebase has no parent/student/teacher/staff login, so a
  // "message" is just a notice whose audience is narrowed to one class,
  // role or individual rather than "Entire School" -- one resource, one
  // permission surface, not a duplicate inbox nobody could open anyway.
  // 'acknowledgements' is a real page of its own (its own read/write
  // pair) since a role could plausibly be trusted to log that people were
  // informed without also being trusted to author/publish notices.
  notices: {
    label: 'Notices & Communication',
    pages: {
      board: { label: 'Notice board (list, view, create, edit, publish/archive)', actions: ['read', 'write', 'update'] },
      delete: { label: 'Delete a draft notice', actions: ['delete'] },
      acknowledgements: { label: 'Acknowledgement log', actions: ['read', 'write'] },
    },
  },

  // Settings (edusphere-settings-module-plan-2026-09-23.md). "My Account"
  // and "Appearance" (theme) are deliberately NOT permission keys here --
  // they're self-service (gated on authenticate alone, scoped to req.auth.
  // sub) and client-only respectively, so there is nothing to grant or
  // revoke for either. Only the two tenant-wide pillars get real
  // permissions: Regional Format (relocated from school-setup's old
  // preferences tab) and Security Policy (new -- password rules, session
  // timeout, lockout).
  settings: {
    label: 'Settings',
    pages: {
      regional: { label: 'Regional format (language, date/time, currency)', actions: ['read', 'write'] },
      security: { label: 'Security policy (password rules, session, lockout)', actions: ['read', 'write'] },
    },
  },
};

export const V2_PERMISSIONS = Object.entries(FEATURE_CATALOG).flatMap(([featureKey, feature]) =>
  Object.entries(feature.pages).flatMap(([pageKey, page]) =>
    page.actions.map((action) => `${featureKey}:${pageKey}:${action}`),
  ),
);

export const V2_PERMISSION_SET = new Set(V2_PERMISSIONS);

export const isV2Permission = (key) => typeof key === 'string' && key.split(':').length === 3;

// The feature a v2 permission belongs to, for entitlement checks --
// 'school-setup:profile:read' -> 'school-setup'.
export const featureOf = (v2Key) => v2Key.split(':')[0];

// Old flat key <-> new triplet key, for the two already-migrated actions.
// permit() consults this both ways so a role stored with either format
// still resolves correctly during the transition window -- see
// core/middleware.js.
// Old flat key -> array of new triplet keys it now maps to. An array
// because 'students.archive' used to cover two things this rewrite
// deliberately splits apart (Archive itself, and Withdraw/Transfer) --
// a role stored with the old key must still satisfy BOTH new checks
// during the transition window, per the RBAC plan doc's "either format
// keeps working" promise. permit()'s grants() (core/middleware.js)
// consults this both ways.
export const OLD_TO_NEW = {
  'school.settings.view': ['school-setup:profile:read'],
  'school.settings.update': ['school-setup:profile:update'],
  'students.view': ['students:profile:read'],
  'students.create': ['students:profile:write'],
  'students.update': ['students:profile:update'],
  'students.archive': ['students:archive:delete', 'students:withdraw-transfer:update'],
  'students.import': ['students:import:write'],
  // attendance.view used to gate almost every read in the module (see
  // modules/attendance/routes.js before this migration) -- a role stored
  // with just the old key must keep passing every one of these new read
  // checks during the transition window.
  'attendance.view': [
    'attendance:today:read',
    'attendance:daily-register:read',
    'attendance:period-register:read',
    'attendance:monthly-summary:read',
    'attendance:learner-record:read',
    'attendance:defaulters:read',
    'attendance:interventions:read',
    'attendance:corrections:read',
    'attendance:settings:read',
    'attendance:reports:read',
  ],
  'attendance.create': ['attendance:daily-register:write'],
  'attendance.update': [
    'attendance:daily-register:update',
    'attendance:period-register:write',
    'attendance:interventions:write',
  ],
  'attendance.correction.approve': ['attendance:corrections:update'],
  'attendance.settings.manage': ['attendance:settings:update'],
  // timetable.view gated every read across all 12 screens (same shape as
  // attendance.view). 'export' is deliberately excluded -- see the
  // FEATURE_CATALOG comment above.
  'timetable.view': [
    'timetable:config:read',
    'timetable:venues:read',
    'timetable:versions:read',
    'timetable:entries:read',
    'timetable:generator:read',
    'timetable:clashes:read',
    'timetable:exams:read',
    'timetable:relief:read',
  ],
  'timetable.manage': [
    'timetable:config:update',
    'timetable:venues:write',
    'timetable:versions:update',
    'timetable:entries:write',
    'timetable:entries:delete',
    'timetable:generator:write',
    'timetable:clashes:update',
    'timetable:exams:write',
    'timetable:relief:write',
  ],
  // classes.view gated every read across all 9 screens (same shape as
  // attendance.view / timetable.view).
  'classes.view': [
    'classes:levels:read',
    'classes:capacity:read',
    'classes:curriculum:read',
    'classes:class-teacher:read',
    'classes:promotion:read',
    'classes:settings:read',
  ],
  'classes.manage': [
    'classes:levels:write',
    'classes:levels:update',
    'classes:levels:delete',
    'classes:capacity:write',
    'classes:capacity:update',
    'classes:curriculum:update',
    'classes:class-teacher:update',
    'classes:promotion:write',
    'classes:promotion:update',
    'classes:settings:update',
  ],
  // exams.view gated every read across all 9 screens (same shape as
  // classes.view/attendance.view/timetable.view).
  'exams.view': [
    'exams:overview:read',
    'exams:cycles:read',
    'exams:datesheet:read',
    'exams:structure:read',
    'exams:marks-entry:read',
    'exams:moderation:read',
    'exams:results:read',
    'exams:report-cards:read',
    'exams:publish:read',
  ],
  // exams.create covered every "add a new thing" action across the module.
  'exams.create': [
    'exams:cycles:write',
    'exams:datesheet:write',
    'exams:structure:write',
    'exams:report-cards:write',
  ],
  // exams.update covered every "edit/remove an existing thing" action.
  'exams.update': [
    'exams:cycles:update',
    'exams:datesheet:update',
    'exams:datesheet:delete',
    'exams:structure:update',
    'exams:structure:delete',
    'exams:marks-entry:update',
    'exams:report-cards:update',
  ],
  // exams.publish covered every workflow-gating "release/approve" action
  // -- see the FEATURE_CATALOG comment above for why these stay a
  // separately-grantable axis rather than folding into exams.update.
  'exams.publish': [
    'exams:datesheet-publish:update',
    'exams:moderation:update',
    'exams:publish:update',
  ],

  // See the FEATURE_CATALOG comment above for the fees.refund / two-page
  // (disbursements + disbursements-approval) reasoning.
  'fees.view': [
    'fees:overview:read',
    'fees:structure:read',
    'fees:invoices:read',
    'fees:payments:read',
    'fees:reconciliation:read',
    'fees:arrears:read',
    'fees:disbursements:read',
    'fees:settings:read',
  ],
  'fees.create': [
    'fees:invoices:write',
    'fees:payments:write',
    'fees:arrears:write',
    'fees:disbursements:write',
  ],
  'fees.update': [
    'fees:structure:update',
    'fees:invoices:update',
    'fees:reconciliation:update',
    'fees:arrears:update',
  ],
  'fees.refund': [
    'fees:disbursements-approval:update',
  ],

  // See the FEATURE_CATALOG comment above for the sub_admin partial-access
  // note -- this is the first module where the old keys being expanded
  // here are NOT all absent from SUB_ADMIN_PERMISSIONS.
  'parents.view': [
    'parents:registry:read',
    'parents:profile:read',
  ],
  'parents.create': [
    'parents:add-link:write',
    'parents:import:write',
  ],
  'parents.update': [
    'parents:merge:update',
    'parents:profile:update',
  ],

  // See the FEATURE_CATALOG comment above for the archive/offboarding
  // split and the reports page's brand-new-permission (no bridge) choice.
  // Staff is a zero-regression migration -- db/seed.js's
  // SUB_ADMIN_PERMISSIONS holds none of staff.view/create/update/archive/
  // import and never held 'documents.generate' either, so sub_admin's
  // access to this module is unchanged: none, before or after.
  'staff.view': [
    'staff:profile:read',
    'staff:assignments:read',
    'staff:leave:read',
  ],
  'staff.create': ['staff:profile:write'],
  'staff.update': [
    'staff:profile:update',
    'staff:assignments:write',
    'staff:assignments:update',
    'staff:assignments:delete',
    'staff:leave:write',
    'staff:leave:update',
  ],
  'staff.archive': [
    'staff:archive:delete',
    'staff:offboarding:update',
  ],
  'staff.import': ['staff:import:write'],

  // See the FEATURE_CATALOG comment above for the dormant users.update /
  // split roles.manage reasoning. Zero-regression: db/seed.js's
  // SUB_ADMIN_PERMISSIONS holds none of these six old keys and never
  // did, so sub_admin's access to user/role management is unchanged --
  // none, before or after.
  'users.view': ['users:directory:read'],
  'users.create': ['users:directory:write'],
  'users.update': ['users:role-assignment:update'],
  'users.deactivate': ['users:status:update'],
  'roles.view': ['users:roles:read'],
  'roles.manage': ['users:roles:write', 'users:roles:update'],
};

// New key -> array of old key(s) it was migrated from. Built from
// OLD_TO_NEW rather than hand-duplicated, so the two can never drift.
// students:documents:* and students:reports:read have no entry here --
// they are brand-new permissions with no old-format equivalent (Students
// never had its own document/report permission before this rewrite; it
// borrowed the platform-wide documents.view/upload/generate), so a role
// must be granted them explicitly rather than inheriting them for free.
export const NEW_TO_OLD = {};
for (const [oldKey, newKeys] of Object.entries(OLD_TO_NEW)) {
  for (const newKey of newKeys) {
    (NEW_TO_OLD[newKey] ??= []).push(oldKey);
  }
}

// Every permission string the system currently knows about, in either
// format -- used to validate a role-permission grant so a typo or an
// invented key can never be assigned (mirrors core/permissions.js's own
// isKnownPermission intent for the old catalog).
export function isKnownPermissionV2(key, oldPermissionSet) {
  return oldPermissionSet.has(key) || V2_PERMISSION_SET.has(key);
}
