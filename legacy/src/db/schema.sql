-- EduSphere MySQL schema (Phase 1 foundation)
-- Run this once against an empty database before starting the API with
-- DATABASE_DRIVER=mysql. Keep it hand-in-hand with adapters/mysqlAdapter.js:
-- every column read/written there must exist here.
--
--   mysql -u <user> -p <database> < src/db/schema.sql
--
-- Design notes (see requirement/rquiremnt phase 1.md sections 37, 55-59):
--   * Every tenant-owned table carries school_id and is never queried
--     without it (enforced in code, not just by this schema).
--   * Nothing here is hard deleted by the application; status/archive
--     columns carry lifecycle instead.
--   * Students are decoupled from a single class: class/section live on
--     the student row for V1 (matching the current UI/API contract), but
--     attendance and future enrollment history are already date-scoped so
--     a proper student_enrollments table can be introduced later without
--     breaking this contract.

CREATE TABLE IF NOT EXISTS schools (
  id            VARCHAR(36) PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  slug          VARCHAR(100) NOT NULL UNIQUE,
  active        TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- tenant_id NULL = platform-level role (super_admin). Permissions are
-- stored as a JSON array of permission keys from src/core/permissions.js
-- rather than a separate join table, so a school can tailor its own
-- "Sub Admin" role permission set without a schema change.
CREATE TABLE IF NOT EXISTS roles (
  id            VARCHAR(36) PRIMARY KEY,
  tenant_id     VARCHAR(36) NULL,
  `key`         VARCHAR(100) NOT NULL,
  name          VARCHAR(150) NOT NULL,
  permissions   JSON NOT NULL,
  is_system     TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY uniq_role_per_tenant (tenant_id, `key`),
  CONSTRAINT fk_roles_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;

-- Tier one of the two-tier RBAC model (see RBAC plan doc): which
-- features a school is entitled to at all, independent of any user's
-- role. Feature-level granularity only, a real row per (school, feature)
-- rather than a JSON blob, specifically for audit visibility -- who
-- toggled what, and when. A missing row defaults to enabled (see
-- core/entitlements.js).
CREATE TABLE IF NOT EXISTS school_entitlements (
  id            VARCHAR(36) PRIMARY KEY,
  tenant_id     VARCHAR(36) NOT NULL,
  feature_key   VARCHAR(100) NOT NULL,
  enabled       TINYINT(1) NOT NULL DEFAULT 1,
  updated_by    VARCHAR(36) NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_entitlement_per_tenant (tenant_id, feature_key),
  CONSTRAINT fk_entitlements_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
  id                     VARCHAR(36) PRIMARY KEY,
  tenant_id              VARCHAR(36) NULL,
  email                  VARCHAR(255) NOT NULL UNIQUE,
  password_hash          VARCHAR(255) NOT NULL,
  full_name              VARCHAR(150) NOT NULL,
  phone                  VARCHAR(30) NULL,
  role_keys              JSON NOT NULL,
  status                 ENUM('active','inactive') NOT NULL DEFAULT 'active',
  last_login_at          DATETIME NULL,
  -- Security Policy lockout enforcement (edusphere-settings-module-plan-
  -- 2026-09-23.md) -- failed_login_attempts resets to 0 on a successful
  -- login or a self-service password change; locked_until is cleared the
  -- same way and otherwise checked at login time against the tenant's
  -- security_policies row.
  failed_login_attempts  INT NOT NULL DEFAULT 0,
  locked_until           DATETIME NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;

-- Student Management (designs/Student managment system.png, 12 screens).
-- Personal/academic fields are flat columns (queried/filtered directly);
-- father/mother/guardian contact info is one JSON column (`guardians`) --
-- it's per-student contact info entered during admission, not a separate
-- Parent Management account/module (that's the still-unbuilt `parents.*`
-- module, kept out of scope here on purpose, same reasoning as excluding
-- Classes & Sections from the School Setup build). `withdrawal`/`transfer`
-- are JSON too since each is only ever set once, together, when the
-- student's status changes to that value.
CREATE TABLE IF NOT EXISTS students (
  id                  VARCHAR(36) PRIMARY KEY,
  tenant_id           VARCHAR(36) NOT NULL,
  admission_number    VARCHAR(50) NOT NULL,
  first_name          VARCHAR(100) NOT NULL,
  middle_name         VARCHAR(100) NULL,
  last_name           VARCHAR(100) NOT NULL,
  date_of_birth       DATE NULL,
  gender              ENUM('Male','Female','Other') NULL,
  blood_group         VARCHAR(5) NULL,
  nationality         VARCHAR(50) NULL,
  aadhaar_number      VARCHAR(20) NULL,
  student_email       VARCHAR(150) NULL,
  guardians           JSON NULL,
  academic_year       VARCHAR(20) NULL,
  class_name          VARCHAR(50) NOT NULL,
  section             VARCHAR(20) NOT NULL,
  roll_number         VARCHAR(20) NULL,
  admission_date      DATE NULL,
  admission_type      VARCHAR(30) NOT NULL DEFAULT 'New Admission',
  previous_school     VARCHAR(150) NULL,
  previous_class      VARCHAR(50) NULL,
  house               VARCHAR(50) NULL,
  category            VARCHAR(30) NULL,
  transport_required  TINYINT(1) NOT NULL DEFAULT 0,
  status              ENUM('active','withdrawn','transferred','graduated','archived') NOT NULL DEFAULT 'active',
  withdrawal          JSON NULL,
  transfer            JSON NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NULL,
  UNIQUE KEY uniq_admission_per_tenant (tenant_id, admission_number),
  CONSTRAINT fk_students_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_students_tenant_class ON students (tenant_id, class_name, section);

CREATE TABLE IF NOT EXISTS attendance (
  id            VARCHAR(36) PRIMARY KEY,
  tenant_id     VARCHAR(36) NOT NULL,
  student_id    VARCHAR(36) NOT NULL,
  date          DATE NOT NULL,
  class_name    VARCHAR(50) NOT NULL,
  section       VARCHAR(20) NOT NULL,
  status        ENUM('present','absent','late','leave') NOT NULL,
  remark        VARCHAR(500) NOT NULL DEFAULT '',
  created_by    VARCHAR(36) NOT NULL,
  created_at    DATETIME NOT NULL,
  updated_by    VARCHAR(36) NOT NULL,
  updated_at    DATETIME NOT NULL,
  UNIQUE KEY uniq_attendance_per_day (tenant_id, student_id, date),
  CONSTRAINT fk_attendance_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_attendance_student FOREIGN KEY (student_id) REFERENCES students(id)
) ENGINE=InnoDB;
CREATE INDEX idx_attendance_lookup ON attendance (tenant_id, date, class_name, section);

-- Append-only correction trail, per spec section 19/59 (never overwrite
-- history, prefer archive/adjustment records).
CREATE TABLE IF NOT EXISTS attendance_history (
  id             VARCHAR(36) PRIMARY KEY,
  tenant_id      VARCHAR(36) NOT NULL,
  attendance_id  VARCHAR(36) NOT NULL,
  action         ENUM('created','updated') NOT NULL,
  actor_id       VARCHAR(36) NOT NULL,
  before_json    JSON NULL,
  after_json     JSON NOT NULL,
  at             DATETIME NOT NULL,
  CONSTRAINT fk_history_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;

-- Attendance module additions (Attendance.dc.html, 9 screens) --
-- settings, backdated-correction approval queue, period-level marks and a
-- defaulter-intervention log. See modules/attendance/routes.js header for
-- the full design rationale and honest scope cuts (Notices & Communication
-- integration, real PDF/CSV export).

-- One row per tenant governing register lock time, the backdate window
-- before a correction needs approval, at-risk thresholds, and which class
-- phases (Early years/Primary/Secondary) have period-wise marking turned
-- on. notify_rules is persisted so admins can save preferences, but
-- nothing actually sends anything yet -- no Notices & Communication
-- backend exists in this codebase (see routes.js header).
CREATE TABLE IF NOT EXISTS attendance_settings (
  tenant_id                    VARCHAR(36) PRIMARY KEY,
  register_lock_time           VARCHAR(5) NOT NULL DEFAULT '10:00',
  backdate_window_days         INT NOT NULL DEFAULT 7,
  at_risk_threshold            INT NOT NULL DEFAULT 75,
  consecutive_absence_trigger  INT NOT NULL DEFAULT 3,
  leave_needs_note             TINYINT(1) NOT NULL DEFAULT 1,
  period_marking_phases        JSON NOT NULL,
  notify_rules                 JSON NOT NULL,
  updated_at                   DATETIME NULL,
  CONSTRAINT fk_attendance_settings_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;

-- A correction to attendance more than backdate_window_days in the past
-- doesn't apply immediately -- it waits here until someone holding
-- attendance.correction.approve decides it (see PATCH
-- /api/attendance/correction-requests/:id/decide). Same-day/in-window
-- edits never touch this table; they go straight through PUT
-- /api/attendance as before and land in attendance_history directly.
CREATE TABLE IF NOT EXISTS attendance_correction_requests (
  id                VARCHAR(36) PRIMARY KEY,
  tenant_id         VARCHAR(36) NOT NULL,
  student_id        VARCHAR(36) NOT NULL,
  date              DATE NOT NULL,
  class_name        VARCHAR(50) NOT NULL,
  section           VARCHAR(20) NOT NULL,
  previous_status   VARCHAR(20) NULL,
  previous_remark   VARCHAR(500) NULL,
  requested_status  VARCHAR(20) NOT NULL,
  requested_remark  VARCHAR(500) NOT NULL,
  reason            VARCHAR(500) NOT NULL,
  status            ENUM('pending','approved','declined') NOT NULL DEFAULT 'pending',
  requested_by      VARCHAR(36) NOT NULL,
  requested_at      DATETIME NOT NULL,
  decided_by        VARCHAR(36) NULL,
  decided_at        DATETIME NULL,
  decision_note     VARCHAR(500) NULL,
  CONSTRAINT fk_correction_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_correction_student FOREIGN KEY (student_id) REFERENCES students(id)
) ENGINE=InnoDB;
CREATE INDEX idx_correction_status ON attendance_correction_requests (tenant_id, status);

-- Period-level attendance marks (screen 3), separate from the daily
-- register above and deliberately opt-in per phase via
-- attendance_settings.period_marking_phases -- most schools only need the
-- daily register. slot_id references a timetable config slot id (e.g.
-- "P4"), not a foreign key -- timetable slots are config, not rows, and
-- which subject/teacher a slot meant on a given day is snapshotted into
-- this row at marking time so a later timetable republish can't silently
-- retro-alter what a past mark meant.
CREATE TABLE IF NOT EXISTS attendance_periods (
  id          VARCHAR(36) PRIMARY KEY,
  tenant_id   VARCHAR(36) NOT NULL,
  student_id  VARCHAR(36) NOT NULL,
  date        DATE NOT NULL,
  slot_id     VARCHAR(20) NOT NULL,
  class_name  VARCHAR(50) NOT NULL,
  section     VARCHAR(20) NOT NULL,
  subject     VARCHAR(100) NULL,
  status      ENUM('present','absent','late','leave') NOT NULL,
  remark      VARCHAR(500) NOT NULL DEFAULT '',
  created_by  VARCHAR(36) NOT NULL,
  created_at  DATETIME NOT NULL,
  updated_by  VARCHAR(36) NOT NULL,
  updated_at  DATETIME NOT NULL,
  UNIQUE KEY uniq_attendance_period (tenant_id, student_id, date, slot_id),
  CONSTRAINT fk_period_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_period_student FOREIGN KEY (student_id) REFERENCES students(id)
) ENGINE=InnoDB;
CREATE INDEX idx_period_lookup ON attendance_periods (tenant_id, date, class_name, section);

-- Defaulter/at-risk interventions (screens 5/6): a real, queryable log of
-- action taken on a learner's attendance record. No letter/SMS/email is
-- actually sent (no Notices & Communication backend exists yet) -- this is
-- the honest "action was taken and recorded" trail, not a fabricated
-- delivery/messaging feature.
CREATE TABLE IF NOT EXISTS attendance_interventions (
  id          VARCHAR(36) PRIMARY KEY,
  tenant_id   VARCHAR(36) NOT NULL,
  student_id  VARCHAR(36) NOT NULL,
  type        ENUM('warning_letter','guardian_meeting','support_referral') NOT NULL,
  note        VARCHAR(500) NOT NULL DEFAULT '',
  created_by  VARCHAR(36) NOT NULL,
  created_at  DATETIME NOT NULL,
  CONSTRAINT fk_intervention_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_intervention_student FOREIGN KEY (student_id) REFERENCES students(id)
) ENGINE=InnoDB;
CREATE INDEX idx_intervention_student ON attendance_interventions (tenant_id, student_id);

-- Generic document/file metadata (spec section 36/58) — the file bytes live
-- in object storage, never in this table.
CREATE TABLE IF NOT EXISTS documents (
  id            VARCHAR(36) PRIMARY KEY,
  tenant_id     VARCHAR(36) NOT NULL,
  entity_type   VARCHAR(50) NOT NULL,
  entity_id     VARCHAR(36) NOT NULL,
  document_type VARCHAR(100) NOT NULL,
  file_name     VARCHAR(255) NOT NULL,
  storage_key   VARCHAR(500) NOT NULL,
  mime_type     VARCHAR(150) NOT NULL,
  size_bytes    INT NOT NULL,
  uploaded_by   VARCHAR(36) NOT NULL,
  -- Optional: used by the Teachers & Staff "Documents & Qualifications"
  -- compliance register (SACE registration, police clearance, etc. expire).
  -- NULL for document types that never expire (e.g. a qualification cert).
  expiry_date   DATE NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_documents_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_documents_entity ON documents (tenant_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          VARCHAR(36) PRIMARY KEY,
  tenant_id   VARCHAR(36) NOT NULL,
  event       VARCHAR(150) NOT NULL,
  actor_id    VARCHAR(36) NOT NULL,
  target      VARCHAR(255) NULL,
  summary     JSON NOT NULL,
  at          DATETIME NOT NULL,
  CONSTRAINT fk_audit_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_audit_tenant_time ON audit_logs (tenant_id, at);

-- School Setup (see designs/School Managment Feature.png, "School Setup -
-- All Related Screens"). school_profiles is one row per tenant holding
-- every profile/preference form as its own JSON column -- these are all
-- "one form, one Save Changes button" tabs with no sub-records to list, so
-- a JSON blob per section avoids ~35 rarely-queried columns. Everything
-- else here is a normal list table following the same tenant_id pattern
-- as students/attendance above.
CREATE TABLE IF NOT EXISTS school_profiles (
  tenant_id      VARCHAR(36) PRIMARY KEY,
  basic_info     JSON NULL,
  contact        JSON NULL,
  address        JSON NULL,
  branding       JSON NULL,
  bank           JSON NULL,
  registration   JSON NULL,
  social         JSON NULL,
  promotion      JSON NULL,
  preferences    JSON NULL,
  updated_at     DATETIME NULL,
  CONSTRAINT fk_school_profiles_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS academic_years (
  id          VARCHAR(36) PRIMARY KEY,
  tenant_id   VARCHAR(36) NOT NULL,
  label       VARCHAR(50) NOT NULL,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  status      ENUM('upcoming','current','closed') NOT NULL DEFAULT 'upcoming',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_academic_years_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_academic_years_tenant ON academic_years (tenant_id);

CREATE TABLE IF NOT EXISTS academic_terms (
  id                VARCHAR(36) PRIMARY KEY,
  tenant_id         VARCHAR(36) NOT NULL,
  academic_year_id  VARCHAR(36) NOT NULL,
  name              VARCHAR(50) NOT NULL,
  start_date        DATE NOT NULL,
  end_date          DATE NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_academic_terms_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_academic_terms_year FOREIGN KEY (academic_year_id) REFERENCES academic_years(id)
) ENGINE=InnoDB;
CREATE INDEX idx_academic_terms_year ON academic_terms (tenant_id, academic_year_id);

CREATE TABLE IF NOT EXISTS subjects (
  id                  VARCHAR(36) PRIMARY KEY,
  tenant_id           VARCHAR(36) NOT NULL,
  name                VARCHAR(150) NOT NULL,
  code                VARCHAR(30) NOT NULL DEFAULT '',
  applicable_classes  VARCHAR(255) NOT NULL DEFAULT '',
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_subjects_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_subjects_tenant ON subjects (tenant_id);

CREATE TABLE IF NOT EXISTS holidays (
  id          VARCHAR(36) PRIMARY KEY,
  tenant_id   VARCHAR(36) NOT NULL,
  name        VARCHAR(150) NOT NULL,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  type        VARCHAR(50) NOT NULL DEFAULT 'School',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_holidays_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_holidays_tenant ON holidays (tenant_id);

CREATE TABLE IF NOT EXISTS grades (
  id           VARCHAR(36) PRIMARY KEY,
  tenant_id    VARCHAR(36) NOT NULL,
  grade        VARCHAR(10) NOT NULL,
  min_marks    DECIMAL(5,2) NOT NULL,
  max_marks    DECIMAL(5,2) NOT NULL,
  grade_point  DECIMAL(4,2) NOT NULL,
  -- Added for the Examinations module (screen 9: Grading scale). Per the
  -- plan doc's decision 2, this one existing per-tenant scale is reused
  -- (rather than a new multi-scale model) -- descriptor is the mockup's
  -- "Outstanding achievement" / "Not achieved" style text column.
  descriptor   VARCHAR(150) NOT NULL DEFAULT '',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_grades_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_grades_tenant ON grades (tenant_id);

CREATE TABLE IF NOT EXISTS fee_types (
  id                  VARCHAR(36) PRIMARY KEY,
  tenant_id           VARCHAR(36) NOT NULL,
  name                VARCHAR(150) NOT NULL,
  frequency           ENUM('One Time','Monthly','Quarterly','Annual') NOT NULL,
  applicable_classes  VARCHAR(255) NOT NULL DEFAULT '',
  amount              DECIMAL(10,2) NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_fee_types_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_fee_types_tenant ON fee_types (tenant_id);


-- Teachers & Staff (designs/Teacher feature UI mockup/Teachers & Staff.dc.html,
-- 9 screens). Mirrors the students table's shape/conventions: a flat row
-- per staff member, free-text designation/department/employment-type
-- (School Setup owns no "Designations"/"Departments" list tables yet, same
-- reasoning as students' className being free text), status lifecycle via
-- `status` + an `offboarding` JSON blob set once on the way out (mirrors
-- students' withdrawal/transfer). "On leave today" is intentionally NOT a
-- stored status -- it's derived at read time from staff_leave so it can
-- never drift from the actual approved leave record; `status` here only
-- tracks the employment lifecycle (active/probation/inactive/resigned).
CREATE TABLE IF NOT EXISTS staff (
  id                      VARCHAR(36) PRIMARY KEY,
  tenant_id               VARCHAR(36) NOT NULL,
  employee_id             VARCHAR(50) NOT NULL,
  first_name              VARCHAR(100) NOT NULL,
  last_name               VARCHAR(100) NOT NULL,
  gender                  ENUM('Male','Female','Other') NULL,
  date_of_birth           DATE NULL,
  id_number               VARCHAR(20) NULL,
  personal_email          VARCHAR(150) NULL,
  work_email              VARCHAR(150) NULL,
  phone                   VARCHAR(30) NULL,
  address                 VARCHAR(255) NULL,
  staff_type              VARCHAR(30) NOT NULL DEFAULT 'Teaching',
  designation             VARCHAR(100) NOT NULL,
  department              VARCHAR(100) NOT NULL,
  employment_type         VARCHAR(50) NOT NULL DEFAULT 'Permanent · Full-time',
  joining_date            DATE NULL,
  reports_to              VARCHAR(36) NULL,
  weekly_period_capacity  INT NOT NULL DEFAULT 30,
  is_class_teacher        TINYINT(1) NOT NULL DEFAULT 0,
  class_teacher_of        VARCHAR(50) NULL,
  notes                   VARCHAR(1000) NULL,
  status                  ENUM('active','probation','inactive','resigned') NOT NULL DEFAULT 'active',
  offboarding             JSON NULL,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME NULL,
  UNIQUE KEY uniq_employee_per_tenant (tenant_id, employee_id),
  CONSTRAINT fk_staff_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_staff_tenant_dept ON staff (tenant_id, department, status);

-- One row per subject+class+section a staff member teaches. Also the data
-- source for the Assignment Matrix (pivot by subject x class) and the
-- Workload view (sum periods_per_week per staff vs weekly_period_capacity)
-- -- the design's separate Timetable/Matrix screens are collapsed into one
-- "Assignments & Workload" screen backed by this single table, since none
-- of clash-detection, auto-balance or substitutions has a real day/period
-- timetable to work from (out of scope, same as School Setup's own
-- Classes & Sections cut).
CREATE TABLE IF NOT EXISTS staff_assignments (
  id                VARCHAR(36) PRIMARY KEY,
  tenant_id         VARCHAR(36) NOT NULL,
  staff_id          VARCHAR(36) NOT NULL,
  subject           VARCHAR(100) NOT NULL,
  class_name        VARCHAR(50) NOT NULL,
  section           VARCHAR(20) NOT NULL,
  periods_per_week  INT NOT NULL DEFAULT 1,
  role              VARCHAR(20) NOT NULL DEFAULT 'Subject',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_staff_assignments_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_staff_assignments_staff FOREIGN KEY (staff_id) REFERENCES staff(id)
) ENGINE=InnoDB;
CREATE INDEX idx_staff_assignments_staff ON staff_assignments (tenant_id, staff_id);
CREATE INDEX idx_staff_assignments_class ON staff_assignments (tenant_id, class_name, section);

-- Leave & Attendance (real half of that design screen -- see
-- staffLeave routes for the daily-attendance-heatmap scope cut). Balances
-- against each leave_type's annual entitlement are computed in code from
-- approved rows here, not stored, so nothing needs resetting each year.
CREATE TABLE IF NOT EXISTS staff_leave (
  id           VARCHAR(36) PRIMARY KEY,
  tenant_id    VARCHAR(36) NOT NULL,
  staff_id     VARCHAR(36) NOT NULL,
  leave_type   VARCHAR(50) NOT NULL,
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  days_count   DECIMAL(4,1) NOT NULL,
  reason       VARCHAR(500) NULL,
  status       ENUM('pending','approved','declined') NOT NULL DEFAULT 'pending',
  decided_by   VARCHAR(36) NULL,
  decided_at   DATETIME NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_staff_leave_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_staff_leave_staff FOREIGN KEY (staff_id) REFERENCES staff(id)
) ENGINE=InnoDB;
CREATE INDEX idx_staff_leave_staff ON staff_leave (tenant_id, staff_id, status);

-- Timetable (designs/Teacher feature UI mockup/Timetable.dc.html, 12
-- screens). Demand for the generator/build screen is NOT stored here --
-- it is read straight from staff_assignments (subject + class + section +
-- periods_per_week per teacher, already real), so there is no separate
-- "curriculum requirement" concept and therefore no such thing as an
-- "unstaffed" period in this build (every assignment already has a
-- teacher) -- see core/timetableGenerator.js's header comment. One config
-- row per tenant holds the six-day cycle's bell structure; everything
-- placed on that structure lives in timetable_entries, scoped to a
-- version so draft edits never touch the live grid.
CREATE TABLE IF NOT EXISTS timetable_config (
  tenant_id     VARCHAR(36) PRIMARY KEY,
  cycle_days    INT NOT NULL DEFAULT 6,
  -- Day 1 of the six-day cycle, so "what cycle day is today" is a simple
  -- (today - cycle_anchor) mod cycle_days -- a deliberate simplification:
  -- a real school's cycle also pauses for weekends/holidays (School
  -- Setup's own Holidays list), which this does not consult.
  cycle_anchor  DATE NOT NULL DEFAULT '2026-09-14',
  slots         JSON NOT NULL, -- [{id,label,start,end,kind:'p'|'b',icon,dayOneLabel?}]
  hard_rules    JSON NOT NULL, -- [{key,label,note,on,locked}]
  soft_rules    JSON NOT NULL, -- [{key,label,note,weight,wired}]
  updated_at    DATETIME NULL,
  CONSTRAINT fk_timetable_config_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;

-- Specialist spaces only (screen 8) -- an ordinary classroom-bound period
-- needs no venue row at all; `subjects` is the free-text list of subjects
-- that require this venue, matched against staff_assignments.subject the
-- same way School Setup's Subjects keeps `applicable_classes` as free text
-- rather than a real reference.
CREATE TABLE IF NOT EXISTS timetable_venues (
  id          VARCHAR(36) PRIMARY KEY,
  tenant_id   VARCHAR(36) NOT NULL,
  name        VARCHAR(150) NOT NULL,
  capacity    VARCHAR(50) NOT NULL DEFAULT '',
  subjects    VARCHAR(500) NOT NULL DEFAULT '',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_timetable_venues_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_timetable_venues_tenant ON timetable_venues (tenant_id);

-- One version = one complete grid snapshot (screen 11: draft/live/archived,
-- exactly one 'live' per tenant at a time). Publishing sets this row's
-- state to live and demotes whichever version previously held it to
-- archived -- same demotion pattern as academic_years.set_current.
CREATE TABLE IF NOT EXISTS timetable_versions (
  id             VARCHAR(36) PRIMARY KEY,
  tenant_id      VARCHAR(36) NOT NULL,
  version_number INT NOT NULL,
  state          ENUM('draft','live','archived') NOT NULL DEFAULT 'draft',
  note           VARCHAR(500) NOT NULL DEFAULT '',
  source_run_id  VARCHAR(36) NULL,
  created_by     VARCHAR(36) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at   DATETIME NULL,
  effective_from DATE NULL,
  CONSTRAINT fk_timetable_versions_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_timetable_versions_tenant ON timetable_versions (tenant_id, state);

-- One row per placed period. (class_name, section, day, slot_id) is unique
-- within a version -- a class can only have one subject in one slot; a
-- teacher/venue appearing twice for the same (version, day, slot) across
-- different classes is exactly what the clash report scans for.
CREATE TABLE IF NOT EXISTS timetable_entries (
  id          VARCHAR(36) PRIMARY KEY,
  tenant_id   VARCHAR(36) NOT NULL,
  version_id  VARCHAR(36) NOT NULL,
  class_name  VARCHAR(50) NOT NULL,
  section     VARCHAR(20) NOT NULL,
  day         INT NOT NULL, -- 1..cycle_days
  slot_id     VARCHAR(20) NOT NULL, -- e.g. 'P1'
  subject     VARCHAR(100) NOT NULL,
  staff_id    VARCHAR(36) NOT NULL,
  venue_id    VARCHAR(36) NULL,
  source      ENUM('generated','manual') NOT NULL DEFAULT 'manual',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_entry_slot (version_id, class_name, section, day, slot_id),
  CONSTRAINT fk_timetable_entries_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_timetable_entries_version FOREIGN KEY (version_id) REFERENCES timetable_versions(id)
) ENGINE=InnoDB;
CREATE INDEX idx_timetable_entries_version ON timetable_entries (tenant_id, version_id);
CREATE INDEX idx_timetable_entries_staff ON timetable_entries (tenant_id, version_id, staff_id);

-- History of auto-generate runs (screen 6's "Previous runs" list) -- each
-- run produces a new draft version and records its own scope/stats so the
-- wizard can show "run 3: 96% placed" without recomputing after the fact.
CREATE TABLE IF NOT EXISTS timetable_runs (
  id             VARCHAR(36) PRIMARY KEY,
  tenant_id      VARCHAR(36) NOT NULL,
  version_id     VARCHAR(36) NOT NULL,
  hard_rules     JSON NOT NULL,
  soft_rules     JSON NOT NULL,
  total_periods  INT NOT NULL,
  placed_periods INT NOT NULL,
  note           VARCHAR(255) NOT NULL DEFAULT '',
  created_by     VARCHAR(36) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_timetable_runs_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_timetable_runs_version FOREIGN KEY (version_id) REFERENCES timetable_versions(id)
) ENGINE=InnoDB;
CREATE INDEX idx_timetable_runs_tenant ON timetable_runs (tenant_id, created_at);

-- Exam timetable (screen 9) -- deliberately its own self-contained model
-- rather than reading from a real Examinations module, which does not
-- exist in this codebase yet (see nav_items.dart: Examinations has no
-- screen). A future Examinations module can supply exam_sessions.subject
-- from its own paper records instead of this free-text field without
-- changing anything here.
CREATE TABLE IF NOT EXISTS exam_sessions (
  id                 VARCHAR(36) PRIMARY KEY,
  tenant_id          VARCHAR(36) NOT NULL,
  class_name         VARCHAR(50) NOT NULL,
  exam_date          DATE NOT NULL,
  session            ENUM('AM','PM') NOT NULL,
  subject            VARCHAR(100) NOT NULL,
  venue              VARCHAR(150) NOT NULL DEFAULT '',
  seats              INT NOT NULL DEFAULT 0,
  invigilator_staff_id VARCHAR(36) NULL,
  term_label         VARCHAR(50) NOT NULL DEFAULT '',
  -- Added for the Examinations module (designs/Teacher feature UI
  -- mockup/Examinations.dc.html, screen 3: Datesheet). Per the plan doc's
  -- decision 1, Examinations writes real papers straight into THIS table
  -- rather than a parallel one, so Timetable's own Exam timetable screen
  -- and Classes & Sections' delete-guard/rename-cascade keep seeing every
  -- exam sitting Examinations creates, with no drift between modules. A
  -- row with a null cycle_id is a legacy/Timetable-only sitting created
  -- outside any exam cycle (still fully valid). Clash/unscheduled status
  -- is deliberately NOT stored here -- it's computed live from this table
  -- plus the timetable, the same way Timetable's own GET /exams-checks
  -- already does it, so it can never go stale.
  cycle_id           VARCHAR(36) NULL,
  period_slot_id     VARCHAR(50) NULL,
  duration_minutes   INT NULL,
  sections_included  JSON NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_exam_sessions_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_exam_sessions_tenant ON exam_sessions (tenant_id, exam_date);
CREATE INDEX idx_exam_sessions_cycle ON exam_sessions (tenant_id, cycle_id);

-- Substitution & relief (screen 10) -- one row per period that needs
-- covering because its usual teacher is on approved/pending leave that
-- day (staff_leave is the source of truth for "who's absent"; this table
-- only tracks the cover assignment itself). `notified_at` is set by the
-- "Notify staff" action -- see timetable routes for why that's a logged
-- record rather than a real email/SMS, same honest-placeholder pattern as
-- the Staff module's inert "Invite as user" checkbox.
CREATE TABLE IF NOT EXISTS timetable_relief (
  id               VARCHAR(36) PRIMARY KEY,
  tenant_id        VARCHAR(36) NOT NULL,
  relief_date      DATE NOT NULL,
  slot_id          VARCHAR(20) NOT NULL,
  class_name       VARCHAR(50) NOT NULL,
  section          VARCHAR(20) NOT NULL,
  subject          VARCHAR(100) NOT NULL,
  absent_staff_id  VARCHAR(36) NOT NULL,
  cover_staff_id   VARCHAR(36) NULL,
  status           ENUM('open','covered') NOT NULL DEFAULT 'open',
  note             VARCHAR(255) NOT NULL DEFAULT '',
  notified_at      DATETIME NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_relief_slot (tenant_id, relief_date, slot_id, class_name, section),
  CONSTRAINT fk_timetable_relief_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_timetable_relief_date ON timetable_relief (tenant_id, relief_date);

-- Classes & Sections (designs/Teacher feature UI mockup/
-- Classes and Sections.dc.html) -- the registry other modules read for
-- their class/section options. Class levels are NOT year-scoped --
-- "Class 9" persists across academic years as the same row; Promotion &
-- rollover (below) is what moves each student's own class_name/section
-- forward for a new year, not a fork of the structure itself.
CREATE TABLE IF NOT EXISTS class_levels (
  id                      VARCHAR(36) PRIMARY KEY,
  tenant_id               VARCHAR(36) NOT NULL,
  name                    VARCHAR(50) NOT NULL,
  phase                   VARCHAR(30) NOT NULL DEFAULT 'Primary',
  order_index             INT NOT NULL DEFAULT 0,
  language_of_instruction VARCHAR(50) NOT NULL DEFAULT 'English',
  default_capacity        INT NOT NULL DEFAULT 35,
  status                  ENUM('active','provisional') NOT NULL DEFAULT 'active',
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME NULL,
  UNIQUE KEY uniq_class_level_name (tenant_id, name),
  CONSTRAINT fk_class_levels_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_class_levels_tenant ON class_levels (tenant_id, order_index);

CREATE TABLE IF NOT EXISTS class_sections (
  id             VARCHAR(36) PRIMARY KEY,
  tenant_id      VARCHAR(36) NOT NULL,
  class_level_id VARCHAR(36) NOT NULL,
  letter         VARCHAR(5) NOT NULL,
  capacity       INT NOT NULL DEFAULT 35,
  room           VARCHAR(100) NOT NULL DEFAULT '',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NULL,
  UNIQUE KEY uniq_class_section_letter (tenant_id, class_level_id, letter),
  CONSTRAINT fk_class_sections_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_class_sections_level FOREIGN KEY (class_level_id) REFERENCES class_levels(id)
) ENGINE=InnoDB;
CREATE INDEX idx_class_sections_level ON class_sections (tenant_id, class_level_id);

-- Class teacher is NOT duplicated here -- staff.class_teacher_of (free
-- text "Class 9 · A", already used by the Staff module's Add Staff wizard
-- and profile) is the single source of truth; this module reads and
-- writes that same field rather than keeping a second copy that could
-- drift out of sync.

-- Minimal, real prospective-applicant queue (screen 5's Waitlist card) --
-- not a fabricated admissions pipeline. There is no applicant-tracking
-- module in this codebase, so this is intentionally a plain, admin-
-- managed list rather than a full admissions workflow.
CREATE TABLE IF NOT EXISTS class_waitlist (
  id           VARCHAR(36) PRIMARY KEY,
  tenant_id    VARCHAR(36) NOT NULL,
  class_name   VARCHAR(50) NOT NULL,
  learner_name VARCHAR(150) NOT NULL,
  note         VARCHAR(255) NOT NULL DEFAULT '',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_class_waitlist_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_class_waitlist_tenant ON class_waitlist (tenant_id, class_name);

-- Curriculum plan (screen 6) -- periods-per-cycle per subject per level.
-- Real and persisted, but NOT yet read by Timetable's auto-generate,
-- which still derives its demand from staff_assignments (see
-- core/timetableGenerator.js) -- wiring the generator to this table
-- instead is a follow-on change to an already-shipped module, not part
-- of this pass. subject_name is denormalized against School Setup's
-- subjects.name, the same free-text linking School Setup itself already
-- uses for applicableClasses.
CREATE TABLE IF NOT EXISTS class_curriculum (
  id                VARCHAR(36) PRIMARY KEY,
  tenant_id         VARCHAR(36) NOT NULL,
  subject_name      VARCHAR(100) NOT NULL,
  class_name        VARCHAR(50) NOT NULL,
  periods_per_cycle INT NOT NULL DEFAULT 0,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NULL,
  UNIQUE KEY uniq_curriculum_row (tenant_id, subject_name, class_name),
  CONSTRAINT fk_class_curriculum_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_class_curriculum_tenant ON class_curriculum (tenant_id, class_name);

-- Promotion & year rollover (screen 8) -- one row per confirmed run,
-- storing exactly what changed so it can be rolled back within its
-- window. A dry-run preview (GET /classes/promotion/preview) never
-- writes a row; only a confirmed POST /classes/promotion/execute does.
CREATE TABLE IF NOT EXISTS class_promotion_runs (
  id              VARCHAR(36) PRIMARY KEY,
  tenant_id       VARCHAR(36) NOT NULL,
  from_year       VARCHAR(9) NOT NULL,
  to_year         VARCHAR(9) NOT NULL,
  moved_count     INT NOT NULL DEFAULT 0,
  repeat_count    INT NOT NULL DEFAULT 0,
  graduated_count INT NOT NULL DEFAULT 0,
  snapshot        JSON NOT NULL,
  rolled_back     TINYINT(1) NOT NULL DEFAULT 0,
  executed_by     VARCHAR(36) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_class_promotion_runs_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_class_promotion_runs_tenant ON class_promotion_runs (tenant_id, created_at);

-- Structure settings (screen 9) -- one row per tenant, the naming registry
-- other screens read. section_letters/default_seats are real and
-- editable; display/short format conventions ("Class 9 · A" / "9A") are
-- fixed, documented here rather than made freely editable, since changing
-- them would mean touching every screen that formats a class name.
CREATE TABLE IF NOT EXISTS class_structure_settings (
  tenant_id                 VARCHAR(36) PRIMARY KEY,
  section_letters           VARCHAR(50) NOT NULL DEFAULT 'A,B,C,D,E',
  default_seats             INT NOT NULL DEFAULT 35,
  default_seats_early_years INT NOT NULL DEFAULT 30,
  updated_at                DATETIME NULL,
  CONSTRAINT fk_class_structure_settings_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;

-- Settings module (edusphere-settings-module-plan-2026-09-23.md) --
-- Security Policy, one row per tenant. Defaults mirror this codebase's
-- actual current behaviour (see modules/settings/service.js's
-- SECURITY_POLICY_DEFAULTS) so a tenant with no row here behaves exactly
-- as it always has. Enforced at password-set time (invite + self-service
-- change-password) and at login time (lockout, session timeout) -- see
-- modules/auth/service.js and modules/users/routes.js.
CREATE TABLE IF NOT EXISTS security_policies (
  tenant_id                  VARCHAR(36) PRIMARY KEY,
  min_password_length        INT NOT NULL DEFAULT 8,
  require_uppercase          TINYINT(1) NOT NULL DEFAULT 0,
  require_number             TINYINT(1) NOT NULL DEFAULT 0,
  require_symbol             TINYINT(1) NOT NULL DEFAULT 0,
  password_expiry_days       INT NOT NULL DEFAULT 0,
  session_timeout_minutes    INT NOT NULL DEFAULT 480,
  max_failed_login_attempts  INT NOT NULL DEFAULT 5,
  lockout_duration_minutes   INT NOT NULL DEFAULT 15,
  updated_at                 DATETIME NULL,
  CONSTRAINT fk_security_policies_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;

-- ═══════════════════════════════════════════════════════════════════════
-- Fees & Payments (designs/Teacher feature UI mockup/Fees and Payments.dc.html,
-- 9 screens, /fees). This module is a RECORD of an offline collection
-- process, not a payment gateway: no money moves through the portal.
-- Guardians pay by EFT/debit order/card/cash outside the system; the
-- school pays refunds/suppliers out on its own bank portal. The spine is
-- fee structure -> invoice -> recorded payment -> receipt -> reconciliation.
--
-- Deliberately separate from School Setup's existing `fee_types` table
-- (flat amount, free-text applicable classes, no phase pricing or
-- versioning, already shipped as the "Fee Configuration" tab). The two
-- co-exist as a documented, deliberate overlap -- see
-- modules/fees/routes.js header and the project plan doc -- rather than
-- migrating an already-shipped School Setup screen in this pass.
--
-- Scope cuts agreed with Vishnu before building (see project doc
-- edusphere-fees-payments-module-plan-2026-09-18.md): bursaries are a
-- manual discount line on an invoice, not a separate award-tracking
-- entity; bank reconciliation lines are entered by hand, not parsed from
-- an uploaded statement; guardian email/SMS (invoice issued, receipts,
-- reminders, statements) is honestly not wired -- no Notices &
-- Communication backend exists in this codebase, same as every prior
-- module.
-- ═══════════════════════════════════════════════════════════════════════

-- One row per published/draft structure version per tenant. Editing a
-- published structure creates a new draft version rather than mutating
-- history -- only the currently-published version prices new invoices,
-- so an invoice already raised is never silently repriced.
CREATE TABLE IF NOT EXISTS fee_structures (
  id            VARCHAR(36) PRIMARY KEY,
  tenant_id     VARCHAR(36) NOT NULL,
  version       INT NOT NULL,
  status        ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  published_at  DATETIME NULL,
  created_by    VARCHAR(36) NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_fee_structure_version (tenant_id, version),
  CONSTRAINT fk_fee_structures_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_fee_structures_tenant ON fee_structures (tenant_id, status);

-- Fee heads priced per real Classes & Sections phase (class_levels.phase),
-- not a hardcoded 3-column list. A NULL amount column means "not charged
-- at this phase" (mirrors the mock's em-dash cells), not zero.
CREATE TABLE IF NOT EXISTS fee_structure_heads (
  id                  VARCHAR(36) PRIMARY KEY,
  tenant_id           VARCHAR(36) NOT NULL,
  structure_id        VARCHAR(36) NOT NULL,
  name                VARCHAR(150) NOT NULL,
  type                ENUM('Core','Optional') NOT NULL DEFAULT 'Core',
  cycle               ENUM('Per term','One-off') NOT NULL DEFAULT 'Per term',
  amount_early_years  DECIMAL(10,2) NULL,
  amount_primary      DECIMAL(10,2) NULL,
  amount_secondary    DECIMAL(10,2) NULL,
  applies_to          VARCHAR(150) NOT NULL DEFAULT 'All learners',
  order_index         INT NOT NULL DEFAULT 0,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_fee_heads_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_fee_heads_structure FOREIGN KEY (structure_id) REFERENCES fee_structures(id)
) ENGINE=InnoDB;
CREATE INDEX idx_fee_heads_structure ON fee_structure_heads (tenant_id, structure_id);

-- Per-term billing schedule (screen 2's "Billing schedule" card). State
-- (Scheduled/In collection/Collected) is derived at read time from
-- whether invoices for that term exist/are settled, not stored here.
CREATE TABLE IF NOT EXISTS fee_billing_schedule (
  id             VARCHAR(36) PRIMARY KEY,
  tenant_id      VARCHAR(36) NOT NULL,
  term_label     VARCHAR(50) NOT NULL,
  due_date       DATE NOT NULL,
  share_percent  DECIMAL(5,2) NOT NULL,
  note           VARCHAR(255) NOT NULL DEFAULT '',
  order_index    INT NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_billing_term (tenant_id, term_label),
  CONSTRAINT fk_billing_schedule_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;

-- One row per tenant. Sibling discount and late-payment interest are
-- computed for real at invoice-raise/read time (see service.js). Early-
-- settlement discount and pro-rata are real, saved settings but are not
-- automatically applied by any trigger in this pass (full-year-paid /
-- mid-term-admission detection) -- flagged honestly in the Fee structure
-- screen, the same way Timetable's non-wired soft rules were labelled.
-- "Bursaries reduce the invoice, not the receipt" has no field of its own
-- -- it's a fact about how the manual bursary discount line works
-- (fee_invoice_lines.kind = 'bursary'), not a separate toggle.
CREATE TABLE IF NOT EXISTS fee_structure_rules (
  tenant_id                          VARCHAR(36) PRIMARY KEY,
  sibling_discount_percent          DECIMAL(5,2) NOT NULL DEFAULT 10,
  early_settlement_discount_percent DECIMAL(5,2) NOT NULL DEFAULT 5,
  late_payment_interest_percent     DECIMAL(5,2) NOT NULL DEFAULT 2,
  pro_rata_enabled                  TINYINT(1) NOT NULL DEFAULT 0,
  updated_at                        DATETIME NULL,
  CONSTRAINT fk_fee_rules_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;

-- One invoice per student per billing-schedule term. Status (Paid/
-- Part-paid/Unpaid/Overdue) is derived at read time from invoice_lines
-- total vs. allocated payments + ageing, never stored redundantly, so a
-- late-recorded payment or a new interest line can never leave a stale
-- status behind.
CREATE TABLE IF NOT EXISTS fee_invoices (
  id                VARCHAR(36) PRIMARY KEY,
  tenant_id         VARCHAR(36) NOT NULL,
  invoice_no        VARCHAR(30) NOT NULL,
  student_id        VARCHAR(36) NOT NULL,
  class_name        VARCHAR(50) NOT NULL,
  section           VARCHAR(20) NOT NULL,
  term_label        VARCHAR(50) NOT NULL,
  due_date          DATE NOT NULL,
  structure_version INT NOT NULL,
  raised_by         VARCHAR(36) NOT NULL,
  raised_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_invoice_no (tenant_id, invoice_no),
  CONSTRAINT fk_invoices_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_invoices_student FOREIGN KEY (student_id) REFERENCES students(id)
) ENGINE=InnoDB;
CREATE INDEX idx_invoices_lookup ON fee_invoices (tenant_id, student_id, term_label);
CREATE INDEX idx_invoices_due ON fee_invoices (tenant_id, due_date);

-- Line items. kind='head' is a real fee head charge; discount/interest/
-- bursary/other are signed adjustment lines (negative for a reduction,
-- positive for interest). A bursary is just a discount-kind line with a
-- reason string (e.g. "Bursary -- Academic merit, School fund") -- see
-- schema header re: no separate award-tracking table this pass.
CREATE TABLE IF NOT EXISTS fee_invoice_lines (
  id          VARCHAR(36) PRIMARY KEY,
  tenant_id   VARCHAR(36) NOT NULL,
  invoice_id  VARCHAR(36) NOT NULL,
  kind        ENUM('head','discount','interest','bursary','other') NOT NULL DEFAULT 'head',
  label       VARCHAR(150) NOT NULL,
  note        VARCHAR(255) NOT NULL DEFAULT '',
  qty         INT NOT NULL DEFAULT 1,
  rate        DECIMAL(10,2) NULL,
  amount      DECIMAL(10,2) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_invoice_lines_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_invoice_lines_invoice FOREIGN KEY (invoice_id) REFERENCES fee_invoices(id)
) ENGINE=InnoDB;
CREATE INDEX idx_invoice_lines_invoice ON fee_invoice_lines (tenant_id, invoice_id);

-- A recorded payment. `confirmed` is the unconfirmed/confirmed spine of
-- the whole module -- false until a bank_statement_lines row matches it,
-- exactly mirroring the mock's "Recorded as unconfirmed until the
-- September bank statement is imported and this line matches."
CREATE TABLE IF NOT EXISTS fee_payments (
  id                 VARCHAR(36) PRIMARY KEY,
  tenant_id          VARCHAR(36) NOT NULL,
  student_id         VARCHAR(36) NOT NULL,
  amount_received    DECIMAL(10,2) NOT NULL,
  date_received      DATE NOT NULL,
  method             ENUM('EFT','Card','Cash','Debit order') NOT NULL,
  bank_reference     VARCHAR(150) NOT NULL DEFAULT '',
  proof_document_id  VARCHAR(36) NULL,
  confirmed          TINYINT(1) NOT NULL DEFAULT 0,
  recorded_by        VARCHAR(36) NOT NULL,
  recorded_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_payments_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_payments_student FOREIGN KEY (student_id) REFERENCES students(id)
) ENGINE=InnoDB;
CREATE INDEX idx_payments_student ON fee_payments (tenant_id, student_id);
CREATE INDEX idx_payments_reference ON fee_payments (tenant_id, bank_reference);

-- Splits one recorded payment across one or more invoices (oldest-first
-- by default, overridable at record time).
CREATE TABLE IF NOT EXISTS fee_payment_allocations (
  id          VARCHAR(36) PRIMARY KEY,
  tenant_id   VARCHAR(36) NOT NULL,
  payment_id  VARCHAR(36) NOT NULL,
  invoice_id  VARCHAR(36) NOT NULL,
  amount      DECIMAL(10,2) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_allocations_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_allocations_payment FOREIGN KEY (payment_id) REFERENCES fee_payments(id),
  CONSTRAINT fk_allocations_invoice FOREIGN KEY (invoice_id) REFERENCES fee_invoices(id)
) ENGINE=InnoDB;
CREATE INDEX idx_allocations_invoice ON fee_payment_allocations (tenant_id, invoice_id);

-- Real, tracked instalment agreements (screen 7's "PLAN" column). state
-- is stored as the lifecycle (active/broken/completed); the mock's
-- display labels (On track/In arrears/Completing) are derived at read
-- time from next_due_date vs. today and what's actually been recorded
-- against invoice_ids, not stored redundantly. Capped at 6 instalments
-- (enforced in service.js), matching the mock's own stated rule.
CREATE TABLE IF NOT EXISTS fee_payment_plans (
  id                 VARCHAR(36) PRIMARY KEY,
  tenant_id          VARCHAR(36) NOT NULL,
  student_id         VARCHAR(36) NOT NULL,
  total_amount       DECIMAL(10,2) NOT NULL,
  instalment_amount  DECIMAL(10,2) NOT NULL,
  instalment_count   INT NOT NULL,
  start_date         DATE NOT NULL,
  next_due_date      DATE NOT NULL,
  invoice_ids        JSON NOT NULL,
  status             ENUM('active','completed','broken') NOT NULL DEFAULT 'active',
  created_by         VARCHAR(36) NOT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_plans_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_plans_student FOREIGN KEY (student_id) REFERENCES students(id)
) ENGINE=InnoDB;
CREATE INDEX idx_plans_student ON fee_payment_plans (tenant_id, student_id);

-- Bank lines entered by hand (see schema header -- no CSV/statement
-- import this pass). matched_payment_id + confidence are set by the real
-- reference-then-amount matching engine in service.js, not by the person
-- entering the line.
CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id                  VARCHAR(36) PRIMARY KEY,
  tenant_id           VARCHAR(36) NOT NULL,
  line_date           DATE NOT NULL,
  reference           VARCHAR(150) NOT NULL,
  amount              DECIMAL(10,2) NOT NULL,
  matched_payment_id  VARCHAR(36) NULL,
  confidence          ENUM('Exact','Likely','None') NOT NULL DEFAULT 'None',
  reviewed_by         VARCHAR(36) NULL,
  reviewed_at         DATETIME NULL,
  created_by          VARCHAR(36) NOT NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_bank_lines_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_bank_lines_payment FOREIGN KEY (matched_payment_id) REFERENCES fee_payments(id)
) ENGINE=InnoDB;
CREATE INDEX idx_bank_lines_confidence ON bank_statement_lines (tenant_id, confidence);

-- Money OUT: refunds to guardians and supplier settlements (screen 8).
-- Gated by fees.refund. The two-person rule (requester != approver above
-- R10 000) is enforced in service.js, not just descriptive UI copy.
CREATE TABLE IF NOT EXISTS fee_disbursements (
  id                 VARCHAR(36) PRIMARY KEY,
  tenant_id          VARCHAR(36) NOT NULL,
  reference          VARCHAR(30) NOT NULL,
  disb_date          DATE NOT NULL,
  payee_name         VARCHAR(150) NOT NULL,
  reason             VARCHAR(255) NOT NULL,
  amount             DECIMAL(10,2) NOT NULL,
  method             ENUM('EFT','Cash','Cheque') NOT NULL DEFAULT 'EFT',
  state              ENUM('Awaiting approval','Approved','Paid','Declined') NOT NULL DEFAULT 'Awaiting approval',
  proof_document_id  VARCHAR(36) NULL,
  requested_by       VARCHAR(36) NOT NULL,
  approved_by        VARCHAR(36) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at         DATETIME NULL,
  UNIQUE KEY uniq_disbursement_ref (tenant_id, reference),
  CONSTRAINT fk_disbursements_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_disbursements_state ON fee_disbursements (tenant_id, state);

-- Escalation ladder (screen 7). Automatic reminder counts are derived
-- live from invoice ageing in service.js; this table is the real,
-- queryable log of the two MANUAL steps ("Manual - principal signs" /
-- "Governing body approval needed"), so "Run queued steps" writes
-- something real instead of just flipping a badge, and so a step is
-- never double-counted against the same invoice.
-- Payment channels & policy (screen 9). accepted_channels/notify_rules
-- are saved for real; guardian-communication toggles are honestly NOT
-- wired to anything (no Notices & Communication backend exists in this
-- codebase -- same precedent as attendance_settings.notify_rules).
CREATE TABLE IF NOT EXISTS fee_settings (
  tenant_id         VARCHAR(36) PRIMARY KEY,
  accepted_channels JSON NOT NULL,
  reference_format  VARCHAR(100) NOT NULL DEFAULT 'SURNAME + class, e.g. BOTHA9A',
  notify_rules      JSON NOT NULL,
  updated_at        DATETIME NULL,
  CONSTRAINT fk_fee_settings_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS fee_escalation_events (
  id          VARCHAR(36) PRIMARY KEY,
  tenant_id   VARCHAR(36) NOT NULL,
  student_id  VARCHAR(36) NOT NULL,
  invoice_id  VARCHAR(36) NULL,
  step        ENUM('first_reminder','second_reminder','letter_of_demand','handover') NOT NULL,
  note        VARCHAR(500) NOT NULL DEFAULT '',
  created_by  VARCHAR(36) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_escalation_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_escalation_student FOREIGN KEY (student_id) REFERENCES students(id)
) ENGINE=InnoDB;
CREATE INDEX idx_escalation_student ON fee_escalation_events (tenant_id, student_id);

-- ============================================================================
-- Examinations (designs/Teacher feature UI mockup/Examinations.dc.html, 9
-- screens). See the project plan doc
-- (edusphere-examinations-module-plan-2026-09-20.md) for the full design
-- rationale and the four binding decisions made with Vishnu before this was
-- written: (1) the Datesheet (screen 3) is the exam_sessions table above,
-- extended, not a parallel table; (2) the grading scale (screen 9) is the
-- `grades` table above, extended, not a new multi-scale model; (3) marks
-- entry/moderation are gated by exams.update/exams.publish held by
-- admin-level roles only -- there is no teacher-portal/login concept
-- anywhere in this codebase, so "assigned teacher" fields below are
-- informational labels, not an access boundary; (4) report cards generate
-- real PDF files this pass (see modules/exams/service.js).
--
-- class_name/section throughout match every other module's free-text
-- convention (students.class_name, exam_sessions.class_name,
-- staff_assignments.class_name) rather than joining through Classes &
-- Sections' class_levels/class_sections ids -- consistent with the
-- existing "migration due" gap already documented on those other tables
-- (see classes/routes.js), not a new one invented here.

CREATE TABLE IF NOT EXISTS exam_cycles (
  id                    VARCHAR(36) PRIMARY KEY,
  tenant_id             VARCHAR(36) NOT NULL,
  name                  VARCHAR(150) NOT NULL,
  academic_term         VARCHAR(50) NOT NULL DEFAULT '',
  exam_type             ENUM('Class test','Mid-term','Term final','Practical','Mock') NOT NULL DEFAULT 'Mid-term',
  window_opens          DATE NOT NULL,
  window_closes         DATE NOT NULL,
  weight_in_term_mark   DECIMAL(5,2) NOT NULL DEFAULT 0,
  class_names           JSON NOT NULL,
  marks_entry_closes    DATETIME NULL,
  -- Informational only -- see decision 3 above. One of: assigned_teacher,
  -- assigned_or_class_teacher, exam_officer. Never checked by any route.
  entry_role_policy     VARCHAR(50) NOT NULL DEFAULT 'assigned_teacher',
  stage                 ENUM('planned','datesheet_draft','marking','moderation','results','published','closed') NOT NULL DEFAULT 'planned',
  copied_from_cycle_id  VARCHAR(36) NULL,
  publish_settings      JSON NULL,
  created_by            VARCHAR(36) NOT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NULL,
  CONSTRAINT fk_exam_cycles_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_exam_cycles_tenant ON exam_cycles (tenant_id, stage);

-- Paper & marks structure (screen 4). One row per cycle+class+subject; a
-- subject's components must sum their max to the subject's own max_marks
-- before marks entry opens for it (checked in service.js, not stored as a
-- boolean -- storing it would just be a second place it could go stale).
CREATE TABLE IF NOT EXISTS exam_structure (
  id           VARCHAR(36) PRIMARY KEY,
  tenant_id    VARCHAR(36) NOT NULL,
  cycle_id     VARCHAR(36) NOT NULL,
  class_name   VARCHAR(50) NOT NULL,
  subject_name VARCHAR(150) NOT NULL,
  max_marks    DECIMAL(6,2) NOT NULL,
  pass_marks   DECIMAL(6,2) NOT NULL,
  weight       DECIMAL(4,2) NOT NULL DEFAULT 1.0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NULL,
  UNIQUE KEY uniq_exam_structure (tenant_id, cycle_id, class_name, subject_name),
  CONSTRAINT fk_exam_structure_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_exam_structure_cycle FOREIGN KEY (cycle_id) REFERENCES exam_cycles(id)
) ENGINE=InnoDB;
CREATE INDEX idx_exam_structure_cycle ON exam_structure (tenant_id, cycle_id, class_name);

CREATE TABLE IF NOT EXISTS exam_structure_components (
  id            VARCHAR(36) PRIMARY KEY,
  tenant_id     VARCHAR(36) NOT NULL,
  structure_id  VARCHAR(36) NOT NULL,
  name          VARCHAR(100) NOT NULL,
  max_marks     DECIMAL(6,2) NOT NULL,
  pass_marks    DECIMAL(6,2) NOT NULL,
  order_index   INT NOT NULL DEFAULT 0,
  CONSTRAINT fk_exam_components_structure FOREIGN KEY (structure_id) REFERENCES exam_structure(id)
) ENGINE=InnoDB;
CREATE INDEX idx_exam_components_structure ON exam_structure_components (tenant_id, structure_id);

-- Marks entry + moderation (screens 5, 6). One marksheet per
-- cycle+class+section+subject -- exactly the unit a teacher submits and a
-- moderator approves/returns, matching the mockup's own "8·C Natural
-- Sciences" sheet naming. teacher_staff_id is looked up from
-- staff_assignments for display only (see decision 3 -- not an access
-- check). flags is a small JSON array of short strings ("2 outliers",
-- "2 blank") built at submit time for the moderation queue's FLAGS
-- column; "Flagged" in the UI is a client-side filter over these, not a
-- fifth status.
CREATE TABLE IF NOT EXISTS exam_marksheets (
  id               VARCHAR(36) PRIMARY KEY,
  tenant_id        VARCHAR(36) NOT NULL,
  cycle_id         VARCHAR(36) NOT NULL,
  class_name       VARCHAR(50) NOT NULL,
  section          VARCHAR(20) NOT NULL,
  subject_name     VARCHAR(150) NOT NULL,
  teacher_staff_id VARCHAR(36) NULL,
  status           ENUM('draft','submitted','approved','returned') NOT NULL DEFAULT 'draft',
  submitted_by     VARCHAR(36) NULL,
  submitted_at     DATETIME NULL,
  decided_by       VARCHAR(36) NULL,
  decided_at       DATETIME NULL,
  reviewer_note    VARCHAR(1000) NOT NULL DEFAULT '',
  mean             DECIMAL(6,2) NULL,
  pass_rate_pct    DECIMAL(5,2) NULL,
  flags            JSON NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NULL,
  UNIQUE KEY uniq_exam_marksheet (tenant_id, cycle_id, class_name, section, subject_name),
  CONSTRAINT fk_exam_marksheets_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_exam_marksheets_cycle FOREIGN KEY (cycle_id) REFERENCES exam_cycles(id)
) ENGINE=InnoDB;
CREATE INDEX idx_exam_marksheets_cycle ON exam_marksheets (tenant_id, cycle_id, status);

-- flag: absent (a real absence with a note), not_entered (blank -- a real,
-- distinct state from absent, per the mockup's own "Not entered" vs
-- "Absent" flags), outlier (>2 std dev vs a historical mean -- only ever
-- set once 3+ years of cycles exist, see service.js), below_pass.
CREATE TABLE IF NOT EXISTS exam_marks (
  id               VARCHAR(36) PRIMARY KEY,
  tenant_id        VARCHAR(36) NOT NULL,
  marksheet_id     VARCHAR(36) NOT NULL,
  student_id       VARCHAR(36) NOT NULL,
  component_marks  JSON NULL,
  total            DECIMAL(6,2) NULL,
  grade             VARCHAR(10) NULL,
  flag             ENUM('absent','not_entered','outlier','below_pass') NULL,
  remark           VARCHAR(255) NOT NULL DEFAULT '',
  updated_at       DATETIME NULL,
  UNIQUE KEY uniq_exam_mark (tenant_id, marksheet_id, student_id),
  CONSTRAINT fk_exam_marks_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_exam_marks_sheet FOREIGN KEY (marksheet_id) REFERENCES exam_marksheets(id),
  CONSTRAINT fk_exam_marks_student FOREIGN KEY (student_id) REFERENCES students(id)
) ENGINE=InnoDB;
CREATE INDEX idx_exam_marks_sheet ON exam_marks (tenant_id, marksheet_id);

-- Report cards (screen 8) -- one class-teacher comment per cycle+student,
-- collected before a batch can generate (mockup's own stated rule).
CREATE TABLE IF NOT EXISTS exam_report_comments (
  id                      VARCHAR(36) PRIMARY KEY,
  tenant_id               VARCHAR(36) NOT NULL,
  cycle_id                VARCHAR(36) NOT NULL,
  class_name              VARCHAR(50) NOT NULL,
  student_id              VARCHAR(36) NOT NULL,
  comment                 VARCHAR(1000) NOT NULL DEFAULT '',
  class_teacher_staff_id  VARCHAR(36) NULL,
  updated_at              DATETIME NULL,
  UNIQUE KEY uniq_exam_comment (tenant_id, cycle_id, student_id),
  CONSTRAINT fk_exam_comments_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_exam_comments_cycle FOREIGN KEY (cycle_id) REFERENCES exam_cycles(id)
) ENGINE=InnoDB;

-- Publish, grading scale & audit (screen 9) -- append-only, mirrors
-- attendance_history's shape exactly (before_json/after_json/actor_id/at).
CREATE TABLE IF NOT EXISTS exam_audit_log (
  id          VARCHAR(36) PRIMARY KEY,
  tenant_id   VARCHAR(36) NOT NULL,
  cycle_id    VARCHAR(36) NULL,
  event       VARCHAR(100) NOT NULL,
  actor_id    VARCHAR(36) NOT NULL,
  target      VARCHAR(150) NULL,
  detail      VARCHAR(500) NOT NULL DEFAULT '',
  before_json JSON NULL,
  after_json  JSON NULL,
  at          DATETIME NOT NULL,
  CONSTRAINT fk_exam_audit_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_exam_audit_cycle ON exam_audit_log (tenant_id, cycle_id, at);

-- Parent Registry (see "Parent Registry Blueprint" plan artifact,
-- 2026-09-20, and modules/parents/service.js's header for the full
-- rationale). students.guardians (see that table's own comment, above)
-- is left completely unchanged and kept as a legacy fallback -- every
-- existing screen that reads it keeps working unmodified. A one-time,
-- safe-to-re-run backfill (modules/parents/service.js's
-- backfillFromGuardians()) migrates each student's guardians{} JSON into
-- real rows here, deduping by phone/email exactly like the interactive
-- Add/Link Parent flow does.
CREATE TABLE IF NOT EXISTS parents (
  id            VARCHAR(36) PRIMARY KEY,
  tenant_id     VARCHAR(36) NOT NULL,
  full_name     VARCHAR(150) NOT NULL,
  phone         VARCHAR(30) NOT NULL DEFAULT '',
  email         VARCHAR(150) NOT NULL DEFAULT '',
  address       VARCHAR(300) NOT NULL DEFAULT '',
  occupation    VARCHAR(100) NOT NULL DEFAULT '',
  -- Stored, not wired to a real login -- there is no parent-login concept
  -- anywhere in this codebase yet (same gap the teacher portal has). See
  -- the Portal tab's own honest-scope note.
  portal_access TINYINT(1) NOT NULL DEFAULT 0,
  status        ENUM('active','inactive','merged') NOT NULL DEFAULT 'active',
  merged_into   VARCHAR(36) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NULL,
  CONSTRAINT fk_parents_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_parents_tenant_status ON parents (tenant_id, status);

-- One row per parent<->student relationship -- a parent can have several
-- linked children and a child can have several linked parents/guardians.
CREATE TABLE IF NOT EXISTS parent_student_links (
  id                    VARCHAR(36) PRIMARY KEY,
  tenant_id             VARCHAR(36) NOT NULL,
  parent_id             VARCHAR(36) NOT NULL,
  student_id            VARCHAR(36) NOT NULL,
  relationship          ENUM('father','mother','guardian','other') NOT NULL,
  is_primary_contact    TINYINT(1) NOT NULL DEFAULT 0,
  is_emergency_contact  TINYINT(1) NOT NULL DEFAULT 0,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_parent_student (tenant_id, parent_id, student_id),
  CONSTRAINT fk_parent_links_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_parent_links_parent FOREIGN KEY (parent_id) REFERENCES parents(id),
  CONSTRAINT fk_parent_links_student FOREIGN KEY (student_id) REFERENCES students(id)
) ENGINE=InnoDB;
CREATE INDEX idx_parent_links_parent ON parent_student_links (tenant_id, parent_id);
CREATE INDEX idx_parent_links_student ON parent_student_links (tenant_id, student_id);

-- Notices & Communication (edusphere-notices-communication-module-plan-
-- 2026-09-22.md). One resource covers both the notice board and "direct
-- & group messaging" -- a message is just a notice whose audience is
-- narrowed to one class/role/individual rather than the entire school
-- (this codebase has no parent/student/teacher login to message into an
-- inbox). Status is deliberately NOT a stored enum -- it is computed at
-- read time from publish_at/expiry_at/is_draft/is_archived (see
-- modules/notices/service.js) so it can never drift out of sync with a
-- date that has simply passed; no cron/worker exists in this codebase to
-- keep a stored status current.
CREATE TABLE IF NOT EXISTS notices (
  id                      VARCHAR(36) PRIMARY KEY,
  tenant_id               VARCHAR(36) NOT NULL,
  title                   VARCHAR(200) NOT NULL,
  category                ENUM('notice','circular','announcement','event') NOT NULL DEFAULT 'notice',
  description             TEXT NOT NULL,
  -- Audience is a descriptive target for filtering/record-keeping in the
  -- admin panel, not an enforcement mechanism -- see the plan doc's
  -- "pivotal constraint" note. audience_role/class_name/section/
  -- recipient_* are only ever populated for the matching audience_type.
  audience_type           ENUM('entire_school','role','class','individual') NOT NULL DEFAULT 'entire_school',
  audience_role           VARCHAR(20) NULL,
  audience_class_name     VARCHAR(50) NULL,
  audience_section        VARCHAR(20) NULL,
  audience_recipient_type VARCHAR(20) NULL,
  audience_recipient_id   VARCHAR(36) NULL,
  publish_at              DATETIME NOT NULL,
  expiry_at               DATETIME NULL,
  is_draft                TINYINT(1) NOT NULL DEFAULT 1,
  is_archived             TINYINT(1) NOT NULL DEFAULT 0,
  created_by              VARCHAR(36) NOT NULL,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME NULL,
  CONSTRAINT fk_notices_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;
CREATE INDEX idx_notices_tenant_status ON notices (tenant_id, is_draft, is_archived, publish_at);
CREATE INDEX idx_notices_tenant_category ON notices (tenant_id, category);

-- Acknowledgement is an admin manually recording that a recipient was
-- informed (phone/paper/in person) -- there is no recipient login to
-- produce a real read receipt, so this is an honest log, not a
-- fabricated delivery/read status. Same disclosed-simplification pattern
-- as attendance_interventions above.
CREATE TABLE IF NOT EXISTS notice_acknowledgements (
  id             VARCHAR(36) PRIMARY KEY,
  tenant_id      VARCHAR(36) NOT NULL,
  notice_id      VARCHAR(36) NOT NULL,
  recipient_label VARCHAR(200) NOT NULL,
  method         ENUM('phone','in_person','paper','other') NOT NULL DEFAULT 'other',
  note           VARCHAR(500) NOT NULL DEFAULT '',
  recorded_by    VARCHAR(36) NOT NULL,
  recorded_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notice_ack_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_notice_ack_notice FOREIGN KEY (notice_id) REFERENCES notices(id)
) ENGINE=InnoDB;
CREATE INDEX idx_notice_ack_notice ON notice_acknowledgements (tenant_id, notice_id);

-- Payroll (Teachers & Staff > Payroll summary + each staff profile's
-- Payroll tab; edusphere-staff-payroll-build-2026-09-24.md). A RECORD of
-- an offline payroll process, same trust boundary as Fees: salaries are
-- paid outside the system and marked as paid here. No statutory tax
-- tables -- every deduction (PAYE, UIF, pension, medical aid, ...) is an
-- admin-entered fixed amount or percentage per staff member.
--
-- One pay setup per staff member. allowances: [{label, amount}];
-- deductions: [{label, type: 'fixed'|'percent', value}]; bank:
-- {accountHolder, bankName, accountNumber, branchCode, verified}.
CREATE TABLE IF NOT EXISTS staff_pay_profiles (
  id             VARCHAR(36) PRIMARY KEY,
  tenant_id      VARCHAR(36) NOT NULL,
  staff_id       VARCHAR(36) NOT NULL,
  basic_salary   DECIMAL(12,2) NOT NULL DEFAULT 0,
  allowances     JSON NULL,
  deductions     JSON NULL,
  bank           JSON NULL,
  updated_by     VARCHAR(36) NULL,
  updated_at     DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_pay_profile_staff (tenant_id, staff_id),
  CONSTRAINT fk_pay_profiles_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_pay_profiles_staff FOREIGN KEY (staff_id) REFERENCES staff(id)
) ENGINE=InnoDB;

-- One run per school per month ('YYYY-MM'). draft -> finalised -> paid.
-- Totals are stored when the run is (re)calculated so the list view and
-- department roll-up never disagree with the payslips.
CREATE TABLE IF NOT EXISTS payroll_runs (
  id                VARCHAR(36) PRIMARY KEY,
  tenant_id         VARCHAR(36) NOT NULL,
  period            CHAR(7) NOT NULL,
  status            ENUM('draft','finalised','paid') NOT NULL DEFAULT 'draft',
  totals            JSON NULL,
  missing_profiles  JSON NULL,
  created_by        VARCHAR(36) NULL,
  calculated_at     DATETIME NULL,
  finalised_by      VARCHAR(36) NULL,
  finalised_at      DATETIME NULL,
  paid_by           VARCHAR(36) NULL,
  paid_at           DATETIME NULL,
  paid_on           DATE NULL,
  paid_reference    VARCHAR(100) NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_payroll_run_period (tenant_id, period),
  CONSTRAINT fk_payroll_runs_school FOREIGN KEY (tenant_id) REFERENCES schools(id)
) ENGINE=InnoDB;

-- A payslip is a SNAPSHOT of the pay setup + leave at calculation time, so
-- editing a salary later never rewrites a finalised/paid month.
CREATE TABLE IF NOT EXISTS payroll_payslips (
  id                   VARCHAR(36) PRIMARY KEY,
  tenant_id            VARCHAR(36) NOT NULL,
  run_id               VARCHAR(36) NOT NULL,
  staff_id             VARCHAR(36) NOT NULL,
  period               CHAR(7) NOT NULL,
  staff_name           VARCHAR(200) NOT NULL,
  employee_id          VARCHAR(50) NOT NULL,
  department           VARCHAR(100) NOT NULL,
  designation          VARCHAR(100) NOT NULL,
  basic_salary         DECIMAL(12,2) NOT NULL DEFAULT 0,
  allowances           JSON NULL,
  gross_pay            DECIMAL(12,2) NOT NULL DEFAULT 0,
  unpaid_leave_days    DECIMAL(5,1) NOT NULL DEFAULT 0,
  leave_deduction      DECIMAL(12,2) NOT NULL DEFAULT 0,
  deductions           JSON NULL,
  total_deductions     DECIMAL(12,2) NOT NULL DEFAULT 0,
  net_pay              DECIMAL(12,2) NOT NULL DEFAULT 0,
  bank_verified        TINYINT(1) NOT NULL DEFAULT 0,
  bank_summary         VARCHAR(120) NULL,
  exceptions           JSON NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_payslips_school FOREIGN KEY (tenant_id) REFERENCES schools(id),
  CONSTRAINT fk_payslips_run FOREIGN KEY (run_id) REFERENCES payroll_runs(id),
  CONSTRAINT fk_payslips_staff FOREIGN KEY (staff_id) REFERENCES staff(id)
) ENGINE=InnoDB;
CREATE INDEX idx_payslips_run ON payroll_payslips (tenant_id, run_id);
CREATE INDEX idx_payslips_staff ON payroll_payslips (tenant_id, staff_id, period);
