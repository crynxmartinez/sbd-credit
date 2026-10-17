import { formatDate } from "@/lib/domain/dates";
import type { LedgerRecord } from "@/lib/domain/ledger";
import { formatCents } from "@/lib/domain/money";
import type { LedgerEntryDto } from "@/lib/types";

/**
 * The ledger as the pure rules in domain/ read it, built from what the screen already holds. The write-off form uses it to
 * offer exactly the charges the server will accept (domain/write-off.ts), with no second copy of the rule.
 */
export function recordsFromDto(ledger: readonly LedgerEntryDto[]): LedgerRecord[] {
  return ledger
    .filter((entry) => !entry.voided)
    .map((entry) => ({
      id: entry.id,
      type: entry.type,
      amountCents: entry.amountCents,
      entryDate: entry.entryDate,
      dueDate: entry.dueDate,
      voided: false,
      reverses: entry.reversesId,
      writeOffAllocations: entry.covers,
    }));
}

/** How a charge is named to a person: its invoice number, or what it was and when. */
export function chargeLabel(entry: Pick<LedgerEntryDto, "reference" | "amountCents" | "entryDate"> | undefined): string {
  if (!entry) return "a charge";
  return entry.reference ?? `charge of ${formatCents(entry.amountCents, { fixed: true })} dated ${formatDate(entry.entryDate)}`;
}
