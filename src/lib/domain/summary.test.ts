import { describe, expect, test } from "vitest";
import type { CustomerBase } from "../types";
import { buildDashboard } from "./dashboard";
import type { LedgerRecord } from "./ledger";
import { toSummary } from "./summary";

const ASOF = "2026-10-13";

function base(overrides: Partial<CustomerBase> = {}): CustomerBase {
  return {
    id: "c1",
    businessName: "Acme Steel",
    contactName: null,
    phone: null,
    email: null,
    billingAddress: null,
    status: "approved",
    dateApplied: "2026-09-01",
    statusChangedDate: "2026-09-01",
    requestedLimitCents: null,
    creditLimitCents: 100_000_00,
    paymentTerms: "Net 30",
    creditStartDate: "2026-09-01",
    accountingAppName: null,
    accountingProjectUrl: null,
    notes: null,
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function charge(id: string, amountCents: number, dueDate: string): LedgerRecord {
  return { id, type: "CHARGE", amountCents, entryDate: "2026-09-01", dueDate, voided: false };
}

describe("toSummary", () => {
  test("derives balance, utilization and overdue from the ledger", () => {
    const summary = toSummary(base(), [charge("a", 90_000_00, "2026-10-03")], ASOF);
    expect(summary).toMatchObject({
      balanceCents: 90_000_00,
      availableCents: 10_000_00,
      utilizationPct: 90,
      utilizationLevel: "warn",
      overdueCents: 90_000_00,
      oldestOverdueDays: 10,
      nextDueDate: "2026-10-03",
    });
  });

  test("keeps the customer's own fields", () => {
    expect(toSummary(base(), [], ASOF)).toMatchObject({ id: "c1", businessName: "Acme Steel", version: 1 });
  });

  test("available credit never exceeds the limit, even when the customer has overpaid", () => {
    const overpaid = [
      charge("a", 1_000_00, "2026-09-20"),
      { id: "p", type: "PAYMENT" as const, amountCents: 3_000_00, entryDate: "2026-10-01", dueDate: null, voided: false },
    ];
    const summary = toSummary(base({ creditLimitCents: 10_000_00 }), overpaid, ASOF);
    expect(summary.balanceCents).toBe(-2_000_00);
    expect(summary.availableCents).toBe(10_000_00); // not $12,000
  });

  test("available credit never goes below zero when over the limit", () => {
    const summary = toSummary(base(), [charge("a", 120_000_00, "2026-12-01")], ASOF);
    expect(summary.availableCents).toBe(0);
    expect(summary.utilizationLevel).toBe("crit");
  });

  test("shows how much has been written off, as of the day", () => {
    const entries: LedgerRecord[] = [
      charge("a", 500_00, "2026-09-30"),
      { id: "w", type: "WRITE_OFF", amountCents: 200_00, entryDate: "2026-10-05", dueDate: null, voided: false },
    ];
    expect(toSummary(base(), entries, ASOF)).toMatchObject({ balanceCents: 300_00, writtenOffCents: 200_00 });
    expect(toSummary(base(), entries, "2026-10-04").writtenOffCents).toBe(0);
  });

  test("an empty ledger is a clean account", () => {
    expect(toSummary(base(), [], ASOF)).toMatchObject({ balanceCents: 0, overdueCents: 0, nextDueDate: null });
  });
});

describe("buildDashboard", () => {
  const customers = [
    toSummary(base({ id: "a", businessName: "Alpha", updatedAt: "2026-10-12T00:00:00.000Z" }), [charge("x", 5_000_00, "2026-10-03")], ASOF),
    toSummary(base({ id: "b", businessName: "Bravo", creditLimitCents: 50_000_00, updatedAt: "2026-10-10T00:00:00.000Z" }), [charge("y", 1_000_00, "2026-11-20")], ASOF),
    toSummary(base({ id: "c", businessName: "Charlie", status: "submitted", creditLimitCents: 0, dateApplied: "2026-10-01", statusChangedDate: "2026-10-01", updatedAt: "2026-10-13T00:00:00.000Z" }), [], ASOF),
    toSummary(base({ id: "d", businessName: "Delta", status: "denied", creditLimitCents: 0, updatedAt: "2026-09-01T00:00:00.000Z" }), [], ASOF),
  ];
  const dashboard = buildDashboard(customers, ASOF);

  test("counts customers by what they are", () => {
    expect(dashboard.stats).toMatchObject({ totalCustomers: 4, pendingApplications: 1, activeAccounts: 2 });
  });

  test("totals credit extended only for approved customers", () => {
    expect(dashboard.stats.totalExtendedCents).toBe(150_000_00);
  });

  test("totals outstanding and overdue money", () => {
    expect(dashboard.stats.totalOutstandingCents).toBe(6_000_00);
    expect(dashboard.stats.totalOverdueCents).toBe(5_000_00);
  });

  test("totals what has been written off", () => {
    const written = toSummary(
      base({ id: "w" }),
      [charge("q", 90_00, "2026-09-30"), { id: "wo", type: "WRITE_OFF", amountCents: 90_00, entryDate: "2026-10-01", dueDate: null, voided: false }],
      ASOF,
    );
    expect(buildDashboard([...customers, written], ASOF).stats.totalWrittenOffCents).toBe(90_00);
    expect(dashboard.stats.totalWrittenOffCents).toBe(0);
  });

  test("sums aging across customers", () => {
    expect(dashboard.aging.d1_30).toBe(5_000_00);
    expect(dashboard.aging.current).toBe(1_000_00);
  });

  test("needs-attention matches the alert list", () => {
    expect(dashboard.stats.needsAttention).toBe(dashboard.alerts.length);
    expect(dashboard.alerts.map((a) => a.kind)).toEqual(["overdue", "stale_application"]);
  });

  test("recent is newest first and capped", () => {
    expect(dashboard.recent.map((c) => c.id)).toEqual(["c", "a", "b", "d"]);
    const many = Array.from({ length: 9 }, (_, i) => ({ ...customers[0]!, id: `m${i}`, updatedAt: `2026-10-0${i + 1}T00:00:00.000Z` }));
    expect(buildDashboard(many, ASOF).recent).toHaveLength(5);
  });

  test("an empty list gives zeroes, not errors", () => {
    expect(buildDashboard([], ASOF).stats).toMatchObject({ totalCustomers: 0, needsAttention: 0 });
  });
});
