import { describe, expect, test } from "vitest";
import type { CustomerSummary } from "../types";
import { PORTAL_ENTRY_LIMIT, portalStanding, toPortalView, type PortalSourceEntry } from "./portal";

const ASOF = "2026-10-13";

function customer(overrides: Partial<CustomerSummary> = {}): CustomerSummary {
  return {
    id: "c1", businessName: "Acme Steel", contactName: "Private Contact", phone: "555-0100", email: "x@example.com",
    billingAddress: "1 Secret St", status: "approved", dateApplied: "2026-01-01", statusChangedDate: "2026-01-02",
    requestedLimitCents: 99_000_00, creditLimitCents: 50_000_00, paymentTerms: "Net 30", creditStartDate: "2026-01-02",
    accountingAppName: "QuickBooks", accountingProjectUrl: "https://internal.example/acme", notes: "SECRET-INTERNAL-NOTE",
    version: 4, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    balanceCents: 12_000_00, creditCents: 0, availableCents: 38_000_00, utilizationPct: 24, utilizationLevel: "ok",
    overdueCents: 2_000_00, oldestOverdueDays: 12, nextDueDate: "2026-10-25", nextDueCents: 10_000_00,
    buckets: { current: 10_000_00, d1_30: 2_000_00, d31_60: 0, d61_90: 0, d90_plus: 0 }, writtenOffCents: 0,
    ...overrides,
  };
}

let n = 0;
function entry(overrides: Partial<PortalSourceEntry> & Pick<PortalSourceEntry, "type" | "amountCents">): PortalSourceEntry {
  n += 1;
  return { id: `e${n}`, entryDate: "2026-10-01", dueDate: null, reference: null, voided: false, ...overrides };
}

describe("portalStanding", () => {
  test("says what a customer needs to know, not our internal workflow", () => {
    expect(portalStanding("approved")).toBe("active");
    expect(portalStanding("suspended")).toBe("on_hold");
    for (const status of ["submitted", "under_review", "denied"] as const) expect(portalStanding(status)).toBe("in_review");
  });
});

describe("toPortalView", () => {
  test("shows the customer their own figures", () => {
    const view = toPortalView(customer(), [], ASOF);
    expect(view).toMatchObject({
      businessName: "Acme Steel", standing: "active", asOf: ASOF, creditLimitCents: 50_000_00, availableCents: 38_000_00,
      utilizationPct: 24, balanceCents: 12_000_00, paymentTerms: "Net 30", overdueCents: 2_000_00, oldestOverdueDays: 12,
      nextDueDate: "2026-10-25", nextDueCents: 10_000_00,
    });
  });

  test("LEAKS NOTHING INTERNAL: the view has exactly the whitelisted fields, and no internal text appears anywhere in it", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 5_00, reference: "INV-1", note: "SECRET-ENTRY-NOTE", createdBy: "Staff Person" } as never),
      entry({ type: "WRITE_OFF", amountCents: 1_00, note: "SECRET-WRITE-OFF-REASON" } as never),
    ];
    const view = toPortalView(customer(), entries, ASOF);

    expect(Object.keys(view).sort()).toEqual(
      [
        "asOf", "availableCents", "balanceCents", "businessName", "creditCents", "creditLimitCents", "entries", "nextDueCents",
        "nextDueDate", "oldestOverdueDays", "overdueCents", "paymentTerms", "standing", "utilizationPct",
      ].sort(),
    );
    expect(Object.keys(view.entries[0]!).sort()).toEqual(["amountCents", "date", "dueDate", "kind", "reference"]);
    const text = JSON.stringify(view);
    for (const secret of ["SECRET-INTERNAL-NOTE", "SECRET-ENTRY-NOTE", "SECRET-WRITE-OFF-REASON", "Staff Person", "Private Contact", "1 Secret St", "QuickBooks", "internal.example", "99000"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("available credit is zero unless the account is active", () => {
    expect(toPortalView(customer({ status: "suspended" }), [], ASOF)).toMatchObject({ standing: "on_hold", availableCents: 0, creditLimitCents: 50_000_00 });
    expect(toPortalView(customer({ status: "under_review", creditLimitCents: 0, availableCents: 0 }), [], ASOF).availableCents).toBe(0);
  });

  test("an account still being reviewed shows no limit it does not have", () => {
    const view = toPortalView(customer({ status: "submitted", creditLimitCents: 7_000_00, availableCents: 7_000_00 }), [], ASOF);
    expect(view).toMatchObject({ standing: "in_review", creditLimitCents: 0, availableCents: 0 });
  });

  test("names each entry the way a customer would, with the direction of the money", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 100_00, reference: "INV-9", dueDate: "2026-10-30" }),
      entry({ type: "PAYMENT", amountCents: 40_00, reference: "Check 12" }),
      entry({ type: "WRITE_OFF", amountCents: 10_00 }),
      entry({ type: "ADJUSTMENT", amountCents: -5_00 }),
      entry({ type: "ADJUSTMENT", amountCents: 3_00 }),
      entry({ type: "REVERSAL", amountCents: -100_00 }),
    ];
    const byKind = toPortalView(customer(), entries, ASOF).entries.map((e) => [e.kind, e.amountCents]);
    expect(byKind).toEqual(
      expect.arrayContaining([
        ["purchase", 100_00],
        ["payment", -40_00],
        ["credit", -10_00],
        ["correction", -5_00],
        ["correction", 3_00],
        ["correction", -100_00],
      ]),
    );
  });

  test("a reference is shown only for purchases and payments: on anything else it may be staff reasoning", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 5_00, reference: "INV-1" }),
      entry({ type: "PAYMENT", amountCents: 1_00, reference: "Check 9" }),
      entry({ type: "WRITE_OFF", amountCents: 1_00, reference: "SECRET-REF-WO" }),
      entry({ type: "REVERSAL", amountCents: -5_00, reference: "SECRET-REF-REV" }),
      entry({ type: "ADJUSTMENT", amountCents: 2_00, reference: "SECRET-REF-ADJ" }),
    ];
    const view = toPortalView(customer(), entries, ASOF);
    expect(JSON.stringify(view)).not.toContain("SECRET-REF");
    expect(view.entries.filter((e) => e.reference !== null).map((e) => e.kind).sort()).toEqual(["payment", "purchase"]);
  });

  test("what is listed adds up to the balance shown, so hiding entries cannot be used to work out hidden ones", () => {
    const view = toPortalView(
      customer({ balanceCents: 95_00 }),
      [
        entry({ type: "CHARGE", amountCents: 100_00 }),
        entry({ type: "PAYMENT", amountCents: 20_00, entryDate: "2026-10-02" }),
        entry({ type: "ADJUSTMENT", amountCents: 15_00, entryDate: "2026-10-03" }),
        entry({ type: "CHARGE", amountCents: 999_00, voided: true }),
        entry({ type: "CHARGE", amountCents: 777_00, entryDate: "2026-12-01" }),
      ],
      ASOF,
    );
    expect(view.entries.reduce((sum, e) => sum + e.amountCents, 0)).toBe(95_00);
  });

  test("hides voided entries and entries dated after today", () => {
    const entries = [
      entry({ type: "CHARGE", amountCents: 1_00, voided: true }),
      entry({ type: "CHARGE", amountCents: 2_00, entryDate: "2026-10-14" }),
      entry({ type: "CHARGE", amountCents: 3_00, entryDate: ASOF }),
    ];
    expect(toPortalView(customer(), entries, ASOF).entries.map((e) => e.amountCents)).toEqual([3_00]);
  });

  test("newest first, and capped so a huge ledger cannot make a huge page", () => {
    const many = Array.from({ length: PORTAL_ENTRY_LIMIT + 25 }, (_, i) =>
      entry({ type: "CHARGE", amountCents: 1_00, entryDate: `2026-${i < 25 ? "08" : "09"}-0${(i % 9) + 1}` }),
    );
    const view = toPortalView(customer(), [...many, entry({ type: "PAYMENT", amountCents: 1_00, entryDate: "2026-10-10" })], ASOF);
    expect(view.entries).toHaveLength(PORTAL_ENTRY_LIMIT);
    expect(view.entries[0]).toMatchObject({ kind: "payment", date: "2026-10-10" });
    const dates = view.entries.map((e) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  test("does not change its input", () => {
    const entries = [entry({ type: "CHARGE", amountCents: 5_00 }), entry({ type: "PAYMENT", amountCents: 1_00, entryDate: "2026-10-05" })];
    const snapshot = JSON.stringify(entries);
    toPortalView(customer(), entries, ASOF);
    expect(JSON.stringify(entries)).toBe(snapshot);
  });
});
