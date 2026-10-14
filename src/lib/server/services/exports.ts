import "server-only";
import { centsToDecimal, toCsv } from "@/lib/domain/csv";
import { dbDateToIso } from "@/lib/domain/dates";
import { prisma } from "../db";
import { listSummaries } from "./customers";

/** One row per customer with the figures as of one business day. */
export async function customersCsv(asOf: string): Promise<string> {
  const customers = await listSummaries(asOf);
  const header = [
    "Business", "Contact", "Phone", "Email", "Status", "Date applied", "Credit limit", "Payment terms",
    "Balance", "Overdue", "Next due date", "Next due amount", "Utilization %", "Written off",
  ];
  const rows = customers.map((c) => [
    c.businessName, c.contactName, c.phone, c.email, c.status, c.dateApplied, centsToDecimal(c.creditLimitCents),
    c.paymentTerms, centsToDecimal(c.balanceCents), centsToDecimal(c.overdueCents), c.nextDueDate,
    centsToDecimal(c.nextDueCents), c.utilizationPct, centsToDecimal(c.writtenOffCents),
  ]);
  return toCsv([header, ...rows]);
}

/** Every ledger entry, voided ones included and marked, so the export reconciles to the books. */
export async function ledgerCsv(): Promise<string> {
  const entries = await prisma.ledgerEntry.findMany({
    include: { customer: { select: { businessName: true } } },
    orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  });
  const header = ["Business", "Type", "Amount", "Entry date", "Due date", "Reference", "Note", "Recorded by", "Voided", "Void reason"];
  const rows = entries.map((e) => [
    e.customer.businessName, e.type, centsToDecimal(e.amountCents), dbDateToIso(e.entryDate), dbDateToIso(e.dueDate),
    e.reference, e.note, e.createdBy, e.voidedAt ? "yes" : "no", e.voidReason,
  ]);
  return toCsv([header, ...rows]);
}
