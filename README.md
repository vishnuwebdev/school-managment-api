# EduSphere API

Multi-tenant school management API. One platform hosts many schools; each
school's data, users, roles and configuration are isolated from every other school.

It implements the system design in
[`docs/architecture/source-notes`](docs/architecture/source-notes/README.md).
**Phase 1 (platform core)** is in place: identity, schools, roles and
permissions, plans and entitlements, audit, background events. Business modules
(students, attendance, fees, exams, …) are rebuilt on this core phase by phase;
their previous JavaScript implementation is kept in [`legacy/`](legacy/) only
as a reference while porting.

```
api/
├── src/
│   ├── catalog/        features, permissions, system roles, plans (single source of truth)
│   ├── db/             schema, client, migrate, seed
│   ├── http/           route definitions, request pipeline, OpenAPI
│   ├── modules/        identity · tenants · members · access · entitlements · audit · catalog
│   ├── platform/       audit log, outbox, request context
│   ├── events/         outbox relay + idempotent event handlers
│   ├── server.ts       HTTP API
│   └── worker.ts       background worker
├── drizzle/            SQL migrations
├── tests/              integration (real MySQL + Redis) and unit tests
├── docs/               decisions, conventions, OpenAPI, design notes
├── legacy/             previous JS API (reference only — not built or run)
└── docker-compose.yml  local stack
```

## Run it

**Docker (one command):**

```bash
docker compose up --build
```

MySQL, Redis, migrations + seed, the API on <http://localhost:4000> and the
worker. Emails (invitations, password resets) are printed in the worker log:
`docker compose logs worker`.

**Node on your machine** (Node 22+, MySQL 8 and Redis running):

```bash
npm install
cp .env.example .env         # edit DATABASE_URL / REDIS_URL / JWT_SECRET
npm run db:migrate
npm run db:seed              # reference data + first Super Admin
npm run dev                  # API on :4000
npm run dev:worker           # second terminal: emails and events
```

The seed creates the Super Admin from `SEED_SUPER_ADMIN_EMAIL` /
`SEED_SUPER_ADMIN_PASSWORD` (default `superadmin@example.com` / `ChangeMe!12345` — change it).

## Test it

```bash
docker compose up -d mysql redis
TEST_DATABASE_URL=mysql://root:root@localhost:3306/sms_test npm test
```

A manual walkthrough (create → provision → invite → sign in) is in
[`docs/phase-1-review.md`](docs/phase-1-review.md). The full contract is
`docs/api/openapi.json` (also served at `/openapi.json`); import it into Postman.

## Commands

| Command                              | What it does                          |
| ------------------------------------ | ------------------------------------- |
| `npm test`                           | All tests (needs MySQL + Redis)       |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript                   |
| `npm run format`                     | Prettier                              |
| `npm run db:generate`                | New SQL migration from schema changes |
| `npm run openapi`                    | Regenerate `docs/api/openapi.json`    |

## Rules every module follows

1. The tenant comes from the signed-in membership — never from the request body or query.
2. Routes declare permissions; the pipeline checks the permission **and** the school's
   entitlement to that permission's feature. No role-name checks in code.
3. A business change, its audit row and its outbox event commit in one transaction.
4. Another school's ids behave exactly like missing ids (404).
5. Nobody can grant what they do not hold.

Details: [decisions](docs/architecture/decisions.md) ·
[database conventions](docs/architecture/database-conventions.md).
