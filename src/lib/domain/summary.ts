import type { CustomerBase, CustomerSummary } from "../types";
import { utilizationLevel, utilizationPct } from "./alerts";
import { computeAging, type LedgerRecord } from "./ledger";

/** A customer plus everything derived from their ledger as of one day. Pure: no database, no clock. */
export function toSummary(customer: CustomerBase, entries: readonly LedgerRecord[], asOf: string): CustomerSummary {
  const aging = computeAging(entries, asOf);
  const pct = utilizationPct(aging.balanceCents, customer.creditLimitCents);

  return {
    ...customer,
    balanceCents: aging.balanceCents,
    creditCents: aging.creditCents,
    availableCents: Math.max(0, customer.creditLimitCents - aging.balanceCents),
    utilizationPct: pct,
    utilizationLevel: utilizationLevel(pct),
    overdueCents: aging.overdueCents,
    oldestOverdueDays: aging.oldestOverdueDays,
    nextDueDate: aging.nextDueDate,
    nextDueCents: aging.nextDueCents,
    buckets: aging.buckets,
  };
}
