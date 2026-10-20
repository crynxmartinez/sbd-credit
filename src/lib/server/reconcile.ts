import type { PrismaClient } from "@/generated/prisma/client";
import { dbDateToIso } from "@/lib/domain/dates";
import { MAX_AMOUNT_CENTS, MAX_POSTDATE_DAYS } from "@/lib/domain/constants";
import { addDays } from "@/lib/domain/dates";
import { computeAging, effectOnBalance, type LedgerRecord } from "@/lib/domain/ledger";
import type { LedgerType } from "@/lib/domain/constants";

/**
 * "Would anyone notice?" A nightly, read-only check of the books against themselves. Nothing here trusts the application's own
 * arithmetic: balances are re-summed by the database, allocations and reversals are re-checked from the raw rows, the history is
 * compared with the ledger, and the database's own safeguards are looked up in its catalog. Every finding names something that
 * should be impossible if the application and the database rules are doing their jobs, which is exactly why it is worth knowing.
 *
 * Run as the application's own database login (it only reads):  npm run reconcile   (production: docs/PRODUCTION.md)
 * No "server-only" import on purpose: scripts/reconcile.ts runs outside Next.
 */
export interface Finding {
  check: string;
  detail: string;
}

export interface ReconcileReport {
  today: string;
  customers: number;
  entries: number;
  /** Money amounts in the history that could be read back and compared with the ledger. */
  amountsCrossChecked: number;
  findings: Finding[];
}

/** Every trigger the schema must have, and that must be switched on: "Table.trigger". */
export const EXPECTED_TRIGGERS: readonly string[] = [
  "AccountEvent.AccountEvent_append_only",
  "AccountEvent.AccountEvent_no_truncate",
  "AuditEvent.AuditEvent_append_only",
  "AuditEvent.AuditEvent_no_truncate",
  "LedgerEntry.LedgerEntry_no_delete",
  "LedgerEntry.LedgerEntry_no_truncate",
  "LedgerEntry.LedgerEntry_void_only",
  "LedgerEntry.LedgerEntry_write_off_allocated",
  "WriteOffAllocation.WriteOffAllocation_append_only",
  "WriteOffAllocation.WriteOffAllocation_no_truncate",
  "WriteOffAllocation.WriteOffAllocation_rules",
  "WriteOffAllocation.WriteOffAllocation_total",
];

/** The first money amount in a history line: "Payment received — $1,234.56 (CHK-9)" -> 123456, "Adjustment — −$5.00" -> -500. */
export function amountInSummary(summary: string): number | null {
  const match = /([+−-])?\$([\d,]+)\.(\d{2})/.exec(summary);
  if (!match) return null;
  const cents = Number(match[2]!.replace(/,/g, "")) * 100 + Number(match[3]);
  return match[1] === "−" || match[1] === "-" ? -cents : cents;
}

const CREATED_ACTION: Readonly<Record<string, LedgerType>> = {
  "ledger.charge": "CHARGE", "ledger.payment": "PAYMENT", "ledger.adjustment": "ADJUSTMENT", "ledger.write_off": "WRITE_OFF", "ledger.reversal": "REVERSAL",
};

const cap = (findings: Finding[], check: string, rows: string[], what: string, limit = 20): void => {
  for (const row of rows.slice(0, limit)) findings.push({ check, detail: row });
  if (rows.length > limit) findings.push({ check, detail: `…and ${rows.length - limit} more ${what}` });
};

export async function reconcileBooks(db: PrismaClient, today: string): Promise<ReconcileReport> {
  return db.$transaction(
    async (tx) => {
      const findings: Finding[] = [];

      // One snapshot for everything below, so a payment recorded while this runs cannot make the checks disagree with each other.
      const customers = await tx.customer.count();
      const ledger = await tx.ledgerEntry.findMany({
        select: { id: true, customerId: true, type: true, amountCents: true, entryDate: true, dueDate: true, voidedAt: true, reversesEntryId: true, allocationsRequired: true },
      });
      const allocations = await tx.writeOffAllocation.findMany({ select: { writeOffEntryId: true, chargeEntryId: true, amountCents: true } });

      // 1. The database's own sum of what every customer owes, against the application's rules, for every customer.
      const sums = await tx.$queryRaw<Array<{ id: string; balance: bigint }>>`
        SELECT "customerId" AS id,
               COALESCE(SUM(CASE WHEN "type" IN ('PAYMENT', 'WRITE_OFF') THEN -"amountCents" ELSE "amountCents" END), 0)::bigint AS balance
        FROM "LedgerEntry" WHERE "voidedAt" IS NULL AND "entryDate" <= ${new Date(`${today}T00:00:00Z`)}::date GROUP BY "customerId"`;
      const sqlBalance = new Map(sums.map((row) => [row.id, Number(row.balance)]));

      const allocationsOf = new Map<string, Array<{ chargeId: string; amountCents: number }>>();
      for (const a of allocations) {
        const list = allocationsOf.get(a.writeOffEntryId) ?? [];
        list.push({ chargeId: a.chargeEntryId, amountCents: a.amountCents });
        allocationsOf.set(a.writeOffEntryId, list);
      }
      const byCustomer = new Map<string, LedgerRecord[]>();
      for (const row of ledger) {
        if (row.voidedAt) continue;
        const record: LedgerRecord = {
          id: row.id, type: row.type as LedgerType, amountCents: row.amountCents, entryDate: dbDateToIso(row.entryDate) ?? "", dueDate: dbDateToIso(row.dueDate),
          voided: false, reverses: row.reversesEntryId, writeOffAllocations: allocationsOf.get(row.id) ?? [],
        };
        const list = byCustomer.get(row.customerId) ?? [];
        list.push(record);
        byCustomer.set(row.customerId, list);
      }
      const disagree: string[] = [];
      const broken: string[] = [];
      for (const [customerId, records] of byCustomer) {
        const aging = computeAging(records, today);
        const expected = sqlBalance.get(customerId) ?? 0;
        if (aging.balanceCents !== expected) disagree.push(`${customerId}: the application computes ${aging.balanceCents}, the database sums ${expected}`);
        const open = Object.values(aging.buckets).reduce((sum, n) => sum + n, 0);
        if (open !== Math.max(0, aging.balanceCents) || aging.creditCents !== Math.max(0, -aging.balanceCents)) {
          broken.push(`${customerId}: open ${open} and credit ${aging.creditCents} do not add up to a balance of ${aging.balanceCents}`);
        }
      }
      cap(findings, "balance_matches_database_sum", disagree, "customers");
      cap(findings, "open_items_add_up_to_balance", broken, "customers");

      // 2. Write-off allocations, from the raw rows.
      const byId = new Map(ledger.map((row) => [row.id, row]));
      const reversedIds = new Set(ledger.filter((row) => row.reversesEntryId && !row.voidedAt).map((row) => row.reversesEntryId));
      const liveWriteOff = (id: string) => {
        const row = byId.get(id);
        return !!row && row.type === "WRITE_OFF" && !row.voidedAt && !reversedIds.has(id);
      };
      const unallocated: string[] = [];
      for (const row of ledger) {
        if (row.type !== "WRITE_OFF" || row.voidedAt || !row.allocationsRequired || reversedIds.has(row.id)) continue;
        const total = (allocationsOf.get(row.id) ?? []).reduce((sum, a) => sum + a.amountCents, 0);
        if (total !== row.amountCents) unallocated.push(`write-off ${row.id}: ${total} of ${row.amountCents} allocated to charges`);
      }
      cap(findings, "write_offs_allocated_in_full", unallocated, "write-offs");
      const writtenOff = new Map<string, number>();
      const pointless: string[] = [];
      for (const a of allocations) {
        if (!liveWriteOff(a.writeOffEntryId)) continue;
        writtenOff.set(a.chargeEntryId, (writtenOff.get(a.chargeEntryId) ?? 0) + a.amountCents);
        const charge = byId.get(a.chargeEntryId);
        if (!charge || charge.voidedAt) pointless.push(`allocation of ${a.amountCents} from write-off ${a.writeOffEntryId} points at a charge that is gone (${a.chargeEntryId})`);
        else if (charge.customerId !== byId.get(a.writeOffEntryId)!.customerId) pointless.push(`write-off ${a.writeOffEntryId} covers another customer's charge ${a.chargeEntryId}`);
      }
      cap(findings, "allocations_point_at_live_charges", pointless, "allocations");
      const over: string[] = [];
      for (const [chargeId, cents] of writtenOff) {
        const charge = byId.get(chargeId);
        if (charge && cents > charge.amountCents) over.push(`charge ${chargeId} of ${charge.amountCents} is written off for ${cents}`);
      }
      cap(findings, "no_charge_written_off_for_more_than_it_is", over, "charges");

      // 3. Reversals: each offsets exactly the entry it names, for the same customer, never before it.
      const badReversal: string[] = [];
      for (const row of ledger) {
        if (row.type !== "REVERSAL") continue;
        const target = row.reversesEntryId ? byId.get(row.reversesEntryId) : undefined;
        if (!target) badReversal.push(`reversal ${row.id} names an entry that does not exist`);
        else if (target.customerId !== row.customerId) badReversal.push(`reversal ${row.id} names another customer's entry`);
        else if (row.amountCents !== -effectOnBalance(target.type as LedgerType, target.amountCents)) badReversal.push(`reversal ${row.id} (${row.amountCents}) does not offset ${target.id} (${target.type} ${target.amountCents}) exactly`);
        else if ((dbDateToIso(row.entryDate) ?? "") < (dbDateToIso(target.entryDate) ?? "")) badReversal.push(`reversal ${row.id} is dated before the entry it reverses`);
        else if (target.voidedAt) badReversal.push(`reversal ${row.id} names an entry that was voided (an entry is reversed or voided, never both)`);
      }
      cap(findings, "reversals_offset_exactly", badReversal, "reversals");

      // 4. Bounds the application enforces on the way in: a row outside them did not come in through it.
      const limit = addDays(today, MAX_POSTDATE_DAYS);
      const outOfBounds = ledger
        .filter((row) => Math.abs(row.amountCents) > MAX_AMOUNT_CENTS || (dbDateToIso(row.entryDate) ?? "") > limit)
        .map((row) => `${row.id}: ${row.type} ${row.amountCents} dated ${dbDateToIso(row.entryDate)}`);
      cap(findings, "entries_within_the_limits_the_app_enforces", outOfBounds, "entries");

      // 5. The history agrees with the ledger: every entry has a history line, and the amount in it is the amount on the entry.
      const events = await tx.$queryRaw<Array<{ ledgerEntryId: string; action: string; summary: string }>>`
        SELECT "ledgerEntryId", "action", "summary" FROM "AuditEvent" WHERE "ledgerEntryId" IS NOT NULL AND "action" LIKE 'ledger.%'`;
      const history = new Map<string, Array<{ action: string; summary: string }>>();
      for (const event of events) {
        const list = history.get(event.ledgerEntryId) ?? [];
        list.push(event);
        history.set(event.ledgerEntryId, list);
      }
      const unrecorded: string[] = [];
      const tampered: string[] = [];
      let crossChecked = 0;
      for (const row of ledger) {
        const lines = history.get(row.id);
        if (!lines) {
          unrecorded.push(`${row.id}: ${row.type} ${row.amountCents} has no history line (written outside the application?)`);
          continue;
        }
        const created = lines.find((line) => CREATED_ACTION[line.action] === row.type);
        const read = created ? amountInSummary(created.summary) : null;
        if (read === null) continue;
        crossChecked += 1;
        // A reversal's history line states the amount of the entry it reverses (not its own, which is the opposite).
        const subject = row.type === "REVERSAL" && row.reversesEntryId ? byId.get(row.reversesEntryId) : row;
        if (!subject) continue;
        const signed = subject.type === "ADJUSTMENT" ? subject.amountCents : Math.abs(subject.amountCents);
        if (read !== signed) tampered.push(`${row.id}: the ledger says ${signed}, the history line recorded when it was entered says ${read}`);
      }
      cap(findings, "every_entry_has_a_history_line", unrecorded, "entries");
      cap(findings, "ledger_amount_equals_amount_in_history", tampered, "entries");

      // 6. The database's own safeguards are present and switched on.
      const triggers = await tx.$queryRaw<Array<{ tbl: string; name: string; enabled: string }>>`
        SELECT c.relname AS tbl, t.tgname AS name, t.tgenabled::text AS enabled
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND NOT t.tgisinternal`;
      const have = new Map(triggers.map((t) => [`${t.tbl}.${t.name}`, t.enabled]));
      for (const name of EXPECTED_TRIGGERS) {
        if (!have.has(name)) findings.push({ check: "database_safeguards_present", detail: `trigger ${name} does not exist` });
        else if (have.get(name) !== "O") findings.push({ check: "database_safeguards_present", detail: `trigger ${name} is switched off (state ${have.get(name)})` });
      }

      return { today, customers, entries: ledger.length, amountsCrossChecked: crossChecked, findings };
    },
    { isolationLevel: "RepeatableRead", timeout: 600_000, maxWait: 30_000 },
  );
}
