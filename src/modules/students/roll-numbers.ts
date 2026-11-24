import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Request } from 'express';
import { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import { academicSections, enrollments, students } from '../../db/schema/index.js';
import { defineRoute } from '../../http/route.js';
import { actorFrom, type Actor, type Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { hasTenantWideScope } from '../access/authorization.service.js';
import { sectionInScope } from '../attendance/support.js';

const RollNumber = z
  .string()
  .trim()
  .max(16)
  .regex(/^[A-Za-z0-9\-/ ]*$/, 'Use letters, digits, - or /')
  .transform((v) => (v === '' ? null : v))
  .nullable();

export const RollNumbersBody = z.object({
  items: z
    .array(z.object({ enrollment_id: z.uuid(), roll_number: RollNumber }))
    .min(1)
    .max(300),
});

const OPEN = ['PENDING', 'ACTIVE'] as const;

/**
 * Roll numbers (0045): a student's number in the class / section for the year, kept on the
 * enrollment. Unique among the open enrollments of a section (or of a class without sections).
 */
export class RollNumberService {
  constructor(private readonly deps: Deps) {}

  async save(
    tenantId: string,
    input: z.infer<typeof RollNumbersBody>,
    principal: Principal,
    actor: Actor,
  ) {
    return this.deps.db.transaction((tx) => this.saveIn(tx, tenantId, input, principal, actor));
  }

  private async saveIn(
    tx: Executor,
    tenantId: string,
    input: z.infer<typeof RollNumbersBody>,
    principal: Principal,
    actor: Actor,
  ) {
    const ids = [...new Set(input.items.map((i) => i.enrollment_id))];
    if (ids.length !== input.items.length)
      throw new ValidationError('Each enrollment can appear only once');
    {
      const rows = await tx
        .select()
        .from(enrollments)
        .where(and(eq(enrollments.tenantId, tenantId), inArray(enrollments.id, ids)))
        .for('update');
      if (rows.length !== ids.length) throw new NotFoundError('Enrollment');
      const wide = hasTenantWideScope(principal, 'students.enroll');
      for (const e of rows) {
        if (
          !wide &&
          !(
            e.sectionId &&
            sectionInScope(principal, 'students.enroll', { id: e.sectionId, classId: e.classId })
          )
        )
          throw new NotFoundError('Enrollment');
      }
      const next = new Map(input.items.map((i) => [i.enrollment_id, i.roll_number]));
      // Duplicates within the request, per section (or class) and year.
      const groupOf = (e: typeof enrollments.$inferSelect) =>
        `${e.academicYearId}:${e.sectionId ?? `class:${e.classId}`}`;
      const seen = new Map<string, string>();
      for (const e of rows) {
        const rn = next.get(e.id);
        if (!rn || !OPEN.includes(e.status as (typeof OPEN)[number])) continue;
        const key = `${groupOf(e)}:${rn.toLowerCase()}`;
        if (seen.has(key))
          throw new ConflictError('DUPLICATE_RESOURCE', `Roll number ${rn} is used twice`, {
            roll_number: rn,
          });
        seen.set(key, e.id);
      }
      // Against the other open enrollments in the same sections / classes.
      for (const e of rows) {
        const rn = next.get(e.id);
        if (!rn) continue;
        const clash = await tx
          .select({ id: enrollments.id, rn: enrollments.rollNumber })
          .from(enrollments)
          .where(
            and(
              eq(enrollments.tenantId, tenantId),
              eq(enrollments.academicYearId, e.academicYearId),
              e.sectionId
                ? eq(enrollments.sectionId, e.sectionId)
                : eq(enrollments.classId, e.classId),
              inArray(enrollments.status, [...OPEN]),
              eq(enrollments.rollNumber, rn),
              ne(enrollments.id, e.id),
            ),
          );
        const other = clash.find((c) => !next.has(c.id) || next.get(c.id) === rn);
        if (other)
          throw new ConflictError('DUPLICATE_RESOURCE', `Roll number ${rn} is already taken`, {
            roll_number: rn,
            enrollment_id: other.id,
          });
      }
      for (const e of rows) {
        const rn = next.get(e.id) ?? null;
        if (rn === e.rollNumber) continue;
        await tx
          .update(enrollments)
          .set({ rollNumber: rn, version: e.version + 1 })
          .where(eq(enrollments.id, e.id));
      }
      await recordChange(tx, actor, tenantId, {
        action: 'ROLL_NUMBERS_SET',
        entityType: 'enrollment',
        entityId: rows[0]!.id,
        after: { enrollments: rows.length },
      });
      return {
        data: rows.map((e) => ({
          enrollment_id: e.id,
          student_id: e.studentId,
          roll_number: next.get(e.id) ?? null,
        })),
      };
    }
  }

  /** Number every open enrollment of a section 1, 2, 3… in name order (first time setup). */
  async autoNumber(tenantId: string, sectionId: string, principal: Principal, actor: Actor) {
    const [sec] = await this.deps.db
      .select()
      .from(academicSections)
      .where(and(eq(academicSections.tenantId, tenantId), eq(academicSections.id, sectionId)));
    if (!sec) throw new NotFoundError('Section');
    if (
      !hasTenantWideScope(principal, 'students.enroll') &&
      !sectionInScope(principal, 'students.enroll', { id: sec.id, classId: sec.classId })
    )
      throw new NotFoundError('Section');
    return this.deps.db.transaction(async (tx) => {
      const list = await tx
        .select({ id: enrollments.id })
        .from(enrollments)
        .innerJoin(
          students,
          and(eq(students.tenantId, enrollments.tenantId), eq(students.id, enrollments.studentId)),
        )
        .where(
          and(
            eq(enrollments.tenantId, tenantId),
            eq(enrollments.sectionId, sectionId),
            inArray(enrollments.status, [...OPEN]),
          ),
        )
        .orderBy(students.firstName, students.lastName);
      if (!list.length) return { data: [] };
      // Clear first so the new numbers never clash with the old ones.
      await tx
        .update(enrollments)
        .set({ rollNumber: null })
        .where(
          inArray(
            enrollments.id,
            list.map((l) => l.id),
          ),
        );
      return this.saveIn(
        tx,
        tenantId,
        { items: list.map((l, i) => ({ enrollment_id: l.id, roll_number: String(i + 1) })) },
        principal,
        actor,
      );
    });
  }
}

const TAG = ['School · Enrollments'];
const tid = (req: Request) => req.ctx.tenant!.tenantId;

export function rollNumberRoutes(svc: RollNumberService) {
  return [
    defineRoute({
      method: 'put',
      path: '/enrollments/roll-numbers',
      summary: 'Set roll numbers (empty clears). Unique within a section for the year.',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.enroll'],
      body: RollNumbersBody,
      handler: async ({ body, req }) =>
        svc.save(tid(req), body, req.ctx.principal!, actorFrom(req.ctx)),
    }),
    defineRoute({
      method: 'post',
      path: '/sections/:id/roll-numbers/auto',
      summary: "Number a section's students 1, 2, 3… in name order (replaces existing numbers)",
      tags: TAG,
      access: 'tenant',
      permissions: ['students.enroll'],
      params: z.object({ id: z.uuid() }),
      handler: async ({ params, req }) =>
        svc.autoNumber(tid(req), params.id, req.ctx.principal!, actorFrom(req.ctx)),
    }),
  ];
}
