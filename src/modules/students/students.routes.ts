import type { Request } from 'express';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import { AuthorizationError } from '../../shared/errors.js';
import type { AdmissionService } from './admissions.service.js';
import type { EnrollmentService } from './enrollments.service.js';
import type { GuardianService } from './guardians.service.js';
import {
  AdmissionListQuery,
  ApproveAdmissionBody,
  BulkMoveBody,
  BulkPromoteBody,
  ChangeEnrollmentBody,
  CompleteEnrollmentBody,
  CreateAdmissionBody,
  CreateStudentBody,
  EnrollBody,
  EnrollmentListQuery,
  CreateGuardianBody,
  GuardianListQuery,
  IdParams,
  LinkGuardianBody,
  Reason,
  StudentCommandBody,
  StudentCommands,
  StudentLinkParams,
  StudentListQuery,
  UpdateGuardianBody,
  UpdateLinkBody,
  UpdateStudentBody,
} from './students.schemas.js';
import { COMMAND_PERMISSION, exportStudentsCsv, type StudentService } from './students.service.js';

const tid = (req: Request) => req.ctx.tenant!.tenantId;
const me = (req: Request) => req.ctx.principal!;

/** Extra permission (and its feature) needed only when part of a combined request is used. */
function requireAlso(req: Request, permission: string, feature: string) {
  if (!me(req).permissions.has(permission))
    throw new AuthorizationError('PERMISSION_DENIED', undefined, { permission });
  if (!req.ctx.tenant!.entitlements.features.includes(feature))
    throw new AuthorizationError(
      'FEATURE_NOT_ENABLED',
      'This feature is not enabled for your school',
      {
        feature,
      },
    );
}

const TAG = ['School · Students'];
const TAG_G = ['School · Guardians'];
const TAG_E = ['School · Enrollments'];
const TAG_A = ['School · Admissions'];

export function studentRoutes(
  students: StudentService,
  enrollments: EnrollmentService,
  guardians: GuardianService,
  admissions: AdmissionService,
  deps: import('../../container.js').Deps,
) {
  return [
    // ---- Students
    defineRoute({
      method: 'get',
      path: '/students',
      summary: 'List and search students (filters: status, class, section, year, enrolled)',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.read'],
      query: StudentListQuery,
      handler: async ({ query, req }) => students.list(tid(req), query, me(req)),
    }),
    defineRoute({
      method: 'get',
      path: '/students/export',
      summary: 'Export the filtered student list as CSV (audited)',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.read', 'students.export'],
      query: StudentListQuery,
      handler: async ({ query, req, res }) => {
        const csv = await exportStudentsCsv(
          students,
          deps,
          tid(req),
          query,
          me(req),
          actorFrom(req.ctx),
        );
        res
          .status(200)
          .type('text/csv')
          .set('Content-Disposition', 'attachment; filename="students.csv"')
          .send(csv);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/students',
      summary:
        'Create a student, optionally with guardians and an enrollment in one transaction. ' +
        'Possible duplicates return 409 CONFIRMATION_REQUIRED until confirm_duplicate is true.',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.create'],
      body: CreateStudentBody,
      status: 201,
      handler: async ({ body, req }) => {
        if (body.guardians?.length) requireAlso(req, 'students.guardians.manage', 'students');
        if (body.enrollment) {
          requireAlso(req, 'students.enroll', 'students');
          requireAlso(req, 'academics.read', 'academics');
        }
        return { data: await students.create(tid(req), body, me(req), actorFrom(req.ctx)) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/students/:id',
      summary: 'Student profile with current enrollment and guardians',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await students.get(tid(req), params.id, me(req)),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/students/:id',
      summary: 'Edit a student (send the version you read). Status changes use commands.',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.update'],
      params: IdParams,
      body: UpdateStudentBody,
      handler: async ({ params, body, req }) => ({
        data: await students.update(tid(req), params.id, body, me(req), actorFrom(req.ctx)),
      }),
    }),
    ...StudentCommands.map((command) =>
      defineRoute({
        method: 'post',
        path: `/students/:id/${command}`,
        summary: {
          admit: 'Admit a prospective student (PROSPECTIVE/ADMISSION_PENDING → ADMITTED)',
          activate: 'Activate an admitted, enrolled student (ADMITTED → ACTIVE)',
          transfer: 'Transfer out of the school (ACTIVE → TRANSFERRED); closes enrollments',
          withdraw: 'Withdraw a student; closes enrollments',
          graduate: 'Graduate an active student; completes enrollments',
          archive: 'Archive a transferred, withdrawn or graduated student',
          reinstate: 'Bring a withdrawn/transferred student back (→ ADMITTED)',
        }[command],
        tags: TAG,
        access: 'tenant',
        permissions: [COMMAND_PERMISSION[command]],
        params: IdParams,
        body: StudentCommandBody,
        handler: async ({ params, body, req }) => ({
          data: await students.command(
            tid(req),
            params.id,
            command,
            body,
            me(req),
            actorFrom(req.ctx),
          ),
        }),
      }),
    ),
    defineRoute({
      method: 'get',
      path: '/students/:id/history',
      summary: 'Student timeline (lifecycle, enrollment, guardian and admission events)',
      tags: TAG,
      access: 'tenant',
      permissions: ['students.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await students.history(tid(req), params.id, me(req)),
      }),
    }),

    // ---- Student guardians
    defineRoute({
      method: 'get',
      path: '/students/:id/guardians',
      summary: "A student's guardians",
      tags: TAG_G,
      access: 'tenant',
      permissions: ['students.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await guardians.forStudent(tid(req), params.id, me(req)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/students/:id/guardians',
      summary: 'Link an existing guardian, or create one and link them',
      tags: TAG_G,
      access: 'tenant',
      permissions: ['students.guardians.manage'],
      params: IdParams,
      body: LinkGuardianBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await guardians.link(tid(req), params.id, body, me(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/students/:id/guardians/:linkId',
      summary: 'Change the relationship, primary contact, pick-up or portal rights',
      tags: TAG_G,
      access: 'tenant',
      permissions: ['students.guardians.manage'],
      params: StudentLinkParams,
      body: UpdateLinkBody,
      handler: async ({ params, body, req }) => ({
        data: await guardians.updateLink(
          tid(req),
          params.id,
          params.linkId,
          body,
          me(req),
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'delete',
      path: '/students/:id/guardians/:linkId',
      summary: 'End the guardian relationship (kept in history)',
      tags: TAG_G,
      access: 'tenant',
      permissions: ['students.guardians.manage'],
      params: StudentLinkParams,
      status: 204,
      handler: async ({ params, req }) => {
        await guardians.unlink(tid(req), params.id, params.linkId, me(req), actorFrom(req.ctx));
      },
    }),
    defineRoute({
      method: 'get',
      path: '/guardians',
      summary: 'Guardian directory (search by name, phone, email)',
      tags: TAG_G,
      access: 'tenant',
      permissions: ['students.read'],
      query: GuardianListQuery,
      handler: async ({ query, req }) => guardians.list(tid(req), query, me(req)),
    }),
    defineRoute({
      method: 'post',
      path: '/guardians',
      summary:
        'Add a parent without linking a student yet (409 with matches when the phone/email already exists)',
      tags: TAG_G,
      access: 'tenant',
      permissions: ['students.guardians.manage'],
      body: CreateGuardianBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await guardians.create(tid(req), body, me(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/guardians/:id',
      summary: 'Guardian with linked students',
      tags: TAG_G,
      access: 'tenant',
      permissions: ['students.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await guardians.get(tid(req), params.id, me(req)),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/guardians/:id',
      summary: "Edit a guardian's contact details",
      tags: TAG_G,
      access: 'tenant',
      permissions: ['students.guardians.manage'],
      params: IdParams,
      body: UpdateGuardianBody,
      handler: async ({ params, body, req }) => ({
        data: await guardians.update(tid(req), params.id, body, me(req), actorFrom(req.ctx)),
      }),
    }),

    // ---- Enrollments
    defineRoute({
      method: 'get',
      path: '/students/:id/enrollments',
      summary: "A student's enrollment history",
      tags: TAG_E,
      access: 'tenant',
      permissions: ['students.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await enrollments.forStudent(tid(req), params.id, me(req)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/students/:id/enrollments',
      summary: 'Enroll a student in a class/section for an academic year (checks capacity)',
      tags: TAG_E,
      access: 'tenant',
      permissions: ['students.enroll', 'academics.read'],
      params: IdParams,
      body: EnrollBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await enrollments.enroll(tid(req), params.id, body, me(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/enrollments',
      summary: 'Roster: enrollments by year, class or section',
      tags: TAG_E,
      access: 'tenant',
      permissions: ['students.read', 'academics.read'],
      query: EnrollmentListQuery,
      handler: async ({ query, req }) => enrollments.list(tid(req), query, me(req)),
    }),
    defineRoute({
      method: 'post',
      path: '/enrollments/bulk-move',
      summary: 'Move many students into one section (same academic year). All or nothing.',
      tags: TAG_E,
      access: 'tenant',
      permissions: ['students.enroll', 'academics.read'],
      body: BulkMoveBody,
      handler: async ({ body, req }) => ({
        data: await enrollments.bulkMove(tid(req), body, me(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/enrollments/bulk-promote',
      summary:
        'Promote students: complete their open enrollments and enroll them in the next year. All or nothing.',
      tags: TAG_E,
      access: 'tenant',
      permissions: ['students.enroll', 'academics.read'],
      body: BulkPromoteBody,
      handler: async ({ body, req }) => ({
        data: await enrollments.bulkPromote(tid(req), body, me(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/enrollments/:id/change',
      summary: 'Move to another class/section in the same year (old enrollment is kept)',
      tags: TAG_E,
      access: 'tenant',
      permissions: ['students.enroll', 'academics.read'],
      params: IdParams,
      body: ChangeEnrollmentBody,
      handler: async ({ params, body, req }) => ({
        data: await enrollments.change(tid(req), params.id, body, me(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/enrollments/:id/complete',
      summary: 'Complete an enrollment (end of period)',
      tags: TAG_E,
      access: 'tenant',
      permissions: ['students.enroll', 'academics.read'],
      params: IdParams,
      body: CompleteEnrollmentBody,
      handler: async ({ params, body, req }) => ({
        data: await enrollments.complete(tid(req), params.id, body, me(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/enrollments/:id/cancel',
      summary: 'Cancel an enrollment entered in error',
      tags: TAG_E,
      access: 'tenant',
      permissions: ['students.enroll', 'academics.read'],
      params: IdParams,
      body: Reason,
      handler: async ({ params, body, req }) => ({
        data: await enrollments.cancel(
          tid(req),
          params.id,
          body.reason,
          me(req),
          actorFrom(req.ctx),
        ),
      }),
    }),

    // ---- Admissions
    defineRoute({
      method: 'get',
      path: '/admissions',
      summary: 'List admissions',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['students.admissions.read'],
      query: AdmissionListQuery,
      handler: async ({ query, req }) => admissions.list(tid(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/admissions',
      summary: 'Open an admission for a new (or existing prospective) student',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['students.admissions.manage', 'students.create'],
      body: CreateAdmissionBody,
      status: 201,
      handler: async ({ body, req }) => ({
        data: await admissions.create(tid(req), body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/admissions/:id',
      summary: 'Admission detail',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['students.admissions.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await admissions.get(tid(req), params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/admissions/:id/submit',
      summary: 'Submit a draft admission (student becomes ADMISSION_PENDING)',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['students.admissions.manage'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await admissions.submit(tid(req), params.id, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/admissions/:id/review',
      summary: 'Mark a submitted admission as under review',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['students.admissions.manage'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await admissions.startReview(tid(req), params.id, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/admissions/:id/approve',
      summary: 'Approve an admission (student becomes ADMITTED; enroll them separately)',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['students.admissions.approve'],
      params: IdParams,
      body: ApproveAdmissionBody,
      handler: async ({ params, body, req }) => ({
        data: await admissions.approve(tid(req), params.id, body, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/admissions/:id/reject',
      summary: 'Reject an admission',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['students.admissions.approve'],
      params: IdParams,
      body: Reason,
      handler: async ({ params, body, req }) => ({
        data: await admissions.reject(tid(req), params.id, body.reason, actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/admissions/:id/cancel',
      summary: 'Cancel an open admission',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['students.admissions.manage'],
      params: IdParams,
      body: Reason,
      handler: async ({ params, body, req }) => ({
        data: await admissions.cancel(tid(req), params.id, body.reason, actorFrom(req.ctx)),
      }),
    }),
  ];
}
