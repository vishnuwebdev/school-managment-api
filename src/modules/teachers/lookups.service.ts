import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import { staffLookups, teachers, type StaffLookupKind } from '../../db/schema/index.js';
import type { Actor } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import {
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';

export const LookupParams = z.object({ id: z.uuid() });
export const LookupListQuery = z.object({
  kind: z.enum(['DEPARTMENT', 'DESIGNATION']).optional(),
  all: z.stringbool().optional(),
});
export const CreateLookupBody = z.object({
  kind: z.enum(['DEPARTMENT', 'DESIGNATION']),
  name: z.string().trim().min(1).max(100),
  sort_order: z.number().int().min(0).max(9999).default(0),
});
export const UpdateLookupBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
});

type Row = typeof staffLookups.$inferSelect;
const present = (r: Row) => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  is_active: r.isActive,
  sort_order: r.sortOrder,
});

/**
 * Managed department and designation lists. A school's first visit seeds each
 * list from the distinct values already typed on staff records, so existing
 * schools need no data migration. Staff keep the plain text value; the list
 * drives the pickers and rejects new values that are not on it.
 */
export class StaffLookupService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  private async ensureSeeded(tenantId: string, kind: StaffLookupKind) {
    const any = await this.db
      .select({ id: staffLookups.id })
      .from(staffLookups)
      .where(and(eq(staffLookups.tenantId, tenantId), eq(staffLookups.kind, kind)))
      .limit(1);
    if (any.length) return;
    const col = kind === 'DEPARTMENT' ? teachers.department : teachers.designation;
    const found = await this.db
      .selectDistinct({ name: col })
      .from(teachers)
      .where(and(eq(teachers.tenantId, tenantId), isNotNull(col)));
    const names = found.map((f) => f.name!.trim()).filter(Boolean);
    if (!names.length) return;
    await this.db
      .insert(staffLookups)
      .values([...new Set(names)].sort().map((name, i) => ({ tenantId, kind, name, sortOrder: i })))
      .onDuplicateKeyUpdate({ set: { name: sql`${staffLookups.name}` } });
  }

  async list(tenantId: string, q: z.infer<typeof LookupListQuery>) {
    const kinds: StaffLookupKind[] = q.kind ? [q.kind] : ['DEPARTMENT', 'DESIGNATION'];
    for (const k of kinds) await this.ensureSeeded(tenantId, k);
    const rows = await this.db
      .select()
      .from(staffLookups)
      .where(
        and(
          eq(staffLookups.tenantId, tenantId),
          q.kind ? eq(staffLookups.kind, q.kind) : undefined,
          q.all ? undefined : eq(staffLookups.isActive, true),
        ),
      )
      .orderBy(asc(staffLookups.kind), asc(staffLookups.sortOrder), asc(staffLookups.name));
    return rows.map(present);
  }

  async create(tenantId: string, input: z.infer<typeof CreateLookupBody>, actor: Actor) {
    await this.ensureSeeded(tenantId, input.kind);
    try {
      return await this.db.transaction(async (tx) => {
        const [ins] = await tx
          .insert(staffLookups)
          .values({
            tenantId,
            kind: input.kind,
            name: input.name,
            sortOrder: input.sort_order,
          })
          .$returningId();
        const [row] = await tx.select().from(staffLookups).where(eq(staffLookups.id, ins!.id));
        await recordChange(tx, actor, tenantId, {
          action: 'STAFF_LOOKUP_CREATED',
          entityType: 'staff_lookup',
          entityId: row!.id,
          after: present(row!),
        });
        return present(row!);
      });
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw new ConflictError('DUPLICATE_RESOURCE', 'This name is already on the list', {
          field: 'name',
        });
      throw err;
    }
  }

  async update(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateLookupBody>,
    actor: Actor,
  ) {
    try {
      return await this.db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(staffLookups)
          .where(and(eq(staffLookups.id, id), eq(staffLookups.tenantId, tenantId)))
          .for('update');
        if (!before) throw new NotFoundError('List entry');
        await tx
          .update(staffLookups)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.is_active !== undefined ? { isActive: input.is_active } : {}),
            ...(input.sort_order !== undefined ? { sortOrder: input.sort_order } : {}),
          })
          .where(eq(staffLookups.id, id));
        // Renaming carries the new name onto the staff who already have the old one.
        if (input.name !== undefined && input.name !== before.name) {
          const col = before.kind === 'DEPARTMENT' ? 'department' : 'designation';
          await tx
            .update(teachers)
            .set(
              before.kind === 'DEPARTMENT'
                ? { department: input.name }
                : { designation: input.name },
            )
            .where(and(eq(teachers.tenantId, tenantId), eq(teachers[col], before.name)));
        }
        const [after] = await tx.select().from(staffLookups).where(eq(staffLookups.id, id));
        await recordChange(tx, actor, tenantId, {
          action: 'STAFF_LOOKUP_UPDATED',
          entityType: 'staff_lookup',
          entityId: id,
          before: present(before),
          after: present(after!),
        });
        return present(after!);
      });
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw new ConflictError('DUPLICATE_RESOURCE', 'This name is already on the list', {
          field: 'name',
        });
      throw err;
    }
  }

  /**
   * Called when a staff record is created or edited with a new value. Only
   * enforced when the school has a list; an unchanged value is always allowed
   * so old records stay editable after a list entry is switched off.
   */
  async assertAllowed(
    ex: Executor,
    tenantId: string,
    kind: StaffLookupKind,
    value: string | null | undefined,
    current?: string | null,
  ) {
    if (!value || value === current) return;
    const rows = await ex
      .select({ name: staffLookups.name, isActive: staffLookups.isActive })
      .from(staffLookups)
      .where(and(eq(staffLookups.tenantId, tenantId), eq(staffLookups.kind, kind)));
    if (!rows.length) return;
    const hit = rows.find((r) => r.name.toLowerCase() === value.toLowerCase());
    if (!hit || !hit.isActive)
      throw new ValidationError(
        `${kind === 'DEPARTMENT' ? 'Department' : 'Designation'} "${value}" is not on the school's list`,
        [
          {
            field: kind === 'DEPARTMENT' ? 'department' : 'designation',
            message: 'Pick a value from the list, or add it under Staff settings',
          },
        ],
      );
  }
}
