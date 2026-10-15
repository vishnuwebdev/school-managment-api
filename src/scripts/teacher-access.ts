import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { closeDeps, createDeps } from '../bootstrap.js';
import { loadEnv } from '../config/env.js';
import { createApp } from '../app.js';
import { memberships, teachers, users } from '../db/schema/index.js';
import { processEvent, relayOutbox } from '../events/processor.js';
import { MemoryMailer } from '../infrastructure/mail/mailer.js';
import { buildServices } from '../services.js';

/**
 * Development only: give a teacher a working teacher-app sign-in without email.
 *
 *   npm run teacher:access -- teacher@school.com 'Demo#Pass2026'
 *
 * For every school where a teacher has this email it switches on the teacher
 * app add-on, gives the teacher a TEACHER login if they have none, and sets the
 * password (accepting the invitation, or through a password reset). Everything
 * goes through the real API in-process, like `db:seed:demo`.
 */
if (process.env.NODE_ENV === 'production') throw new Error('Development only');

const [emailArg, passwordArg] = process.argv.slice(2);
if (!emailArg) {
  console.error("Usage: npm run teacher:access -- <teacher email> ['<password>']");
  process.exit(1);
}
const EMAIL = emailArg.trim().toLowerCase();
const PASSWORD = passwordArg ?? 'Demo#Pass2026';
const SUPER_EMAIL = process.env.SEED_SUPER_ADMIN_EMAIL ?? 'superadmin@example.com';
const SUPER_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? 'ChangeMe!12345';

process.env.LOG_LEVEL = 'error';
const mailer = new MemoryMailer();
const deps = createDeps({ env: { ...loadEnv(), NODE_ENV: 'test' }, mailer });
const svc = buildServices(deps);
const http = request(createApp(deps, svc));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: 'get' | 'post' | 'put',
  path: string,
  opts: { token?: string; tenant?: string; body?: object } = {},
): Promise<{ status: number; body: Json }> {
  const req = http[method](`/api/v1${path}`);
  if (opts.token) req.set('Authorization', `Bearer ${opts.token}`);
  if (opts.tenant) req.set('X-Tenant-Id', opts.tenant);
  const res = await (method === 'get' ? req : req.send(opts.body ?? {}));
  return { status: res.status, body: res.body as Json };
}

async function ok(...args: Parameters<typeof call>) {
  const res = await call(...args);
  if (res.status >= 300)
    throw new Error(
      `${args[0].toUpperCase()} ${args[1]} → ${res.status} ${JSON.stringify(res.body)}`,
    );
  return res.body.data as Json;
}

async function drain() {
  for (let i = 0; i < 20; i++) {
    const n = await relayOutbox(deps, (event) => processEvent(deps, event.id));
    if (n === 0) return;
  }
}

const tokenFor = (template: string) =>
  [...mailer.sent].reverse().find((m) => m.to === EMAIL && m.template === template)?.data.token as
    string | undefined;

async function main() {
  const rows = await deps.db.select().from(teachers).where(eq(teachers.email, EMAIL));
  if (!rows.length)
    throw new Error(`No teacher with email ${EMAIL}. Add the teacher in the admin panel first.`);

  const root = (
    await ok('post', '/auth/login', { body: { email: SUPER_EMAIL, password: SUPER_PASSWORD } })
  ).access_token as string;

  for (const t of rows) {
    const tenant = t.tenantId;
    console.log(`\nSchool ${tenant} · teacher ${t.firstName} ${t.lastName} (${t.status})`);

    // 1. The teacher app add-on.
    const grant = await call(
      'put',
      `/platform/tenants/${tenant}/entitlements/overrides/teachers.mobile_app`,
      {
        token: root,
        body: { effect: 'GRANT', reason: 'Development: teacher app access' },
      },
    );
    console.log(
      grant.status < 300
        ? '  ✓ teacher app add-on on'
        : `  ! add-on: ${grant.status} ${JSON.stringify(grant.body)}`,
    );

    // 2. A TEACHER login.
    let membershipId = t.membershipId;
    if (!membershipId) {
      const roles = (await ok('get', '/roles', { token: root, tenant })) as unknown as Json[];
      const teacherRole = roles.find((r) => r.code === 'TEACHER')?.id as string;
      await ok('post', `/teachers/${t.id}/portal-access`, {
        token: root,
        tenant,
        body: { role_id: teacherRole, email: EMAIL },
      });
      const [linked] = await deps.db.select().from(teachers).where(eq(teachers.id, t.id));
      membershipId = linked!.membershipId;
      console.log('  ✓ login created (TEACHER role)');
    }
    if (!membershipId) throw new Error('The teacher has no login after portal access.');

    // 3. The password.
    const [m] = await deps.db
      .select({
        status: memberships.status,
        userStatus: users.status,
        hasPassword: users.passwordHash,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.id, membershipId), eq(memberships.tenantId, tenant)));
    if (m?.status === 'INVITED' || !m?.hasPassword) {
      await call('post', `/members/${membershipId}/invitations/resend`, { token: root, tenant });
      await drain();
      const token = tokenFor('invitation');
      if (!token) throw new Error('No invitation link captured (stop the worker and run again).');
      await ok('post', '/auth/invitations/accept', { body: { token, password: PASSWORD } });
      console.log('  ✓ invitation accepted, password set');
    } else {
      await ok('post', '/auth/forgot-password', { body: { email: EMAIL } });
      await drain();
      const token = tokenFor('password_reset');
      if (!token) throw new Error('No reset link captured (stop the worker and run again).');
      await ok('post', '/auth/reset-password', { body: { token, new_password: PASSWORD } });
      console.log('  ✓ password set');
    }
  }

  // 4. Prove it: sign in and open the teacher app profile.
  const login = await call('post', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  let token = login.body.data?.access_token as string | undefined;
  if (!token && login.body.error?.code === 'CONTEXT_SELECTION_REQUIRED') {
    const first = login.body.error.details.memberships.find((x: Json) => x.kind === 'TENANT');
    token = (
      await ok('post', '/auth/login', {
        body: { email: EMAIL, password: PASSWORD, membership_id: first.membership_id },
      })
    ).access_token as string;
  }
  if (!token) throw new Error(`Sign-in still fails: ${JSON.stringify(login.body)}`);
  const me = await call('get', '/teacher/me', { token });
  console.log(
    me.status === 200
      ? `\nReady. Sign in to the teacher app with:\n  ${EMAIL}\n  ${PASSWORD}`
      : `\nSigned in, but the teacher app refused: ${me.status} ${JSON.stringify(me.body.error)}`,
  );
}

main()
  .catch((e) => {
    console.error(`\n✗ ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  })
  .finally(() => closeDeps(deps));
