import type { AgingBucket, LedgerType } from "./constants";
import { diffDays } from "./dates";
import { sumCents } from "./money";

/**
 * The ledger is the single source of truth for what a customer owes. The balance is never stored; it is always
 * recomputed from entries, so two people recording payments at the same moment cannot overwrite each other.
 *
 * Sign convention: CHARGE adds to the balance, PAYMENT subtracts, ADJUSTMENT is already signed.
 */
export interface LedgerRecord {
  id: string;
  type: LedgerType;
  /** Positive for CHARGE and PAYMENT. Signed for ADJUSTMENT. */
  amountCents: number;
  entryDate: string;
  /** When a charge falls due. Null falls back to the entry date. */
  dueDate: string | null;
  voided: boolean;
}

export interface OpenItem {
  id: string;
  dueDate: string;
  remainingCents: number;
}

export interface Aging {
  /** Total owed. Negative when the customer has overpaid. */
  balanceCents: number;
  /** Payment left over after every open charge was covered. */
  creditCents: number;
  openItems: OpenItem[];
  buckets: Record<AgingBucket, number>;
  overdueCents: number;
  nextDueDate: string | null;
  nextDueCents: number;
  oldestOverdueDays: number;
}

const BUCKET_LIMITS: ReadonlyArray<readonly [number, AgingBucket]> = [
  [30, "d1_30"],
  [60, "d31_60"],
  [90, "d61_90"],
];

function activeEntries(entries: readonly LedgerRecord[]): LedgerRecord[] {
  return entries.filter((entry) => !entry.voided);
}

function signedAmount(entry: LedgerRecord): number {
  return entry.type === "PAYMENT" ? -entry.amountCents : entry.amountCents;
}

export function balanceCents(entries: readonly LedgerRecord[]): number {
  return sumCents(activeEntries(entries).map(signedAmount));
}

function bucketFor(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return "current";
  const match = BUCKET_LIMITS.find(([limit]) => daysPastDue <= limit);
  return match ? match[1] : "d90_plus";
}

function emptyBuckets(): Record<AgingBucket, number> {
  return { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
}

interface Debit {
  id: string;
  dueDate: string;
  entryDate: string;
  remainingCents: number;
}

/** Charges and positive adjustments, oldest due date first. */
function debitsOf(entries: readonly LedgerRecord[]): Debit[] {
  return entries
    .filter((entry) => entry.type !== "PAYMENT" && entry.amountCents > 0)
    .map((entry) => ({
      id: entry.id,
      dueDate: entry.dueDate ?? entry.entryDate,
      entryDate: entry.entryDate,
      remainingCents: entry.amountCents,
    }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.entryDate.localeCompare(b.entryDate) || a.id.localeCompare(b.id));
}

function creditsTotal(entries: readonly LedgerRecord[]): number {
  return sumCents(
    entries
      .filter((entry) => entry.type === "PAYMENT" || (entry.type === "ADJUSTMENT" && entry.amountCents < 0))
      .map((entry) => Math.abs(entry.amountCents)),
  );
}

/** Applies credits to debits oldest-first. Returns the debits that are still open and the credit left over. */
function settle(debits: readonly Debit[], credits: number): { open: Debit[]; creditLeft: number } {
  let creditLeft = credits;
  const open: Debit[] = [];
  for (const debit of debits) {
    const applied = Math.min(debit.remainingCents, creditLeft);
    creditLeft -= applied;
    const remaining = debit.remainingCents - applied;
    if (remaining > 0) open.push({ ...debit, remainingCents: remaining });
  }
  return { open, creditLeft };
}

/**
 * Everything is computed as of one day: entries dated after it have not happened yet, so they neither add to the
 * balance nor pay anything off. That keeps a month-end figure stable however many later entries exist.
 */
export function computeAging(entries: readonly LedgerRecord[], asOf: string): Aging {
  const active = activeEntries(entries).filter((entry) => entry.entryDate <= asOf);
  const { open, creditLeft } = settle(debitsOf(active), creditsTotal(active));

  const buckets = emptyBuckets();
  let oldestOverdueDays = 0;
  for (const item of open) {
    const daysPastDue = diffDays(item.dueDate, asOf);
    buckets[bucketFor(daysPastDue)] += item.remainingCents;
    oldestOverdueDays = Math.max(oldestOverdueDays, daysPastDue);
  }

  const nextDueDate = open[0]?.dueDate ?? null;
  const nextDueCents = sumCents(open.filter((item) => item.dueDate === nextDueDate).map((item) => item.remainingCents));
  const overdueCents = buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.d90_plus;

  return {
    balanceCents: balanceCents(active),
    creditCents: creditLeft,
    openItems: open.map(({ id, dueDate, remainingCents }) => ({ id, dueDate, remainingCents })),
    buckets,
    overdueCents,
    nextDueDate,
    nextDueCents,
    oldestOverdueDays: Math.max(0, oldestOverdueDays),
  };
}
