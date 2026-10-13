import { describe, expect, test } from "vitest";
import type { CustomerSummary } from "../types";
import { filterCustomers, isSortKey, sortCustomers } from "./customer-list";

function customer(overrides: Partial<CustomerSummary>): CustomerSummary {
  return {
    id: "x", businessName: "Name", contactName: null, phone: null, email: null, billingAddress: null,
    status: "approved", dateApplied: "2026-09-01", statusChangedDate: "2026-09-01", requestedLimitCents: null, creditLimitCents: 0,
    paymentTerms: "Net 30", creditStartDate: null, accountingAppName: null, accountingProjectUrl: null, notes: null,
    version: 1, createdAt: "", updatedAt: "", balanceCents: 0, creditCents: 0, availableCents: 0, utilizationPct: 0,
    utilizationLevel: "ok", overdueCents: 0, oldestOverdueDays: 0, nextDueDate: null, nextDueCents: 0,
    buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 },
    ...overrides,
  };
}

const list = [
  customer({ id: "b", businessName: "Bravo", balanceCents: 500, nextDueDate: "2026-11-01", status: "approved" }),
  customer({ id: "a", businessName: "Alpha", balanceCents: 900, nextDueDate: null, status: "submitted" }),
  customer({ id: "c", businessName: "Charlie", balanceCents: 100, nextDueDate: "2026-10-20", status: "denied" }),
];

describe("sortCustomers", () => {
  test("sorts by name both ways without mutating the input", () => {
    const snapshot = list.map((c) => c.id);
    expect(sortCustomers(list, "name", "asc").map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(sortCustomers(list, "name", "desc").map((c) => c.id)).toEqual(["c", "b", "a"]);
    expect(list.map((c) => c.id)).toEqual(snapshot);
  });

  test("sorts by balance", () => {
    expect(sortCustomers(list, "balance", "desc").map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  test("sorts by status in workflow order", () => {
    expect(sortCustomers(list, "status", "asc").map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  test("next due sorts soonest first and keeps blanks last in either direction", () => {
    expect(sortCustomers(list, "nextDue", "asc").map((c) => c.id)).toEqual(["c", "b", "a"]);
    expect(sortCustomers(list, "nextDue", "desc").map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  test("ties fall back to name", () => {
    const tied = [customer({ id: "z", businessName: "Zed" }), customer({ id: "m", businessName: "Mid" })];
    expect(sortCustomers(tied, "limit", "asc").map((c) => c.id)).toEqual(["m", "z"]);
  });
});

describe("filterCustomers", () => {
  const people = [
    customer({ id: "1", businessName: "Midwest Fab", contactName: "Dana", email: "dana@mw.example", phone: "(555) 201-4410", status: "approved" }),
    customer({ id: "2", businessName: "Lakeside", notes: "Pays by check", status: "submitted" }),
  ];

  test("filters by status", () => {
    expect(filterCustomers(people, "approved", "").map((c) => c.id)).toEqual(["1"]);
    expect(filterCustomers(people, "all", "")).toHaveLength(2);
  });

  test("searches name, contact, email, phone and notes, ignoring case and spaces at the ends", () => {
    expect(filterCustomers(people, "all", "  MIDWEST ").map((c) => c.id)).toEqual(["1"]);
    expect(filterCustomers(people, "all", "dana").map((c) => c.id)).toEqual(["1"]);
    expect(filterCustomers(people, "all", "mw.example").map((c) => c.id)).toEqual(["1"]);
    expect(filterCustomers(people, "all", "201-4410").map((c) => c.id)).toEqual(["1"]);
    expect(filterCustomers(people, "all", "by check").map((c) => c.id)).toEqual(["2"]);
  });

  test("combines status and search", () => {
    expect(filterCustomers(people, "submitted", "midwest")).toEqual([]);
  });
});

describe("isSortKey", () => {
  test("accepts known keys only", () => {
    expect(isSortKey("balance")).toBe(true);
    expect(isSortKey("nope")).toBe(false);
    expect(isSortKey(null)).toBe(false);
  });
});
