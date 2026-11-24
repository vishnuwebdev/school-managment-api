import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { academicClasses, academicSections, academicYears } from '../../db/schema/index.js';
import { recordChange } from '../../platform/record.js';
import { csvLine } from '../../shared/csv.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import { offsetOf } from '../../shared/pagination.js';
import { fullName, loadStudent } from '../students/support.js';
import { dayOff } from '../calendar/calendar.rules.js';
import { emptyCounts, ROSTER_ENROLLMENT_STATUSES, } from './sessions.service.js';
import { addDaysIso, daysBetween, monthRange, num, percentage, placementScope, readSettings, round2, rows, schoolToday, sectionInScope, } from './support.js';
const MAX_REGISTER_DAYS = 62;
const MAX_HISTORY_DAYS = 732;
const MAX_CSV_ROWS = 10_000;
export class ReportService {
    deps;
    config;
    sessions;
    calendar;
    constructor(deps, config, sessions, calendar) {
        this.deps = deps;
        this.config = config;
        this.sessions = sessions;
        this.calendar = calendar;
    }
    get db() {
        return this.deps.db;
    }
    badRange(path, message) {
        return new ValidationError('The request is invalid', {
            location: 'query',
            issues: [{ path, code: 'custom', message }],
        });
    }
    async sectionFor(c, sectionId) {
        const [row] = await this.db
            .select({
            sec: academicSections,
            className: academicClasses.name,
            classCode: academicClasses.code,
            yearCode: academicYears.code,
        })
            .from(academicSections)
            .innerJoin(academicClasses, eq(academicClasses.id, academicSections.classId))
            .innerJoin(academicYears, eq(academicYears.id, academicSections.academicYearId))
            .where(and(eq(academicSections.id, sectionId), eq(academicSections.tenantId, c.tenantId)));
        if (!row || !sectionInScope(c.principal, 'attendance.read', row.sec))
            throw new NotFoundError('Section');
        return row;
    }
    // ---- today -------------------------------------------------------------------
    /** Per-section state of the day's DAILY register for the active academic year. */
    async today(c, q) {
        await this.config.ensureDefaults(c.tenantId);
        const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
        const date = q.date ?? today;
        if (date > today)
            throw this.badRange('date', 'The date cannot be in the future');
        const [year] = await this.db
            .select()
            .from(academicYears)
            .where(and(eq(academicYears.tenantId, c.tenantId), eq(academicYears.isCurrent, true)));
        // Why the day is off (weekly off or holiday): one settings and one holiday read for every section.
        const [calSettings, holidays] = await Promise.all([
            this.calendar.settings(c.tenantId),
            this.calendar.activeHolidays(c.tenantId, date, date),
        ]);
        const offFor = (who) => {
            const off = dayOff(calSettings, holidays, date, who);
            return off ? { reason: off.reason, name: off.name } : null;
        };
        const schoolDayOff = offFor({ kind: 'students' });
        const totals = {
            sections: 0,
            not_started: 0,
            draft: 0,
            submitted: 0,
            final: 0,
            roster_size: 0,
            marked: 0,
            counts: emptyCounts(),
        };
        if (!year)
            return { date, day_off: schoolDayOff, academic_year: null, totals, sections: [] };
        const conds = [
            sql `sec.tenant_id = ${c.tenantId}`,
            sql `sec.academic_year_id = ${year.id}`,
            sql `sec.status = 'ACTIVE'`,
        ];
        const scope = placementScope(c.principal, 'attendance.read', {
            section: sql `sec.id`,
            klass: sql `sec.class_id`,
        });
        if (scope)
            conds.push(scope);
        const data = await rows(this.db, sql `select sec.id as section_id, sec.code as sec_code, sec.name as sec_name,
        cl.id as class_id, cl.code as cl_code, cl.name as cl_name,
        s.id as session_id, s.status as session_status,
        count(r.id) as marked,
        coalesce(sum(st.category = 'PRESENT'), 0) as c_present,
        coalesce(sum(st.category = 'ABSENT'), 0) as c_absent,
        coalesce(sum(st.category = 'LATE'), 0) as c_late,
        coalesce(sum(st.category = 'HALF_DAY'), 0) as c_half_day,
        coalesce(sum(st.category = 'EXCUSED'), 0) as c_excused,
        coalesce(sum(st.category = 'LEAVE'), 0) as c_leave,
        coalesce(sum(st.category = 'OTHER'), 0) as c_other
      from academic_sections sec
      join academic_classes cl on cl.tenant_id = sec.tenant_id and cl.id = sec.class_id
      left join attendance_sessions s on s.tenant_id = sec.tenant_id and s.section_id = sec.id
        and s.attendance_type = 'DAILY' and s.session_date = ${date}
      left join attendance_records r on r.tenant_id = s.tenant_id and r.session_id = s.id
      left join attendance_statuses st on st.tenant_id = r.tenant_id and st.id = r.status_id
      where ${sql.join(conds, sql ` and `)}
      group by sec.id, sec.code, sec.name, cl.id, cl.code, cl.name, cl.sequence, s.id, s.status
      order by cl.sequence, cl.name, sec.name`);
        const sizes = await rows(this.db, sql `select e.section_id, count(distinct e.student_id) as n
        from enrollments e
        where e.tenant_id = ${c.tenantId} and e.academic_year_id = ${year.id}
          and e.status in (${sql.join(ROSTER_ENROLLMENT_STATUSES.map((x) => sql `${x}`), sql `, `)})
          and e.start_date <= ${date} and (e.end_date is null or e.end_date > ${date})
        group by e.section_id`);
        const sizeOf = new Map(sizes.map((s) => [s.section_id, num(s.n)]));
        const teacherOf = await this.classTeachers(c.tenantId);
        const lastMark = await this.lastMarks(c.tenantId, data.map((r) => r.session_id).filter((id) => !!id));
        const sections = data.map((r) => {
            const state = (r.session_id ? r.session_status : 'NOT_STARTED');
            const marked = num(r.marked);
            const counts = {
                present: num(r.c_present),
                absent: num(r.c_absent),
                late: num(r.c_late),
                half_day: num(r.c_half_day),
                excused: num(r.c_excused),
                leave: num(r.c_leave),
                other: num(r.c_other),
            };
            const rosterSize = state === 'SUBMITTED' || state === 'FINAL'
                ? marked
                : (sizeOf.get(String(r.section_id)) ?? 0);
            totals.sections++;
            totals[state.toLowerCase()]++;
            totals.roster_size += rosterSize;
            totals.marked += marked;
            for (const k of Object.keys(counts))
                totals.counts[k] += counts[k];
            return {
                section: { id: r.section_id, code: r.sec_code, name: r.sec_name },
                class: { id: r.class_id, code: r.cl_code, name: r.cl_name },
                session_id: r.session_id ?? null,
                state,
                roster_size: rosterSize,
                marked_count: marked,
                counts,
                day_off: offFor({
                    kind: 'class',
                    classId: String(r.class_id),
                    sectionId: String(r.section_id),
                }),
                class_teacher: teacherOf.get(String(r.section_id)) ?? null,
                last_marked_by: lastMark.get(String(r.session_id))?.by ?? null,
                last_marked_at: lastMark.get(String(r.session_id))?.at ?? null,
            };
        });
        return {
            date,
            day_off: schoolDayOff,
            academic_year: { id: year.id, code: year.code },
            totals,
            sections,
        };
    }
    /** The active class teacher of each section: section id -> {id, name}. */
    async classTeachers(tenantId) {
        const list = await rows(this.db, sql `select ct.section_id, t.id, t.first_name as first, t.last_name as last
        from section_class_teachers ct
        join teachers t on t.tenant_id = ct.tenant_id and t.id = ct.teacher_id
        where ct.tenant_id = ${tenantId} and ct.status = 'ACTIVE'`);
        return new Map(list.map((t) => [t.section_id, { id: t.id, name: `${t.first} ${t.last ?? ''}`.trim() }]));
    }
    /**
     * Who saved the latest mark of each register, and when: session id -> {by, at}.
     * `by` is null when the user no longer exists.
     */
    async lastMarks(tenantId, sessionIds) {
        const out = new Map();
        if (sessionIds.length === 0)
            return out;
        const ids = sql.join(sessionIds.map((id) => sql `${id}`), sql `, `);
        const list = await rows(this.db, sql `select r.session_id, r.marked_by, r.marked_at, u.first_name as first, u.last_name as last
        from attendance_records r
        join (select session_id, max(marked_at) as m from attendance_records
          where tenant_id = ${tenantId} and session_id in (${ids}) group by session_id) x
          on x.session_id = r.session_id and x.m = r.marked_at
        left join users u on u.id = r.marked_by
        where r.tenant_id = ${tenantId}`);
        for (const r of list) {
            const id = String(r.session_id);
            if (out.has(id))
                continue;
            const at = r.marked_at instanceof Date ? r.marked_at : new Date(`${String(r.marked_at)}Z`);
            out.set(id, {
                by: r.first
                    ? { id: String(r.marked_by), name: `${String(r.first)} ${String(r.last ?? '')}`.trim() }
                    : null,
                at: at.toISOString(),
            });
        }
        return out;
    }
    // ---- register / monthly (shared matrix) ------------------------------------------
    async matrix(c, sectionId, from, to) {
        const sec = await this.sectionFor(c, sectionId);
        const sessions = await rows(this.db, sql `select s.id, date_format(s.session_date, '%Y-%m-%d') as date, s.status
        from attendance_sessions s
        where s.tenant_id = ${c.tenantId} and s.section_id = ${sec.sec.id}
          and s.attendance_type = 'DAILY' and s.session_date between ${from} and ${to}
        order by s.session_date`);
        const recs = await rows(this.db, sql `select r.id as record_id, r.student_id, date_format(s.session_date, '%Y-%m-%d') as date,
        s.status as session_status, st.id as status_id, st.code as status_code, st.category,
        r.present_weight, r.absent_weight, r.remarks,
        stu.student_number, stu.first_name, stu.middle_name, stu.last_name
      from attendance_records r
      join attendance_sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
      join attendance_statuses st on st.tenant_id = r.tenant_id and st.id = r.status_id
      join students stu on stu.tenant_id = r.tenant_id and stu.id = r.student_id
      where r.tenant_id = ${c.tenantId} and s.section_id = ${sec.sec.id}
        and s.attendance_type = 'DAILY' and s.session_date between ${from} and ${to}`);
        const eligible = await this.sessions.eligible(this.db, {
            tenantId: c.tenantId,
            sectionId: sec.sec.id,
            academicYearId: sec.sec.academicYearId,
            sessionDate: to,
        }, false);
        const byStudent = new Map();
        const ensure = (id, n) => {
            let s = byStudent.get(id);
            if (!s) {
                s = {
                    student: {
                        id,
                        student_number: n.number,
                        full_name: fullName({ firstName: n.first, middleName: n.middle, lastName: n.last }),
                        last: n.last,
                        first: n.first,
                    },
                    cells: {},
                    marked: 0,
                    present_units: 0,
                    absent_units: 0,
                    counts: emptyCounts(),
                };
                byStudent.set(id, s);
            }
            return s;
        };
        for (const e of eligible)
            ensure(e.studentId, {
                number: e.studentNumber,
                first: e.firstName,
                middle: e.middleName,
                last: e.lastName,
            });
        for (const r of recs) {
            const s = ensure(String(r.student_id), {
                number: String(r.student_number),
                first: String(r.first_name),
                middle: r.middle_name ?? null,
                last: String(r.last_name),
            });
            s.cells[String(r.date)] = {
                record_id: String(r.record_id),
                status_id: String(r.status_id),
                status_code: String(r.status_code),
                category: String(r.category),
                remarks: r.remarks ?? null,
                session_status: String(r.session_status),
            };
            if (r.session_status === 'FINAL') {
                s.marked++;
                s.present_units += num(r.present_weight);
                s.absent_units += num(r.absent_weight);
                s.counts[String(r.category).toLowerCase()]++;
            }
        }
        const students = [...byStudent.values()].sort((a, b) => a.student.last.localeCompare(b.student.last) ||
            a.student.first.localeCompare(b.student.first) ||
            a.student.id.localeCompare(b.student.id));
        return { sec, sessions, recs, students };
    }
    studentRow(s) {
        return {
            student: {
                id: s.student.id,
                student_number: s.student.student_number,
                full_name: s.student.full_name,
            },
            marked_count: s.marked,
            present_units: round2(s.present_units),
            absent_units: round2(s.absent_units),
            percentage: percentage(s.present_units, s.marked),
            counts: s.counts,
        };
    }
    checkRange(from, to, max) {
        if (from > to)
            throw this.badRange('date_from', 'date_from must not be after date_to');
        if (daysBetween(from, to) + 1 > max)
            throw this.badRange('date_to', `The range cannot exceed ${max} days`);
    }
    /** Student × date matrix for one section. Cells show every session; the summary counts FINAL ones only. */
    async register(c, q) {
        await this.config.ensureDefaults(c.tenantId);
        this.checkRange(q.date_from, q.date_to, MAX_REGISTER_DAYS);
        const m = await this.matrix(c, q.section_id, q.date_from, q.date_to);
        return {
            section: { id: m.sec.sec.id, code: m.sec.sec.code, name: m.sec.sec.name },
            class: { id: m.sec.sec.classId, code: m.sec.classCode, name: m.sec.className },
            academic_year: { id: m.sec.sec.academicYearId, code: m.sec.yearCode },
            date_from: q.date_from,
            date_to: q.date_to,
            dates: m.sessions.map((s) => ({ date: s.date, session_id: s.id, session_status: s.status })),
            students: m.students.map((s) => ({ ...this.studentRow(s), cells: s.cells })),
        };
    }
    async monthly(c, q) {
        await this.config.ensureDefaults(c.tenantId);
        const { from, to } = monthRange(q.month);
        const m = await this.matrix(c, q.section_id, from, to);
        const days = m.sessions.map((s) => {
            const counts = emptyCounts();
            let marked = 0;
            let present = 0;
            for (const r of m.recs) {
                if (String(r.date) !== s.date)
                    continue;
                marked++;
                present += num(r.present_weight);
                counts[String(r.category).toLowerCase()]++;
            }
            return {
                date: s.date,
                session_id: s.id,
                session_status: s.status,
                marked_count: marked,
                present_units: round2(present),
                counts,
            };
        });
        const final = m.sessions.filter((s) => s.status === 'FINAL');
        let marked = 0;
        let present = 0;
        let absent = 0;
        for (const s of m.students) {
            marked += s.marked;
            present += s.present_units;
            absent += s.absent_units;
        }
        return {
            section: { id: m.sec.sec.id, code: m.sec.sec.code, name: m.sec.sec.name },
            class: { id: m.sec.sec.classId, code: m.sec.classCode, name: m.sec.className },
            month: q.month,
            date_from: from,
            date_to: to,
            days,
            students: m.students.map((s) => this.studentRow(s)),
            summary: {
                sessions_held: final.length,
                sessions_open: m.sessions.length - final.length,
                marked_count: marked,
                present_units: round2(present),
                absent_units: round2(absent),
                percentage: percentage(present, marked),
            },
        };
    }
    /**
     * The month as a simple grid: every student × every day of the month. A day is a
     * holiday or weekly off for the class (HOLIDAY / OFF), the student's mark on that
     * day's register (PRESENT, LATE, HALF_DAY, ABSENT, LEAVE — excused counts as leave —
     * or OTHER), UPCOMING, or NOT_MARKED (a past school day with no mark for them).
     * Day counts come from every register; the percentage uses final registers only,
     * the one definition every report shares.
     */
    async monthGrid(c, q) {
        await this.config.ensureDefaults(c.tenantId);
        const { from, to } = monthRange(q.month);
        const m = await this.matrix(c, q.section_id, from, to);
        const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
        const cal = await this.calendar.workingDays(c.tenantId, from, to, {
            kind: 'class',
            classId: m.sec.sec.classId,
            sectionId: m.sec.sec.id,
        });
        const offOn = new Map(cal.off_days.map((d) => [d.date, d]));
        const sessionOn = new Map(m.sessions.map((s) => [s.date, s]));
        const dates = [];
        for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000)
            dates.push(new Date(t).toISOString().slice(0, 10));
        const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const STATE = {
            PRESENT: 'PRESENT',
            LATE: 'LATE',
            HALF_DAY: 'HALF_DAY',
            ABSENT: 'ABSENT',
            EXCUSED: 'LEAVE',
            LEAVE: 'LEAVE',
            OTHER: 'OTHER',
        };
        const students = m.students.map((s) => {
            const counts = {
                present: 0,
                late: 0,
                half_day: 0,
                absent: 0,
                leave: 0,
                other: 0,
                not_marked: 0,
            };
            let schoolDays = 0;
            const days = dates.map((date) => {
                const off = offOn.get(date);
                if (off)
                    return {
                        date,
                        state: off.reason === 'HOLIDAY' ? 'HOLIDAY' : 'OFF',
                        status_code: null,
                        remarks: null,
                        final: false,
                    };
                if (date <= today)
                    schoolDays++;
                const cell = s.cells[date];
                if (cell) {
                    const state = STATE[cell.category] ?? 'OTHER';
                    const key = state.toLowerCase();
                    counts[key]++;
                    return {
                        date,
                        state,
                        status_code: cell.status_code,
                        remarks: cell.remarks,
                        final: cell.session_status === 'FINAL',
                    };
                }
                if (date > today)
                    return { date, state: 'UPCOMING', status_code: null, remarks: null, final: false };
                counts.not_marked++;
                return { date, state: 'NOT_MARKED', status_code: null, remarks: null, final: false };
            });
            return {
                student: {
                    id: s.student.id,
                    student_number: s.student.student_number,
                    full_name: s.student.full_name,
                },
                days,
                summary: {
                    school_days: schoolDays,
                    ...counts,
                    present_units: round2(s.present_units),
                    marked_count: s.marked,
                    percentage: percentage(s.present_units, s.marked),
                },
            };
        });
        let marked = 0;
        let present = 0;
        let absences = 0;
        let notMarked = 0;
        for (const s of students) {
            marked += s.summary.marked_count;
            present += s.summary.present_units;
            absences += s.summary.absent;
            notMarked += s.summary.not_marked;
        }
        const schoolDays = dates.filter((d) => !offOn.has(d) && d <= today).length;
        return {
            section: { id: m.sec.sec.id, code: m.sec.sec.code, name: m.sec.sec.name },
            class: { id: m.sec.sec.classId, code: m.sec.classCode, name: m.sec.className },
            month: q.month,
            date_from: from,
            date_to: to,
            today,
            partial: to > today,
            days: dates.map((date) => {
                const off = offOn.get(date);
                const sess = sessionOn.get(date);
                return {
                    date,
                    weekday: WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()],
                    off: off ? { reason: off.reason, name: off.name } : null,
                    future: date > today,
                    session_id: sess?.id ?? null,
                    session_status: sess?.status ?? null,
                };
            }),
            students,
            totals: {
                students: students.length,
                school_days: schoolDays,
                registers_taken: m.sessions.filter((s) => !offOn.has(s.date)).length,
                absences,
                not_marked: notMarked,
                percentage: percentage(present, marked),
            },
        };
    }
    // ---- student history ---------------------------------------------------------------
    /** Needs students.read (scope decides who) and attendance.read (scope narrows the sessions). */
    async studentHistory(c, studentId, q) {
        await this.config.ensureDefaults(c.tenantId);
        const student = await loadStudent(this.db, c.tenantId, studentId, c.principal, 'students.read');
        const today = await schoolToday(this.db, c.tenantId, this.deps.clock);
        let from = q.from;
        let to = q.to;
        let yearId = q.academic_year_id ?? null;
        if (!from && !to) {
            const [y] = yearId
                ? await this.db
                    .select()
                    .from(academicYears)
                    .where(and(eq(academicYears.id, yearId), eq(academicYears.tenantId, c.tenantId)))
                : await this.db
                    .select()
                    .from(academicYears)
                    .where(and(eq(academicYears.tenantId, c.tenantId), eq(academicYears.isCurrent, true)));
            if (yearId && !y)
                throw new NotFoundError('Academic year');
            yearId = y?.id ?? null;
            from = y?.startDate ?? addDaysIso(today, -365);
            to = y?.endDate ?? today;
        }
        from ??= addDaysIso(to, -365);
        to ??= today;
        if (from > to)
            throw this.badRange('from', 'from must not be after to');
        if (daysBetween(from, to) + 1 > MAX_HISTORY_DAYS)
            throw this.badRange('to', `The range cannot exceed ${MAX_HISTORY_DAYS} days`);
        const conds = [
            sql `r.tenant_id = ${c.tenantId}`,
            sql `r.student_id = ${student.id}`,
            sql `s.attendance_type = 'DAILY'`,
            sql `s.status = 'FINAL'`,
            sql `s.session_date between ${from} and ${to}`,
        ];
        const scope = placementScope(c.principal, 'attendance.read', {
            section: sql `s.section_id`,
            klass: sql `s.class_id`,
        });
        if (scope)
            conds.push(scope);
        const recs = await rows(this.db, sql `select r.id as record_id, s.id as session_id, date_format(s.session_date, '%Y-%m-%d') as date,
        s.section_id, sec.name as sec_name, cl.name as cl_name,
        st.id as status_id, st.code as status_code, st.name as status_name, st.category,
        r.present_weight, r.absent_weight, r.remarks
      from attendance_records r
      join attendance_sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
      join attendance_statuses st on st.tenant_id = r.tenant_id and st.id = r.status_id
      join academic_sections sec on sec.tenant_id = s.tenant_id and sec.id = s.section_id
      join academic_classes cl on cl.tenant_id = s.tenant_id and cl.id = s.class_id
      where ${sql.join(conds, sql ` and `)}
      order by s.session_date asc`);
        let present = 0;
        let absent = 0;
        const counts = emptyCounts();
        const byStatus = new Map();
        for (const r of recs) {
            present += num(r.present_weight);
            absent += num(r.absent_weight);
            counts[String(r.category).toLowerCase()]++;
            const k = String(r.status_code);
            const e = byStatus.get(k) ?? {
                code: k,
                name: String(r.status_name),
                category: String(r.category),
                count: 0,
            };
            e.count++;
            byStatus.set(k, e);
        }
        return {
            student: {
                id: student.id,
                student_number: student.studentNumber,
                full_name: fullName(student),
            },
            period: { from, to, academic_year_id: yearId },
            summary: {
                marked_count: recs.length,
                present_units: round2(present),
                absent_units: round2(absent),
                percentage: percentage(present, recs.length),
                counts,
                by_status: [...byStatus.values()],
            },
            records: recs.map((r) => ({
                record_id: r.record_id,
                session_id: r.session_id,
                session_date: r.date,
                class: { name: r.cl_name },
                section: { id: r.section_id, name: r.sec_name },
                status: {
                    id: r.status_id,
                    code: r.status_code,
                    name: r.status_name,
                    category: r.category,
                },
                present_weight: num(r.present_weight),
                remarks: r.remarks ?? null,
            })),
        };
    }
    // ---- defaulters --------------------------------------------------------------------
    async defaulterQuery(c, q, page) {
        await this.config.ensureDefaults(c.tenantId);
        const settings = await readSettings(this.db, c.tenantId);
        const threshold = q.threshold ?? Number(settings.defaulterThresholdPercent);
        let yearId = q.academic_year_id;
        let yearStart;
        let yearEnd;
        if (yearId) {
            const [y] = await this.db
                .select()
                .from(academicYears)
                .where(and(eq(academicYears.id, yearId), eq(academicYears.tenantId, c.tenantId)));
            if (!y)
                throw new NotFoundError('Academic year');
            yearStart = y.startDate;
            yearEnd = y.endDate;
        }
        else {
            const [y] = await this.db
                .select()
                .from(academicYears)
                .where(and(eq(academicYears.tenantId, c.tenantId), eq(academicYears.isCurrent, true)));
            yearId = y?.id;
            yearStart = y?.startDate;
            yearEnd = y?.endDate;
        }
        const empty = { data: [], total: 0, threshold, from: null, to: null, yearId: yearId ?? null };
        if (!yearId)
            return empty;
        const from = q.from ?? yearStart;
        const to = q.to ?? yearEnd;
        if (from > to)
            throw this.badRange('from', 'from must not be after to');
        const conds = [
            sql `r.tenant_id = ${c.tenantId}`,
            sql `s.attendance_type = 'DAILY'`,
            sql `s.status = 'FINAL'`,
            sql `s.academic_year_id = ${yearId}`,
            sql `s.session_date between ${from} and ${to}`,
        ];
        if (q.class_id)
            conds.push(sql `s.class_id = ${q.class_id}`);
        if (q.section_id)
            conds.push(sql `s.section_id = ${q.section_id}`);
        const scope = placementScope(c.principal, 'attendance.read', {
            section: sql `s.section_id`,
            klass: sql `s.class_id`,
        });
        if (scope)
            conds.push(scope);
        const filter = sql.join(conds, sql ` and `);
        const agg = sql `select r.student_id, count(*) as marked, sum(r.present_weight) as present_units,
        sum(r.absent_weight) as absent_units
      from attendance_records r
      join attendance_sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
      where ${filter}
      group by r.student_id
      having sum(r.present_weight) / count(*) * 100 < ${threshold}`;
        const [total] = await rows(this.db, sql `select count(*) as n from (${agg}) x`);
        const data = await rows(this.db, sql `with agg as (${agg}),
        last_sec as (
          select r.student_id, s.section_id, s.class_id,
            row_number() over (partition by r.student_id order by s.session_date desc, s.id desc) as rn
          from attendance_records r
          join attendance_sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
          where ${filter} and r.student_id in (select student_id from agg)
        )
        select a.student_id, a.marked, a.present_units, a.absent_units,
          stu.student_number, stu.first_name, stu.middle_name, stu.last_name,
          ls.section_id, sec.name as sec_name, ls.class_id, cl.name as cl_name
        from agg a
        join students stu on stu.tenant_id = ${c.tenantId} and stu.id = a.student_id
        left join last_sec ls on ls.student_id = a.student_id and ls.rn = 1
        left join academic_sections sec on sec.tenant_id = ${c.tenantId} and sec.id = ls.section_id
        left join academic_classes cl on cl.tenant_id = ${c.tenantId} and cl.id = ls.class_id
        order by (a.present_units / a.marked) asc, stu.last_name asc, stu.first_name asc, a.student_id asc
        limit ${page.limit} offset ${page.offset}`);
        return {
            data: data.map((r) => ({
                student: {
                    id: r.student_id,
                    student_number: r.student_number,
                    full_name: fullName({
                        firstName: String(r.first_name),
                        middleName: r.middle_name ?? null,
                        lastName: String(r.last_name),
                    }),
                },
                class: r.class_id ? { id: r.class_id, name: r.cl_name } : null,
                section: r.section_id ? { id: r.section_id, name: r.sec_name } : null,
                marked_count: num(r.marked),
                present_units: round2(num(r.present_units)),
                absent_units: round2(num(r.absent_units)),
                percentage: percentage(num(r.present_units), num(r.marked)),
            })),
            total: num(total?.n),
            threshold,
            from,
            to,
            yearId,
        };
    }
    async defaulters(c, q) {
        const r = await this.defaulterQuery(c, q, { limit: q.page_size, offset: offsetOf(q) });
        return {
            data: r.data,
            meta: {
                page: q.page,
                page_size: q.page_size,
                total: r.total,
                threshold_percent: r.threshold,
                academic_year_id: r.yearId,
                from: r.from,
                to: r.to,
            },
        };
    }
    // ---- CSV exports (audited) ------------------------------------------------------------
    async audited(c, report, rowsCount, filters) {
        await this.db.transaction(async (tx) => {
            await recordChange(tx, c.actor, c.tenantId, {
                action: 'ATTENDANCE_EXPORTED',
                entityType: 'attendance_export',
                entityId: c.tenantId,
                event: 'attendance.exported',
                payload: { report, rows: rowsCount, filters },
            });
        });
    }
    async exportRegister(c, q) {
        const r = await this.register(c, q);
        const dates = r.dates.map((d) => d.date);
        const lines = [
            csvLine([
                'Student number',
                'Student',
                ...dates,
                'Marked days',
                'Present units',
                'Absent units',
                'Attendance %',
            ]),
        ];
        for (const s of r.students)
            lines.push(csvLine([
                s.student.student_number,
                s.student.full_name,
                ...dates.map((d) => s.cells[d]?.status_code ?? ''),
                s.marked_count,
                s.present_units,
                s.absent_units,
                s.percentage,
            ]));
        await this.audited(c, 'register', r.students.length, q);
        return lines.join('\n') + '\n';
    }
    async exportMonthly(c, q) {
        const r = await this.monthly(c, q);
        const lines = [
            csvLine([
                'Student number',
                'Student',
                'Marked days',
                'Present units',
                'Absent units',
                'Late',
                'Attendance %',
            ]),
        ];
        for (const s of r.students)
            lines.push(csvLine([
                s.student.student_number,
                s.student.full_name,
                s.marked_count,
                s.present_units,
                s.absent_units,
                s.counts.late,
                s.percentage,
            ]));
        await this.audited(c, 'monthly', r.students.length, q);
        return lines.join('\n') + '\n';
    }
    async exportDefaulters(c, q) {
        const r = await this.defaulterQuery(c, q, { limit: MAX_CSV_ROWS, offset: 0 });
        const lines = [
            csvLine([
                'Student number',
                'Student',
                'Class',
                'Section',
                'Marked days',
                'Present units',
                'Absent units',
                'Attendance %',
            ]),
        ];
        for (const s of r.data)
            lines.push(csvLine([
                s.student.student_number,
                s.student.full_name,
                s.class?.name,
                s.section?.name,
                s.marked_count,
                s.present_units,
                s.absent_units,
                s.percentage,
            ]));
        await this.audited(c, 'defaulters', r.data.length, {
            ...q,
            page: undefined,
            page_size: undefined,
            threshold: r.threshold,
        });
        return lines.join('\n') + '\n';
    }
}
