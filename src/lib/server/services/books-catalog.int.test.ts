import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * The claims about the database, checked against the database's own catalog (pg_catalog), not against the migration files: what is
 * actually installed, switched on, and configured in the schema the tests run in. If a migration, an owner or a restore ever leaves a
 * trigger missing or disabled, a constraint dropped, or a column that stores a balance, this is where it is found.
 */
let client: pg.Client;
let schema: string;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  schema = url.searchParams.get("schema")!;
  url.searchParams.delete("schema");
  client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
});
afterAll(() => client?.end());

const rows = async <T = Record<string, string>>(sql: string, params: unknown[] = []): Promise<T[]> => (await client.query(sql, params)).rows as T[];

describe("append-only: the triggers that make ledger and audit history permanent", () => {
  test("exactly these triggers exist, all switched on (a disabled trigger is a silent hole)", async () => {
    const triggers = await rows<{ tbl: string; name: string; enabled: string; fn: string; type: number }>(
      `SELECT c.relname AS tbl, t.tgname AS name, t.tgenabled AS enabled, p.proname AS fn, t.tgtype AS type
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY 1, 2`,
      [schema],
    );
    expect(triggers.map((t) => `${t.tbl}.${t.name} -> ${t.fn}`)).toEqual([
      "AccountEvent.AccountEvent_append_only -> credit_forbid_change",
      "AccountEvent.AccountEvent_no_truncate -> credit_forbid_change",
      "AuditEvent.AuditEvent_append_only -> credit_forbid_change",
      "AuditEvent.AuditEvent_no_truncate -> credit_forbid_change",
      "LedgerEntry.LedgerEntry_no_delete -> credit_forbid_change",
      "LedgerEntry.LedgerEntry_no_truncate -> credit_forbid_change",
      "LedgerEntry.LedgerEntry_void_only -> credit_ledger_void_only",
      "LedgerEntry.LedgerEntry_write_off_allocated -> credit_check_write_off_total",
      "WriteOffAllocation.WriteOffAllocation_append_only -> credit_forbid_change",
      "WriteOffAllocation.WriteOffAllocation_no_truncate -> credit_forbid_change",
      "WriteOffAllocation.WriteOffAllocation_rules -> credit_check_allocation_row",
      "WriteOffAllocation.WriteOffAllocation_total -> credit_check_write_off_total",
    ]);
    expect(triggers.filter((t) => t.enabled !== "O").map((t) => `${t.tbl}.${t.name} (${t.enabled})`), "triggers that are not enabled").toEqual([]);
  });

  test("the append-only triggers cover UPDATE, DELETE and TRUNCATE on every record table", async () => {
    // tgtype bits: 1 = row, 2 = before, 4 = insert, 8 = delete, 16 = update, 32 = truncate.
    const bits = await rows<{ tbl: string; name: string; type: number }>(
      `SELECT c.relname AS tbl, t.tgname AS name, t.tgtype AS type FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND NOT t.tgisinternal`,
      [schema],
    );
    const covered = (table: string, bit: number) => bits.some((t) => t.tbl === table && (t.type & bit) !== 0 && (t.type & 2) !== 0);
    for (const table of ["AuditEvent", "WriteOffAllocation", "AccountEvent"]) {
      expect(covered(table, 16), `${table}: UPDATE`).toBe(true);
      expect(covered(table, 8), `${table}: DELETE`).toBe(true);
      expect(covered(table, 32), `${table}: TRUNCATE`).toBe(true);
    }
    expect(covered("LedgerEntry", 16), "LedgerEntry: UPDATE (void only)").toBe(true);
    expect(covered("LedgerEntry", 8), "LedgerEntry: DELETE").toBe(true);
    expect(covered("LedgerEntry", 32), "LedgerEntry: TRUNCATE").toBe(true);
  });

  test("every trigger function reads only this schema: its search_path is pinned", async () => {
    const fns = await rows<{ name: string; config: string[] | null }>(
      `SELECT p.proname AS name, p.proconfig AS config FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname LIKE 'credit\\_%' ORDER BY 1`,
      [schema],
    );
    expect(fns.map((f) => f.name)).toEqual(["credit_backfill_write_off_allocations", "credit_check_allocation_row", "credit_check_write_off_total", "credit_forbid_change", "credit_ledger_void_only"]);
    for (const fn of fns) expect(fn.config?.some((setting) => setting.startsWith("search_path=")), `${fn.name} has a pinned search_path`).toBe(true);
  });

  test("the void-only trigger compares the WHOLE row, so a column added later is frozen by default", async () => {
    const [fn] = await rows<{ src: string }>(`SELECT p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = 'credit_ledger_void_only'`, [schema]);
    expect(fn!.src).toContain("to_jsonb(NEW)");
    expect(fn!.src).toContain("to_jsonb(OLD)");
  });
});

describe("the books: what is stored and what is not", () => {
  test("no balance, total or running figure is stored anywhere: the balance is always the sum of the ledger", async () => {
    const stored = await rows<{ tbl: string; col: string }>(
      `SELECT table_name AS tbl, column_name AS col FROM information_schema.columns WHERE table_schema = $1 AND column_name ~* '(balance|total|running|outstanding|overdue)'`,
      [schema],
    );
    expect(stored).toEqual([]);
  });

  test("money is whole cents in a 32-bit integer and is never a float or a decimal; dates are dates; moments carry their time zone", async () => {
    const cols = await rows<{ tbl: string; col: string; type: string }>(
      `SELECT table_name AS tbl, column_name AS col, data_type AS type FROM information_schema.columns WHERE table_schema = $1 AND table_name <> '_prisma_migrations'`,
      [schema],
    );
    for (const c of cols) {
      if (/Cents$/.test(c.col)) expect(c.type, `${c.tbl}.${c.col}`).toBe("integer");
      expect(c.type, `${c.tbl}.${c.col} must not be a float or decimal`).not.toMatch(/real|double|numeric|money/);
      if (/At$|^createdAt$|^updatedAt$/.test(c.col) && c.col !== "statusChangedOn") expect(c.type, `${c.tbl}.${c.col}`).toBe("timestamp with time zone");
      if (/Date$|^dateApplied$|^statusChangedOn$/.test(c.col)) expect(c.type, `${c.tbl}.${c.col}`).toBe("date");
    }
  });

  test("the rules the app relies on are CHECK constraints in the database, by name", async () => {
    const checks = (await rows<{ name: string }>(`SELECT co.conname AS name FROM pg_constraint co JOIN pg_namespace n ON n.oid = co.connamespace WHERE n.nspname = $1 AND co.contype = 'c'`, [schema])).map((c) => c.name);
    for (const name of [
      "LedgerEntry_amount_check", "LedgerEntry_type_check", "LedgerEntry_void_check", "LedgerEntry_reversal_check", "LedgerEntry_reason_check",
      "LedgerEntry_allocationsRequired_only_write_off", "WriteOffAllocation_amount_positive", "Customer_status_check", "Customer_credit_check",
      "Customer_requested_check", "Customer_paymentTerms_known", "AppUser_role_check", "AppUser_failed_check", "AppUser_username_format",
      "AppUser_sessionVersion_positive", "CustomerUser_sessionVersion_positive",
    ]) expect(checks, name).toContain(name);
  });

  test("a ledger entry can be reversed once and a request key used once: the unique indexes exist", async () => {
    const indexes = (await rows<{ name: string }>(`SELECT indexname AS name FROM pg_indexes WHERE schemaname = $1`, [schema])).map((i) => i.name);
    for (const name of ["LedgerEntry_reversesEntryId_key", "LedgerEntry_customerId_requestKey_key", "Customer_requestKey_key", "WriteOffAllocation_writeOffEntryId_chargeEntryId_key", "AppUser_username_key"]) {
      expect(indexes, name).toContain(name);
    }
  });

  test("nothing that holds money or history can be deleted by deleting the thing it points at: every such foreign key RESTRICTs", async () => {
    const fks = await rows<{ tbl: string; name: string; del: string }>(
      `SELECT c.relname AS tbl, co.conname AS name, co.confdeltype AS del FROM pg_constraint co JOIN pg_class c ON c.oid = co.conrelid JOIN pg_namespace n ON n.oid = co.connamespace
       WHERE n.nspname = $1 AND co.contype = 'f' AND c.relname IN ('LedgerEntry', 'AuditEvent', 'WriteOffAllocation') ORDER BY 1, 2`,
      [schema],
    );
    expect(fks.map((fk) => fk.tbl).sort()).toEqual(["AuditEvent", "AuditEvent", "LedgerEntry", "LedgerEntry", "WriteOffAllocation", "WriteOffAllocation"]);
    expect(fks.filter((fk) => fk.del !== "r").map((fk) => `${fk.tbl}.${fk.name} (${fk.del})`)).toEqual([]);
  });

  test("every table has a primary key", async () => {
    const without = await rows<{ tbl: string }>(
      `SELECT c.relname AS tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind = 'r' AND NOT EXISTS (SELECT 1 FROM pg_constraint co WHERE co.conrelid = c.oid AND co.contype = 'p')`,
      [schema],
    );
    expect(without).toEqual([]);
  });
});

describe("the database itself says so: history cannot be changed, even by the owner of the tables", () => {
  test("DELETE, TRUNCATE and a change to a recorded amount are refused by the database, not by the application", async () => {
    // A throwaway customer and entry, written directly: nothing in the application is involved.
    const id = `cat${Date.now()}`;
    await client.query(`INSERT INTO "${schema}"."Customer" ("id", "businessName", "status", "dateApplied", "statusChangedOn", "updatedAt") VALUES ($1, 'Catalog Co', 'approved', DATE '2026-01-01', DATE '2026-01-01', now())`, [id]);
    await client.query(`INSERT INTO "${schema}"."LedgerEntry" ("id", "customerId", "type", "amountCents", "entryDate", "createdBy") VALUES ($1, $1, 'CHARGE', 500, DATE '2026-01-01', 'catalog')`, [id]);
    await expect(client.query(`DELETE FROM "${schema}"."LedgerEntry" WHERE "id" = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(client.query(`UPDATE "${schema}"."LedgerEntry" SET "amountCents" = 1 WHERE "id" = $1`, [id])).rejects.toThrow(/append-only/);
    // (A plain TRUNCATE of a referenced table is refused by Postgres itself; CASCADE gets past that, and then the trigger refuses it.)
    await expect(client.query(`TRUNCATE "${schema}"."LedgerEntry"`)).rejects.toThrow(/append-only|cannot truncate/);
    await expect(client.query(`TRUNCATE "${schema}"."LedgerEntry" CASCADE`)).rejects.toThrow(/append-only/);
    await expect(client.query(`TRUNCATE "${schema}"."AuditEvent"`)).rejects.toThrow(/append-only/);
    // Voiding is the one change allowed, and only once.
    await client.query(`UPDATE "${schema}"."LedgerEntry" SET "voidedAt" = now(), "voidedBy" = 'x', "voidReason" = 'x' WHERE "id" = $1`, [id]);
    await expect(client.query(`UPDATE "${schema}"."LedgerEntry" SET "voidReason" = 'edited' WHERE "id" = $1`, [id])).rejects.toThrow(/voided ledger entry cannot be changed/);
  });
});
