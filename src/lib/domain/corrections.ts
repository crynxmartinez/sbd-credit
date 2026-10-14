import { isInClosedMonth } from "./dates";
import { can, type Role } from "./roles";
import type { LedgerType } from "./constants";

export type Correction = "void" | "reverse";

/**
 * How a ledger entry can be corrected by this role, or null if it cannot be. This month's entries can be voided (a typo);
 * an entry from a closed month is reversed instead, so the past never changes. An entry that is already voided or
 * reversed, and a reversal itself, cannot be corrected again. The service enforces the same rule; the screen offers only
 * what this returns.
 */
export function correctionFor(
  entry: { type: LedgerType; voided: boolean; reversed: boolean; entryDate: string },
  today: string,
  role: Role,
): Correction | null {
  if (entry.voided || entry.reversed || entry.type === "REVERSAL") return null;
  if (isInClosedMonth(entry.entryDate, today)) return can(role, "ledger.reverse") ? "reverse" : null;
  return can(role, "ledger.void") ? "void" : null;
}
