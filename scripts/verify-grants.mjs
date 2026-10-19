/**
 * Step D of docs/PRODUCTION.md, as a program: connects as the app's database login and checks that every promise the grants make
 * holds. Used by the CI "grants" job; also runnable by hand against a real server:
 *
 *   APP_DATABASE_URL="<app-url>" node scripts/verify-grants.mjs
 *
 * It only reads, and every "must be refused" statement is expected to fail (and is rolled back if it somehow does not).
 */
import pg from "pg";

const url = process.env.APP_DATABASE_URL;
if (!url) {
  console.error("APP_DATABASE_URL is not set.");
  process.exit(2);
}

const PERMISSION_DENIED = "42501";
const client = new pg.Client({ connectionString: url });
await client.connect();

const failures = [];
async function mustWork(label, sql) {
  try {
    await client.query(sql);
    console.log(`ok       ${label}`);
  } catch (error) {
    failures.push(`${label}: should work but failed (${error.message})`);
  }
}
async function mustBeRefused(label, sql) {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    failures.push(`${label}: should have been refused but WORKED`);
  } catch (error) {
    if (error.code === PERMISSION_DENIED) console.log(`ok       ${label}`);
    else failures.push(`${label}: refused for the wrong reason (${error.code}: ${error.message})`);
  } finally {
    await client.query("ROLLBACK");
  }
}

try {
  await mustWork("read customers", 'SELECT count(*) FROM "Customer"');
  await mustWork("read customer users (a missing grant here makes every sign-in fail)", 'SELECT count(*) FROM "CustomerUser"');
  await mustWork("read staff accounts", 'SELECT count(*) FROM "AppUser"');
  await mustWork("count a failed sign-in", `UPDATE "AppUser" SET "failedLogins" = "failedLogins" WHERE false`);
  await mustWork("update a customer", `UPDATE "Customer" SET "updatedAt" = "updatedAt" WHERE false`);
  await mustBeRefused("delete ledger rows", 'DELETE FROM "LedgerEntry"');
  await mustBeRefused("truncate the audit log", 'TRUNCATE "AuditEvent"');
  await mustBeRefused("update the audit log", `UPDATE "AuditEvent" SET "actor" = 'x'`);
  await mustBeRefused("update a write-off allocation", `UPDATE "WriteOffAllocation" SET "amountCents" = 1`);
  await mustBeRefused("change a staff role", `UPDATE "AppUser" SET "role" = 'SUPERADMIN'`);
  await mustBeRefused("create a staff account", `INSERT INTO "AppUser" ("id") VALUES ('x')`);
  await mustBeRefused("read the migration history", 'SELECT * FROM "_prisma_migrations"');
  await mustBeRefused("read the account-event log", 'SELECT * FROM "AccountEvent"');
  await mustBeRefused("run the allocation backfill", "SELECT credit.credit_backfill_write_off_allocations()");
  await mustBeRefused("create a table", "CREATE TABLE credit.x (id int)");

  const { rows } = await client.query(`
    SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb,
           (SELECT t.tableowner = current_user FROM pg_tables t WHERE t.schemaname = 'credit' AND t.tablename = 'LedgerEntry') AS owns
    FROM pg_roles r WHERE r.rolname = current_user`);
  const facts = rows[0];
  if (facts.rolsuper || facts.rolcreaterole || facts.rolcreatedb || facts.owns !== false) failures.push(`the login is too powerful: ${JSON.stringify(facts)}`);
  else console.log("ok       the login is not a superuser, cannot create roles or databases, and owns no tables");
} finally {
  await client.end();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} grant check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\nEvery grant check passed.");
