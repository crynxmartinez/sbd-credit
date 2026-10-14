/**
 * A request key makes a retry safe: the second send of the same form finds the first result instead of adding it again.
 * But a key reused with DIFFERENT details is not a retry, it is someone who edited the form after a lost reply. Answering
 * with the old entry would tell them "recorded" about an amount they never saved, so the details are compared.
 */
export interface SubmittedLedgerEntry {
  type: string;
  amountCents: number;
  entryDate: string;
  dueDate: string | null;
  reference: string | null;
  note: string | null;
}

export function sameLedgerSubmission(
  existing: SubmittedLedgerEntry,
  input: Omit<SubmittedLedgerEntry, "dueDate"> & { dueDate?: string | null },
): boolean {
  return (
    existing.type === input.type &&
    existing.amountCents === input.amountCents &&
    existing.entryDate === input.entryDate &&
    (existing.reference ?? null) === (input.reference ?? null) &&
    (existing.note ?? null) === (input.note ?? null) &&
    // A blank due date means "work it out from the terms", so only a due date the person actually gave can differ.
    (!input.dueDate || input.dueDate === existing.dueDate)
  );
}

const CUSTOMER_FIELDS = [
  "businessName", "contactName", "phone", "email", "billingAddress", "dateApplied",
  "requestedLimitCents", "accountingAppName", "accountingProjectUrl", "notes",
] as const;

/** Whether a customer-creation request repeats what an earlier request with the same key already saved. */
export function sameCustomerSubmission(
  existing: Partial<Record<(typeof CUSTOMER_FIELDS)[number], string | number | null>>,
  input: Partial<Record<(typeof CUSTOMER_FIELDS)[number], string | number | null>>,
): boolean {
  return CUSTOMER_FIELDS.every((field) => (existing[field] ?? null) === (input[field] ?? null));
}
