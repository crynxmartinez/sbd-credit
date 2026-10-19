import "server-only";
import { Prisma } from "@/generated/prisma/client";
import type { CustomerStatus, LedgerType } from "@/lib/domain/constants";
import { dbDateToIso, dueDateFor, formatDate, isInClosedMonth, isoToDbDate } from "@/lib/domain/dates";
import { entryDateIssue } from "@/lib/domain/entry-dates";
import { sameLedgerSubmission } from "@/lib/domain/idempotency";
import { effectOnBalance, reversalFor, type LedgerRecord } from "@/lib/domain/ledger";
import { formatCents } from "@/lib/domain/money";
import { can, type Action } from "@/lib/domain/roles";
import { canTakePayment } from "@/lib/domain/status";
import { planWriteOffAllocation, sameAllocations, writeOffTargets, type Allocation } from "@/lib/domain/write-off";
import type { SessionUser } from "@/lib/types";
import type { LedgerEntryInput, ReversalInput } from "@/lib/validation";
import { systemClock, type Clock } from "../clock";
import { ApiError } from "../http";
import { transaction } from "../tx";
import { toLedgerRecord } from "../serialize";
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

const keyReuse = () =>
  new ApiError(
    409,
    "request_key_reuse",
    "That was already recorded with different details. Reload the customer to see what was saved, then enter any change as a new entry.",
  );

interface LockedCustomer {
  status: string;
  paymentTerms: string;
  creditLimitCents: number;
}

/**
 * Locks the customer row for the rest of the transaction and returns its current values, in ONE statement. Anything
 * else that wants this customer (a suspension, an edit, another entry) waits for this transaction to finish, so what
 * is read afterwards cannot change underneath it.
 */
async function lockCustomer(tx: Prisma.TransactionClient, customerId: string): Promise<LockedCustomer> {
  const rows = await tx.$queryRaw<LockedCustomer[]>`
    UPDATE "Customer" SET "updatedAt" = now()
    WHERE "id" = ${customerId}
    RETURNING "status", "paymentTerms", "creditLimitCents"`;
  const row = rows[0];
  if (!row) throw new ApiError(404, "not_found", "That customer no longer exists.");
  return row;
}

/**
 * The balance counting entries dated on or before `throughDate`, and the number of live entries of ANY date, summed by
 * the database so the whole ledger never travels to Node. The SQL sign rule mirrors effectOnBalance in domain/ledger.ts:
 * a test checks the two agree for every ledger type.
 */
export async function balanceOf(
  tx: Prisma.TransactionClient,
  customerId: string,
  throughDate: string,
): Promise<{ balanceCents: number; entries: number }> {
  const [row] = await tx.$queryRaw<{ total: bigint; entries: number }[]>`
    SELECT COALESCE(SUM(CASE WHEN "type" IN ('PAYMENT', 'WRITE_OFF') THEN -"amountCents" ELSE "amountCents" END)
                    FILTER (WHERE "entryDate" <= ${isoToDbDate(throughDate)}), 0)::bigint AS total,
           COUNT(*)::int AS entries
    FROM "LedgerEntry" WHERE "customerId" = ${customerId} AND "voidedAt" IS NULL`;
  return { balanceCents: Number(row?.total ?? BigInt(0)), entries: row?.entries ?? 0 };
}

/** Every live entry of the customer, with the allocations of its write-offs: the books as the pure rules in domain/ see them. */
async function loadRecords(tx: Prisma.TransactionClient, customerId: string): Promise<LedgerRecord[]> {
  const rows = await tx.ledgerEntry.findMany({
    where: { customerId, voidedAt: null },
    select: {
      id: true, type: true, amountCents: true, entryDate: true, dueDate: true, voidedAt: true, reversesEntryId: true,
      writeOffAllocations: { select: { chargeEntryId: true, amountCents: true } },
    },
  });
  return rows.map(toLedgerRecord);
}

/**
 * Decides which charges a write-off covers, or refuses it. A write-off gives up on money that is owed, so it cannot be
 * dated ahead, and each charge it covers must have that much still open on EVERY day the write-off will be in force (from its
 * own date to today): otherwise a write-off backdated to before a payment, or to a time another write-off was in force, would
 * settle one charge twice for the days in between. The default is the oldest-due charges; the person may choose instead.
 */
async function planWriteOff(tx: Prisma.TransactionClient, customerId: string, input: LedgerEntryInput, today: string): Promise<Allocation[]> {
  if (input.entryDate > today) throw new ApiError(422, "invalid_entry", "A write-off cannot be dated in the future.");
  const targets = writeOffTargets(await loadRecords(tx, customerId), input.entryDate, today);
  const plan = planWriteOffAllocation(input.amountCents, targets, input.allocations);
  if (plan.ok) return plan.allocations;
  if (plan.code === "nothing_owed") throw new ApiError(409, "nothing_owed", "Nothing is owed, so there is nothing to write off.");
  if (plan.code === "exceeds_balance") {
    throw new ApiError(409, "exceeds_balance", `You can write off at most ${formatCents(plan.maxCents, { fixed: true })}, which is what is owed.`);
  }
  throw new ApiError(
    409,
    "invalid_allocation",
    `The charges chosen do not match what is owed now (something may have changed since you opened this form). You can write off at most ${formatCents(plan.maxCents, { fixed: true })}. Review the write-off and try again.`,
  );
}

interface CoverRow {
  writeOffCents: number;
  entryDate: Date;
  reversed: boolean;
}

/** The write-offs on the books (not voided) that cover this entry, and whether each has been reversed since. */
async function writeOffsCovering(tx: Prisma.TransactionClient, entryId: string): Promise<CoverRow[]> {
  return tx.$queryRaw<CoverRow[]>`
    SELECT w."amountCents" AS "writeOffCents", w."entryDate",
           EXISTS (SELECT 1 FROM "LedgerEntry" r WHERE r."reversesEntryId" = w."id" AND r."voidedAt" IS NULL) AS "reversed"
    FROM "WriteOffAllocation" a JOIN "LedgerEntry" w ON w."id" = a."writeOffEntryId"
    WHERE a."chargeEntryId" = ${entryId} AND w."voidedAt" IS NULL`;
}

/**
 * Taking a charge out of the books must not leave a write-off pointing at nothing. A charge that a write-off covers cannot
 * be voided or reversed until that write-off is reversed. A charge that a write-off covered EARLIER and has since been
 * reversed cannot be voided (a void erases it from every day, including the days the write-off was in force), only reversed.
 * A charge nothing ever covered can always be corrected.
 */
async function assertNotCoveredByWriteOff(tx: Prisma.TransactionClient, entryId: string, how: "void" | "reverse"): Promise<void> {
  const covering = await writeOffsCovering(tx, entryId);
  const live = covering.find((row) => !row.reversed);
  if (live) {
    throw new ApiError(
      409,
      "write_off_covers",
      `A write-off of ${formatCents(live.writeOffCents, { fixed: true })} dated ${formatDate(dbDateToIso(live.entryDate) ?? "")} covers this charge. Reverse that write-off first, then correct the charge.`,
    );
  }
  if (how === "void" && covering.length > 0) {
    throw new ApiError(409, "write_off_history", "A write-off covered this charge earlier (it has since been reversed), so it cannot be voided. Reverse the charge instead.");
  }
}

/**
 * Write-offs from before allocations existed settle the oldest charge like a payment, so correcting a charge could still push
 * the balance below zero while one of them stands. While the customer has any such write-off, a correction that lowers what
 * is owed must leave today's balance at or above zero.
 */
async function assertLegacyWriteOffSafe(tx: Prisma.TransactionClient, customerId: string, effectCents: number, today: string): Promise<void> {
  if (effectCents <= 0) return;
  const [row] = await tx.$queryRaw<{ found: number }[]>`
    SELECT 1 AS found FROM "LedgerEntry" w
    WHERE w."customerId" = ${customerId} AND w."type" = 'WRITE_OFF' AND w."voidedAt" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "LedgerEntry" r WHERE r."reversesEntryId" = w."id" AND r."voidedAt" IS NULL)
      AND NOT EXISTS (SELECT 1 FROM "WriteOffAllocation" a WHERE a."writeOffEntryId" = w."id")
    LIMIT 1`;
  if (!row) return;
  const { balanceCents } = await balanceOf(tx, customerId, today);
  if (balanceCents - effectCents < 0) {
    throw new ApiError(409, "write_off_covers", "An earlier write-off covers this charge. Reverse the write-off first, then correct the charge.");
  }
}

function toDateErrors(issue: { code: string; message: string }): ApiError {
  return issue.code === "closed_month"
    ? new ApiError(403, "closed_month_admin_only", issue.message)
    : new ApiError(422, "invalid_entry", issue.message);
}

/** "covers INV-1 ($60.00), a charge of $40.00 dated Oct 3, 2026 ($40.00)": which charges a write-off covers, for the history. */
async function describeCovers(tx: Prisma.TransactionClient, allocations: readonly Allocation[]): Promise<string> {
  const rows = await tx.ledgerEntry.findMany({
    where: { id: { in: allocations.map((allocation) => allocation.chargeId) } },
    select: { id: true, reference: true, amountCents: true, entryDate: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parts = allocations.map((allocation) => {
    const charge = byId.get(allocation.chargeId);
    const label = charge?.reference ?? `a charge of ${formatCents(charge?.amountCents ?? 0, { fixed: true })} dated ${formatDate(dbDateToIso(charge?.entryDate ?? null) ?? "")}`;
    return `${label} (${formatCents(allocation.amountCents, { fixed: true })})`;
  });
  return `covers ${parts.join(", ")}`;
}

export async function recordEntry(customerId: string, input: LedgerEntryInput, actor: SessionUser, clock: Clock = systemClock): Promise<RecordResult> {
  const permission = POST_PERMISSION[input.type];
  if (permission && !can(actor.role, permission.action)) throw new ApiError(403, "forbidden", permission.message);
  const today = clock.today();

  return transaction(async (tx) => {
    const customer = await lockCustomer(tx, customerId);

    // A retry of a submission that already went through (a lost response, a double click) returns the first result,
    // provided it really is the same submission. This comes first, so a retry still succeeds after a later suspension.
    if (input.requestKey) {
      const earlier = await tx.ledgerEntry.findUnique({
        where: { customerId_requestKey: { customerId, requestKey: input.requestKey } },
        select: {
          id: true, type: true, amountCents: true, entryDate: true, dueDate: true, reference: true, note: true, voidedAt: true,
          writeOffAllocations: { select: { chargeEntryId: true, amountCents: true } },
        },
      });
      if (earlier) {
        const stored = { ...earlier, entryDate: dbDateToIso(earlier.entryDate) ?? "", dueDate: dbDateToIso(earlier.dueDate) };
        if (!sameLedgerSubmission(stored, input)) throw keyReuse();
        // A write-off sent again with a DIFFERENT choice of charges is an edited form, not a retry.
        const storedSplit = earlier.writeOffAllocations.map((allocation) => ({ chargeId: allocation.chargeEntryId, amountCents: allocation.amountCents }));
        if (input.allocations && !sameAllocations(storedSplit, input.allocations)) throw keyReuse();
        // Recorded, and then taken out of the books: "already recorded" would be a lie, because nothing counts. Say what happened.
        if (earlier.voidedAt) {
          throw new ApiError(409, "entry_voided", "That entry was recorded and then voided, so it does not count. Reload the customer and enter it again as a new entry if it should.");
        }
        return { id: earlier.id, warning: null, duplicate: true, postDated: stored.entryDate > today };
      }
    }

    const issue = entryDateIssue(actor.role, input.entryDate, today);
    if (issue) throw toDateErrors(issue);

    // A charge, and an adjustment that raises what is owed, are new credit: only an approved account may have them.
    const addsDebt = input.type === "CHARGE" || (input.type === "ADJUSTMENT" && input.amountCents > 0);
    if (addsDebt && customer.status !== "approved") {
      throw new ApiError(409, "invalid_state", "Charges can only be added to an approved account.");
    }

    // Everything below is judged on today's books: an entry dated ahead has not happened yet.
    const { balanceCents: before, entries } = await balanceOf(tx, customerId, today);
    if (input.type !== "CHARGE" && !canTakePayment(customer.status as CustomerStatus, entries > 0)) {
      throw new ApiError(409, "invalid_state", "This account has no balance to change.");
    }
    const allocations = input.type === "WRITE_OFF" ? await planWriteOff(tx, customerId, input, today) : [];

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
        // The database insists a write-off recorded from now on is allocated to charges in full.
        allocationsRequired: input.type === "WRITE_OFF",
      },
    });
    let covers: string | null = null;
    if (allocations.length > 0) {
      await tx.writeOffAllocation.createMany({
        data: allocations.map((allocation) => ({ writeOffEntryId: created.id, chargeEntryId: allocation.chargeId, amountCents: allocation.amountCents })),
      });
      // Check the totals now, inside the transaction, so a problem is a clear error here and not a failure at commit.
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
      covers = await describeCovers(tx, allocations);
    }
    await writeAudit(tx, {
      customerId,
      action: `ledger.${input.type.toLowerCase()}`,
      summary: [`${VERB[input.type]} — ${withReference(describeAmount(input.type, input.amountCents), input.reference)}`, input.type === "WRITE_OFF" ? input.note : null, covers]
        .filter(Boolean)
        .join(" — "),
      actor: actor.name,
      actorId: actor.id,
      ledgerEntryId: created.id,
    });
    return { id: created.id, warning, duplicate: false, postDated: input.entryDate > today };
  });
}

/**
 * A void takes an entry out of the books as if it never happened, which is right for a typo in the current month and
 * wrong for anything already reported: that is corrected with a reversal dated today instead.
 */
async function assertVoidable(tx: Prisma.TransactionClient, entry: { id: string; type: string; entryDate: Date }, today: string): Promise<void> {
  if (entry.type === "REVERSAL") {
    throw new ApiError(409, "not_voidable", "A reversal cannot be voided. Record the original entry again instead.");
  }
  const reversal = await tx.ledgerEntry.findUnique({ where: { reversesEntryId: entry.id }, select: { id: true } });
  if (reversal) {
    throw new ApiError(409, "already_reversed", "That entry has been reversed, so it cannot also be voided.");
  }
  if (isInClosedMonth(dbDateToIso(entry.entryDate) ?? "", today)) {
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
export async function reverseEntry(customerId: string, entryId: string, input: ReversalInput, actor: SessionUser, clock: Clock = systemClock): Promise<ReverseResult> {
  if (!can(actor.role, "ledger.reverse")) throw new ApiError(403, "forbidden", "Only an admin can reverse an entry.");
  const today = clock.today();

  return transaction(async (tx) => {
    await lockCustomer(tx, customerId);

    if (input.requestKey) {
      const earlier = await tx.ledgerEntry.findUnique({
        where: { customerId_requestKey: { customerId, requestKey: input.requestKey } },
        select: { id: true, reversesEntryId: true, note: true },
      });
      if (earlier) {
        if (earlier.reversesEntryId !== entryId || earlier.note !== input.reason) throw keyReuse();
        return { id: earlier.id, duplicate: true };
      }
    }

    const original = await tx.ledgerEntry.findFirst({ where: { id: entryId, customerId } });
    if (!original) throw new ApiError(404, "not_found", "That entry no longer exists.");
    if (original.voidedAt) throw new ApiError(409, "already_voided", "That entry was voided, so it has no effect to reverse.");

    const type = original.type as LedgerType;
    const offset = reversalFor({ type, amountCents: original.amountCents, entryDate: dbDateToIso(original.entryDate) ?? "" }, today);
    if (!offset) throw new ApiError(409, "not_reversible", "A reversal cannot be reversed. Record the original entry again instead.");

    const already = await tx.ledgerEntry.findUnique({ where: { reversesEntryId: entryId }, select: { id: true, createdById: true, note: true } });
    if (already) {
      // The same person reversing it again for the same reason is a retry of a request that already succeeded.
      if (already.createdById === actor.id && already.note === input.reason) return { id: already.id, duplicate: true };
      throw new ApiError(409, "already_reversed", "That entry has already been reversed.");
    }
    await assertNotCoveredByWriteOff(tx, entryId, "reverse");
    await assertLegacyWriteOffSafe(tx, customerId, effectOnBalance(type, original.amountCents), today);

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

export async function voidEntry(customerId: string, entryId: string, reason: string, actor: SessionUser, clock: Clock = systemClock): Promise<void> {
  // Checked here as well as in the route, so a future caller cannot bypass it.
  if (!can(actor.role, "ledger.void")) throw new ApiError(403, "forbidden", "Only an admin can void an entry.");
  const today = clock.today();

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
    await assertVoidable(tx, entry, today);

    const type = entry.type as LedgerType;
    await assertNotCoveredByWriteOff(tx, entryId, "void");
    await assertLegacyWriteOffSafe(tx, customerId, effectOnBalance(type, entry.amountCents), today);
    await tx.ledgerEntry.update({
      where: { id: entryId },
      data: { voidedAt: clock.now(), voidedBy: actor.name, voidedById: actor.id, voidReason: reason },
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
