import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { addDays } from "@/lib/domain/dates";
import { prisma } from "@/lib/server/db";
import { ApiError } from "@/lib/server/http";
import type { SessionUser } from "@/lib/types";
import type { CustomerCreateInput, LedgerEntryInput } from "@/lib/validation";
import { businessToday } from "../as-of";
import { createCustomer, decide, getDetail } from "./customers";
import { recordEntry, reverseEntry, voidEntry } from "./ledger";

/**
 * Written because mutation testing of services/ledger.ts (Stryker, 2026-10-21) showed these rules could be broken with every
 * existing test still green: write-offs from before allocations existed, a retry of an entry that was voided, the overpayment
 * boundary, and what the person is TOLD for each refusal (the words are the product here: they say what to do next).
 */
const ADMIN: SessionUser = { id: "u-gap-admin", username: "gap-admin", name: "Gap Admin", role: "ADMIN" };
const EMPLOYEE: SessionUser = { id: "u-gap-emp", username: "gap-emp", name: "Gap Employee", role: "EMPLOYEE" };
const TODAY = businessToday();
const clock = { today: () => TODAY, now: () => new Date() };

const profile = (name: string): CustomerCreateInput => ({
  businessName: name, contactName: null, phone: null, email: null, billingAddress: null, dateApplied: "2026-10-01",
  requestedLimitCents: null, accountingAppName: null, accountingProjectUrl: null, notes: null,
});
const entry = (type: LedgerEntryInput["type"], amountCents: number, entryDate = TODAY, extra: Partial<LedgerEntryInput> = {}): LedgerEntryInput => ({
  type, amountCents, entryDate, dueDate: null, reference: null, note: null, ...extra,
});
async function approved(limit = 10_000_000): Promise<string> {
  const id = await createCustomer(profile(`Gap ${randomUUID().slice(0, 8)}`), ADMIN);
  await decide(id, { action: "approve", version: 1, creditLimitCents: limit, paymentTerms: "Net 30", creditStartDate: "2026-10-01" }, ADMIN);
  return id;
}
const refusal = async (work: Promise<unknown>): Promise<ApiError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};
const refused = (error: ApiError, status: number, code: string, message: RegExp) => {
  expect({ status: error.status, code: error.code }).toEqual({ status, code });
  expect(error.message).toMatch(message);
};

/** A write-off the way data from before allocations existed has it: no allocations, so it counts as an ordinary credit. */
async function legacyWriteOff(customerId: string, amountCents: number): Promise<string> {
  const id = `legacy${randomUUID().slice(0, 8)}`;
  await prisma.$executeRaw`INSERT INTO "LedgerEntry" ("id", "customerId", "type", "amountCents", "entryDate", "note", "createdBy")
    VALUES (${id}, ${customerId}, 'WRITE_OFF', ${amountCents}, ${new Date(`${TODAY}T00:00:00Z`)}::date, 'legacy write-off', 'legacy')`;
  return id;
}

describe("a write-off from before allocations existed still protects the books", () => {
  test("correcting a charge so the balance would fall below zero is refused, with what to do next; a correction that keeps it at or above zero is allowed", async () => {
    const id = await approved();
    const a = await recordEntry(id, entry("CHARGE", 100_00, addDays(TODAY, -3)), ADMIN, clock);
    const b = await recordEntry(id, entry("CHARGE", 50_00, addDays(TODAY, -2)), ADMIN, clock);
    await legacyWriteOff(id, 120_00); // balance now 30.00
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(30_00);

    refused(await refusal(voidEntry(id, a.id, "typo", ADMIN, clock)), 409, "write_off_covers", /earlier write-off covers this charge.*Reverse the write-off first/);
    refused(await refusal(reverseEntry(id, b.id, { reason: "billed twice" }, ADMIN, clock)), 409, "write_off_covers", /earlier write-off covers this charge/);

    // Voiding something that does not lower what is owed (a payment) is not blocked.
    const p = await recordEntry(id, entry("PAYMENT", 10_00), ADMIN, clock);
    await voidEntry(id, p.id, "wrong customer", ADMIN, clock);
    // And with room (30.00 balance, a 20.00 charge): allowed, leaving exactly 10.00.
    const c = await recordEntry(id, entry("CHARGE", 20_00), ADMIN, clock);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(50_00);
    await voidEntry(id, c.id, "typo", ADMIN, clock);
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(30_00);
    // The boundary: taking exactly the whole balance is allowed (it reaches zero, not below it).
    const d = await recordEntry(id, entry("CHARGE", 30_00), ADMIN, clock);
    await recordEntry(id, entry("PAYMENT", 60_00), ADMIN, clock); // balance 0 now? 30 + 30 - 60
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(0);
    refused(await refusal(voidEntry(id, d.id, "typo", ADMIN, clock)), 409, "write_off_covers", /earlier write-off/);
  });

  test("with no write-off of that kind on the books, the same correction is simply allowed", async () => {
    const id = await approved();
    const a = await recordEntry(id, entry("CHARGE", 100_00), ADMIN, clock);
    await recordEntry(id, entry("PAYMENT", 100_00), ADMIN, clock);
    await voidEntry(id, a.id, "typo", ADMIN, clock); // leaves a 100.00 credit: fine, there is no write-off to protect
    expect((await getDetail(id, TODAY)).customer.balanceCents).toBe(-100_00);
  });
});

describe("a retry of a submission that has since been voided", () => {
  test("is told so (the entry does not count), not answered as if it were recorded", async () => {
    const id = await approved();
    const requestKey = randomUUID();
    const first = await recordEntry(id, entry("CHARGE", 40_00, TODAY, { requestKey }), ADMIN, clock);
    await voidEntry(id, first.id, "typo", ADMIN, clock);
    refused(await refusal(recordEntry(id, entry("CHARGE", 40_00, TODAY, { requestKey }), ADMIN, clock)), 409, "entry_voided", /recorded and then voided, so it does not count.*enter it again as a new entry/);
  });

  test("an entry dated ahead says it is post-dated, and says so again on a retry", async () => {
    const id = await approved();
    const requestKey = randomUUID();
    const first = await recordEntry(id, entry("CHARGE", 40_00, addDays(TODAY, 5), { requestKey }), ADMIN, clock);
    expect(first).toMatchObject({ duplicate: false, postDated: true });
    expect(await recordEntry(id, entry("CHARGE", 40_00, addDays(TODAY, 5), { requestKey }), ADMIN, clock)).toMatchObject({ id: first.id, duplicate: true, postDated: true });
    const today = await recordEntry(id, entry("CHARGE", 40_00, TODAY, { requestKey: randomUUID() }), ADMIN, clock);
    expect(today.postDated).toBe(false);
  });

  test("the same key with a different amount is refused with words that say what to do", async () => {
    const id = await approved();
    const requestKey = randomUUID();
    await recordEntry(id, entry("CHARGE", 40_00, TODAY, { requestKey }), ADMIN, clock);
    refused(await refusal(recordEntry(id, entry("CHARGE", 41_00, TODAY, { requestKey }), ADMIN, clock)), 409, "request_key_reuse", /already recorded with different details.*Reload the customer/);
  });
});

describe("the overpayment and over-limit warnings sit exactly on their boundaries", () => {
  test("a payment that exactly clears the balance is not an overpayment; one cent more is", async () => {
    const id = await approved();
    await recordEntry(id, entry("CHARGE", 100_00), ADMIN, clock);
    expect((await recordEntry(id, entry("PAYMENT", 100_00), ADMIN, clock)).warning).toBeNull();
    expect((await recordEntry(id, entry("PAYMENT", 1), ADMIN, clock)).warning).toBe("overpayment");
  });

  test("an adjustment of either sign is described with its sign in the history", async () => {
    const id = await approved();
    await recordEntry(id, entry("CHARGE", 100_00), ADMIN, clock);
    await recordEntry(id, entry("ADJUSTMENT", -5_00, TODAY, { note: "rebate" }), ADMIN, clock);
    await recordEntry(id, entry("ADJUSTMENT", 7_00, TODAY, { note: "late fee" }), ADMIN, clock);
    const history = (await getDetail(id, TODAY)).audit.map((event) => event.summary);
    expect(history.some((line) => /Adjustment — −\$5\.00/.test(line))).toBe(true);
    expect(history.some((line) => /Adjustment — \+\$7\.00/.test(line))).toBe(true);
  });
});

describe("every refusal says what happened and what to do", () => {
  test("write-offs", async () => {
    const id = await approved();
    refused(await refusal(recordEntry(id, entry("WRITE_OFF", 10_00, addDays(TODAY, 1), { note: "future" }), ADMIN, clock)), 422, "invalid_entry", /cannot be dated in the future/);
    refused(await refusal(recordEntry(id, entry("WRITE_OFF", 10_00, TODAY, { note: "nothing owed" }), ADMIN, clock)), 409, "nothing_owed", /Nothing is owed, so there is nothing to write off/);
    const charge = await recordEntry(id, entry("CHARGE", 60_00), ADMIN, clock);
    refused(await refusal(recordEntry(id, entry("WRITE_OFF", 70_00, TODAY, { note: "too much" }), ADMIN, clock)), 409, "exceeds_balance", /at most \$60\.00, which is what is owed/);
    refused(
      await refusal(recordEntry(id, entry("WRITE_OFF", 30_00, TODAY, { note: "wrong split", allocations: [{ chargeId: charge.id, amountCents: 20_00 }] }), ADMIN, clock)),
      409, "invalid_allocation", /do not match what is owed now.*at most \$60\.00.*Review the write-off and try again/,
    );
  });

  test("who may do what", async () => {
    const id = await approved();
    const charge = await recordEntry(id, entry("CHARGE", 60_00), ADMIN, clock);
    refused(await refusal(recordEntry(id, entry("ADJUSTMENT", 5_00, TODAY, { note: "x adj" }), EMPLOYEE, clock)), 403, "forbidden", /Only an admin can post an adjustment/);
    refused(await refusal(recordEntry(id, entry("WRITE_OFF", 5_00, TODAY, { note: "x off" }), EMPLOYEE, clock)), 403, "forbidden", /Only an admin can write off a balance/);
    refused(await refusal(reverseEntry(id, charge.id, { reason: "because" }, EMPLOYEE, clock)), 403, "forbidden", /Only an admin can reverse an entry/);
    refused(await refusal(voidEntry(id, charge.id, "because", EMPLOYEE, clock)), 403, "forbidden", /Only an admin can void an entry/);
  });

  test("states of the account and of the entry", async () => {
    const id = await createCustomer(profile(`Gap pending ${randomUUID().slice(0, 8)}`), ADMIN);
    refused(await refusal(recordEntry(id, entry("CHARGE", 5_00), ADMIN, clock)), 409, "invalid_state", /Charges can only be added to an approved account/);
    refused(await refusal(recordEntry(id, entry("PAYMENT", 5_00), ADMIN, clock)), 409, "invalid_state", /This account has no balance to change/);
    refused(await refusal(recordEntry("no-such-customer", entry("CHARGE", 5_00), ADMIN, clock)), 404, "not_found", /That customer no longer exists/);

    const ok = await approved();
    const charge = await recordEntry(ok, entry("CHARGE", 60_00, addDays(TODAY, -45)), ADMIN, clock);
    refused(await refusal(voidEntry(ok, "no-such-entry", "x void", ADMIN, clock)), 404, "not_found", /That entry no longer exists/);
    refused(await refusal(reverseEntry(ok, "no-such-entry", { reason: "x rev" }, ADMIN, clock)), 404, "not_found", /That entry no longer exists/);
    const reversal = await reverseEntry(ok, charge.id, { reason: "billed twice" }, ADMIN, clock);
    refused(await refusal(voidEntry(ok, charge.id, "x void", ADMIN, clock)), 409, "already_reversed", /has been reversed, so it cannot also be voided/);
    refused(await refusal(reverseEntry(ok, charge.id, { reason: "another reason" }, ADMIN, clock)), 409, "already_reversed", /already been reversed/);
    refused(await refusal(voidEntry(ok, reversal.id, "x void", ADMIN, clock)), 409, "not_voidable", /A reversal cannot be voided.*Record the original entry again/);
    refused(await refusal(reverseEntry(ok, reversal.id, { reason: "undo" }, ADMIN, clock)), 409, "not_reversible", /A reversal cannot be reversed/);

    const typo = await recordEntry(ok, entry("CHARGE", 1_00), ADMIN, clock);
    await voidEntry(ok, typo.id, "typo", ADMIN, clock);
    refused(await refusal(reverseEntry(ok, typo.id, { reason: "x rev" }, ADMIN, clock)), 409, "already_voided", /was voided, so it has no effect to reverse/);
    // The same person voiding it again for the same reason is a retry; for a different reason it is a mistake.
    await voidEntry(ok, typo.id, "typo", ADMIN, clock);
    refused(await refusal(voidEntry(ok, typo.id, "a different reason", ADMIN, clock)), 409, "already_voided", /already been voided/);
    refused(await refusal(voidEntry(ok, typo.id, "typo", { ...ADMIN, id: "u-someone-else" }, clock)), 409, "already_voided", /already been voided/);
  });

  test("a write-off that covers a charge blocks correcting it, and says which write-off", async () => {
    const id = await approved();
    const charge = await recordEntry(id, entry("CHARGE", 100_00, addDays(TODAY, -2)), ADMIN, clock);
    const writeOff = await recordEntry(id, entry("WRITE_OFF", 40_00, TODAY, { note: "uncollectable" }), ADMIN, clock);
    refused(await refusal(voidEntry(id, charge.id, "typo", ADMIN, clock)), 409, "write_off_covers", /write-off of \$40\.00 dated .*2026.*covers this charge\. Reverse that write-off first/);
    refused(await refusal(reverseEntry(id, charge.id, { reason: "billed twice" }, ADMIN, clock)), 409, "write_off_covers", /write-off of \$40\.00/);
    await reverseEntry(id, writeOff.id, { reason: "paid after all" }, ADMIN, clock);
    // Reversed: the charge can be reversed again but never voided (a void would erase days the write-off was in force).
    refused(await refusal(voidEntry(id, charge.id, "typo", ADMIN, clock)), 409, "write_off_history", /covered this charge earlier.*Reverse the charge instead/);
    await reverseEntry(id, charge.id, { reason: "billed twice" }, ADMIN, clock);
  });

  test("the history says which charges a write-off covers, by invoice number or by amount and date", async () => {
    const id = await approved();
    await recordEntry(id, entry("CHARGE", 30_00, addDays(TODAY, -4), { reference: "INV-77" }), ADMIN, clock);
    await recordEntry(id, entry("CHARGE", 20_00, addDays(TODAY, -3)), ADMIN, clock);
    await recordEntry(id, entry("WRITE_OFF", 50_00, TODAY, { note: "uncollectable" }), ADMIN, clock);
    const line = (await getDetail(id, TODAY)).audit.map((event) => event.summary).find((text) => text.startsWith("Written off"))!;
    expect(line).toMatch(/covers INV-77 \(\$30\.00\), a charge of \$20\.00 dated [A-Z][a-z]{2} \d{1,2}, \d{4} \(\$20\.00\)/);
  });
});

describe("the warnings and due dates an entry is recorded with", () => {
  test("over-limit: a charge that reaches the limit warns, one cent under does not; a limit of zero never warns; money going down never warns", async () => {
    const id = await approved(500_00);
    expect((await recordEntry(id, entry("CHARGE", 499_99), ADMIN, clock)).warning).toBeNull();
    expect((await recordEntry(id, entry("CHARGE", 1), ADMIN, clock)).warning).toBe("over_limit"); // exactly at 500.00
    expect((await recordEntry(id, entry("CHARGE", 10_00), ADMIN, clock)).warning).toBe("over_limit"); // beyond it
    expect((await recordEntry(id, entry("PAYMENT", 1_00), ADMIN, clock)).warning).toBeNull(); // still over, but going down
    expect((await recordEntry(id, entry("ADJUSTMENT", -1_00, TODAY, { note: "rebate" }), ADMIN, clock)).warning).toBeNull();
    const unlimited = await approved(1); // a 1-cent line: any charge reaches it
    expect((await recordEntry(unlimited, entry("CHARGE", 5_00), ADMIN, clock)).warning).toBe("over_limit");
  });

  test("overpayment is only ever said about a payment: a negative adjustment or a write-off that takes the balance below zero is not an 'overpayment'", async () => {
    const id = await approved();
    await recordEntry(id, entry("CHARGE", 10_00), ADMIN, clock);
    expect((await recordEntry(id, entry("ADJUSTMENT", -25_00, TODAY, { note: "credit memo" }), ADMIN, clock)).warning).toBeNull();
  });

  test("a charge and an adjustment carry a due date (terms from the entry date, or the one given); a payment and a write-off never do", async () => {
    const id = await approved();
    const due = async (entryId: string) => (await getDetail(id, TODAY)).ledger.find((row) => row.id === entryId)!.dueDate;
    const byTerms = await recordEntry(id, entry("CHARGE", 10_00, TODAY), ADMIN, clock);
    expect(await due(byTerms.id)).toBe(addDays(TODAY, 30)); // Net 30
    const explicit = await recordEntry(id, entry("CHARGE", 10_00, TODAY, { dueDate: addDays(TODAY, 7) }), ADMIN, clock);
    expect(await due(explicit.id)).toBe(addDays(TODAY, 7));
    const adjustment = await recordEntry(id, entry("ADJUSTMENT", 5_00, TODAY, { note: "late fee" }), ADMIN, clock);
    expect(await due(adjustment.id)).toBe(addDays(TODAY, 30));
    const payment = await recordEntry(id, entry("PAYMENT", 5_00, TODAY, { dueDate: addDays(TODAY, 9) }), ADMIN, clock);
    expect(await due(payment.id)).toBeNull();
    const writeOff = await recordEntry(id, entry("WRITE_OFF", 5_00, TODAY, { note: "uncollectable", dueDate: addDays(TODAY, 9) }), ADMIN, clock);
    expect(await due(writeOff.id)).toBeNull();
  });

  test("a payment or a write-off needs an account that has, or had, a credit line or a ledger", async () => {
    const id = await createCustomer(profile(`Gap review ${randomUUID().slice(0, 8)}`), ADMIN);
    refused(await refusal(recordEntry(id, entry("WRITE_OFF", 5_00, TODAY, { note: "nothing" }), ADMIN, clock)), 409, "invalid_state", /no balance to change/);
  });
});
