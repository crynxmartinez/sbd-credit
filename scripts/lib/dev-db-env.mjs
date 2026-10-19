import { parse } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertDevSchema } from "./dev-db-url.mjs";

const ENV_FILE = fileURLToPath(new URL("../../.env.databases", import.meta.url));

/** The environment variables that name a server address, best first. A restricted development role beats the live one. */
const ADDRESS_KEYS = ["DEV_DATABASE_URL_DIRECT", "LIVE_DATABASE_URL_DIRECT", "TEST_DATABASE_URL"];

/**
 * Picks the server address and the development schema from the environment and from the values read out of .env.databases.
 * The real environment wins over the file. Pure, so it can be tested.
 */
export function resolveDevConfig(env, fileValues) {
  const pick = (name) => env[name] || fileValues[name];
  for (const key of ADDRESS_KEYS) {
    const raw = pick(key);
    if (raw) return { raw, schema: assertDevSchema(pick("CREDIT_DEV_SCHEMA") || "credit_dev"), source: key };
  }
  return null;
}

/**
 * Reads .env.databases and returns the raw server address plus the dev schema name.
 *
 * The file is PARSED, not loaded into process.env: anything else a person keeps in it never reaches a child process (a dev
 * server, a test run, a dependency's install script). Only the one address this function returns is used, and with-dev-db
 * hands the child just the development address built from it.
 */
export function loadDevConfig(env = process.env) {
  const fileValues = existsSync(ENV_FILE) ? parse(readFileSync(ENV_FILE)) : {};
  const resolved = resolveDevConfig(env, fileValues);
  if (!resolved) {
    console.error("No database address found. Expected DEV_DATABASE_URL_DIRECT or LIVE_DATABASE_URL_DIRECT in .env.databases.");
    process.exit(2);
  }
  if (resolved.source === "LIVE_DATABASE_URL_DIRECT" && !env.CI) {
    console.error(
      "[dev-db] note: this uses the live server's own login. Ask for a restricted DEV_DATABASE_URL_DIRECT (a role that can reach only credit_dev* and credit_test* schemas) and put it in .env.databases; it is preferred automatically.",
    );
  }
  return { raw: resolved.raw, schema: resolved.schema };
}
