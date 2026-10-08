import { and, asc, count, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  feeCategories,
  feeComponents,
  feeSettings,
  feeStructures,
  studentFeeAssignments,
  type DueRule,
} from '../../db/schema/index.js';
import { recordChange } from '../../platform/record.js';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  isDuplicateKeyError,
} from '../../shared/errors.js';
import { offsetOf, orderFrom, pageOf } from '../../shared/pagination.js';
import type {
  ArchiveStructureBody,
  CategoryListQuery,
  CreateCategoryBody,
  CreateComponentBody,
  CreateStructureBody,
  DuplicateStructureBody,
  PublishStructureBody,
  StructureListQuery,
  UpdateCategoryBody,
  UpdateComponentBody,
  UpdateSettingsBody,
  UpdateStructureBody,
} from './fees.schemas.js';
import { fromMinor, toMinor } from './money.js';
import { validateDueRule } from './schedule.js';
import {
  addDaysIso,
  businessRule,
  ensureSettings,
  likeOf,
  loadCategory,
  loadStructure,
  presentCategory,
  presentComponent,
  presentStructure,
  readSettings,
  requireWide,
  schoolToday,
  settingsPresent,
  staleVersion,
  validationIssue,
  type Caller,
  type ComponentRow,
  type StructureRow,
} from './support.js';

const OPEN_YEAR = ['UPCOMING', 'ACTIVE'];
const stale = () => new ConflictError('CONFLICT', undefined, { reason: 'STALE_VERSION' });

/**
 * Fee configuration: categories, the late-fee settings and fee structures (versioned, with
 * components). A PUBLISHED structure is immutable; changing one means duplicating it as a new DRAFT
 * version and publishing that, which archives the version it replaces. Demands already issued never
 * follow a structure (they are snapshots), so none of this can rewrite financial history.
 *
 * Lock order (always): structure → (previously published structure). Component edits lock only their structure.
 */
export class FeeConfigService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  // ---- settings ---------------------------------------------------------------------------

  async getSettings(c: Caller) {
    await ensureSettings(this.db, c.tenantId);
    return settingsPresent(await readSettings(this.db, c.tenantId));
  }

  async updateSettings(c: Caller, input: z.infer<typeof UpdateSettingsBody>) {
    requireWide(c.principal, 'fees.settings.manage');
    await ensureSettings(this.db, c.tenantId);
    await this.db.transaction(async (tx) => {
      const before = await readSettings(tx, c.tenantId, 'update');
      if (before.version !== input.version) throw stale();
      const type = input.late_fee_type ?? before.lateFeeType;
      const value = input.late_fee_value ?? before.lateFeeValue;
      if (type === 'PERCENT' && toMinor(value) > 10_000n)
        throw validationIssue('late_fee_value', 'A percentage cannot be more than 100');
      const enabled = input.late_fee_enabled ?? before.lateFeeEnabled;
      if (enabled && toMinor(value) <= 0n)
        throw validationIssue(
          'late_fee_value',
          'Set a late fee value before switching late fees on',
        );
      await tx
        .update(feeSettings)
        .set({
          ...(input.late_fee_enabled !== undefined
            ? { lateFeeEnabled: input.late_fee_enabled }
            : {}),
          ...(input.late_fee_type !== undefined ? { lateFeeType: input.late_fee_type } : {}),
          ...(input.late_fee_value !== undefined ? { lateFeeValue: input.late_fee_value } : {}),
          ...(input.late_fee_grace_days !== undefined
            ? { lateFeeGraceDays: input.late_fee_grace_days }
            : {}),
          ...(input.late_fee_cap !== undefined ? { lateFeeCap: input.late_fee_cap } : {}),
          version: before.version + 1,
          updatedBy: c.actor.userId,
        })
        .where(eq(feeSettings.tenantId, c.tenantId));
      const after = await readSettings(tx, c.tenantId);
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_SETTINGS_UPDATED',
        entityType: 'fee_settings',
        entityId: c.tenantId,
        event: 'fee_settings.updated',
        before: settingsPresent(before),
        after: settingsPresent(after),
        payload: { changed: Object.keys(input).filter((k) => k !== 'version') },
      });
    });
    return settingsPresent(await readSettings(this.db, c.tenantId));
  }

  // ---- categories -----------------------------------------------------------------------------

  async listCategories(c: Caller, q: z.infer<typeof CategoryListQuery>) {
    const where = and(
      eq(feeCategories.tenantId, c.tenantId),
      q.status ? eq(feeCategories.status, q.status) : undefined,
      q.search
        ? or(like(feeCategories.name, likeOf(q.search)), like(feeCategories.code, likeOf(q.search)))
        : undefined,
    );
    const order = orderFrom(
      q,
      { code: feeCategories.code, name: feeCategories.name, created_at: feeCategories.createdAt },
      'code',
    );
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(feeCategories)
        .where(where)
        .orderBy(order)
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(feeCategories).where(where),
    ]);
    return pageOf(rows.map(presentCategory), total?.n ?? 0, q);
  }

  async getCategory(c: Caller, id: string) {
    return presentCategory(await loadCategory(this.db, c.tenantId, id));
  }

  async createCategory(c: Caller, input: z.infer<typeof CreateCategoryBody>) {
    let id!: string;
    await this.db.transaction(async (tx) => {
      id = uuidv7();
      try {
        await tx.insert(feeCategories).values({
          id,
          tenantId: c.tenantId,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          createdBy: c.actor.userId,
          updatedBy: c.actor.userId,
        });
      } catch (err) {
        if (isDuplicateKeyError(err))
          throw new ConflictError('DUPLICATE_RESOURCE', 'A fee category with this code exists', {
            reason: 'DUPLICATE_CODE',
          });
        throw err;
      }
      const row = presentCategory(await loadCategory(tx, c.tenantId, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_CATEGORY_CREATED',
        entityType: 'fee_category',
        entityId: id,
        event: 'fee_category.created',
        after: row,
      });
    });
    return this.getCategory(c, id);
  }

  async updateCategory(c: Caller, id: string, input: z.infer<typeof UpdateCategoryBody>) {
    await this.db.transaction(async (tx) => {
      const before = await loadCategory(tx, c.tenantId, id, 'update');
      if (before.version !== input.version) throw stale();
      await tx
        .update(feeCategories)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          version: before.version + 1,
          updatedBy: c.actor.userId,
        })
        .where(eq(feeCategories.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_CATEGORY_UPDATED',
        entityType: 'fee_category',
        entityId: id,
        event: 'fee_category.updated',
        before: presentCategory(before),
        after: presentCategory(await loadCategory(tx, c.tenantId, id)),
      });
    });
    return this.getCategory(c, id);
  }

  async setCategoryState(c: Caller, id: string, to: 'ACTIVE' | 'INACTIVE') {
    await this.db.transaction(async (tx) => {
      const before = await loadCategory(tx, c.tenantId, id, 'update');
      if (before.status === to) return;
      await tx
        .update(feeCategories)
        .set({ status: to, version: before.version + 1, updatedBy: c.actor.userId })
        .where(eq(feeCategories.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: to === 'ACTIVE' ? 'FEE_CATEGORY_ACTIVATED' : 'FEE_CATEGORY_DEACTIVATED',
        entityType: 'fee_category',
        entityId: id,
        event: `fee_category.${to === 'ACTIVE' ? 'activated' : 'deactivated'}`,
        before: { status: before.status },
        after: { status: to },
      });
    });
    return this.getCategory(c, id);
  }

  // ---- structures: reads -----------------------------------------------------------------------------

  private async decorate(ex: Executor, tenantId: string, rows: StructureRow[]) {
    if (!rows.length) return [];
    const yearIds = [...new Set(rows.map((r) => r.academicYearId))];
    const classIds = [
      ...new Set(rows.flatMap((r) => (r.academicClassId ? [r.academicClassId] : []))),
    ];
    const ids = rows.map((r) => r.id);
    const [years, classes, comps, assigns] = await Promise.all([
      ex
        .select()
        .from(academicYears)
        .where(and(eq(academicYears.tenantId, tenantId), inArray(academicYears.id, yearIds))),
      classIds.length
        ? ex
            .select()
            .from(academicClasses)
            .where(
              and(eq(academicClasses.tenantId, tenantId), inArray(academicClasses.id, classIds)),
            )
        : Promise.resolve([]),
      ex
        .select({
          id: feeComponents.feeStructureId,
          n: sql<number>`count(*)`,
          total: sql<string>`coalesce(sum(${feeComponents.amount}), 0)`,
        })
        .from(feeComponents)
        .where(
          and(eq(feeComponents.tenantId, tenantId), inArray(feeComponents.feeStructureId, ids)),
        )
        .groupBy(feeComponents.feeStructureId),
      ex
        .select({ id: studentFeeAssignments.feeStructureId, n: sql<number>`count(*)` })
        .from(studentFeeAssignments)
        .where(
          and(
            eq(studentFeeAssignments.tenantId, tenantId),
            inArray(studentFeeAssignments.feeStructureId, ids),
          ),
        )
        .groupBy(studentFeeAssignments.feeStructureId),
    ]);
    const y = new Map(years.map((r) => [r.id, r]));
    const k = new Map(classes.map((r) => [r.id, r]));
    const cm = new Map(comps.map((r) => [r.id, r]));
    const am = new Map(assigns.map((r) => [r.id, Number(r.n)]));
    return rows.map((r) =>
      presentStructure(r, {
        year: y.get(r.academicYearId)
          ? {
              id: r.academicYearId,
              code: y.get(r.academicYearId)!.code,
              name: y.get(r.academicYearId)!.name,
            }
          : undefined,
        klass:
          r.academicClassId && k.get(r.academicClassId)
            ? {
                id: r.academicClassId,
                code: k.get(r.academicClassId)!.code,
                name: k.get(r.academicClassId)!.name,
              }
            : null,
        componentCount: Number(cm.get(r.id)?.n ?? 0),
        totalAmount: fromMinor(toMinor(String(cm.get(r.id)?.total ?? '0'))),
        assignmentCount: am.get(r.id) ?? 0,
      }),
    );
  }

  async listStructures(c: Caller, q: z.infer<typeof StructureListQuery>) {
    const where = and(
      eq(feeStructures.tenantId, c.tenantId),
      q.academic_year_id ? eq(feeStructures.academicYearId, q.academic_year_id) : undefined,
      q.academic_class_id ? eq(feeStructures.academicClassId, q.academic_class_id) : undefined,
      q.status ? eq(feeStructures.status, q.status) : undefined,
      q.code ? eq(feeStructures.code, q.code) : undefined,
      q.search
        ? or(like(feeStructures.name, likeOf(q.search)), like(feeStructures.code, likeOf(q.search)))
        : undefined,
    );
    const order = orderFrom(
      q,
      { code: feeStructures.code, name: feeStructures.name, created_at: feeStructures.createdAt },
      'created_at',
    );
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(feeStructures)
        .where(where)
        .orderBy(order, desc(feeStructures.versionNo))
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db.select({ n: count() }).from(feeStructures).where(where),
    ]);
    return pageOf(await this.decorate(this.db, c.tenantId, rows), total?.n ?? 0, q);
  }

  async listComponents(ex: Executor, tenantId: string, structureId: string) {
    const rows = await ex
      .select({ comp: feeComponents, cat: feeCategories })
      .from(feeComponents)
      .innerJoin(
        feeCategories,
        and(
          eq(feeCategories.tenantId, feeComponents.tenantId),
          eq(feeCategories.id, feeComponents.feeCategoryId),
        ),
      )
      .where(
        and(eq(feeComponents.tenantId, tenantId), eq(feeComponents.feeStructureId, structureId)),
      )
      .orderBy(asc(feeComponents.displayOrder), asc(feeComponents.name), asc(feeComponents.id));
    return rows.map((r) => presentComponent(r.comp, { code: r.cat.code, name: r.cat.name }));
  }

  async getStructure(c: Caller, id: string, ex: Executor = this.db) {
    const row = await loadStructure(ex, c.tenantId, id);
    const [view] = await this.decorate(ex, c.tenantId, [row]);
    return { ...view!, components: await this.listComponents(ex, c.tenantId, id) };
  }

  // ---- structures: draft editing -------------------------------------------------------------------------------

  private assertDraft(s: StructureRow) {
    if (s.status !== 'DRAFT')
      throw businessRule(
        'STRUCTURE_NOT_DRAFT',
        'Only a draft fee structure can be edited. Duplicate it as a new version to change a published one.',
        { structure_status: s.status },
      );
  }

  private async assertYearAndClass(
    tx: Executor,
    tenantId: string,
    yearId: string,
    classId: string | null | undefined,
  ) {
    const [year] = await tx
      .select()
      .from(academicYears)
      .where(and(eq(academicYears.id, yearId), eq(academicYears.tenantId, tenantId)));
    if (!year) throw new NotFoundError('Academic year');
    if (!OPEN_YEAR.includes(year.status))
      throw new BusinessRuleError(
        'OPERATION_NOT_ALLOWED',
        'Fee structures can only be created for an upcoming or active academic year',
        { reason: 'YEAR_NOT_OPEN', academic_year_status: year.status },
      );
    if (classId) {
      const [klass] = await tx
        .select({ id: academicClasses.id })
        .from(academicClasses)
        .where(and(eq(academicClasses.id, classId), eq(academicClasses.tenantId, tenantId)));
      if (!klass) throw new NotFoundError('Class');
    }
    return year;
  }

  private assertDatesInYear(
    year: { startDate: string; endDate: string },
    from?: string | null,
    to?: string | null,
  ) {
    if (from && (from < year.startDate || from > year.endDate))
      throw validationIssue('effective_from', 'The date must fall inside the academic year');
    if (to && (to < year.startDate || to > year.endDate))
      throw validationIssue('effective_to', 'The date must fall inside the academic year');
  }

  async createStructure(c: Caller, input: z.infer<typeof CreateStructureBody>) {
    await ensureSettings(this.db, c.tenantId);
    let id!: string;
    await this.db.transaction(async (tx) => {
      const year = await this.assertYearAndClass(
        tx,
        c.tenantId,
        input.academic_year_id,
        input.academic_class_id,
      );
      if (input.academic_section_id) {
        const [sec] = await tx
          .select({ id: academicSections.id })
          .from(academicSections)
          .where(
            and(
              eq(academicSections.id, input.academic_section_id),
              eq(academicSections.tenantId, c.tenantId),
              eq(academicSections.academicYearId, year.id),
              eq(academicSections.classId, input.academic_class_id!),
            ),
          );
        if (!sec) throw new NotFoundError('Section');
      }
      this.assertDatesInYear(year, input.effective_from, input.effective_to);
      const settings = await readSettings(tx, c.tenantId, 'share');
      id = uuidv7();
      try {
        await tx.insert(feeStructures).values({
          id,
          tenantId: c.tenantId,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          versionNo: 1,
          academicYearId: year.id,
          academicClassId: input.academic_class_id ?? null,
          academicSectionId: input.academic_section_id ?? null,
          currency: settings.currency,
          status: 'DRAFT',
          effectiveFrom: input.effective_from ?? null,
          effectiveTo: input.effective_to ?? null,
          createdBy: c.actor.userId,
          updatedBy: c.actor.userId,
        });
      } catch (err) {
        if (isDuplicateKeyError(err))
          throw new ConflictError(
            'DUPLICATE_RESOURCE',
            'A fee structure with this code exists. Duplicate it to create a new version.',
            { reason: 'DUPLICATE_CODE' },
          );
        throw err;
      }
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_STRUCTURE_CREATED',
        entityType: 'fee_structure',
        entityId: id,
        event: 'fee_structure.created',
        after: presentStructure(await loadStructure(tx, c.tenantId, id)),
        payload: { academic_year_id: year.id, code: input.code, version_no: 1 },
      });
    });
    return this.getStructure(c, id);
  }

  async updateStructure(c: Caller, id: string, input: z.infer<typeof UpdateStructureBody>) {
    await this.db.transaction(async (tx) => {
      const before = await loadStructure(tx, c.tenantId, id, 'update');
      this.assertDraft(before);
      if (before.version !== input.version) throw stale();
      const [year] = await tx
        .select()
        .from(academicYears)
        .where(eq(academicYears.id, before.academicYearId));
      const from = input.effective_from === undefined ? before.effectiveFrom : input.effective_from;
      const to = input.effective_to === undefined ? before.effectiveTo : input.effective_to;
      if (from && to && from > to)
        throw validationIssue('effective_to', 'effective_to cannot be before effective_from');
      this.assertDatesInYear(year!, from, to);
      if (input.academic_class_id) {
        const [klass] = await tx
          .select({ id: academicClasses.id })
          .from(academicClasses)
          .where(
            and(
              eq(academicClasses.id, input.academic_class_id),
              eq(academicClasses.tenantId, c.tenantId),
            ),
          );
        if (!klass) throw new NotFoundError('Class');
      }
      await tx
        .update(feeStructures)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.academic_class_id !== undefined
            ? { academicClassId: input.academic_class_id }
            : {}),
          effectiveFrom: from,
          effectiveTo: to,
          version: before.version + 1,
          updatedBy: c.actor.userId,
        })
        .where(eq(feeStructures.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_STRUCTURE_UPDATED',
        entityType: 'fee_structure',
        entityId: id,
        event: 'fee_structure.updated',
        before: presentStructure(before),
        after: presentStructure(await loadStructure(tx, c.tenantId, id)),
        payload: { changed: Object.keys(input).filter((k) => k !== 'version') },
      });
    });
    return this.getStructure(c, id);
  }

  // ---- components -----------------------------------------------------------------------------------------

  private resolveRule(frequency: ComponentRow['frequency'], rule: DueRule | undefined): DueRule {
    const effective: DueRule | undefined =
      rule ?? (frequency === 'CUSTOM' ? undefined : { type: 'DAYS_AFTER_PERIOD_START', days: 0 });
    if (!effective)
      throw validationIssue('due_rule', 'CUSTOM fees need a due_rule of type CUSTOM_DATES');
    const problem = validateDueRule(frequency, effective);
    if (problem) throw validationIssue('due_rule', problem);
    return effective;
  }

  private async assertCategoryUsable(tx: Executor, tenantId: string, categoryId: string) {
    const cat = await loadCategory(tx, tenantId, categoryId, 'share');
    if (cat.status !== 'ACTIVE')
      throw businessRule('CATEGORY_INACTIVE', 'The fee category is inactive', {
        fee_category_id: categoryId,
      });
    return cat;
  }

  async createComponent(
    c: Caller,
    structureId: string,
    input: z.infer<typeof CreateComponentBody>,
  ) {
    let id!: string;
    await this.db.transaction(async (tx) => {
      const structure = await loadStructure(tx, c.tenantId, structureId, 'update');
      this.assertDraft(structure);
      const cat = await this.assertCategoryUsable(tx, c.tenantId, input.fee_category_id);
      const rule = this.resolveRule(input.frequency, input.due_rule);
      id = uuidv7();
      await tx.insert(feeComponents).values({
        id,
        tenantId: c.tenantId,
        feeStructureId: structureId,
        feeCategoryId: input.fee_category_id,
        name: input.name,
        amount: input.amount,
        frequency: input.frequency,
        dueRule: rule,
        displayOrder: input.display_order,
        createdBy: c.actor.userId,
        updatedBy: c.actor.userId,
      });
      await tx
        .update(feeStructures)
        .set({ version: structure.version + 1, updatedBy: c.actor.userId })
        .where(eq(feeStructures.id, structureId));
      const [row] = await tx.select().from(feeComponents).where(eq(feeComponents.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_COMPONENT_ADDED',
        entityType: 'fee_structure',
        entityId: structureId,
        event: 'fee_structure.component_added',
        after: presentComponent(row!, cat),
        payload: { component_id: id },
      });
    });
    return (await this.listComponents(this.db, c.tenantId, structureId)).find((x) => x.id === id)!;
  }

  private async loadComponentOfDraft(
    tx: Executor,
    c: Caller,
    componentId: string,
  ): Promise<{ component: ComponentRow; structure: StructureRow }> {
    const [comp] = await tx
      .select()
      .from(feeComponents)
      .where(and(eq(feeComponents.id, componentId), eq(feeComponents.tenantId, c.tenantId)));
    if (!comp) throw new NotFoundError('Fee component');
    const structure = await loadStructure(tx, c.tenantId, comp.feeStructureId, 'update');
    this.assertDraft(structure);
    // Re-read under the structure lock (the row could have been removed while we waited).
    const [fresh] = await tx
      .select()
      .from(feeComponents)
      .where(and(eq(feeComponents.id, componentId), eq(feeComponents.tenantId, c.tenantId)))
      .for('update');
    if (!fresh) throw new NotFoundError('Fee component');
    return { component: fresh, structure };
  }

  async getComponent(c: Caller, id: string) {
    const [comp] = await this.db
      .select()
      .from(feeComponents)
      .where(and(eq(feeComponents.id, id), eq(feeComponents.tenantId, c.tenantId)));
    if (!comp) throw new NotFoundError('Fee component');
    return (await this.listComponents(this.db, c.tenantId, comp.feeStructureId)).find(
      (x) => x.id === id,
    )!;
  }

  async updateComponent(c: Caller, id: string, input: z.infer<typeof UpdateComponentBody>) {
    let structureId!: string;
    await this.db.transaction(async (tx) => {
      const { component: before, structure } = await this.loadComponentOfDraft(tx, c, id);
      structureId = structure.id;
      if (before.version !== input.version) throw stale();
      const cat = input.fee_category_id
        ? await this.assertCategoryUsable(tx, c.tenantId, input.fee_category_id)
        : null;
      const frequency = input.frequency ?? before.frequency;
      const rule = this.resolveRule(
        frequency,
        input.due_rule ??
          (input.frequency && input.frequency !== before.frequency ? undefined : before.dueRule),
      );
      await tx
        .update(feeComponents)
        .set({
          ...(input.fee_category_id !== undefined ? { feeCategoryId: input.fee_category_id } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.display_order !== undefined ? { displayOrder: input.display_order } : {}),
          frequency,
          dueRule: rule,
          version: before.version + 1,
          updatedBy: c.actor.userId,
        })
        .where(eq(feeComponents.id, id));
      await tx
        .update(feeStructures)
        .set({ version: structure.version + 1, updatedBy: c.actor.userId })
        .where(eq(feeStructures.id, structure.id));
      const [after] = await tx.select().from(feeComponents).where(eq(feeComponents.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_COMPONENT_UPDATED',
        entityType: 'fee_structure',
        entityId: structure.id,
        event: 'fee_structure.component_updated',
        before: presentComponent(before),
        after: presentComponent(after!, cat ?? undefined),
        payload: { component_id: id, changed: Object.keys(input).filter((k) => k !== 'version') },
      });
    });
    return (await this.listComponents(this.db, c.tenantId, structureId)).find((x) => x.id === id)!;
  }

  async deleteComponent(c: Caller, id: string, version: number | undefined) {
    await this.db.transaction(async (tx) => {
      const { component, structure } = await this.loadComponentOfDraft(tx, c, id);
      if (staleVersion(component.version, version)) throw stale();
      await tx.delete(feeComponents).where(eq(feeComponents.id, id));
      await tx
        .update(feeStructures)
        .set({ version: structure.version + 1, updatedBy: c.actor.userId })
        .where(eq(feeStructures.id, structure.id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_COMPONENT_REMOVED',
        entityType: 'fee_structure',
        entityId: structure.id,
        event: 'fee_structure.component_removed',
        before: presentComponent(component),
        payload: { component_id: id },
      });
    });
  }

  // ---- publish / archive / duplicate ----------------------------------------------------------------------------

  /**
   * DRAFT → PUBLISHED: the structure becomes immutable and assignable. Needs at least one component
   * with a valid due rule and active category. The version published before for the same code, year
   * and class is archived in the same transaction (`superseded_by_id`).
   */
  async publish(c: Caller, id: string, input: z.infer<typeof PublishStructureBody>) {
    requireWide(c.principal, 'fees.structures.publish');
    await this.db.transaction(async (tx) => {
      const s = await loadStructure(tx, c.tenantId, id, 'update');
      this.assertDraft(s);
      if (staleVersion(s.version, input.version)) throw stale();
      const [year] = await tx
        .select()
        .from(academicYears)
        .where(eq(academicYears.id, s.academicYearId));
      if (!OPEN_YEAR.includes(year!.status))
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'Only a structure of an upcoming or active academic year can be published',
          { reason: 'YEAR_NOT_OPEN', academic_year_status: year!.status },
        );
      const comps = await tx
        .select({ comp: feeComponents, cat: feeCategories })
        .from(feeComponents)
        .innerJoin(
          feeCategories,
          and(
            eq(feeCategories.tenantId, feeComponents.tenantId),
            eq(feeCategories.id, feeComponents.feeCategoryId),
          ),
        )
        .where(and(eq(feeComponents.tenantId, c.tenantId), eq(feeComponents.feeStructureId, id)))
        .for('share');
      const blocking: { component_id: string | null; reason: string; message: string }[] = [];
      if (!comps.length)
        blocking.push({
          component_id: null,
          reason: 'NO_COMPONENTS',
          message: 'Add at least one fee component before publishing',
        });
      for (const { comp, cat } of comps) {
        if (cat.status !== 'ACTIVE')
          blocking.push({
            component_id: comp.id,
            reason: 'CATEGORY_INACTIVE',
            message: `Category ${cat.code} is inactive`,
          });
        const problem = validateDueRule(comp.frequency, comp.dueRule);
        if (problem)
          blocking.push({ component_id: comp.id, reason: 'INVALID_DUE_RULE', message: problem });
      }
      if (blocking.length)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          `The structure cannot be published: ${blocking.length} blocking issue(s)`,
          { reason: 'PUBLISH_BLOCKED', blocking },
        );
      const today = await schoolToday(tx, c.tenantId, this.deps.clock);
      const from =
        input.effective_from ??
        s.effectiveFrom ??
        (today > year!.startDate ? today : year!.startDate);
      if (s.effectiveTo && from > s.effectiveTo)
        throw new BusinessRuleError(
          'OPERATION_NOT_ALLOWED',
          'The effective date is after the end date of this structure',
          { reason: 'EFFECTIVE_DATES_INVALID' },
        );
      this.assertDatesInYear(year!, from, s.effectiveTo);
      const now = this.deps.clock.now();
      const prevQ = tx
        .select()
        .from(feeStructures)
        .where(
          and(
            eq(feeStructures.tenantId, c.tenantId),
            eq(feeStructures.academicYearId, s.academicYearId),
            eq(feeStructures.code, s.code),
            eq(feeStructures.status, 'PUBLISHED'),
            s.academicClassId
              ? eq(feeStructures.academicClassId, s.academicClassId)
              : sql`${feeStructures.academicClassId} is null`,
          ),
        )
        .for('update');
      const [prev] = await prevQ;
      if (prev) {
        const endsOn = addDaysIso(from, -1);
        const trim =
          prev.effectiveFrom !== null &&
          endsOn >= prev.effectiveFrom &&
          (prev.effectiveTo === null || prev.effectiveTo > endsOn);
        await tx
          .update(feeStructures)
          .set({
            status: 'ARCHIVED',
            archivedAt: now,
            archivedBy: c.actor.userId,
            supersededById: s.id,
            ...(trim ? { effectiveTo: endsOn } : {}),
            version: prev.version + 1,
            updatedBy: c.actor.userId,
          })
          .where(eq(feeStructures.id, prev.id));
        await recordChange(tx, c.actor, c.tenantId, {
          action: 'FEE_STRUCTURE_SUPERSEDED',
          entityType: 'fee_structure',
          entityId: prev.id,
          event: 'fee_structure.superseded',
          before: { status: 'PUBLISHED' },
          after: { status: 'ARCHIVED', superseded_by_id: s.id },
          payload: { code: prev.code, version_no: prev.versionNo, superseded_by_id: s.id },
        });
      }
      await tx
        .update(feeStructures)
        .set({
          status: 'PUBLISHED',
          effectiveFrom: from,
          publishedAt: now,
          publishedBy: c.actor.userId,
          version: s.version + 1,
          updatedBy: c.actor.userId,
        })
        .where(eq(feeStructures.id, id));
      const total = comps.reduce((a, r) => a + toMinor(r.comp.amount), 0n);
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_STRUCTURE_PUBLISHED',
        entityType: 'fee_structure',
        entityId: id,
        event: 'fee_structure.published',
        before: { status: 'DRAFT' },
        after: { status: 'PUBLISHED', effective_from: from, components: comps.length },
        payload: {
          code: s.code,
          version_no: s.versionNo,
          academic_year_id: s.academicYearId,
          academic_class_id: s.academicClassId,
          components: comps.length,
          per_period_total: fromMinor(total),
          superseded_id: prev?.id ?? null,
        },
      });
    });
    return this.getStructure(c, id);
  }

  /** DRAFT or PUBLISHED → ARCHIVED. No new assignments; existing assignments and demands are untouched. */
  async archive(c: Caller, id: string, input: z.infer<typeof ArchiveStructureBody>) {
    requireWide(c.principal, 'fees.structures.publish');
    await this.db.transaction(async (tx) => {
      const s = await loadStructure(tx, c.tenantId, id, 'update');
      if (s.status === 'ARCHIVED')
        throw businessRule('ALREADY_ARCHIVED', 'The fee structure is already archived');
      if (staleVersion(s.version, input.version)) throw stale();
      const today = await schoolToday(tx, c.tenantId, this.deps.clock);
      const yesterday = addDaysIso(today, -1);
      const endsOn =
        s.status === 'PUBLISHED' && (s.effectiveTo === null || s.effectiveTo > yesterday)
          ? s.effectiveFrom && yesterday < s.effectiveFrom
            ? s.effectiveTo
            : yesterday
          : s.effectiveTo;
      await tx
        .update(feeStructures)
        .set({
          status: 'ARCHIVED',
          archivedAt: this.deps.clock.now(),
          archivedBy: c.actor.userId,
          effectiveTo: endsOn,
          version: s.version + 1,
          updatedBy: c.actor.userId,
        })
        .where(eq(feeStructures.id, id));
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_STRUCTURE_ARCHIVED',
        entityType: 'fee_structure',
        entityId: id,
        event: 'fee_structure.archived',
        before: { status: s.status },
        after: { status: 'ARCHIVED' },
        reason: input.reason ?? null,
        payload: { code: s.code, version_no: s.versionNo, from_status: s.status },
      });
    });
    return this.getStructure(c, id);
  }

  /** A new DRAFT version (same code, next version_no) with a copy of the components. */
  async duplicate(c: Caller, sourceId: string, input: z.infer<typeof DuplicateStructureBody>) {
    let id!: string;
    await this.db.transaction(async (tx) => {
      const src = await loadStructure(tx, c.tenantId, sourceId, 'share');
      const [max] = await tx
        .select({ n: sql<number>`coalesce(max(${feeStructures.versionNo}), 0)` })
        .from(feeStructures)
        .where(and(eq(feeStructures.tenantId, c.tenantId), eq(feeStructures.code, src.code)))
        .for('update');
      const versionNo = Number(max?.n ?? 0) + 1;
      id = uuidv7();
      try {
        await tx.insert(feeStructures).values({
          id,
          tenantId: c.tenantId,
          code: src.code,
          name: input.name ?? src.name,
          description: src.description,
          versionNo,
          academicYearId: src.academicYearId,
          academicClassId: src.academicClassId,
          academicSectionId: src.academicSectionId,
          currency: src.currency,
          status: 'DRAFT',
          copiedFromId: src.id,
          createdBy: c.actor.userId,
          updatedBy: c.actor.userId,
        });
      } catch (err) {
        if (isDuplicateKeyError(err))
          throw new ConflictError(
            'CONFLICT',
            'Another version was created at the same time. Try again.',
            { reason: 'VERSION_RACE' },
          );
        throw err;
      }
      const comps = await tx
        .select()
        .from(feeComponents)
        .where(
          and(eq(feeComponents.tenantId, c.tenantId), eq(feeComponents.feeStructureId, src.id)),
        )
        .for('share');
      if (comps.length)
        await tx.insert(feeComponents).values(
          comps.map((k) => ({
            id: uuidv7(),
            tenantId: c.tenantId,
            feeStructureId: id,
            feeCategoryId: k.feeCategoryId,
            name: k.name,
            amount: k.amount,
            frequency: k.frequency,
            dueRule: k.dueRule,
            displayOrder: k.displayOrder,
            createdBy: c.actor.userId,
            updatedBy: c.actor.userId,
          })),
        );
      await recordChange(tx, c.actor, c.tenantId, {
        action: 'FEE_STRUCTURE_DUPLICATED',
        entityType: 'fee_structure',
        entityId: id,
        event: 'fee_structure.created',
        after: presentStructure(await loadStructure(tx, c.tenantId, id)),
        payload: {
          code: src.code,
          version_no: versionNo,
          copied_from_id: src.id,
          components: comps.length,
        },
      });
    });
    return this.getStructure(c, id);
  }
}
