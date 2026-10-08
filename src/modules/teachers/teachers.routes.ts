import type { Request } from 'express';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import { AuthorizationError } from '../../shared/errors.js';
import type { AssignmentService } from './assignments.service.js';
import type { ClassTeacherService } from './class-teachers.service.js';
import type { QualificationService } from './qualifications.service.js';
import {
  AssignClassTeacherBody,
  AssignmentListQuery,
  ClassTeacherListQuery,
  CreateAssignmentBody,
  CreateAssignmentWithTeacherBody,
  CreateTeacherBody,
  EndAssignmentBody,
  IdParams,
  PortalAccessBody,
  QualificationBody,
  QualificationParams,
  Reason,
  RevokePortalBody,
  SectionParams,
  TeacherCommandBody,
  TeacherCommands,
  TeacherListQuery,
  UpdateQualificationBody,
  UpdateTeacherBody,
} from './teachers.schemas.js';
import { COMMAND_PERMISSION, exportTeachersCsv, type TeacherService } from './teachers.service.js';

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
      { feature },
    );
}

const TAG = ['School · Teachers & staff'];
const TAG_Q = ['School · Teacher qualifications'];
const TAG_A = ['School · Teaching assignments'];
const TAG_C = ['School · Class teachers'];

const COMMAND_SUMMARY: Record<(typeof TeacherCommands)[number], string> = {
  onboard: 'Start onboarding a prospective staff member (PROSPECTIVE → ONBOARDING)',
  activate:
    'Activate (PROSPECTIVE/ONBOARDING/INACTIVE → ACTIVE). Does not restore a suspended login.',
  'start-leave': 'Put an active staff member on leave (ACTIVE → ON_LEAVE)',
  'return-from-leave': 'Return from leave (ON_LEAVE → ACTIVE)',
  deactivate:
    'Deactivate (ACTIVE/ON_LEAVE → INACTIVE). Ends open assignments and suspends the login.',
  resign:
    'Record a resignation with exit date and reason. Ends open assignments and suspends the login.',
  retire:
    'Record a retirement with exit date (reason optional). Ends open assignments and suspends the login.',
  terminate:
    'Record a termination with exit date and reason. Ends open assignments and suspends the login.',
  archive: 'Archive a departed (or never-started) staff member',
  restore: 'Restore an archived staff member (ARCHIVED → INACTIVE)',
};

export function teacherRoutes(
  teachers: TeacherService,
  qualifications: QualificationService,
  assignments: AssignmentService,
  classTeachers: ClassTeacherService,
  deps: import('../../container.js').Deps,
) {
  return [
    // ---- Teachers
    defineRoute({
      method: 'get',
      path: '/teachers',
      summary:
        'List and search teachers and staff (filters: status, staff_type, department, employment_type, has_login)',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.read'],
      query: TeacherListQuery,
      handler: async ({ query, req }) => teachers.list(tid(req), query, me(req)),
    }),
    defineRoute({
      method: 'get',
      path: '/teachers/export',
      summary: 'Export the filtered teacher list as CSV (audited)',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.read', 'teachers.export'],
      query: TeacherListQuery,
      handler: async ({ query, req, res }) => {
        const csv = await exportTeachersCsv(
          teachers,
          deps,
          tid(req),
          query,
          me(req),
          actorFrom(req.ctx),
        );
        res
          .status(200)
          .type('text/csv')
          .set('Content-Disposition', 'attachment; filename="teachers.csv"')
          .send(csv);
      },
    }),
    defineRoute({
      method: 'post',
      path: '/teachers',
      summary:
        'Create a teacher or staff member (optionally with qualifications). Possible duplicates ' +
        'return 409 CONFIRMATION_REQUIRED until confirm_duplicate is true.',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.create'],
      body: CreateTeacherBody,
      status: 201,
      handler: async ({ body, req }) => {
        if (body.qualifications?.length) requireAlso(req, 'teachers.update', 'teachers');
        return { data: await teachers.create(tid(req), body, me(req), actorFrom(req.ctx)) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teachers/me',
      summary:
        "The signed-in teacher's own classes: sections they are class teacher of and their open teaching assignments",
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.read'],
      handler: async ({ req }) => ({ data: await classTeachers.mine(tid(req), me(req)) }),
    }),
    defineRoute({
      method: 'get',
      path: '/teachers/:id',
      summary: 'Teacher profile with qualifications, open assignments and portal access',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await teachers.get(tid(req), params.id, me(req)),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/teachers/:id',
      summary: 'Edit a teacher (send the version you read). Status changes use commands.',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.update'],
      params: IdParams,
      body: UpdateTeacherBody,
      handler: async ({ params, body, req }) => ({
        data: await teachers.update(tid(req), params.id, body, me(req), actorFrom(req.ctx)),
      }),
    }),
    ...TeacherCommands.map((command) =>
      defineRoute({
        method: 'post',
        path: `/teachers/:id/${command}`,
        summary: COMMAND_SUMMARY[command],
        tags: TAG,
        access: 'tenant',
        permissions: [COMMAND_PERMISSION[command]],
        params: IdParams,
        body: TeacherCommandBody,
        handler: async ({ params, body, req }) => {
          const { teacher, warnings } = await teachers.command(
            tid(req),
            params.id,
            command,
            body,
            me(req),
            actorFrom(req.ctx),
          );
          return warnings.length ? { data: teacher, meta: { warnings } } : { data: teacher };
        },
      }),
    ),
    defineRoute({
      method: 'get',
      path: '/teachers/:id/history',
      summary: 'Teacher timeline (lifecycle, profile, qualification, assignment and login events)',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await teachers.history(tid(req), params.id, me(req)),
      }),
    }),

    // ---- Portal access (optional login)
    defineRoute({
      method: 'post',
      path: '/teachers/:id/portal-access',
      summary:
        'Invite the teacher to sign in: creates an invitation through the members service and ' +
        'links the membership. Anti-escalation applies to the chosen role.',
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.portal.manage'],
      params: IdParams,
      body: PortalAccessBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await teachers.invitePortalAccess(
          tid(req),
          params.id,
          body,
          me(req),
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'delete',
      path: '/teachers/:id/portal-access',
      summary: "Remove the teacher's login (revokes the membership) and clear the link",
      tags: TAG,
      access: 'tenant',
      permissions: ['teachers.portal.manage'],
      params: IdParams,
      body: RevokePortalBody,
      handler: async ({ params, body, req }) => ({
        data: await teachers.revokePortalAccess(
          tid(req),
          params.id,
          body.reason,
          me(req),
          actorFrom(req.ctx),
        ),
      }),
    }),

    // ---- Qualifications
    defineRoute({
      method: 'get',
      path: '/teachers/:id/qualifications',
      summary: "A teacher's qualifications",
      tags: TAG_Q,
      access: 'tenant',
      permissions: ['teachers.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await qualifications.list(tid(req), params.id, me(req)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/teachers/:id/qualifications',
      summary: 'Add a qualification',
      tags: TAG_Q,
      access: 'tenant',
      permissions: ['teachers.update'],
      params: IdParams,
      body: QualificationBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await qualifications.add(tid(req), params.id, body, me(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/teachers/:id/qualifications/:qid',
      summary: 'Edit a qualification (send the version you read)',
      tags: TAG_Q,
      access: 'tenant',
      permissions: ['teachers.update'],
      params: QualificationParams,
      body: UpdateQualificationBody,
      handler: async ({ params, body, req }) => ({
        data: await qualifications.update(
          tid(req),
          params.id,
          params.qid,
          body,
          me(req),
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'delete',
      path: '/teachers/:id/qualifications/:qid',
      summary: 'Remove a qualification from the profile (kept for audit)',
      tags: TAG_Q,
      access: 'tenant',
      permissions: ['teachers.update'],
      params: QualificationParams,
      status: 204,
      handler: async ({ params, req }) => {
        await qualifications.remove(tid(req), params.id, params.qid, me(req), actorFrom(req.ctx));
      },
    }),

    // ---- Teaching assignments
    defineRoute({
      method: 'get',
      path: '/teachers/:id/assignments',
      summary: "A teacher's teaching assignments (current and historical)",
      tags: TAG_A,
      access: 'tenant',
      permissions: ['teachers.read'],
      params: IdParams,
      query: AssignmentListQuery,
      handler: async ({ params, query, req }) =>
        assignments.listForTeacher(tid(req), params.id, query, me(req)),
    }),
    defineRoute({
      method: 'post',
      path: '/teachers/:id/assignments',
      summary:
        'Assign the teacher to a subject offering. The teacher must be ACTIVE, the offering ACTIVE ' +
        'in an UPCOMING/ACTIVE year; a second open assignment for the same offering is 409.',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['teachers.assignments.manage'],
      params: IdParams,
      body: CreateAssignmentBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await assignments.create(tid(req), params.id, body, me(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/teaching-assignments',
      summary:
        'List teaching assignments (filters: teacher, offering, year, class, section, status)',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['teachers.read'],
      query: AssignmentListQuery,
      handler: async ({ query, req }) => assignments.list(tid(req), query, me(req)),
    }),
    defineRoute({
      method: 'post',
      path: '/teaching-assignments',
      summary: 'Create a teaching assignment (same as POST /teachers/:id/assignments)',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['teachers.assignments.manage'],
      body: CreateAssignmentWithTeacherBody,
      status: 201,
      handler: async ({ body, req }) => {
        const { teacher_id, ...rest } = body;
        return {
          data: await assignments.create(tid(req), teacher_id, rest, me(req), actorFrom(req.ctx)),
        };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/teaching-assignments/:id',
      summary: 'Teaching assignment with its offering context',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['teachers.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await assignments.get(tid(req), params.id, me(req)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/teaching-assignments/:id/end',
      summary: 'End a running assignment (kept in history). Not-yet-started ones are cancelled.',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['teachers.assignments.manage'],
      params: IdParams,
      body: EndAssignmentBody,
      handler: async ({ params, body, req }) => ({
        data: await assignments.end(tid(req), params.id, body, me(req), actorFrom(req.ctx)),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/teaching-assignments/:id/cancel',
      summary: 'Cancel an assignment entered by mistake or that never started (reason required)',
      tags: TAG_A,
      access: 'tenant',
      permissions: ['teachers.assignments.manage'],
      params: IdParams,
      body: Reason,
      handler: async ({ params, body, req }) => ({
        data: await assignments.cancel(
          tid(req),
          params.id,
          body.reason,
          me(req),
          actorFrom(req.ctx),
        ),
      }),
    }),

    // ---- Class teachers
    defineRoute({
      method: 'get',
      path: '/class-teachers',
      summary: 'Sections of an academic year (default: the active year) with their class teacher',
      tags: TAG_C,
      access: 'tenant',
      permissions: ['teachers.read'],
      query: ClassTeacherListQuery,
      handler: async ({ query, req }) => classTeachers.list(tid(req), query, me(req)),
    }),
    defineRoute({
      method: 'put',
      path: '/sections/:sectionId/class-teacher',
      summary:
        'Make a teacher the class teacher of a section; the previous class teacher is ended. ' +
        'The teacher must be an ACTIVE teaching-staff member; the year upcoming or active.',
      tags: TAG_C,
      access: 'tenant',
      permissions: ['teachers.assignments.manage'],
      params: SectionParams,
      body: AssignClassTeacherBody,
      handler: async ({ params, body, req }) => ({
        data: await classTeachers.assign(
          tid(req),
          params.sectionId,
          body,
          me(req),
          actorFrom(req.ctx),
        ),
      }),
    }),
    defineRoute({
      method: 'delete',
      path: '/sections/:sectionId/class-teacher',
      summary: 'End the current class teacher of a section (reason required, kept in history)',
      tags: TAG_C,
      access: 'tenant',
      permissions: ['teachers.assignments.manage'],
      params: SectionParams,
      body: Reason,
      status: 204,
      handler: async ({ params, body, req }) => {
        await classTeachers.remove(
          tid(req),
          params.sectionId,
          body.reason,
          me(req),
          actorFrom(req.ctx),
        );
      },
    }),
  ];
}
