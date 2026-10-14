import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { FieldChange } from "@/lib/domain/diff";

interface AuditInput {
  customerId: string;
  action: string;
  summary: string;
  actor: string;
  /** Display names are not unique; the id is what ties an event to one person. */
  actorId: string;
  /** Who this is: a member of staff, a customer, or the system itself. */
  actorKind?: "staff" | "customer" | "system" | "anonymous";
  /** The ledger entry this event is about, when it is about one. */
  ledgerEntryId?: string;
  changes?: readonly FieldChange[];
}

/** Written inside the same transaction as the change it describes, so the log can never disagree with the data. */
export async function writeAudit(tx: Prisma.TransactionClient, input: AuditInput): Promise<void> {
  await tx.auditEvent.create({
    data: {
      customerId: input.customerId,
      action: input.action,
      summary: input.summary,
      actor: input.actor,
      actorId: input.actorId,
      actorKind: input.actorKind ?? "staff",
      ledgerEntryId: input.ledgerEntryId ?? null,
      changes: input.changes && input.changes.length > 0 ? (input.changes as unknown as Prisma.InputJsonValue) : undefined,
    },
  });
}
