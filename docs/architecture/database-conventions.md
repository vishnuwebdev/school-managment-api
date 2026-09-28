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

## Migrations

- Edit `src/db/schema/*.ts`, then `npm run db:generate -w apps/api` to create a
  SQL migration in `apps/api/drizzle/`. Review it and commit it.
- `npm run db:migrate -w apps/api` applies pending migrations (also used in deploys).
- Never change a production schema by hand. CI fails if the schema and the
  committed migrations drift.
