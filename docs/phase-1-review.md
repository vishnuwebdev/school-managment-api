# Phase 1 review — platform core

**Status:** complete, 64 automated tests passing against real MySQL 8 + Redis.
**Milestone proven:** Platform Admin → create school → provision → invite School
Admin → admin accepts → signs in → school context with permissions and features
(`tests/integration/provisioning.test.ts`).

## What was built

| Area             | Delivered                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation       | Monorepo, TypeScript, ESLint, Prettier, env validation, structured logs with secret redaction, request ids, health/readiness, graceful shutdown, Docker, CI pipeline      |
| Request pipeline | request id → rate limit → authentication → tenant context → permission → entitlement → validation → handler; stable error codes; OpenAPI generated from route definitions |
| Identity         | Login (lockout after 5 failures), rotating refresh tokens with theft detection, logout, session list/revoke, change/forgot/reset password, invitations, context switching |
| Schools          | Create, profile, settings (optimistic concurrency), lifecycle (approve → provision → active ⇄ suspended → archived) with history, public school request + review          |
| Provisioning     | One transaction: settings → subscription → plan entitlements → first admin invitation → ACTIVE. Failure leaves the school APPROVED and retryable                          |
| RBAC             | 85 permissions, 12 system roles (4 platform, 8 school), custom roles, role assignments with scope, anti-escalation, last-admin protection                                 |
| Entitlements     | 21 features with a dependency graph, 3 plans (versioned), subscriptions, overrides (grant/deny, with impact confirmation), grace period and lock-out                      |
| Shared services  | Append-only audit log (school + platform views), transactional outbox, BullMQ worker, idempotent event handlers, tenant-namespaced Redis cache                            |

## How to check it yourself (≈10 minutes)

1. `docker compose up --build` in `school-management/`.
2. Follow **“Try the first workflow”** in the README.
3. Open `docs/api/openapi.json` in Swagger Editor (or <http://localhost:4000/openapi.json>) to browse all 59 endpoints.
4. Things worth trying:
   - As the school admin, create a custom **“Sub Admin”** role with only `members.read`, invite someone with it, and confirm they can list users but get `PERMISSION_DENIED` when inviting.
   - Call `GET /api/v1/members` with the school admin token and `X-Tenant-Id` of another school → `TENANT_ACCESS_DENIED`.
   - As Super Admin, `POST /platform/tenants/{id}/suspend` → the school admin now gets `SCHOOL_SUSPENDED`.
   - `PUT /platform/tenants/{id}/entitlements/overrides/students` with `{"effect":"DENY","reason":"test"}` → `CONFIRMATION_REQUIRED` listing attendance, fees, exams… that depend on it.

## Security review

An independent review of the finished code found 8 issues (concurrent admin
demotion, role edits removing the last admin, re-invite overriding roles,
scope widening, suspend without anti-escalation, cross-school role
permission leak, email links in production logs, invite revealing account
details) plus 4 minor ones. **All were fixed** and each has a regression test in
`tests/integration/escalation-regressions.test.ts`.

## Decisions to confirm

Full list in [`architecture/decisions.md`](architecture/decisions.md). The ones that need your eyes:

1. **Drizzle instead of Prisma (D4).** Prisma cannot download its engines in this environment.
2. **Permission naming `students.read` (D6)** — the newer backend note, not `student.view`.
3. **V1 scope excludes HR, Inventory and Calendar (D18)**, per the Master V1 spec. Say if you want them in V1.
4. **Plan contents and prices (D19)** in `apps/api/src/catalog/plans.ts` are placeholders.
5. **Default locale India / INR (D19).** Per school it is configurable; tell me if the platform default should be South Africa / ZAR instead.

## Not in Phase 1 (by design)

MFA, file storage, real email/SMS providers, platform invoices/payments, Redis-backed
rate limiting, scheduled jobs. See the “Deferred” list in the decisions file.

## Next

- **Phase 1b — Flutter admin shell on the new API:** point `admin-panel-repo` at `/api/v1`,
  replace its login/session code with the new tokens + `/auth/me` (permissions & features
  drive the sidebar), and build the Platform screens (schools, provisioning,
  entitlements) and School screens (users, roles, settings, audit).
- **Phase 2 — Academic & student core:** academic years, terms, classes, sections,
  subjects, students, guardians, enrollment, teachers (Milestone 2 in the kickoff note).

The previous `api/` folder is untouched and kept only as reference.
