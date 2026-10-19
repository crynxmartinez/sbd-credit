import type { LedgerType } from "./constants";
import { compareText } from "./dates";
import { computeAging, type LedgerRecord, type OpenItem } from "./ledger";

/**
 * A write-off gives up on money that is owed, and says WHICH charges it gives up on. Each write-off is split into
 * allocations to specific charges (the amounts add up to the write-off exactly). That is what lets the books answer
 * "what covers this charge?" without guessing from dates, and what lets a charge be corrected whenever nothing covers it.
 *
 * Pure: no database, no clock. The server uses it to decide and to check; the screen uses it to offer the same choices.
 */

export interface AllocationTarget {
  id: string;
  /** What is still open on the charge (after earlier write-offs and payments). */
  openCents: number;
  dueDate: string;
  entryDate: string;
}

export interface Allocation {
  chargeId: string;
  amountCents: number;
}

export type AllocationPlan =
  | { ok: true; allocations: Allocation[] }
  | { ok: false; code: "nothing_owed" | "exceeds_balance" | "invalid_allocation"; maxCents: number };

/** The entries a write-off may be allocated to: what the ledger says each id is. */
export interface TargetEntry {
  id: string;
  type: LedgerType;
  amountCents: number;
  entryDate: string;
}

/**
 * The open items a write-off dated `writeOffDate` may be allocated to: charges and upward adjustments that already existed
 * on that day. Not a reduction, not a reversal, and not something dated after the write-off (it could not have covered it).
 */
export function allocatableTargets(openItems: readonly OpenItem[], entries: readonly TargetEntry[], writeOffDate: string): AllocationTarget[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const targets: AllocationTarget[] = [];
  for (const item of openItems) {
    const source = byId.get(item.id);
    if (!source || item.remainingCents <= 0) continue;
    const isTarget = source.type === "CHARGE" || (source.type === "ADJUSTMENT" && source.amountCents > 0);
    if (!isTarget || source.entryDate > writeOffDate) continue;
    targets.push({ id: item.id, openCents: item.remainingCents, dueDate: item.dueDate, entryDate: source.entryDate });
  }
  return targets;
}

/**
 * How much of each charge a write-off dated `writeOffDate` may take, judged on EVERY day the write-off would be in force
 * (from its own date through `today`), not only today. Otherwise a write-off backdated to before a payment, or to a time
 * another write-off was in force (and has since been reversed), would settle the same charge twice for the days in between.
 * The screen and the server both use this, so what is offered is exactly what is accepted.
 */
export function writeOffTargets(records: readonly LedgerRecord[], writeOffDate: string, today: string): AllocationTarget[] {
  const days = new Set([writeOffDate, today]);
  for (const record of records) {
    if (!record.voided && record.entryDate > writeOffDate && record.entryDate < today) days.add(record.entryDate);
  }
  const openToday = computeAging(records, today).openItems;
  // A charge missing from a day's open items is settled that day: it has no room on that day, and so none overall.
  const room = new Map(openToday.map((item) => [item.id, item.remainingCents]));
  for (const day of [...days].sort()) {
    const open = new Map(computeAging(records, day).openItems.map((item) => [item.id, item.remainingCents]));
    for (const [id, left] of room) room.set(id, Math.min(left, open.get(id) ?? 0));
  }
  const entries: TargetEntry[] = records.map((record) => ({ id: record.id, type: record.type, amountCents: record.amountCents, entryDate: record.entryDate }));
  return allocatableTargets(
    openToday.map((item) => ({ ...item, remainingCents: Math.min(item.remainingCents, room.get(item.id) ?? 0) })),
    entries,
    writeOffDate,
  );
}

/** Whether two splits are the same charges for the same amounts, in any order. */
export function sameAllocations(a: readonly Allocation[], b: readonly Allocation[]): boolean {
  if (a.length !== b.length) return false;
  const byCharge = new Map(a.map((item) => [item.chargeId, item.amountCents]));
  return byCharge.size === a.length && b.every((item) => byCharge.get(item.chargeId) === item.amountCents);
}

const oldestFirst = (a: AllocationTarget, b: AllocationTarget): number =>
  compareText(a.dueDate, b.dueDate) || compareText(a.entryDate, b.entryDate) || compareText(a.id, b.id);

/**
 * Splits a write-off across charges. By default the oldest-due charges are covered first (the same order payments settle
 * in). An explicit `chosen` split is used instead when given, and must name only open charges, never more than is open on
 * each, and add up to exactly the amount.
 */
export function planWriteOffAllocation(amountCents: number, targets: readonly AllocationTarget[], chosen?: readonly Allocation[]): AllocationPlan {
  const open = targets.filter((target) => target.openCents > 0);
  const totalOpen = open.reduce((sum, target) => sum + target.openCents, 0);
  if (totalOpen <= 0) return { ok: false, code: "nothing_owed", maxCents: 0 };

  if (chosen !== undefined) {
    const openById = new Map(open.map((target) => [target.id, target.openCents]));
    const seen = new Set<string>();
    let sum = 0;
    for (const item of chosen) {
      const room = openById.get(item.chargeId);
      if (room === undefined || seen.has(item.chargeId) || !Number.isInteger(item.amountCents) || item.amountCents <= 0 || item.amountCents > room) {
        return { ok: false, code: "invalid_allocation", maxCents: totalOpen };
      }
      seen.add(item.chargeId);
      sum += item.amountCents;
    }
    if (chosen.length === 0 || sum !== amountCents) return { ok: false, code: "invalid_allocation", maxCents: totalOpen };
    return { ok: true, allocations: chosen.map((item) => ({ chargeId: item.chargeId, amountCents: item.amountCents })) };
  }

  if (amountCents > totalOpen) return { ok: false, code: "exceeds_balance", maxCents: totalOpen };
  const allocations: Allocation[] = [];
  let left = amountCents;
  for (const target of [...open].sort(oldestFirst)) {
    if (left === 0) break;
    const take = Math.min(target.openCents, left);
    allocations.push({ chargeId: target.id, amountCents: take });
    left -= take;
  }
  return { ok: true, allocations };
}

/** Write-offs still in force: not voided, and not cancelled by a reversal that itself is still in force. */
function liveWriteOffs(entries: readonly LedgerRecord[]): LedgerRecord[] {
  const reversed = new Set(entries.filter((entry) => entry.type === "REVERSAL" && !entry.voided && entry.reverses).map((entry) => entry.reverses));
  return entries.filter((entry) => entry.type === "WRITE_OFF" && !entry.voided && !reversed.has(entry.id));
}

/** The write-offs in force that cover this charge, and how much each one covers. */
export function allocationsTo(entries: readonly LedgerRecord[], chargeId: string): Array<{ writeOffId: string; amountCents: number }> {
  return liveWriteOffs(entries).flatMap((writeOff) =>
    (writeOff.writeOffAllocations ?? []).filter((allocation) => allocation.chargeId === chargeId).map((allocation) => ({ writeOffId: writeOff.id, amountCents: allocation.amountCents })),
  );
}

/** How much of this charge is currently written off. */
export function liveAllocationCents(entries: readonly LedgerRecord[], chargeId: string): number {
  return allocationsTo(entries, chargeId).reduce((sum, item) => sum + item.amountCents, 0);
}

/**
 * What write-offs have done to a charge: how much is written off now, and whether a write-off that is still on the books
 * (live, or reversed since) ever covered it. A voided write-off never counted, so it leaves no trace here.
 */
export function writeOffCover(entries: readonly LedgerRecord[], chargeId: string): { liveCents: number; ever: boolean } {
  const reversed = new Set(entries.filter((entry) => entry.type === "REVERSAL" && !entry.voided && entry.reverses).map((entry) => entry.reverses));
  let liveCents = 0;
  let ever = false;
  for (const writeOff of entries) {
    if (writeOff.type !== "WRITE_OFF" || writeOff.voided) continue;
    for (const allocation of writeOff.writeOffAllocations ?? []) {
      if (allocation.chargeId !== chargeId) continue;
      ever = true;
      if (!reversed.has(writeOff.id)) liveCents += allocation.amountCents;
    }
  }
  return { liveCents, ever };
}

/**
 * `writeOffCover` for every entry at once: one pass over the ledger instead of one pass PER entry (which made opening a customer
 * with thousands of entries quadratic). An entry nothing covers is simply absent.
 */
export function writeOffCoverMap(entries: readonly LedgerRecord[]): Map<string, { liveCents: number; ever: boolean }> {
  const reversed = new Set(entries.filter((entry) => entry.type === "REVERSAL" && !entry.voided && entry.reverses).map((entry) => entry.reverses));
  const cover = new Map<string, { liveCents: number; ever: boolean }>();
  for (const writeOff of entries) {
    if (writeOff.type !== "WRITE_OFF" || writeOff.voided) continue;
    const live = !reversed.has(writeOff.id);
    for (const allocation of writeOff.writeOffAllocations ?? []) {
      const current = cover.get(allocation.chargeId) ?? { liveCents: 0, ever: false };
      cover.set(allocation.chargeId, { liveCents: current.liveCents + (live ? allocation.amountCents : 0), ever: true });
    }
  }
  return cover;
}
