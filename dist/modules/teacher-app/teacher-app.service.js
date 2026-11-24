import { and, eq, inArray } from 'drizzle-orm';
import { academicSections, academicYears, teachers, timetableDayOverrides, users, timetablePeriods, } from '../../db/schema/index.js';
import { AuthorizationError, ValidationError } from '../../shared/errors.js';
import { verifyPassword } from '../identity/password.js';
import { fullName } from '../teachers/support.js';
/**
 * Screen-shaped reads for the teacher app. Everything here composes existing
 * services, so scope and business rules stay where they are; nothing in this
 * class writes data.
 */
export class TeacherAppService {
    deps;
    classTeachers;
    attendanceReports;
    timetableViews;
    constructor(deps, classTeachers, attendanceReports, timetableViews) {
        this.deps = deps;
        this.classTeachers = classTeachers;
        this.attendanceReports = attendanceReports;
        this.timetableViews = timetableViews;
    }
    /**
     * The teacher record linked to this membership. The teacher app is for
     * teachers only: a school user without one (or one who has left) gets 403
     * NOT_A_TEACHER, whatever their role.
     */
    async myTeacher(tenantId, principal) {
        const [t] = await this.deps.db
            .select()
            .from(teachers)
            .where(and(eq(teachers.tenantId, tenantId), eq(teachers.membershipId, principal.membershipId), inArray(teachers.status, ['ACTIVE', 'ON_LEAVE'])));
        if (!t)
            throw new AuthorizationError('NOT_A_TEACHER', 'The teacher app is only for teachers. Your account isn’t linked to an active teacher record.');
        return {
            id: t.id,
            teacherNumber: t.teacherNumber,
            fullName: fullName(t),
            firstName: t.firstName,
            preferredName: t.preferredName,
            status: t.status,
        };
    }
    /** Forgot PIN while signed in: confirm it is me with my account password. */
    async checkPassword(userId, password) {
        const [u] = await this.deps.db
            .select({ hash: users.passwordHash })
            .from(users)
            .where(eq(users.id, userId));
        if (!u?.hash || !(await verifyPassword(u.hash, password)))
            throw new ValidationError('That password isn’t right', {
                location: 'body',
                issues: [{ path: 'password', message: 'That password isn’t right' }],
            });
    }
    /** Classes I teach or am class teacher of (active / upcoming years): who class events reach. */
    async myClassIds(tenantId, principal) {
        const mine = await this.classTeachers.mine(tenantId, principal);
        return [
            ...new Set([...mine.class_teacher_of, ...mine.teaching].map((x) => String(x.class_id))),
        ];
    }
    /**
     * Sections where I have a period on the timetable (live years): my own periods
     * and weekday overrides that give me the period. A period for a whole class
     * (no section) counts for every section of that class.
     */
    async scheduledSectionIds(tenantId, teacherId) {
        const db = this.deps.db;
        const live = inArray(academicYears.status, ['ACTIVE', 'UPCOMING']);
        const fields = {
            sectionId: timetablePeriods.academicSectionId,
            classId: timetablePeriods.academicClassId,
            yearId: timetablePeriods.academicYearId,
        };
        const [own, overridden] = await Promise.all([
            db
                .select(fields)
                .from(timetablePeriods)
                .innerJoin(academicYears, eq(academicYears.id, timetablePeriods.academicYearId))
                .where(and(eq(timetablePeriods.tenantId, tenantId), eq(timetablePeriods.teacherId, teacherId), eq(timetablePeriods.status, 'ACTIVE'), live)),
            db
                .select(fields)
                .from(timetableDayOverrides)
                .innerJoin(timetablePeriods, and(eq(timetablePeriods.tenantId, timetableDayOverrides.tenantId), eq(timetablePeriods.id, timetableDayOverrides.periodId)))
                .innerJoin(academicYears, eq(academicYears.id, timetablePeriods.academicYearId))
                .where(and(eq(timetableDayOverrides.tenantId, tenantId), eq(timetableDayOverrides.teacherId, teacherId), eq(timetableDayOverrides.kind, 'LESSON'), eq(timetablePeriods.status, 'ACTIVE'), live)),
        ]);
        const out = new Set();
        const wholeClasses = [];
        for (const r of [...own, ...overridden]) {
            if (r.sectionId)
                out.add(r.sectionId);
            else if (r.classId && r.yearId)
                wholeClasses.push({ classId: r.classId, yearId: r.yearId });
        }
        for (const w of wholeClasses) {
            const secs = await db
                .select({ id: academicSections.id })
                .from(academicSections)
                .where(and(eq(academicSections.tenantId, tenantId), eq(academicSections.classId, w.classId), eq(academicSections.academicYearId, w.yearId)));
            for (const x of secs)
                out.add(x.id);
        }
        return out;
    }
    /** Today: my lessons and the daily register state of every class I can mark. */
    async today(c, date) {
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
     * My classes: sections where I have a timetable period or am class teacher, with today's
     * register state and the subjects I teach there.
     */
    async classes(c) {
        const me = await this.myTeacher(c.tenantId, c.principal);
        const [mine, registers, scheduled] = await Promise.all([
            this.classTeachers.mine(c.tenantId, c.principal),
            this.attendanceReports.today(c, {}),
            this.scheduledSectionIds(c.tenantId, me.id),
        ]);
        const classTeacherOf = new Set(mine.class_teacher_of.map((x) => x.section_id));
        // Product owner, 26 Oct 2026: My classes lists only sections where I have a
        // period on the timetable, plus the section I am class teacher of.
        const shown = registers.sections.filter((s) => scheduled.has(String(s.section.id)) || classTeacherOf.has(String(s.section.id)));
        const subjectsFor = (sectionId, classId) => mine.teaching
            .filter((t) => t.section_id === sectionId || (t.section_id === null && t.class_id === classId))
            .map((t) => ({ assignment_id: t.assignment_id, role: t.role, subject: t.subject }));
        return {
            date: registers.date,
            classes: shown.map((s) => ({
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
