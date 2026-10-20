import "server-only";
import { toPortalView, type PortalView } from "@/lib/domain/portal";
import { toSummary } from "@/lib/domain/summary";
import { prisma } from "../db";
import type { PortalUser } from "../auth/customer-session";
import { toCustomerBase, toLedgerRecord } from "../serialize";

/**
 * What a signed-in customer sees. It takes the signed-in contact and reads ONLY that contact's own customer: there is
 * no parameter anywhere that names a customer, so there is nothing for a caller to get wrong or a request to forge.
 * Every query below is scoped by `user.customerId`.
 */
export async function getPortalView(user: PortalUser, asOf: string): Promise<PortalView | null> {
  // One snapshot, so the customer's standing and limit and the entries they are shown (and the figures computed from them) are from the
  // same moment: what the customer sees adds up.
  const [customer, entries] = await prisma.$transaction([
    prisma.customer.findUnique({ where: { id: user.customerId } }),
    prisma.ledgerEntry.findMany({
      where: { customerId: user.customerId, voidedAt: null },
      select: {
        id: true, type: true, amountCents: true, entryDate: true, dueDate: true, reference: true, voidedAt: true, reversesEntryId: true,
        writeOffAllocations: { select: { chargeEntryId: true, amountCents: true } },
      },
    }),
  ], { isolationLevel: "RepeatableRead" });
  if (!customer) return null;

  const rows = entries.map((entry) => ({ entry, record: toLedgerRecord(entry) }));
  const summary = toSummary(toCustomerBase(customer), rows.map((row) => row.record), asOf);
  return toPortalView(
    summary,
    rows.map(({ entry, record }) => ({
      id: record.id,
      type: record.type,
      amountCents: record.amountCents,
      entryDate: record.entryDate,
      dueDate: record.dueDate,
      reference: entry.reference,
      voided: false,
    })),
    asOf,
  );
}
