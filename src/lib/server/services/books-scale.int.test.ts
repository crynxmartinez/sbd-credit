import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, test } from "vitest";
import { buildDashboard } from "@/lib/domain/dashboard";
import { prisma } from "@/lib/server/db";
import { reconcileBooks } from "@/lib/server/reconcile";
import { businessToday } from "../as-of";
import { customersCsv, ledgerCsv } from "./exports";
import { getDetail, listSummaries } from "./customers";

/**
 * The books at the size they will reach, not the size of a test: thousands of customers and a couple of hundred thousand ledger rows,
 * generated in the database (so the rows are the database's own, not the application's idea of them). Figures are reconciled across
 * the whole table by SQL and compared with the application's; the screens' computations are timed; and the schema is dumped with
 * pg_dump, restored into a clean database, and shown to hold the same rows, the same figures and the same append-only triggers.
 *
 * Off by default (it takes minutes): BOOKS_SCALE=1 npm run test:db -- books-scale
 * Sizes: BOOKS_SCALE_CUSTOMERS (default 3000), BOOKS_SCALE_ENTRIES (default 60 per customer).
 */
const ENABLED = process.env.BOOKS_SCALE === "1";
const CUSTOMERS = Number(process.env.BOOKS_SCALE_CUSTOMERS ?? 3000);
const ENTRIES = Number(process.env.BOOKS_SCALE_ENTRIES ?? 60);
const TODAY = businessToday();
const report: Record<string, unknown> = { customers: CUSTOMERS, entriesPerCustomer: ENTRIES, today: TODAY };

const seconds = (since: number) => Math.round((Date.now() - since) / 10) / 100;
const url = () => new URL(process.env.DATABASE_URL!);
const schemaName = () => url().searchParams.get("schema")!;
const plainUrl = (database?: string) => {
  const u = url();
  u.searchParams.delete("schema");
  if (database) u.pathname = `/${database}`;
  return u.toString();
};

async function generate(): Promise<void> {
  const schema = schemaName();
  // Everything below is deterministic: the same sizes always give the same books. h(...) is a stable pseudo-random number.
  const h = (expr: string) => `(abs(hashtext(${expr})) % 1000000)`;
  await prisma.$executeRawUnsafe(`
    INSERT INTO "${schema}"."Customer" ("id", "businessName", "status", "dateApplied", "statusChangedOn", "creditLimitCents", "paymentTerms", "version", "updatedAt")
    SELECT 'sc' || lpad(i::text, 7, '0'), 'Scale Co ' || i,
           CASE WHEN ${h("'s' || i")} % 20 = 0 THEN 'suspended' ELSE 'approved' END,
           DATE '2026-01-01', DATE '2026-01-01', 5000000 + (${h("'l' || i")} % 50) * 100000,
           (ARRAY['Net 15','Net 30','Net 30','Net 45','Net 60'])[1 + ${h("'t' || i")} % 5], 1, now()
    FROM generate_series(1, ${CUSTOMERS}) AS i`);

  // Charges, payments, adjustments and write-offs (written off the way older data was: no allocations), spread over the last 150 days.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "${schema}"."LedgerEntry" ("id", "customerId", "type", "amountCents", "entryDate", "dueDate", "reference", "note", "createdBy")
    SELECT 'sl' || c."id" || '-' || lpad(g::text, 4, '0'), c."id", t.type,
           CASE t.type WHEN 'ADJUSTMENT' THEN (CASE WHEN ${h("c.\"id\" || 'z' || g")} % 2 = 0 THEN 1 ELSE -1 END) * (100 + ${h("c.\"id\" || 'a' || g")} % 50000)
                       ELSE 100 + ${h("c.\"id\" || 'a' || g")} % 2500000 END,
           (CURRENT_DATE - (${h("c.\"id\" || 'd' || g")} % 150))::date,
           CASE WHEN t.type IN ('CHARGE','ADJUSTMENT') THEN (CURRENT_DATE - (${h("c.\"id\" || 'd' || g")} % 150) + (ARRAY[15,30,30,45,60])[1 + ${h("c.\"id\" || 'u' || g")} % 5])::date END,
           CASE WHEN t.type IN ('CHARGE','PAYMENT') THEN 'REF-' || g END,
           CASE WHEN t.type IN ('WRITE_OFF','ADJUSTMENT') THEN 'scale ' || lower(t.type) END,
           'Scale Generator'
    FROM "${schema}"."Customer" c
    CROSS JOIN generate_series(1, ${ENTRIES}) AS g
    CROSS JOIN LATERAL (SELECT CASE
        WHEN ${h("c.\"id\" || 'y' || g")} % 100 < 52 THEN 'CHARGE'
        WHEN ${h("c.\"id\" || 'y' || g")} % 100 < 90 THEN 'PAYMENT'
        WHEN ${h("c.\"id\" || 'y' || g")} % 100 < 96 THEN 'ADJUSTMENT'
        ELSE 'WRITE_OFF' END AS type) t`);

  // A reversal of roughly one charge in forty, dated the day after it.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "${schema}"."LedgerEntry" ("id", "customerId", "type", "amountCents", "entryDate", "note", "createdBy", "reversesEntryId")
    SELECT 'sr' || e."id", e."customerId", 'REVERSAL', -e."amountCents", LEAST(e."entryDate" + 1, CURRENT_DATE), 'scale reversal', 'Scale Generator', e."id"
    FROM "${schema}"."LedgerEntry" e WHERE e."type" = 'CHARGE' AND ${h("e.\"id\"")} % 40 = 0`);

  // A few entries voided (never a reversed or reversing one).
  await prisma.$executeRawUnsafe(`
    UPDATE "${schema}"."LedgerEntry" e SET "voidedAt" = now(), "voidedBy" = 'Scale Generator', "voidReason" = 'scale typo'
    WHERE e."type" IN ('CHARGE','PAYMENT') AND ${h("e.\"id\" || 'v'")} % 33 = 0
      AND NOT EXISTS (SELECT 1 FROM "${schema}"."LedgerEntry" r WHERE r."reversesEntryId" = e."id")`);

  // The history: one event per entry.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "${schema}"."AuditEvent" ("id", "customerId", "action", "summary", "actor", "ledgerEntryId")
    SELECT 'sa' || e."id", e."customerId", 'ledger.' || lower(e."type"),
           'Scale entry — ' || CASE WHEN e."type" = 'ADJUSTMENT' THEN (CASE WHEN e."amountCents" < 0 THEN '−' ELSE '+' END) ELSE '' END
             || '$' || to_char(CASE WHEN e."type" = 'REVERSAL' THEN (SELECT o."amountCents" FROM "${schema}"."LedgerEntry" o WHERE o."id" = e."reversesEntryId") ELSE abs(e."amountCents") END / 100.0, 'FM999,999,990.00'),
           'Scale Generator', e."id"
    FROM "${schema}"."LedgerEntry" e`);
}

/** What SQL says every customer owes today, with no help from the application. */
async function sqlBalances(client: pg.Client, schema: string): Promise<Map<string, number>> {
  const result = await client.query(
    `SELECT "customerId" AS id, COALESCE(SUM(CASE WHEN "type" IN ('PAYMENT','WRITE_OFF') THEN -"amountCents" ELSE "amountCents" END), 0)::bigint AS balance
     FROM "${schema}"."LedgerEntry" WHERE "voidedAt" IS NULL AND "entryDate" <= $1::date GROUP BY "customerId"`,
    [TODAY],
  );
  return new Map(result.rows.map((row: { id: string; balance: string }) => [row.id, Number(row.balance)]));
}

async function fingerprint(client: pg.Client, schema: string): Promise<Record<string, string | number>> {
  const out: Record<string, string | number> = {};
  for (const table of ["Customer", "LedgerEntry", "AuditEvent", "WriteOffAllocation"]) {
    const r = await client.query(`SELECT count(*)::int AS n, COALESCE(md5(string_agg(t::text, '|' ORDER BY t."id")), '') AS sum FROM "${schema}"."${table}" t`);
    out[`${table}.count`] = r.rows[0].n;
    out[`${table}.md5`] = r.rows[0].sum;
  }
  const balances = [...(await sqlBalances(client, schema)).entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  out["balances.md5"] = (await client.query(`SELECT md5($1::text) AS m`, [balances.map(([id, b]) => `${id}:${b}`).join(",")])).rows[0].m;
  return out;
}

describe.skipIf(!ENABLED)("the books at scale", () => {
  test("generate, reconcile every customer by SQL, time the screens, dump and restore", async () => {
    const schema = schemaName();
    let started = Date.now();
    await generate();
    report["generateSeconds"] = seconds(started);

    const direct = new pg.Client({ connectionString: plainUrl() });
    await direct.connect();
    try {
      const counts = await direct.query(`SELECT (SELECT count(*)::int FROM "${schema}"."Customer") AS customers, (SELECT count(*)::int FROM "${schema}"."LedgerEntry") AS entries, (SELECT count(*)::int FROM "${schema}"."AuditEvent") AS audit`);
      report["rows"] = counts.rows[0];
      expect(counts.rows[0].customers).toBe(CUSTOMERS);
      expect(counts.rows[0].entries).toBeGreaterThanOrEqual(CUSTOMERS * ENTRIES);

      // 1. The list the staff see, timed, and reconciled against SQL for EVERY customer.
      started = Date.now();
      const summaries = await listSummaries(TODAY);
      report["listSeconds"] = seconds(started);
      expect(summaries).toHaveLength(CUSTOMERS);
      const sql = await sqlBalances(direct, schema);
      const wrong = summaries.filter((s) => s.balanceCents !== (sql.get(s.id) ?? 0)).map((s) => s.id);
      expect(wrong, `customers whose balance disagrees with SQL (first 5): ${wrong.slice(0, 5).join(", ")}`).toEqual([]);
      // Conservation for every customer: what is open adds up to what is owed, and the rest is credit.
      const broken = summaries.filter((s) => {
        const open = Object.values(s.buckets).reduce((sum, n) => sum + n, 0);
        return open !== Math.max(0, s.balanceCents) || s.creditCents !== Math.max(0, -s.balanceCents);
      });
      expect(broken.map((s) => s.id).slice(0, 5)).toEqual([]);

      // 1b. The nightly reconciliation over the whole table: it must pass, and it must be fast enough to run every night.
      started = Date.now();
      const reconciliation = await reconcileBooks(prisma, TODAY);
      report["reconcileSeconds"] = seconds(started);
      report["reconcileCrossChecked"] = reconciliation.amountsCrossChecked;
      expect(reconciliation.findings.slice(0, 5)).toEqual([]);
      expect(reconciliation.amountsCrossChecked).toBe(counts.rows[0].entries);

      // 2. The dashboard, and the CSV exports, on the same books.
      started = Date.now();
      const dashboard = buildDashboard(summaries, TODAY);
      report["dashboardSeconds"] = seconds(started);
      expect(dashboard.stats.totalOutstandingCents).toBe(Object.values(dashboard.aging).reduce((sum, n) => sum + n, 0));
      expect(dashboard.stats.totalOutstandingCents).toBe(summaries.reduce((sum, s) => sum + Math.max(0, s.balanceCents), 0));
      started = Date.now();
      const customerCsv = await customersCsv(TODAY);
      report["customersCsvSeconds"] = seconds(started);
      expect(customerCsv.split("\r\n").filter(Boolean)).toHaveLength(CUSTOMERS + 1);
      started = Date.now();
      let bytes = 0;
      let rows = 0;
      const csv = await ledgerCsv(TODAY);
      bytes = Buffer.byteLength(csv);
      rows = csv.split("\r\n").filter(Boolean).length - 1;
      report["ledgerCsvSeconds"] = seconds(started);
      report["ledgerCsvMegabytes"] = Math.round(bytes / 10_485.76) / 100;
      expect(rows).toBe(counts.rows[0].entries);

      // 3. The heaviest customer's page.
      const heaviest = await direct.query(`SELECT "customerId" AS id FROM "${schema}"."LedgerEntry" GROUP BY "customerId" ORDER BY count(*) DESC, "customerId" LIMIT 1`);
      started = Date.now();
      const detail = await getDetail(heaviest.rows[0].id, TODAY);
      report["detailSeconds"] = seconds(started);
      expect(detail.customer.balanceCents).toBe(sql.get(heaviest.rows[0].id) ?? 0);

      // 4. Dump, restore into a clean database, and compare.
      const before = await fingerprint(direct, schema);
      const dump = spawnSync("pg_dump", ["--version"], { encoding: "utf8" });
      if (dump.status !== 0) {
        report["restore"] = "skipped: pg_dump is not installed here (CI runs it)";
      } else {
        const dir = join(tmpdir(), "books-scale");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "books.dump");
        started = Date.now();
        const dumped = spawnSync("pg_dump", ["-Fc", "-n", schema, "-f", file, plainUrl()], { encoding: "utf8" });
        expect(dumped.status, dumped.stderr).toBe(0);
        report["dumpSeconds"] = seconds(started);

        const restoreDb = "books_restore";
        await direct.query(`DROP DATABASE IF EXISTS ${restoreDb}`);
        await direct.query(`CREATE DATABASE ${restoreDb}`);
        started = Date.now();
        const restored = spawnSync("pg_restore", ["--exit-on-error", "-d", plainUrl(restoreDb), file], { encoding: "utf8" });
        expect(restored.status, restored.stderr).toBe(0);
        report["restoreSeconds"] = seconds(started);

        const copy = new pg.Client({ connectionString: plainUrl(restoreDb) });
        await copy.connect();
        try {
          const after = await fingerprint(copy, schema);
          expect(after, "the restored copy is the same rows and the same figures").toEqual(before);
          // The rules came with it: the triggers exist, are switched on, and still refuse to let history change.
          const triggers = await copy.query(
            `SELECT c.relname AS tbl, t.tgname, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND NOT t.tgisinternal`,
            [schema],
          );
          expect(triggers.rows.every((row: { tgenabled: string }) => row.tgenabled === "O")).toBe(true);
          expect(triggers.rows.map((row: { tbl: string; tgname: string }) => `${row.tbl}.${row.tgname}`)).toEqual(
            expect.arrayContaining(["LedgerEntry.LedgerEntry_no_delete", "LedgerEntry.LedgerEntry_void_only", "AuditEvent.AuditEvent_append_only", "WriteOffAllocation.WriteOffAllocation_append_only"]),
          );
          await expect(copy.query(`DELETE FROM "${schema}"."LedgerEntry" WHERE "id" = (SELECT min("id") FROM "${schema}"."LedgerEntry")`)).rejects.toThrow(/append-only/);
          await expect(copy.query(`UPDATE "${schema}"."LedgerEntry" SET "amountCents" = "amountCents" + 1 WHERE "id" = (SELECT min("id") FROM "${schema}"."LedgerEntry")`)).rejects.toThrow(/append-only/);
          const constraints = await copy.query(`SELECT count(*)::int AS n FROM pg_constraint co JOIN pg_namespace n ON n.oid = co.connamespace WHERE n.nspname = $1 AND co.contype = 'c'`, [schema]);
          report["checkConstraintsAfterRestore"] = constraints.rows[0].n;
          expect(constraints.rows[0].n).toBeGreaterThanOrEqual(15);
        } finally {
          await copy.end();
          await direct.query(`DROP DATABASE IF EXISTS ${restoreDb}`);
        }
      }
    } finally {
      await direct.end();
      mkdirSync("reports", { recursive: true });
      writeFileSync("reports/books-scale.json", JSON.stringify(report, null, 2));
    }

    // Budgets: generous, because shared CI machines are slow. They exist so a change that makes the books 10x slower is noticed.
    expect(report["listSeconds"] as number).toBeLessThan(30);
    expect(report["detailSeconds"] as number).toBeLessThan(10);
  }, 1_800_000);
});
