import { and, eq, inArray, sql } from 'drizzle-orm';
import { academicSections } from '../../db/schema/index.js';
import { hasTenantWideScope, scopesFor } from '../access/authorization.service.js';
function grants(principal, permission) {
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
export function placementScope(principal, permission, cols) {
    if (hasTenantWideScope(principal, permission))
        return undefined;
    const { sectionIds, classIds } = grants(principal, permission);
    const list = (col, ids) => sql `${col} in (${sql.join(ids.map((i) => sql `${i}`), sql `, `)})`;
    const parts = [];
    if (sectionIds.length)
        parts.push(list(cols.section, sectionIds));
    if (classIds.length)
        parts.push(list(cols.klass, classIds));
    if (parts.length === 0)
        return sql `1 = 0`;
    return sql `(${sql.join(parts, sql ` or `)})`;
}
/** The classes a scoped principal can reach (null = every class). */
export async function reachableClassIds(db, c, permission) {
    if (hasTenantWideScope(c.principal, permission))
        return null;
    const { sectionIds, classIds } = grants(c.principal, permission);
    const out = new Set(classIds);
    if (sectionIds.length) {
        const rows = await db
            .select({ classId: academicSections.classId })
            .from(academicSections)
            .where(and(eq(academicSections.tenantId, c.tenantId), inArray(academicSections.id, sectionIds)));
        for (const r of rows)
            out.add(r.classId);
    }
    return [...out];
}
