import { and, eq, inArray, like, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  subjectOfferings,
  teachingAssignments,
  timetableDayOverrides,
  timetablePeriods,
  timetableVenues,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import {
  BusinessRuleError,
  ConflictError,
  isDuplicateKeyError,
  NotFoundError,
} from '../../shared/errors.js';
import type { TimetableConfigService } from './config.service.js';
import {
  assertNoClash,
  cellOf,
  findClashes,
  lessonPresent,
  lessonProblems,
  lessonsOf,
  loadPeriods,
  periodBrief,
  specPresent,
  ownerPresent,
  clashPresent,
  type LoadedPeriod,
} from './lessons.js';
import type {
  CopyPeriodsBody,
  CopyYearBody,
  CreatePeriodBody,
  OwnerQuery,
  SetDayBody,
  StatusQuery,
  UpdatePeriodBody,
} from './timetable.schemas.js';
import {
  currentYearId,
  DAY_NAMES,
  daysOverlap,
  normalizeDays,
  runsOn,
  hhmm,
  hhmmss,
  loadYear,
  ownerFilter,
  readSettings,
  requireWide,
  resolveOwner,
  sectionInScope,
  validationIssue,
  type Owner,
  type PeriodRow,
} from './support.js';

const PERIOD_CODE_PREFIX: Record<string, string> = {
  LESSON: 'P',
  BREAK: 'BRK',
  LUNCH: 'LUNCH',
  ASSEMBLY: 'ASM',
  CUSTOM: 'CUS',
};

/** The lowest free `<PREFIX><n>` code for [kind] across all of the school's periods. */
async function nextPeriodCode(tx: Executor, tenantId: string, kind: string): Promise<string> {
  const prefix = PERIOD_CODE_PREFIX[kind] ?? 'PER';
  const rows = await tx
    .select({ code: timetablePeriods.code })
    .from(timetablePeriods)
    .where(and(eq(timetablePeriods.tenantId, tenantId), like(timetablePeriods.code, `${prefix}%`)));
  const taken = new Set(rows.map((r) => r.code.toUpperCase()));
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** A resolved lesson: the offering, the teacher's assignment, and the venue (all checked). */
interface Resolved {
  offeringId: string;
  assignmentId: string;
  teacherId: string;
  venueId: string | null;
}

const reject = (reason: string, message: string, details: Record<string, unknown> = {}) =>
  new BusinessRuleError('OPERATION_NOT_ALLOWED', message, { reason, ...details });

/**
 * The live timetable: every section's (or class's) periods with their subject
 * and teacher, weekday exceptions, copying, and the per-section status. Every
 * write takes the school's settings row lock, then refuses overlapping periods
 * of the same day and teacher / venue clashes across the year.
 */
export class PeriodService {
  constructor(
    private readonly deps: Deps,
    private readonly config: TimetableConfigService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  // ---- reading -------------------------------------------------------------------------

  /** An owner from the query, or null for the School default day. */
  private async ownerOf(
    ex: Executor,
    tenantId: string,
    q: { section_id?: string; class_id?: string; academic_year_id?: string },
    principal: Principal,
    permission: string,
  ): Promise<Owner | null> {
    if (!q.section_id && !q.class_id) return null;
    return resolveOwner(ex, tenantId, q, principal, permission);
  }

  /** The periods of a section / class (with subject, teacher and weekday exceptions), or of the School default day. */
  async list(tenantId: string, q: z.infer<typeof OwnerQuery>, principal: Principal) {
    await this.config.ensureSettings(tenantId);
    const owner = await this.ownerOf(this.db, tenantId, q, principal, 'timetable.read');
    const settings = await readSettings(this.db, tenantId);
    const periods = await loadPeriods(this.db, tenantId, { extra: ownerFilter(owner) });
    return {
      owner: owner ? ownerPresent(owner) : null,
      academic_year_id: owner?.yearId ?? null,
      working_days: [...settings.workingDays].sort((a, b) => a - b),
      periods: periods.map((lp) => this.present(lp, settings.workingDays)),
    };
  }

  async get(tenantId: string, id: string, principal: Principal) {
    await this.config.ensureSettings(tenantId);
    const lp = await this.loaded(this.db, tenantId, id);
    this.assertScope(lp, principal, 'timetable.read');
    const settings = await readSettings(this.db, tenantId);
    return this.present(lp, settings.workingDays);
  }

  private present(lp: LoadedPeriod, workingDays: number[]) {
    const p = lp.p;
    const days = [...workingDays].sort((a, b) => a - b);
    return {
      ...periodBrief(p),
      display_order: p.displayOrder,
      owner: lp.owner ? ownerPresent(lp.owner) : null,
      academic_year_id: p.academicYearId,
      class_id: p.academicClassId,
      section_id: p.academicSectionId,
      scope: p.academicSectionId ? 'SECTION' : p.academicClassId ? 'CLASS' : 'SCHOOL',
      /** The lesson of every day (unless a weekday exception says otherwise). */
      lesson: p.kind === 'LESSON' && lp.owner ? specPresent(lp.lesson) : null,
      /** LESSON periods of a section or class without a subject yet. */
      needs_subject: p.kind === 'LESSON' && !!lp.owner && !lp.lesson.offering,
      problems: lp.owner ? lessonProblems(lp.lesson, lp.owner) : [],
      days: days.map((d) => {
        const c = cellOf(lp, d);
        const ov = lp.overrides.get(d);
        return {
          day_of_week: d,
          day_name: DAY_NAMES[d],
          state: c.state,
          /** True when a weekday exception decides this day. */
          overridden: !!ov,
          override_id: ov?.o.id ?? null,
          ...(c.lesson ? specPresent(c.lesson.spec) : {}),
        };
      }),
      version: p.version,
      created_at: p.createdAt.toISOString(),
      updated_at: p.updatedAt.toISOString(),
    };
  }

  private async loaded(ex: Executor, tenantId: string, id: string, lock?: 'update') {
    if (lock)
      await ex
        .select({ id: timetablePeriods.id })
        .from(timetablePeriods)
        .where(and(eq(timetablePeriods.id, id), eq(timetablePeriods.tenantId, tenantId)))
        .for(lock);
    const [lp] = await loadPeriods(ex, tenantId, { periodIds: [id] });
    if (!lp) throw new NotFoundError('Period');
    return lp;
  }

  private assertScope(lp: LoadedPeriod, principal: Principal, permission: string) {
    if (!lp.owner) {
      if (permission !== 'timetable.read') requireWide(principal, permission);
      return;
    }
    if (
      !sectionInScope(principal, permission, {
        id: lp.owner.sectionId ?? '',
        classId: lp.owner.classId,
      })
    )
      throw new NotFoundError('Period');
  }

  // ---- validation ----------------------------------------------------------------------

  /** Check a subject + teacher (+ venue) for an owner: offered there, taught by an active assignment, venue active. */
  private async resolveLesson(
    tx: Executor,
    tenantId: string,
    owner: Owner,
    input: { subject_offering_id: string; teacher_id?: string | null; venue_id?: string | null },
  ): Promise<Resolved> {
    const [off] = await tx
      .select()
      .from(subjectOfferings)
      .where(
        and(
          eq(subjectOfferings.id, input.subject_offering_id),
          eq(subjectOfferings.tenantId, tenantId),
        ),
      )
      .for('share');
    if (!off) throw new NotFoundError('Subject offering');
    if (off.status !== 'ACTIVE')
      throw reject('OFFERING_INACTIVE', 'The subject is no longer offered');
    if (
      off.academicYearId !== owner.yearId ||
      off.classId !== owner.classId ||
      (off.sectionId !== null && off.sectionId !== owner.sectionId)
    )
      throw reject('OFFERING_NOT_FOR_SECTION', `This subject is not offered to ${owner.title}`, {
        subject_offering_id: off.id,
      });
    const active = await tx
      .select()
      .from(teachingAssignments)
      .where(
        and(
          eq(teachingAssignments.tenantId, tenantId),
          eq(teachingAssignments.subjectOfferingId, off.id),
          eq(teachingAssignments.status, 'ACTIVE'),
        ),
      )
      .for('share');
    let a = active[0];
    if (input.teacher_id) {
      a = active.find((x) => x.teacherId === input.teacher_id);
      if (!a)
        throw reject(
          'TEACHER_NOT_ASSIGNED',
          'This teacher is not assigned to teach this subject here',
          {
            teacher_id: input.teacher_id,
            subject_offering_id: off.id,
          },
        );
    } else if (active.length === 0)
      throw reject(
        'NO_TEACHING_ASSIGNMENT',
        'No teacher is assigned to this subject yet. Assign one under Teachers first.',
        { subject_offering_id: off.id },
      );
    else if (active.length > 1)
      throw reject('AMBIGUOUS_TEACHER', 'Several teachers teach this subject: choose one', {
        subject_offering_id: off.id,
        teacher_ids: active.map((x) => x.teacherId),
      });
    let venueId: string | null = null;
    if (input.venue_id) {
      const [v] = await tx
        .select()
        .from(timetableVenues)
        .where(and(eq(timetableVenues.id, input.venue_id), eq(timetableVenues.tenantId, tenantId)))
        .for('share');
      if (!v) throw new NotFoundError('Venue');
      if (v.status !== 'ACTIVE') throw reject('VENUE_INACTIVE', 'The venue is inactive');
      venueId = v.id;
    }
    return { offeringId: off.id, assignmentId: a!.id, teacherId: a!.teacherId, venueId };
  }

  /** Active periods of the same school day must not overlap on a weekday they share. */
  private async assertNoOverlap(
    tx: Executor,
    tenantId: string,
    owner: Owner | null,
    start: string,
    end: string,
    days: number[] | null,
    exceptId?: string,
  ) {
    const rows = await tx
      .select()
      .from(timetablePeriods)
      .where(
        and(
          eq(timetablePeriods.tenantId, tenantId),
          eq(timetablePeriods.status, 'ACTIVE'),
          ownerFilter(owner),
          exceptId ? ne(timetablePeriods.id, exceptId) : undefined,
          sql`${timetablePeriods.startTime} < ${hhmmss(end)} and ${timetablePeriods.endTime} > ${hhmmss(start)}`,
        ),
      );
    const clash = rows.filter((r) => daysOverlap(r.daysOfWeek, days));
    if (clash.length)
      throw reject(
        'PERIOD_OVERLAP',
        `The period overlaps ${clash[0]!.name} (${hhmm(clash[0]!.startTime)}–${hhmm(clash[0]!.endTime)})`,
        { overlapping: clash.map(periodBrief) },
      );
  }

  /**
   * The weekdays a period runs on, from the request: sorted, only teaching days,
   * and null when it is every teaching day.
   */
  private daysFor(input: number[] | null | undefined, workingDays: number[]): number[] | null {
    const days = normalizeDays(input);
    if (!days) return null;
    const teaching = days.filter((d) => workingDays.includes(d));
    if (!teaching.length)
      throw validationIssue('days_of_week', 'Choose at least one teaching day of the school');
    return workingDays.every((d) => teaching.includes(d)) ? null : teaching;
  }

  /** Lock the school (serialises timetable writes) and return the settings. */
  private async lock(tx: Executor, tenantId: string) {
    return readSettings(tx, tenantId, 'update');
  }

  // ---- periods -------------------------------------------------------------------------

  async create(
    tenantId: string,
    input: z.infer<typeof CreatePeriodBody>,
    principal: Principal,
    actor: Actor,
  ) {
    await this.config.ensureSettings(tenantId);
    let id!: string;
    await this.db.transaction(async (tx) => {
      const settings = await this.lock(tx, tenantId);
      const owner = await this.ownerOf(tx, tenantId, input, principal, 'timetable.manage');
      if (!owner) requireWide(principal, 'timetable.manage');
      const teaching = input.kind === 'LESSON' && owner !== null;
      if (!teaching && (input.subject_offering_id || input.teacher_id || input.venue_id))
        throw validationIssue(
          'subject_offering_id',
          owner
            ? 'Only lesson periods have a subject, teacher and venue'
            : 'The School default day is a template of times: it has no subjects',
        );
      if (teaching && !input.subject_offering_id)
        throw validationIssue('subject_offering_id', 'Choose the subject of this lesson period');
      const days = this.daysFor(input.days_of_week, settings.workingDays);
      await this.assertNoOverlap(tx, tenantId, owner, input.start_time, input.end_time, days);
      const lesson = teaching
        ? await this.resolveLesson(tx, tenantId, owner, {
            subject_offering_id: input.subject_offering_id!,
            teacher_id: input.teacher_id,
            venue_id: input.venue_id,
          })
        : null;
      const code = input.code ?? (await nextPeriodCode(tx, tenantId, input.kind));
      id = uuidv7();
      try {
        await tx.insert(timetablePeriods).values({
          id,
          tenantId,
          code,
          name: input.name,
          startTime: hhmmss(input.start_time),
          endTime: hhmmss(input.end_time),
          kind: input.kind,
          displayOrder: input.display_order,
          academicClassId: owner?.classId ?? null,
          academicSectionId: owner?.sectionId ?? null,
          academicYearId: owner?.yearId ?? null,
          subjectOfferingId: lesson?.offeringId ?? null,
          teachingAssignmentId: lesson?.assignmentId ?? null,
          teacherId: lesson?.teacherId ?? null,
          venueId: lesson?.venueId ?? null,
          daysOfWeek: days,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        });
      } catch (err) {
        if (isDuplicateKeyError(err))
          throw new ConflictError('DUPLICATE_RESOURCE', 'A period with this code already exists');
        throw err;
      }
      if (owner) await assertNoClash(tx, tenantId, owner.yearId, settings.workingDays, [id]);
      const lp = await this.loaded(tx, tenantId, id);
      const view = this.present(lp, settings.workingDays);
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_PERIOD_CREATED',
        entityType: 'timetable_period',
        entityId: id,
        event: 'timetable_period.created',
        after: view,
        payload: { code, kind: input.kind, owner: view.owner },
      });
    });
    return this.get(tenantId, id, principal);
  }

  async update(
    tenantId: string,
    id: string,
    input: z.infer<typeof UpdatePeriodBody>,
    principal: Principal,
    actor: Actor,
  ) {
    await this.config.ensureSettings(tenantId);
    await this.db.transaction(async (tx) => {
      const settings = await this.lock(tx, tenantId);
      const before = await this.loaded(tx, tenantId, id, 'update');
      this.assertScope(before, principal, 'timetable.manage');
      const p = before.p;
      if (p.version !== input.version)
        throw new ConflictError('CONFLICT', undefined, { reason: 'STALE_VERSION' });
      const start = input.start_time ?? hhmm(p.startTime);
      const end = input.end_time ?? hhmm(p.endTime);
      if (start >= end)
        throw validationIssue('end_time', 'The end time must be after the start time');
      const kind = input.kind ?? p.kind;
      const owner = before.owner;
      const teaching = kind === 'LESSON' && owner !== null;
      if (!teaching && (input.subject_offering_id || input.teacher_id || input.venue_id))
        throw validationIssue(
          'subject_offering_id',
          'Only lesson periods have a subject, teacher and venue',
        );
      const days =
        input.days_of_week !== undefined
          ? this.daysFor(input.days_of_week, settings.workingDays)
          : p.daysOfWeek;
      if (p.status === 'ACTIVE')
        await this.assertNoOverlap(tx, tenantId, owner, start, end, days, id);

      const set: Partial<typeof timetablePeriods.$inferInsert> = {
        startTime: hhmmss(start),
        endTime: hhmmss(end),
        kind,
        daysOfWeek: days,
      };
      // Weekday exceptions on days the period no longer runs on go away.
      for (const [d, ov] of before.overrides)
        if (!runsOn({ daysOfWeek: days }, d))
          await tx.delete(timetableDayOverrides).where(eq(timetableDayOverrides.id, ov.o.id));
      if (input.name !== undefined) set.name = input.name;
      if (input.display_order !== undefined) set.displayOrder = input.display_order;
      if (!teaching) {
        Object.assign(set, {
          subjectOfferingId: null,
          teachingAssignmentId: null,
          teacherId: null,
          venueId: null,
        });
        // A period that no longer takes lessons has no weekday exceptions either.
        await tx
          .delete(timetableDayOverrides)
          .where(
            and(
              eq(timetableDayOverrides.tenantId, tenantId),
              eq(timetableDayOverrides.periodId, id),
            ),
          );
      } else {
        const lessonChanged =
          input.subject_offering_id !== undefined ||
          input.teacher_id !== undefined ||
          input.venue_id !== undefined;
        if (lessonChanged || !p.subjectOfferingId) {
          const offeringId = input.subject_offering_id ?? p.subjectOfferingId;
          if (!offeringId)
            throw validationIssue(
              'subject_offering_id',
              'Choose the subject of this lesson period',
            );
          // A new subject picks its own teacher unless one is named.
          const teacherId =
            input.teacher_id !== undefined
              ? input.teacher_id
              : input.subject_offering_id && input.subject_offering_id !== p.subjectOfferingId
                ? undefined
                : p.teacherId;
          const r = await this.resolveLesson(tx, tenantId, owner, {
            subject_offering_id: offeringId,
            teacher_id: teacherId ?? undefined,
            venue_id: input.venue_id !== undefined ? input.venue_id : p.venueId,
          });
          Object.assign(set, {
            subjectOfferingId: r.offeringId,
            teachingAssignmentId: r.assignmentId,
            teacherId: r.teacherId,
            venueId: r.venueId,
          });
        }
      }
      await tx
        .update(timetablePeriods)
        .set({ ...set, version: p.version + 1, updatedBy: actor.userId })
        .where(eq(timetablePeriods.id, id));
      if (owner) await assertNoClash(tx, tenantId, owner.yearId, settings.workingDays, [id]);
      const after = await this.loaded(tx, tenantId, id);
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_PERIOD_UPDATED',
        entityType: 'timetable_period',
        entityId: id,
        event: 'timetable_period.updated',
        before: this.present(before, settings.workingDays),
        after: this.present(after, settings.workingDays),
        payload: { changed: Object.keys(input).filter((k) => k !== 'version') },
      });
    });
    return this.get(tenantId, id, principal);
  }

  async setState(
    tenantId: string,
    id: string,
    to: 'ACTIVE' | 'INACTIVE',
    principal: Principal,
    actor: Actor,
  ) {
    await this.config.ensureSettings(tenantId);
    await this.db.transaction(async (tx) => {
      const settings = await this.lock(tx, tenantId);
      const before = await this.loaded(tx, tenantId, id, 'update');
      this.assertScope(before, principal, 'timetable.manage');
      if (before.p.status === to) return;
      if (to === 'ACTIVE')
        await this.assertNoOverlap(
          tx,
          tenantId,
          before.owner,
          hhmm(before.p.startTime),
          hhmm(before.p.endTime),
          before.p.daysOfWeek,
          id,
        );
      await tx
        .update(timetablePeriods)
        .set({ status: to, version: before.p.version + 1, updatedBy: actor.userId })
        .where(eq(timetablePeriods.id, id));
      if (to === 'ACTIVE' && before.owner)
        await assertNoClash(tx, tenantId, before.owner.yearId, settings.workingDays, [id]);
      await recordChange(tx, actor, tenantId, {
        action: to === 'ACTIVE' ? 'TIMETABLE_PERIOD_ACTIVATED' : 'TIMETABLE_PERIOD_DEACTIVATED',
        entityType: 'timetable_period',
        entityId: id,
        event: `timetable_period.${to === 'ACTIVE' ? 'activated' : 'deactivated'}`,
        before: { status: before.p.status },
        after: { status: to },
      });
    });
    return this.get(tenantId, id, principal);
  }

  /** Delete a period (and its weekday exceptions). The audit log keeps what it was. */
  async remove(tenantId: string, id: string, principal: Principal, actor: Actor) {
    await this.config.ensureSettings(tenantId);
    await this.db.transaction(async (tx) => {
      const settings = await this.lock(tx, tenantId);
      const before = await this.loaded(tx, tenantId, id, 'update');
      this.assertScope(before, principal, 'timetable.manage');
      await tx
        .delete(timetableDayOverrides)
        .where(
          and(eq(timetableDayOverrides.tenantId, tenantId), eq(timetableDayOverrides.periodId, id)),
        );
      await tx.delete(timetablePeriods).where(eq(timetablePeriods.id, id));
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_PERIOD_DELETED',
        entityType: 'timetable_period',
        entityId: id,
        event: 'timetable_period.deleted',
        before: this.present(before, settings.workingDays),
      });
    });
  }

  // ---- weekday exceptions ---------------------------------------------------------------

  /**
   * On weekday [day], period [id] has another lesson (subject + teacher + venue),
   * or no lesson at all (`subject_offering_id: null`). Setting it back to the
   * period's own lesson removes the exception.
   */
  async setDay(
    tenantId: string,
    id: string,
    day: number,
    input: z.infer<typeof SetDayBody>,
    principal: Principal,
    actor: Actor,
  ) {
    await this.config.ensureSettings(tenantId);
    await this.db.transaction(async (tx) => {
      const settings = await this.lock(tx, tenantId);
      const lp = await this.loaded(tx, tenantId, id, 'update');
      this.assertScope(lp, principal, 'timetable.manage');
      const owner = lp.owner;
      if (!owner || lp.p.kind !== 'LESSON')
        throw reject('PERIOD_NOT_LESSON', `${lp.p.name} does not take lessons`);
      if (!settings.workingDays.includes(day))
        throw reject('DAY_NOT_WORKING', `${DAY_NAMES[day]} is not a teaching day of the school`);
      if (!runsOn(lp.p, day))
        throw reject('DAY_NOT_IN_PERIOD', `${lp.p.name} does not run on ${DAY_NAMES[day]}s`);
      const existing = lp.overrides.get(day)?.o;
      if (existing && input.version !== undefined && existing.version !== input.version)
        throw new ConflictError('CONFLICT', undefined, { reason: 'STALE_VERSION' });
      const r =
        input.subject_offering_id === null
          ? null
          : await this.resolveLesson(tx, tenantId, owner, {
              subject_offering_id: input.subject_offering_id,
              teacher_id: input.teacher_id,
              venue_id: input.venue_id,
            });
      const sameAsPeriod =
        r !== null &&
        r.offeringId === lp.p.subjectOfferingId &&
        r.assignmentId === lp.p.teachingAssignmentId &&
        r.venueId === lp.p.venueId;
      if (existing)
        await tx.delete(timetableDayOverrides).where(eq(timetableDayOverrides.id, existing.id));
      if (!sameAsPeriod)
        await tx.insert(timetableDayOverrides).values({
          id: uuidv7(),
          tenantId,
          periodId: id,
          dayOfWeek: day,
          kind: r ? 'LESSON' : 'FREE',
          subjectOfferingId: r?.offeringId ?? null,
          teachingAssignmentId: r?.assignmentId ?? null,
          teacherId: r?.teacherId ?? null,
          venueId: r?.venueId ?? null,
          version: existing ? existing.version + 1 : 1,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        });
      await assertNoClash(tx, tenantId, owner.yearId, settings.workingDays, [id]);
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_DAY_SET',
        entityType: 'timetable_period',
        entityId: id,
        event: 'timetable_period.day_set',
        before: existing
          ? { kind: existing.kind, subject_offering_id: existing.subjectOfferingId }
          : null,
        after: sameAsPeriod
          ? null
          : {
              day_of_week: day,
              kind: r ? 'LESSON' : 'FREE',
              subject_offering_id: r?.offeringId ?? null,
              teacher_id: r?.teacherId ?? null,
            },
        payload: { day_of_week: day, owner: ownerPresent(owner) },
      });
    });
    return this.get(tenantId, id, principal);
  }

  /** Remove the weekday exception: the day follows the period's own lesson again. */
  async clearDay(tenantId: string, id: string, day: number, principal: Principal, actor: Actor) {
    await this.config.ensureSettings(tenantId);
    await this.db.transaction(async (tx) => {
      const settings = await this.lock(tx, tenantId);
      const lp = await this.loaded(tx, tenantId, id, 'update');
      this.assertScope(lp, principal, 'timetable.manage');
      const existing = lp.overrides.get(day)?.o;
      if (!existing) return;
      await tx.delete(timetableDayOverrides).where(eq(timetableDayOverrides.id, existing.id));
      if (lp.owner) await assertNoClash(tx, tenantId, lp.owner.yearId, settings.workingDays, [id]);
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_DAY_CLEARED',
        entityType: 'timetable_period',
        entityId: id,
        event: 'timetable_period.day_cleared',
        before: {
          day_of_week: day,
          kind: existing.kind,
          subject_offering_id: existing.subjectOfferingId,
        },
      });
    });
    return this.get(tenantId, id, principal);
  }

  // ---- copying -------------------------------------------------------------------------

  /**
   * Give an empty section (or class) a school day by copying the period TIMES
   * (names, kinds, start/end) of another section/class or the School default
   * day. Subjects and teachers are not copied: one teacher cannot teach two
   * sections at the same time, so each section picks its own.
   */
  async copy(
    tenantId: string,
    input: z.infer<typeof CopyPeriodsBody>,
    principal: Principal,
    actor: Actor,
  ) {
    await this.config.ensureSettings(tenantId);
    let created = 0;
    let owner!: Owner;
    await this.db.transaction(async (tx) => {
      await this.lock(tx, tenantId);
      owner = await resolveOwner(tx, tenantId, input.to, principal, 'timetable.manage');
      const from =
        input.from.template === true
          ? null
          : await resolveOwner(tx, tenantId, input.from, principal, 'timetable.read');
      const [has] = await tx
        .select({ id: timetablePeriods.id })
        .from(timetablePeriods)
        .where(and(eq(timetablePeriods.tenantId, tenantId), ownerFilter(owner)))
        .limit(1);
      if (has)
        throw reject(
          'OWNER_HAS_PERIODS',
          `${owner.title} already has periods. Delete them first to copy another school day.`,
        );
      const source = await tx
        .select()
        .from(timetablePeriods)
        .where(
          and(
            eq(timetablePeriods.tenantId, tenantId),
            eq(timetablePeriods.status, 'ACTIVE'),
            ownerFilter(from),
          ),
        );
      if (!source.length) throw reject('NOTHING_TO_COPY', 'There are no periods to copy there');
      for (const p of source) {
        await tx.insert(timetablePeriods).values({
          id: uuidv7(),
          tenantId,
          code: await nextPeriodCode(tx, tenantId, p.kind),
          name: p.name,
          startTime: p.startTime,
          endTime: p.endTime,
          kind: p.kind,
          displayOrder: p.displayOrder,
          daysOfWeek: p.daysOfWeek,
          academicClassId: owner.classId,
          academicSectionId: owner.sectionId,
          academicYearId: owner.yearId,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        });
        created++;
      }
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_PERIODS_COPIED',
        entityType: 'timetable_day',
        entityId: owner.sectionId ?? owner.classId,
        event: 'timetable.periods_copied',
        after: {
          owner: ownerPresent(owner),
          from: from ? ownerPresent(from) : 'SCHOOL_DEFAULT',
          periods: created,
        },
        payload: { periods: created },
      });
    });
    return { owner: ownerPresent(owner), created };
  }

  /**
   * Start a new academic year from last year's timetable: for every section (by
   * class + section code) or class without sections that has periods in the
   * source year and none in the target year, copy the periods and, where they
   * still apply, their subject (same subject offered there), teacher (still
   * assigned) and weekday exceptions. Lessons that would clash keep their
   * subject but lose the teacher, and are reported.
   */
  async copyYear(
    tenantId: string,
    input: z.infer<typeof CopyYearBody>,
    principal: Principal,
    actor: Actor,
  ) {
    requireWide(principal, 'timetable.manage');
    await this.config.ensureSettings(tenantId);
    if (input.from_academic_year_id === input.to_academic_year_id)
      throw validationIssue('to_academic_year_id', 'Choose a different academic year to copy into');
    const report = {
      owners: 0,
      periods: 0,
      lessons: 0,
      skipped: [] as string[],
      teacher_removed: [] as string[],
    };
    await this.db.transaction(async (tx) => {
      const settings = await this.lock(tx, tenantId);
      await loadYear(tx, tenantId, input.from_academic_year_id);
      await loadYear(tx, tenantId, input.to_academic_year_id);
      const src = (await loadPeriods(tx, tenantId, { yearId: input.from_academic_year_id })).filter(
        (lp) => lp.owner && (!input.class_id || lp.owner.classId === input.class_id),
      );
      const targetSections = await tx
        .select()
        .from(academicSections)
        .where(
          and(
            eq(academicSections.tenantId, tenantId),
            eq(academicSections.academicYearId, input.to_academic_year_id),
            inArray(academicSections.status, ['ACTIVE', 'DRAFT']),
          ),
        );
      const targetOfferings = await tx
        .select()
        .from(subjectOfferings)
        .where(
          and(
            eq(subjectOfferings.tenantId, tenantId),
            eq(subjectOfferings.academicYearId, input.to_academic_year_id),
            eq(subjectOfferings.status, 'ACTIVE'),
          ),
        );
      const activeAssignments = await tx
        .select()
        .from(teachingAssignments)
        .where(
          and(eq(teachingAssignments.tenantId, tenantId), eq(teachingAssignments.status, 'ACTIVE')),
        );
      const sourceOfferings = new Map(
        (
          await tx
            .select()
            .from(subjectOfferings)
            .where(
              and(
                eq(subjectOfferings.tenantId, tenantId),
                eq(subjectOfferings.academicYearId, input.from_academic_year_id),
              ),
            )
        ).map((o) => [o.id, o]),
      );
      const existingTarget = await tx
        .select({ s: timetablePeriods.academicSectionId, c: timetablePeriods.academicClassId })
        .from(timetablePeriods)
        .where(
          and(
            eq(timetablePeriods.tenantId, tenantId),
            eq(timetablePeriods.academicYearId, input.to_academic_year_id),
          ),
        );
      const busy = new Set(existingTarget.map((r) => r.s ?? `C${r.c}`));

      // group source periods by owner
      const groups = new Map<string, LoadedPeriod[]>();
      for (const lp of src) {
        const k = lp.owner!.sectionId ?? `C${lp.owner!.classId}`;
        groups.set(k, [...(groups.get(k) ?? []), lp]);
      }
      const created: string[] = [];
      for (const list of groups.values()) {
        const o = list[0]!.owner!;
        let target: { sectionId: string | null; classId: string } | null = null;
        if (o.sectionId) {
          const s = targetSections.find((x) => x.classId === o.classId && x.code === o.sectionCode);
          if (s) target = { sectionId: s.id, classId: s.classId };
        } else if (!targetSections.some((x) => x.classId === o.classId)) {
          target = { sectionId: null, classId: o.classId };
        }
        if (!target) {
          report.skipped.push(
            `${o.title}: no matching ${o.sectionId ? 'section' : 'class'} in the new year`,
          );
          continue;
        }
        if (busy.has(target.sectionId ?? `C${target.classId}`)) {
          report.skipped.push(`${o.title}: already has periods in the new year`);
          continue;
        }
        report.owners++;
        // the target offering for a source offering: same subject, class and (section by code or class-wide)
        const mapOffering = (id: string | null) => {
          if (!id) return null;
          const so = sourceOfferings.get(id);
          if (!so) return null;
          return (
            targetOfferings.find(
              (t) =>
                t.subjectId === so.subjectId &&
                t.classId === target!.classId &&
                (so.sectionId === null ? t.sectionId === null : t.sectionId === target!.sectionId),
            ) ?? null
          );
        };
        const assignmentFor = (offId: string, teacherId: string | null) => {
          const list2 = activeAssignments.filter((a) => a.subjectOfferingId === offId);
          return (
            list2.find((a) => a.teacherId === teacherId) ?? (list2.length === 1 ? list2[0]! : null)
          );
        };
        for (const lp of list) {
          const off = lp.p.kind === 'LESSON' ? mapOffering(lp.p.subjectOfferingId) : null;
          const a = off ? assignmentFor(off.id, lp.p.teacherId) : null;
          const id = uuidv7();
          await tx.insert(timetablePeriods).values({
            id,
            tenantId,
            code: await nextPeriodCode(tx, tenantId, lp.p.kind),
            name: lp.p.name,
            startTime: lp.p.startTime,
            endTime: lp.p.endTime,
            kind: lp.p.kind,
            displayOrder: lp.p.displayOrder,
            daysOfWeek: lp.p.daysOfWeek,
            status: lp.p.status,
            academicClassId: target.classId,
            academicSectionId: target.sectionId,
            academicYearId: input.to_academic_year_id,
            subjectOfferingId: a ? off!.id : null,
            teachingAssignmentId: a?.id ?? null,
            teacherId: a?.teacherId ?? null,
            venueId: a ? lp.p.venueId : null,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          });
          report.periods++;
          if (a) report.lessons++;
          created.push(id);
          for (const { o: ov } of lp.overrides.values()) {
            if (ov.kind === 'FREE') {
              await tx.insert(timetableDayOverrides).values({
                id: uuidv7(),
                tenantId,
                periodId: id,
                dayOfWeek: ov.dayOfWeek,
                kind: 'FREE',
                createdBy: actor.userId,
                updatedBy: actor.userId,
              });
              continue;
            }
            const off2 = mapOffering(ov.subjectOfferingId);
            const a2 = off2 ? assignmentFor(off2.id, ov.teacherId) : null;
            if (!a2) continue;
            await tx.insert(timetableDayOverrides).values({
              id: uuidv7(),
              tenantId,
              periodId: id,
              dayOfWeek: ov.dayOfWeek,
              kind: 'LESSON',
              subjectOfferingId: off2!.id,
              teachingAssignmentId: a2.id,
              teacherId: a2.teacherId,
              venueId: ov.venueId,
              createdBy: actor.userId,
              updatedBy: actor.userId,
            });
          }
        }
      }
      // Lessons that would clash keep their subject but lose the teacher (reported).
      const clashes = findClashes(
        lessonsOf(
          await loadPeriods(tx, tenantId, { yearId: input.to_academic_year_id }),
          settings.workingDays,
        ),
        new Set(created),
      );
      for (const c of clashes) {
        const l = c.lessons.find((x) => created.includes(x.period.p.id)) ?? c.lessons[1];
        if (l.override)
          await tx.delete(timetableDayOverrides).where(eq(timetableDayOverrides.id, l.override.id));
        else
          await tx
            .update(timetablePeriods)
            .set({
              subjectOfferingId: null,
              teachingAssignmentId: null,
              teacherId: null,
              venueId: null,
            })
            .where(eq(timetablePeriods.id, l.period.p.id));
        report.teacher_removed.push(clashPresent(c).message);
      }
      await recordChange(tx, actor, tenantId, {
        action: 'TIMETABLE_YEAR_COPIED',
        entityType: 'academic_year',
        entityId: input.to_academic_year_id,
        event: 'timetable.year_copied',
        after: { from_academic_year_id: input.from_academic_year_id, ...report },
        payload: { owners: report.owners, periods: report.periods },
      });
    });
    return report;
  }

  // ---- status ---------------------------------------------------------------------------

  /**
   * Every section (and class without sections) of the year the caller can see,
   * with how complete its timetable is: periods, lesson periods still without
   * a subject, lessons with a problem (ended assignment …), and clashes.
   */
  async status(tenantId: string, q: z.infer<typeof StatusQuery>, principal: Principal) {
    await this.config.ensureSettings(tenantId);
    const yearId = q.academic_year_id ?? (await currentYearId(this.db, tenantId));
    if (!yearId) return { academic_year_id: null, owners: [], clashes: [] };
    await loadYear(this.db, tenantId, yearId);
    const settings = await readSettings(this.db, tenantId);
    const periods = await loadPeriods(this.db, tenantId, { yearId });
    const lessons = lessonsOf(periods, settings.workingDays);
    const clashes = findClashes(lessons);
    const sections = await this.db
      .select({
        id: academicSections.id,
        code: academicSections.code,
        name: academicSections.name,
        classId: academicSections.classId,
        className: academicClasses.name,
        classCode: academicClasses.code,
        sequence: academicClasses.sequence,
      })
      .from(academicSections)
      .innerJoin(academicClasses, eq(academicClasses.id, academicSections.classId))
      .where(
        and(
          eq(academicSections.tenantId, tenantId),
          eq(academicSections.academicYearId, yearId),
          inArray(academicSections.status, ['ACTIVE', 'DRAFT']),
        ),
      );
    const withSections = new Set(sections.map((s) => s.classId));
    const classes = await this.db
      .select()
      .from(academicClasses)
      .where(and(eq(academicClasses.tenantId, tenantId), eq(academicClasses.status, 'ACTIVE')));
    const owners = [
      ...sections.map((s) => ({
        kind: 'SECTION' as const,
        id: s.id,
        classId: s.classId,
        sectionId: s.id as string | null,
        title: `${s.className} ${s.name}`.trim(),
        className: s.className,
        sectionName: s.name as string | null,
        sequence: s.sequence,
        sectionCode: s.code as string | null,
      })),
      ...classes
        .filter((c) => !withSections.has(c.id))
        .map((c) => ({
          kind: 'CLASS' as const,
          id: c.id,
          classId: c.id,
          sectionId: null,
          title: c.name,
          className: c.name,
          sectionName: null,
          sequence: c.sequence,
          sectionCode: null,
        })),
    ]
      .filter((o) =>
        sectionInScope(principal, 'timetable.read', { id: o.sectionId ?? '', classId: o.classId }),
      )
      .sort(
        (a, b) =>
          a.sequence - b.sequence || (a.sectionCode ?? '').localeCompare(b.sectionCode ?? ''),
      );
    const mine = (o: { sectionId: string | null; classId: string }) =>
      periods.filter(
        (lp) =>
          lp.owner &&
          (o.sectionId
            ? lp.owner.sectionId === o.sectionId
            : !lp.owner.sectionId && lp.owner.classId === o.classId),
      );
    return {
      academic_year_id: yearId,
      working_days: settings.workingDays,
      owners: owners.map((o) => {
        const ps = mine(o).filter((lp) => lp.p.status === 'ACTIVE');
        const lessonPeriods = ps.filter((lp) => lp.p.kind === 'LESSON');
        const ids = new Set(ps.map((lp) => lp.p.id));
        const problems = lessonPeriods.filter(
          (lp) => lessonProblems(lp.lesson, lp.owner!).length > 0,
        );
        const nClash = clashes.filter((c) => c.lessons.some((l) => ids.has(l.period.p.id))).length;
        const missing = lessonPeriods.filter((lp) => !lp.lesson.offering).length;
        return {
          kind: o.kind,
          id: o.id,
          class: { id: o.classId, name: o.className },
          section: o.sectionId ? { id: o.sectionId, name: o.sectionName } : null,
          title: o.title,
          periods: ps.length,
          lesson_periods: lessonPeriods.length,
          needs_subject: missing,
          problems: problems.length,
          clashes: nClash,
          state:
            ps.length === 0
              ? 'NO_PERIODS'
              : missing + problems.length + nClash > 0
                ? 'NEEDS_ATTENTION'
                : 'COMPLETE',
        };
      }),
      clashes: clashes.slice(0, 50).map(clashPresent),
    };
  }

  /** Week lessons of an owner, for the section / class views. */
  ownerLessons(periods: LoadedPeriod[], days: number[]) {
    return lessonsOf(periods, days).map(lessonPresent);
  }
}

export type { PeriodRow };
