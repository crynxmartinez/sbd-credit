import "server-only";
import { centsToDecimal, toCsv } from "@/lib/domain/csv";
import { dbDateToIso } from "@/lib/domain/dates";
import { LEDGER_CSV_HEADER, ledgerCsvRow } from "@/lib/domain/ledger-csv";
import { formatCents } from "@/lib/domain/money";
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

/** Rows read from the database at a time. Small enough to keep memory flat, large enough that the round trips stay few. */
const LEDGER_PAGE_SIZE = 2_000;

/**
 * Every ledger entry, voided ones included and marked, so the export reconciles to the books, produced a page at a time.
 *
 * It used to read the whole ledger into memory, build every row, join them into one string and then copy that string again with a
 * byte-order mark on the front: at hundreds of thousands of rows that was gigabytes and several seconds with the whole server
 * stalled. Pages are read by id (a stable order that needs no sort over the whole table), turned into text, and handed on; the
 * event loop gets a turn between pages. Rows come out in the order they were recorded.
 */
export async function* ledgerCsvChunks(asOf: string, pageSize: number = LEDGER_PAGE_SIZE): AsyncGenerator<string> {
  yield toCsv([[...LEDGER_CSV_HEADER]]);
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.ledgerEntry.findMany({
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: "asc" },
      include: {
        customer: { select: { businessName: true } },
        // An entry is "reversed" when a reversal points at it.
        reversedBy: { select: { id: true } },
        writeOffAllocations: { include: { chargeEntry: { select: { reference: true, amountCents: true, entryDate: true } } }, orderBy: { createdAt: "asc" } },
      },
    });
    if (page.length === 0) return;
    cursor = page[page.length - 1]!.id;
    yield toCsv(
      page.map((e) =>
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
            reversed: e.reversedBy !== null,
            isReversal: e.type === "REVERSAL",
            writtenOffAgainst: e.writeOffAllocations
              .map((a) => `${a.chargeEntry.reference ?? `charge of ${formatCents(a.chargeEntry.amountCents, { fixed: true })} dated ${dbDateToIso(a.chargeEntry.entryDate) ?? ""}`} (${formatCents(a.amountCents, { fixed: true })})`)
              .join("; "),
          },
          asOf,
        ),
      ),
    );
    if (page.length < pageSize) return;
    // A turn for everything else the server is doing.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** The whole ledger CSV as one string (for tests and small uses; the download streams it). */
export async function ledgerCsv(asOf: string, pageSize?: number): Promise<string> {
  let text = "";
  for await (const chunk of ledgerCsvChunks(asOf, pageSize)) text += chunk;
  return text;
}
