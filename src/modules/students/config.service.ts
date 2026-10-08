import { and, asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import { studentHouses, studentSettings } from '../../db/schema/index.js';
import type { Actor } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { ConflictError, isDuplicateKeyError, NotFoundError } from '../../shared/errors.js';
import type {
  CreateHouseBody,
  UpdateHouseBody,
  UpdateStudentSettingsBody,
} from './students.schemas.js';

type House = typeof studentHouses.$inferSelect;
const present = (h: House) => ({
  id: h.id,
  name: h.name,
  is_active: h.isActive,
  sort_order: h.sortOrder,
});

/** Houses and admission-number settings for a school. */
export class StudentConfigService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  async listHouses(tenantId: string, all = false) {
    const rows = await this.db
      .select()
      .from(studentHouses)
      .where(
        and(
          eq(studentHouses.tenantId, tenantId),
          all ? undefined : eq(studentHouses.isActive, true),
        ),
      )
      .orderBy(asc(studentHouses.sortOrder), asc(studentHouses.name));
    return rows.map(present);
  }

  async createHouse(tenantId: string, input: z.infer<typeof CreateHouseBody>, actor: Actor) {
    try {
      return await this.db.transaction(async (tx) => {
        const [ins] = await tx
          .insert(studentHouses)
          .values({ tenantId, name: input.name, sortOrder: input.sort_order })
          .$returningId();
        const [row] = await tx.select().from(studentHouses).where(eq(studentHouses.id, ins!.id));
        await recordChange(tx, actor, tenantId, {
          action: 'STUDENT_HOUSE_CREATED',
          entityType: 'student_house',
          entityId: row!.id,
          after: present(row!),
        });
        return present(row!);
      });
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw new ConflictError('DUPLICATE_RESOURCE', 'A house with this name exists', {
          field: 'name',
        });
      throw err;
    }
  }

  async updateHouse(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdateHouseBody>,
    actor: Actor,
  ) {
    try {
      return await this.db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(studentHouses)
          .where(and(eq(studentHouses.id, id), eq(studentHouses.tenantId, tenantId)))
          .for('update');
        if (!before) throw new NotFoundError('House');
        await tx
          .update(studentHouses)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.is_active !== undefined ? { isActive: input.is_active } : {}),
            ...(input.sort_order !== undefined ? { sortOrder: input.sort_order } : {}),
          })
          .where(eq(studentHouses.id, id));
        const [after] = await tx.select().from(studentHouses).where(eq(studentHouses.id, id));
        await recordChange(tx, actor, tenantId, {
          action: 'STUDENT_HOUSE_UPDATED',
          entityType: 'student_house',
          entityId: id,
          before: present(before),
          after: present(after!),
        });
        return present(after!);
      });
    } catch (err) {
      if (isDuplicateKeyError(err))
        throw new ConflictError('DUPLICATE_RESOURCE', 'A house with this name exists', {
          field: 'name',
        });
      throw err;
    }
  }

  async getSettings(tenantId: string) {
    const [s] = await this.db
      .select()
      .from(studentSettings)
      .where(eq(studentSettings.tenantId, tenantId));
    return { admission_number_mode: s?.admissionNumberMode ?? 'AUTO' };
  }

  async updateSettings(
    tenantId: string,
    input: z.infer<typeof UpdateStudentSettingsBody>,
    actor: Actor,
  ) {
    const before = await this.getSettings(tenantId);
    await this.db.transaction(async (tx) => {
      await tx
        .insert(studentSettings)
        .values({ tenantId, admissionNumberMode: input.admission_number_mode })
        .onDuplicateKeyUpdate({ set: { admissionNumberMode: input.admission_number_mode } });
      await recordChange(tx, actor, tenantId, {
        action: 'STUDENT_SETTINGS_UPDATED',
        entityType: 'student_settings',
        entityId: tenantId,
        before,
        after: { admission_number_mode: input.admission_number_mode },
      });
    });
    return { admission_number_mode: input.admission_number_mode };
  }
}
