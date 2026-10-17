import { describe, expect, test } from "vitest";
import { computeAging, writtenOffCents, type LedgerRecord } from "./ledger";
import { allocatableTargets, allocationsTo, liveAllocationCents, planWriteOffAllocation, sameAllocations, writeOffCover, writeOffTargets, type AllocationTarget } from "./write-off";

let counter = 0;
function entry(overrides: Partial<LedgerRecord> & Pick<LedgerRecord, "type" | "amountCents">): LedgerRecord {
  counter += 1;
  return { id: `w${counter}`, entryDate: "2026-09-01", dueDate: null, voided: false, ...overrides };
}
const ASOF = "2026-10-13";

const target = (id: string, openCents: number, dueDate: string, entryDate = "2026-06-01"): AllocationTarget => ({ id, openCents, dueDate, entryDate });

describe("planWriteOffAllocation", () => {
  const targets = [target("a", 100_00, "2026-07-01"), target("b", 60_00, "2026-08-01"), target("c", 40_00, "2026-09-01")];

  test("by default fills the oldest-due charge first, then the next", () => {
    const plan = planWriteOffAllocation(130_00, targets);
    expect(plan).toEqual({ ok: true, allocations: [{ chargeId: "a", amountCents: 100_00 }, { chargeId: "b", amountCents: 30_00 }] });
  });

  test("the order of the targets given does not matter: oldest due date first, ties by entry date then id", () => {
    const shuffled = [target("z", 10_00, "2026-07-01", "2026-06-02"), target("y", 10_00, "2026-07-01", "2026-06-01"), target("x", 10_00, "2026-06-30")];
    expect(planWriteOffAllocation(15_00, shuffled)).toEqual({ ok: true, allocations: [{ chargeId: "x", amountCents: 10_00 }, { chargeId: "y", amountCents: 5_00 }] });
  });

  test("allocations always add up to exactly the amount", () => {
    for (const amount of [1, 99_99, 100_00, 100_01, 200_00]) {
      const plan = planWriteOffAllocation(amount, targets);
      expect(plan.ok && plan.allocations.reduce((sum, item) => sum + item.amountCents, 0)).toBe(amount);
    }
  });

  test("more than is open is refused with the most that can be written off", () => {
    expect(planWriteOffAllocation(200_01, targets)).toEqual({ ok: false, code: "exceeds_balance", maxCents: 200_00 });
  });

  test("nothing open means nothing to write off", () => {
    expect(planWriteOffAllocation(1, [])).toEqual({ ok: false, code: "nothing_owed", maxCents: 0 });
  });

  test("an explicit choice is honoured when it is valid and adds up", () => {
    const plan = planWriteOffAllocation(70_00, targets, [{ chargeId: "c", amountCents: 40_00 }, { chargeId: "b", amountCents: 30_00 }]);
    expect(plan).toEqual({ ok: true, allocations: [{ chargeId: "c", amountCents: 40_00 }, { chargeId: "b", amountCents: 30_00 }] });
  });

  test("an explicit choice that is wrong is refused: unknown charge, too much on one, duplicate, zero, or not adding up", () => {
    const bad = (chosen: Array<{ chargeId: string; amountCents: number }>, amount = 50_00) => planWriteOffAllocation(amount, targets, chosen);
    expect(bad([{ chargeId: "nope", amountCents: 50_00 }])).toMatchObject({ ok: false, code: "invalid_allocation" });
    expect(bad([{ chargeId: "c", amountCents: 50_00 }])).toMatchObject({ ok: false, code: "invalid_allocation" }); // only 40 open
    expect(bad([{ chargeId: "a", amountCents: 25_00 }, { chargeId: "a", amountCents: 25_00 }])).toMatchObject({ ok: false, code: "invalid_allocation" });
    expect(bad([{ chargeId: "a", amountCents: 0 }, { chargeId: "b", amountCents: 50_00 }])).toMatchObject({ ok: false, code: "invalid_allocation" });
    expect(bad([{ chargeId: "a", amountCents: 20_00 }, { chargeId: "b", amountCents: 20_00 }])).toMatchObject({ ok: false, code: "invalid_allocation" }); // 40 of 50
    expect(bad([])).toMatchObject({ ok: false, code: "invalid_allocation" });
  });
});

describe("allocatableTargets", () => {
  const entries = [
    { id: "charge", type: "CHARGE" as const, amountCents: 100_00, entryDate: "2026-09-01" },
    { id: "later", type: "CHARGE" as const, amountCents: 100_00, entryDate: "2026-09-20" },
    { id: "up", type: "ADJUSTMENT" as const, amountCents: 30_00, entryDate: "2026-09-02" },
    { id: "down", type: "ADJUSTMENT" as const, amountCents: -30_00, entryDate: "2026-09-02" },
    { id: "rev", type: "REVERSAL" as const, amountCents: 20_00, entryDate: "2026-09-03" },
  ];
  const open = ["charge", "later", "up", "down", "rev", "ghost"].map((id) => ({ id, dueDate: "2026-10-01", remainingCents: 10_00 }));

  test("only charges and upward adjustments that exist on the date of the write-off can be written off", () => {
    const ids = allocatableTargets(open, entries, "2026-09-10").map((item) => item.id);
    expect(ids).toEqual(["charge", "up"]); // not a later charge, a reduction, a reversal, or something unknown
  });

  test("a charge dated the same day as the write-off counts", () => {
    expect(allocatableTargets(open, entries, "2026-09-20").map((item) => item.id)).toContain("later");
  });

  test("carries each open amount and the dates across", () => {
    expect(allocatableTargets(open, entries, "2026-09-10")[0]).toEqual({ id: "charge", openCents: 10_00, dueDate: "2026-10-01", entryDate: "2026-09-01" });
  });
});

describe("aging with explicit write-off allocations", () => {
  const A = entry({ id: "A", type: "CHARGE", amountCents: 100_00, entryDate: "2026-06-01", dueDate: "2026-07-01" });
  const B = entry({ id: "B", type: "CHARGE", amountCents: 100_00, entryDate: "2026-08-01", dueDate: "2026-09-01" });

  test("a write-off settles the charge it was allocated to, not the oldest one", () => {
    const writeOff = entry({ type: "WRITE_OFF", amountCents: 100_00, entryDate: "2026-10-01", writeOffAllocations: [{ chargeId: "B", amountCents: 100_00 }] });
    const aging = computeAging([A, B, writeOff], ASOF);
    expect(aging.balanceCents).toBe(100_00);
    expect(aging.openItems).toEqual([{ id: "A", dueDate: "2026-07-01", remainingCents: 100_00 }]);
  });

  test("a write-off with NO allocations still works as before (old data stays safe): it settles the oldest charge", () => {
    const legacy = entry({ type: "WRITE_OFF", amountCents: 100_00, entryDate: "2026-10-01" });
    expect(computeAging([A, B, legacy], ASOF).openItems).toEqual([{ id: "B", dueDate: "2026-09-01", remainingCents: 100_00 }]);
  });

  test("payments then settle what is left, oldest first, and never the part that was written off", () => {
    const writeOff = entry({ type: "WRITE_OFF", amountCents: 100_00, entryDate: "2026-10-01", writeOffAllocations: [{ chargeId: "A", amountCents: 100_00 }] });
    const payment = entry({ type: "PAYMENT", amountCents: 40_00, entryDate: "2026-10-02" });
    const aging = computeAging([A, B, writeOff, payment], ASOF);
    expect(aging.openItems).toEqual([{ id: "B", dueDate: "2026-09-01", remainingCents: 60_00 }]);
    expect(aging.balanceCents).toBe(60_00);
  });

  test("a partly written-off charge keeps the rest open, with its true age", () => {
    const writeOff = entry({ type: "WRITE_OFF", amountCents: 30_00, entryDate: "2026-10-01", writeOffAllocations: [{ chargeId: "A", amountCents: 30_00 }] });
    const aging = computeAging([A, writeOff], ASOF);
    expect(aging.openItems).toEqual([{ id: "A", dueDate: "2026-07-01", remainingCents: 70_00 }]);
    expect(aging.buckets.d90_plus).toBe(70_00);
  });

  test("a reversed write-off frees its charges again", () => {
    const writeOff = entry({ id: "W", type: "WRITE_OFF", amountCents: 100_00, entryDate: "2026-10-01", writeOffAllocations: [{ chargeId: "A", amountCents: 100_00 }] });
    const reversal = entry({ type: "REVERSAL", amountCents: 100_00, entryDate: "2026-10-05", reverses: "W" });
    const aging = computeAging([A, writeOff, reversal], ASOF);
    expect(aging.openItems).toEqual([{ id: "A", dueDate: "2026-07-01", remainingCents: 100_00 }]);
    expect(aging.balanceCents).toBe(100_00);
  });

  test("a voided write-off frees its charges too", () => {
    const writeOff = entry({ type: "WRITE_OFF", amountCents: 100_00, entryDate: "2026-10-01", voided: true, writeOffAllocations: [{ chargeId: "A", amountCents: 100_00 }] });
    expect(computeAging([A, writeOff], ASOF).openItems).toEqual([{ id: "A", dueDate: "2026-07-01", remainingCents: 100_00 }]);
  });

  test("an allocation to something that is not there is not lost: it is treated as a credit, so the balance still agrees", () => {
    const writeOff = entry({ type: "WRITE_OFF", amountCents: 30_00, entryDate: "2026-10-01", writeOffAllocations: [{ chargeId: "missing", amountCents: 30_00 }] });
    const aging = computeAging([A, writeOff], ASOF);
    expect(aging.balanceCents).toBe(70_00);
    expect(aging.openItems).toEqual([{ id: "A", dueDate: "2026-07-01", remainingCents: 70_00 }]);
  });

  test("a write-off allocated only in part still counts in full: the rest settles the oldest charge like a payment", () => {
    const partial = entry({ type: "WRITE_OFF", amountCents: 100_00, entryDate: "2026-10-01", writeOffAllocations: [{ chargeId: "B", amountCents: 40_00 }] });
    const aging = computeAging([A, B, partial], ASOF);
    expect(aging.balanceCents).toBe(100_00);
    // 40 off B by name; the other 60 is pooled and settles A (the oldest).
    expect(aging.openItems).toEqual([
      { id: "A", dueDate: "2026-07-01", remainingCents: 40_00 },
      { id: "B", dueDate: "2026-09-01", remainingCents: 60_00 },
    ]);
  });

  test("more allocated to a charge than it has is clamped, and the overflow is not lost", () => {
    const over = entry({ type: "WRITE_OFF", amountCents: 150_00, entryDate: "2026-10-01", writeOffAllocations: [{ chargeId: "A", amountCents: 150_00 }] });
    const aging = computeAging([A, B, over], ASOF);
    expect(aging.balanceCents).toBe(50_00);
    expect(aging.openItems).toEqual([{ id: "B", dueDate: "2026-09-01", remainingCents: 50_00 }]);
    expect(aging.openItems.every((item) => item.remainingCents >= 0)).toBe(true);
  });

  test("balance and written-off totals do not depend on allocations at all", () => {
    const withAlloc = entry({ type: "WRITE_OFF", amountCents: 100_00, entryDate: "2026-10-01", writeOffAllocations: [{ chargeId: "B", amountCents: 100_00 }] });
    const without = { ...withAlloc, writeOffAllocations: undefined };
    expect(computeAging([A, B, withAlloc], ASOF).balanceCents).toBe(computeAging([A, B, without], ASOF).balanceCents);
    expect(writtenOffCents([A, B, withAlloc], ASOF)).toBe(100_00);
  });
});

describe("liveAllocationCents and allocationsTo", () => {
  const A = entry({ id: "A2", type: "CHARGE", amountCents: 100_00, entryDate: "2026-06-01" });
  const live = entry({ id: "W1", type: "WRITE_OFF", amountCents: 60_00, entryDate: "2026-10-01", writeOffAllocations: [{ chargeId: "A2", amountCents: 60_00 }] });
  const voided = entry({ id: "W2", type: "WRITE_OFF", amountCents: 10_00, entryDate: "2026-10-01", voided: true, writeOffAllocations: [{ chargeId: "A2", amountCents: 10_00 }] });
  const reversedWriteOff = entry({ id: "W3", type: "WRITE_OFF", amountCents: 5_00, entryDate: "2026-10-01", writeOffAllocations: [{ chargeId: "A2", amountCents: 5_00 }] });
  const reversal = entry({ type: "REVERSAL", amountCents: 5_00, entryDate: "2026-10-02", reverses: "W3" });
  const all = [A, live, voided, reversedWriteOff, reversal];

  test("counts only the write-offs still in force", () => {
    expect(liveAllocationCents(all, "A2")).toBe(60_00);
    expect(liveAllocationCents(all, "nothing")).toBe(0);
  });

  test("names the write-offs that cover a charge", () => {
    expect(allocationsTo(all, "A2")).toEqual([{ writeOffId: "W1", amountCents: 60_00 }]);
  });
});

describe("writeOffTargets: how much of each charge a write-off may take, judged on EVERY day it would be in force", () => {
  const charge = entry({ id: "C", type: "CHARGE", amountCents: 100_00, entryDate: "2026-02-01", dueDate: "2026-03-01" });
  const TODAY = "2026-10-13";

  test("a plain open charge can be written off in full", () => {
    expect(writeOffTargets([charge], "2026-10-01", TODAY)).toEqual([{ id: "C", openCents: 100_00, dueDate: "2026-03-01", entryDate: "2026-02-01" }]);
  });

  test("a charge a payment has already settled has no room", () => {
    const payment = entry({ type: "PAYMENT", amountCents: 100_00, entryDate: "2026-09-01" });
    expect(writeOffTargets([charge, payment], "2026-10-01", TODAY)).toEqual([]);
  });

  test("a BACKDATED write-off cannot cover what a later payment already paid (it would be paid twice in between)", () => {
    const payment = entry({ type: "PAYMENT", amountCents: 100_00, entryDate: "2026-09-01" });
    expect(writeOffTargets([charge, payment], "2026-08-01", TODAY)).toEqual([]);
  });

  test("a charge once written off and since freed still has no room on the days the first write-off was in force", () => {
    // W1 covered C from Feb 1 and was reversed on Mar 10: free TODAY, but a new write-off dated Feb 15 would overlap it.
    const first = entry({ id: "W1", type: "WRITE_OFF", amountCents: 100_00, entryDate: "2026-02-01", writeOffAllocations: [{ chargeId: "C", amountCents: 100_00 }] });
    const undo = entry({ type: "REVERSAL", amountCents: 100_00, entryDate: "2026-03-10", reverses: "W1" });
    expect(writeOffTargets([charge, first, undo], "2026-02-15", TODAY)).toEqual([]);
    // Dated after the reversal there is no overlap, so it is allowed.
    expect(writeOffTargets([charge, first, undo], "2026-03-10", TODAY)).toEqual([{ id: "C", openCents: 100_00, dueDate: "2026-03-01", entryDate: "2026-02-01" }]);
  });

  test("a bounced payment: the charge it once paid is open today, but a write-off dated while it was paid would overlap", () => {
    const payment = entry({ id: "P", type: "PAYMENT", amountCents: 100_00, entryDate: "2026-02-10" });
    const bounced = entry({ type: "REVERSAL", amountCents: 100_00, entryDate: "2026-04-01", reverses: "P" });
    expect(writeOffTargets([charge, payment, bounced], "2026-03-01", TODAY)).toEqual([]);
    expect(writeOffTargets([charge, payment, bounced], "2026-04-01", TODAY)).toHaveLength(1);
  });

  test("a partly written-off charge offers only what is left", () => {
    const part = entry({ type: "WRITE_OFF", amountCents: 30_00, entryDate: "2026-09-01", writeOffAllocations: [{ chargeId: "C", amountCents: 30_00 }] });
    expect(writeOffTargets([charge, part], "2026-10-01", TODAY)[0]!.openCents).toBe(70_00);
  });

  test("never offers a charge dated after the write-off, a reduction, or a reversal", () => {
    const later = entry({ id: "L", type: "CHARGE", amountCents: 50_00, entryDate: "2026-10-05", dueDate: "2026-11-05" });
    const down = entry({ id: "D", type: "ADJUSTMENT", amountCents: -10_00, entryDate: "2026-09-01" });
    expect(writeOffTargets([charge, later, down], "2026-10-01", TODAY).map((item) => item.id)).toEqual(["C"]);
  });
});

describe("sameAllocations", () => {
  const stored = [{ chargeId: "a", amountCents: 60_00 }, { chargeId: "b", amountCents: 40_00 }];
  test("is the same split whatever the order", () => {
    expect(sameAllocations(stored, [{ chargeId: "b", amountCents: 40_00 }, { chargeId: "a", amountCents: 60_00 }])).toBe(true);
  });
  test("is not the same when a charge or an amount differs", () => {
    expect(sameAllocations(stored, [{ chargeId: "a", amountCents: 100_00 }])).toBe(false);
    expect(sameAllocations(stored, [{ chargeId: "a", amountCents: 60_00 }, { chargeId: "c", amountCents: 40_00 }])).toBe(false);
    expect(sameAllocations(stored, [{ chargeId: "a", amountCents: 61_00 }, { chargeId: "b", amountCents: 39_00 }])).toBe(false);
  });
});

describe("writeOffCover", () => {
  const A = entry({ id: "Z1", type: "CHARGE", amountCents: 100_00, entryDate: "2026-06-01" });
  const live = entry({ id: "ZW1", type: "WRITE_OFF", amountCents: 60_00, entryDate: "2026-10-01", writeOffAllocations: [{ chargeId: "Z1", amountCents: 60_00 }] });
  const reversedOne = entry({ id: "ZW2", type: "WRITE_OFF", amountCents: 5_00, entryDate: "2026-10-01", writeOffAllocations: [{ chargeId: "Z1", amountCents: 5_00 }] });
  const reversal = entry({ type: "REVERSAL", amountCents: 5_00, entryDate: "2026-10-02", reverses: "ZW2" });
  const voidedOne = entry({ id: "ZW3", type: "WRITE_OFF", amountCents: 9_00, entryDate: "2026-10-01", voided: true, writeOffAllocations: [{ chargeId: "Z1", amountCents: 9_00 }] });

  test("a live write-off covers it now and ever", () => {
    expect(writeOffCover([A, live], "Z1")).toEqual({ liveCents: 60_00, ever: true });
  });
  test("a reversed write-off no longer covers it, but did once", () => {
    expect(writeOffCover([A, reversedOne, reversal], "Z1")).toEqual({ liveCents: 0, ever: true });
  });
  test("a voided write-off leaves no trace, and an untouched charge has none", () => {
    expect(writeOffCover([A, voidedOne], "Z1")).toEqual({ liveCents: 0, ever: false });
    expect(writeOffCover([A, live], "other")).toEqual({ liveCents: 0, ever: false });
  });
});
