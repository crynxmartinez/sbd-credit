/**
 * Manage the development schema inside the shared database server.
 *
 *   npm run dev-db -- status   show whether the schema exists and which tables it holds
 *   npm run dev-db -- create   make the schema (safe to repeat)
 *   npm run dev-db -- reset    drop it and make it again (a clean slate)
 *   npm run dev-db -- drop     remove it
 *
 * Only schemas named credit_dev / credit_test* are ever touched. The live `public` tables are out of reach.
 */
import pg from "pg";
import { loadDevConfig } from "./lib/dev-db-env.mjs";
import { plainUrl } from "./lib/dev-db-url.mjs";

const MODES = ["status", "create", "reset", "drop"];
const mode = process.argv[2];
if (!MODES.includes(mode)) {
  console.error(`usage: npm run dev-db -- <${MODES.join("|")}>`);
  process.exit(2);
}

const { raw, schema } = loadDevConfig();
// The name passed the guard in loadDevConfig, so quoting it as an identifier is safe.
const identifier = `"${schema}"`;

async function withClient(work) {
  const client = new pg.Client({ connectionString: plainUrl(raw) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function status(client) {
  const exists = await client.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [schema]);
  if (exists.rowCount === 0) {
    console.log(`schema "${schema}": does not exist`);
    return;
  }
  const tables = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
    [schema],
  );
  console.log(`schema "${schema}": exists, ${tables.rowCount} table(s)`);
  for (const row of tables.rows) console.log(`  - ${row.table_name}`);
}

try {
  await withClient(async (client) => {
    if (mode === "reset" || mode === "drop") {
      await client.query(`DROP SCHEMA IF EXISTS ${identifier} CASCADE`);
      console.log(`dropped schema "${schema}"`);
    }
    if (mode === "create" || mode === "reset") {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${identifier}`);
      console.log(`created schema "${schema}"`);
    }
    await status(client);
  });
} catch (error) {
  // Print the reason only. Never echo the connection string.
  console.error(`dev-db ${mode} failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
}
