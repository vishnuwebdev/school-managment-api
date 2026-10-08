import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Deps } from './container.js';
import { healthRouter } from './http/health.js';
import { errorHandler, notFoundHandler } from './http/middleware/error-handler.js';
import { requestId } from './http/middleware/request-id.js';
import { buildOpenApiDocument } from './http/openapi.js';
import { createPipeline } from './http/pipeline.js';
import { mountRoutes, type RouteDef } from './http/route.js';
import { academicRoutes } from './modules/academic/academic.routes.js';
import { roleRoutes } from './modules/access/roles.routes.js';
import { attendanceRoutes } from './modules/attendance/attendance.routes.js';
import { feeRoutes } from './modules/fees/fees.routes.js';
import { examRoutes } from './modules/exams/exams.routes.js';
import { timetableRoutes } from './modules/timetable/timetable.routes.js';
import { studentRoutes } from './modules/students/students.routes.js';
import { teacherRoutes } from './modules/teachers/teachers.routes.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { billingRoutes } from './modules/billing/billing.routes.js';
import { planRoutes } from './modules/plans/plans.routes.js';
import { catalogRoutes } from './modules/catalog/catalog.routes.js';
import { authRoutes } from './modules/identity/auth.routes.js';
import { memberRoutes, platformUserRoutes } from './modules/members/members.routes.js';
import {
  currentTenantRoutes,
  platformTenantRoutes,
  publicTenantRoutes,
} from './modules/tenants/tenants.routes.js';
import { DOCUMENT_TYPES } from './modules/files/file-validation.js';
import { leaveRoutes } from './modules/teachers/leave.routes.js';
import { calendarRoutes } from './modules/calendar/calendar.routes.js';
import { studentConfigRoutes } from './modules/students/config.routes.js';
import { staffReportRoutes } from './modules/teachers/staff-reports.routes.js';
import { staffImportRoutes } from './modules/teachers/import.routes.js';
import { IMPORT_CONTENT_TYPES } from './modules/teachers/import.service.js';
import { staffDocumentRoutes } from './modules/teachers/documents.routes.js';
import { studentDocumentRoutes } from './modules/students/documents.routes.js';
import { STUDENT_IMPORT_XLSX } from './modules/students/import.service.js';
import { classOverviewRoutes } from './modules/academic/overview.routes.js';
import { studentCertificateRoutes } from './modules/students/certificates.routes.js';
import { studentReportRoutes } from './modules/students/reports.routes.js';
import { studentImportRoutes } from './modules/students/import.routes.js';
import { studentExitRoutes } from './modules/students/exits.routes.js';
import { schoolSetupRoutes } from './modules/tenants/school-setup.routes.js';
import { ALLOWED_IMAGE_TYPES } from './modules/tenants/school-setup.service.js';
import type { Services } from './services.js';

export interface AppOptions {
  /** Extra routes (used by tests to exercise the pipeline). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraRoutes?: RouteDef<any, any, any>[];
}

export function createApp(deps: Deps, svc: Services, opts: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  if (deps.env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(helmet());
  const origins = deps.env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: origins.length ? origins : false,
      credentials: false,
      exposedHeaders: ['X-Request-Id'],
    }),
  );
  app.use(requestId);
  app.use(express.json({ limit: '1mb' }));
  // Branding images arrive as the raw request body (no multipart parser needed).
  app.use(
    '/api/v1/tenants/current/branding',
    express.raw({ type: ALLOWED_IMAGE_TYPES, limit: '6mb' }),
  );
  // Student photos and documents are raw bodies too.
  app.use(
    '/api/v1/students',
    express.raw({ type: [...DOCUMENT_TYPES, STUDENT_IMPORT_XLSX], limit: '6mb' }),
  );
  // Proof of payment is a raw file body too.
  app.use(
    '/api/v1/fees',
    express.raw({
      type: [...DOCUMENT_TYPES, 'text/csv', 'application/vnd.ms-excel'],
      limit: '6mb',
    }),
  );
  app.use(
    '/api/v1/teachers',
    express.raw({ type: [...DOCUMENT_TYPES, ...IMPORT_CONTENT_TYPES], limit: '6mb' }),
  );
  if (deps.env.NODE_ENV !== 'test') {
    app.use(
      pinoHttp({
        logger: deps.log,
        genReqId: (req) => req.ctx.meta.requestId,
        customProps: (req) => ({
          tenant_id: req.ctx?.tenant?.tenantId,
          user_id: req.ctx?.principal?.userId,
        }),
      }),
    );
  }

  app.use(healthRouter(deps));

  const pipeline = createPipeline(deps, svc);
  const api = Router();
  mountRoutes(
    api,
    [
      ...authRoutes(svc.auth),
      ...publicTenantRoutes(svc.tenants),
      ...currentTenantRoutes(svc.tenants),
      ...schoolSetupRoutes(svc.schoolSetup),
      ...memberRoutes(svc.members),
      ...roleRoutes(svc.roles),
      ...catalogRoutes(deps, svc.entitlements),
      ...planRoutes(svc.plans),
      ...billingRoutes(svc.billing),
      ...auditRoutes(deps),
      ...classOverviewRoutes(svc.classOverview),
      ...academicRoutes(svc.academic),
      ...studentDocumentRoutes(svc.studentDocuments),
      ...studentExitRoutes(svc.studentExits),
      ...staffImportRoutes(svc.staffImport),
      ...staffReportRoutes(svc.staffReports),
      ...staffDocumentRoutes(svc.staffDocuments, svc.staffLookups),
      ...leaveRoutes(svc.leave, svc.staffAttendance),
      ...calendarRoutes(svc.calendar),
      ...studentImportRoutes(svc.studentImport),
      ...studentReportRoutes(svc.studentReports),
      ...studentCertificateRoutes(svc.studentCertificates),
      ...studentConfigRoutes(svc.studentConfig, svc.students),
      ...studentRoutes(svc.students, svc.enrollments, svc.guardians, svc.admissions, deps),
      ...teacherRoutes(svc.teachers, svc.qualifications, svc.assignments, svc.classTeachers, deps),
      ...attendanceRoutes(
        svc.attendanceConfig,
        svc.attendanceSessions,
        svc.attendanceCorrections,
        svc.attendanceReports,
      ),
      ...timetableRoutes(
        svc.timetableConfig,
        svc.timetables,
        svc.timetableEntries,
        svc.timetableViews,
      ),
      ...examRoutes(svc.exams),
      ...feeRoutes({
        config: svc.feeConfig,
        assignments: svc.feeAssignments,
        demands: svc.feeDemands,
        adjustments: svc.feeAdjustments,
        payments: svc.feePayments,
        refunds: svc.feeRefunds,
        reports: svc.feeReports,
        documents: svc.feeDocuments,
        reconciliation: svc.feeReconciliation,
        arrears: svc.feeArrears,
      }),
      ...platformTenantRoutes(svc.tenants, svc.entitlements),
      ...platformUserRoutes(svc.members),
      ...(opts.extraRoutes ?? []),
    ],
    pipeline,
  );
  app.use('/api/v1', api);

  const docsEnabled = deps.env.DOCS_ENABLED ?? deps.env.NODE_ENV !== 'production';
  if (docsEnabled) {
    app.get('/openapi.json', (_req, res) => {
      res.json(buildOpenApiDocument());
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler(deps.log));
  return app;
}
