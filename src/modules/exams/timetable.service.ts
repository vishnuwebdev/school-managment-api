import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import {
  academicClasses,
  academicSections,
  examPaperSittings,
  examPaperStaff,
  examPapers,
  exams,
  subjects,
  teachers,
  tenants,
  timetableDayOverrides,
  timetablePeriods,
  timetableVenues,
} from '../../db/schema/index.js';
import type { Actor, Principal } from '../../platform/context.js';
import { recordChange } from '../../platform/record.js';
import {
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors.js';
import { hasTenantWideScope } from '../access/authorization.service.js';
import { reachableClassIds } from './scope.js';
import type { DutiesQuery, PaperScheduleBody, SectionScheduleBody } from './exams.schemas.js';

/**
 * The exam timetable: when and where each paper is sat and who runs it.
 *
 * A paper (exam × class × subject) is scheduled for the whole class: a date, a start
 * and end time, a venue and its invigilators. A section can sit it differently
 * (exam_paper_sittings: its own date / time / venue, NULL = same as the class) and
 * can have its own invigilators, which then replace the class invigilators there.
 * Markers belong to the paper and may enter its marks.
 *
 * A "sitting" is what actually happens: one per section (or one for a class without
 * sections) with the effective date, time, venue and invigilators. Clashes are
 * checked on sittings, school-wide, across every exam:
 *   - a class / section cannot sit two papers at overlapping times;
 *   - a teacher cannot invigilate two sittings at overlapping times (sections of the
 *     same paper sat in the same slot count as one sitting);
 *   - a venue cannot hold two different papers at overlapping times.
 * An invigilator who normally has a timetable lesson at that time only gets a warning.
 */

interface Person {
  id: string;
  name: string;
}

export interface Sitting {
  paper_id: string;
  exam_id: string;
  exam_name: string;
  exam_status: string;
  class_id: string;
  class_name: string;
  section_id: string | null;
  section_name: string | null;
  subject_id: string;
  subject_name: string;
  exam_date: string | null;
  start_time: string | null;
  end_time: string | null;
  venue: Person | null;
  invigilators: Person[];
  /** The section sits differently from its class (own date, time or venue). */
  overridden: boolean;
  /** The section has its own invigilators. */
  own_invigilators: boolean;
}

interface Clash {
  type: 'SECTION' | 'TEACHER' | 'VENUE';
  message: string;
  paper_id: string;
  section_id: string | null;
  other_paper_id: string;
  teacher_id?: string;
  venue_id?: string;
}

const hhmm = (t: string | null | undefined) => (t ? t.slice(0, 5) : null);
const hhmmss = (t: string) => (t.length === 5 ? `${t}:00` : t);
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const timed = (
  s: Sitting,
): s is Sitting & { exam_date: string; start_time: string; end_time: string } =>
  !!(s.exam_date && s.start_time && s.end_time);
const overlap = (a: Sitting, b: Sitting) =>
  a.exam_date === b.exam_date &&
  minutes(a.start_time!) < minutes(b.end_time!) &&
  minutes(b.start_time!) < minutes(a.end_time!);
const sameSlot = (a: Sitting, b: Sitting) =>
  a.paper_id === b.paper_id &&
  a.exam_date === b.exam_date &&
  a.start_time === b.start_time &&
  a.end_time === b.end_time;
const where = (s: Sitting) => (s.section_name ? `${s.class_name} ${s.section_name}` : s.class_name);
const when = (s: Sitting) => `${s.exam_date} ${s.start_time}–${s.end_time}`;
const isoWeekday = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};
const DAY = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const teacherName = (t: { firstName: string; lastName: string; preferredName: string | null }) =>
  `${t.preferredName || t.firstName} ${t.lastName}`.trim();
const uniq = <T>(xs: T[]) => [...new Set(xs)];

export class ExamTimetableService {
  constructor(private readonly deps: Deps) {}

  private get db() {
    return this.deps.db;
  }

  // ---- loading -------------------------------------------------------------------

  private async loadPaper(ex: Executor, tenantId: string, paperId: string, lock = false) {
    const q = ex
      .select({ paper: examPapers, exam: exams })
      .from(examPapers)
      .innerJoin(
        exams,
        and(eq(exams.tenantId, examPapers.tenantId), eq(exams.id, examPapers.examId)),
      )
      .where(and(eq(examPapers.tenantId, tenantId), eq(examPapers.id, paperId)));
    const [row] = await (lock ? q.for('update') : q);
    if (!row) throw new NotFoundError('Paper');
    return row;
  }

  private assertOpen(exam: typeof exams.$inferSelect) {
    if (exam.status === 'PUBLISHED')
      throw new BusinessRuleError(
        'INVALID_STATE',
        'These results are published. Reopen the exam to change it',
        { reason: 'EXAM_PUBLISHED' },
      );
  }

  /** Papers with any sitting on one of these dates. */
  private async paperIdsOn(ex: Executor, tenantId: string, dates: string[]) {
    if (!dates.length) return [];
    const [a, b] = await Promise.all([
      ex
        .select({ id: examPapers.id })
        .from(examPapers)
        .where(and(eq(examPapers.tenantId, tenantId), inArray(examPapers.examDate, dates))),
      ex
        .select({ id: examPaperSittings.paperId })
        .from(examPaperSittings)
        .where(
          and(eq(examPaperSittings.tenantId, tenantId), inArray(examPaperSittings.examDate, dates)),
        ),
    ]);
    return uniq([...a, ...b].map((r) => r.id));
  }

  /**
   * Everything about some papers: the paper rows, their markers and class invigilators,
   * and their sittings (one per active section of the class in the exam's year, or one
   * for a class without sections).
   */
  private async load(ex: Executor, tenantId: string, paperIds: string[]) {
    if (!paperIds.length) return { papers: [], sittings: [] as Sitting[] };
    const papers = await ex
      .select({
        paper: examPapers,
        examName: exams.name,
        examStatus: exams.status,
        yearId: exams.academicYearId,
        subjectName: subjects.name,
        className: academicClasses.name,
        classDisplay: academicClasses.displayName,
        classSequence: academicClasses.sequence,
      })
      .from(examPapers)
      .innerJoin(
        exams,
        and(eq(exams.tenantId, examPapers.tenantId), eq(exams.id, examPapers.examId)),
      )
      .innerJoin(
        subjects,
        and(eq(subjects.tenantId, examPapers.tenantId), eq(subjects.id, examPapers.subjectId)),
      )
      .innerJoin(
        academicClasses,
        and(
          eq(academicClasses.tenantId, examPapers.tenantId),
          eq(academicClasses.id, examPapers.classId),
        ),
      )
      .where(and(eq(examPapers.tenantId, tenantId), inArray(examPapers.id, paperIds)));
    const classIds = uniq(papers.map((p) => p.paper.classId));
    const yearIds = uniq(papers.map((p) => p.yearId));
    const [sections, overrides, staff] = await Promise.all([
      classIds.length
        ? ex
            .select({
              id: academicSections.id,
              name: academicSections.name,
              classId: academicSections.classId,
              yearId: academicSections.academicYearId,
            })
            .from(academicSections)
            .where(
              and(
                eq(academicSections.tenantId, tenantId),
                eq(academicSections.status, 'ACTIVE'),
                inArray(academicSections.classId, classIds),
                inArray(academicSections.academicYearId, yearIds),
              ),
            )
            .orderBy(academicSections.name)
        : [],
      ex
        .select()
        .from(examPaperSittings)
        .where(
          and(
            eq(examPaperSittings.tenantId, tenantId),
            inArray(examPaperSittings.paperId, paperIds),
          ),
        ),
      ex
        .select({
          paperId: examPaperStaff.paperId,
          sectionId: examPaperStaff.sectionId,
          role: examPaperStaff.role,
          teacherId: teachers.id,
          firstName: teachers.firstName,
          lastName: teachers.lastName,
          preferredName: teachers.preferredName,
        })
        .from(examPaperStaff)
        .innerJoin(
          teachers,
          and(
            eq(teachers.tenantId, examPaperStaff.tenantId),
            eq(teachers.id, examPaperStaff.teacherId),
          ),
        )
        .where(
          and(eq(examPaperStaff.tenantId, tenantId), inArray(examPaperStaff.paperId, paperIds)),
        ),
    ]);
    const venueIds = uniq(
      [...papers.map((p) => p.paper.venueId), ...overrides.map((o) => o.venueId)].filter(
        (v): v is string => !!v,
      ),
    );
    const venues = venueIds.length
      ? await ex
          .select({ id: timetableVenues.id, name: timetableVenues.name })
          .from(timetableVenues)
          .where(and(eq(timetableVenues.tenantId, tenantId), inArray(timetableVenues.id, venueIds)))
      : [];
    const venueOf = (id: string | null) => {
      const v = id ? venues.find((x) => x.id === id) : undefined;
      return v ? { id: v.id, name: v.name } : null;
    };
    const people = (rows: typeof staff) =>
      rows
        .map((r) => ({ id: r.teacherId, name: teacherName(r) }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const sittings: Sitting[] = [];
    const out = papers.map((p) => {
      const mine = staff.filter((s) => s.paperId === p.paper.id);
      const classInvigilators = people(
        mine.filter((s) => s.role === 'INVIGILATOR' && !s.sectionId),
      );
      const markers = people(mine.filter((s) => s.role === 'MARKER'));
      const base = {
        paper_id: p.paper.id,
        exam_id: p.paper.examId,
        exam_name: p.examName,
        exam_status: p.examStatus,
        class_id: p.paper.classId,
        class_name: p.classDisplay || p.className,
        subject_id: p.paper.subjectId,
        subject_name: p.subjectName,
      };
      const secs = sections.filter((s) => s.classId === p.paper.classId && s.yearId === p.yearId);
      const own: Sitting[] = secs.length
        ? secs.map((s) => {
            const o = overrides.find((x) => x.paperId === p.paper.id && x.sectionId === s.id);
            const ownInv = people(
              mine.filter((m) => m.role === 'INVIGILATOR' && m.sectionId === s.id),
            );
            return {
              ...base,
              section_id: s.id,
              section_name: s.name,
              exam_date: o?.examDate ?? p.paper.examDate,
              start_time: hhmm(o?.startTime ?? p.paper.startTime),
              end_time: hhmm(o?.endTime ?? p.paper.endTime),
              venue: venueOf(o?.venueId ?? p.paper.venueId),
              invigilators: ownInv.length ? ownInv : classInvigilators,
              overridden: !!o && !!(o.examDate || o.startTime || o.venueId),
              own_invigilators: ownInv.length > 0,
            };
          })
        : [
            {
              ...base,
              section_id: null,
              section_name: null,
              exam_date: p.paper.examDate,
              start_time: hhmm(p.paper.startTime),
              end_time: hhmm(p.paper.endTime),
              venue: venueOf(p.paper.venueId),
              invigilators: classInvigilators,
              overridden: false,
              own_invigilators: false,
            },
          ];
      sittings.push(...own);
      return {
        id: p.paper.id,
        exam_id: p.paper.examId,
        class_id: p.paper.classId,
        class_name: base.class_name,
        class_sequence: p.classSequence,
        subject_id: p.paper.subjectId,
        subject_name: p.subjectName,
        exam_date: p.paper.examDate,
        start_time: hhmm(p.paper.startTime),
        end_time: hhmm(p.paper.endTime),
        venue: venueOf(p.paper.venueId),
        invigilators: classInvigilators,
        markers,
        max_marks: Number(p.paper.maxMarks),
        pass_marks: Number(p.paper.passMarks),
        has_sections: secs.length > 0,
        sections: secs.length ? own : [],
      };
    });
    return { papers: out, sittings };
  }

  // ---- checks --------------------------------------------------------------------

  /** Every clash between the sittings of one paper and the rest of the school. */
  private async clashes(ex: Executor, tenantId: string, paperId: string): Promise<Clash[]> {
    const mine = (await this.load(ex, tenantId, [paperId])).sittings.filter(timed);
    if (!mine.length) return [];
    const otherIds = (
      await this.paperIdsOn(ex, tenantId, uniq(mine.map((s) => s.exam_date!)))
    ).filter((id) => id !== paperId);
    const others = (await this.load(ex, tenantId, otherIds)).sittings.filter(timed);
    const out = new Map<string, Clash>();
    for (const m of mine) {
      for (const o of [...mine, ...others]) {
        if (o === m || !overlap(m, o)) continue;
        if (o.paper_id !== m.paper_id) {
          const sameGroup =
            m.class_id === o.class_id &&
            (m.section_id === o.section_id || m.section_id === null || o.section_id === null);
          if (sameGroup) {
            const k = `S:${m.section_id ?? m.class_id}:${o.paper_id}`;
            out.set(k, {
              type: 'SECTION',
              message: `${where(m)} already sits ${o.subject_name} (${o.exam_name}) on ${when(o)}`,
              paper_id: m.paper_id,
              section_id: m.section_id,
              other_paper_id: o.paper_id,
            });
          }
          if (m.venue && o.venue && m.venue.id === o.venue.id) {
            const k = `V:${m.venue.id}:${o.paper_id}`;
            out.set(k, {
              type: 'VENUE',
              message: `${m.venue.name} is already booked for ${where(o)} · ${o.subject_name} (${o.exam_name}) on ${when(o)}`,
              paper_id: m.paper_id,
              section_id: m.section_id,
              other_paper_id: o.paper_id,
              venue_id: m.venue.id,
            });
          }
        }
        if (sameSlot(m, o)) continue;
        for (const t of m.invigilators) {
          if (!o.invigilators.some((x) => x.id === t.id)) continue;
          // One clash per teacher and other slot (not one per section sitting in it).
          const k = `T:${t.id}:${o.paper_id}:${when(o)}`;
          if (out.has(k)) continue;
          out.set(k, {
            type: 'TEACHER',
            message: `${t.name} is already invigilating ${where(o)} · ${o.subject_name} (${o.exam_name}) on ${when(o)}`,
            paper_id: m.paper_id,
            section_id: m.section_id,
            other_paper_id: o.paper_id,
            teacher_id: t.id,
          });
        }
      }
    }
    return [...out.values()];
  }

  /** Invigilators who normally teach a timetable lesson while they would be invigilating. */
  private async lessonWarnings(
    ex: Executor,
    tenantId: string,
    yearId: string,
    sittings: Sitting[],
  ) {
    const list = sittings.filter(timed).filter((s) => s.invigilators.length);
    const teacherIds = uniq(list.flatMap((s) => s.invigilators.map((t) => t.id)));
    if (!teacherIds.length) return [];
    const ovByTeacher = await ex
      .select({ periodId: timetableDayOverrides.periodId })
      .from(timetableDayOverrides)
      .where(
        and(
          eq(timetableDayOverrides.tenantId, tenantId),
          inArray(timetableDayOverrides.teacherId, teacherIds),
        ),
      );
    const periods = await ex
      .select()
      .from(timetablePeriods)
      .where(
        and(
          eq(timetablePeriods.tenantId, tenantId),
          eq(timetablePeriods.status, 'ACTIVE'),
          eq(timetablePeriods.kind, 'LESSON'),
          eq(timetablePeriods.academicYearId, yearId),
          sql`(${inArray(timetablePeriods.teacherId, teacherIds)}${
            ovByTeacher.length
              ? sql` or ${inArray(
                  timetablePeriods.id,
                  ovByTeacher.map((o) => o.periodId),
                )}`
              : sql``
          })`,
        ),
      );
    if (!periods.length) return [];
    const overrides = await ex
      .select()
      .from(timetableDayOverrides)
      .where(
        and(
          eq(timetableDayOverrides.tenantId, tenantId),
          inArray(
            timetableDayOverrides.periodId,
            periods.map((p) => p.id),
          ),
        ),
      );
    const out = new Map<string, { teacher_id: string; message: string }>();
    for (const s of list) {
      const day = isoWeekday(s.exam_date!);
      for (const p of periods) {
        if (p.daysOfWeek && !p.daysOfWeek.includes(day)) continue;
        if (!(
          minutes(p.startTime) < minutes(s.end_time!) && minutes(s.start_time!) < minutes(p.endTime)
        ))
          continue;
        const ov = overrides.find((o) => o.periodId === p.id && o.dayOfWeek === day);
        if (ov?.kind === 'FREE') continue;
        const who = ov ? (ov.teacherId ?? p.teacherId) : p.teacherId;
        const t = s.invigilators.find((x) => x.id === who);
        if (!t) continue;
        const k = `${t.id}:${s.exam_date}:${p.id}`;
        out.set(k, {
          teacher_id: t.id,
          message: `${t.name} normally teaches ${p.name} (${hhmm(p.startTime)}–${hhmm(p.endTime)}) on ${DAY[day]}s — arrange cover for ${s.exam_date}`,
        });
      }
    }
    return [...out.values()];
  }

  private async lockSchool(tx: Executor, tenantId: string) {
    // One exam-timetable write at a time per school, so two changes cannot both pass
    // the clash check and then clash with each other.
    await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
  }

  private validateTimes(
    date: string | null,
    start: string | null,
    end: string | null,
    exam: typeof exams.$inferSelect,
  ) {
    if ((start === null) !== (end === null))
      throw new ValidationError('Set both a start and an end time');
    if (start && end && minutes(start) >= minutes(end))
      throw new ValidationError('The end time must be after the start time');
    if (start && !date) throw new ValidationError('Pick a date before setting the time');
    if (
      date &&
      ((exam.startDate && date < exam.startDate) || (exam.endDate && date > exam.endDate))
    )
      throw new ValidationError(
        `Pick a date within the exam dates (${exam.startDate ?? '…'} to ${exam.endDate ?? '…'})`,
      );
  }

  private async checkVenue(ex: Executor, tenantId: string, venueId: string | null | undefined) {
    if (!venueId) return;
    const [v] = await ex
      .select({ status: timetableVenues.status })
      .from(timetableVenues)
      .where(and(eq(timetableVenues.tenantId, tenantId), eq(timetableVenues.id, venueId)));
    if (!v) throw new NotFoundError('Venue');
    if (v.status !== 'ACTIVE') throw new ValidationError('This venue is no longer in use');
  }

  private async checkTeachers(ex: Executor, tenantId: string, ids: string[] | undefined) {
    if (!ids?.length) return;
    const rows = await ex
      .select({ id: teachers.id, status: teachers.status })
      .from(teachers)
      .where(and(eq(teachers.tenantId, tenantId), inArray(teachers.id, uniq(ids))));
    if (rows.length !== uniq(ids).length) throw new NotFoundError('Teacher');
    if (rows.some((r) => r.status !== 'ACTIVE'))
      throw new ValidationError('Only active teachers can run an exam');
  }

  private async replaceStaff(
    tx: Executor,
    tenantId: string,
    paperId: string,
    sectionId: string | null,
    role: 'INVIGILATOR' | 'MARKER',
    ids: string[],
  ) {
    await tx
      .delete(examPaperStaff)
      .where(
        and(
          eq(examPaperStaff.tenantId, tenantId),
          eq(examPaperStaff.paperId, paperId),
          eq(examPaperStaff.role, role),
          sectionId ? eq(examPaperStaff.sectionId, sectionId) : isNull(examPaperStaff.sectionId),
        ),
      );
    if (ids.length)
      await tx.insert(examPaperStaff).values(
        uniq(ids).map((teacherId) => ({
          id: uuidv7(),
          tenantId,
          paperId,
          sectionId,
          teacherId,
          role,
        })),
      );
  }

  private async guard(tx: Executor, tenantId: string, paperId: string, yearId: string) {
    const clashes = await this.clashes(tx, tenantId, paperId);
    if (clashes.length)
      throw new ConflictError('CONFLICT', clashes[0]!.message, { reason: 'EXAM_CLASH', clashes });
    const { sittings } = await this.load(tx, tenantId, [paperId]);
    return this.lessonWarnings(tx, tenantId, yearId, sittings);
  }

  // ---- reads ---------------------------------------------------------------------

  /** The whole timetable of an exam: every paper with its sittings, invigilators and markers. */
  async timetable(tenantId: string, examId: string) {
    const [exam] = await this.db
      .select()
      .from(exams)
      .where(and(eq(exams.tenantId, tenantId), eq(exams.id, examId)));
    if (!exam) throw new NotFoundError('Exam');
    const ids = (
      await this.db
        .select({ id: examPapers.id })
        .from(examPapers)
        .where(and(eq(examPapers.tenantId, tenantId), eq(examPapers.examId, examId)))
    ).map((r) => r.id);
    const { papers } = await this.load(this.db, tenantId, ids);
    papers.sort(
      (a, b) =>
        a.class_sequence - b.class_sequence ||
        (a.exam_date ?? '9999').localeCompare(b.exam_date ?? '9999') ||
        (a.start_time ?? '99').localeCompare(b.start_time ?? '99') ||
        a.subject_name.localeCompare(b.subject_name),
    );
    return {
      exam: {
        id: exam.id,
        name: exam.name,
        start_date: exam.startDate,
        end_date: exam.endDate,
        status: exam.status,
      },
      papers,
    };
  }

  private async paperView(tenantId: string, paperId: string) {
    const { papers } = await this.load(this.db, tenantId, [paperId]);
    return papers[0]!;
  }

  // ---- writes --------------------------------------------------------------------

  async setSchedule(
    tenantId: string,
    paperId: string,
    input: z.infer<typeof PaperScheduleBody>,
    actor: Actor,
  ) {
    const warnings = await this.db.transaction(async (tx) => {
      await this.lockSchool(tx, tenantId);
      const { paper, exam } = await this.loadPaper(tx, tenantId, paperId, true);
      this.assertOpen(exam);
      const date = input.exam_date !== undefined ? input.exam_date : paper.examDate;
      const start = input.start_time !== undefined ? input.start_time : hhmm(paper.startTime);
      const end = input.end_time !== undefined ? input.end_time : hhmm(paper.endTime);
      this.validateTimes(date, start, end, exam);
      await this.checkVenue(tx, tenantId, input.venue_id);
      await this.checkTeachers(tx, tenantId, [
        ...(input.invigilator_ids ?? []),
        ...(input.marker_ids ?? []),
      ]);
      await tx
        .update(examPapers)
        .set({
          examDate: date,
          startTime: start ? hhmmss(start) : null,
          endTime: end ? hhmmss(end) : null,
          ...(input.venue_id !== undefined ? { venueId: input.venue_id } : {}),
        })
        .where(and(eq(examPapers.tenantId, tenantId), eq(examPapers.id, paperId)));
      if (input.invigilator_ids)
        await this.replaceStaff(tx, tenantId, paperId, null, 'INVIGILATOR', input.invigilator_ids);
      if (input.marker_ids)
        await this.replaceStaff(tx, tenantId, paperId, null, 'MARKER', input.marker_ids);
      const w = await this.guard(tx, tenantId, paperId, exam.academicYearId);
      await recordChange(tx, actor, tenantId, {
        action: 'EXAM_PAPER_SCHEDULED',
        entityType: 'exam_paper',
        entityId: paperId,
        after: { ...input, exam_date: date, start_time: start, end_time: end },
      });
      return w;
    });
    return { paper: await this.paperView(tenantId, paperId), warnings };
  }

  async setSectionSchedule(
    tenantId: string,
    paperId: string,
    sectionId: string,
    input: z.infer<typeof SectionScheduleBody>,
    actor: Actor,
  ) {
    const warnings = await this.db.transaction(async (tx) => {
      await this.lockSchool(tx, tenantId);
      const { paper, exam } = await this.loadPaper(tx, tenantId, paperId, true);
      this.assertOpen(exam);
      const [section] = await tx
        .select({ id: academicSections.id })
        .from(academicSections)
        .where(
          and(
            eq(academicSections.tenantId, tenantId),
            eq(academicSections.id, sectionId),
            eq(academicSections.classId, paper.classId),
            eq(academicSections.academicYearId, exam.academicYearId),
          ),
        );
      if (!section) throw new NotFoundError('Section of this class');
      const ownDate = input.exam_date ?? null;
      const ownStart = input.start_time ?? null;
      const ownEnd = input.end_time ?? null;
      if ((ownStart === null) !== (ownEnd === null))
        throw new ValidationError('Set both a start and an end time');
      this.validateTimes(
        ownDate ?? paper.examDate,
        ownStart ?? hhmm(paper.startTime),
        ownEnd ?? hhmm(paper.endTime),
        exam,
      );
      await this.checkVenue(tx, tenantId, input.venue_id);
      await this.checkTeachers(tx, tenantId, input.invigilator_ids);
      const fields = {
        examDate: ownDate,
        startTime: ownStart ? hhmmss(ownStart) : null,
        endTime: ownEnd ? hhmmss(ownEnd) : null,
        venueId: input.venue_id ?? null,
      };
      const empty = !ownDate && !ownStart && !fields.venueId;
      const at = and(
        eq(examPaperSittings.tenantId, tenantId),
        eq(examPaperSittings.paperId, paperId),
        eq(examPaperSittings.sectionId, sectionId),
      );
      if (empty) await tx.delete(examPaperSittings).where(at);
      else
        await tx
          .insert(examPaperSittings)
          .values({ id: uuidv7(), tenantId, paperId, sectionId, ...fields })
          .onDuplicateKeyUpdate({ set: fields });
      await this.replaceStaff(
        tx,
        tenantId,
        paperId,
        sectionId,
        'INVIGILATOR',
        input.invigilator_ids ?? [],
      );
      const w = await this.guard(tx, tenantId, paperId, exam.academicYearId);
      await recordChange(tx, actor, tenantId, {
        action: 'EXAM_SECTION_SCHEDULED',
        entityType: 'exam_paper',
        entityId: paperId,
        after: { section_id: sectionId, ...input },
      });
      return w;
    });
    return { paper: await this.paperView(tenantId, paperId), warnings };
  }

  /** The section sits with its class again (same date, time, venue and invigilators). */
  async clearSectionSchedule(tenantId: string, paperId: string, sectionId: string, actor: Actor) {
    await this.db.transaction(async (tx) => {
      const { exam } = await this.loadPaper(tx, tenantId, paperId, true);
      this.assertOpen(exam);
      await tx
        .delete(examPaperSittings)
        .where(
          and(
            eq(examPaperSittings.tenantId, tenantId),
            eq(examPaperSittings.paperId, paperId),
            eq(examPaperSittings.sectionId, sectionId),
          ),
        );
      await this.replaceStaff(tx, tenantId, paperId, sectionId, 'INVIGILATOR', []);
      // Back on the class slot: that slot was already checked, but the section joins it now.
      const clashes = await this.clashes(tx, tenantId, paperId);
      if (clashes.length)
        throw new ConflictError('CONFLICT', clashes[0]!.message, { reason: 'EXAM_CLASH', clashes });
      await recordChange(tx, actor, tenantId, {
        action: 'EXAM_SECTION_SCHEDULE_CLEARED',
        entityType: 'exam_paper',
        entityId: paperId,
        after: { section_id: sectionId },
      });
    });
    return { paper: await this.paperView(tenantId, paperId), warnings: [] };
  }

  // ---- teachers ------------------------------------------------------------------

  private async myTeacherId(tenantId: string, principal: Principal) {
    const [t] = await this.db
      .select({ id: teachers.id })
      .from(teachers)
      .where(
        and(eq(teachers.tenantId, tenantId), eq(teachers.membershipId, principal.membershipId)),
      );
    return t?.id ?? null;
  }

  /** The signed-in teacher's exam duties: sittings to invigilate and papers to mark. */
  async myDuties(tenantId: string, principal: Principal, q: z.infer<typeof DutiesQuery>) {
    const teacherId = await this.myTeacherId(tenantId, principal);
    if (!teacherId) throw new NotFoundError('Teacher profile linked to your login');
    const rows = await this.db
      .select({ paperId: examPaperStaff.paperId, role: examPaperStaff.role })
      .from(examPaperStaff)
      .where(and(eq(examPaperStaff.tenantId, tenantId), eq(examPaperStaff.teacherId, teacherId)));
    const { papers, sittings } = await this.load(
      this.db,
      tenantId,
      uniq(rows.map((r) => r.paperId)),
    );
    const inRange = (d: string | null) =>
      (!q.from || (!!d && d >= q.from)) && (!q.to || (!!d && d <= q.to));
    const invigilating = sittings
      .filter((s) => s.invigilators.some((t) => t.id === teacherId) && inRange(s.exam_date))
      .sort(
        (a, b) =>
          (a.exam_date ?? '9999').localeCompare(b.exam_date ?? '9999') ||
          (a.start_time ?? '99').localeCompare(b.start_time ?? '99'),
      );
    const markIds = new Set(rows.filter((r) => r.role === 'MARKER').map((r) => r.paperId));
    const marking = papers
      .filter((p) => markIds.has(p.id))
      .map((p) => {
        const s = sittings.find((x) => x.paper_id === p.id)!;
        return {
          paper_id: p.id,
          exam_id: p.exam_id,
          exam_name: s.exam_name,
          exam_status: s.exam_status,
          class_id: p.class_id,
          class_name: p.class_name,
          subject_name: p.subject_name,
          exam_date: p.exam_date,
        };
      });
    return { teacher_id: teacherId, invigilating, marking };
  }

  /**
   * Marks for a paper may be entered by anyone with school-wide marks access, by a
   * teacher whose marks access covers the class (their sections / classes), or by
   * one of the paper's markers.
   */
  async assertCanEnterMarks(tenantId: string, principal: Principal, paperId: string) {
    if (hasTenantWideScope(principal, 'exams.marks.enter')) return;
    const { paper } = await this.loadPaper(this.db, tenantId, paperId);
    const reach = await reachableClassIds(this.db, { tenantId, principal }, 'exams.marks.enter');
    if (reach === null || reach.includes(paper.classId)) return;
    const teacherId = await this.myTeacherId(tenantId, principal);
    if (teacherId) {
      const [m] = await this.db
        .select({ id: examPaperStaff.id })
        .from(examPaperStaff)
        .where(
          and(
            eq(examPaperStaff.tenantId, tenantId),
            eq(examPaperStaff.paperId, paperId),
            eq(examPaperStaff.teacherId, teacherId),
            eq(examPaperStaff.role, 'MARKER'),
          ),
        );
      if (m) return;
    }
    throw new AuthorizationError(
      'PERMISSION_DENIED',
      'You can enter marks only for classes you teach or papers you are marking',
    );
  }
}

export type { Clash };
