import type { Request, Response } from 'express';
import { z } from 'zod';
import { defineRoute } from '../../http/route.js';
import { actorFrom } from '../../platform/context.js';
import type { AdjustmentService } from './adjustments.service.js';
import type { AssignmentService } from './assignments.service.js';
import type { FeeConfigService } from './config.service.js';
import type { DemandService } from './demands.service.js';
import type { ArrearsService } from './arrears.service.js';
import type { FeeDocumentService } from './documents.service.js';
import type { ReconciliationService } from './reconciliation.service.js';
import { fileHeaders } from '../files/files.service.js';
import { PhotoUploadQuery } from '../students/documents.schemas.js';
import {
  ArrearsQuery,
  BankLineListQuery,
  CancelPlanBody,
  ConfirmLineBody,
  CreatePlanBody,
  IgnoreLineBody,
  LineParams,
  PlanListQuery,
  PlanParams,
  RecordLineBody,
  RecordReminderBody,
  RunRemindersBody,
  StatementUploadQuery,
  UnconfirmedPaymentsQuery,
} from './collections.schemas.js';
import {
  AdjustmentListQuery,
  AllocateBody,
  AllocationParams,
  ApplyLateFeesBody,
  ArchiveStructureBody,
  AssignmentListQuery,
  BulkAssignBody,
  BulkGenerateBody,
  CategoryListQuery,
  CollectionQuery,
  CompleteRefundBody,
  ConcessionReportQuery,
  CreateAdjustmentBody,
  CreateAssignmentBody,
  CreateCategoryBody,
  CreateComponentBody,
  CreatePaymentBody,
  CreateRefundBody,
  CreateStructureBody,
  DashboardQuery,
  DecisionBody,
  DeleteComponentQuery,
  DemandListQuery,
  DiscountBody,
  DuplicateStructureBody,
  ExportParams,
  ExportQuery,
  GenerateDemandsBody,
  IdParams,
  IssueDemandsBody,
  LedgerQuery,
  OutstandingQuery,
  OverdueQuery,
  PaymentListQuery,
  PublishStructureBody,
  ReasonBody,
  ReceiptListQuery,
  RefundListQuery,
  RefundReportQuery,
  StructureListQuery,
  StudentParams,
  UpdateCategoryBody,
  UpdateComponentBody,
  UpdateSettingsBody,
  UpdateStructureBody,
  VerifyPaymentBody,
} from './fees.schemas.js';
import type { PaymentService } from './payments.service.js';
import type { RefundService } from './refunds.service.js';
import type { FeeReportService } from './reports.service.js';
import type { Caller } from './support.js';

const caller = (req: Request): Caller => ({
  tenantId: req.ctx.tenant!.tenantId,
  principal: req.ctx.principal!,
  actor: actorFrom(req.ctx),
  features: req.ctx.tenant!.entitlements.features,
});

const csv = (res: Response, filename: string, body: string) => {
  res
    .status(200)
    .type('text/csv')
    .set('Content-Disposition', `attachment; filename="${filename}"`)
    .send(body);
};

const T_CFG = ['School · Fee settings and categories'];
const T_STR = ['School · Fee structures'];
const T_ASN = ['School · Fee assignments'];
const T_DEM = ['School · Fee demands'];
const T_ADJ = ['School · Fee concessions and waivers'];
const T_PAY = ['School · Fee payments and receipts'];
const T_REF = ['School · Fee refunds'];
const T_REP = ['School · Fee reports'];
const T_REC = ['School · Fee bank reconciliation'];
const T_ARR = ['School · Fee arrears and payment plans'];

export interface FeeServices {
  documents: FeeDocumentService;
  reconciliation: ReconciliationService;
  arrears: ArrearsService;
  config: FeeConfigService;
  assignments: AssignmentService;
  demands: DemandService;
  adjustments: AdjustmentService;
  payments: PaymentService;
  refunds: RefundService;
  reports: FeeReportService;
}

export function feeRoutes(s: FeeServices) {
  const { config, assignments, demands, adjustments, payments, refunds, reports, documents } = s;
  const { reconciliation, arrears } = s;
  return [
    // ---- Settings and categories ---------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/fees/settings',
      summary:
        'School fee settings: currency and the late fee rule (created with defaults on first use)',
      tags: T_CFG,
      access: 'tenant',
      permissions: ['fees.read'],
      handler: async ({ req }) => ({ data: await config.getSettings(caller(req)) }),
    }),
    defineRoute({
      method: 'patch',
      path: '/fees/settings',
      summary: 'Update the fee settings (send the version you read)',
      tags: T_CFG,
      access: 'tenant',
      permissions: ['fees.settings.manage'],
      body: UpdateSettingsBody,
      handler: async ({ body, req }) => ({ data: await config.updateSettings(caller(req), body) }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/categories',
      summary: 'List fee categories. Filter: status, search',
      tags: T_CFG,
      access: 'tenant',
      permissions: ['fees.read'],
      query: CategoryListQuery,
      handler: async ({ query, req }) => config.listCategories(caller(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/categories',
      summary: 'Create a fee category',
      tags: T_CFG,
      access: 'tenant',
      permissions: ['fees.settings.manage'],
      body: CreateCategoryBody,
      status: 201,
      handler: async ({ body, req }) => ({ data: await config.createCategory(caller(req), body) }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/categories/:id',
      summary: 'One fee category',
      tags: T_CFG,
      access: 'tenant',
      permissions: ['fees.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await config.getCategory(caller(req), params.id),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/fees/categories/:id',
      summary: 'Edit a fee category (send the version you read)',
      tags: T_CFG,
      access: 'tenant',
      permissions: ['fees.settings.manage'],
      params: IdParams,
      body: UpdateCategoryBody,
      handler: async ({ params, body, req }) => ({
        data: await config.updateCategory(caller(req), params.id, body),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/categories/:id/deactivate',
      summary: 'Deactivate a category (no new structures use it; existing demands keep it)',
      tags: T_CFG,
      access: 'tenant',
      permissions: ['fees.settings.manage'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await config.setCategoryState(caller(req), params.id, 'INACTIVE'),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/categories/:id/activate',
      summary: 'Reactivate a category',
      tags: T_CFG,
      access: 'tenant',
      permissions: ['fees.settings.manage'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await config.setCategoryState(caller(req), params.id, 'ACTIVE'),
      }),
    }),

    // ---- Structures and components ------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/fees/structures',
      summary: 'List fee structures. Filter: status, academic_year_id, class_id, search',
      tags: T_STR,
      access: 'tenant',
      permissions: ['fees.read'],
      query: StructureListQuery,
      handler: async ({ query, req }) => config.listStructures(caller(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/structures',
      summary: 'Create a DRAFT fee structure (version 1 of its code)',
      tags: T_STR,
      access: 'tenant',
      permissions: ['fees.manage'],
      body: CreateStructureBody,
      status: 201,
      handler: async ({ body, req }) => ({ data: await config.createStructure(caller(req), body) }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/structures/:id',
      summary: 'One fee structure with its components',
      tags: T_STR,
      access: 'tenant',
      permissions: ['fees.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await config.getStructure(caller(req), params.id),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/fees/structures/:id',
      summary:
        'Edit a DRAFT structure. Published structures are immutable: duplicate them instead.',
      tags: T_STR,
      access: 'tenant',
      permissions: ['fees.manage'],
      params: IdParams,
      body: UpdateStructureBody,
      handler: async ({ params, body, req }) => ({
        data: await config.updateStructure(caller(req), params.id, body),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/structures/:id/components',
      summary: 'Add a component to a DRAFT structure',
      tags: T_STR,
      access: 'tenant',
      permissions: ['fees.manage'],
      params: IdParams,
      body: CreateComponentBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await config.createComponent(caller(req), params.id, body),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/components/:id',
      summary: 'One fee component',
      tags: T_STR,
      access: 'tenant',
      permissions: ['fees.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await config.getComponent(caller(req), params.id),
      }),
    }),
    defineRoute({
      method: 'patch',
      path: '/fees/components/:id',
      summary: 'Edit a component of a DRAFT structure',
      tags: T_STR,
      access: 'tenant',
      permissions: ['fees.manage'],
      params: IdParams,
      body: UpdateComponentBody,
      handler: async ({ params, body, req }) => ({
        data: await config.updateComponent(caller(req), params.id, body),
      }),
    }),
    defineRoute({
      method: 'delete',
      path: '/fees/components/:id',
      summary: 'Remove a component from a DRAFT structure',
      tags: T_STR,
      access: 'tenant',
      permissions: ['fees.manage'],
      params: IdParams,
      query: DeleteComponentQuery,
      handler: async ({ params, query, req }) => {
        await config.deleteComponent(caller(req), params.id, query.version);
        return undefined;
      },
    }),
    defineRoute({
      method: 'post',
      path: '/fees/structures/:id/publish',
      summary:
        'Publish a DRAFT structure: it becomes immutable and the previously published version of the same code and class is archived',
      tags: T_STR,
      access: 'tenant',
      permissions: ['fees.structures.publish'],
      params: IdParams,
      body: PublishStructureBody,
      handler: async ({ params, body, req }) => ({
        data: await config.publish(caller(req), params.id, body),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/structures/:id/archive',
      summary: 'Archive a structure (existing assignments and demands are untouched)',
      tags: T_STR,
      access: 'tenant',
      permissions: ['fees.structures.publish'],
      params: IdParams,
      body: ArchiveStructureBody,
      handler: async ({ params, body, req }) => ({
        data: await config.archive(caller(req), params.id, body),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/structures/:id/duplicate',
      summary: 'Copy a structure (with components) as a new DRAFT version of the same code',
      tags: T_STR,
      access: 'tenant',
      permissions: ['fees.manage'],
      params: IdParams,
      body: DuplicateStructureBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await config.duplicate(caller(req), params.id, body),
      }),
    }),

    // ---- Assignments and demand generation -----------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/fees/assignments',
      summary: 'List student fee assignments (student scope applies)',
      tags: T_ASN,
      access: 'tenant',
      permissions: ['fees.read'],
      query: AssignmentListQuery,
      handler: async ({ query, req }) => assignments.list(caller(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/assignments',
      summary: 'Assign a published structure to one enrolled student',
      tags: T_ASN,
      access: 'tenant',
      permissions: ['fees.manage'],
      body: CreateAssignmentBody,
      status: 201,
      handler: async ({ body, req }) => ({ data: await assignments.create(caller(req), body) }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/assignments/bulk',
      summary: 'Assign a published structure to every student of a section or class (idempotent)',
      tags: T_ASN,
      access: 'tenant',
      permissions: ['fees.manage'],
      body: BulkAssignBody,
      handler: async ({ body, req }) => ({ data: await assignments.bulkAssign(caller(req), body) }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/assignments/generate-demands',
      summary:
        'Generate demands for many assignments (idempotent per assignment, component and period)',
      tags: T_ASN,
      access: 'tenant',
      permissions: ['fees.manage'],
      body: BulkGenerateBody,
      handler: async ({ body, req }) => ({
        data: await assignments.bulkGenerate(caller(req), body),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/assignments/:id',
      summary: 'One assignment',
      tags: T_ASN,
      access: 'tenant',
      permissions: ['fees.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await assignments.get(caller(req), params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/assignments/:id/cancel',
      summary: 'Cancel an assignment (its DRAFT demands are cancelled; issued demands stay)',
      tags: T_ASN,
      access: 'tenant',
      permissions: ['fees.manage'],
      params: IdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await assignments.cancel(caller(req), params.id, body.reason),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/assignments/:id/preview-demands',
      summary: 'Show the demands that generating would create, without creating them',
      tags: T_ASN,
      access: 'tenant',
      permissions: ['fees.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await assignments.preview(caller(req), params.id),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/assignments/:id/generate-demands',
      summary:
        'Generate the demands of one assignment (idempotent). issue=true issues them immediately.',
      tags: T_ASN,
      access: 'tenant',
      permissions: ['fees.manage'],
      params: IdParams,
      body: GenerateDemandsBody,
      handler: async ({ params, body, req }) => ({
        data: await assignments.generate(caller(req), params.id, body),
      }),
    }),

    // ---- Demands ----------------------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/fees/students/:id/summary',
      summary: 'Billed, paid and outstanding totals for one student',
      tags: T_DEM,
      access: 'tenant',
      permissions: ['fees.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await demands.studentSummary(caller(req), params.id),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/demands',
      summary:
        'List demands (effective status: past-due ISSUED and PARTIALLY_PAID read as OVERDUE)',
      tags: T_DEM,
      access: 'tenant',
      permissions: ['fees.read'],
      query: DemandListQuery,
      handler: async ({ query, req }) => demands.list(caller(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/demands/issue',
      summary: 'Issue many DRAFT demands',
      tags: T_DEM,
      access: 'tenant',
      permissions: ['fees.manage'],
      body: IssueDemandsBody,
      handler: async ({ body, req }) => ({ data: await demands.issueMany(caller(req), body) }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/demands/apply-late-fees',
      summary: 'Apply the late fee rule to overdue demands (all of them, or the ones listed)',
      tags: T_DEM,
      access: 'tenant',
      permissions: ['fees.manage'],
      body: ApplyLateFeesBody,
      handler: async ({ body, req }) => ({ data: await demands.applyLateFees(caller(req), body) }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/demands/mark-overdue',
      summary: 'Persist the OVERDUE status on demands past their due date (safe to run repeatedly)',
      tags: T_DEM,
      access: 'tenant',
      permissions: ['fees.manage'],
      handler: async ({ req }) => {
        const c = caller(req);
        return { data: await demands.sweepOverdue(c.tenantId, c.actor) };
      },
    }),
    defineRoute({
      method: 'get',
      path: '/fees/demands/:id',
      summary: 'One demand with its allocations and adjustments',
      tags: T_DEM,
      access: 'tenant',
      permissions: ['fees.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await demands.get(caller(req), params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/demands/:id/issue',
      summary: 'Issue a DRAFT demand',
      tags: T_DEM,
      access: 'tenant',
      permissions: ['fees.manage'],
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await demands.issue(caller(req), params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/demands/:id/cancel',
      summary: 'Cancel a demand that has no payments (reason required)',
      tags: T_DEM,
      access: 'tenant',
      permissions: ['fees.manage'],
      params: IdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await demands.cancel(caller(req), params.id, body.reason, body.version),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/demands/:id/write-off',
      summary: 'Write off the outstanding balance (reason required)',
      tags: T_DEM,
      access: 'tenant',
      permissions: ['fees.waivers.approve'],
      params: IdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await demands.writeOff(caller(req), params.id, body.reason, body.version),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/demands/:id/discount',
      summary: 'Apply a direct discount (fixed amount or percent) to an open demand',
      tags: T_DEM,
      access: 'tenant',
      permissions: ['fees.waivers.approve'],
      params: IdParams,
      body: DiscountBody,
      handler: async ({ params, body, req }) => ({
        data: await demands.discount(caller(req), params.id, body),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/demands/:id/late-fee',
      summary: 'Apply the late fee rule to one overdue demand',
      tags: T_DEM,
      access: 'tenant',
      permissions: ['fees.manage'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await demands.applyLateFee(caller(req), params.id),
      }),
    }),

    // ---- Concessions and waivers ------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/fees/adjustments',
      summary: 'List concession and waiver requests. Filter: type, status, student_id',
      tags: T_ADJ,
      access: 'tenant',
      permissions: ['fees.read'],
      query: AdjustmentListQuery,
      handler: async ({ query, req }) => adjustments.list(caller(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/adjustments',
      summary: 'Request a concession or waiver on a demand (approval is a separate step)',
      tags: T_ADJ,
      access: 'tenant',
      permissions: ['fees.concessions.request'],
      body: CreateAdjustmentBody,
      status: 201,
      handler: async ({ body, req }) => ({ data: await adjustments.request(caller(req), body) }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/adjustments/:id',
      summary: 'One adjustment request',
      tags: T_ADJ,
      access: 'tenant',
      permissions: ['fees.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await adjustments.get(caller(req), params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/adjustments/:id/approve',
      summary: 'Approve a request. The approver must not be the requester.',
      tags: T_ADJ,
      access: 'tenant',
      permissions: ['fees.waivers.approve'],
      params: IdParams,
      body: DecisionBody,
      handler: async ({ params, body, req }) => ({
        data: await adjustments.approve(caller(req), params.id, body, body.version),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/adjustments/:id/reject',
      summary: 'Reject a request (reason required)',
      tags: T_ADJ,
      access: 'tenant',
      permissions: ['fees.waivers.approve'],
      params: IdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await adjustments.reject(caller(req), params.id, body.reason),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/adjustments/:id/apply',
      summary: 'Apply an approved adjustment to its demand (reduces the amount due)',
      tags: T_ADJ,
      access: 'tenant',
      permissions: ['fees.waivers.approve'],
      params: IdParams,
      body: DecisionBody,
      handler: async ({ params, body, req }) => ({
        data: await adjustments.apply(caller(req), params.id, body.version),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/adjustments/:id/cancel',
      summary: 'Withdraw a request that is not applied yet (requester or approver)',
      tags: T_ADJ,
      access: 'tenant',
      permissions: ['fees.read'],
      params: IdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await adjustments.cancel(caller(req), params.id, body.reason),
      }),
    }),

    // ---- Payments and receipts -------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/fees/payments',
      summary: 'List payments. Filter: student_id, status, method, from, to',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.read'],
      query: PaymentListQuery,
      handler: async ({ query, req }) => payments.list(caller(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/payments',
      summary:
        'Record a payment (201). Retrying the same idempotency_key or provider_reference returns the original payment (200, meta.replayed=true). RECEIVED payments get a receipt; an optional allocation applies it to demands in the same call.',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.payments.create'],
      body: CreatePaymentBody,
      handler: async ({ body, req, res }) => {
        const out = await payments.create(caller(req), body);
        res.status(out.replayed ? 200 : 201).json({
          data: out.payment,
          ...(out.replayed ? { meta: { replayed: true } } : {}),
        });
        return undefined;
      },
    }),
    defineRoute({
      method: 'get',
      path: '/fees/payments/:id',
      summary:
        'One payment with allocations, receipts, refunds and the amount still available to allocate',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await payments.get(caller(req), params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/payments/:id/receive',
      summary: 'PENDING to RECEIVED (e.g. cheque cleared): issues the receipt',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.payments.create'],
      params: IdParams,
      body: DecisionBody,
      handler: async ({ params, body, req }) => ({
        data: await payments.receive(caller(req), params.id, body.version),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/payments/:id/verify',
      summary: 'Verify a RECEIVED payment (bank or reconciliation check)',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.payments.verify'],
      params: IdParams,
      body: VerifyPaymentBody,
      handler: async ({ params, body, req }) => ({
        data: await payments.verify(caller(req), params.id, body.note, body.version),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/payments/:id/fail',
      summary: 'Mark a PENDING payment as FAILED (bounced cheque, declined card)',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.payments.verify'],
      params: IdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await payments.fail(caller(req), params.id, body.reason),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/payments/:id/cancel',
      summary: 'Cancel a payment recorded in error: reverses its allocations and voids its receipt',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.payments.verify'],
      params: IdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await payments.cancel(caller(req), params.id, body.reason),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/payments/:id/allocate',
      summary:
        'Allocate a payment to demands. mode AUTO: oldest due date first. mode MANUAL: explicit amounts. Never exceeds the outstanding balance or the payment amount.',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.payments.create'],
      params: IdParams,
      body: AllocateBody,
      handler: async ({ params, body, req }) => ({
        data: await payments.allocate(caller(req), params.id, body),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/payments/:id/allocations/:allocation_id/reverse',
      summary: 'Reverse one allocation: the demand balance is reopened',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.payments.verify'],
      params: AllocationParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await payments.reverseAllocation(
          caller(req),
          params.id,
          params.allocation_id,
          body.reason,
        ),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/receipts',
      summary: 'List receipts. Filter: student_id, status, from, to',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.read'],
      query: ReceiptListQuery,
      handler: async ({ query, req }) => payments.listReceipts(caller(req), query),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/receipts/:id',
      summary: 'One receipt with its allocation lines',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await payments.getReceipt(caller(req), params.id),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/payments/:id/receipt',
      summary: 'Issue the receipt of a RECEIVED or VERIFIED payment that has none (idempotent)',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.payments.create'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await payments.issueReceiptFor(caller(req), params.id),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/receipts/:id/pdf',
      summary: 'Printable PDF of a receipt (a voided receipt is marked VOID)',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.read'],
      params: IdParams,
      handler: async ({ params, req, res }) => {
        const f = await documents.receiptPdf(caller(req), params.id);
        res
          .status(200)
          .set({
            'Content-Type': 'application/pdf',
            'Content-Length': String(f.data.length),
            'Content-Disposition': `inline; filename="${f.filename}"`,
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
          })
          .end(f.data);
        return undefined;
      },
    }),
    defineRoute({
      method: 'get',
      path: '/fees/payments/:id/proofs',
      summary: 'Proof-of-payment files attached to a payment',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await documents.listProofs(caller(req), params.id),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/payments/:id/proofs',
      summary:
        'Attach proof of payment (PNG, JPEG, WebP or PDF, up to 5 MB): the EFT confirmation, card slip or signed cash receipt. Raw body plus ?filename=.',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.payments.create'],
      params: IdParams,
      query: PhotoUploadQuery,
      body: z.any(),
      handler: async ({ params, query, body, req }) => ({
        data: await documents.addProof(caller(req), params.id, {
          data: body,
          filename: query.filename,
        }),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/payments/:id/proofs/:proof_id/file',
      summary: 'Download one proof-of-payment file',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.read'],
      params: z.object({ id: z.uuid(), proof_id: z.uuid() }),
      handler: async ({ params, req, res }) => {
        const f = await documents.readProof(caller(req), params.id, params.proof_id);
        res.status(200).set(fileHeaders(f)).end(f.data);
        return undefined;
      },
    }),
    defineRoute({
      method: 'post',
      path: '/fees/receipts/:id/void',
      summary: 'Void a receipt (reason required). The receipt number is never reused.',
      tags: T_PAY,
      access: 'tenant',
      permissions: ['fees.payments.verify'],
      params: IdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await payments.voidReceipt(caller(req), params.id, body.reason),
      }),
    }),

    // ---- Bank reconciliation -------------------------------------------------------------------------
    defineRoute({
      method: 'post',
      path: '/fees/reconciliation/statements',
      summary:
        'Import a bank statement (CSV, raw body plus ?filename=). Credits become lines; lines already imported are skipped; matching runs straight away.',
      tags: T_REC,
      access: 'tenant',
      permissions: ['fees.reconcile'],
      query: StatementUploadQuery,
      body: z.any(),
      status: 201,
      handler: async ({ query, body, req }) => ({
        data: await reconciliation.importStatement(caller(req), {
          text: Buffer.isBuffer(body) ? body.toString('utf8') : '',
          filename: query.filename,
        }),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/reconciliation/statements',
      summary: 'Imported bank statements with how many lines are still open',
      tags: T_REC,
      access: 'tenant',
      permissions: ['fees.reconcile'],
      handler: async ({ req }) => ({ data: await reconciliation.statements(caller(req)) }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/reconciliation/summary',
      summary: 'Counts and amounts: lines by status and payments still waiting for the bank',
      tags: T_REC,
      access: 'tenant',
      permissions: ['fees.reconcile'],
      handler: async ({ req }) => ({ data: await reconciliation.summary(caller(req)) }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/reconciliation/lines',
      summary: 'Bank statement lines, filterable by status and statement',
      tags: T_REC,
      access: 'tenant',
      permissions: ['fees.reconcile'],
      query: BankLineListQuery,
      handler: async ({ query, req }) => reconciliation.lines(caller(req), query),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/reconciliation/unconfirmed-payments',
      summary: 'Recorded payments not yet tied to a bank line',
      tags: T_REC,
      access: 'tenant',
      permissions: ['fees.reconcile'],
      query: UnconfirmedPaymentsQuery,
      handler: async ({ query, req }) => reconciliation.unconfirmedPayments(caller(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/reconciliation/rematch',
      summary: 'Run matching again over every open line',
      tags: T_REC,
      access: 'tenant',
      permissions: ['fees.reconcile'],
      handler: async ({ req }) => ({ data: await reconciliation.rematch(caller(req)) }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/reconciliation/lines/:id/confirm',
      summary: 'Tie a line to a recorded payment of exactly the same amount',
      tags: T_REC,
      access: 'tenant',
      permissions: ['fees.reconcile'],
      params: LineParams,
      body: ConfirmLineBody,
      handler: async ({ params, body, req }) => ({
        data: await reconciliation.confirm(caller(req), params.id, body),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/reconciliation/lines/:id/record',
      summary: 'Record the payment for a line that has no payment yet, against a ltudent',
      tags: T_REC,
      access: 'tenant',
      permissions: ['fees.reconcile', 'fees.payments.create'],
      params: LineParams,
      body: RecordLineBody,
      handler: async ({ params, body, req }) => ({
        data: await reconciliation.recordFromLine(caller(req), params.id, body),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/reconciliation/lines/:id/ignore',
      summary: 'Mark a line as not school money (reason required)',
      tags: T_REC,
      access: 'tenant',
      permissions: ['fees.reconcile'],
      params: LineParams,
      body: IgnoreLineBody,
      handler: async ({ params, body, req }) => ({
        data: await reconciliation.ignore(caller(req), params.id, body),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/reconciliation/lines/:id/reopen',
      summary: 'Put an ignored line back in the review queue',
      tags: T_REC,
      access: 'tenant',
      permissions: ['fees.reconcile'],
      params: LineParams,
      handler: async ({ params, req }) => ({
        data: await reconciliation.reopen(caller(req), params.id),
      }),
    }),

    // ---- Arrears, reminders and payment plans -----------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/fees/arrears',
      summary:
        'Ltudents with overdue fees, each with the next step on the reminder ladder. Also closes plans that were completed or missed.',
      tags: T_ARR,
      access: 'tenant',
      permissions: ['fees.arrears.manage'],
      query: ArrearsQuery,
      handler: async ({ query, req }) => arrears.arrears(caller(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/arrears/reminders/run',
      summary:
        'Record the first and second reminders that have fallen due (dry_run to preview). Emits fee_reminder.recorded for the messaging service.',
      tags: T_ARR,
      access: 'tenant',
      permissions: ['fees.arrears.manage'],
      body: RunRemindersBody,
      handler: async ({ body, req }) => ({ data: await arrears.runReminders(caller(req), body) }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/arrears/:student_id/reminders',
      summary: 'Every ladder step recorded for a ltudent',
      tags: T_ARR,
      access: 'tenant',
      permissions: ['fees.arrears.manage'],
      params: StudentParams,
      handler: async ({ params, req }) => arrears.history(caller(req), params.student_id),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/arrears/:student_id/reminders',
      summary:
        'Record the next ladder step by hand. A letter of demand or handover needs fees.arrears.escalate.',
      tags: T_ARR,
      access: 'tenant',
      permissions: ['fees.arrears.manage'],
      params: StudentParams,
      body: RecordReminderBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await arrears.recordReminder(caller(req), params.student_id, body),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/payment-plans',
      summary: 'Payment plans with each instalment marked paid, upcoming or missed',
      tags: T_ARR,
      access: 'tenant',
      permissions: ['fees.arrears.manage'],
      query: PlanListQuery,
      handler: async ({ query, req }) => arrears.plans(caller(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/payment-plans',
      summary:
        'Create a plan for overdue fees (2-6 instalments; more needs fees.arrears.escalate). Late fees stop while a plan is active.',
      tags: T_ARR,
      access: 'tenant',
      permissions: ['fees.arrears.manage'],
      body: CreatePlanBody,
      status: 201,
      handler: async ({ body, req }) => ({ data: await arrears.createPlan(caller(req), body) }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/payment-plans/:id',
      summary: 'One payment plan',
      tags: T_ARR,
      access: 'tenant',
      permissions: ['fees.arrears.manage'],
      params: PlanParams,
      handler: async ({ params, req }) => ({ data: await arrears.getPlan(caller(req), params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/payment-plans/:id/cancel',
      summary: 'Cancel an active plan (reason required)',
      tags: T_ARR,
      access: 'tenant',
      permissions: ['fees.arrears.manage'],
      params: PlanParams,
      body: CancelPlanBody,
      handler: async ({ params, body, req }) => ({
        data: await arrears.cancelPlan(caller(req), params.id, body),
      }),
    }),

    // ---- Refunds ------------------------------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/fees/refunds',
      summary: 'List refunds. Filter: status, student_id, payment_id',
      tags: T_REF,
      access: 'tenant',
      permissions: ['fees.read'],
      query: RefundListQuery,
      handler: async ({ query, req }) => refunds.list(caller(req), query),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/refunds',
      summary: 'Request a refund of part or all of a payment',
      tags: T_REF,
      access: 'tenant',
      permissions: ['fees.refunds.request'],
      body: CreateRefundBody,
      status: 201,
      handler: async ({ body, req }) => ({ data: await refunds.request(caller(req), body) }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/refunds/:id',
      summary: 'One refund',
      tags: T_REF,
      access: 'tenant',
      permissions: ['fees.read'],
      params: IdParams,
      handler: async ({ params, req }) => ({ data: await refunds.get(caller(req), params.id) }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/refunds/:id/approve',
      summary: 'Approve a refund request. The approver must not be the requester.',
      tags: T_REF,
      access: 'tenant',
      permissions: ['fees.refunds.approve'],
      params: IdParams,
      body: DecisionBody,
      handler: async ({ params, body, req }) => ({
        data: await refunds.approve(caller(req), params.id, body, body.version),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/refunds/:id/reject',
      summary: 'Reject a refund request (it ends CANCELLED with the reason)',
      tags: T_REF,
      access: 'tenant',
      permissions: ['fees.refunds.approve'],
      params: IdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await refunds.reject(caller(req), params.id, body.reason),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/refunds/:id/cancel',
      summary: 'Withdraw a refund that is not processing yet (requester or approver)',
      tags: T_REF,
      access: 'tenant',
      permissions: ['fees.read'],
      params: IdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await refunds.cancel(caller(req), params.id, body.reason),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/refunds/:id/process',
      summary: 'APPROVED to PROCESSING: the money is being paid out',
      tags: T_REF,
      access: 'tenant',
      permissions: ['fees.refunds.approve'],
      params: IdParams,
      handler: async ({ params, req }) => ({
        data: await refunds.startProcessing(caller(req), params.id),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/refunds/:id/complete',
      summary:
        'PROCESSING to COMPLETED: reverses allocations (unallocated money first, then newest allocations), reopens demand balances and updates the payment status',
      tags: T_REF,
      access: 'tenant',
      permissions: ['fees.refunds.approve'],
      params: IdParams,
      body: CompleteRefundBody,
      handler: async ({ params, body, req }) => ({
        data: await refunds.complete(caller(req), params.id, body),
      }),
    }),
    defineRoute({
      method: 'post',
      path: '/fees/refunds/:id/fail',
      summary: 'Mark a refund FAILED (reason required). Nothing is reversed.',
      tags: T_REF,
      access: 'tenant',
      permissions: ['fees.refunds.approve'],
      params: IdParams,
      body: ReasonBody,
      handler: async ({ params, body, req }) => ({
        data: await refunds.fail(caller(req), params.id, body.reason),
      }),
    }),

    // ---- Reports, dashboard, exports --------------------------------------------------------------
    defineRoute({
      method: 'get',
      path: '/fees/dashboard',
      summary: 'Fee dashboard: billed, collected, outstanding, overdue, pending items',
      tags: T_REP,
      access: 'tenant',
      permissions: ['fees.read'],
      query: DashboardQuery,
      handler: async ({ query, req }) => ({ data: await reports.dashboard(caller(req), query) }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/students/:student_id/ledger',
      summary: 'Student fee ledger: demands, payments, allocations, refunds and running balance',
      tags: T_REP,
      access: 'tenant',
      permissions: ['fees.read'],
      params: StudentParams,
      query: LedgerQuery,
      handler: async ({ params, query, req }) => ({
        data: await reports.ledger(caller(req), params.student_id, query),
      }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/reports/outstanding',
      summary: 'Outstanding balance per student',
      tags: T_REP,
      access: 'tenant',
      permissions: ['fees.read'],
      query: OutstandingQuery,
      handler: async ({ query, req }) => reports.outstanding(caller(req), query),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/reports/overdue',
      summary: 'Overdue demands with days overdue',
      tags: T_REP,
      access: 'tenant',
      permissions: ['fees.read'],
      query: OverdueQuery,
      handler: async ({ query, req }) => reports.overdue(caller(req), query),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/reports/by-class',
      summary:
        'Billed, collected, outstanding and overdue per class for an academic year (default: the active one)',
      tags: T_REP,
      access: 'tenant',
      permissions: ['fees.read'],
      query: DashboardQuery,
      handler: async ({ query, req }) => ({ data: await reports.byClass(caller(req), query) }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/reports/collection',
      summary: 'Collections for a date range: totals, by method and by day',
      tags: T_REP,
      access: 'tenant',
      permissions: ['fees.read'],
      query: CollectionQuery,
      handler: async ({ query, req }) => ({ data: await reports.collection(caller(req), query) }),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/reports/concessions',
      summary: 'Concessions, waivers and discounts given',
      tags: T_REP,
      access: 'tenant',
      permissions: ['fees.read'],
      query: ConcessionReportQuery,
      handler: async ({ query, req }) => reports.concessions(caller(req), query),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/reports/refunds',
      summary: 'Refunds by status with totals',
      tags: T_REP,
      access: 'tenant',
      permissions: ['fees.read'],
      query: RefundReportQuery,
      handler: async ({ query, req }) => reports.refunds(caller(req), query),
    }),
    defineRoute({
      method: 'get',
      path: '/fees/reports/:report/export',
      summary:
        'CSV export of demands, payments, outstanding, collection, overdue, concessions or refunds (audited). Same filters as the report.',
      tags: T_REP,
      access: 'tenant',
      permissions: ['fees.read', 'fees.export'],
      params: ExportParams,
      query: ExportQuery,
      handler: async ({ params, query, req, res }) => {
        const out = await reports.exportCsv(caller(req), params.report, query);
        csv(res, out.filename, out.body);
        return undefined;
      },
    }),
  ];
}
