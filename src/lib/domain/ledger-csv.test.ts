import { describe, expect, test } from "vitest";
import { LEDGER_CSV_HEADER, ledgerCsvRow, type LedgerCsvSource } from "./ledger-csv";

const row = (overrides: Partial<LedgerCsvSource> = {}): LedgerCsvSource => ({
  customerId: "c1", businessName: "Acme", type: "CHARGE", amountCents: 100_00, entryDate: "2026-10-01", dueDate: "2026-10-31",
  reference: "INV-1", note: null, createdBy: "Dana", voided: false, voidReason: null, reversed: false, isReversal: false, writtenOffAgainst: "", ...overrides,
});
const col = (name: (typeof LEDGER_CSV_HEADER)[number]) => LEDGER_CSV_HEADER.indexOf(name);

describe("ledgerCsvRow", () => {
  test("has one cell per header", () => {
    expect(ledgerCsvRow(row(), "2026-10-13")).toHaveLength(LEDGER_CSV_HEADER.length);
  });

  test("carries the customer id, because two customers can share a business name", () => {
    expect(ledgerCsvRow(row(), "2026-10-13")[col("Customer ID")]).toBe("c1");
  });

  test("the signed effect column sums to the balance: charges add, payments and write-offs subtract, corrections keep their sign", () => {
    const effect = (r: Partial<LedgerCsvSource>) => ledgerCsvRow(row(r), "2026-10-13")[col("Effect on balance")];
    expect(effect({ type: "CHARGE", amountCents: 100_00 })).toBe("100.00");
    expect(effect({ type: "PAYMENT", amountCents: 40_00 })).toBe("-40.00");
    expect(effect({ type: "WRITE_OFF", amountCents: 10_00 })).toBe("-10.00");
    expect(effect({ type: "ADJUSTMENT", amountCents: -5_00 })).toBe("-5.00");
    expect(effect({ type: "REVERSAL", amountCents: -100_00 })).toBe("-100.00");
  });

  test("says whether a row is in today's balance: not if voided, not if dated ahead", () => {
    const counts = (r: Partial<LedgerCsvSource>) => ledgerCsvRow(row(r), "2026-10-13")[col("Counts today")];
    expect(counts({})).toBe("yes");
    expect(counts({ voided: true })).toBe("no");
    expect(counts({ entryDate: "2026-10-14" })).toBe("no");
    expect(counts({ entryDate: "2026-10-13" })).toBe("yes");
  });

  test("a write-off says which charges it covers; anything else leaves that cell empty", () => {
    const covers = (r: Partial<LedgerCsvSource>) => ledgerCsvRow(row(r), "2026-10-13")[col("Written off against")];
    expect(covers({ type: "WRITE_OFF", writtenOffAgainst: "INV-1 ($60.00); INV-2 ($40.00)" })).toBe("INV-1 ($60.00); INV-2 ($40.00)");
    expect(covers({})).toBe("");
  });

  test("marks a reversed entry", () => {
    expect(ledgerCsvRow(row({ reversed: true }), "2026-10-13")[col("Reversed")]).toBe("yes");
  });
});
