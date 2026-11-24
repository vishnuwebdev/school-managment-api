import { describe, expect, it } from "vitest";
import {
  planPeriods,
  resolveMonthDay,
  splitEven,
} from "../../src/modules/fees/schedule.js";

const year = { startDate: "2026-01-01", endDate: "2026-12-31" };
const rules = {
  monthlyInstalments: 11,
  monthlyDueDay: 1,
  termDueDates: null,
  annualPayBy: null,
};

describe("fee plan schedule", () => {
  it("splits into whole units with the last instalment taking the difference", () => {
    const parts = splitEven(3_600_000n, 11);
    expect(parts.slice(0, 10).every((p) => p === 327_300n)).toBe(true);
    expect(parts[10]).toBe(327_000n);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(3_600_000n);
    expect(splitEven(150n, 3).reduce((a, b) => a + b, 0n)).toBe(150n);
    expect(splitEven(150n, 3).every((p) => p > 0n)).toBe(true);
  });

  it("monthly: 11 instalments Jan to Nov on the 1st", () => {
    const p = planPeriods("MONTHLY", rules, year);
    expect(p).toHaveLength(11);
    expect(p[0]).toEqual({
      code: "M01",
      label: "Jan 2026",
      dueDate: "2026-01-01",
    });
    expect(p[10]!.dueDate).toBe("2026-11-01");
  });

  it("termly: every three months by default, or the configured term dates", () => {
    expect(planPeriods("TERMLY", rules, year).map((x) => x.dueDate)).toEqual([
      "2026-01-01",
      "2026-04-01",
      "2026-07-01",
      "2026-10-01",
    ]);
    const custom = planPeriods(
      "TERMLY",
      { ...rules, termDueDates: ["01-14", "04-08", "07-21", "10-06"] },
      year,
    );
    expect(custom.map((x) => x.dueDate)).toEqual([
      "2026-01-14",
      "2026-04-08",
      "2026-07-21",
      "2026-10-06",
    ]);
  });

  it("annual: by the end of the first month unless set", () => {
    expect(planPeriods("ANNUAL", rules, year)[0]!.dueDate).toBe("2026-01-31");
    expect(
      planPeriods("ANNUAL", { ...rules, annualPayBy: "02-15" }, year)[0]!
        .dueDate,
    ).toBe("2026-02-15");
  });

  it("resolves month-days in a year that crosses the calendar year", () => {
    const y = { startDate: "2026-06-01", endDate: "2027-03-31" };
    expect(resolveMonthDay("01-31", y)).toBe("2027-01-31");
    expect(resolveMonthDay("07-01", y)).toBe("2026-07-01");
    expect(resolveMonthDay("05-01", y)).toBeNull();
  });
});
