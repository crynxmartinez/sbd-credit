import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { correctionFor } from "./corrections";
import { addDays } from "./dates";
import { computeAging, reversalFor, writtenOffCents, type LedgerRecord } from "./ledger";
import { planWriteOffAllocation, writeOffCover, writeOffTargets, type Allocation } from "./write-off";

/**
 * Property tests for write-off allocations: random ledgers, built the way the service builds them (a write-off is planned by
 * the same domain functions the service uses), and rules that must hold for ALL of them.
 */
const TODAY = "2026-10-13";
const BASE = "2026-06-01";

type Step =
  | { kind: "charge"; cents: number; day: number; due: number }
  | { kind: "payment"; cents: number; day: number }
  | { kind: "writeoff"; fraction: number; day: number; choose: boolean; pick: number }
  | { kind: "reverseWriteOff"; pick: number }
  | { kind: "voidWriteOff"; pick: number };

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("charge" as const), cents: fc.integer({ min: 100, max: 500_00 }), day: fc.integer({ min: 0, max: 100 }), due: fc.integer({ min: 0, max: 40 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("payment" as const), cents: fc.integer({ min: 100, max: 400_00 }), day: fc.integer({ min: 0, max: 130 }) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("writeoff" as const), fraction: fc.double({ min: 0.05, max: 1, noNaN: true }), day: fc.integer({ min: 0, max: 130 }), choose: fc.boolean(), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("reverseWriteOff" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("voidWriteOff" as const), pick: fc.nat() }) },
);

/** Applies the steps the way the service would: a write-off only records if the plan accepts it. */
function build(steps: readonly Step[]): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  let counter = 0;
  const id = () => `r${(counter += 1)}`;
  for (const s of steps) {
    if (s.kind === "charge") {
      const entryDate = addDays(BASE, s.day);
      records.push({ id: id(), type: "CHARGE", amountCents: s.cents, entryDate, dueDate: addDays(entryDate, s.due), voided: false });
    } else if (s.kind === "payment") {
      records.push({ id: id(), type: "PAYMENT", amountCents: s.cents, entryDate: addDays(BASE, s.day), dueDate: null, voided: false });
    } else if (s.kind === "writeoff") {
      const entryDate = addDays(BASE, Math.min(s.day, 129)) > TODAY ? TODAY : addDays(BASE, Math.min(s.day, 129));
      const targets = writeOffTargets(records, entryDate, TODAY);
      const room = targets.reduce((sum, target) => sum + target.openCents, 0);
      if (room <= 0) continue;
      const amount = Math.max(1, Math.floor(room * s.fraction));
      let chosen: Allocation[] | undefined;
      if (s.choose) {
        const target = targets[s.pick % targets.length]!;
        const take = Math.min(target.openCents, amount);
        chosen = [{ chargeId: target.id, amountCents: take }];
        const plan = planWriteOffAllocation(take, targets, chosen);
        if (!plan.ok) continue;
        records.push({ id: id(), type: "WRITE_OFF", amountCents: take, entryDate, dueDate: null, voided: false, writeOffAllocations: plan.allocations });
        continue;
      }
      const plan = planWriteOffAllocation(amount, targets);
      if (!plan.ok) continue;
      records.push({ id: id(), type: "WRITE_OFF", amountCents: amount, entryDate, dueDate: null, voided: false, writeOffAllocations: plan.allocations });
    } else {
      const writeOffs = records.filter((r) => r.type === "WRITE_OFF" && !r.voided);
      const alreadyReversed = new Set(records.filter((r) => r.type === "REVERSAL").map((r) => r.reverses));
      const open = writeOffs.filter((r) => !alreadyReversed.has(r.id));
      if (open.length === 0) continue;
      const target = open[s.pick % open.length]!;
      if (s.kind === "voidWriteOff") {
        target.voided = true;
      } else {
        const offset = reversalFor(target, TODAY)!;
        records.push({ id: id(), type: "REVERSAL", amountCents: offset.amountCents, entryDate: offset.entryDate, dueDate: null, voided: false, reverses: target.id });
      }
    }
  }
  return records;
}

const ledgers = fc.array(step, { minLength: 1, maxLength: 16 }).map(build);
const stripAllocations = (records: readonly LedgerRecord[]) => records.map((r) => ({ ...r, writeOffAllocations: undefined }));

describe("allocations never break the arithmetic", () => {
  test("what is open adds up to the balance when money is owed (the rest is credit), and nothing is ever negative", () => {
    fc.assert(
      fc.property(ledgers, (records) => {
        const aging = computeAging(records, TODAY);
        const open = aging.openItems.reduce((sum, item) => sum + item.remainingCents, 0);
        expect(open).toBe(Math.max(0, aging.balanceCents));
        expect(aging.creditCents).toBe(Math.max(0, -aging.balanceCents));
        for (const item of aging.openItems) expect(item.remainingCents).toBeGreaterThan(0);
      }),
    );
  });

  test("the balance and the written-off total do not depend on how a write-off was allocated", () => {
    fc.assert(
      fc.property(ledgers, (records) => {
        const plain = stripAllocations(records);
        expect(computeAging(records, TODAY).balanceCents).toBe(computeAging(plain, TODAY).balanceCents);
        expect(writtenOffCents(records, TODAY)).toBe(writtenOffCents(plain, TODAY));
      }),
    );
  });

  test("the written-off total equals what the live allocations add up to", () => {
    fc.assert(
      fc.property(ledgers, (records) => {
        const live = records.filter((r) => r.type === "WRITE_OFF" && !r.voided && !records.some((x) => x.type === "REVERSAL" && x.reverses === r.id));
        const allocated = live.reduce((sum, r) => sum + (r.writeOffAllocations ?? []).reduce((inner, a) => inner + a.amountCents, 0), 0);
        expect(allocated).toBe(writtenOffCents(records, TODAY));
      }),
    );
  });

  test("the order the entries are listed in changes nothing", () => {
    fc.assert(
      fc.property(ledgers, fc.nat(), (records, seed) => {
        const shuffled = [...records].sort((a, b) => ((a.id.length * 31 + seed) % 7) - ((b.id.length * 31 + seed) % 7) || b.id.localeCompare(a.id));
        expect(computeAging(shuffled, TODAY)).toEqual(computeAging(records, TODAY));
      }),
    );
  });
});

describe("planning a write-off", () => {
  const targets = fc.array(
    fc.record({ openCents: fc.integer({ min: 1, max: 900_00 }), due: fc.integer({ min: 0, max: 60 }), entry: fc.integer({ min: 0, max: 60 }) }),
    { minLength: 1, maxLength: 8 },
  ).map((rows) => rows.map((row, index) => ({ id: `t${index}`, openCents: row.openCents, dueDate: addDays(BASE, row.due), entryDate: addDays(BASE, row.entry) })));

  test("the allocations add up to the amount exactly, each is positive and within what is open, and no charge appears twice", () => {
    fc.assert(
      fc.property(targets, fc.double({ min: 0.001, max: 1, noNaN: true }), (list, fraction) => {
        const total = list.reduce((sum, t) => sum + t.openCents, 0);
        const amount = Math.max(1, Math.floor(total * fraction));
        const plan = planWriteOffAllocation(amount, list);
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(plan.allocations.reduce((sum, a) => sum + a.amountCents, 0)).toBe(amount);
        const openById = new Map(list.map((t) => [t.id, t.openCents]));
        for (const a of plan.allocations) {
          expect(a.amountCents).toBeGreaterThan(0);
          expect(a.amountCents).toBeLessThanOrEqual(openById.get(a.chargeId)!);
        }
        expect(new Set(plan.allocations.map((a) => a.chargeId)).size).toBe(plan.allocations.length);
      }),
    );
  });

  test("an older charge is never left partly open while a newer one is touched", () => {
    fc.assert(
      fc.property(targets, fc.double({ min: 0.001, max: 1, noNaN: true }), (list, fraction) => {
        const total = list.reduce((sum, t) => sum + t.openCents, 0);
        const plan = planWriteOffAllocation(Math.max(1, Math.floor(total * fraction)), list);
        if (!plan.ok) return;
        const order = [...list].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.entryDate.localeCompare(b.entryDate) || a.id.localeCompare(b.id));
        const taken = new Map(plan.allocations.map((a) => [a.chargeId, a.amountCents]));
        let sawPartial = false;
        for (const target of order) {
          const got = taken.get(target.id) ?? 0;
          if (sawPartial) expect(got).toBe(0); // once one charge was not fully covered, nothing newer is touched
          if (got < target.openCents) sawPartial = true;
        }
      }),
    );
  });

  test("more than is open is always refused, never silently trimmed", () => {
    fc.assert(
      fc.property(targets, fc.integer({ min: 1, max: 1000 }), (list, extra) => {
        const total = list.reduce((sum, t) => sum + t.openCents, 0);
        expect(planWriteOffAllocation(total + extra, list)).toEqual({ ok: false, code: "exceeds_balance", maxCents: total });
      }),
    );
  });
});

describe("correcting charges after write-offs (the service and the screen share this rule)", () => {
  const entryOf = (record: LedgerRecord, records: readonly LedgerRecord[]) => {
    const cover = writeOffCover(records, record.id);
    return { type: record.type, voided: record.voided, reversed: records.some((r) => r.type === "REVERSAL" && r.reverses === record.id), entryDate: record.entryDate, writtenOffCents: cover.liveCents, everWrittenOff: cover.ever };
  };

  test("a charge a write-off still covers is offered no correction; a charge no write-off ever touched is always offered one", () => {
    fc.assert(
      fc.property(ledgers, (records) => {
        for (const record of records.filter((r) => r.type === "CHARGE" && !r.voided)) {
          const cover = writeOffCover(records, record.id);
          const how = correctionFor(entryOf(record, records), TODAY, "ADMIN");
          const reversed = records.some((r) => r.type === "REVERSAL" && r.reverses === record.id);
          if (cover.liveCents > 0) expect(how).toBeNull();
          else if (!cover.ever && !reversed) expect(how).not.toBeNull();
        }
      }),
    );
  });

  test("a charge a write-off covered earlier (reversed since) is never offered a void", () => {
    fc.assert(
      fc.property(ledgers, (records) => {
        for (const record of records.filter((r) => r.type === "CHARGE" && !r.voided)) {
          const cover = writeOffCover(records, record.id);
          if (cover.ever && cover.liveCents === 0) expect(correctionFor(entryOf(record, records), TODAY, "ADMIN")).not.toBe("void");
        }
      }),
    );
  });
});
