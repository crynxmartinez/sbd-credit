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
  const customer = await prisma.customer.findUnique({ where: { id: user.customerId } });
  if (!customer) return null;

  const entries = await prisma.ledgerEntry.findMany({
    where: { customerId: user.customerId, voidedAt: null },
    select: { id: true, type: true, amountCents: true, entryDate: true, dueDate: true, reference: true, voidedAt: true, reversesEntryId: true },
  });

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
