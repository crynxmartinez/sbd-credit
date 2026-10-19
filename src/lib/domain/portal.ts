import { compareText } from "./dates";
import type { CustomerStatus, LedgerType } from "./constants";
import type { CustomerSummary } from "../types";
import { effectOnBalance } from "./ledger";

/**
 * What a customer is allowed to see of their own account. This is a WHITELIST: the view is built field by field, so a
 * new internal field added to the customer or the ledger can never reach a customer by accident. Internal notes, the
 * audit trail, staff names, the accounting link, voided entries and entries dated in the future are deliberately absent.
 */

/** The most entries one page shows, so a very long ledger cannot make a very large page. */
export const PORTAL_ENTRY_LIMIT = 200;

/** Where the account stands, in a customer's words rather than our review workflow's. */
export type PortalStanding = "active" | "on_hold" | "in_review";

export function portalStanding(status: CustomerStatus): PortalStanding {
  if (status === "approved") return "active";
  if (status === "suspended") return "on_hold";
  return "in_review";
}

/** How an entry reads to a customer. A write-off is shown as a credit, and a reversal or adjustment as a correction. */
export type PortalEntryKind = "purchase" | "payment" | "credit" | "correction";

const KIND_OF: Readonly<Record<LedgerType, PortalEntryKind>> = {
  CHARGE: "purchase",
  PAYMENT: "payment",
  WRITE_OFF: "credit",
  ADJUSTMENT: "correction",
  REVERSAL: "correction",
};

/** The only ledger fields the portal reads. Notes and staff names are not among them. */
export interface PortalSourceEntry {
  id: string;
  type: LedgerType;
  amountCents: number;
  entryDate: string;
  dueDate: string | null;
  reference: string | null;
  voided: boolean;
}

export interface PortalEntry {
  date: string;
  kind: PortalEntryKind;
  /** Positive adds to what the customer owes, negative reduces it. */
  amountCents: number;
  reference: string | null;
  dueDate: string | null;
}

export interface PortalView {
  businessName: string;
  standing: PortalStanding;
  /** The business day every figure is computed for. */
  asOf: string;
  creditLimitCents: number;
  /** What they can still buy on credit. Zero unless the account is active. */
  availableCents: number;
  utilizationPct: number;
  balanceCents: number;
  /** Payment received beyond what was owed. */
  creditCents: number;
  paymentTerms: string;
  overdueCents: number;
  oldestOverdueDays: number;
  nextDueDate: string | null;
  nextDueCents: number;
  entries: PortalEntry[];
}

/** Only purchases and payments carry a reference a customer would recognise (an invoice or check number). */
const SHOWS_REFERENCE: ReadonlySet<LedgerType> = new Set<LedgerType>(["CHARGE", "PAYMENT"]);

function toEntry(entry: PortalSourceEntry): PortalEntry {
  return {
    date: entry.entryDate,
    kind: KIND_OF[entry.type],
    amountCents: effectOnBalance(entry.type, entry.amountCents),
    reference: SHOWS_REFERENCE.has(entry.type) ? entry.reference : null,
    dueDate: entry.type === "CHARGE" ? entry.dueDate : null,
  };
}

/** Newest first; ties broken by the entry's id (not sent to the customer) so the order never reshuffles between loads. */
function newestFirst(a: PortalSourceEntry, b: PortalSourceEntry): number {
  return compareText(b.entryDate, a.entryDate) || compareText(b.id, a.id);
}

export function toPortalView(customer: CustomerSummary, ledger: readonly PortalSourceEntry[], asOf: string): PortalView {
  const standing = portalStanding(customer.status);
  const hasCredit = standing !== "in_review";

  return {
    businessName: customer.businessName,
    standing,
    asOf,
    creditLimitCents: hasCredit ? customer.creditLimitCents : 0,
    availableCents: standing === "active" ? customer.availableCents : 0,
    utilizationPct: hasCredit ? customer.utilizationPct : 0,
    balanceCents: customer.balanceCents,
    creditCents: customer.creditCents,
    paymentTerms: customer.paymentTerms,
    overdueCents: customer.overdueCents,
    oldestOverdueDays: customer.oldestOverdueDays,
    nextDueDate: customer.nextDueDate,
    nextDueCents: customer.nextDueCents,
    entries: ledger
      .filter((entry) => !entry.voided && entry.entryDate <= asOf)
      .sort(newestFirst)
      .slice(0, PORTAL_ENTRY_LIMIT)
      .map(toEntry),
  };
}
