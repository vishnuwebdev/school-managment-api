
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
  status        ENUM('draft','published') NOT NULL DEFAULT 'draft',
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
