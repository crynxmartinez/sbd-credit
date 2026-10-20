import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { addDays } from "@/lib/domain/dates";
import { ApiError } from "@/lib/server/http";
import { assertBooksAgree, footprint, rawRows } from "@/test/books-oracle";
import type { SessionUser } from "@/lib/types";
import type { CustomerCreateInput, LedgerEntryInput } from "@/lib/validation";
import { businessToday } from "../as-of";
import { createCustomer, decide } from "./customers";
import { recordEntry, reverseEntry, voidEntry } from "./ledger";

/**
 * Many people at once on ONE customer. Writers to a customer are serialised by a row lock, so whatever order they land in the books
 * must be one that could have happened one at a time: figures equal the independent oracle, nothing is recorded twice, nothing is
 * allocated past what is owed, and nobody waits forever.
 */
const ADMIN: SessionUser = { id: "u-conc-admin", username: "conc-admin", name: "Concurrent Admin", role: "ADMIN" };
const ADMIN_TWO: SessionUser = { id: "u-conc-admin-2", username: "conc-admin-2", name: "Concurrent Admin Two", role: "ADMIN" };
const TODAY = businessToday();
const clock = { today: () => TODAY, now: () => new Date() };

const profile = (name: string): CustomerCreateInput => ({
  businessName: name, contactName: null, phone: null, email: null, billingAddress: null, dateApplied: "2026-10-01",
  requestedLimitCents: null, accountingAppName: null, accountingProjectUrl: null, notes: null,
});
const entry = (type: LedgerEntryInput["type"], amountCents: number, entryDate: string, extra: Partial<LedgerEntryInput> = {}): LedgerEntryInput => ({
  type, amountCents, entryDate, dueDate: null, reference: null, note: null, ...extra,
});

async function approvedCustomer(): Promise<string> {
  const id = await createCustomer(profile(`Concurrent ${randomUUID().slice(0, 8)}`), ADMIN);
  await decide(id, { action: "approve", version: 1, creditLimitCents: 10_000_000, paymentTerms: "Net 30", creditStartDate: "2026-10-01" }, ADMIN);
  return id;
}

/** "ok", or the name of a clean refusal. Anything that is not a clean refusal is rethrown, and fails the test. */
const outcome = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof ApiError) return error.code;
    throw error;
  }
};

describe("many writers on one customer", () => {
  test("a crowd of mixed writes (charges, payments, write-offs, reversals, voids) ends in books that match the one-at-a-time oracle", async () => {
    const stepArb = fc.tuple(fc.nat(5), fc.integer({ min: 1, max: 40 }), fc.integer({ min: 0, max: 12 }), fc.nat(20));
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 12, maxLength: 28 }), async (steps) => {
        const id = await approvedCustomer();
        const ids: string[] = [];
        for (let i = 0; i < 4; i += 1) {
          const seeded = await recordEntry(id, entry("CHARGE", 30 + i * 7, addDays(TODAY, -(i * 4)), { dueDate: addDays(TODAY, 30 - i * 20) }), ADMIN, clock);
          ids.push(seeded.id);
        }

        const started = Date.now();
        const results = await Promise.all(
          steps.map(([kind, amt, ago, pick], index) => {
            const actor = index % 2 === 0 ? ADMIN : ADMIN_TWO;
            const date = addDays(TODAY, -ago);
            const target = ids[pick % ids.length]!;
            if (kind === 0) return outcome(recordEntry(id, entry("CHARGE", amt, date), actor, clock));
            if (kind === 1) return outcome(recordEntry(id, entry("PAYMENT", amt, date), actor, clock));
            if (kind === 2) return outcome(recordEntry(id, entry("WRITE_OFF", amt, TODAY, { note: "crowd write-off" }), actor, clock));
            if (kind === 3) return outcome(reverseEntry(id, target, { reason: `crowd reversal ${index}` }, actor, clock));
            if (kind === 4) return outcome(voidEntry(id, target, `crowd void ${index}`, actor, clock));
            return outcome(recordEntry(id, entry("ADJUSTMENT", amt, date, { note: "crowd adjustment" }), actor, clock));
          }),
        );
        expect(Date.now() - started, "nobody waited anywhere near the lock timeout").toBeLessThan(8_000);
        expect(results.length).toBe(steps.length);
        await assertBooksAgree(id, `crowd ${JSON.stringify(steps).slice(0, 80)}`, TODAY);
      }),
      { numRuns: 12 },
    );
  }, 240_000);

  test("the same submission sent ten times at once is recorded exactly once", async () => {
    const id = await approvedCustomer();
    const requestKey = randomUUID();
    const input = entry("PAYMENT", 25_00, TODAY, { requestKey, reference: "CHK-1" });
    await recordEntry(id, entry("CHARGE", 100_00, TODAY), ADMIN, clock);
    const before = JSON.parse(await footprint(id)) as { l: number; a: number };
    const results = await Promise.all(Array.from({ length: 10 }, () => recordEntry(id, input, ADMIN, clock)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const after = JSON.parse(await footprint(id)) as { l: number; a: number };
    expect({ rows: after.l - before.l, audit: after.a - before.a }).toEqual({ rows: 1, audit: 1 });
    await assertBooksAgree(id, "ten identical submissions", TODAY);
  });

  test("two write-offs each for everything that is owed, at the same moment: one is accepted, the other is refused, and nothing is allocated twice", async () => {
    for (let round = 0; round < 5; round += 1) {
      const id = await approvedCustomer();
      await recordEntry(id, entry("CHARGE", 60_00, addDays(TODAY, -20), { dueDate: addDays(TODAY, -5) }), ADMIN, clock);
      await recordEntry(id, entry("CHARGE", 40_00, addDays(TODAY, -2)), ADMIN, clock);
      const results = await Promise.all([
        outcome(recordEntry(id, entry("WRITE_OFF", 100_00, TODAY, { note: "first of two" }), ADMIN, clock)),
        outcome(recordEntry(id, entry("WRITE_OFF", 100_00, TODAY, { note: "second of two" }), ADMIN_TWO, clock)),
      ]);
      expect(results.filter((r) => r === "ok"), `round ${round}: ${results.join(",")}`).toHaveLength(1);
      expect(results.filter((r) => r !== "ok")[0]).toMatch(/nothing_owed|exceeds_balance/);
      const { allocs } = await rawRows(id);
      expect(allocs.reduce((sum, a) => sum + a.amountCents, 0)).toBe(100_00);
      await assertBooksAgree(id, `two write-offs round ${round}`, TODAY);
    }
  });

  test("two administrators reversing the same entry for different reasons: one reversal, one clean refusal", async () => {
    const id = await approvedCustomer();
    const charge = await recordEntry(id, entry("CHARGE", 50_00, addDays(TODAY, -40)), ADMIN, clock);
    const results = await Promise.all([
      outcome(reverseEntry(id, charge.id, { reason: "billed twice" }, ADMIN, clock)),
      outcome(reverseEntry(id, charge.id, { reason: "wrong customer" }, ADMIN_TWO, clock)),
    ]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "already_reversed")).toHaveLength(1);
    const { rows } = await rawRows(id);
    expect(rows.filter((row) => row.type === "REVERSAL")).toHaveLength(1);
    await assertBooksAgree(id, "double reversal", TODAY);
  });

  test("a payment and a void of the charge it pays, at the same moment, never leave a write-off without its charge", async () => {
    for (let round = 0; round < 5; round += 1) {
      const id = await approvedCustomer();
      const charge = await recordEntry(id, entry("CHARGE", 80_00, TODAY), ADMIN, clock);
      await recordEntry(id, entry("WRITE_OFF", 30_00, TODAY, { note: "part uncollectable" }), ADMIN, clock);
      const results = await Promise.all([
        outcome(voidEntry(id, charge.id, "typo", ADMIN, clock)),
        outcome(recordEntry(id, entry("PAYMENT", 10_00, TODAY), ADMIN_TWO, clock)),
      ]);
      // The write-off covers the charge, so the void must be refused whatever the order.
      expect(results[0]).toBe("write_off_covers");
      await assertBooksAgree(id, `void vs payment round ${round}`, TODAY);
    }
  });
});
