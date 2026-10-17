import { isInClosedMonth } from "./dates";
import { can, type Role } from "./roles";
import type { LedgerType } from "./constants";

export type Correction = "void" | "reverse";

/**
 * How a ledger entry can be corrected by this role, or null if it cannot be. This month's entries can be voided (a typo);
 * an entry from a closed month is reversed instead, so the past never changes. An entry that is already voided or
 * reversed, and a reversal itself, cannot be corrected again. A charge that a write-off covers (`writtenOffCents` above
 * zero) cannot be corrected either until that write-off is reversed. A charge that a write-off covered EARLIER (reversed
 * since: `everWrittenOff`) can no longer be voided, because a void erases it from every day, including the days the
 * write-off was in force; it is reversed instead. The service enforces the same rules; the screen offers only what this
 * returns.
 */
export function correctionFor(
  entry: { type: LedgerType; voided: boolean; reversed: boolean; entryDate: string; writtenOffCents?: number; everWrittenOff?: boolean },
  today: string,
  role: Role,
): Correction | null {
  if (entry.voided || entry.reversed || entry.type === "REVERSAL") return null;
  if ((entry.writtenOffCents ?? 0) > 0) return null;
  if (isInClosedMonth(entry.entryDate, today) || entry.everWrittenOff === true) return can(role, "ledger.reverse") ? "reverse" : null;
  return can(role, "ledger.void") ? "void" : null;
}
