import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, uniq, type Api, type Harness } from "../helpers.js";

let h: Harness;
let api: Api;

const DAY = 86_400_000;
const daysAgo = (n: number) =>
  new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const inDays = (n: number) =>
  new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
function ok<T = Json>(res: { status: number; body: Json }, status = 200) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
}
const cents = (v: string) => Math.round(Number(v) * 100);
const sum = (rows: Json[], k: string) =>
  rows.reduce((t, r) => t + cents(r[k]), 0);

let yearId: string;
let g8: string;
let g9: string;
let secA: string;

async function enrol(classId: string, section?: string) {
  const res = await api.post("/students", {
    first_name: "Plan",
    last_name: uniq("Kid"),
    gender: "FEMALE",
    enrollment: {
      academic_year_id: yearId,
      class_id: classId,
      ...(section ? { section_id: section } : {}),
    },
  });
  return ok(res, 201) as { id: string };
}
const account = async (id: string) => ok(await api.get(`/fees/learners/${id}`));

let early: { id: string };
let late: { id: string };

beforeAll(async () => {
  h = await createHarness();
  const A = await h.provisionSchool();
  api = A.admin.api;
  const y = ok(
    await api.post("/academic-years", {
      code: "Y-PLAN",
      name: "Year Plan",
      start_date: daysAgo(200),
      end_date: inDays(150),
    }),
    201,
  );
  ok(
    await api.post(`/academic-years/${y.id}/activate`, {
      complete_current: true,
    }),
  );
  yearId = y.id;
  g8 = ok(
    await api.post("/academic-classes", {
      code: "G8",
      name: "Grade 8",
      sequence: 8,
    }),
    201,
  ).id;
  g9 = ok(
    await api.post("/academic-classes", {
      code: "G9",
      name: "Grade 9",
      sequence: 9,
    }),
    201,
  ).id;
  secA = ok(
    await api.post(`/academic-years/${yearId}/sections`, {
      class_id: g8,
      code: "A",
      name: "A",
    }),
    201,
  ).id;
  // Annual payers must pay by 10 days from now (so the discount still applies in these tests).
  ok(
    await api.patch("/fees/plan-settings", {
      annual_pay_by: inDays(10).slice(5),
    }),
  );
  early = await enrol(g8, secA);
  late = await enrol(g8, secA);
}, 120_000);
afterAll(() => h.close());

describe("grade fees and learner plans", () => {
  it("setting a grade fee bills enrolled learners on the monthly plan, 11 instalments summing to the fee", async () => {
    const res = ok(
      await api.put("/fees/grade-fees", {
        fees: [{ class_id: g8, annual_fee: "36000" }],
      }),
    );
    expect(res.created).toBe(1);
    expect(res.learners_billed).toBe(2);
    const g = res.grades.find((x: Json) => x.class_id === g8);
    expect(g.annual_fee).toBe("36000.00");
    expect(g.plans.find((p: Json) => p.plan === "MONTHLY")).toMatchObject({
      instalments: 11,
      amount: "3273.00",
      learners: 2,
    });
    expect(g.plans.find((p: Json) => p.plan === "ANNUAL").amount).toBe(
      "34200.00",
    );

    const acc = await account(early.id);
    expect(acc.plan).toBe("MONTHLY");
    expect(acc.annual_fee).toBe("36000.00");
    expect(acc.instalments).toHaveLength(11);
    expect(acc.instalments[0].amount).toBe("3273.00");
    expect(acc.instalments[10].amount).toBe("3270.00");
    expect(sum(acc.instalments, "amount")).toBe(3_600_000);
    expect(acc.totals.instalments_behind).toBeGreaterThan(0);
    expect(acc.status).toBe("OVERDUE");
    expect(acc.plan_options.map((p: Json) => p.plan)).toEqual([
      "MONTHLY",
      "TERMLY",
      "ANNUAL",
    ]);
  });

  it("setting the same fee again changes nothing", async () => {
    const res = ok(
      await api.put("/fees/grade-fees", {
        fees: [{ class_id: g8, annual_fee: "36000.00" }],
      }),
    );
    expect(res.unchanged).toBe(1);
  });

  it("a new learner in the grade is billed automatically on enrolment", async () => {
    const s = await enrol(g8, secA);
    const acc = await account(s.id);
    expect(acc.plan).toBe("MONTHLY");
    expect(sum(acc.instalments, "original_amount")).toBe(3_600_000);
  });

  it("switching to annual before paying gives one discounted instalment", async () => {
    const acc = ok(
      await api.post(`/fees/learners/${early.id}/plan`, { plan: "ANNUAL" }),
    );
    expect(acc.plan).toBe("ANNUAL");
    expect(acc.instalments).toHaveLength(1);
    expect(acc.instalments[0]).toMatchObject({
      original_amount: "36000.00",
      discount_amount: "1800.00",
      amount: "34200.00",
      state: "UPCOMING",
    });
    expect(acc.status).toBe("UP_TO_DATE");
  });

  it("a payment settles instalments oldest first and issues a receipt", async () => {
    const pay = ok(
      await api.post("/fees/payments", {
        student_id: early.id,
        amount: "34200.00",
        method: "BANK_TRANSFER",
        provider_reference: uniq("EFT"),
        allocation: { mode: "AUTO" },
      }),
      201,
    );
    expect(pay.status).toBe("RECEIVED");
    const acc = await account(early.id);
    expect(acc.instalments[0].state).toBe("PAID");
    expect(acc.totals.owing_now).toBe("0.00");
    expect(acc.payments[0].receipt_number).toBeTruthy();
  });

  it("a monthly learner who paid two instalments keeps them when changing plan; the rest is re-split", async () => {
    const first = (await account(late.id)).instalments[0];
    ok(
      await api.post("/fees/payments", {
        student_id: late.id,
        amount: String(Number(first.amount) * 2),
        method: "CASH",
        allocation: { mode: "AUTO" },
      }),
      201,
    );
    const acc = ok(
      await api.post(`/fees/learners/${late.id}/plan`, { plan: "TERMLY" }),
    );
    expect(acc.plan).toBe("TERMLY");
    const paid = acc.instalments.filter((i: Json) => i.state === "PAID");
    expect(paid).toHaveLength(2);
    expect(sum(acc.instalments, "original_amount")).toBe(3_600_000);
    expect(
      acc.instalments.every(
        (i: Json) => i.state === "PAID" || i.due_date >= acc.today,
      ),
    ).toBe(true);
  });

  it("changing the grade fee re-splits what learners still owe at the new fee", async () => {
    const res = ok(
      await api.put("/fees/grade-fees", {
        fees: [{ class_id: g8, annual_fee: "38000" }],
      }),
    );
    expect(res.updated).toBe(1);
    expect(res.learners_resplit).toBe(3);
    const acc = await account(late.id);
    expect(acc.annual_fee).toBe("38000.00");
    expect(sum(acc.instalments, "original_amount")).toBe(3_800_000);
    // The annual payer who paid in full now owes the 2 000 difference.
    const e = await account(early.id);
    expect(sum(e.instalments, "original_amount")).toBe(3_800_000);
  });

  it("adds a one-off charge to the learner account", async () => {
    const acc = ok(
      await api.post(`/fees/learners/${late.id}/charges`, {
        name: "Museum trip",
        amount: "250",
        due_date: inDays(5),
      }),
      201,
    );
    expect(acc.charges).toHaveLength(1);
    expect(acc.charges[0]).toMatchObject({
      label: "Museum trip",
      amount: "250.00",
      state: "UPCOMING",
    });
    expect(acc.instalments.every((i: Json) => i.label !== "Museum trip")).toBe(
      true,
    );
  });

  it("a learner in a grade with no fee cannot change plan", async () => {
    const s = await enrol(g9);
    const res = await api.post(`/fees/learners/${s.id}/plan`, {
      plan: "TERMLY",
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details.reason).toBe("NO_GRADE_FEE");
  });

  it("tracker shows totals, plan mix, classes and learners overdue first", async () => {
    const t = ok(await api.get("/fees/tracker"));
    expect(t.totals.learners).toBe(4);
    expect(t.plan_mix).toMatchObject({
      MONTHLY: 1,
      TERMLY: 1,
      ANNUAL: 1,
      NONE: 1,
    });
    expect(t.by_class.map((c: Json) => c.label)).toEqual([
      "Grade 8 · A",
      "Grade 9",
    ]);
    expect(t.counts.ALL).toBe(4);
    const ranks = { OVERDUE: 0, PART_PAID: 1, UP_TO_DATE: 2 } as Record<
      string,
      number
    >;
    const order = t.learners.map((l: Json) => ranks[l.status]);
    expect([...order].sort()).toEqual(order);
    const overdue = ok(await api.get("/fees/tracker?status=OVERDUE"));
    expect(overdue.learners.every((l: Json) => l.status === "OVERDUE")).toBe(
      true,
    );
    const filtered = ok(await api.get(`/fees/tracker?class_id=${g9}`));
    expect(filtered.learners).toHaveLength(1);
    const csv = await api.get("/fees/tracker/export");
    expect(csv.status).toBe(200);
  });
});
