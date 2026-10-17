import { centsToDecimal } from "./csv";
import type { LedgerType } from "./constants";
import { effectOnBalance } from "./ledger";

/** What a ledger row needs to be exported so the file reconciles to the books. */
export interface LedgerCsvSource {
  customerId: string;
  businessName: string;
  type: LedgerType;
  amountCents: number;
  entryDate: string;
  dueDate: string | null;
  reference: string | null;
  note: string | null;
  createdBy: string;
  voided: boolean;
  voidReason: string | null;
  /** True when another entry reverses this one. */
  reversed: boolean;
  /** For a reversal, true: it offsets an earlier entry. */
  isReversal: boolean;
  /** For a write-off, the charges it covers ("INV-1 ($60.00); INV-2 ($40.00)"). Empty for anything else. */
  writtenOffAgainst: string;
}

export const LEDGER_CSV_HEADER = [
  "Customer ID", "Business", "Type", "Amount", "Effect on balance", "Counts today", "Entry date", "Due date", "Reference",
  "Note", "Recorded by", "Voided", "Void reason", "Reversed", "Written off against",
] as const;

/**
 * "Amount" is as entered (always positive for a charge, payment or write-off). "Effect on balance" is the SIGNED figure, so
 * summing that column for one customer gives their balance. "Counts today" says whether the row is in today's balance:
 * voided and not-yet-dated rows are not, which is why a column total over every row would not match.
 */
export function ledgerCsvRow(entry: LedgerCsvSource, asOf: string): Array<string | number> {
  const counts = !entry.voided && entry.entryDate <= asOf;
  return [
    entry.customerId, entry.businessName, entry.type, centsToDecimal(entry.amountCents),
    centsToDecimal(effectOnBalance(entry.type, entry.amountCents)), counts ? "yes" : "no", entry.entryDate, entry.dueDate ?? "",
    entry.reference ?? "", entry.note ?? "", entry.createdBy, entry.voided ? "yes" : "no", entry.voidReason ?? "",
    entry.reversed ? "yes" : "no", entry.writtenOffAgainst,
  ];
}
