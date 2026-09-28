# EduSphere API foundation

## Local setup

```
cp .env.example .env
npm install
npm run dev
```

The default `.env` uses `DATABASE_DRIVER=memory` — a zero-setup, in-process
store that auto-seeds a demo school, three roles, and one login per role on
every boot. Nothing persists across restarts; this is for trying the API
and for local Flutter development only.

Demo logins (password `ChangeMe123!` for all three):

```
superadmin@edusphere.app   Super Admin   (platform-wide)
admin@brightfuture.edu     School Admin  (Bright Future International School)
subadmin@brightfuture.edu  Sub Admin     (limited starter permission set)
```

`POST /api/auth/login` with `{ email, password }` returns a JWT plus the
resolved permission list. `POST /api/auth/dev-login` with `{ role }` is a
zero-password shortcut for local development only — disable it in any
shared environment with `ALLOW_DEV_LOGIN=false`.

## Switching to a real database

1. Pick `mysql` or `mongo` and set `DATABASE_DRIVER` + `DATABASE_URL` in `.env`.
2. For MySQL: create an empty database, then apply the schema once:
   `mysql -u <user> -p <database> < src/db/schema.sql`.
   For MongoDB: nothing to apply up front — indexes are created on connect.
3. Run `npm run seed` once against the fresh database (creates the same
   demo school/roles/users as the memory driver, so you can log in the
   same way).
4. `npm run dev`.

The `mysql`/`mongo` adapters (`src/db/adapters/`) were written against this
schema but have not been exercised against a live instance in this
environment — sanity-check `/health` and a login once you point them at a
real database, and flag anything that doesn't match in
`context-memory/`.

## Architecture

- `src/config/env.js` — the only place that reads `process.env`.
- `src/core/` — auth/tenant/permission middleware, the permission catalog,
  and the shared error type.
- `src/db/` — the repository contract and its three adapters (memory,
  mysql, mongo), selected by `DATABASE_DRIVER`. Every module reads/writes
  through `db`, never through a raw query of its own.
- `src/modules/<domain>/` — routes + service per business domain (auth,
  schools, users, students, attendance, storage/documents, audit). This is
  a modular monolith (per `coding-agent/references/architecture.md`), not
  microservices — new Phase 1 modules (fees, exams, timetable, ...) should
  each get their own folder here following the same shape.

## What's still missing

School setup, academic years, classes/sections, subjects, parents,
teachers/staff, fees, examinations, timetable, notices, and reports have no
endpoints yet — see `context-memory/gap-analysis-2026-09-14.md` for the
full picture and the recommended build order.
