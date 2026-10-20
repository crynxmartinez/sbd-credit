import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, test } from "vitest";
import { addDays } from "@/lib/domain/dates";
import type { SessionUser } from "@/lib/types";
import type { CustomerCreateInput } from "@/lib/validation";
import { businessToday } from "../as-of";
import { createCustomer, decide, getDetail, listSummaries } from "./customers";
import { ledgerCsv } from "./exports";
import { LEDGER_CSV_HEADER } from "@/lib/domain/ledger-csv";
import { recordEntry, reverseEntry, voidEntry } from "./ledger";

/**
 * A screen is built from several reads. If a write commits BETWEEN two of them, the screen can show a figure that never existed in the
 * books (half of one moment, half of another). These tests make that interleaving happen on purpose, at the driver, and require the
 * answer to match one real moment: before the write or after it, never a mixture.
 */
const ADMIN: SessionUser = { id: "u-snap-admin", username: "snap-admin", name: "Snapshot Admin", role: "ADMIN" };
const TODAY = businessToday();
const clock = { today: () => TODAY, now: () => new Date() };

const profile = (name: string): CustomerCreateInput => ({
  businessName: name, contactName: null, phone: null, email: null, billingAddress: null, dateApplied: "2026-10-01",
  requestedLimitCents: null, accountingAppName: null, accountingProjectUrl: null, notes: null,
});
const entry = (type: "CHARGE" | "PAYMENT" | "WRITE_OFF", amountCents: number, entryDate: string, extra: object = {}) => ({
  type, amountCents, entryDate, dueDate: null, reference: null, note: null, ...extra,
});

async function approvedCustomer(): Promise<string> {
  const id = await createCustomer(profile(`Snapshot ${randomUUID().slice(0, 8)}`), ADMIN);
  await decide(id, { action: "approve", version: 1, creditLimitCents: 1_000_000, paymentTerms: "Net 30", creditStartDate: "2026-10-01" }, ADMIN);
  return id;
}

interface Deferred<T = void> { promise: Promise<T>; resolve: (value: T) => void }
const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

type Query = (...args: unknown[]) => Promise<unknown>;
const proto = pg.Client.prototype as unknown as { query: Query };
const realQuery = proto.query;
afterEach(() => { proto.query = realQuery; });

/**
 * Holds the FIRST statement matching `hold` until released, reports when it has been reached, and reports when a statement matching
 * `done` has finished. Everything else runs untouched.
 */
function intercept(opts: { hold?: (sql: string, values: unknown[]) => boolean; done?: (sql: string) => boolean }) {
  const reached = deferred();
  const release = deferred();
  const finished = deferred();
  let held = false;
  proto.query = function (this: unknown, ...args: unknown[]) {
    const first = args[0] as string | { text?: string; values?: unknown[] };
    const sql = (typeof first === "string" ? first : (first.text ?? "")).replace(/"credit_[a-z0-9_]+"\./g, "");
    const values = ((typeof first === "string" ? args[1] : (first.values ?? args[1])) ?? []) as unknown[];
    if (opts.hold && !held && opts.hold(sql, values)) {
      held = true;
      reached.resolve();
      return release.promise.then(() => realQuery.apply(this, args));
    }
    if (!opts.done?.(sql)) return realQuery.apply(this, args);
    // The driver is called both ways: with a callback (the pool does) and for a promise.
    const last = args[args.length - 1];
    if (typeof last === "function") {
      args[args.length - 1] = (...callbackArgs: unknown[]) => {
        finished.resolve();
        return (last as (...a: unknown[]) => unknown)(...callbackArgs);
      };
      return realQuery.apply(this, args);
    }
    return realQuery.apply(this, args).then((value) => { finished.resolve(); return value; });
  };
  return { reached: reached.promise, release: release.resolve, finished: finished.promise };
}

describe("a screen is one moment in time", () => {
  test("the customer list: a write-off that commits while the list is being read never half-applies", async () => {
    const id = await approvedCustomer();
    // A is overdue (due 45 days ago). B is not due yet. A write-off of 30 is allocated to B on purpose, not to the oldest charge.
    const a = await recordEntry(id, entry("CHARGE", 50_00, addDays(TODAY, -60), { dueDate: addDays(TODAY, -45) }), ADMIN, clock);
    const b = await recordEntry(id, entry("CHARGE", 60_00, addDays(TODAY, -10), { dueDate: addDays(TODAY, 20) }), ADMIN, clock);

    // The ledger is read after the (small) allocations table, and the write-off commits in between.
    const gate = intercept({
      hold: (sql) => sql.includes('"LedgerEntry"."voidedAt", "LedgerEntry"."reversesEntryId" FROM') && !sql.includes("IN ("),
      done: (sql) => sql.includes('FROM "WriteOffAllocation"') && sql.includes("LEFT JOIN"),
    });
    const listing = listSummaries(TODAY);
    await gate.reached;
    // Read separately (concurrently), the small allocations table is done by now; read in one snapshot it has not even started.
    await Promise.race([gate.finished, new Promise((resolve) => setTimeout(resolve, 400))]);
    const lineA = deferred();
    void lineA;
    await recordEntry(id, entry("WRITE_OFF", 30_00, TODAY, { note: "Uncollectable part of B", allocations: [{ chargeId: b.id, amountCents: 30_00 }] }), ADMIN, clock);
    gate.release();
    const listed = (await listing).find((summary) => summary.id === id)!;
    proto.query = realQuery;

    const truth = (await getDetail(id, TODAY)).customer;
    // After the write-off the truth is: A still open and overdue (50.00), B down to 30.00 and not due.
    expect(truth.overdueCents).toBe(50_00);
    // Before it, A (50.00) and B (60.00) were open and A overdue: also 50.00 overdue. Either moment is fine; a mixture is not.
    expect({ balance: listed.balanceCents, overdue: listed.overdueCents, nextDue: listed.nextDueDate, nextDueCents: listed.nextDueCents }).toEqual({
      balance: listed.balanceCents === 80_00 ? 80_00 : 110_00,
      overdue: 50_00,
      nextDue: addDays(TODAY, -45),
      nextDueCents: 50_00,
    });
    void a;
    // And the figure shown must be consistent with the balance it sits next to: what is open adds up to what is owed.
    const openTotal = Object.values(listed.buckets).reduce((sum, n) => sum + n, 0);
    expect(openTotal).toBe(Math.max(0, listed.balanceCents));
    expect(listed.buckets.d31_60).toBe(50_00);
  });

  test("the customer page: a reversal that commits while the page is being read never shows 'reversed' without the reversal", async () => {
    const id = await approvedCustomer();
    const charge = await recordEntry(id, entry("CHARGE", 100_00, TODAY), ADMIN, clock);

    // The page reads the ledger, then separately asks which entries have been reversed; the reversal commits in between.
    const gate = intercept({ hold: (sql) => sql.includes('"LedgerEntry"."reversesEntryId" FROM') && sql.includes("IN (") });
    const reading = getDetail(id, TODAY);
    // If the page is read in one statement there is nothing to hold, and nothing to interleave with: that is the point.
    await Promise.race([gate.reached, reading]);
    await reverseEntry(id, charge.id, { reason: "Billed twice" }, ADMIN, clock);
    gate.release();
    const detail = await reading;
    proto.query = realQuery;

    const row = detail.ledger.find((e) => e.id === charge.id)!;
    const reversalShown = detail.ledger.some((e) => e.type === "REVERSAL");
    expect(row.reversed, "the entry says it was reversed, so the reversal must be on the page").toBe(reversalShown);
    expect(detail.customer.balanceCents, "and the balance must agree with what is on the page").toBe(reversalShown ? 0 : 100_00);
  });

  /**
   * KNOWN LIMIT, not yet fixed (docs/BOOKS_AUDIT.md, F7). The ledger export reads the table a page at a time, each page a separate
   * statement, so a file made while people are saving can combine two moments: here an entry that was voided (read on page 1, before the
   * void) next to one that was added after it (read on page 2). The file's "counts today" rows then add up to a balance the books never
   * had. `test.fails` keeps this honest: it passes while the limit exists and FAILS the day the export becomes one snapshot, which is the
   * signal to turn it into an ordinary test.
   */
  test.fails("the ledger export across pages shows one moment", async () => {
    const id = await approvedCustomer();
    const first = await recordEntry(id, entry("CHARGE", 10_00, TODAY, { reference: "EXP-1" }), ADMIN, clock);
    await recordEntry(id, entry("CHARGE", 20_00, TODAY, { reference: "EXP-2" }), ADMIN, clock);
    const books = async () => (await getDetail(id, TODAY)).customer.balanceCents;
    const before = await books(); // 30.00: the only moment at which EXP-1 is live and EXP-3 does not exist

    // One row per page. The read that follows the page holding EXP-1 (it carries EXP-1's id as its cursor) is held, and the books change
    // underneath it: EXP-1 is voided, and a new charge is added. EXP-1 has already been read as live; the new charge has not been read yet.
    const hold = intercept({ hold: (sql, values) => sql.includes('FROM "LedgerEntry"') && sql.includes("ORDER BY") && values.includes(first.id) });
    const file = ledgerCsv(TODAY, 1);
    await hold.reached;
    await voidEntry(id, first.id, "typo", ADMIN, clock);
    await recordEntry(id, entry("CHARGE", 5_00, TODAY, { reference: "EXP-3" }), ADMIN, clock);
    hold.release();
    const csv = await file;
    proto.query = realQuery;

    const col = (cells: string[], name: (typeof LEDGER_CSV_HEADER)[number]) => cells[LEDGER_CSV_HEADER.indexOf(name)]!;
    const mine = csv.trim().split(String.fromCharCode(13, 10)).filter((line) => line.startsWith(`${id},`)).map((line) => line.split(","));
    const counted = mine.filter((cells) => col(cells, "Counts today") === "yes").reduce((sum, cells) => sum + Math.round(Number(col(cells, "Effect on balance")) * 100), 0);
    const after = await books();
    expect([before, after], "the file adds up to a balance the books had at no moment").toContain(counted);
  });
});
