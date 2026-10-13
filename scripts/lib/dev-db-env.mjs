import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { assertDevSchema } from "./dev-db-url.mjs";

const ENV_FILE = fileURLToPath(new URL("../../.env.databases", import.meta.url));

/** Reads .env.databases and returns the raw server address plus the dev schema name. */
export function loadDevConfig() {
  config({ path: ENV_FILE, quiet: true });

  // The direct address is the only one that is safe to pin a schema on.
  const raw = process.env.LIVE_DATABASE_URL_DIRECT || process.env.TEST_DATABASE_URL;
  if (!raw) {
    console.error("No database address found. Expected LIVE_DATABASE_URL_DIRECT in .env.databases.");
    process.exit(2);
  }

  const schema = assertDevSchema(process.env.CREDIT_DEV_SCHEMA || "credit_dev");
  return { raw, schema };
}
