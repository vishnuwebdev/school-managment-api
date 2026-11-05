import type { Request } from "express";
import { defineRoute } from "../../http/route.js";
import { actorFrom } from "../../platform/context.js";
import { StudentParams } from "./fees.schemas.js";
import {
  AddChargeBody,
  ChangePlanBody,
  GradeFeesBody,
  PlanSettingsBody,
  TrackerQuery,
  YearQuery,
} from "./learner-fees.schemas.js";
import type { LearnerFeesService } from "./learner-fees.service.js";
import type { Caller } from "./support.js";

const caller = (req: Request): Caller => ({
  tenantId: req.ctx.tenant!.tenantId,
  principal: req.ctx.principal!,
  actor: actorFrom(req.ctx),
  features: req.ctx.tenant!.entitlements.features,
});

const T = ["School · Fees (tracker, fee plans, learner accounts)"];

export function learnerFeeRoutes(svc: LearnerFeesService) {
  return [
    defineRoute({
      method: "get",
      path: "/fees/tracker",
      summary:
        "Fee tracker for a year: due to date, collected, outstanding, plan mix, by class, and learners (overdue first, largest balance first)",
      tags: T,
      access: "tenant",
      permissions: ["fees.read"],
      query: TrackerQuery,
      handler: async ({ query, req }) => ({
        data: await svc.tracker(caller(req), query),
      }),
    }),
    defineRoute({
      method: "get",
      path: "/fees/tracker/export",
      summary: "The tracker learner list as CSV (same filters)",
      tags: T,
      access: "tenant",
      permissions: ["fees.read", "fees.export"],
      query: TrackerQuery,
      handler: async ({ query, req, res }) => {
        const body = await svc.trackerCsv(caller(req), query);
        res
          .status(200)
          .type("text/csv")
          .set("Content-Disposition", 'attachment; filename="fee-tracker.csv"')
          .send(body);
      },
    }),
    defineRoute({
      method: "get",
      path: "/fees/grade-fees",
      summary:
        "Fee plans: the annual fee of every grade, what each plan works out to, and how many learners are on each plan",
      tags: T,
      access: "tenant",
      permissions: ["fees.read"],
      query: YearQuery,
      handler: async ({ query, req }) => ({
        data: await svc.gradeFees(caller(req), query.academic_year_id),
      }),
    }),
    defineRoute({
      method: "put",
      path: "/fees/grade-fees",
      summary:
        "Set grade annual fees. A grade's first fee bills its enrolled learners; a changed fee re-splits what learners still owe (update_existing)",
      tags: T,
      access: "tenant",
      permissions: ["fees.manage"],
      body: GradeFeesBody,
      handler: async ({ body, req }) => ({
        data: await svc.setGradeFees(caller(req), body),
      }),
    }),
    defineRoute({
      method: "patch",
      path: "/fees/plan-settings",
      summary:
        "Payment plan rules: monthly instalments and due day, term dates, annual discount and pay-by date, default plan",
      tags: T,
      access: "tenant",
      permissions: ["fees.settings.manage"],
      body: PlanSettingsBody,
      handler: async ({ body, req }) => ({
        data: await svc.updatePlanSettings(caller(req), body),
      }),
    }),
    defineRoute({
      method: "get",
      path: "/fees/learners/:student_id",
      summary:
        "A learner's fee account: totals, instalment schedule, other charges, payments and plan options",
      tags: T,
      access: "tenant",
      permissions: ["fees.read"],
      params: StudentParams,
      query: YearQuery,
      handler: async ({ params, query, req }) => ({
        data: await svc.account(
          caller(req),
          params.student_id,
          query.academic_year_id,
        ),
      }),
    }),
    defineRoute({
      method: "post",
      path: "/fees/learners/:student_id/plan",
      summary:
        "Change how a learner pays (Monthly / Termly / Annually). Re-splits only what they still owe",
      tags: T,
      access: "tenant",
      permissions: ["fees.manage"],
      params: StudentParams,
      body: ChangePlanBody,
      handler: async ({ params, body, req }) => ({
        data: await svc.changePlan(caller(req), params.student_id, body),
      }),
    }),
    defineRoute({
      method: "post",
      path: "/fees/learners/:student_id/charges",
      summary: "Add a one-off charge (trip, uniform …) to a learner's account",
      tags: T,
      access: "tenant",
      permissions: ["fees.manage"],
      params: StudentParams,
      body: AddChargeBody,
      status: 201,
      handler: async ({ params, body, req }) => ({
        data: await svc.addCharge(caller(req), params.student_id, body),
      }),
    }),
  ];
}
