import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { addDays } from "./dates";
import { computeAlerts, utilizationLevel, utilizationPct, type AlertInput } from "./alerts";
import { parseMoneyToCents } from "./money";

/**
 * A differential run against the system this one replaced. The legacy page (legacy/credit-tracker-artifact.html) is the only record of
 * what staff relied on, so its own functions are lifted out of the file, unchanged, and run on the same customers as the new rules.
 *
 * The legacy page has no ledger, no aging and no write-offs: it keeps one typed-in balance per customer. What it has in common with
 * the new system is the credit-line percentage, its warning levels, and the alerts. Those are compared here, and every way they are
 * allowed to differ is written down below as a named, asserted difference, so a disagreement that is NOT on the list fails the test.
 */
const html = readFileSync(new URL("../../../legacy/credit-tracker-artifact.html", import.meta.url), "utf8");
const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));

/** The source of `function name(...) { ... }` from the legacy script, by matching braces. */
function legacyFunction(name: string): string {
  const start = script.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`legacy function ${name} not found`);
  const open = script.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < script.length; i += 1) {
    if (script[i] === "{") depth += 1;
    if (script[i] === "}") depth -= 1;
    if (depth === 0) return script.slice(start, i + 1);
  }
  throw new Error(`legacy function ${name} is not closed`);
}

interface LegacyCustomer {
  id: string;
  businessName: string;
  status: string;
  creditLimit: number;
  currentBalance: number;
  nextPaymentDueDate: string | null;
  dateApplied: string;
}
interface LegacyAlert { sev: "high" | "med"; cid: string; text: string }

/** The legacy functions, bound to a list of customers and a "today" (which the legacy page reads from the UTC clock). */
function legacy(customers: LegacyCustomer[], today: string) {
  const sources = ["fmtMoney", "fmtDate", "daysUntil", "escapeHtml", "utilizationPct", "utilLevel", "computeAlerts"].map(legacyFunction).join("\n");
  const factory = new Function("customers", "todayISO", `${sources}\nreturn { utilizationPct, utilLevel, computeAlerts, daysUntil };`);
  return factory(customers, () => today) as {
    utilizationPct: (c: LegacyCustomer) => number;
    utilLevel: (pct: number) => string;
    computeAlerts: () => LegacyAlert[];
    daysUntil: (d: string) => number | null;
  };
}

const TODAY = "2026-10-13";
const KIND_OF_TEXT: Array<[RegExp, string]> = [
  [/is over its credit limit/, "over_limit"],
  [/credit limit\./, "near_limit"],
  [/overdue\./, "overdue"],
  [/is due in|is due today/, "due_soon"],
  [/awaiting review|under review for/, "stale_application"],
];
const kindOfLegacy = (alert: LegacyAlert): string => KIND_OF_TEXT.find(([pattern]) => pattern.test(alert.text.replace(/<[^>]+>/g, "")))?.[1] ?? `unknown: ${alert.text}`;

describe("the credit-line percentage: legacy and new", () => {
  test("agree exactly whenever the figure is a whole number, and differ only by rounding down vs to nearest otherwise", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5_000 }), fc.integer({ min: 0, max: 12_000 }), (limitDollars, balanceDollars) => {
        const customer: LegacyCustomer = { id: "c", businessName: "X", status: "approved", creditLimit: limitDollars, currentBalance: balanceDollars, nextPaymentDueDate: null, dateApplied: "2026-10-01" };
        const old = legacy([customer], TODAY).utilizationPct(customer);
        const now = utilizationPct(balanceDollars * 100, limitDollars * 100);
        const exact = (balanceDollars / limitDollars) * 100;
        if (Number.isInteger(exact)) expect(now).toBe(old);
        // Never more than one point apart, and the new one is never ahead of the legacy one (it rounds down, so no one is flagged early).
        expect(old - now).toBeGreaterThanOrEqual(0);
        expect(old - now).toBeLessThanOrEqual(1);
        // The only way they differ is that the legacy page rounded to the nearest whole number.
        expect(now).toBe(Math.min(200, Math.floor(exact)));
        expect(old).toBe(Math.min(200, Math.round(exact)));
      }),
      { numRuns: 500 },
    );
  });

  test("a missing or zero limit is 0% in both, and the warning levels are the same words at the same thresholds", () => {
    const zero: LegacyCustomer = { id: "c", businessName: "X", status: "approved", creditLimit: 0, currentBalance: 500, nextPaymentDueDate: null, dateApplied: "2026-10-01" };
    expect(legacy([zero], TODAY).utilizationPct(zero)).toBe(0);
    expect(utilizationPct(500_00, 0)).toBe(0);
    for (const pct of [0, 79, 80, 99, 100, 150, 200]) expect(utilizationLevel(pct)).toBe(legacy([], TODAY).utilLevel(pct));
  });

  test("a figure in dollars from the legacy page parses to the same cents the new form would store", () => {
    for (const dollars of [0, 1, 12, 1_234, 999_999]) expect(parseMoneyToCents(String(dollars))).toBe(dollars * 100);
  });
});

describe("alerts: legacy and new, on customers both can describe", () => {
  const customerArb = fc.record({
    limit: fc.integer({ min: 100, max: 500 }),
    balance: fc.integer({ min: 0, max: 700 }),
    /** Sometimes put the balance a hair under a threshold, which is where the two rounding rules part. */
    near: fc.option(fc.constantFrom(0.795, 0.797, 0.799, 0.995, 0.997, 0.999), { nil: null }),
    dueIn: fc.option(fc.integer({ min: -20, max: 20 }), { nil: null }),
    status: fc.constantFrom("approved", "submitted", "under_review"),
    waited: fc.integer({ min: 0, max: 12 }),
  });

  test("every disagreement is one of the documented differences", () => {
    const seen = new Map<string, number>();
    fc.assert(
      fc.property(fc.array(customerArb, { minLength: 1, maxLength: 6 }), (rows) => {
        const legacyCustomers: LegacyCustomer[] = rows.map((r, i) => ({
          id: `c${i}`, businessName: `Name ${i}`, status: r.status, creditLimit: r.limit, currentBalance: r.near === null ? r.balance : Math.round(r.limit * r.near),
          nextPaymentDueDate: r.dueIn === null ? null : addDays(TODAY, r.dueIn), dateApplied: addDays(TODAY, -r.waited),
        }));
        const oldAlerts = legacy(legacyCustomers, TODAY).computeAlerts();

        // The new rules are fed the same facts. The new system derives "overdue" from the ledger; here a customer whose due date has
        // passed while money is owed has all of it overdue, and otherwise all of it is due on that date.
        const inputs: AlertInput[] = legacyCustomers.map((c) => {
          const pastDue = c.nextPaymentDueDate !== null && c.nextPaymentDueDate < TODAY && c.currentBalance > 0;
          return {
            id: c.id, businessName: c.businessName, status: c.status as AlertInput["status"], creditLimitCents: c.creditLimit * 100,
            balanceCents: c.currentBalance * 100, overdueCents: pastDue ? c.currentBalance * 100 : 0,
            oldestOverdueDays: pastDue ? Math.round((Date.parse(TODAY) - Date.parse(c.nextPaymentDueDate!)) / 86_400_000) : 0,
            nextDueDate: c.nextPaymentDueDate, nextDueCents: c.currentBalance * 100, statusChangedDate: c.dateApplied,
          };
        });
        const newAlerts = computeAlerts(inputs, TODAY);

        for (const c of legacyCustomers) {
          const a = new Set(oldAlerts.filter((x) => x.cid === c.id).map(kindOfLegacy));
          const b = new Set<string>(newAlerts.filter((x) => x.customerId === c.id).map((x) => x.kind));
          const onlyOld = [...a].filter((k) => !b.has(k));
          const onlyNew = [...b].filter((k) => !a.has(k));
          const exact = (c.currentBalance / c.creditLimit) * 100;
          for (const kind of onlyOld) {
            // D1: the legacy page rounds to the nearest whole percent, so 79.5%..79.99% already counts as 80% (and 99.5% as 100%).
            const roundedUp = (kind === "near_limit" && Math.round(exact) >= 80 && Math.floor(exact) < 80) || (kind === "over_limit" && Math.round(exact) >= 100 && Math.floor(exact) < 100);
            // D2: a payment due within a week with nothing owed is still announced by the legacy page when the balance is typed as 0? No:
            // legacy requires balance > 0; the new rules need money actually due. They agree, so there is no allowed difference here.
            expect(roundedUp, `D1 only: legacy-only alert "${kind}" for ${JSON.stringify(c)} (exact ${exact}%)`).toBe(true);
            seen.set("D1 legacy rounds to the nearest percent", (seen.get("D1 legacy rounds to the nearest percent") ?? 0) + 1);
          }
          for (const kind of onlyNew) {
            // D3: when the legacy "near limit" would show and the customer is also over, the legacy page shows only the stronger one: same here.
            // D4: the new system reports an overdue amount for any status that can owe money; the legacy page only for approved accounts.
            // D1 again, seen from the other side: at 99.5% the legacy page says "over its limit" where the new rules say "at 99%".
            const nearestIsOver = kind === "near_limit" && Math.round(exact) >= 100 && Math.floor(exact) < 100 && Math.floor(exact) >= 80;
            const allowed = (kind === "overdue" && c.status !== "approved") || nearestIsOver;
            expect(allowed, `legacy-missing alert "${kind}" for ${JSON.stringify(c)}`).toBe(true);
            const name = nearestIsOver ? "D1 legacy rounds to the nearest percent" : "D4 new alerts overdue money for suspended/under-review accounts too";
            seen.set(name, (seen.get(name) ?? 0) + 1);
          }
        }
      }),
      { numRuns: 400 },
    );
    // The differences really occur (the test is not passing because it never looked).
    expect([...seen.keys()].sort()).toEqual(["D1 legacy rounds to the nearest percent", "D4 new alerts overdue money for suspended/under-review accounts too"]);
  });
});

describe("what the legacy page got wrong that the new system does not", () => {
  test("it decides 'today' from the UTC clock, so after 7 pm Central it is already tomorrow: due dates and ages are a day out", () => {
    const evening = new Date("2026-10-14T01:30:00Z"); // 8:30 pm on 13 Oct in Chicago
    expect(evening.toISOString().slice(0, 10)).toBe("2026-10-14"); // what the legacy page's todayISO() returns
    const chicagoDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(evening);
    expect(chicagoDay).toBe("2026-10-13"); // what the books say, and what businessToday() returns
  });

  test("a payment larger than the balance leaves it at zero in the legacy page (the extra money vanishes); the new ledger keeps it as credit", () => {
    const legacyAfterPayment = (balance: number, payment: number) => Math.max(0, balance - payment); // showPaymentForm, line 1313 of the legacy page
    expect(legacyAfterPayment(100, 130)).toBe(0);
    // New system: the same two entries leave a credit of 30.00 (see the model test in books-model.int.test.ts, and ledger.test.ts).
    expect(100_00 - 130_00).toBe(-30_00);
  });

  test("the legacy payment line really is the one quoted above", () => {
    expect(script).toContain("Math.max(0, (Number(c.currentBalance)||0) - amount)");
  });
});
