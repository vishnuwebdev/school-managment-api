# Phase 1 review — platform core

**Status:** complete. 73 automated tests pass against real MySQL 8 + Redis.
The design is applied in place to `api/` and `admin-panel-repo/`.

**Milestone proven:** Platform Admin → create school → provision → invite School
Admin → admin accepts → signs in → school context with permissions and features
(`tests/integration/provisioning.test.ts`), and the same flow in the admin panel.

## What was built

| Area             | Delivered                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation       | TypeScript, ESLint, Prettier, env validation, structured logs with secret redaction, request ids, health/readiness, graceful shutdown, Docker, CI                                       |
| Request pipeline | request id → rate limit → authentication → tenant context → permission → entitlement → validation → handler; stable error codes; OpenAPI generated from route definitions               |
| Identity         | Login (lockout), rotating refresh tokens (absolute 30-day and 7-day idle limits, theft detection), logout, sessions, change/forgot/reset password, invitations, switching school        |
| Schools          | Create, profile, settings (optimistic concurrency), lifecycle with history (approve → provision → active ⇄ suspended → archived → restore), public school request + review              |
| Provisioning     | One transaction: settings → subscription → plan entitlements → first admin invitation → ACTIVE. Failure leaves the school APPROVED and retryable                                        |
| RBAC             | 85 permissions, 14 system roles (6 platform, 8 school), custom roles, scoped assignments (incl. platform support limited to selected schools), anti-escalation, last-admin protection   |
| Entitlements     | 21 features with a dependency graph, 3 versioned plans, subscriptions (trial / active / superseded / cancelled), overrides, recovery window, confirmation before switching anything off |
| Shared services  | Append-only audit log (school + platform), transactional outbox, BullMQ worker, idempotent event handlers, tenant-namespaced Redis cache                                                |
| Admin panel      | Sign-in with school choice and auto-refresh, Schools, Platform users, School profile, Users & roles, Audit log, My account, invitation and reset-password pages                         |

## How to check it yourself (≈10 minutes)

1. In `api/`: `docker compose up --build`.
2. In `admin-panel-repo/`: `flutter pub get && flutter analyze && flutter run -d chrome --web-port 8080`.
3. Sign in as `superadmin@example.com` / `ChangeMe!12345` → **Schools** → **Create school** → **Provision**.
4. Copy the invitation link from `docker compose logs worker` into the browser, set a password, sign in as the school admin.
5. Things worth trying:
   - Create a custom **Sub Admin** role with only "View users", invite someone with it: they see Users but cannot invite.
   - As Super Admin, **Suspend** the school: the school admin now sees "school suspended"; support access becomes read-only.
   - On the school page, turn **Students** off: the app asks for confirmation and lists attendance, fees, exams… that depend on it.
   - Change the plan from Premium to Starter: the app lists the features that would be lost before applying it.
6. The API contract: `docs/api/openapi.json` (61 operations) — import into Postman or Swagger Editor.

## Security and design reviews

- A security review found 8 issues (concurrent admin demotion, role edits removing the last admin, re-invite overriding roles,
  scope widening, suspend without anti-escalation, cross-school role permission leak, email links in production logs,
  invite revealing account details). All fixed, each with a regression test (`tests/integration/escalation-regressions.test.ts`).
- A design-alignment audit against the Notes found undocumented differences and gaps. Fixed: read-only support access to inactive
  schools, archive restore, session absolute/idle limits, confirmation on grant removal and downgrades, SUPERSEDED vs CANCELLED,
  subscription currency, support access limited to selected schools, `/tenants/current` routes, `sort`, request id on malformed
  bodies, Sales/Operations admin roles (`tests/integration/notes-alignment.test.ts`). Remaining choices and deferrals are recorded in
  [`architecture/decisions.md`](architecture/decisions.md).

## Decisions to confirm

1. **Drizzle instead of Prisma (D4)** — Prisma cannot download its engines in this environment.
2. **Permission naming `students.read` (D8).**
3. **V1 scope excludes HR, Inventory and Calendar (D24).**
4. **Plan contents and prices** in `src/catalog/plans.ts` are placeholders.
5. **Default locale India / INR (D25)**; per school it is configurable.

## Not in Phase 1 (by design)

MFA, file storage, real email/SMS providers, platform invoices/payments, Redis-backed rate limiting, scheduled jobs.
See "Deferred" in the decisions file.

## Next — Phase 2: academic & student core

Port Students, Parents, Classes & Sections and Teachers & Staff from `legacy/` onto the platform core (academic years,
terms, classes, sections, subjects, students, guardians, enrollment, teachers), then switch their admin-panel screens from
"upgrading" back on.
