import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { addDays, diffDays } from "./dates";
import { formatCents, parseMoneyToCents } from "./money";
import { MAX_AMOUNT_CENTS, type LedgerType } from "./constants";
import { balanceCents, computeAging, effectOnBalance, reversalFor, writtenOffCents, type LedgerRecord } from "./ledger";

/**
 * Property tests: instead of a handful of hand-picked cases, these generate hundreds of random ledgers and check rules that
 * must hold for ALL of them. A bug in the aging or reversal logic that no example thought of shows up here.
 */

const ASOF = "2026-10-13";
const BASE = "2026-06-01";

const day = fc.integer({ min: 0, max: 130 }).map((offset) => addDays(BASE, offset)); // up to a few days past ASOF
const cents = fc.integer({ min: 1, max: 5_000_00 });
const nonZeroSigned = fc.integer({ min: -2_000_00, max: 2_000_00 }).filter((value) => value !== 0);

let counter = 0;
const id = () => `e${(counter += 1)}`;

const entry = fc
  .record({
    type: fc.constantFrom<LedgerType>("CHARGE", "PAYMENT", "ADJUSTMENT", "WRITE_OFF"),
    amount: cents,
    signed: nonZeroSigned,
    entryDate: day,
    dueOffset: fc.option(fc.integer({ min: 0, max: 60 }), { nil: null }),
  })
  .map((raw): LedgerRecord => {
    const entryDate = raw.entryDate;
    const dueDate = raw.dueOffset === null ? null : addDays(entryDate, raw.dueOffset);
    const amountCents = raw.type === "ADJUSTMENT" ? raw.signed : raw.amount;
    return { id: id(), type: raw.type, amountCents, entryDate, dueDate: raw.type === "PAYMENT" || raw.type === "WRITE_OFF" ? null : dueDate, voided: false };
  });

const ledger = fc.array(entry, { minLength: 0, maxLength: 14 });

describe("balance and aging invariants (any ledger)", () => {
  test("the balance is exactly the sum of what each entry does to it", () => {
    fc.assert(
      fc.property(ledger, (entries) => {
        const expected = entries.filter((e) => e.entryDate <= ASOF).reduce((sum, e) => sum + effectOnBalance(e.type, e.amountCents), 0);
        expect(computeAging(entries, ASOF).balanceCents).toBe(expected);
      }),
    );
  });

  test("what is still open adds up to the balance when money is owed, and to nothing when it is not (the rest is credit)", () => {
    fc.assert(
      fc.property(ledger, (entries) => {
        const aging = computeAging(entries, ASOF);
        const open = aging.openItems.reduce((sum, item) => sum + item.remainingCents, 0);
        expect(open).toBe(Math.max(0, aging.balanceCents));
        expect(aging.creditCents).toBe(Math.max(0, -aging.balanceCents));
        // The buckets are the same money, sorted by age.
        const bucketTotal = Object.values(aging.buckets).reduce((sum, value) => sum + value, 0);
        expect(bucketTotal).toBe(open);
        expect(aging.overdueCents).toBeLessThanOrEqual(open);
      }),
    );
  });

  test("the order the entries are listed in changes nothing", () => {
    fc.assert(
      // A genuine random permutation (fc.shuffledSubarray keeping every element), not one fixed reversal.
      fc.property(ledger.chain((entries) => fc.tuple(fc.constant(entries), fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }))), ([entries, shuffled]) => {
        expect(computeAging(shuffled, ASOF)).toEqual(computeAging(entries, ASOF));
      }),
    );
  });

  test("an entry dated after the as-of day never affects that day's figures", () => {
    fc.assert(
      fc.property(ledger, entry, (entries, extra) => {
        const later = { ...extra, entryDate: addDays(ASOF, 1) };
        expect(computeAging([...entries, later], ASOF)).toEqual(computeAging(entries, ASOF));
      }),
    );
  });

  test("a voided entry is the same as an entry that was never made", () => {
    fc.assert(
      fc.property(ledger, entry, (entries, extra) => {
        expect(computeAging([...entries, { ...extra, voided: true }], ASOF)).toEqual(computeAging(entries, ASOF));
      }),
    );
  });

  test("the oldest overdue age is never negative and never larger than the oldest open item's lateness", () => {
    fc.assert(
      fc.property(ledger, (entries) => {
        const aging = computeAging(entries, ASOF);
        expect(aging.oldestOverdueDays).toBeGreaterThanOrEqual(0);
        for (const item of aging.openItems) expect(aging.oldestOverdueDays).toBeGreaterThanOrEqual(diffDays(item.dueDate, ASOF));
      }),
    );
  });
});

describe("reversal invariants", () => {
  /** A ledger, one entry of it chosen to be reversed on a later day, and the reversal of it. */
  const withReversal = fc.tuple(ledger.filter((entries) => entries.length > 0), fc.nat(), fc.integer({ min: 0, max: 20 })).map(([entries, pick, lateness]) => {
    const target = entries[pick % entries.length]!;
    const reversalDay = addDays(target.entryDate > ASOF ? target.entryDate : ASOF, 0);
    const offset = reversalFor(target, reversalDay)!;
    const reversal: LedgerRecord = { id: id(), type: "REVERSAL", amountCents: offset.amountCents, entryDate: addDays(offset.entryDate, lateness), dueDate: null, voided: false, reverses: target.id };
    return { entries, target, reversal };
  });

  test("after a reversal the books are exactly as if the entry had never been made", () => {
    fc.assert(
      fc.property(withReversal, ({ entries, target, reversal }) => {
        const asOf = reversal.entryDate;
        const without = entries.filter((e) => e.id !== target.id);
        expect(computeAging([...entries, reversal], asOf)).toEqual(computeAging(without, asOf));
      }),
    );
  });

  test("before the reversal's day nothing changes: a month already reported stays as it was", () => {
    fc.assert(
      fc.property(withReversal, ({ entries, reversal }) => {
        const before = addDays(reversal.entryDate, -1);
        expect(computeAging([...entries, reversal], before)).toEqual(computeAging(entries, before));
      }),
    );
  });

  test("a reversal always offsets its target exactly, and is never dated earlier than it", () => {
    fc.assert(
      fc.property(entry, day, (target, today) => {
        const offset = reversalFor(target, today)!;
        expect(offset.amountCents + effectOnBalance(target.type, target.amountCents)).toBe(0);
        expect(offset.entryDate >= target.entryDate).toBe(true);
      }),
    );
  });

  test("a reversed write-off no longer counts as written off", () => {
    fc.assert(
      fc.property(cents, day, (amount, entryDate) => {
        const writeOff: LedgerRecord = { id: id(), type: "WRITE_OFF", amountCents: amount, entryDate, dueDate: null, voided: false };
        const reversal: LedgerRecord = { id: id(), type: "REVERSAL", amountCents: amount, entryDate: addDays(entryDate, 1), dueDate: null, voided: false, reverses: writeOff.id };
        const asOf = addDays(entryDate, 5);
        expect(writtenOffCents([writeOff], asOf)).toBe(amount);
        expect(writtenOffCents([writeOff, reversal], asOf)).toBe(0);
      }),
    );
  });
});

describe("money and dates round-trip", () => {
  test("a formatted amount parses back to the same number of cents", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_AMOUNT_CENTS }), (value) => {
        expect(parseMoneyToCents(formatCents(value, { fixed: true }))).toBe(value);
      }),
    );
  });

  test("adding days and measuring the difference are inverses, across month ends, leap years and clock changes", () => {
    fc.assert(
      fc.property(day, fc.integer({ min: -4000, max: 4000 }), (start, days) => {
        expect(diffDays(start, addDays(start, days))).toBe(days);
      }),
    );
  });

  test("the balance of any ledger is the same however many pieces it is summed in", () => {
    fc.assert(
      fc.property(ledger, ledger, (a, b) => {
        expect(balanceCents([...a, ...b])).toBe(balanceCents(a) + balanceCents(b));
      }),
    );
  });
});
