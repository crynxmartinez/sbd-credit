import { describe, expect, test } from "vitest";
import { computeAlerts, utilizationPct, utilizationLevel, type AlertInput } from "./alerts";

const ASOF = "2026-10-13";

function customer(overrides: Partial<AlertInput> = {}): AlertInput {
  return {
    id: "c1",
    businessName: "Midwest Fabrication",
    status: "approved",
    creditLimitCents: 100_000_00,
    balanceCents: 10_000_00,
    overdueCents: 0,
    oldestOverdueDays: 0,
    nextDueDate: null,
    nextDueCents: 0,
    statusChangedDate: "2026-09-01",
    ...overrides,
  };
}

describe("utilizationPct / utilizationLevel", () => {
  test("is balance over limit, rounded", () => {
    expect(utilizationPct(50_000_00, 100_000_00)).toBe(50);
    expect(utilizationPct(33_333, 100_000)).toBe(33);
  });

  test("a zero or missing limit is 0%, not a divide-by-zero", () => {
    expect(utilizationPct(5_00, 0)).toBe(0);
  });

  test("rounds DOWN so a customer is never shown at a threshold they have not reached", () => {
    expect(utilizationPct(996, 1000)).toBe(99);
    expect(utilizationLevel(utilizationPct(996, 1000))).toBe("warn");
    expect(utilizationPct(799, 1000)).toBe(79);
    expect(utilizationPct(1000, 1000)).toBe(100);
  });

  test("clamps display between 0 and 200", () => {
    expect(utilizationPct(900_000_00, 100_000_00)).toBe(200);
    expect(utilizationPct(-5_00, 100_00)).toBe(0);
  });

  test.each([
    [0, "ok"],
    [79, "ok"],
    [80, "warn"],
    [99, "warn"],
    [100, "crit"],
    [150, "crit"],
  ])("%i%% is %s", (pct, level) => expect(utilizationLevel(pct)).toBe(level));
});

describe("computeAlerts", () => {
  test("a healthy approved account raises nothing", () => {
    expect(computeAlerts([customer()], ASOF)).toEqual([]);
  });

  test("over the limit is high severity", () => {
    const [alert] = computeAlerts([customer({ balanceCents: 110_000_00 })], ASOF);
    expect(alert).toMatchObject({ severity: "high", kind: "over_limit", customerId: "c1" });
    expect(alert?.detail).toContain("$110,000 of $100,000");
  });

  test("80% to 99% is a medium warning", () => {
    const [alert] = computeAlerts([customer({ balanceCents: 85_000_00 })], ASOF);
    expect(alert).toMatchObject({ severity: "med", kind: "near_limit" });
    expect(alert?.detail).toContain("85%");
  });

  test("overdue money is high severity and names the age", () => {
    const [alert] = computeAlerts([customer({ overdueCents: 2_500_00, oldestOverdueDays: 12 })], ASOF);
    expect(alert).toMatchObject({ severity: "high", kind: "overdue" });
    expect(alert?.detail).toContain("$2,500");
    expect(alert?.detail).toContain("12 days");
  });

  test("overdue wording is singular for one day", () => {
    const [alert] = computeAlerts([customer({ overdueCents: 100, oldestOverdueDays: 1 })], ASOF);
    expect(alert?.detail).toContain("1 day ");
  });

  test("a suspended account that owes overdue money still alerts", () => {
    const alerts = computeAlerts([customer({ status: "suspended", overdueCents: 100_00, oldestOverdueDays: 30 })], ASOF);
    expect(alerts.map((a) => a.kind)).toEqual(["overdue"]);
  });

  test("a reopened or denied customer who still owes overdue money still alerts", () => {
    for (const status of ["under_review", "denied"] as const) {
      const alerts = computeAlerts(
        [customer({ status, overdueCents: 5_00, oldestOverdueDays: 9, statusChangedDate: ASOF })],
        ASOF,
      );
      expect(alerts.map((a) => a.kind)).toEqual(["overdue"]);
    }
  });

  test("the review clock starts when the status last changed, not when the customer first applied", () => {
    const reopened = customer({ status: "under_review", statusChangedDate: "2026-10-12" });
    expect(computeAlerts([reopened], ASOF)).toEqual([]);
  });

  test("due-soon covers day 7 and not day 8", () => {
    expect(computeAlerts([customer({ nextDueDate: "2026-10-20", nextDueCents: 100 })], ASOF)).toHaveLength(1);
    expect(computeAlerts([customer({ nextDueDate: "2026-10-21", nextDueCents: 100 })], ASOF)).toHaveLength(0);
  });

  test("a suspended account is not flagged for utilization", () => {
    const alerts = computeAlerts([customer({ status: "suspended", balanceCents: 200_000_00 })], ASOF);
    expect(alerts).toEqual([]);
  });

  test("payment due within a week is a medium warning", () => {
    const [alert] = computeAlerts([customer({ nextDueDate: "2026-10-18", nextDueCents: 4_000_00 })], ASOF);
    expect(alert).toMatchObject({ severity: "med", kind: "due_soon" });
    expect(alert?.detail).toContain("in 5 days");
  });

  test("payment due today says so", () => {
    const [alert] = computeAlerts([customer({ nextDueDate: ASOF, nextDueCents: 1_00 })], ASOF);
    expect(alert?.detail).toContain("due today");
  });

  test("payment due beyond a week is quiet", () => {
    expect(computeAlerts([customer({ nextDueDate: "2026-10-21", nextDueCents: 1_00 })], ASOF)).toEqual([]);
  });

  test("an overdue account does not also get a due-soon alert", () => {
    const alerts = computeAlerts(
      [customer({ overdueCents: 1_00, oldestOverdueDays: 3, nextDueDate: "2026-10-10", nextDueCents: 1_00 })],
      ASOF,
    );
    expect(alerts.map((a) => a.kind)).toEqual(["overdue"]);
  });

  test("an application waiting five days is flagged", () => {
    const [alert] = computeAlerts([customer({ status: "submitted", statusChangedDate: "2026-10-05" })], ASOF);
    expect(alert).toMatchObject({ severity: "med", kind: "stale_application" });
    expect(alert?.detail).toContain("awaiting review for 8 days");
  });

  test("under-review wording differs from submitted", () => {
    const [alert] = computeAlerts([customer({ status: "under_review", statusChangedDate: "2026-10-01" })], ASOF);
    expect(alert?.detail).toContain("under review for 12 days");
  });

  test("a four-day-old application is not flagged yet", () => {
    expect(computeAlerts([customer({ status: "submitted", statusChangedDate: "2026-10-09" })], ASOF)).toEqual([]);
  });

  test("denied customers raise nothing", () => {
    expect(computeAlerts([customer({ status: "denied", balanceCents: 999_999_00 })], ASOF)).toEqual([]);
  });

  test("high severity sorts before medium, then by business name", () => {
    const alerts = computeAlerts(
      [
        customer({ id: "b", businessName: "Bravo", balanceCents: 85_000_00 }),
        customer({ id: "z", businessName: "Zulu", overdueCents: 1_00, oldestOverdueDays: 2 }),
        customer({ id: "a", businessName: "Alpha", overdueCents: 1_00, oldestOverdueDays: 2 }),
      ],
      ASOF,
    );
    expect(alerts.map((a) => a.customerId)).toEqual(["a", "z", "b"]);
  });
});
