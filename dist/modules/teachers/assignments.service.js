import { and, asc, count, desc, eq, like, or, sql } from 'drizzle-orm';
import { academicClasses, academicSections, academicYears, subjectOfferings, subjects, teachers, teachingAssignments, } from '../../db/schema/index.js';
import { recordChange } from '../../platform/record.js';
import { todayIso } from '../../shared/dates.js';
import { BusinessRuleError, ConflictError, isDuplicateKeyError, NotFoundError, } from '../../shared/errors.js';
import { offsetOf, orderFrom, pageOf } from '../../shared/pagination.js';
import { likeOf } from '../students/support.js';
import { addTeacherHistory, fullName, loadTeacher, refreshTeacherAccess, teacherScope, } from './support.js';
/** Everything the response needs, in one row: the assignment plus its offering context and teacher. */
const selection = {
    a: teachingAssignments,
    t: {
        id: teachers.id,
        teacherNumber: teachers.teacherNumber,
        firstName: teachers.firstName,
        middleName: teachers.middleName,
        lastName: teachers.lastName,
    },
    year: { id: academicYears.id, code: academicYears.code },
    klass: { id: academicClasses.id, code: academicClasses.code, name: academicClasses.name },
    section: { id: academicSections.id, code: academicSections.code, name: academicSections.name },
    subject: { id: subjects.id, code: subjects.code, name: subjects.name },
};
function present(r) {
    return {
        id: r.a.id,
        teacher: {
            id: r.t.id,
            teacher_number: r.t.teacherNumber,
            full_name: fullName(r.t),
        },
        subject_offering_id: r.a.subjectOfferingId,
        academic_year: r.year,
        class: r.klass,
        section: r.section ? { id: r.section.id, code: r.section.code, name: r.section.name } : null,
        subject: r.subject,
        role: r.a.role,
        status: r.a.status,
        start_date: r.a.startDate,
        end_date: r.a.endDate,
        reason: r.a.reason,
        version: r.a.version,
        created_at: r.a.createdAt.toISOString(),
        updated_at: r.a.updatedAt.toISOString(),
    };
}
export class AssignmentService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    get db() {
        return this.deps.db;
    }
    /** assignment ⋈ teacher ⋈ offering ⋈ year/class/subject ⟕ section, ready for `.where()`. */
    joined(ex) {
        return ex
            .select(selection)
            .from(teachingAssignments)
            .innerJoin(teachers, and(eq(teachers.tenantId, teachingAssignments.tenantId), eq(teachers.id, teachingAssignments.teacherId)))
            .innerJoin(subjectOfferings, and(eq(subjectOfferings.tenantId, teachingAssignments.tenantId), eq(subjectOfferings.id, teachingAssignments.subjectOfferingId)))
            .innerJoin(academicYears, eq(academicYears.id, subjectOfferings.academicYearId))
            .innerJoin(academicClasses, eq(academicClasses.id, subjectOfferings.classId))
            .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
            .leftJoin(academicSections, eq(academicSections.id, subjectOfferings.sectionId));
    }
    async fetch(ex, where) {
        return (await this.joined(ex)
            .where(where)
            .orderBy(desc(teachingAssignments.startDate), asc(subjects.name), desc(teachingAssignments.id)));
    }
    // ---- reads ---------------------------------------------------------------------
    async list(tenantId, q, principal) {
        const conds = [
            eq(teachingAssignments.tenantId, tenantId),
            teacherScope(principal, 'teachers.read'),
        ];
        if (q.teacher_id)
            conds.push(eq(teachingAssignments.teacherId, q.teacher_id));
        if (q.subject_offering_id)
            conds.push(eq(teachingAssignments.subjectOfferingId, q.subject_offering_id));
        if (q.academic_year_id)
            conds.push(eq(subjectOfferings.academicYearId, q.academic_year_id));
        if (q.class_id)
            conds.push(eq(subjectOfferings.classId, q.class_id));
        if (q.section_id)
            conds.push(eq(subjectOfferings.sectionId, q.section_id));
        if (q.status)
            conds.push(eq(teachingAssignments.status, q.status));
        if (q.search) {
            const s = likeOf(q.search);
            conds.push(or(like(teachers.teacherNumber, s), like(teachers.firstName, s), like(teachers.lastName, s), sql `concat(${teachers.firstName}, ' ', ${teachers.lastName}) like ${s}`, like(subjects.name, s), like(subjects.code, s)));
        }
        const where = and(...conds);
        const [rows, [total]] = await Promise.all([
            this.joined(this.db)
                .where(where)
                .orderBy(orderFrom({ ...q, order: q.sort ? q.order : 'desc' }, {
                start_date: teachingAssignments.startDate,
                end_date: teachingAssignments.endDate,
                status: teachingAssignments.status,
                created_at: teachingAssignments.createdAt,
                teacher: teachers.lastName,
                subject: subjects.name,
            }, 'start_date'), desc(teachingAssignments.id))
                .limit(q.page_size)
                .offset(offsetOf(q)),
            this.db
                .select({ n: count() })
                .from(teachingAssignments)
                .innerJoin(teachers, and(eq(teachers.tenantId, teachingAssignments.tenantId), eq(teachers.id, teachingAssignments.teacherId)))
                .innerJoin(subjectOfferings, and(eq(subjectOfferings.tenantId, teachingAssignments.tenantId), eq(subjectOfferings.id, teachingAssignments.subjectOfferingId)))
                .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
                .where(where),
        ]);
        return pageOf(rows.map(present), total?.n ?? 0, q);
    }
    /** Assignments of one teacher (404 if the teacher is not in this school). */
    async listForTeacher(tenantId, teacherId, q, principal) {
        await loadTeacher(this.db, tenantId, teacherId, principal, 'teachers.read');
        return this.list(tenantId, { ...q, teacher_id: teacherId }, principal);
    }
    async get(tenantId, id, principal, ex = this.db) {
        const [row] = await this.fetch(ex, and(eq(teachingAssignments.id, id), eq(teachingAssignments.tenantId, tenantId), teacherScope(principal, 'teachers.read')));
        if (!row)
            throw new NotFoundError('Teaching assignment');
        return present(row);
    }
    /** Open (ACTIVE) assignments of a teacher for the profile page. */
    async activeForTeacher(tenantId, teacherId, ex = this.db) {
        const rows = await this.fetch(ex, and(eq(teachingAssignments.tenantId, tenantId), eq(teachingAssignments.teacherId, teacherId), eq(teachingAssignments.status, 'ACTIVE')));
        return rows.map(present);
    }
    /** Number of open assignments per teacher, for list pages. */
    async activeCounts(tenantId, teacherIds, ex = this.db) {
        const out = new Map();
        if (!teacherIds.length)
            return out;
        const rows = await ex
            .select({ teacherId: teachingAssignments.teacherId, n: count() })
            .from(teachingAssignments)
            .where(and(eq(teachingAssignments.tenantId, tenantId), sql `${teachingAssignments.teacherId} in (${sql.join(teacherIds.map((i) => sql `${i}`), sql `, `)})`, eq(teachingAssignments.status, 'ACTIVE')))
            .groupBy(teachingAssignments.teacherId);
        for (const r of rows)
            out.set(r.teacherId, r.n);
        return out;
    }
    /** Distinct subject names each teacher teaches now (active assignments), sorted. */
    async activeSubjectNames(tenantId, teacherIds, ex = this.db) {
        const out = new Map();
        if (!teacherIds.length)
            return out;
        const rows = await ex
            .selectDistinct({ teacherId: teachingAssignments.teacherId, name: subjects.name })
            .from(teachingAssignments)
            .innerJoin(subjectOfferings, eq(subjectOfferings.id, teachingAssignments.subjectOfferingId))
            .innerJoin(subjects, eq(subjects.id, subjectOfferings.subjectId))
            .where(and(eq(teachingAssignments.tenantId, tenantId), sql `${teachingAssignments.teacherId} in (${sql.join(teacherIds.map((i) => sql `${i}`), sql `, `)})`, eq(teachingAssignments.status, 'ACTIVE')))
            .orderBy(asc(subjects.name));
        for (const r of rows)
            out.set(r.teacherId, [...(out.get(r.teacherId) ?? []), r.name]);
        return out;
    }
    // ---- create ----------------------------------------------------------------------
    async create(tenantId, teacherId, input, principal, actor) {
        const id = await this.db.transaction(async (tx) => {
            // Lock order: teacher → offering (share) → new row. Serialises with lifecycle commands.
            const teacher = await loadTeacher(tx, tenantId, teacherId, principal, 'teachers.assignments.manage', { lock: true });
            if (teacher.status !== 'ACTIVE')
                throw new BusinessRuleError('INVALID_STATE', 'Only active teachers can receive new teaching assignments', { teacher_status: teacher.status });
            const [offering] = await tx
                .select({
                o: subjectOfferings,
                yearStatus: academicYears.status,
                yearCode: academicYears.code,
            })
                .from(subjectOfferings)
                .innerJoin(academicYears, eq(academicYears.id, subjectOfferings.academicYearId))
                .where(and(eq(subjectOfferings.id, input.subject_offering_id), eq(subjectOfferings.tenantId, tenantId)))
                .for('share');
            if (!offering)
                throw new NotFoundError('Subject offering');
            if (offering.o.status !== 'ACTIVE')
                throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'The subject offering is inactive and cannot be assigned', { offering_status: offering.o.status });
            if (offering.yearStatus !== 'UPCOMING' && offering.yearStatus !== 'ACTIVE')
                throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'Teachers can only be assigned to offerings of an upcoming or active academic year', { academic_year_status: offering.yearStatus });
            const [dup] = await tx
                .select({ id: teachingAssignments.id })
                .from(teachingAssignments)
                .where(and(eq(teachingAssignments.tenantId, tenantId), eq(teachingAssignments.teacherId, teacherId), eq(teachingAssignments.subjectOfferingId, input.subject_offering_id), eq(teachingAssignments.status, 'ACTIVE')))
                .for('update');
            if (dup)
                throw this.duplicate(dup.id);
            const start = input.start_date ?? todayIso(this.deps.clock);
            let newId;
            try {
                const [ins] = await tx
                    .insert(teachingAssignments)
                    .values({
                    tenantId,
                    teacherId,
                    subjectOfferingId: input.subject_offering_id,
                    role: input.role,
                    status: 'ACTIVE',
                    startDate: start,
                    reason: input.reason ?? null,
                    createdBy: actor.userId,
                    updatedBy: actor.userId,
                })
                    .$returningId();
                newId = ins.id;
            }
            catch (err) {
                if (isDuplicateKeyError(err))
                    throw this.duplicate();
                throw err;
            }
            const view = await this.get(tenantId, newId, principal, tx);
            await addTeacherHistory(tx, actor, tenantId, teacherId, {
                eventType: 'TEACHING_ASSIGNED',
                effectiveDate: start,
                reason: input.reason ?? null,
                details: this.historyDetails(view),
            });
            await recordChange(tx, actor, tenantId, {
                action: 'TEACHING_ASSIGNMENT_CREATED',
                entityType: 'teaching_assignment',
                entityId: newId,
                event: 'teaching_assignment.created',
                after: view,
                payload: this.eventPayload(view),
            });
            return newId;
        });
        await refreshTeacherAccess(this.deps, tenantId);
        return this.get(tenantId, id, principal);
    }
    duplicate(existingId) {
        return new ConflictError('DUPLICATE_RESOURCE', 'This teacher already has an open assignment for that subject offering', existingId ? { assignment_id: existingId } : null);
    }
    historyDetails(v) {
        return {
            assignment_id: v.id,
            subject_offering_id: v.subject_offering_id,
            academic_year: v.academic_year.code,
            class: v.class.name,
            section: v.section?.name ?? null,
            subject: v.subject.name,
            role: v.role,
        };
    }
    eventPayload(v) {
        return {
            teacher_id: v.teacher.id,
            subject_offering_id: v.subject_offering_id,
            academic_year_id: v.academic_year.id,
            class_id: v.class.id,
            section_id: v.section?.id ?? null,
            subject_id: v.subject.id,
            role: v.role,
        };
    }
    // ---- end / cancel ---------------------------------------------------------------
    /** Lock the assignment and its teacher (404 across schools), same order as create. */
    async lockOpen(tx, tenantId, id, principal) {
        const [peek] = await tx
            .select({ teacherId: teachingAssignments.teacherId })
            .from(teachingAssignments)
            .where(and(eq(teachingAssignments.id, id), eq(teachingAssignments.tenantId, tenantId)));
        if (!peek)
            throw new NotFoundError('Teaching assignment');
        await loadTeacher(tx, tenantId, peek.teacherId, principal, 'teachers.assignments.manage', {
            lock: true,
        });
        const [row] = await tx
            .select()
            .from(teachingAssignments)
            .where(and(eq(teachingAssignments.id, id), eq(teachingAssignments.tenantId, tenantId)))
            .for('update');
        if (!row)
            throw new NotFoundError('Teaching assignment');
        if (row.status !== 'ACTIVE')
            throw new BusinessRuleError('INVALID_STATE', 'The assignment is already closed', {
                assignment_status: row.status,
            });
        return row;
    }
    /** End an assignment that has started: the historical record stays. */
    async end(tenantId, id, input, principal, actor) {
        await this.db.transaction(async (tx) => {
            const row = await this.lockOpen(tx, tenantId, id, principal);
            const today = todayIso(this.deps.clock);
            const end = input.end_date ?? today;
            if (row.startDate > today)
                throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'This assignment has not started yet. Cancel it instead.', { start_date: row.startDate });
            if (end < row.startDate)
                throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'The end date cannot be before the start date', { field: 'end_date', start_date: row.startDate });
            if (end > today)
                throw new BusinessRuleError('OPERATION_NOT_ALLOWED', 'The end date cannot be in the future', {
                    field: 'end_date',
                });
            await this.close(tx, actor, tenantId, row, 'ENDED', end, input.reason ?? null, principal);
        });
        await refreshTeacherAccess(this.deps, tenantId);
        return this.get(tenantId, id, principal);
    }
    /** Cancel an assignment entered by mistake or that never started. Reason required. */
    async cancel(tenantId, id, reason, principal, actor) {
        await this.db.transaction(async (tx) => {
            const row = await this.lockOpen(tx, tenantId, id, principal);
            const today = todayIso(this.deps.clock);
            await this.close(tx, actor, tenantId, row, 'CANCELLED', row.startDate > today ? row.startDate : today, reason, principal);
        });
        await refreshTeacherAccess(this.deps, tenantId);
        return this.get(tenantId, id, principal);
    }
    async close(tx, actor, tenantId, row, to, endDate, reason, principal) {
        await tx
            .update(teachingAssignments)
            .set({
            status: to,
            endDate,
            reason: reason ?? row.reason,
            version: row.version + 1,
            updatedBy: actor.userId,
        })
            .where(eq(teachingAssignments.id, row.id));
        const view = await this.get(tenantId, row.id, principal, tx);
        await this.recordClosed(tx, actor, tenantId, row, view, to, reason);
    }
    async recordClosed(tx, actor, tenantId, before, view, to, reason) {
        await addTeacherHistory(tx, actor, tenantId, before.teacherId, {
            eventType: to === 'ENDED' ? 'TEACHING_ASSIGNMENT_ENDED' : 'TEACHING_ASSIGNMENT_CANCELLED',
            effectiveDate: view.end_date,
            reason,
            details: this.historyDetails(view),
        });
        await recordChange(tx, actor, tenantId, {
            action: `TEACHING_ASSIGNMENT_${to}`,
            entityType: 'teaching_assignment',
            entityId: before.id,
            event: `teaching_assignment.${to.toLowerCase()}`,
            before: { status: before.status },
            after: { status: to, end_date: view.end_date },
            reason,
            payload: this.eventPayload(view),
        });
    }
    /**
     * Close every open assignment of a teacher who is leaving (caller holds the
     * teacher row lock). Assignments that have not started are cancelled; the
     * others end on `endDate`. Returns how many were closed.
     */
    async closeAllForTeacher(tx, actor, teacher, o) {
        const open = await tx
            .select()
            .from(teachingAssignments)
            .where(and(eq(teachingAssignments.tenantId, teacher.tenantId), eq(teachingAssignments.teacherId, teacher.id), eq(teachingAssignments.status, 'ACTIVE')))
            .for('update');
        for (const row of open) {
            const notStarted = row.startDate > o.today;
            const to = notStarted ? 'CANCELLED' : 'ENDED';
            const end = notStarted
                ? row.startDate
                : o.endDate < row.startDate
                    ? row.startDate
                    : o.endDate;
            const reason = o.reason ?? 'Teacher left the school';
            await tx
                .update(teachingAssignments)
                .set({
                status: to,
                endDate: end,
                reason,
                version: row.version + 1,
                updatedBy: actor.userId,
            })
                .where(eq(teachingAssignments.id, row.id));
            const [view] = await this.fetch(tx, eq(teachingAssignments.id, row.id));
            await this.recordClosed(tx, actor, teacher.tenantId, row, present(view), to, reason);
        }
        return open.length;
    }
}
