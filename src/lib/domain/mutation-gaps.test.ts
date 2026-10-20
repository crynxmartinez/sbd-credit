import { beforeEach, describe, expect, test } from "vitest";
import type { CustomerBase, CustomerSummary } from "../types";
import { computeAlerts, utilizationLevel, type AlertInput } from "./alerts";
import { DUE_SOON_DAYS, STALE_APPLICATION_DAYS } from "./constants";
import { buildDashboard } from "./dashboard";
import { addDays, diffDays, dueDateFor, formatDate, isValidISODate, termDays } from "./dates";
import { computeAging, writtenOffCents, type LedgerRecord } from "./ledger";
import { ledgerCsvRow } from "./ledger-csv";
import { parseMoneyToCents } from "./money";
import { toPortalView, type PortalSourceEntry } from "./portal";
import { filterCustomers, isSortKey, sortCustomers } from "./customer-list";
import { toSummary } from "./summary";
import {
  allocationsTo,
  liveAllocationCents,
  planWriteOffAllocation,
  sameAllocations,
  writeOffCover,
  writeOffCoverMap,
  writeOffTargets,
} from "./write-off";

/**
 * Tests that exist because mutation testing (Stryker, 2026-10-21) showed the suite would still pass with the rule broken: each block
 * names the mutation it kills. They are about figures people read, so they are written from the rule, not from the code.
 */
const TODAY = "2026-10-13";
let counter = 0;
function rec(overrides: Partial<LedgerRecord> & Pick<LedgerRecord, "type" | "amountCents">): LedgerRecord {
  counter += 1;
  return { id: `g${counter}`, entryDate: "2026-06-01", dueDate: null, voided: false, ...overrides };
}

describe("aging: the overdue total is every overdue bucket, and only those", () => {
  test("an item in each bucket, with different amounts, so adding any one with the wrong sign or leaving one out is seen", () => {
    const aging = computeAging(
      [
        rec({ type: "CHARGE", amountCents: 1_00, dueDate: addDays(TODAY, 10) }), // not yet due
        rec({ type: "CHARGE", amountCents: 2_00, dueDate: addDays(TODAY, -10) }), // 1-30
        rec({ type: "CHARGE", amountCents: 4_00, dueDate: addDays(TODAY, -40) }), // 31-60
        rec({ type: "CHARGE", amountCents: 8_00, dueDate: addDays(TODAY, -70) }), // 61-90
        rec({ type: "CHARGE", amountCents: 16_00, dueDate: addDays(TODAY, -100) }), // 90+
      ],
      TODAY,
    );
    expect(aging.buckets).toEqual({ current: 1_00, d1_30: 2_00, d31_60: 4_00, d61_90: 8_00, d90_plus: 16_00 });
    expect(aging.overdueCents).toBe(2_00 + 4_00 + 8_00 + 16_00);
    expect(aging.balanceCents).toBe(31_00);
  });

  test("a bucket's edges: 30 days late is still 1-30, 31 is 31-60, 60/61, 90/91, and due today is not late", () => {
    const at = (daysLate: number) => computeAging([rec({ type: "CHARGE", amountCents: 1_00, dueDate: addDays(TODAY, -daysLate) })], TODAY).buckets;
    expect(at(0).current).toBe(1_00);
    expect(at(1).d1_30).toBe(1_00);
    expect(at(30).d1_30).toBe(1_00);
    expect(at(31).d31_60).toBe(1_00);
    expect(at(60).d31_60).toBe(1_00);
    expect(at(61).d61_90).toBe(1_00);
    expect(at(90).d61_90).toBe(1_00);
    expect(at(91).d90_plus).toBe(1_00);
  });
});

describe("reversals in the books", () => {
  test("a reversal whose target is not in view is kept and counted by its sign, so nothing is silently dropped", () => {
    const orphan = rec({ type: "REVERSAL", amountCents: -50_00, reverses: "not-in-this-ledger" });
    const aging = computeAging([orphan], TODAY);
    expect(aging.balanceCents).toBe(-50_00);
    expect(aging.creditCents).toBe(50_00);
  });

  test("a reversal with no target named is kept too", () => {
    const aging = computeAging([rec({ type: "CHARGE", amountCents: 100_00 }), rec({ type: "REVERSAL", amountCents: -30_00, reverses: null })], TODAY);
    expect(aging.balanceCents).toBe(70_00);
    expect(aging.openItems.reduce((sum, item) => sum + item.remainingCents, 0)).toBe(70_00);
  });

  test("an entry that merely carries a 'reverses' pointer, but is not a reversal, cancels nothing", () => {
    const charge = rec({ type: "CHARGE", amountCents: 100_00 });
    const bogus = rec({ type: "CHARGE", amountCents: 20_00, reverses: charge.id });
    const aging = computeAging([charge, bogus], TODAY);
    expect(aging.balanceCents).toBe(120_00);
    expect(aging.openItems.reduce((sum, item) => sum + item.remainingCents, 0)).toBe(120_00);
  });

  test("a reversal and the entry it names cancel out of the open items together", () => {
    const charge = rec({ type: "CHARGE", amountCents: 100_00, dueDate: addDays(TODAY, -5) });
    const reversal = rec({ type: "REVERSAL", amountCents: -100_00, reverses: charge.id });
    const other = rec({ type: "CHARGE", amountCents: 7_00, dueDate: addDays(TODAY, 5) });
    const aging = computeAging([charge, reversal, other], TODAY);
    expect(aging.openItems.map((item) => item.remainingCents)).toEqual([7_00]);
    expect(aging.balanceCents).toBe(7_00);
  });

  test("a write-off that has been reversed is not counted as written off, and a voided reversal does not reverse it", () => {
    const charge = rec({ type: "CHARGE", amountCents: 100_00 });
    const writeOff = rec({ type: "WRITE_OFF", amountCents: 40_00 });
    expect(writtenOffCents([charge, writeOff], TODAY)).toBe(40_00);
    const reversal = rec({ type: "REVERSAL", amountCents: 40_00, reverses: writeOff.id });
    expect(writtenOffCents([charge, writeOff, reversal], TODAY)).toBe(0);
    expect(writtenOffCents([charge, writeOff, { ...reversal, voided: true }], TODAY)).toBe(40_00);
    // A reversal of something else leaves this write-off alone.
    expect(writtenOffCents([charge, writeOff, rec({ type: "REVERSAL", amountCents: -100_00, reverses: charge.id })], TODAY)).toBe(40_00);
    // An entry that is not a reversal does not cancel a write-off just because it points at it.
    expect(writtenOffCents([charge, writeOff, rec({ type: "ADJUSTMENT", amountCents: 1_00, reverses: writeOff.id })], TODAY)).toBe(40_00);
  });
});

describe("write-offs: the rule that a charge is never settled twice, on any day in force", () => {
  const D = (days: number) => addDays(TODAY, days);

  test("a payment that settled the charge for a few days and was then reversed still blocks a write-off dated before it", () => {
    const charge = rec({ type: "CHARGE", amountCents: 100_00, entryDate: D(-10), dueDate: D(-5) });
    const payment = rec({ type: "PAYMENT", amountCents: 100_00, entryDate: D(-5) });
    const reversal = rec({ type: "REVERSAL", amountCents: 100_00, entryDate: D(-2), reverses: payment.id });
    const records = [charge, payment, reversal];
    // Today the charge is open again (100.00), and on the write-off's own day (8 days ago) it was open too: but between the
    // payment and its reversal it was fully paid, and a write-off in force over those days would settle it a second time.
    expect(computeAging(records, TODAY).openItems.map((item) => item.remainingCents)).toEqual([100_00]);
    expect(computeAging(records, D(-8)).openItems.map((item) => item.remainingCents)).toEqual([100_00]);
    expect(computeAging(records, D(-4)).openItems).toEqual([]);
    expect(writeOffTargets(records, D(-8), TODAY)).toEqual([]);
  });

  test("a payment that settled part of it leaves only what stayed open on every day", () => {
    const charge = rec({ type: "CHARGE", amountCents: 100_00, entryDate: D(-10), dueDate: D(-5) });
    const payment = rec({ type: "PAYMENT", amountCents: 60_00, entryDate: D(-4) });
    const targets = writeOffTargets([charge, payment], D(-8), TODAY);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.openCents).toBe(40_00);
  });

  test("with nothing in between, the whole open amount is available", () => {
    const charge = rec({ type: "CHARGE", amountCents: 100_00, entryDate: D(-10), dueDate: D(-5) });
    expect(writeOffTargets([charge], D(-8), TODAY)[0]!.openCents).toBe(100_00);
  });

  test("a charge dated after the write-off cannot be covered by it", () => {
    const early = rec({ type: "CHARGE", amountCents: 50_00, entryDate: D(-10), dueDate: D(-5) });
    const late = rec({ type: "CHARGE", amountCents: 70_00, entryDate: D(-3), dueDate: D(5) });
    expect(writeOffTargets([early, late], D(-6), TODAY).map((target) => target.id)).toEqual([early.id]);
  });

  test("an upward adjustment can be covered; a downward one and a payment cannot", () => {
    const up = rec({ type: "ADJUSTMENT", amountCents: 10_00, entryDate: D(-9), dueDate: D(-3) });
    const down = rec({ type: "ADJUSTMENT", amountCents: -2_00, entryDate: D(-9) });
    const charge = rec({ type: "CHARGE", amountCents: 30_00, entryDate: D(-9), dueDate: D(-1) });
    const ids = writeOffTargets([up, down, charge], D(-1), TODAY).map((target) => target.id);
    expect(ids).toContain(up.id);
    expect(ids).toContain(charge.id);
    expect(ids).not.toContain(down.id);
  });
});

describe("planWriteOffAllocation", () => {
  const target = (id: string, openCents: number, dueDate: string) => ({ id, openCents, dueDate, entryDate: "2026-01-01" });

  test("a chosen split must add up to exactly the amount: short, long and empty are all refused", () => {
    const targets = [target("a", 100_00, "2026-07-01"), target("b", 60_00, "2026-08-01")];
    expect(planWriteOffAllocation(80_00, targets, [{ chargeId: "a", amountCents: 50_00 }])).toMatchObject({ ok: false, code: "invalid_allocation" });
    expect(planWriteOffAllocation(80_00, targets, [{ chargeId: "a", amountCents: 50_00 }, { chargeId: "b", amountCents: 40_00 }])).toMatchObject({ ok: false, code: "invalid_allocation" });
    expect(planWriteOffAllocation(80_00, targets, [])).toMatchObject({ ok: false, code: "invalid_allocation" });
    expect(planWriteOffAllocation(80_00, targets, [{ chargeId: "a", amountCents: 50_00 }, { chargeId: "b", amountCents: 30_00 }])).toMatchObject({ ok: true });
  });

  test("a charge with nothing open is never given an allocation, by default or by choice", () => {
    const targets = [target("empty", 0, "2026-01-01"), target("open", 50_00, "2026-09-01")];
    expect(planWriteOffAllocation(30_00, targets)).toEqual({ ok: true, allocations: [{ chargeId: "open", amountCents: 30_00 }] });
    expect(planWriteOffAllocation(30_00, targets, [{ chargeId: "empty", amountCents: 30_00 }])).toMatchObject({ ok: false, code: "invalid_allocation" });
    expect(planWriteOffAllocation(1, [target("empty", 0, "2026-01-01")])).toMatchObject({ ok: false, code: "nothing_owed" });
  });

  test("sameAllocations is about the same charges for the same amounts, in any order, and nothing else", () => {
    const a = [{ chargeId: "x", amountCents: 5 }, { chargeId: "y", amountCents: 7 }];
    expect(sameAllocations(a, [a[1]!, a[0]!])).toBe(true);
    expect(sameAllocations(a, [a[0]!])).toBe(false);
    expect(sameAllocations(a, [{ chargeId: "x", amountCents: 5 }, { chargeId: "y", amountCents: 8 }])).toBe(false);
    expect(sameAllocations(a, [{ chargeId: "x", amountCents: 5 }, { chargeId: "z", amountCents: 7 }])).toBe(false);
    expect(sameAllocations([{ chargeId: "x", amountCents: 5 }, { chargeId: "x", amountCents: 5 }], [{ chargeId: "x", amountCents: 5 }, { chargeId: "x", amountCents: 5 }])).toBe(false);
  });
});

describe("what covers a charge: only write-offs that are on the books", () => {
  const charge = rec({ type: "CHARGE", amountCents: 100_00 });
  const writeOff = rec({ type: "WRITE_OFF", amountCents: 40_00, writeOffAllocations: [{ chargeId: charge.id, amountCents: 40_00 }] });
  const reversalOf = (target: LedgerRecord, extra: Partial<LedgerRecord> = {}) => rec({ type: "REVERSAL", amountCents: 40_00, reverses: target.id, ...extra });

  test.each([
    ["a live write-off", [charge, writeOff], 40_00, true],
    ["a voided write-off leaves no trace at all", [charge, { ...writeOff, voided: true }], 0, false],
    ["a reversed write-off no longer covers but did", [charge, writeOff, reversalOf(writeOff)], 0, true],
    ["a VOIDED reversal does not undo the write-off", [charge, writeOff, reversalOf(writeOff, { voided: true })], 40_00, true],
    ["something that is not a reversal does not undo it", [charge, writeOff, rec({ type: "ADJUSTMENT", amountCents: 1_00, reverses: writeOff.id })], 40_00, true],
    ["an entry that is not a write-off cannot cover anything, whatever it carries", [charge, rec({ type: "PAYMENT", amountCents: 40_00, writeOffAllocations: [{ chargeId: charge.id, amountCents: 40_00 }] })], 0, false],
  ] as const)("%s", (_name, entries, live, ever) => {
    const list = entries as unknown as LedgerRecord[];
    expect(writeOffCover(list, charge.id)).toEqual({ liveCents: live, ever });
    expect(liveAllocationCents(list, charge.id)).toBe(live);
    expect(writeOffCoverMap(list).get(charge.id) ?? { liveCents: 0, ever: false }).toEqual({ liveCents: live, ever });
  });

  test("allocationsTo lists the live write-offs and what each covers", () => {
    expect(allocationsTo([charge, writeOff], charge.id)).toEqual([{ writeOffId: writeOff.id, amountCents: 40_00 }]);
    expect(allocationsTo([charge, writeOff, reversalOf(writeOff)], charge.id)).toEqual([]);
    expect(allocationsTo([charge, { ...writeOff, voided: true }], charge.id)).toEqual([]);
    expect(allocationsTo([charge, writeOff, reversalOf(writeOff, { voided: true })], charge.id)).toHaveLength(1);
  });
});

describe("alerts: the thresholds are exact", () => {
  const customer = (overrides: Partial<AlertInput> = {}): AlertInput => ({
    id: "c1", businessName: "Acme", status: "approved", creditLimitCents: 1_000_00, balanceCents: 0, overdueCents: 0, oldestOverdueDays: 0,
    nextDueDate: null, nextDueCents: 0, statusChangedDate: "2026-09-01", ...overrides,
  });
  const kinds = (input: AlertInput) => computeAlerts([input], TODAY).map((alert) => alert.kind);

  test("exactly 80% of the limit warns, 79% does not; exactly 100% is over the limit, 99% is only near it", () => {
    expect(kinds(customer({ balanceCents: 790_00 }))).toEqual([]);
    expect(kinds(customer({ balanceCents: 800_00 }))).toEqual(["near_limit"]);
    expect(kinds(customer({ balanceCents: 990_00 }))).toEqual(["near_limit"]);
    expect(kinds(customer({ balanceCents: 1_000_00 }))).toEqual(["over_limit"]);
    expect(utilizationLevel(79)).toBe("ok");
    expect(utilizationLevel(80)).toBe("warn");
    expect(utilizationLevel(100)).toBe("crit");
  });

  test("a payment due today, and one due in exactly the warning window, are flagged; one day further is not", () => {
    const due = (days: number) => customer({ nextDueDate: addDays(TODAY, days), nextDueCents: 50_00 });
    expect(kinds(due(0))).toEqual(["due_soon"]);
    expect(computeAlerts([due(0)], TODAY)[0]!.detail).toContain("due today");
    expect(kinds(due(DUE_SOON_DAYS))).toEqual(["due_soon"]);
    expect(kinds(due(DUE_SOON_DAYS + 1))).toEqual([]);
  });

  test("a due-soon reminder needs an approved account, a date, and money actually due", () => {
    const soon = { nextDueDate: addDays(TODAY, 2), nextDueCents: 50_00 };
    expect(kinds(customer({ ...soon, status: "suspended" }))).toEqual([]);
    expect(kinds(customer({ ...soon, nextDueDate: null }))).toEqual([]);
    expect(kinds(customer({ ...soon, nextDueCents: 0 }))).toEqual([]);
    expect(kinds(customer({ ...soon, nextDueCents: -5 }))).toEqual([]);
  });

  test("something already past due is an overdue alert, never also a due-soon one; money owed alerts for every status that can owe", () => {
    const owing = { overdueCents: 20_00, oldestOverdueDays: 3, nextDueDate: addDays(TODAY, -3), nextDueCents: 20_00 };
    expect(kinds(customer(owing))).toEqual(["overdue"]);
    for (const status of ["suspended", "denied", "under_review"] as const) expect(kinds(customer({ ...owing, status }))).toContain("overdue");
    expect(kinds(customer({ ...owing, status: "submitted" }))).not.toContain("overdue");
  });

  test("a due date that has passed while nothing is overdue is a data oddity: it says nothing, not 'due in -1 days'", () => {
    expect(kinds(customer({ nextDueDate: addDays(TODAY, -1), nextDueCents: 50_00, overdueCents: 0 }))).toEqual([]);
  });

  test("an application waiting exactly the review window is flagged; a day less is not", () => {
    expect(kinds(customer({ status: "submitted", statusChangedDate: addDays(TODAY, -STALE_APPLICATION_DAYS) }))).toEqual(["stale_application"]);
    expect(kinds(customer({ status: "submitted", statusChangedDate: addDays(TODAY, -(STALE_APPLICATION_DAYS - 1)) }))).toEqual([]);
    expect(kinds(customer({ status: "denied", statusChangedDate: addDays(TODAY, -30) }))).toEqual([]);
  });
});

describe("the dashboard adds up", () => {
  const base = (overrides: Partial<CustomerBase>): CustomerBase => ({
    id: "c", businessName: "Name", contactName: null, phone: null, email: null, billingAddress: null, status: "approved", dateApplied: "2026-09-01",
    statusChangedDate: "2026-09-01", requestedLimitCents: null, creditLimitCents: 1_000_00, paymentTerms: "Net 30", creditStartDate: "2026-09-01",
    accountingAppName: null, accountingProjectUrl: null, notes: null, version: 1, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...overrides,
  });
  const summary = (overrides: Partial<CustomerBase>, entries: LedgerRecord[]): CustomerSummary => toSummary(base(overrides), entries, TODAY);

  const customers = [
    summary({ id: "a", status: "approved", creditLimitCents: 1_000_00 }, [
      rec({ type: "CHARGE", amountCents: 300_00, dueDate: addDays(TODAY, -45) }), // 31-60
      rec({ type: "CHARGE", amountCents: 100_00, dueDate: addDays(TODAY, 10) }), // current
    ]),
    summary({ id: "b", status: "approved", creditLimitCents: 500_00 }, [rec({ type: "CHARGE", amountCents: 50_00, dueDate: addDays(TODAY, -5) }), rec({ type: "PAYMENT", amountCents: 80_00 })]), // overpaid: -30
    summary({ id: "c", status: "suspended", creditLimitCents: 200_00 }, [
      rec({ type: "CHARGE", amountCents: 70_00, dueDate: addDays(TODAY, -100) }),
      rec({ type: "WRITE_OFF", amountCents: 20_00, writeOffAllocations: [] }),
    ]),
    summary({ id: "d", status: "submitted", creditLimitCents: 0 }, []),
    summary({ id: "e", status: "under_review", creditLimitCents: 0 }, []),
    summary({ id: "f", status: "denied", creditLimitCents: 0 }, []),
  ];
  // Computed inside each test run (not while the file is being read), so what a change to dashboard.ts breaks is attributed to a test.
  let dash!: ReturnType<typeof buildDashboard>;
  beforeEach(() => {
    dash = buildDashboard(customers, TODAY);
  });

  test("counts: everyone, applications waiting (submitted and under review, not denied), approved accounts", () => {
    expect(dash.stats.totalCustomers).toBe(6);
    expect(dash.stats.pendingApplications).toBe(2);
    expect(dash.stats.activeAccounts).toBe(2);
  });

  test("credit extended is the limits of approved accounts only", () => {
    expect(dash.stats.totalExtendedCents).toBe(1_000_00 + 500_00);
  });

  test("outstanding adds what is owed and never subtracts an overpayment", () => {
    // a owes 400.00, b is overpaid by 30.00 (counts as 0), c owes 70.00 - 20.00 written off = 50.00.
    expect(customers.map((c) => c.balanceCents)).toEqual([400_00, -30_00, 50_00, 0, 0, 0]);
    expect(dash.stats.totalOutstandingCents).toBe(400_00 + 0 + 50_00);
  });

  test("overdue and written-off totals add the customers' figures", () => {
    expect(dash.stats.totalOverdueCents).toBe(customers.reduce((sum, c) => sum + c.overdueCents, 0));
    expect(dash.stats.totalOverdueCents).toBe(300_00 + 50_00);
    expect(dash.stats.totalWrittenOffCents).toBe(20_00);
  });

  test("the aging totals add each customer's buckets, and the open money in them is the outstanding total", () => {
    expect(dash.aging.current).toBe(100_00);
    expect(dash.aging.d31_60).toBe(300_00);
    expect(dash.aging.d90_plus).toBe(50_00);
    expect(Object.values(dash.aging).reduce((sum, n) => sum + n, 0)).toBe(dash.stats.totalOutstandingCents);
  });

  test("needs attention is the number of alerts shown", () => {
    expect(dash.stats.needsAttention).toBe(dash.alerts.length);
    expect(dash.alerts.length).toBeGreaterThan(0);
  });

  test("an empty book is all zeros, not an error", () => {
    const empty = buildDashboard([], TODAY);
    expect(empty.stats).toMatchObject({ totalCustomers: 0, totalOutstandingCents: 0, totalOverdueCents: 0, needsAttention: 0 });
    expect(Object.values(empty.aging)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("what a customer is shown about each entry", () => {
  test("only a purchase carries a due date: a payment, a write-off, an adjustment and a reversal never do, even when the record has one", () => {
    const summaryRow = toSummary({ ...({} as CustomerBase), id: "c", businessName: "Acme", status: "approved", creditLimitCents: 1_000_00, paymentTerms: "Net 30" } as CustomerBase, [], TODAY);
    const source = (type: PortalSourceEntry["type"], amountCents: number): PortalSourceEntry => ({ id: `${type}-${amountCents}`, type, amountCents, entryDate: "2026-10-01", dueDate: "2026-11-01", reference: "REF", voided: false });
    const view = toPortalView(summaryRow, [source("CHARGE", 5), source("PAYMENT", 6), source("WRITE_OFF", 7), source("ADJUSTMENT", 8), source("REVERSAL", -9)], TODAY);
    const byKind = new Map(view.entries.map((entry) => [entry.kind, entry]));
    expect(byKind.get("purchase")!.dueDate).toBe("2026-11-01");
    expect(byKind.get("payment")!.dueDate).toBeNull();
    expect(byKind.get("credit")!.dueDate).toBeNull();
    expect(view.entries.filter((entry) => entry.kind === "correction").every((entry) => entry.dueDate === null)).toBe(true);
    // And only purchases and payments show a reference.
    expect(view.entries.filter((entry) => entry.reference !== null).map((entry) => entry.kind).sort()).toEqual(["payment", "purchase"]);
  });
});

describe("dates: an impossible date is refused, not rolled into the next month", () => {
  test.each(["2026-02-30", "2026-02-29", "2026-13-01", "2026-00-10", "2026-10-00", "2026-10-32", "2026-04-31", "1999-12-31", "2101-01-01"])("%s is not a date", (value) => {
    expect(isValidISODate(value)).toBe(false);
  });
  test.each(["2026-1-01", "2026-10-1", "26-10-01", "20261-10-01", " 2026-10-01", "2026-10-01 ", "2026-10-01T00:00:00Z", "x2026-10-01", "2026-10-01x", "2026/10/01", ""])("the shape %j is not accepted", (value) => {
    expect(isValidISODate(value)).toBe(false);
  });
  test.each(["2024-02-29", "2026-10-13", "2000-01-01", "2100-12-31"])("%s is", (value) => {
    expect(isValidISODate(value)).toBe(true);
  });
  test("arithmetic on a malformed date fails loudly instead of inventing a day", () => {
    expect(() => addDays("2026-13-45", 1)).not.toThrow(); // well-formed shape: validity is the form's job (isValidISODate), tested above
    expect(() => addDays("nonsense", 1)).toThrow(/Invalid ISO date: nonsense/);
    expect(() => diffDays("2026-10-01", "10/05/2026")).toThrow(/Invalid ISO date/);
  });
  test("formatDate shows a dash for anything that is not a real date", () => {
    expect(formatDate("2026-02-30")).toBe("—");
    expect(formatDate(null)).toBe("—");
    expect(formatDate("2026-10-05")).toBe("Oct 5, 2026");
  });
  test("payment terms: Net N is N days, due on receipt and COD are today, anything else is the 30-day default, and a look-alike is not Net N", () => {
    expect(termDays("Net 45")).toBe(45);
    expect(termDays("Due on receipt")).toBe(0);
    expect(termDays("COD")).toBe(0);
    expect(termDays("Whenever")).toBe(30);
    expect(termDays("Net 45 days")).toBe(30);
    expect(termDays("Not Net 45")).toBe(30);
    expect(dueDateFor("2026-10-01", "Net 15")).toBe("2026-10-16");
  });
});

describe("money typed as a number: a third decimal place is refused, float noise is not", () => {
  test("1.234 is not a clean amount, 0.1 + 0.2 is 30 cents", () => {
    expect(parseMoneyToCents(1.234)).toBeNull();
    expect(parseMoneyToCents(10.005)).toBeNull();
    expect(parseMoneyToCents(0.1 + 0.2)).toBe(30);
    expect(parseMoneyToCents(19.99)).toBe(19_99);
    expect(parseMoneyToCents(Number.NaN)).toBeNull();
    expect(parseMoneyToCents(Number.POSITIVE_INFINITY)).toBeNull();
  });
  test("the dollar sign is only a prefix, and 'to the cent' means exactly two places at most", () => {
    expect(parseMoneyToCents("$12")).toBe(12_00);
    expect(parseMoneyToCents("12$")).toBeNull();
    expect(parseMoneyToCents("1$2")).toBeNull();
    expect(parseMoneyToCents("12.345")).toBeNull();
    expect(parseMoneyToCents("12.5")).toBe(12_50);
    expect(parseMoneyToCents(".5")).toBe(50);
  });
});

describe("the ledger export row", () => {
  const source = { customerId: "c", businessName: "Acme", type: "CHARGE" as const, amountCents: 12_34, entryDate: "2026-10-01", dueDate: "2026-11-01", reference: "INV-1", note: "a note", createdBy: "Dana", voided: true, voidReason: "typo", reversed: true, isReversal: false, writtenOffAgainst: "INV-9 ($1.00)" };
  test("every column carries its own value, in the order of the header", () => {
    expect(ledgerCsvRow(source, TODAY)).toEqual(["c", "Acme", "CHARGE", "12.34", "12.34", "no", "2026-10-01", "2026-11-01", "INV-1", "a note", "Dana", "yes", "typo", "yes", "INV-9 ($1.00)"]);
  });
  test("empty values are empty cells, not the word null or a placeholder", () => {
    const row = ledgerCsvRow({ ...source, dueDate: null, reference: null, note: null, voided: false, voidReason: null, reversed: false, writtenOffAgainst: "" }, TODAY);
    expect(row.slice(5)).toEqual(["yes", "2026-10-01", "", "", "", "Dana", "no", "", "no", ""]);
  });
});

describe("the customer list: every column sorts by its own figure, both ways", () => {
  const blank = (id: string): CustomerBase => ({
    id, businessName: id.toUpperCase(), contactName: null, phone: null, email: null, billingAddress: null, status: "approved", dateApplied: "2026-09-01",
    statusChangedDate: "2026-09-01", requestedLimitCents: null, creditLimitCents: 0, paymentTerms: "Net 30", creditStartDate: null, accountingAppName: null,
    accountingProjectUrl: null, notes: null, version: 1, createdAt: "", updatedAt: "",
  });
  const row = (id: string, overrides: Partial<CustomerSummary>): CustomerSummary => ({ ...toSummary(blank(id), [], TODAY), ...overrides });
  const list = [
    row("a", { creditLimitCents: 300, balanceCents: 20, utilizationPct: 50, status: "denied", nextDueDate: "2026-12-01" }),
    row("b", { creditLimitCents: 100, balanceCents: 30, utilizationPct: 90, status: "submitted", nextDueDate: "2026-11-01" }),
    row("c", { creditLimitCents: 200, balanceCents: 10, utilizationPct: 10, status: "approved", nextDueDate: null }),
  ];
  const ids = (key: Parameters<typeof sortCustomers>[1], direction: "asc" | "desc") => sortCustomers(list, key, direction).map((c) => c.id).join("");

  test("limit, balance, utilization and status, ascending and descending", () => {
    expect(ids("limit", "asc")).toBe("bca");
    expect(ids("limit", "desc")).toBe("acb");
    expect(ids("balance", "asc")).toBe("cab");
    expect(ids("balance", "desc")).toBe("bac");
    expect(ids("utilization", "asc")).toBe("cab");
    expect(ids("utilization", "desc")).toBe("bac");
    expect(ids("status", "asc")).toBe("bca");
    expect(ids("status", "desc")).toBe("acb");
  });

  test("next due: soonest first, blank last either way; two blanks fall back to name", () => {
    expect(ids("nextDue", "asc")).toBe("bac");
    expect(ids("nextDue", "desc")).toBe("abc");
    const blanks = [row("z", { nextDueDate: null }), row("m", { nextDueDate: null })];
    expect(sortCustomers(blanks, "nextDue", "asc").map((c) => c.id).join("")).toBe("mz");
  });

  test("an unknown sort word is not a sort key; an empty search shows everyone", () => {
    expect(isSortKey("limit")).toBe(true);
    expect(isSortKey("")).toBe(false);
    expect(isSortKey("Limit")).toBe(false);
    expect(filterCustomers(list, "all", "   ")).toHaveLength(3);
    expect(filterCustomers(list, "all", "zzz")).toHaveLength(0);
  });
});
