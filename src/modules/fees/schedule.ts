import type { DueRule, FeeFrequency } from "../../db/schema/index.js";

/** One billing period of a component within an academic year. */
export interface Period {
  key: string;
  label: string;
  /** First day of the period. */
  start: string;
  dueDate: string;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

const addDaysIso = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** The frequencies and rules a component may combine (validated on create, update and publish). */
export function validateDueRule(
  frequency: FeeFrequency,
  rule: DueRule,
): string | null {
  switch (rule.type) {
    case "FIXED_DATE":
      if (frequency !== "ONE_TIME" && frequency !== "ANNUAL")
        return "A fixed due date fits ONE_TIME and ANNUAL fees only; use DAY_OF_MONTH or DAYS_AFTER_PERIOD_START for recurring fees";
      return rule.date ? null : "date is required";
    case "DAY_OF_MONTH":
      if (frequency === "CUSTOM") return "CUSTOM fees use CUSTOM_DATES";
      return rule.day !== undefined && rule.day >= 1 && rule.day <= 28
        ? null
        : "day must be between 1 and 28";
    case "DAYS_AFTER_PERIOD_START":
      if (frequency === "CUSTOM") return "CUSTOM fees use CUSTOM_DATES";
      return rule.days !== undefined && rule.days >= 0 && rule.days <= 366
        ? null
        : "days must be between 0 and 366";
    case "CUSTOM_DATES":
      if (frequency !== "CUSTOM") return "CUSTOM_DATES is for CUSTOM fees only";
      return rule.dates && rule.dates.length >= 1 && rule.dates.length <= 24
        ? null
        : "dates needs 1 to 24 entries";
  }
}

/**
 * The periods a component bills over an academic year, with the due date of each. ONE_TIME and ANNUAL
 * are a single period; MONTHLY / QUARTERLY / HALF_YEARLY walk the year from its first month; CUSTOM
 * is one period per listed date.
 */
export function periodsFor(
  c: { frequency: FeeFrequency; dueRule: DueRule },
  year: { startDate: string; endDate: string },
): Period[] {
  const rule = c.dueRule;
  const startY = Number(year.startDate.slice(0, 4));
  const startM = Number(year.startDate.slice(5, 7));
  const dueOf = (start: string): string => {
    switch (rule.type) {
      case "FIXED_DATE":
        return rule.date!;
      case "DAY_OF_MONTH":
        return `${start.slice(0, 8)}${pad(rule.day!)}`;
      case "DAYS_AFTER_PERIOD_START":
        return addDaysIso(start, rule.days!);
      case "CUSTOM_DATES":
        return start;
    }
  };
  const monthStart = (offset: number) => {
    const total = startM - 1 + offset;
    return { y: startY + Math.floor(total / 12), m: (total % 12) + 1 };
  };
  const walk = (
    step: number,
    count: number,
    keyOf: (i: number, y: number, m: number) => string,
  ) => {
    const out: Period[] = [];
    for (let i = 0; i < count; i++) {
      const { y, m } = monthStart(i * step);
      const first = i === 0 ? year.startDate : iso(y, m, 1);
      if (i > 0 && first > year.endDate) break;
      const last = monthStart(i * step + step - 1);
      const label =
        step === 1
          ? `${MONTHS[m - 1]} ${y}`
          : `${MONTHS[m - 1]} ${y} – ${MONTHS[last.m - 1]} ${last.y}`;
      out.push({
        key: keyOf(i, y, m),
        label,
        start: first,
        dueDate: dueOf(first),
      });
    }
    return out;
  };
  switch (c.frequency) {
    case "ONE_TIME":
      return [
        {
          key: "ONE_TIME",
          label: "One-time",
          start: year.startDate,
          dueDate: dueOf(year.startDate),
        },
      ];
    case "ANNUAL":
      return [
        {
          key: "ANNUAL",
          label: "Annual",
          start: year.startDate,
          dueDate: dueOf(year.startDate),
        },
      ];
    case "MONTHLY":
      return walk(1, 12, (_i, y, m) => `${y}-${pad(m)}`);
    case "QUARTERLY":
      return walk(3, 4, (i) => `${startY}-Q${i + 1}`);
    case "HALF_YEARLY":
      return walk(6, 2, (i) => `${startY}-H${i + 1}`);
    case "CUSTOM":
      return (rule.dates ?? []).map((d, i) => ({
        key: `C${i + 1}`,
        label: `Instalment ${i + 1}`,
        start: d,
        dueDate: d,
      }));
  }
}

// ---- grade-fee payment plans ------------------------------------------------------------------------

export interface PlanRules {
  monthlyInstalments: number;
  monthlyDueDay: number;
  termDueDates: string[] | null;
  annualPayBy: string | null;
}

/** One instalment slot of a payment plan: a stable code (M01, T1, A), a label and the due date. */
export interface PlanPeriod {
  code: string;
  label: string;
  dueDate: string;
}

const lastDayOf = (y: number, m: number) =>
  new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Adds `n` months to (y, m) → [year, month]. */
const plusMonths = (y: number, m: number, n: number): [number, number] => {
  const t = y * 12 + (m - 1) + n;
  return [Math.floor(t / 12), (t % 12) + 1];
};

/** The first date on or after the year start with month-day 'MM-DD', or null if it falls past the year end. */
export function resolveMonthDay(
  md: string,
  year: { startDate: string; endDate: string },
): string | null {
  const m = Number(md.slice(0, 2));
  const d = Number(md.slice(3, 5));
  const y0 = Number(year.startDate.slice(0, 4));
  for (const y of [y0, y0 + 1]) {
    const date = iso(y, m, Math.min(d, lastDayOf(y, m)));
    if (date >= year.startDate) return date <= year.endDate ? date : null;
  }
  return null;
}

export const PLAN_LABELS = {
  MONTHLY: "Monthly",
  TERMLY: "Termly",
  ANNUAL: "Annually",
} as const;

/**
 * The instalments of a plan over an academic year. MONTHLY: `monthlyInstalments` months from the
 * year's first month, due on `monthlyDueDay`. TERMLY: one per term start date (default every three
 * months from the year start). ANNUAL: one, due by `annualPayBy` (default end of the first month).
 */
export function planPeriods(
  plan: "MONTHLY" | "TERMLY" | "ANNUAL",
  rules: PlanRules,
  year: { startDate: string; endDate: string },
): PlanPeriod[] {
  const y0 = Number(year.startDate.slice(0, 4));
  const m0 = Number(year.startDate.slice(5, 7));
  const out: PlanPeriod[] = [];
  if (plan === "MONTHLY") {
    for (let i = 0; i < rules.monthlyInstalments; i++) {
      const [y, m] = plusMonths(y0, m0, i);
      let due = iso(y, m, Math.min(rules.monthlyDueDay, lastDayOf(y, m)));
      if (i === 0 && due < year.startDate) due = year.startDate;
      if (due > year.endDate) break;
      out.push({
        code: `M${pad(i + 1)}`,
        label: `${MONTHS[m - 1]} ${y}`,
        dueDate: due,
      });
    }
  } else if (plan === "TERMLY") {
    const dates = rules.termDueDates?.length
      ? rules.termDueDates
          .map((md) => resolveMonthDay(md, year))
          .filter((d): d is string => !!d)
      : [0, 3, 6, 9].map((n) => {
          const [y, m] = plusMonths(y0, m0, n);
          return n === 0 ? year.startDate : iso(y, m, 1);
        });
    [...new Set(dates)]
      .filter((d) => d <= year.endDate)
      .sort()
      .forEach((d, i) =>
        out.push({ code: `T${i + 1}`, label: `Term ${i + 1}`, dueDate: d }),
      );
  } else {
    const due =
      (rules.annualPayBy ? resolveMonthDay(rules.annualPayBy, year) : null) ??
      iso(y0, m0, lastDayOf(y0, m0));
    out.push({ code: "A", label: "Full year", dueDate: due });
  }
  return out;
}

/**
 * Splits `total` (minor units) into `n` instalments of whole currency units; the last one takes the
 * rounding difference, so the parts always add up to the total exactly.
 */
export function splitEven(total: bigint, n: number): bigint[] {
  if (n <= 1 || total <= 0n) return [total];
  const N = BigInt(n);
  let base = ((total / N + 50n) / 100n) * 100n;
  if (base * (N - 1n) >= total || base === 0n) base = total / N;
  const parts = Array.from({ length: n - 1 }, () => base);
  parts.push(total - base * (N - 1n));
  return parts;
}
