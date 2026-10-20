import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { addDays } from "@/lib/domain/dates";
import { prisma } from "@/lib/server/db";
import { amountInSummary, EXPECTED_TRIGGERS, reconcileBooks } from "@/lib/server/reconcile";
import type { SessionUser } from "@/lib/types";
import type { CustomerCreateInput, LedgerEntryInput } from "@/lib/validation";
import { businessToday } from "../as-of";
import { createCustomer, decide } from "./customers";
import { recordEntry, reverseEntry, voidEntry } from "./ledger";

/**
 * "Would anyone notice?" The nightly check (src/lib/server/reconcile.ts) is shown two ways: it passes on books made through the
 * application, and it FINDS each kind of damage that only someone with the owner's keys could do (the database's own safeguards are
 * switched off for the corruption, as a rogue administrator could). A check that has never been seen to fail is not a check.
 */
const ADMIN: SessionUser = { id: "u-rec-admin", username: "rec-admin", name: "Reconcile Admin", role: "ADMIN" };
const TODAY = businessToday();
const clock = { today: () => TODAY, now: () => new Date() };

let owner: pg.Client;
let schema: string;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  schema = url.searchParams.get("schema")!;
  url.searchParams.delete("schema");
  owner = new pg.Client({ connectionString: url.toString() });
  await owner.connect();
});
afterAll(() => owner?.end());

const profile = (name: string): CustomerCreateInput => ({
  businessName: name, contactName: null, phone: null, email: null, billingAddress: null, dateApplied: "2026-10-01",
  requestedLimitCents: null, accountingAppName: null, accountingProjectUrl: null, notes: null,
});
const entry = (type: LedgerEntryInput["type"], amountCents: number, entryDate: string, extra: Partial<LedgerEntryInput> = {}): LedgerEntryInput => ({
  type, amountCents, entryDate, dueDate: null, reference: null, note: null, ...extra,
});

/** A customer with every kind of entry the application can make, all made through it. */
async function realBooks(): Promise<{ id: string; entries: string[] }> {
  const id = await createCustomer(profile(`Reconcile ${randomUUID().slice(0, 8)}`), ADMIN);
  await decide(id, { action: "approve", version: 1, creditLimitCents: 5_000_000, paymentTerms: "Net 30", creditStartDate: "2026-10-01" }, ADMIN);
  const a = await recordEntry(id, entry("CHARGE", 1_234_56, addDays(TODAY, -50), { reference: "INV-A" }), ADMIN, clock);
  const b = await recordEntry(id, entry("CHARGE", 800_00, addDays(TODAY, -5), { reference: "INV-B" }), ADMIN, clock);
  const p = await recordEntry(id, entry("PAYMENT", 300_00, addDays(TODAY, -3), { reference: "CHK-1" }), ADMIN, clock);
  const adj = await recordEntry(id, entry("ADJUSTMENT", -25_50, addDays(TODAY, -2), { note: "rebate" }), ADMIN, clock);
  const typo = await recordEntry(id, entry("CHARGE", 1_00, TODAY), ADMIN, clock);
  await voidEntry(id, typo.id, "typo", ADMIN, clock);
  const w = await recordEntry(id, entry("WRITE_OFF", 100_00, TODAY, { note: "uncollectable part" }), ADMIN, clock);
  const r = await reverseEntry(id, p.id, { reason: "check bounced" }, ADMIN, clock);
  return { id, entries: [a.id, b.id, p.id, adj.id, typo.id, w.id, r.id] };
}

const mentions = (report: Awaited<ReturnType<typeof reconcileBooks>>, ids: string[]) =>
  report.findings.filter((finding) => ids.some((id) => finding.detail.includes(id)));

/** Switches the database's own rules off for this connection (what an owner could do), runs the damage, and switches them back on. */
async function asRogueOwner(damage: () => Promise<unknown>): Promise<void> {
  await owner.query("SET session_replication_role = replica");
  try {
    await damage();
  } finally {
    await owner.query("SET session_replication_role = DEFAULT");
  }
}

describe("the nightly reconciliation", () => {
  test("passes on books made through the application, and really looked at them", async () => {
    const books = await realBooks();
    const report = await reconcileBooks(prisma, TODAY);
    expect(report.customers).toBeGreaterThan(0);
    expect(report.amountsCrossChecked).toBeGreaterThanOrEqual(books.entries.length);
    expect(mentions(report, [books.id, ...books.entries])).toEqual([]);
    expect(report.findings.filter((f) => f.check === "database_safeguards_present")).toEqual([]);
  });

  test("finds an entry that was written straight into the ledger, with no history line", async () => {
    const books = await realBooks();
    const id = `rogue${randomUUID().slice(0, 8)}`;
    await owner.query(`INSERT INTO "${schema}"."LedgerEntry" ("id", "customerId", "type", "amountCents", "entryDate", "createdBy") VALUES ($1, $2, 'PAYMENT', 99900, $3::date, 'rogue')`, [id, books.id, TODAY]);
    const found = mentions(await reconcileBooks(prisma, TODAY), [id]);
    expect(found.map((f) => f.check)).toContain("every_entry_has_a_history_line");
  });

  test("finds an amount that was changed after the fact: the history line written when it was entered no longer agrees", async () => {
    const books = await realBooks();
    const target = books.entries[0]!;
    await asRogueOwner(() => owner.query(`UPDATE "${schema}"."LedgerEntry" SET "amountCents" = "amountCents" - 100000 WHERE "id" = $1`, [target]));
    const found = mentions(await reconcileBooks(prisma, TODAY), [target]);
    expect(found.map((f) => f.check)).toContain("ledger_amount_equals_amount_in_history");
  });

  test("finds a write-off allocated to a charge for more than the charge was, and one not allocated in full", async () => {
    const books = await realBooks();
    const [, chargeB, , , , writeOff] = books.entries;
    await asRogueOwner(async () => {
      await owner.query(`INSERT INTO "${schema}"."WriteOffAllocation" ("id", "writeOffEntryId", "chargeEntryId", "amountCents") VALUES ($1, $2, $3, 900000)`, [`wax${randomUUID().slice(0, 8)}`, writeOff, chargeB]);
    });
    const found = mentions(await reconcileBooks(prisma, TODAY), [writeOff!, chargeB!]).map((f) => f.check);
    expect(found).toContain("no_charge_written_off_for_more_than_it_is");
    expect(found).toContain("write_offs_allocated_in_full");
  });

  test("finds a reversal that does not offset what it names", async () => {
    const books = await realBooks();
    const reversal = books.entries[6]!;
    await asRogueOwner(() => owner.query(`UPDATE "${schema}"."LedgerEntry" SET "amountCents" = 1 WHERE "id" = $1`, [reversal]));
    const found = mentions(await reconcileBooks(prisma, TODAY), [reversal]).map((f) => f.check);
    expect(found).toContain("reversals_offset_exactly");
  });

  test("finds an entry far outside the dates and amounts the application allows", async () => {
    const books = await realBooks();
    const id = `far${randomUUID().slice(0, 8)}`;
    await owner.query(`INSERT INTO "${schema}"."LedgerEntry" ("id", "customerId", "type", "amountCents", "entryDate", "createdBy") VALUES ($1, $2, 'CHARGE', 100, $3::date, 'rogue')`, [id, books.id, addDays(TODAY, 400)]);
    const found = mentions(await reconcileBooks(prisma, TODAY), [id]).map((f) => f.check);
    expect(found).toContain("entries_within_the_limits_the_app_enforces");
  });

  test("finds a safeguard that has been switched off, and reports it again once it is back", async () => {
    await owner.query(`ALTER TABLE "${schema}"."LedgerEntry" DISABLE TRIGGER "LedgerEntry_void_only"`);
    try {
      const off = (await reconcileBooks(prisma, TODAY)).findings.filter((f) => f.check === "database_safeguards_present");
      expect(off.map((f) => f.detail).join("|")).toContain("LedgerEntry.LedgerEntry_void_only is switched off");
    } finally {
      await owner.query(`ALTER TABLE "${schema}"."LedgerEntry" ENABLE TRIGGER "LedgerEntry_void_only"`);
    }
    expect((await reconcileBooks(prisma, TODAY)).findings.filter((f) => f.check === "database_safeguards_present")).toEqual([]);
  });

  test("the list of safeguards it expects is exactly the list the catalog test expects", async () => {
    const installed = await owner.query(
      `SELECT c.relname || '.' || t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY 1`,
      [schema],
    );
    expect(installed.rows.map((row: { name: string }) => row.name)).toEqual([...EXPECTED_TRIGGERS].sort());
  });
});

describe("reading an amount back out of a history line", () => {
  test.each([
    ["Payment received — $1,234.56 (CHK-9)", 123_456],
    ["Charge added — $0.05", 5],
    ["Adjustment — −$5.00 — rebate", -500],
    ["Adjustment — +$25.50", 2_550],
    ["Reversed payment of $300.00 — check bounced", 30_000],
    ["Written off — $100.00 — note — covers INV-A ($100.00)", 10_000],
    ["Application created", null],
  ])("%s", (summary, cents) => {
    expect(amountInSummary(summary)).toBe(cents);
  });
});
