import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { addDays } from "@/lib/domain/dates";
import { buildDashboard } from "@/lib/domain/dashboard";
import { writeOffTargets, type Allocation } from "@/lib/domain/write-off";
import { ApiError } from "@/lib/server/http";
import type { SessionUser } from "@/lib/types";
import type { CustomerCreateInput, LedgerEntryInput } from "@/lib/validation";
import { assertBooksAgree, footprint, rawRows } from "@/test/books-oracle";
import { businessToday } from "../as-of";
import type { Clock } from "../clock";
import { createCustomer, decide, getDetail, listSummaries } from "./customers";
import { recordEntry, reverseEntry, voidEntry } from "./ledger";

/**
 * The books, attacked as a whole. Random programs of real service calls (charges, payments, adjustments, write-offs allocated to
 * charges, reversals, voids, and deliberately bad requests) run against a real database; after EVERY step the figures are
 * recomputed from the raw rows by a second, deliberately naive implementation (it settles money one cent at a time) and compared with
 * every surface a person can see: the customer detail, the customer list, the dashboard, the CSV export and the customer portal.
 * A step that is refused must leave no trace at all.
 */
const ADMIN: SessionUser = { id: "u-model-admin", username: "model-admin", name: "Model Admin", role: "ADMIN" };
const TODAY = businessToday();
const clock: Clock = { today: () => TODAY, now: () => new Date() };

const profile = (name: string): CustomerCreateInput => ({
  businessName: name, contactName: null, phone: null, email: null, billingAddress: null, dateApplied: "2026-10-01",
  requestedLimitCents: null, accountingAppName: null, accountingProjectUrl: null, notes: null,
});

async function newCustomer(): Promise<string> {
  const id = await createCustomer(profile(`Model ${randomUUID().slice(0, 8)}`), ADMIN);
  await decide(id, { action: "approve", version: 1, creditLimitCents: 100_000, paymentTerms: "Net 30", creditStartDate: "2026-10-01" }, ADMIN);
  return id;
}

// ---- the programs ---------------------------------------------------------------------------------------------------------------

type Op =
  | { k: "charge"; amt: number; ago: number; due: number | null }
  | { k: "payment"; amt: number; ago: number }
  | { k: "adjust"; amt: number; ago: number }
  | { k: "writeoff"; amt: number; ago: number; chosen: boolean; pick: number }
  | { k: "reverse"; idx: number }
  | { k: "void"; idx: number }
  | { k: "bad"; which: number };

/** Mostly this month (so voids are allowed and every date interacts), sometimes a closed month, sometimes a day or two ahead. */
const agoArb = fc.oneof({ weight: 6, arbitrary: fc.integer({ min: 0, max: 15 }) }, { weight: 2, arbitrary: fc.integer({ min: 16, max: 70 }) }, { weight: 1, arbitrary: fc.integer({ min: -3, max: -1 }) });

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ k: fc.constant("charge" as const), amt: fc.integer({ min: 1, max: 60 }), ago: agoArb, due: fc.option(fc.integer({ min: 0, max: 45 }), { nil: null }) }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("payment" as const), amt: fc.integer({ min: 1, max: 60 }), ago: agoArb }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("adjust" as const), amt: fc.integer({ min: -40, max: 40 }).filter((n) => n !== 0), ago: fc.integer({ min: 0, max: 40 }) }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("writeoff" as const), amt: fc.integer({ min: 1, max: 40 }), ago: fc.integer({ min: 0, max: 6 }), chosen: fc.boolean(), pick: fc.nat(20) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("reverse" as const), idx: fc.nat(30) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("void" as const), idx: fc.nat(30) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("bad" as const), which: fc.nat(4) }) },
);

const input = (type: LedgerEntryInput["type"], amountCents: number, entryDate: string, extra: Partial<LedgerEntryInput> = {}): LedgerEntryInput => ({
  type, amountCents, entryDate, dueDate: null, reference: null, note: null, ...extra,
});

/** What happened to the steps, so a run that "passes" because everything was refused cannot go unnoticed. */
const tally = new Map<string, number>();
const count = (key: string) => tally.set(key, (tally.get(key) ?? 0) + 1);

async function run(ops: readonly Op[]): Promise<void> {
  const customerId = await newCustomer();
  const made: Array<{ id: string; type: string; day: string }> = [];
  const day = (ago: number) => addDays(TODAY, -ago);

  for (const [step, op] of ops.entries()) {
    const label = `step ${step + 1} ${JSON.stringify(op)}`;
    const before = await footprint(customerId);
    let created: { id: string; type: string; day: string } | null = null;
    try {
      if (op.k === "charge") {
        const entryDate = day(op.ago);
        const result = await recordEntry(customerId, input("CHARGE", op.amt, entryDate, { dueDate: op.due === null ? null : addDays(entryDate, op.due) }), ADMIN, clock);
        created = { id: result.id, type: "CHARGE", day: entryDate };
      } else if (op.k === "payment") {
        const result = await recordEntry(customerId, input("PAYMENT", op.amt, day(op.ago)), ADMIN, clock);
        created = { id: result.id, type: "PAYMENT", day: day(op.ago) };
      } else if (op.k === "adjust") {
        const result = await recordEntry(customerId, input("ADJUSTMENT", op.amt, day(op.ago), { note: "model adjustment" }), ADMIN, clock);
        created = { id: result.id, type: "ADJUSTMENT", day: day(op.ago) };
      } else if (op.k === "writeoff") {
        const entryDate = day(op.ago);
        let allocations: Allocation[] | undefined;
        if (op.chosen) {
          const { rows, allocs } = await rawRows(customerId);
          const records = (await getDetail(customerId, TODAY)).ledger.map((entry) => ({
            id: entry.id, type: entry.type, amountCents: entry.amountCents, entryDate: entry.entryDate, dueDate: entry.dueDate, voided: entry.voided,
            reverses: entry.reversesId, writeOffAllocations: entry.covers,
          }));
          void rows;
          void allocs;
          const targets = writeOffTargets(records, entryDate, TODAY);
          const target = targets[op.pick % Math.max(1, targets.length)];
          if (target) allocations = [{ chargeId: target.id, amountCents: Math.min(op.amt, target.openCents) }];
        }
        const amount = allocations ? allocations[0]!.amountCents : op.amt;
        const result = await recordEntry(customerId, input("WRITE_OFF", amount, entryDate, { note: "model write-off", ...(allocations ? { allocations } : {}) }), ADMIN, clock);
        created = { id: result.id, type: "WRITE_OFF", day: entryDate };
      } else if (op.k === "reverse" && made.length > 0) {
        const target = made[op.idx % made.length]!;
        const result = await reverseEntry(customerId, target.id, { reason: "model reversal" }, ADMIN, clock);
        // The same person reversing the same entry for the same reason again is treated as a retry: it answers "done" and adds nothing.
        if (!result.duplicate) created = { id: result.id, type: "REVERSAL", day: TODAY };
      } else if (op.k === "void" && made.length > 0) {
        await voidEntry(customerId, made[op.idx % made.length]!.id, "model void", ADMIN, clock);
        count("accepted void");
      } else if (op.k === "bad") {
        // Requests that must be refused, each for a reason, none of them allowed to leave anything behind.
        const bad = [
          () => recordEntry(customerId, input("PAYMENT", 5, addDays(TODAY, 91)), ADMIN, clock), // too far ahead
          () => recordEntry(customerId, input("WRITE_OFF", 5, addDays(TODAY, 1), { note: "future write-off" }), ADMIN, clock),
          () => recordEntry("no-such-customer", input("CHARGE", 5, TODAY), ADMIN, clock),
          () => reverseEntry(customerId, "no-such-entry", { reason: "model reversal" }, ADMIN, clock),
          () => voidEntry(customerId, "no-such-entry", "model void", ADMIN, clock),
        ];
        await bad[op.which % bad.length]!();
        throw new Error(`${label}: a request that must be refused was accepted`);
      }
    } catch (error) {
      if (!(error instanceof ApiError) || error.status < 400 || error.status >= 500) {
        throw new Error(`${label}: failed with something that is not a clean refusal: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      }
      count(`refused ${op.k} ${error.code}`);
      expect(await footprint(customerId), `${label}: a refused step (${error.code}) left something behind`).toBe(before);
    }
    if (created) {
      count(`accepted ${created.type}`);
      made.push(created);
      const after = JSON.parse(await footprint(customerId)) as { l: number; a: number };
      expect(after.l, `${label}: one ledger row`).toBe((JSON.parse(before) as { l: number }).l + 1);
      expect(after.a, `${label}: one audit event`).toBe((JSON.parse(before) as { a: number }).a + 1);
    }
    await assertBooksAgree(customerId, label, TODAY);
  }

  // The dashboard's outstanding total is what the aging buckets add up to.
  const mine = (await listSummaries(TODAY)).filter((summary) => summary.id === customerId);
  const dash = buildDashboard(mine, TODAY);
  expect(dash.stats.totalOutstandingCents, "dashboard outstanding equals the sum of the aging buckets").toBe(Object.values(dash.aging).reduce((sum, n) => sum + n, 0));
}

describe("the books, as a model", () => {
  test("random programs of real service calls: every surface equals the one-cent-at-a-time oracle after every step, and a refused step leaves nothing behind", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 4, maxLength: 24 }), async (ops) => {
        await run(ops);
      }),
      { numRuns: Number(process.env.BOOKS_MODEL_RUNS ?? 40), ...(process.env.BOOKS_MODEL_SEED ? { seed: Number(process.env.BOOKS_MODEL_SEED) } : {}), interruptAfterTimeLimit: 280_000, markInterruptAsFailure: false },
    );
    const summary = JSON.stringify(Object.fromEntries([...tally.entries()].sort()), null, 1);
    if (process.env.BOOKS_MODEL_TALLY_FILE) writeFileSync(process.env.BOOKS_MODEL_TALLY_FILE, summary);
    // Not vacuous: every kind of entry was really accepted, and write-offs were really allocated.
    for (const type of ["CHARGE", "PAYMENT", "ADJUSTMENT", "WRITE_OFF", "REVERSAL"]) expect(tally.get(`accepted ${type}`) ?? 0, `no ${type} was ever accepted`).toBeGreaterThan(0);
  }, 300_000);
});
