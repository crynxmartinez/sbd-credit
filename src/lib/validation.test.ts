import { describe, expect, test } from "vitest";
import {
  customerCreateSchema,
  customerUpdateSchema,
  decisionSchema,
  ledgerEntrySchema,
  loginSchema,
  reversalSchema,
  voidSchema,
} from "./validation";

const profile = { businessName: "  Midwest Fabrication LLC  ", dateApplied: "2026-10-13" };

describe("customerCreateSchema", () => {
  test("trims the name and turns empty optionals into null", () => {
    const parsed = customerCreateSchema.parse({ ...profile, contactName: "  ", phone: "", email: "" });
    expect(parsed.businessName).toBe("Midwest Fabrication LLC");
    expect(parsed.contactName).toBeNull();
    expect(parsed.phone).toBeNull();
    expect(parsed.email).toBeNull();
    expect(parsed.requestedLimitCents).toBeNull();
  });

  test("requires a business name", () => {
    expect(customerCreateSchema.safeParse({ ...profile, businessName: "   " }).success).toBe(false);
  });

  test("rejects a bad email and an impossible date", () => {
    expect(customerCreateSchema.safeParse({ ...profile, email: "not-an-email" }).success).toBe(false);
    expect(customerCreateSchema.safeParse({ ...profile, dateApplied: "2026-02-30" }).success).toBe(false);
  });

  test.each(["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "ftp://x.example.com", "not a url"])(
    "refuses the accounting link %s",
    (url) => {
      expect(customerCreateSchema.safeParse({ ...profile, accountingProjectUrl: url }).success).toBe(false);
    },
  );

  test("accepts web links", () => {
    const parsed = customerCreateSchema.parse({ ...profile, accountingProjectUrl: "https://qbo.intuit.com/app/x" });
    expect(parsed.accountingProjectUrl).toBe("https://qbo.intuit.com/app/x");
  });

  test("refuses amounts that are not whole cents or are over the cap", () => {
    expect(customerCreateSchema.safeParse({ ...profile, requestedLimitCents: 12.5 }).success).toBe(false);
    expect(customerCreateSchema.safeParse({ ...profile, requestedLimitCents: -1 }).success).toBe(false);
    expect(customerCreateSchema.safeParse({ ...profile, requestedLimitCents: 1_000_000_001 }).success).toBe(false);
  });
});

describe("customerUpdateSchema", () => {
  test("needs the version the edit was made from", () => {
    expect(customerUpdateSchema.safeParse(profile).success).toBe(false);
    expect(customerUpdateSchema.safeParse({ ...profile, version: 1 }).success).toBe(true);
  });

  test("credit terms are optional but typed", () => {
    expect(customerUpdateSchema.safeParse({ ...profile, version: 1, paymentTerms: "Net 99" }).success).toBe(false);
    expect(customerUpdateSchema.safeParse({ ...profile, version: 1, paymentTerms: "Net 45" }).success).toBe(true);
  });
});

describe("decisionSchema", () => {
  test("approve needs a limit above zero, terms and a start date", () => {
    const base = { action: "approve", version: 2, paymentTerms: "Net 30", creditStartDate: "2026-10-13" };
    expect(decisionSchema.safeParse({ ...base, creditLimitCents: 0 }).success).toBe(false);
    expect(decisionSchema.safeParse({ ...base, creditLimitCents: 25_000_00 }).success).toBe(true);
    expect(decisionSchema.safeParse({ action: "approve", version: 2, creditLimitCents: 100 }).success).toBe(false);
  });

  test("deny takes an optional reason", () => {
    expect(decisionSchema.parse({ action: "deny", version: 1 })).toMatchObject({ reason: null });
    expect(decisionSchema.parse({ action: "deny", version: 1, reason: " No references " })).toMatchObject({
      reason: "No references",
    });
  });

  test("rejects an unknown action", () => {
    expect(decisionSchema.safeParse({ action: "delete", version: 1 }).success).toBe(false);
  });
});

describe("ledgerEntrySchema", () => {
  const base = { entryDate: "2026-10-13" };

  test("a charge or payment must be positive", () => {
    expect(ledgerEntrySchema.safeParse({ ...base, type: "CHARGE", amountCents: 0 }).success).toBe(false);
    expect(ledgerEntrySchema.safeParse({ ...base, type: "PAYMENT", amountCents: -5 }).success).toBe(false);
    expect(ledgerEntrySchema.safeParse({ ...base, type: "PAYMENT", amountCents: 5 }).success).toBe(true);
  });

  test("an adjustment may be negative but not zero", () => {
    expect(ledgerEntrySchema.safeParse({ ...base, type: "ADJUSTMENT", amountCents: -500 }).success).toBe(true);
    expect(ledgerEntrySchema.safeParse({ ...base, type: "ADJUSTMENT", amountCents: 0 }).success).toBe(false);
  });

  test("a payment has no due date, and a due date cannot precede the entry date", () => {
    expect(
      ledgerEntrySchema.safeParse({ ...base, type: "PAYMENT", amountCents: 5, dueDate: "2026-11-01" }).success,
    ).toBe(false);
    expect(
      ledgerEntrySchema.safeParse({ ...base, type: "CHARGE", amountCents: 5, dueDate: "2026-10-01" }).success,
    ).toBe(false);
    expect(
      ledgerEntrySchema.safeParse({ ...base, type: "CHARGE", amountCents: 5, dueDate: "2026-11-12" }).success,
    ).toBe(true);
  });

  test("a write-off is positive and must say why", () => {
    const writeOff = { ...base, type: "WRITE_OFF", amountCents: 500 };
    expect(ledgerEntrySchema.safeParse({ ...writeOff, note: "Customer closed, uncollectible" }).success).toBe(true);
    expect(ledgerEntrySchema.safeParse(writeOff).success).toBe(false);
    expect(ledgerEntrySchema.safeParse({ ...writeOff, note: "  ok " }).success).toBe(false);
    expect(ledgerEntrySchema.safeParse({ ...writeOff, amountCents: -500, note: "Customer closed" }).success).toBe(false);
    expect(ledgerEntrySchema.safeParse({ ...writeOff, dueDate: "2026-11-01", note: "Customer closed" }).success).toBe(false);
  });

  test("a reversal cannot be posted directly: it only comes from reversing an entry", () => {
    expect(ledgerEntrySchema.safeParse({ ...base, type: "REVERSAL", amountCents: 500, note: "Because" }).success).toBe(false);
  });

  test("rejects fractional cents and unknown types", () => {
    expect(ledgerEntrySchema.safeParse({ ...base, type: "CHARGE", amountCents: 10.5 }).success).toBe(false);
    expect(ledgerEntrySchema.safeParse({ ...base, type: "REFUND", amountCents: 10 }).success).toBe(false);
  });
});

describe("reversalSchema", () => {
  test("needs a real reason, and an optional request key that must be a uuid", () => {
    expect(reversalSchema.safeParse({ reason: "  " }).success).toBe(false);
    expect(reversalSchema.safeParse({ reason: "Check bounced" }).success).toBe(true);
    expect(reversalSchema.safeParse({ reason: "Check bounced", requestKey: "not-a-uuid" }).success).toBe(false);
    expect(reversalSchema.safeParse({ reason: "Check bounced", requestKey: crypto.randomUUID() }).success).toBe(true);
  });
});

describe("voidSchema and loginSchema", () => {
  test("a void needs a real reason", () => {
    expect(voidSchema.safeParse({ reason: "  " }).success).toBe(false);
    expect(voidSchema.safeParse({ reason: "ok" }).success).toBe(false);
    expect(voidSchema.safeParse({ reason: "Entered twice" }).success).toBe(true);
  });

  test("login needs both fields", () => {
    expect(loginSchema.safeParse({ username: "admin", password: "" }).success).toBe(false);
    expect(loginSchema.safeParse({ username: "  ", password: "x" }).success).toBe(false);
    expect(loginSchema.safeParse({ username: "admin", password: "x" }).success).toBe(true);
  });
});
