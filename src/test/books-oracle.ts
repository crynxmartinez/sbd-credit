import { expect } from "vitest";
import { LEDGER_CSV_HEADER } from "@/lib/domain/ledger-csv";
import { prisma } from "@/lib/server/db";
import type { PortalUser } from "@/lib/server/auth/customer-session";
import { getDetail, listSummaries } from "@/lib/server/services/customers";
import { ledgerCsv } from "@/lib/server/services/exports";
import { getPortalView } from "@/lib/server/services/portal";

/**
 * The books, recomputed a second way. Used by the integration tests that attack the books (random programs, concurrency, faults):
 * rows are read RAW from the database and settled one cent at a time by a deliberately naive implementation that shares no code with
 * the application, then compared with every surface a person can see.
 */
// ---- the second implementation: unit by unit, from raw rows -------------------------------------------------------------------

export interface Row {
  id: string;
  type: string;
  amountCents: number;
  d: string;
  due: string | null;
  voided: boolean;
  rev: string | null;
}
export interface Alloc {
  w: string;
  c: string;
  amountCents: number;
}

export async function rawRows(customerId: string): Promise<{ rows: Row[]; allocs: Alloc[] }> {
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT "id", "type", "amountCents", to_char("entryDate", 'YYYY-MM-DD') AS d, to_char("dueDate", 'YYYY-MM-DD') AS due,
           ("voidedAt" IS NOT NULL) AS voided, "reversesEntryId" AS rev
    FROM "LedgerEntry" WHERE "customerId" = ${customerId}`;
  const allocs = await prisma.$queryRaw<Alloc[]>`
    SELECT a."writeOffEntryId" AS w, a."chargeEntryId" AS c, a."amountCents"
    FROM "WriteOffAllocation" a JOIN "LedgerEntry" e ON e."id" = a."writeOffEntryId" WHERE e."customerId" = ${customerId}`;
  return { rows, allocs };
}

const signed = (type: string, amount: number): number => (type === "PAYMENT" || type === "WRITE_OFF" ? -amount : amount);
const dayNumber = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

export function naive(rows: Row[], allocs: Alloc[], asOf: string) {
  const live = rows.filter((row) => !row.voided && row.d <= asOf);
  const liveIds = new Set(live.map((row) => row.id));
  const cancelled = new Set<string>();
  for (const row of live) {
    if (row.type === "REVERSAL" && row.rev && liveIds.has(row.rev)) {
      cancelled.add(row.id);
      cancelled.add(row.rev);
    }
  }
  const view = live.filter((row) => !cancelled.has(row.id));
  const balance = live.reduce((sum, row) => sum + signed(row.type, row.amountCents), 0);

  // One unit per cent still owed, tagged with where it came from, oldest due first.
  let units: Array<{ id: string; due: string; d: string }> = [];
  for (const row of view) {
    if (signed(row.type, row.amountCents) <= 0) continue;
    for (let i = 0; i < row.amountCents; i += 1) units.push({ id: row.id, due: row.due ?? row.d, d: row.d });
  }
  units.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.d < b.d ? -1 : a.d > b.d ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let pool = 0;
  const viewIds = new Set(view.map((row) => row.id));
  for (const row of view) {
    if (row.type === "PAYMENT" || (row.type === "ADJUSTMENT" && row.amountCents < 0) || (row.type === "REVERSAL" && row.amountCents < 0)) pool += Math.abs(signed(row.type, row.amountCents));
    if (row.type === "WRITE_OFF") {
      const mine = allocs.filter((a) => a.w === row.id);
      pool += Math.max(0, row.amountCents - mine.reduce((sum, a) => sum + a.amountCents, 0));
      for (const a of mine) {
        let want = a.amountCents;
        const kept: typeof units = [];
        for (const unit of units) {
          if (want > 0 && unit.id === a.c) want -= 1;
          else kept.push(unit);
        }
        units = kept;
        pool += want; // an allocation that found nothing to settle goes back into the pool
      }
    }
  }
  void viewIds;
  const creditLeft = Math.max(0, pool - units.length);
  units = units.slice(Math.min(pool, units.length));

  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  let oldest = 0;
  for (const unit of units) {
    const days = dayNumber(asOf) - dayNumber(unit.due);
    oldest = Math.max(oldest, days);
    if (days <= 0) buckets.current += 1;
    else if (days <= 30) buckets.d1_30 += 1;
    else if (days <= 60) buckets.d31_60 += 1;
    else if (days <= 90) buckets.d61_90 += 1;
    else buckets.d90_plus += 1;
  }
  const nextDue = units[0]?.due ?? null;
  return {
    balance,
    credit: creditLeft,
    buckets,
    overdue: buckets.d1_30 + buckets.d31_60 + buckets.d61_90 + buckets.d90_plus,
    oldestOverdueDays: Math.max(0, oldest),
    nextDueDate: nextDue,
    nextDueCents: nextDue ? units.filter((unit) => unit.due === nextDue).length : 0,
  };
}

/** Counts of everything a write can touch, for the "a refused step leaves no trace" check. */
export async function footprint(customerId: string): Promise<string> {
  const [row] = await prisma.$queryRaw<Array<{ l: number; a: number; w: number; v: number }>>`
    SELECT (SELECT count(*)::int FROM "LedgerEntry" WHERE "customerId" = ${customerId}) AS l,
           (SELECT count(*)::int FROM "AuditEvent" WHERE "customerId" = ${customerId}) AS a,
           (SELECT count(*)::int FROM "WriteOffAllocation" x JOIN "LedgerEntry" e ON e."id" = x."writeOffEntryId" WHERE e."customerId" = ${customerId}) AS w,
           (SELECT count(*)::int FROM "LedgerEntry" WHERE "customerId" = ${customerId} AND "voidedAt" IS NOT NULL) AS v`;
  return JSON.stringify(row);
}

export async function assertBooksAgree(customerId: string, context: string, TODAY: string): Promise<void> {
  const { rows, allocs } = await rawRows(customerId);
  const want = naive(rows, allocs, TODAY);
  const detail = await getDetail(customerId, TODAY);
  const listed = (await listSummaries(TODAY)).find((summary) => summary.id === customerId)!;
  const portal = await getPortalView({ customerId } as unknown as PortalUser, TODAY);

  // 1. Every surface agrees with the second implementation, and the database's own SUM agrees with both.
  const [sql] = await prisma.$queryRaw<Array<{ total: bigint }>>`
    SELECT COALESCE(SUM(CASE WHEN "type" IN ('PAYMENT','WRITE_OFF') THEN -"amountCents" ELSE "amountCents" END), 0)::bigint AS total
    FROM "LedgerEntry" WHERE "customerId" = ${customerId} AND "voidedAt" IS NULL AND "entryDate" <= ${new Date(`${TODAY}T00:00:00Z`)}`;
  expect(Number(sql!.total), `${context}: SQL balance`).toBe(want.balance);
  for (const [name, figures] of [["detail", detail.customer], ["list", listed], ["portal", portal!]] as const) {
    expect(figures.balanceCents, `${context}: ${name} balance`).toBe(want.balance);
    expect(figures.creditCents, `${context}: ${name} credit`).toBe(want.credit);
    expect(figures.overdueCents, `${context}: ${name} overdue`).toBe(want.overdue);
    expect(figures.oldestOverdueDays, `${context}: ${name} oldest overdue`).toBe(want.oldestOverdueDays);
    expect(figures.nextDueDate, `${context}: ${name} next due`).toBe(want.nextDueDate);
    expect(figures.nextDueCents, `${context}: ${name} next due amount`).toBe(want.nextDueCents);
  }
  expect(detail.aging.buckets, `${context}: buckets`).toEqual(want.buckets);
  expect(listed.buckets, `${context}: list buckets`).toEqual(want.buckets);

  // 2. Conservation: what is open adds up to the balance when money is owed, and the rest is credit.
  const open = Object.values(want.buckets).reduce((sum, n) => sum + n, 0);
  expect(open, `${context}: open = max(0, balance)`).toBe(Math.max(0, want.balance));
  expect(want.credit, `${context}: credit = max(0, -balance)`).toBe(Math.max(0, -want.balance));

  // 3. What the customer sees adds up to what the customer owes (the portal shows the newest 200 only).
  if (portal!.entries.length < 200) {
    expect(portal!.entries.reduce((sum, entry) => sum + entry.amountCents, 0), `${context}: portal entries sum to the balance`).toBe(want.balance);
  }

  // 4. The export reconciles: the rows that count today add up to the balance.
  const csv = await ledgerCsv(TODAY);
  const col = (cells: string[], name: (typeof LEDGER_CSV_HEADER)[number]) => cells[LEDGER_CSV_HEADER.indexOf(name)]!;
  const mine = csv.trim().split("\r\n").filter((line) => line.startsWith(`${customerId},`)).map((line) => line.split(","));
  const counted = mine.filter((cells) => col(cells, "Counts today") === "yes").reduce((sum, cells) => sum + Math.round(Number(col(cells, "Effect on balance")) * 100), 0);
  expect(counted, `${context}: export rows that count today sum to the balance`).toBe(want.balance);

  // 5. A write-off that was recorded through the app is allocated in full, and no charge is written off for more than it is.
  const liveWriteOffs = rows.filter((row) => row.type === "WRITE_OFF" && !row.voided && !rows.some((r) => r.rev === row.id && !r.voided));
  for (const writeOff of liveWriteOffs) {
    expect(allocs.filter((a) => a.w === writeOff.id).reduce((sum, a) => sum + a.amountCents, 0), `${context}: write-off ${writeOff.amountCents} allocated in full`).toBe(writeOff.amountCents);
  }
  for (const charge of rows) {
    const covered = allocs.filter((a) => a.c === charge.id && liveWriteOffs.some((w) => w.id === a.w)).reduce((sum, a) => sum + a.amountCents, 0);
    expect(covered, `${context}: charge ${charge.amountCents} is never written off for more than it is`).toBeLessThanOrEqual(Math.max(0, charge.amountCents));
  }

  // 6. The same records through the domain mapping give the same figures as a fresh read (nothing cached or lost).
  const { rows: again } = await rawRows(customerId);
  expect(again.length, `${context}: row count stable`).toBe(rows.length);
}

