import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { AnyMySqlColumn } from 'drizzle-orm/mysql-core';
import type { Executor } from '../../db/client.js';
import { academicSections } from '../../db/schema/index.js';
import type { Principal } from '../../platform/context.js';
import { hasTenantWideScope, scopesFor } from '../access/authorization.service.js';

/** Who is asking: the school and the signed-in principal (never client input). */
export interface Caller {
  tenantId: string;
  principal: Principal;
}

type Col = AnyMySqlColumn | SQL;

function grants(principal: Principal, permission: string) {
  const g = scopesFor(principal, permission);
  return {
    sectionIds: g.flatMap((x) => (x.type === 'ASSIGNED_SECTION' ? (x.ref?.section_ids ?? []) : [])),
    classIds: g.flatMap((x) => (x.type === 'ASSIGNED_CLASS' ? (x.ref?.class_ids ?? []) : [])),
  };
}

/**
 * Row-level scope for an examinations permission on a section / class column pair.
 * Tenant-wide grants return `undefined` (no narrowing); a grant we cannot resolve denies.
 */
export function placementScope(
  principal: Principal,
  permission: string,
  cols: { section: Col; klass: Col },
): SQL | undefined {
  if (hasTenantWideScope(principal, permission)) return undefined;
  const { sectionIds, classIds } = grants(principal, permission);
  const list = (col: Col, ids: string[]) =>
    sql`${col} in (${sql.join(
      ids.map((i) => sql`${i}`),
      sql`, `,
    )})`;
  const parts: SQL[] = [];
  if (sectionIds.length) parts.push(list(cols.section, sectionIds));
  if (classIds.length) parts.push(list(cols.klass, classIds));
  if (parts.length === 0) return sql`1 = 0`;
  return sql`(${sql.join(parts, sql` or `)})`;
}

/** The classes a scoped principal can reach (null = every class). */
export async function reachableClassIds(
  db: Executor,
  c: Caller,
  permission: string,
): Promise<string[] | null> {
  if (hasTenantWideScope(c.principal, permission)) return null;
  const { sectionIds, classIds } = grants(c.principal, permission);
  const out = new Set(classIds);
  if (sectionIds.length) {
    const rows = await db
      .select({ classId: academicSections.classId })
      .from(academicSections)
      .where(
        and(eq(academicSections.tenantId, c.tenantId), inArray(academicSections.id, sectionIds)),
      );
    for (const r of rows) out.add(r.classId);
  }
  return [...out];
}
