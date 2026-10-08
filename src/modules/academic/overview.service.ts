import { and, asc, count, countDistinct, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Deps } from '../../container.js';
import {
  academicClasses,
  academicSections,
  academicYears,
  enrollments,
  OPEN_ENROLLMENT_STATUSES,
  sectionClassTeachers,
  subjectOfferings,
  teachers,
} from '../../db/schema/index.js';
import { NotFoundError } from '../../shared/errors.js';

export const ClassOverviewQuery = z.object({ academic_year_id: z.uuid().optional() });

const OPEN = [...OPEN_ENROLLMENT_STATUSES];

/** One read for the class registry, class detail and capacity screens. */
export class ClassOverviewService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  async overview(tenantId: string, q: z.infer<typeof ClassOverviewQuery>) {
    const [year] = await this.db
      .select()
      .from(academicYears)
      .where(
        and(
          eq(academicYears.tenantId, tenantId),
          q.academic_year_id
            ? eq(academicYears.id, q.academic_year_id)
            : eq(academicYears.status, 'ACTIVE'),
        ),
      );
    if (q.academic_year_id && !year) throw new NotFoundError('Academic year');

    const classes = await this.db
      .select()
      .from(academicClasses)
      .where(and(eq(academicClasses.tenantId, tenantId), ne(academicClasses.status, 'ARCHIVED')))
      .orderBy(asc(academicClasses.sequence), asc(academicClasses.name));
    if (!year)
      return { academic_year: null, classes: [], totals: null, attention: [] as Attention[] };

    const sections = await this.db
      .select()
      .from(academicSections)
      .where(
        and(
          eq(academicSections.tenantId, tenantId),
          eq(academicSections.academicYearId, year.id),
          ne(academicSections.status, 'ARCHIVED'),
        ),
      )
      .orderBy(asc(academicSections.code));
    const seats = await this.db
      .select({ sectionId: enrollments.sectionId, n: count() })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.tenantId, tenantId),
          eq(enrollments.academicYearId, year.id),
          inArray(enrollments.status, OPEN),
        ),
      )
      .groupBy(enrollments.sectionId);
    const noSection = seats.find((s) => s.sectionId === null);
    const enrolledBy = new Map(seats.filter((s) => s.sectionId).map((s) => [s.sectionId!, s.n]));

    const heads = await this.db
      .select({
        sectionId: sectionClassTeachers.sectionId,
        teacherId: teachers.id,
        first: teachers.firstName,
        last: teachers.lastName,
      })
      .from(sectionClassTeachers)
      .innerJoin(
        teachers,
        and(
          eq(teachers.tenantId, sectionClassTeachers.tenantId),
          eq(teachers.id, sectionClassTeachers.teacherId),
        ),
      )
      .where(
        and(eq(sectionClassTeachers.tenantId, tenantId), eq(sectionClassTeachers.status, 'ACTIVE')),
      );
    const headOf = new Map(heads.map((h) => [h.sectionId, h]));

    const subj = await this.db
      .select({ classId: subjectOfferings.classId, n: countDistinct(subjectOfferings.subjectId) })
      .from(subjectOfferings)
      .where(
        and(
          eq(subjectOfferings.tenantId, tenantId),
          eq(subjectOfferings.academicYearId, year.id),
          eq(subjectOfferings.status, 'ACTIVE'),
        ),
      )
      .groupBy(subjectOfferings.classId);
    const subjectsBy = new Map(subj.map((s) => [s.classId, s.n]));

    const attention: Attention[] = [];
    let totalEnrolled = 0;
    let totalCapacity = 0;
    let totalSections = 0;
    let withoutTeacher = 0;

    // Year-end promotion goes to the next active class in the school's order.
    const nextActive = new Map<string, string>();
    for (const [i, c] of classes.entries()) {
      const n = classes.slice(i + 1).find((x) => x.status === 'ACTIVE');
      if (n) nextActive.set(c.id, n.id);
    }
    const out = classes.map((c) => {
      const secs = sections
        .filter((s) => s.classId === c.id)
        .map((s) => {
          const enrolled = Number(enrolledBy.get(s.id) ?? 0);
          const head = headOf.get(s.id);
          const over = s.capacity !== null && enrolled > s.capacity;
          const live = s.status === 'ACTIVE';
          if (over)
            attention.push({
              type: 'OVER_CAPACITY',
              class_id: c.id,
              section_id: s.id,
              text: `${c.name} · ${s.name} has ${enrolled - s.capacity!} more ltudent(s) than its ${s.capacity} seats`,
            });
          if (!head && live)
            attention.push({
              type: 'NO_CLASS_TEACHER',
              class_id: c.id,
              section_id: s.id,
              text: `${c.name} · ${s.name} has no class teacher`,
            });
          if (!head && live) withoutTeacher++;
          return {
            id: s.id,
            code: s.code,
            name: s.name,
            room: s.room,
            status: s.status,
            capacity: s.capacity,
            enrolled_count: enrolled,
            seats_available: s.capacity === null ? null : Math.max(0, s.capacity - enrolled),
            over_capacity: over,
            class_teacher: head
              ? { id: head.teacherId, name: `${head.first} ${head.last}`.trim() }
              : null,
          };
        });
      const enrolled = secs.reduce((a, s) => a + s.enrolled_count, 0);
      const capacity = secs.reduce((a, s) => a + (s.capacity ?? 0), 0);
      totalEnrolled += enrolled;
      totalCapacity += capacity;
      totalSections += secs.length;
      return {
        id: c.id,
        code: c.code,
        name: c.name,
        display_name: c.displayName,
        sequence: c.sequence,
        phase: c.phase,
        language_of_instruction: c.languageOfInstruction,
        promotes_to_class_id: nextActive.get(c.id) ?? null,
        status: c.status,
        version: c.version,
        sections: secs,
        enrolled,
        capacity,
        subjects: subjectsBy.get(c.id) ?? 0,
        sections_with_teacher: secs.filter((s) => s.class_teacher).length,
      };
    });
    return {
      academic_year: { id: year.id, code: year.code, name: year.name, status: year.status },
      classes: out,
      totals: {
        classes: out.length,
        sections: totalSections,
        enrolled: totalEnrolled,
        capacity: totalCapacity,
        sections_without_teacher: withoutTeacher,
        unplaced: Number(noSection?.n ?? 0), // enrolled in a class but not in a section
      },
      attention,
    };
  }
}

export interface Attention {
  type: 'OVER_CAPACITY' | 'NO_CLASS_TEACHER';
  class_id: string;
  section_id: string;
  text: string;
}
