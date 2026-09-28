import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { errorMiddleware } from './core/errors.js';
import { authRouter } from './modules/auth/routes.js';
import { schoolsRouter } from './modules/schools/routes.js';
import { usersRouter } from './modules/users/routes.js';
import { studentsRouter } from './modules/students/routes.js';
import { attendanceRouter, studentAttendanceRouter } from './modules/attendance/routes.js';
import { documentsRouter } from './modules/storage/routes.js';
import { auditRouter } from './modules/audit/routes.js';
import { schoolSetupRouter } from './modules/schoolSetup/routes.js';
import { academicYearsRouter, academicTermsRouter } from './modules/academicYears/routes.js';
import { subjectsRouter } from './modules/subjects/routes.js';
import { holidaysRouter } from './modules/holidays/routes.js';
import { gradesRouter } from './modules/grades/routes.js';
import { feeTypesRouter } from './modules/feeTypes/routes.js';
import { staffRouter } from './modules/staff/routes.js';
import { staffLeaveRouter } from './modules/staffLeave/routes.js';
import { payrollRouter } from './modules/payroll/routes.js';
import { timetableRouter } from './modules/timetable/routes.js';
import { classesRouter } from './modules/classes/routes.js';
import { feesRouter, studentFeesRouter } from './modules/fees/routes.js';
import { examsRouter, studentExamsRouter } from './modules/exams/routes.js';
import { parentsRouter } from './modules/parents/routes.js';
import { dashboardRouter } from './modules/dashboard/routes.js';
import { permissionsRouter } from './modules/permissions/routes.js';
import { noticesRouter } from './modules/notices/routes.js';
import { settingsRouter } from './modules/settings/routes.js';

// Modular-monolith wiring: each module owns its own routes/service/(repo
// calls via db/index.js) and is mounted here under a resource-oriented
// path (spec section 39) rather than one screen-shaped endpoint per page.
export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok', databaseDriver: env.databaseDriver }));

  app.use('/api/auth', authRouter);
  app.use('/api/schools', schoolsRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/students', studentsRouter);
  app.use('/api/students', studentAttendanceRouter); // GET /api/students/:id/attendance
  app.use('/api/attendance', attendanceRouter);
  app.use('/api/documents', documentsRouter);
  app.use('/api/audit-logs', auditRouter);
  // School Setup module (see designs/School Managment Feature.png) --
  // school-setup owns the profile/promotion/preferences form tabs,
  // academic-years/academic-terms own Academic Settings, subjects/
  // holidays/grades/fee-types are the remaining School Setup sub-tabs.
  app.use('/api/school-setup', schoolSetupRouter);
  app.use('/api/academic-years', academicYearsRouter);
  app.use('/api/academic-terms', academicTermsRouter);
  app.use('/api/subjects', subjectsRouter);
  app.use('/api/holidays', holidaysRouter);
  app.use('/api/grades', gradesRouter);
  app.use('/api/fee-types', feeTypesRouter);
  // Teachers & Staff (designs/Teacher feature UI mockup) -- staff owns
  // the directory/profile/import/reports/assignments/workload surface,
  // staff-leave owns the approval queue + balances sub-module.
  app.use('/api/staff', staffRouter);
  app.use('/api/staff-leave', staffLeaveRouter);
  // Payroll (Teachers & Staff) -- record of an offline payroll process; see modules/payroll/service.js.
  app.use('/api/payroll', payrollRouter);
  // Timetable (designs/Teacher feature UI mockup/Timetable.dc.html) --
  // config/venues/versions/entries/generate/clashes/exams/relief/export,
  // each gated by its own timetable:<page>:<action> permission (see
  // core/permissionsV2.js).
  app.use('/api/timetable', timetableRouter);
  app.use('/api/classes', classesRouter);

  // Fees & Payments (designs/Teacher feature UI mockup/Fees and
  // Payments.dc.html) -- a record of an offline collection process
  // (invoices, payments, reconciliation, arrears, disbursements),
  // gated by fees.view/fees.create/fees.update/fees.refund. Kept
  // fully separate from School Setup's existing fee-types tab -- see
  // modules/fees/service.js's header for the full scope rationale.
  app.use('/api/students', studentFeesRouter); // GET /api/students/:id/fees
  app.use('/api/students', studentExamsRouter); // GET /api/students/:id/exams
  app.use('/api/fees', feesRouter);
  app.use('/api/exams', examsRouter);
  app.use('/api/parents', parentsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/permissions', permissionsRouter);
  app.use('/api/notices', noticesRouter);
  app.use('/api/settings', settingsRouter);

  app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
  app.use(errorMiddleware);
  return app;
}
