import "server-only";
import { Prisma } from "@/generated/prisma/client";
import type { LedgerType } from "@/lib/domain/constants";
import { dueDateFor, isoToDbDate } from "@/lib/domain/dates";
import { formatCents } from "@/lib/domain/money";
import { can } from "@/lib/domain/roles";
import type { SessionUser } from "@/lib/types";
import type { LedgerEntryInput } from "@/lib/validation";
import { businessToday } from "../as-of";
import { ApiError } from "../http";
import { transaction } from "../tx";
import { writeAudit } from "./audit";

export type LedgerWarning = "over_limit" | "overpayment" | null;
export interface RecordResult {
  id: string;
  warning: LedgerWarning;
  /** True when this request had already been recorded (a retry), so nothing new was added. */
  duplicate: boolean;
  /** True when the entry is dated after the business day: it is kept, but does not count toward today's balance yet. */
  postDated: boolean;
}

const VERB: Readonly<Record<LedgerType, string>> = {
  CHARGE: "Charge added",
  PAYMENT: "Payment received",
  ADJUSTMENT: "Adjustment",
};
const NOUN: Readonly<Record<LedgerType, string>> = { CHARGE: "charge", PAYMENT: "payment", ADJUSTMENT: "adjustment" };

/** "$50.00", or "+$50.00" / "−$50.00" for an adjustment, where the direction is the point. */
function describeAmount(type: LedgerType, amountCents: number): string {
  const money = formatCents(Math.abs(amountCents), { fixed: true });
  if (type !== "ADJUSTMENT") return money;
  return `${amountCents < 0 ? "−" : "+"}${money}`;
}

const withReference = (text: string, reference: string | null): string => (reference ? `${text} (${reference})` : text);

/** Money can still be owed after a suspension, denial or reopening, so payments are accepted wherever there is a ledger. */
function assertCanTakePayment(status: string, hasEntries: boolean): void {
  if (hasEntries || status === "approved" || status === "suspended") return;
  throw new ApiError(409, "invalid_state", "This account has no balance to change.");
}

interface LockedCustomer {
  status: string;
  paymentTerms: string;
  creditLimitCents: number;
}

/**
 * Locks the customer row for the rest of the transaction and returns its current values, in ONE statement. Anything
 * else that wants this customer (a suspension, an edit, another entry) waits for this transaction to finish, so what
 * is read afterwards cannot change underneath it. `requireStatus` makes the status part of the lock itself, so a
 * suspension that committed first is seen as "no row" rather than being raced past.
 */
async function lockCustomer(tx: Prisma.TransactionClient, customerId: string, requireStatus?: string): Promise<LockedCustomer> {
  const rows = await tx.$queryRaw<LockedCustomer[]>`
    UPDATE "Customer" SET "updatedAt" = now()
    WHERE "id" = ${customerId} ${requireStatus ? Prisma.sql`AND "status" = ${requireStatus}` : Prisma.empty}
    RETURNING "status", "paymentTerms", "creditLimitCents"`;
  const row = rows[0];
  if (row) return row;

  const exists = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true } });
  if (!exists) throw new ApiError(404, "not_found", "That customer no longer exists.");
  throw new ApiError(409, "invalid_state", "Charges can only be added to an approved account.");
}

/** The balance and the number of live entries, summed by the database so the whole ledger never travels to Node. */
async function balanceOf(tx: Prisma.TransactionClient, customerId: string): Promise<{ balanceCents: number; entries: number }> {
  const [row] = await tx.$queryRaw<{ total: bigint; entries: number }[]>`
    SELECT COALESCE(SUM(CASE WHEN "type" = 'PAYMENT' THEN -"amountCents" ELSE "amountCents" END), 0)::bigint AS total,
           COUNT(*)::int AS entries
    FROM "LedgerEntry" WHERE "customerId" = ${customerId} AND "voidedAt" IS NULL`;
  return { balanceCents: Number(row?.total ?? BigInt(0)), entries: row?.entries ?? 0 };
}

export async function recordEntry(customerId: string, input: LedgerEntryInput, actor: SessionUser): Promise<RecordResult> {
  if (input.type === "ADJUSTMENT" && !can(actor.role, "ledger.adjust")) {
    throw new ApiError(403, "forbidden", "Only an admin can post an adjustment.");
  }

  return transaction(async (tx) => {
    const customer = await lockCustomer(tx, customerId, input.type === "CHARGE" ? "approved" : undefined);

    // A retry of a submission that already went through (a lost response, a double click) returns the first result.
    if (input.requestKey) {
      const earlier = await tx.ledgerEntry.findUnique({
        where: { customerId_requestKey: { customerId, requestKey: input.requestKey } },
        select: { id: true },
      });
      if (earlier) return { id: earlier.id, warning: null, duplicate: true, postDated: false };
    }

    const { balanceCents: before, entries } = await balanceOf(tx, customerId);
    if (input.type !== "CHARGE") assertCanTakePayment(customer.status, entries > 0);

    const after = before + (input.type === "PAYMENT" ? -input.amountCents : input.amountCents);
    const dueDate = input.type === "PAYMENT" ? null : (input.dueDate ?? dueDateFor(input.entryDate, customer.paymentTerms));

    let warning: LedgerWarning = null;
    if (input.type === "PAYMENT" && after < 0) warning = "overpayment";
    else if (customer.creditLimitCents > 0 && after > before && after >= customer.creditLimitCents) warning = "over_limit";

    const created = await tx.ledgerEntry.create({
      data: {
        customerId,
        type: input.type,
        amountCents: input.amountCents,
        entryDate: isoToDbDate(input.entryDate),
        dueDate: dueDate ? isoToDbDate(dueDate) : null,
        reference: input.reference,
        note: input.note,
        createdBy: actor.name,
        createdById: actor.id,
        requestKey: input.requestKey ?? null,
      },
    });
    await writeAudit(tx, {
      customerId,
      action: `ledger.${input.type.toLowerCase()}`,
      summary: `${VERB[input.type]} — ${withReference(describeAmount(input.type, input.amountCents), input.reference)}`,
      actor: actor.name,
      actorId: actor.id,
      ledgerEntryId: created.id,
    });
    return { id: created.id, warning, duplicate: false, postDated: input.entryDate > businessToday() };
  });
}

export async function voidEntry(customerId: string, entryId: string, reason: string, actor: SessionUser): Promise<void> {
  // Checked here as well as in the route, so a future caller cannot bypass it.
  if (!can(actor.role, "ledger.void")) throw new ApiError(403, "forbidden", "Only an admin can void an entry.");

  await transaction(async (tx) => {
    // Customer first, then the entry: the same order every writer uses, so two writers can never wait on each other.
    await lockCustomer(tx, customerId);

    const entry = await tx.ledgerEntry.findFirst({ where: { id: entryId, customerId } });
    if (!entry) throw new ApiError(404, "not_found", "That entry no longer exists.");
    if (entry.voidedAt) {
      // The same person voiding it again for the same reason is a retry of a request that already succeeded.
      if (entry.voidedById === actor.id && entry.voidReason === reason) return;
      throw new ApiError(409, "already_voided", "That entry has already been voided.");
    }

    const type = entry.type as LedgerType;
    await tx.ledgerEntry.update({
      where: { id: entryId },
      data: { voidedAt: new Date(), voidedBy: actor.name, voidedById: actor.id, voidReason: reason },
    });
    await writeAudit(tx, {
      customerId,
      action: "ledger.void",
      summary: `Voided ${NOUN[type]} of ${withReference(describeAmount(type, entry.amountCents), entry.reference)} — ${reason}`,
      actor: actor.name,
      actorId: actor.id,
      ledgerEntryId: entryId,
    });
  });
}
