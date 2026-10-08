import type { Deps } from './container.js';
import { AuthorizationService } from './modules/access/authorization.service.js';
import { AcademicService } from './modules/academic/academic.service.js';
import { AdmissionService } from './modules/students/admissions.service.js';
import { EnrollmentService } from './modules/students/enrollments.service.js';
import { GuardianService } from './modules/students/guardians.service.js';
import { AttendanceConfigService } from './modules/attendance/config.service.js';
import { CorrectionService } from './modules/attendance/corrections.service.js';
import { ReportService } from './modules/attendance/reports.service.js';
import { SessionService } from './modules/attendance/sessions.service.js';
import { ExamService } from './modules/exams/exams.service.js';
import { TimetableConfigService } from './modules/timetable/config.service.js';
import { EntryService } from './modules/timetable/entries.service.js';
import { TimetableService } from './modules/timetable/timetables.service.js';
import { ViewService } from './modules/timetable/views.service.js';
import { AssignmentService } from './modules/teachers/assignments.service.js';
import { ClassTeacherService } from './modules/teachers/class-teachers.service.js';
import { StaffReportService } from './modules/teachers/staff-reports.service.js';
import { StudentConfigService } from './modules/students/config.service.js';
import { StaffImportService } from './modules/teachers/import.service.js';
import { StaffLookupService } from './modules/teachers/lookups.service.js';
import { StaffDocumentService } from './modules/teachers/documents.service.js';
import { LeaveService } from './modules/teachers/leave.service.js';
import { CalendarService } from './modules/calendar/calendar.service.js';
import { StaffAttendanceService } from './modules/teachers/staff-attendance.service.js';
import { QualificationService } from './modules/teachers/qualifications.service.js';
import { TeacherService } from './modules/teachers/teachers.service.js';
import { AdjustmentService } from './modules/fees/adjustments.service.js';
import { AssignmentService as FeeAssignmentService } from './modules/fees/assignments.service.js';
import { FeeConfigService } from './modules/fees/config.service.js';
import { DemandService } from './modules/fees/demands.service.js';
import { ArrearsService } from './modules/fees/arrears.service.js';
import { FeeDocumentService } from './modules/fees/documents.service.js';
import { ReconciliationService } from './modules/fees/reconciliation.service.js';
import { PaymentService } from './modules/fees/payments.service.js';
import { RefundService } from './modules/fees/refunds.service.js';
import { FeeReportService } from './modules/fees/reports.service.js';
import { FileService } from './modules/files/files.service.js';
import { StudentDocumentService } from './modules/students/documents.service.js';
import { ClassOverviewService } from './modules/academic/overview.service.js';
import { StudentCertificateService } from './modules/students/certificates.service.js';
import { StudentReportService } from './modules/students/reports.service.js';
import { StudentImportService } from './modules/students/import.service.js';
import { StudentExitService } from './modules/students/exits.service.js';
import { StudentService } from './modules/students/students.service.js';
import { RoleService } from './modules/access/roles.service.js';
import { EntitlementService } from './modules/entitlements/entitlements.service.js';
import { AuthService } from './modules/identity/auth.service.js';
import { TokenService } from './modules/identity/tokens.js';
import { BillingService } from './modules/billing/billing.service.js';
import { PlanService } from './modules/plans/plans.service.js';
import { MemberService } from './modules/members/members.service.js';
import { SchoolSetupService } from './modules/tenants/school-setup.service.js';
import { TenantService } from './modules/tenants/tenants.service.js';

export function buildServices(deps: Deps) {
  const tokens = new TokenService(deps.env);
  const authz = new AuthorizationService(deps);
  const entitlements = new EntitlementService(deps);
  const plans = new PlanService(deps, entitlements);
  const roles = new RoleService(deps, authz);
  const members = new MemberService(deps, authz, roles);
  const auth = new AuthService(deps, tokens, authz);
  const billing = new BillingService(deps);
  const tenants = new TenantService(deps, entitlements, authz, billing);
  const schoolSetup = new SchoolSetupService(deps);
  const academic = new AcademicService(deps);
  const enrollments = new EnrollmentService(deps, academic);
  const guardians = new GuardianService(deps);
  const students = new StudentService(deps, enrollments, guardians);
  const fileService = new FileService(deps);
  const studentDocuments = new StudentDocumentService(deps, fileService);
  const studentExits = new StudentExitService(deps, fileService);
  const admissions = new AdmissionService(deps, students);
  const qualifications = new QualificationService(deps);
  const assignments = new AssignmentService(deps);
  const classTeachers = new ClassTeacherService(deps);
  const staffDocuments = new StaffDocumentService(deps, fileService);
  const calendar = new CalendarService(deps);
  const leave = new LeaveService(deps, calendar);
  const staffAttendance = new StaffAttendanceService(deps, leave, calendar);
  const studentConfig = new StudentConfigService(deps);
  const studentReports = new StudentReportService(deps);
  const classOverview = new ClassOverviewService(deps);
  const studentCertificates = new StudentCertificateService(deps, fileService, schoolSetup);
  const studentImport = new StudentImportService(
    deps,
    students,
    guardians,
    academic,
    studentConfig,
  );
  const staffLookups = new StaffLookupService(deps);
  const teachers = new TeacherService(
    deps,
    members,
    assignments,
    qualifications,
    classTeachers,
    staffLookups,
    calendar,
  );
  const staffReports = new StaffReportService(deps);
  const staffImport = new StaffImportService(deps, teachers, staffLookups);
  const attendanceConfig = new AttendanceConfigService(deps);
  const attendanceSessions = new SessionService(deps, attendanceConfig, calendar);
  const attendanceCorrections = new CorrectionService(deps, attendanceConfig, attendanceSessions);
  const attendanceReports = new ReportService(deps, attendanceConfig, attendanceSessions);
  const timetableConfig = new TimetableConfigService(deps);
  const timetables = new TimetableService(deps, timetableConfig);
  const timetableEntries = new EntryService(deps, timetableConfig);
  const timetableViews = new ViewService(deps, timetableConfig);
  const exams = new ExamService(deps);
  const feeConfig = new FeeConfigService(deps);
  const feeAssignments = new FeeAssignmentService(deps);
  // New and moved students are billed their class fees automatically.
  enrollments.setAfterEnrol((tx, tenantId, enrollmentId, actor) =>
    feeAssignments.autoApplyForEnrollment(tx, tenantId, enrollmentId, actor),
  );
  const feeDemands = new DemandService(deps);
  const feeAdjustments = new AdjustmentService(deps);
  const feePayments = new PaymentService(deps);
  const feeRefunds = new RefundService(deps, feePayments);
  const feeDocuments = new FeeDocumentService(deps, fileService, schoolSetup);
  const feeReconciliation = new ReconciliationService(deps, feePayments);
  const feeArrears = new ArrearsService(deps);
  const feeReports = new FeeReportService(deps);
  return {
    tokens,
    authz,
    entitlements,
    plans,
    billing,
    roles,
    members,
    auth,
    tenants,
    schoolSetup,
    academic,
    enrollments,
    guardians,
    students,
    fileService,
    studentDocuments,
    studentExits,
    studentImport,
    studentReports,
    classOverview,
    studentCertificates,
    admissions,
    qualifications,
    assignments,
    teachers,
    classTeachers,
    studentConfig,
    staffLookups,
    staffImport,
    staffReports,
    staffDocuments,
    calendar,
    leave,
    staffAttendance,
    attendanceConfig,
    attendanceSessions,
    attendanceCorrections,
    attendanceReports,
    timetableConfig,
    timetables,
    timetableEntries,
    timetableViews,
    exams,
    feeConfig,
    feeAssignments,
    feeDemands,
    feeAdjustments,
    feePayments,
    feeRefunds,
    feeDocuments,
    feeReconciliation,
    feeArrears,
    feeReports,
  };
}

export type Services = ReturnType<typeof buildServices>;
