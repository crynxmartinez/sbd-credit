import { describe, expect, test } from "vitest";
import { balanceCents, computeAging, type LedgerRecord } from "./ledger";

let counter = 0;
function entry(overrides: Partial<LedgerRecord> & Pick<LedgerRecord, "type" | "amountCents">): LedgerRecord {
  counter += 1;
  return {
    id: `e${counter}`,
    entryDate: "2026-09-01",
    dueDate: null,
    voided: false,
    ...overrides,
  };
}

const ASOF = "2026-10-13";

describe("balanceCents", () => {
  test("charges add, payments subtract, adjustments are signed", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 100_00 }),
      entry({ type: "PAYMENT", amountCents: 30_00 }),
      entry({ type: "ADJUSTMENT", amountCents: 5_00 }),
      entry({ type: "ADJUSTMENT", amountCents: -2_00 }),
    ];
    expect(balanceCents(entries)).toBe(73_00);
  });

  test("voided entries are ignored", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 100_00 }),
      entry({ type: "PAYMENT", amountCents: 100_00, voided: true }),
    ];
    expect(balanceCents(entries)).toBe(100_00);
  });

  test("is exact in cents with no float drift", () => {
    const entries = [entry({ type: "CHARGE", amountCents: 10 }), entry({ type: "CHARGE", amountCents: 20 })];
    expect(balanceCents(entries)).toBe(30);
  });

  test("an overpayment gives a negative balance", () => {
    const entries = [entry({ type: "CHARGE", amountCents: 50_00 }), entry({ type: "PAYMENT", amountCents: 80_00 })];
    expect(balanceCents(entries)).toBe(-30_00);
  });

  test("empty ledger is zero", () => {
    expect(balanceCents([])).toBe(0);
  });
});

describe("computeAging", () => {
  test("applies payments to the oldest charge first", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 100_00, entryDate: "2026-07-01", dueDate: "2026-07-31" }),
      entry({ type: "CHARGE", amountCents: 200_00, entryDate: "2026-09-01", dueDate: "2026-10-01" }),
      entry({ type: "PAYMENT", amountCents: 150_00, entryDate: "2026-10-02" }),
    ];
    const aging = computeAging(entries, ASOF);

    expect(aging.balanceCents).toBe(150_00);
    expect(aging.openItems).toHaveLength(1);
    expect(aging.openItems[0]).toMatchObject({ remainingCents: 150_00, dueDate: "2026-10-01" });
  });

  test("sorts open amounts into past-due buckets", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 1_00, dueDate: "2026-10-20" }), // not yet due
      entry({ type: "CHARGE", amountCents: 2_00, dueDate: "2026-10-03" }), // 10 days late
      entry({ type: "CHARGE", amountCents: 3_00, dueDate: "2026-09-03" }), // 40 days late
      entry({ type: "CHARGE", amountCents: 4_00, dueDate: "2026-08-14" }), // 60 days late
      entry({ type: "CHARGE", amountCents: 5_00, dueDate: "2026-07-14" }), // 91 days late
    ];
    const { buckets, overdueCents } = computeAging(entries, ASOF);

    expect(buckets).toEqual({ current: 1_00, d1_30: 2_00, d31_60: 3_00 + 4_00, d61_90: 0, d90_plus: 5_00 });
    expect(overdueCents).toBe(14_00);
  });

  test("an item due today is not overdue", () => {
    const aging = computeAging([entry({ type: "CHARGE", amountCents: 9_00, dueDate: ASOF })], ASOF);
    expect(aging.overdueCents).toBe(0);
    expect(aging.buckets.current).toBe(9_00);
  });

  test("the boundary day counts belong to the lower bucket", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 1_00, dueDate: "2026-09-13" }), // exactly 30 late
      entry({ type: "CHARGE", amountCents: 2_00, dueDate: "2026-08-14" }), // exactly 60 late
      entry({ type: "CHARGE", amountCents: 4_00, dueDate: "2026-07-15" }), // exactly 90 late
    ];
    const { buckets } = computeAging(entries, ASOF);
    expect(buckets.d1_30).toBe(1_00);
    expect(buckets.d31_60).toBe(2_00);
    expect(buckets.d61_90).toBe(4_00);
  });

  test("falls back to the entry date when a charge has no due date", () => {
    const aging = computeAging([entry({ type: "CHARGE", amountCents: 7_00, entryDate: "2026-10-01" })], ASOF);
    expect(aging.buckets.d1_30).toBe(7_00);
  });

  test("reports the next due date and the amount due then", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 10_00, dueDate: "2026-10-25" }),
      entry({ type: "CHARGE", amountCents: 20_00, dueDate: "2026-10-20" }),
      entry({ type: "CHARGE", amountCents: 5_00, dueDate: "2026-10-20" }),
    ];
    const aging = computeAging(entries, ASOF);
    expect(aging.nextDueDate).toBe("2026-10-20");
    expect(aging.nextDueCents).toBe(25_00);
  });

  test("the earliest open item can be overdue; oldest overdue days are reported", () => {
    const aging = computeAging([entry({ type: "CHARGE", amountCents: 8_00, dueDate: "2026-10-03" })], ASOF);
    expect(aging.nextDueDate).toBe("2026-10-03");
    expect(aging.oldestOverdueDays).toBe(10);
  });

  test("a fully paid ledger has nothing open", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 40_00, dueDate: "2026-09-01" }),
      entry({ type: "PAYMENT", amountCents: 40_00 }),
    ];
    const aging = computeAging(entries, ASOF);
    expect(aging.openItems).toEqual([]);
    expect(aging.nextDueDate).toBeNull();
    expect(aging.nextDueCents).toBe(0);
    expect(aging.oldestOverdueDays).toBe(0);
    expect(aging.balanceCents).toBe(0);
  });

  test("an overpayment is reported as unapplied credit", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 50_00, dueDate: "2026-09-01" }),
      entry({ type: "PAYMENT", amountCents: 80_00 }),
    ];
    const aging = computeAging(entries, ASOF);
    expect(aging.creditCents).toBe(30_00);
    expect(aging.balanceCents).toBe(-30_00);
    expect(aging.openItems).toEqual([]);
  });

  test("a positive adjustment ages like a charge, a negative one acts like a payment", () => {
    const entries = [
      entry({ type: "ADJUSTMENT", amountCents: 10_00, entryDate: "2026-09-01", dueDate: "2026-09-10" }),
      entry({ type: "CHARGE", amountCents: 20_00, dueDate: "2026-10-30" }),
      entry({ type: "ADJUSTMENT", amountCents: -10_00 }),
    ];
    const aging = computeAging(entries, ASOF);
    expect(aging.balanceCents).toBe(20_00);
    expect(aging.overdueCents).toBe(0);
  });

  test("voided entries never age or pay anything", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 99_00, dueDate: "2026-01-01", voided: true }),
      entry({ type: "CHARGE", amountCents: 1_00, dueDate: "2026-10-30" }),
    ];
    const aging = computeAging(entries, ASOF);
    expect(aging.overdueCents).toBe(0);
    expect(aging.balanceCents).toBe(1_00);
  });

  test("payments are applied oldest-first even when two charges fall due the same day (ties break by entry date)", () => {
    const entries = [
      entry({ id: "later", type: "CHARGE", amountCents: 10_00, entryDate: "2026-09-10", dueDate: "2026-10-01" }),
      entry({ id: "earlier", type: "CHARGE", amountCents: 10_00, entryDate: "2026-09-01", dueDate: "2026-10-01" }),
      entry({ type: "PAYMENT", amountCents: 10_00 }),
    ];
    expect(computeAging(entries, ASOF).openItems.map((item) => item.id)).toEqual(["later"]);
  });

  test("a payment dated before its charge still settles it (order of entry does not matter)", () => {
    const entries = [
      entry({ type: "PAYMENT", amountCents: 5_00, entryDate: "2026-08-01" }),
      entry({ type: "CHARGE", amountCents: 5_00, entryDate: "2026-09-01", dueDate: "2026-10-01" }),
    ];
    expect(computeAging(entries, ASOF).balanceCents).toBe(0);
    expect(computeAging(entries, ASOF).overdueCents).toBe(0);
  });

  test("is truly as-of: a payment dated after the as-of day does not reduce what is overdue today", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 100_00, dueDate: "2026-10-01" }),
      entry({ type: "PAYMENT", amountCents: 100_00, entryDate: "2026-10-20" }), // a post-dated check
    ];
    const aging = computeAging(entries, ASOF);
    expect(aging.overdueCents).toBe(100_00);
    expect(aging.balanceCents).toBe(100_00);
    // Once that day arrives it settles the charge.
    expect(computeAging(entries, "2026-10-20").balanceCents).toBe(0);
  });

  test("a charge dated after the as-of day is not part of today's balance", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 40_00, entryDate: "2026-10-01", dueDate: "2026-10-31" }),
      entry({ type: "CHARGE", amountCents: 70_00, entryDate: "2026-10-25", dueDate: "2026-11-24" }),
    ];
    expect(computeAging(entries, ASOF).balanceCents).toBe(40_00);
    expect(computeAging(entries, "2026-10-25").balanceCents).toBe(110_00);
  });

  test("an entry dated exactly on the as-of day counts", () => {
    expect(computeAging([entry({ type: "CHARGE", amountCents: 5_00, entryDate: ASOF, dueDate: ASOF })], ASOF).balanceCents).toBe(5_00);
  });

  test("does not mutate its input", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 5_00, dueDate: "2026-10-30" }),
      entry({ type: "CHARGE", amountCents: 5_00, dueDate: "2026-09-30" }),
    ];
    const snapshot = JSON.stringify(entries);
    computeAging(entries, ASOF);
    expect(JSON.stringify(entries)).toBe(snapshot);
  });
});
