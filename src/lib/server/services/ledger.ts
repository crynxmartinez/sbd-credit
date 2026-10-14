import "server-only";
import { Prisma } from "@/generated/prisma/client";
import type { LedgerType } from "@/lib/domain/constants";
import { dbDateToIso, dueDateFor, isInClosedMonth, isoToDbDate } from "@/lib/domain/dates";
import { effectOnBalance, reversalFor } from "@/lib/domain/ledger";
import { formatCents } from "@/lib/domain/money";
import { can, type Action } from "@/lib/domain/roles";
import type { SessionUser } from "@/lib/types";
import type { LedgerEntryInput, ReversalInput } from "@/lib/validation";
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
  WRITE_OFF: "Written off",
  REVERSAL: "Reversal",
};
const NOUN: Readonly<Record<LedgerType, string>> = {
  CHARGE: "charge",
  PAYMENT: "payment",
  ADJUSTMENT: "adjustment",
  WRITE_OFF: "write-off",
  REVERSAL: "reversal",
};

/** The role needed to post each type directly. Types missing here need only the ability to record entries. */
const POST_PERMISSION: Partial<Record<LedgerType, { action: Action; message: string }>> = {
  ADJUSTMENT: { action: "ledger.adjust", message: "Only an admin can post an adjustment." },
  WRITE_OFF: { action: "ledger.write_off", message: "Only an admin can write off a balance." },
};

/** "$50.00", or "+$50.00" / "−$50.00" where the direction is the point (an adjustment or a reversal). */
function describeAmount(type: LedgerType, amountCents: number): string {
  const money = formatCents(Math.abs(amountCents), { fixed: true });
  if (type !== "ADJUSTMENT" && type !== "REVERSAL") return money;
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
async function balanceOf(
  tx: Prisma.TransactionClient,
  customerId: string,
  /** Only count entries dated on or before this day. Without it every live entry counts, post-dated ones included. */
  throughDate?: string,
): Promise<{ balanceCents: number; entries: number }> {
  const [row] = await tx.$queryRaw<{ total: bigint; entries: number }[]>`
    SELECT COALESCE(SUM(CASE WHEN "type" IN ('PAYMENT', 'WRITE_OFF') THEN -"amountCents" ELSE "amountCents" END), 0)::bigint AS total,
           COUNT(*)::int AS entries
    FROM "LedgerEntry" WHERE "customerId" = ${customerId} AND "voidedAt" IS NULL
    ${throughDate ? Prisma.sql`AND "entryDate" <= ${isoToDbDate(throughDate)}` : Prisma.empty}`;
  return { balanceCents: Number(row?.total ?? BigInt(0)), entries: row?.entries ?? 0 };
}

/** A write-off gives up on money that is owed, so it cannot be dated ahead, and cannot exceed what is owed that day. */
async function assertWritableOff(tx: Prisma.TransactionClient, customerId: string, input: LedgerEntryInput): Promise<void> {
  if (input.entryDate > businessToday()) {
    throw new ApiError(422, "invalid_entry", "A write-off cannot be dated in the future.");
  }
  const { balanceCents: owed } = await balanceOf(tx, customerId, input.entryDate);
  if (owed <= 0) throw new ApiError(409, "nothing_owed", "Nothing is owed as of that date, so there is nothing to write off.");
  if (input.amountCents > owed) {
    throw new ApiError(409, "exceeds_balance", `You can write off at most ${formatCents(owed, { fixed: true })}, which is what is owed.`);
  }
}

export async function recordEntry(customerId: string, input: LedgerEntryInput, actor: SessionUser): Promise<RecordResult> {
  const permission = POST_PERMISSION[input.type];
  if (permission && !can(actor.role, permission.action)) throw new ApiError(403, "forbidden", permission.message);

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

    if (input.type === "WRITE_OFF") await assertWritableOff(tx, customerId, input);

    const after = before + effectOnBalance(input.type, input.amountCents);
    const keepsDueDate = input.type === "CHARGE" || input.type === "ADJUSTMENT";
    const dueDate = keepsDueDate ? (input.dueDate ?? dueDateFor(input.entryDate, customer.paymentTerms)) : null;

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
      summary: [`${VERB[input.type]} — ${withReference(describeAmount(input.type, input.amountCents), input.reference)}`, input.type === "WRITE_OFF" ? input.note : null]
        .filter(Boolean)
        .join(" — "),
      actor: actor.name,
      actorId: actor.id,
      ledgerEntryId: created.id,
    });
    return { id: created.id, warning, duplicate: false, postDated: input.entryDate > businessToday() };
  });
}

/**
 * A void takes an entry out of the books as if it never happened, which is right for a typo in the current month and
 * wrong for anything already reported: that is corrected with a reversal dated today instead.
 */
async function assertVoidable(tx: Prisma.TransactionClient, entry: { id: string; type: string; entryDate: Date }): Promise<void> {
  if (entry.type === "REVERSAL") {
    throw new ApiError(409, "not_voidable", "A reversal cannot be voided. Record the original entry again instead.");
  }
  const reversal = await tx.ledgerEntry.findUnique({ where: { reversesEntryId: entry.id }, select: { id: true } });
  if (reversal) {
    throw new ApiError(409, "already_reversed", "That entry has been reversed, so it cannot also be voided.");
  }
  if (isInClosedMonth(dbDateToIso(entry.entryDate) ?? "", businessToday())) {
    throw new ApiError(409, "closed_month", "That entry is from a month that is already closed. Reverse it instead: that records a correction dated today and leaves the past month as it was.");
  }
}

export interface ReverseResult {
  id: string;
  /** True when this request had already been recorded (a retry), so nothing new was added. */
  duplicate: boolean;
}

/**
 * Cancels an earlier entry with a new, opposite one dated today (never earlier than the entry itself). The original is
 * left untouched, so figures already reported for its month stay true. An entry can be reversed once.
 */
export async function reverseEntry(customerId: string, entryId: string, input: ReversalInput, actor: SessionUser): Promise<ReverseResult> {
  if (!can(actor.role, "ledger.reverse")) throw new ApiError(403, "forbidden", "Only an admin can reverse an entry.");

  return transaction(async (tx) => {
    await lockCustomer(tx, customerId);

    if (input.requestKey) {
      const earlier = await tx.ledgerEntry.findUnique({
        where: { customerId_requestKey: { customerId, requestKey: input.requestKey } },
        select: { id: true },
      });
      if (earlier) return { id: earlier.id, duplicate: true };
    }

    const original = await tx.ledgerEntry.findFirst({ where: { id: entryId, customerId } });
    if (!original) throw new ApiError(404, "not_found", "That entry no longer exists.");
    if (original.voidedAt) throw new ApiError(409, "already_voided", "That entry was voided, so it has no effect to reverse.");

    const type = original.type as LedgerType;
    const offset = reversalFor({ type, amountCents: original.amountCents, entryDate: dbDateToIso(original.entryDate) ?? "" }, businessToday());
    if (!offset) throw new ApiError(409, "not_reversible", "A reversal cannot be reversed. Record the original entry again instead.");

    const already = await tx.ledgerEntry.findUnique({ where: { reversesEntryId: entryId }, select: { id: true, createdById: true, note: true } });
    if (already) {
      // The same person reversing it again for the same reason is a retry of a request that already succeeded.
      if (already.createdById === actor.id && already.note === input.reason) return { id: already.id, duplicate: true };
      throw new ApiError(409, "already_reversed", "That entry has already been reversed.");
    }

    const created = await tx.ledgerEntry.create({
      data: {
        customerId,
        type: "REVERSAL",
        amountCents: offset.amountCents,
        entryDate: isoToDbDate(offset.entryDate),
        dueDate: null,
        reference: original.reference,
        note: input.reason,
        createdBy: actor.name,
        createdById: actor.id,
        requestKey: input.requestKey ?? null,
        reversesEntryId: entryId,
      },
    });
    await writeAudit(tx, {
      customerId,
      action: "ledger.reversal",
      summary: `Reversed ${NOUN[type]} of ${withReference(describeAmount(type, original.amountCents), original.reference)} — ${input.reason}`,
      actor: actor.name,
      actorId: actor.id,
      ledgerEntryId: created.id,
    });
    return { id: created.id, duplicate: false };
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
    await assertVoidable(tx, entry);

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
