/**
 * Read-only report for D55 (central scope policy). Lists ACTIVE school role
 * assignments that the policy treats differently from before:
 *   - an unsupported scope type (ASSIGNED_SUBJECT, SELECTED_RESOURCE, …),
 *   - a scope_ref that does not match its type or points at ids that are not
 *     sections / classes of that school,
 *   - permissions the user no longer effectively holds because they only work
 *     school-wide (e.g. members.*, roles.*, audit.read under ASSIGNED_SECTION).
 * Nothing is changed. Run before deploying:  npm run scopes:report [-- --json]
 */
import 'dotenv/config';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { loadEnv } from '../config/env.js';
import { createDatabase } from '../db/client.js';
import {
  academicClasses,
  academicSections,
  memberships,
  permissions,
  roleAssignments,
  rolePermissions,
  roles,
  tenants,
  users,
} from '../db/schema/index.js';
import {
  isWideScope,
  SCOPE_REF_KEY,
  TENANT_SCOPE_TYPES,
  unsupportedPermissions,
} from '../modules/access/scope-policy.js';

const env = loadEnv();
const { db, pool } = createDatabase(env.DATABASE_URL, { connectionLimit: 2 });

interface Finding {
  school: string;
  user: string;
  role: string;
  scope_type: string;
  problems: string[];
  permissions_lost: string[];
}

async function main() {
  const rows = await db
    .select({
      assignmentId: roleAssignments.id,
      tenantId: roleAssignments.tenantId,
      scopeType: roleAssignments.scopeType,
      scopeRef: roleAssignments.scopeRef,
      roleId: roles.id,
      roleName: roles.name,
      email: users.email,
      school: tenants.name,
    })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .innerJoin(memberships, eq(memberships.id, roleAssignments.membershipId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(tenants, eq(tenants.id, roleAssignments.tenantId))
    .where(and(eq(roleAssignments.status, 'ACTIVE'), isNotNull(roleAssignments.tenantId)));

  const narrow = rows.filter((r) => !isWideScope(r.scopeType));
  const roleIds = [...new Set(narrow.map((r) => r.roleId))];
  const perms = roleIds.length
    ? await db
        .select({ roleId: rolePermissions.roleId, code: permissions.code })
        .from(rolePermissions)
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(inArray(rolePermissions.roleId, roleIds))
    : [];
  const ids = (key: string) => [...new Set(narrow.flatMap((r) => r.scopeRef?.[key] ?? []))];
  const sectionIds = ids('section_ids');
  const classIds = ids('class_ids');
  const known = new Map<string, string>(); // id -> tenant id
  if (sectionIds.length)
    (
      await db
        .select({ id: academicSections.id, t: academicSections.tenantId })
        .from(academicSections)
        .where(inArray(academicSections.id, sectionIds))
    ).forEach((r) => known.set(r.id, r.t));
  if (classIds.length)
    (
      await db
        .select({ id: academicClasses.id, t: academicClasses.tenantId })
        .from(academicClasses)
        .where(inArray(academicClasses.id, classIds))
    ).forEach((r) => known.set(r.id, r.t));

  const findings: Finding[] = [];
  for (const r of narrow) {
    const problems: string[] = [];
    if (!(TENANT_SCOPE_TYPES as readonly string[]).includes(r.scopeType))
      problems.push(`scope type ${r.scopeType} is not supported for school roles`);
    const key = SCOPE_REF_KEY[r.scopeType];
    if (r.scopeRef) {
      const keys = Object.keys(r.scopeRef);
      if (!key || keys.length !== 1 || keys[0] !== key)
        problems.push(`scope_ref keys [${keys.join(', ')}] do not match ${r.scopeType}`);
      for (const [k, list] of Object.entries(r.scopeRef)) {
        const bad = list.filter((id) => known.get(id) !== r.tenantId);
        if (bad.length)
          problems.push(`${k}: ${bad.length} id(s) not in this school (${bad.join(', ')})`);
      }
    }
    const lost = unsupportedPermissions(
      perms.filter((p) => p.roleId === r.roleId).map((p) => p.code),
      r.scopeType,
    );
    if (problems.length || lost.length)
      findings.push({
        school: r.school,
        user: r.email,
        role: r.roleName,
        scope_type: r.scopeType,
        problems,
        permissions_lost: lost,
      });
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ assignments_checked: narrow.length, findings }, null, 2));
  } else {
    console.log(`Scope report (D55): ${narrow.length} limited school assignments checked.`);
    if (findings.length === 0) console.log('No assignments are affected.');
    for (const f of findings) {
      console.log(`\n${f.school} · ${f.user} · ${f.role} (${f.scope_type})`);
      for (const p of f.problems) console.log(`  - ${p}`);
      if (f.permissions_lost.length)
        console.log(`  - no longer effective (school-wide only): ${f.permissions_lost.join(', ')}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
