import "server-only";
import { centsToDecimal, toCsv } from "@/lib/domain/csv";
import { dbDateToIso } from "@/lib/domain/dates";
import { LEDGER_CSV_HEADER, ledgerCsvRow } from "@/lib/domain/ledger-csv";
import type { LedgerType } from "@/lib/domain/constants";
import { prisma } from "../db";
import { listSummaries } from "./customers";

/** One row per customer with the figures as of one business day. */
export async function customersCsv(asOf: string): Promise<string> {
  const customers = await listSummaries(asOf);
  // "Balance" is signed (negative when the customer has overpaid); "Credit on account" is the overpayment as a positive
  // figure. The dashboard's "outstanding" adds only the positive balances, so the two totals differ by that credit.
  const header = [
    "Customer ID", "Business", "Contact", "Phone", "Email", "Status", "Date applied", "Credit limit", "Payment terms",
    "Balance", "Credit on account", "Overdue", "Next due date", "Next due amount", "Utilization %", "Written off",
  ];
  const rows = customers.map((c) => [
    c.id, c.businessName, c.contactName, c.phone, c.email, c.status, c.dateApplied, centsToDecimal(c.creditLimitCents),
    c.paymentTerms, centsToDecimal(c.balanceCents), centsToDecimal(c.creditCents), centsToDecimal(c.overdueCents), c.nextDueDate,
    centsToDecimal(c.nextDueCents), c.utilizationPct, centsToDecimal(c.writtenOffCents),
  ]);
  return toCsv([header, ...rows]);
}

/** Every ledger entry, voided ones included and marked, so the export reconciles to the books. */
export async function ledgerCsv(asOf: string): Promise<string> {
  const entries = await prisma.ledgerEntry.findMany({
    include: { customer: { select: { businessName: true } } },
    orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  // An entry is "reversed" when a live entry points at it.
  const reversed = new Set(entries.filter((e) => e.reversesEntryId !== null).map((e) => e.reversesEntryId));
  const rows = entries.map((e) =>
    ledgerCsvRow(
      {
        customerId: e.customerId,
        businessName: e.customer.businessName,
        type: e.type as LedgerType,
        amountCents: e.amountCents,
        entryDate: dbDateToIso(e.entryDate) ?? "",
        dueDate: dbDateToIso(e.dueDate),
        reference: e.reference,
        note: e.note,
        createdBy: e.createdBy,
        voided: e.voidedAt !== null,
        voidReason: e.voidReason,
        reversed: reversed.has(e.id),
        isReversal: e.type === "REVERSAL",
      },
      asOf,
    ),
  );
  return toCsv([[...LEDGER_CSV_HEADER], ...rows]);
}
