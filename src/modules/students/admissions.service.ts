import { and, count, desc, eq, like, or, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import { admissions, students, type AdmissionStatus } from '../../db/schema/index.js';
import type { Actor } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import { todayIso } from '../../shared/dates.js';
import { BusinessRuleError, ConflictError, NotFoundError } from '../../shared/errors.js';
import { offsetOf, pageOf } from '../../shared/pagination.js';
import type {
  AdmissionListQuery,
  ApproveAdmissionBody,
  CreateAdmissionBody,
} from './students.schemas.js';
import type { StudentService } from './students.service.js';
import { addHistory, fullName, likeOf, nextNumber, setStudentStatus } from './support.js';

type AdmissionRow = typeof admissions.$inferSelect;
type StudentRowT = typeof students.$inferSelect;

const present = (a: AdmissionRow, s: StudentRowT) => ({
  id: a.id,
  admission_number: a.admissionNumber,
  status: a.status,
  application_date: a.applicationDate,
  admission_date: a.admissionDate,
  source: a.source,
  notes: a.notes,
  decision_note: a.decisionNote,
  decided_at: a.decidedAt?.toISOString() ?? null,
  student: {
    id: s.id,
    student_number: s.studentNumber,
    full_name: fullName(s),
    date_of_birth: s.dateOfBirth,
    status: s.status,
  },
  version: a.version,
  created_at: a.createdAt.toISOString(),
  updated_at: a.updatedAt.toISOString(),
});

/**
 * Admission workflow: DRAFT → SUBMITTED → (UNDER_REVIEW) → APPROVED | REJECTED,
 * with CANCELLED as an exit. The student's lifecycle status follows the
 * admission (PROSPECTIVE → ADMISSION_PENDING → ADMITTED); approving does not
 * enroll or activate the student.
 */
export class AdmissionService {
  constructor(
    private readonly deps: Deps,
    private readonly studentSvc: StudentService,
  ) {}

  private get db() {
    return this.deps.db;
  }

  async list(tenantId: string, q: z.infer<typeof AdmissionListQuery>) {
    const conds: (SQL | undefined)[] = [eq(admissions.tenantId, tenantId)];
    if (q.status) conds.push(eq(admissions.status, q.status));
    if (q.search) {
      const s = likeOf(q.search);
      conds.push(
        or(
          like(admissions.admissionNumber, s),
          like(students.firstName, s),
          like(students.lastName, s),
          like(students.studentNumber, s),
        ),
      );
    }
    const where = and(...conds);
    const [rows, [total]] = await Promise.all([
      this.db
        .select({ a: admissions, s: students })
        .from(admissions)
        .innerJoin(students, eq(students.id, admissions.studentId))
        .where(where)
        .orderBy(desc(admissions.createdAt))
        .limit(q.page_size)
        .offset(offsetOf(q)),
      this.db
        .select({ n: count() })
        .from(admissions)
        .innerJoin(students, eq(students.id, admissions.studentId))
        .where(where),
    ]);
    return pageOf(
      rows.map((r) => present(r.a, r.s)),
      total?.n ?? 0,
      q,
    );
  }

  async get(tenantId: string, id: string, ex: Executor = this.db) {
    const [r] = await ex
      .select({ a: admissions, s: students })
      .from(admissions)
      .innerJoin(students, eq(students.id, admissions.studentId))
      .where(and(eq(admissions.id, id), eq(admissions.tenantId, tenantId)));
    if (!r) throw new NotFoundError('Admission');
    return present(r.a, r.s);
  }

  async create(tenantId: string, input: z.infer<typeof CreateAdmissionBody>, actor: Actor) {
    const id = await this.db.transaction(async (tx) => {
      const now = this.deps.clock.now();
      const admissionNumber = await nextNumber(tx, tenantId, 'ADM', now);
      let student: StudentRowT;
      if (input.student) {
        const dups = await this.studentSvc.findDuplicates(tx, tenantId, {
          firstName: input.student.first_name,
          lastName: input.student.last_name,
          dateOfBirth: input.student.date_of_birth,
          phone: input.student.primary_phone,
          email: input.student.primary_email,
        });
        this.studentSvc.assertNoUnconfirmedDuplicates(dups, input.confirm_duplicate);
        student = await this.studentSvc.insertStudent(
          tx,
          tenantId,
          input.student,
          'PROSPECTIVE',
          actor,
          {
            admissionNumber,
          },
        );
      } else {
        const [s] = await tx
          .select()
          .from(students)
          .where(and(eq(students.id, input.student_id!), eq(students.tenantId, tenantId)))
          .for('update');
        if (!s) throw new NotFoundError('Student');
        if (s.status !== 'PROSPECTIVE')
          throw new BusinessRuleError(
            'INVALID_STATE',
            'Admissions can only be opened for prospective students',
            {
              student_status: s.status,
            },
          );
        const [open] = await tx
          .select({ id: admissions.id })
          .from(admissions)
          .where(
            and(
              eq(admissions.tenantId, tenantId),
              eq(admissions.studentId, s.id),
              or(
                eq(admissions.status, 'DRAFT'),
                eq(admissions.status, 'SUBMITTED'),
                eq(admissions.status, 'UNDER_REVIEW'),
              ),
            ),
          );
        if (open)
          throw new ConflictError(
            'DUPLICATE_RESOURCE',
            'This student already has an open admission',
            {
              admission_id: open.id,
            },
          );
        await tx
          .update(students)
          .set({ admissionNumber, version: s.version + 1 })
          .where(eq(students.id, s.id));
        student = { ...s, admissionNumber };
      }
      const [ins] = await tx
        .insert(admissions)
        .values({
          tenantId,
          studentId: student.id,
          admissionNumber,
          applicationDate: input.application_date ?? todayIso(this.deps.clock),
          source: input.source ?? null,
          notes: input.notes ?? null,
          createdBy: actor.userId,
        })
        .$returningId();
      await addHistory(tx, actor, tenantId, student.id, {
        eventType: 'ADMISSION_CREATED',
        details: { admission_number: admissionNumber },
      });
      await recordChange(tx, actor, tenantId, {
        action: 'ADMISSION_CREATED',
        entityType: 'admission',
        entityId: ins!.id,
        event: 'admission.created',
        after: { admission_number: admissionNumber, student_id: student.id },
        payload: { student_id: student.id, admission_number: admissionNumber },
      });
      return ins!.id;
    });
    return this.get(tenantId, id);
  }

  /** Runs one workflow step under a row lock, with the student's status kept in step. */
  private async step(
    tenantId: string,
    id: string,
    from: AdmissionStatus[],
    to: AdmissionStatus,
    actor: Actor,
    o: {
      event: string;
      reason?: string | null;
      set?: Partial<typeof admissions.$inferInsert>;
      student?: {
        to: StudentRowT['status'];
        command: string;
        when?: StudentRowT['status'][];
      };
    },
  ) {
    await this.db.transaction(async (tx) => {
      const [a] = await tx
        .select()
        .from(admissions)
        .where(and(eq(admissions.id, id), eq(admissions.tenantId, tenantId)))
        .for('update');
      if (!a) throw new NotFoundError('Admission');
      if (!from.includes(a.status))
        throw new BusinessRuleError(
          'INVALID_STATE',
          `A ${a.status.toLowerCase().replace('_', ' ')} admission cannot move to ${to.toLowerCase().replace('_', ' ')}`,
          { admission_status: a.status },
        );
      await tx
        .update(admissions)
        .set({ status: to, version: a.version + 1, ...(o.set ?? {}) })
        .where(eq(admissions.id, id));
      const [student] = await tx
        .select()
        .from(students)
        .where(and(eq(students.id, a.studentId), eq(students.tenantId, tenantId)))
        .for('update');
      if (student && o.student && (!o.student.when || o.student.when.includes(student.status))) {
        await setStudentStatus(tx, actor, student, o.student.to, {
          command: o.student.command,
          reason: o.reason ?? `Admission ${to.toLowerCase()}`,
          now: this.deps.clock.now(),
        });
      }
      await addHistory(tx, actor, tenantId, a.studentId, {
        eventType: `ADMISSION_${to}`,
        reason: o.reason ?? null,
        details: { admission_number: a.admissionNumber },
      });
      await recordChange(tx, actor, tenantId, {
        action: `ADMISSION_${to}`,
        entityType: 'admission',
        entityId: id,
        event: o.event,
        before: { status: a.status },
        after: { status: to },
        reason: o.reason ?? null,
        payload: { student_id: a.studentId, admission_number: a.admissionNumber },
      });
    });
    return this.get(tenantId, id);
  }

  submit(tenantId: string, id: string, actor: Actor) {
    return this.step(tenantId, id, ['DRAFT'], 'SUBMITTED', actor, {
      event: 'admission.submitted',
      student: { to: 'ADMISSION_PENDING', command: 'admission_submitted', when: ['PROSPECTIVE'] },
    });
  }

  startReview(tenantId: string, id: string, actor: Actor) {
    return this.step(tenantId, id, ['SUBMITTED'], 'UNDER_REVIEW', actor, {
      event: 'admission.review_started',
    });
  }

  approve(tenantId: string, id: string, input: z.infer<typeof ApproveAdmissionBody>, actor: Actor) {
    return this.step(tenantId, id, ['SUBMITTED', 'UNDER_REVIEW'], 'APPROVED', actor, {
      event: 'admission.approved',
      reason: input.note ?? null,
      set: {
        admissionDate: input.admission_date ?? todayIso(this.deps.clock),
        decisionNote: input.note ?? null,
        decidedBy: actor.userId,
        decidedAt: this.deps.clock.now(),
      },
      student: { to: 'ADMITTED', command: 'admit', when: ['ADMISSION_PENDING', 'PROSPECTIVE'] },
    });
  }

  reject(tenantId: string, id: string, reason: string, actor: Actor) {
    return this.step(tenantId, id, ['SUBMITTED', 'UNDER_REVIEW'], 'REJECTED', actor, {
      event: 'admission.rejected',
      reason,
      set: { decisionNote: reason, decidedBy: actor.userId, decidedAt: this.deps.clock.now() },
      student: { to: 'WITHDRAWN', command: 'withdraw', when: ['ADMISSION_PENDING', 'PROSPECTIVE'] },
    });
  }

  cancel(tenantId: string, id: string, reason: string, actor: Actor) {
    return this.step(tenantId, id, ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW'], 'CANCELLED', actor, {
      event: 'admission.cancelled',
      reason,
      student: { to: 'WITHDRAWN', command: 'withdraw', when: ['ADMISSION_PENDING', 'PROSPECTIVE'] },
    });
  }
}
