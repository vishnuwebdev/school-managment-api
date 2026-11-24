import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import { academicClasses, academicSections, classClassTeachers, enrollments, examPapers, examStudentRemarks, exams, sectionClassTeachers, students, teachers, users, } from '../../db/schema/index.js';
import { recordChange } from '../../platform/record.js';
import { AuthorizationError, NotFoundError, ValidationError } from '../../shared/errors.js';
import { hasTenantWideScope } from '../access/authorization.service.js';
import { sectionInScope } from '../attendance/support.js';
import { fullName } from '../teachers/support.js';
export const RemarkListQuery = z.object({
    class_id: z.uuid().optional(),
    section_id: z.uuid().optional(),
});
export const SaveRemarksBody = z.object({
    remarks: z
        .array(z.object({
        student_id: z.uuid(),
        /** Empty text removes the remark. */
        remark: z.string().trim().max(1000),
        share_with_parent: z.boolean().default(false),
    }))
        .min(1)
        .max(200),
});
/**
 * Report-card remarks (0045): one per student per exam, written by the class teacher in the
 * teacher app or by the office. Parents see a remark only when it is shared and the exam's
 * results are published.
 */
export class ExamRemarkService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    get db() {
        return this.deps.db;
    }
    async loadExam(tenantId, examId) {
        const [e] = await this.db
            .select()
            .from(exams)
            .where(and(eq(exams.tenantId, tenantId), eq(exams.id, examId)));
        if (!e)
            throw new NotFoundError('Exam');
        return e;
    }
    /** Sections and whole classes the teacher is class teacher of (live years). */
    async classTeacherOf(tenantId, teacherId) {
        const [secs, classes] = await Promise.all([
            this.db
                .select({ id: sectionClassTeachers.sectionId })
                .from(sectionClassTeachers)
                .where(and(eq(sectionClassTeachers.tenantId, tenantId), eq(sectionClassTeachers.teacherId, teacherId), eq(sectionClassTeachers.status, 'ACTIVE'))),
            this.db
                .select({ classId: classClassTeachers.classId, yearId: classClassTeachers.academicYearId })
                .from(classClassTeachers)
                .where(and(eq(classClassTeachers.tenantId, tenantId), eq(classClassTeachers.teacherId, teacherId), eq(classClassTeachers.status, 'ACTIVE'))),
        ]);
        return {
            sectionIds: new Set(secs.map((s) => s.id)),
            classKeys: new Set(classes.map((c) => `${c.classId}:${c.yearId}`)),
        };
    }
    /** Students who sit the exam (placed in its year), with their placement. */
    async roster(tenantId, exam, f) {
        const classIds = (await this.db
            .selectDistinct({ id: examPapers.classId })
            .from(examPapers)
            .where(and(eq(examPapers.tenantId, tenantId), eq(examPapers.examId, exam.id)))).map((r) => r.id);
        if (!classIds.length)
            return [];
        const rows = await this.db
            .select({
            studentId: students.id,
            firstName: students.firstName,
            middleName: students.middleName,
            lastName: students.lastName,
            admissionNumber: students.admissionNumber,
            studentNumber: students.studentNumber,
            classId: enrollments.classId,
            className: academicClasses.name,
            sectionId: enrollments.sectionId,
            sectionName: academicSections.name,
            rollNumber: enrollments.rollNumber,
        })
            .from(enrollments)
            .innerJoin(students, and(eq(students.tenantId, enrollments.tenantId), eq(students.id, enrollments.studentId)))
            .innerJoin(academicClasses, eq(academicClasses.id, enrollments.classId))
            .leftJoin(academicSections, eq(academicSections.id, enrollments.sectionId))
            .where(and(eq(enrollments.tenantId, tenantId), eq(enrollments.academicYearId, exam.academicYearId), ne(enrollments.status, 'CANCELLED'), inArray(enrollments.classId, f.classId ? [f.classId] : classIds), exam.sectionId ? eq(enrollments.sectionId, exam.sectionId) : undefined, f.sectionId ? eq(enrollments.sectionId, f.sectionId) : undefined, f.studentIds ? inArray(enrollments.studentId, f.studentIds) : undefined))
            .orderBy(asc(academicClasses.sequence), asc(academicSections.code), asc(students.firstName));
        // A student moved during the year has several enrollments: keep the last one.
        const byStudent = new Map();
        for (const r of rows)
            byStudent.set(r.studentId, r);
        return [...byStudent.values()].filter((r) => classIds.includes(r.classId));
    }
    assertMayWrite(who, r, yearId, mine) {
        const ok = who.kind === 'office'
            ? hasTenantWideScope(who.principal, 'exams.remarks.write') ||
                (r.sectionId !== null &&
                    sectionInScope(who.principal, 'exams.remarks.write', {
                        id: r.sectionId,
                        classId: r.classId,
                    }))
            : (r.sectionId !== null && mine.sectionIds.has(r.sectionId)) ||
                mine.classKeys.has(`${r.classId}:${yearId}`);
        if (!ok)
            throw new AuthorizationError('PERMISSION_DENIED', who.kind === 'teacher'
                ? 'Only the class teacher can write report-card remarks for this student'
                : 'You cannot write remarks for this student');
    }
    async list(tenantId, examId, q, who) {
        const exam = await this.loadExam(tenantId, examId);
        const mine = who.kind === 'teacher' ? await this.classTeacherOf(tenantId, who.teacherId) : undefined;
        let roster = await this.roster(tenantId, exam, {
            classId: q.class_id,
            sectionId: q.section_id,
        });
        if (who.kind === 'teacher')
            roster = roster.filter((r) => (r.sectionId !== null && mine.sectionIds.has(r.sectionId)) ||
                mine.classKeys.has(`${r.classId}:${exam.academicYearId}`));
        else if (!hasTenantWideScope(who.principal, 'exams.read'))
            roster = roster.filter((r) => r.sectionId !== null &&
                sectionInScope(who.principal, 'exams.read', { id: r.sectionId, classId: r.classId }));
        const ids = roster.map((r) => r.studentId);
        const remarks = ids.length
            ? await this.db
                .select()
                .from(examStudentRemarks)
                .where(and(eq(examStudentRemarks.tenantId, tenantId), eq(examStudentRemarks.examId, exam.id), inArray(examStudentRemarks.studentId, ids)))
            : [];
        const byStudent = new Map(remarks.map((r) => [r.studentId, r]));
        return {
            exam: { id: exam.id, name: exam.name, status: exam.status },
            data: roster.map((r) => {
                const rm = byStudent.get(r.studentId);
                return {
                    student_id: r.studentId,
                    full_name: fullName(r),
                    admission_number: r.admissionNumber ?? r.studentNumber,
                    roll_number: r.rollNumber,
                    class: { id: r.classId, name: r.className },
                    section: r.sectionId ? { id: r.sectionId, name: r.sectionName } : null,
                    remark: rm?.remark ?? null,
                    share_with_parent: rm?.shareWithParent ?? false,
                    version: rm?.version ?? null,
                    updated_at: rm?.updatedAt.toISOString() ?? null,
                };
            }),
        };
    }
    async save(tenantId, examId, input, who, actor) {
        const exam = await this.loadExam(tenantId, examId);
        const ids = [...new Set(input.remarks.map((r) => r.student_id))];
        if (ids.length !== input.remarks.length)
            throw new ValidationError('Each student can appear only once');
        const roster = await this.roster(tenantId, exam, { studentIds: ids });
        const placed = new Map(roster.map((r) => [r.studentId, r]));
        const mine = who.kind === 'teacher' ? await this.classTeacherOf(tenantId, who.teacherId) : undefined;
        for (const r of input.remarks) {
            const p = placed.get(r.student_id);
            if (!p)
                throw new ValidationError('The request is invalid', {
                    location: 'body',
                    issues: [{ path: 'remarks', message: `Student ${r.student_id} does not sit this exam` }],
                });
            this.assertMayWrite(who, p, exam.academicYearId, mine);
        }
        const teacherId = who.kind === 'teacher' ? who.teacherId : null;
        await this.db.transaction(async (tx) => {
            const existing = await tx
                .select()
                .from(examStudentRemarks)
                .where(and(eq(examStudentRemarks.tenantId, tenantId), eq(examStudentRemarks.examId, exam.id), inArray(examStudentRemarks.studentId, ids)))
                .for('update');
            const byStudent = new Map(existing.map((r) => [r.studentId, r]));
            for (const r of input.remarks) {
                const prev = byStudent.get(r.student_id);
                if (!r.remark) {
                    if (prev)
                        await tx.delete(examStudentRemarks).where(eq(examStudentRemarks.id, prev.id));
                    continue;
                }
                if (prev)
                    await tx
                        .update(examStudentRemarks)
                        .set({
                        remark: r.remark,
                        shareWithParent: r.share_with_parent,
                        teacherId: teacherId ?? prev.teacherId,
                        updatedBy: actor.userId,
                        version: prev.version + 1,
                    })
                        .where(eq(examStudentRemarks.id, prev.id));
                else
                    await tx.insert(examStudentRemarks).values({
                        tenantId,
                        examId: exam.id,
                        studentId: r.student_id,
                        remark: r.remark,
                        shareWithParent: r.share_with_parent,
                        teacherId,
                        createdBy: actor.userId,
                        updatedBy: actor.userId,
                    });
            }
            await recordChange(tx, actor, tenantId, {
                action: 'EXAM_REMARKS_SAVED',
                entityType: 'exam',
                entityId: exam.id,
                after: {
                    students: ids.length,
                    shared: input.remarks.filter((r) => r.remark && r.share_with_parent).length,
                    by: who.kind,
                },
            });
        });
        return this.list(tenantId, exam.id, {}, who).then((res) => ({
            ...res,
            data: res.data.filter((d) => ids.includes(d.student_id)),
        }));
    }
    /** Shared remarks of published exams for one student, with who wrote them (parent app). */
    async sharedForStudent(tenantId, studentId, examIds) {
        const rows = await this.shared(tenantId, [studentId], examIds);
        return new Map(rows.map(({ examId, ...r }) => [examId, r]));
    }
    /** Shared remarks of one exam for many students, keyed by student (printed report cards). */
    async sharedForExam(tenantId, examId, studentIds) {
        const rows = await this.shared(tenantId, studentIds, [examId]);
        return new Map(rows.map(({ studentId, ...r }) => [studentId, r]));
    }
    /** Only remarks the teacher chose to share with parents go on a report card. */
    async shared(tenantId, studentIds, examIds) {
        if (!studentIds.length || !examIds.length)
            return [];
        const rows = await this.db
            .select({
            r: examStudentRemarks,
            t: {
                firstName: teachers.firstName,
                middleName: teachers.middleName,
                lastName: teachers.lastName,
            },
            u: { firstName: users.firstName, lastName: users.lastName },
        })
            .from(examStudentRemarks)
            .leftJoin(teachers, eq(teachers.id, examStudentRemarks.teacherId))
            .leftJoin(users, eq(users.id, examStudentRemarks.updatedBy))
            .where(and(eq(examStudentRemarks.tenantId, tenantId), inArray(examStudentRemarks.studentId, studentIds), eq(examStudentRemarks.shareWithParent, true), inArray(examStudentRemarks.examId, examIds)));
        return rows.map((x) => ({
            examId: x.r.examId,
            studentId: x.r.studentId,
            remark: x.r.remark,
            by: x.t?.firstName
                ? fullName(x.t)
                : x.u?.firstName
                    ? `${x.u.firstName} ${x.u.lastName}`.trim()
                    : null,
        }));
    }
}
