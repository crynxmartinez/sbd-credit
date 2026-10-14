import { describe, expect, test } from "vitest";
import { sameCustomerSubmission, sameLedgerSubmission } from "./idempotency";

const existing = { type: "PAYMENT", amountCents: 100_00, entryDate: "2026-10-13", dueDate: null, reference: "Check 9", note: null };
const input = { type: "PAYMENT" as const, amountCents: 100_00, entryDate: "2026-10-13", dueDate: null, reference: "Check 9", note: null };

describe("sameLedgerSubmission", () => {
  test("the same details are the same submission (a genuine retry)", () => {
    expect(sameLedgerSubmission(existing, input)).toBe(true);
  });

  test("a different amount, date, type or reference is NOT: someone edited the form and sent it again with the old key", () => {
    expect(sameLedgerSubmission(existing, { ...input, amountCents: 150_00 })).toBe(false);
    expect(sameLedgerSubmission(existing, { ...input, entryDate: "2026-10-14" })).toBe(false);
    expect(sameLedgerSubmission(existing, { ...input, type: "CHARGE" })).toBe(false);
    expect(sameLedgerSubmission(existing, { ...input, reference: "Check 10" })).toBe(false);
    expect(sameLedgerSubmission(existing, { ...input, note: "now with a note" })).toBe(false);
  });

  test("a due date left blank (the server works it out) does not count as a difference", () => {
    const charge = { ...existing, type: "CHARGE", dueDate: "2026-11-12" };
    expect(sameLedgerSubmission(charge, { ...input, type: "CHARGE", dueDate: null })).toBe(true);
    expect(sameLedgerSubmission(charge, { ...input, type: "CHARGE", dueDate: "2026-11-12" })).toBe(true);
    expect(sameLedgerSubmission(charge, { ...input, type: "CHARGE", dueDate: "2026-12-01" })).toBe(false);
  });
});

describe("sameCustomerSubmission", () => {
  const saved = { businessName: "Acme LLC", contactName: null, phone: "555", email: null, billingAddress: null, dateApplied: "2026-10-01", requestedLimitCents: 5_000_00, accountingAppName: null, accountingProjectUrl: null, notes: null };

  test("the same form sent again is the same submission, whether a blank is null or missing", () => {
    expect(sameCustomerSubmission(saved, { ...saved })).toBe(true);
    const withoutContact: Record<string, string | number | null> = { ...saved };
    delete withoutContact.contactName;
    expect(sameCustomerSubmission(saved, withoutContact)).toBe(true);
  });

  test("an edited form is not a retry", () => {
    expect(sameCustomerSubmission(saved, { ...saved, businessName: "Acme Inc" })).toBe(false);
    expect(sameCustomerSubmission(saved, { ...saved, requestedLimitCents: 6_000_00 })).toBe(false);
    expect(sameCustomerSubmission(saved, { ...saved, notes: "added later" })).toBe(false);
  });
});
