# Database conventions

Every new table in every module follows these rules. They are derived from
Part 21, Part 31 and Part 42 of the design notes.

## Identifiers

- Primary key `id CHAR(36)` holding a **UUIDv7**, generated in the application
  (`id()` helper in `src/db/schema/_columns.ts`). UUIDv7 is time-ordered, so
  inserts stay index-friendly.
- Business identifiers (admission number, invoice number…) are separate columns,
  unique **per tenant**: `UNIQUE (tenant_id, admission_number)`.

## Tenancy

- Every tenant-owned table has `tenant_id CHAR(36) NOT NULL` referencing
  `tenants.id`, even when a parent row already implies the tenant.
- Every query on a tenant-owned table filters by the tenant id from the
  request context (`req.ctx.tenant.tenantId`) — never from client input.
- Child rows copy the parent's `tenant_id`; services validate that referenced
  rows belong to the same tenant (a row from another tenant is a 404).
- Cross-table references inside a school use composite foreign keys
  `(tenant_id, x_id) → (tenant_id, id)` so the database rejects cross-school links. Every
  referenced table needs `UNIQUE (tenant_id, id)` (added to `memberships` for the teacher login link).
- Partial unique indexes ("one open X per Y") are emulated with a generated VIRTUAL column that
  is NULL when the row is closed, plus a UNIQUE on it (`open_key`, `current_key`, `active_key`,
  `pending_key`, `published_key`). A generated key can also make a composite business key unique
  (`session_key` on attendance sessions; `section_slot_key` / `teacher_slot_key` / `venue_slot_key`
  on timetable entries, which forbid double-booking).
- A child that must belong to the same parent AND the same year references a three-column unique
  key `(tenant_id, id, academic_year_id)` (timetable entries → sections, offerings, timetables).
- Nullable-tenant uniqueness uses a `tenant_key` column (`tenant_id` or a
  literal such as `'PLATFORM'` / `'SYSTEM'`), because MySQL treats NULLs as distinct.

## Columns

| Concern           | Convention                                                                       |
| ----------------- | -------------------------------------------------------------------------------- |
| Names             | `snake_case` in MySQL, `camelCase` in TypeScript                                 |
| Timestamps        | `DATETIME(3)` in UTC; `created_at`, `updated_at` on mutable rows                 |
| Lifecycle stamps  | Only when meaningful: `activated_at`, `suspended_at`, `archived_at`, …           |
| Money             | `BIGINT` minor units (paise/cents) + `CHAR(3)` currency. Never floats.           |
| Status            | `ENUM` from the shared lists in `src/db/schema/enums.ts`                         |
| Concurrency       | `version INT` on admin-edited rows; updates use `WHERE version = ?` (409 if not) |
| Flexible metadata | `JSON` only when the shape is genuinely open (e.g. `scope_ref`)                  |
| Actor             | `created_by` / `updated_by` user ids where it matters                            |

## Deletion

No generic soft-delete. Use domain states: `ARCHIVED`, `REVOKED`, `CANCELLED`,
`WITHDRAWN`… Never delete payments, allocations, attendance history,
published results, audit logs or stock movements — correct them with
reversals/adjustments.

## Indexes

Start with `(tenant_id, status)`, `(tenant_id, created_at)` and
`(tenant_id, <business key>)`; add others from real access patterns.

## Transactions & events

- A business change, its audit row (`recordAudit`) and its outbox event
  (`publishEvent`) are written with the **same transaction executor**.
- Contended resources (payments, stock, seats, admin counts) are protected with
  `SELECT … FOR UPDATE` or conditional updates, not application-level checks alone.
- Under REPEATABLE READ a plain `SELECT` uses the transaction's snapshot. Any check that depends on a
  concurrent commit (roster, statuses, settings, pending rows) must be a locking read (`FOR SHARE` /
  `FOR UPDATE`) taken after the lock that serialises the change. Insert-then-catch-duplicate beats
  lock-then-insert for "open or get" (the latter deadlocks on gap locks).
- Drizzle renders correlated subqueries with unqualified columns; write those as raw `sql` with aliases.

## Migrations

- Edit `src/db/schema/*.ts`, then `npm run db:generate` to create a
  SQL migration in `drizzle/`. Review it and commit it.
- `npm run db:migrate` applies pending migrations (also used in deploys).
- Never change a production schema by hand. CI fails if the schema and the
  committed migrations drift.
