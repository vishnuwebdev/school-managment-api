import { and, eq, inArray } from 'drizzle-orm';
import type { Deps } from '../../container.js';
import { teachers } from '../../db/schema/index.js';
import type { Principal } from '../../platform/context.js';
import { AuthorizationError } from '../../shared/errors.js';
import type { ReportService } from '../attendance/reports.service.js';
import type { Caller } from '../attendance/support.js';
import type { ClassTeacherService } from '../teachers/class-teachers.service.js';
import { fullName } from '../teachers/support.js';
import type { ViewService } from '../timetable/views.service.js';

/** The signed-in teacher's own record, as the teacher app needs it everywhere. */
export interface MyTeacher {
  id: string;
  teacherNumber: string;
  fullName: string;
  firstName: string;
  preferredName: string | null;
  status: string;
}

/**
 * Screen-shaped reads for the teacher app. Everything here composes existing
 * services, so scope and business rules stay where they are; nothing in this
 * class writes data.
 */
export class TeacherAppService {
  constructor(
    private readonly deps: Deps,
    private readonly classTeachers: ClassTeacherService,
    private readonly attendanceReports: ReportService,
    private readonly timetableViews: ViewService,
  ) {}

  /**
   * The teacher record linked to this membership. The teacher app is for
   * teachers only: a school user without one (or one who has left) gets 403
   * NOT_A_TEACHER, whatever their role.
   */
  async myTeacher(tenantId: string, principal: Principal): Promise<MyTeacher> {
    const [t] = await this.deps.db
      .select()
      .from(teachers)
      .where(
        and(
          eq(teachers.tenantId, tenantId),
          eq(teachers.membershipId, principal.membershipId),
          inArray(teachers.status, ['ACTIVE', 'ON_LEAVE']),
        ),
      );
    if (!t)
      throw new AuthorizationError(
        'NOT_A_TEACHER',
        'The teacher app is only for teachers. Your account isn’t linked to an active teacher record.',
      );
    return {
      id: t.id,
      teacherNumber: t.teacherNumber,
      fullName: fullName(t),
      firstName: t.firstName,
      preferredName: t.preferredName,
      status: t.status,
    };
  }

  /** Today: my lessons and the daily register state of every class I can mark. */
  async today(c: Caller, date: string | undefined) {
    const me = await this.myTeacher(c.tenantId, c.principal);
    const [lessons, registers] = await Promise.all([
      this.timetableViews.myDay(c.tenantId, { date }, c.principal),
      this.attendanceReports.today(c, { date }),
    ]);
    return {
      date: registers.date,
      teacher: { id: me.id, full_name: me.fullName, first_name: me.preferredName ?? me.firstName },
      lessons,
      registers: registers.sections,
      register_totals: registers.totals,
    };
  }

  /**
   * My classes: every section I teach or am class teacher of, with today's
   * register state and the subjects I teach there.
   */
  async classes(c: Caller) {
    await this.myTeacher(c.tenantId, c.principal);
    const [mine, registers] = await Promise.all([
      this.classTeachers.mine(c.tenantId, c.principal),
      this.attendanceReports.today(c, {}),
    ]);
    const classTeacherOf = new Set(mine.class_teacher_of.map((x) => x.section_id));
    const subjectsFor = (sectionId: string, classId: string) =>
      mine.teaching
        .filter(
          (t) => t.section_id === sectionId || (t.section_id === null && t.class_id === classId),
        )
        .map((t) => ({ assignment_id: t.assignment_id, role: t.role, subject: t.subject }));
    return {
      date: registers.date,
      classes: registers.sections.map((s) => ({
        section: s.section,
        class: s.class,
        is_class_teacher: classTeacherOf.has(String(s.section.id)),
        subjects: subjectsFor(String(s.section.id), String(s.class.id)),
        register: {
          session_id: s.session_id,
          state: s.state,
          roster_size: s.roster_size,
          marked_count: s.marked_count,
        },
      })),
    };
  }
}
