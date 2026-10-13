/**
 * Run any command with DATABASE_URL pinned to the development schema.
 *
 *   npm run with-dev-db -- npx prisma migrate deploy
 *   npm run with-dev-db -- npx vitest run
 *
 * `npm run dev` goes through this too, so the app can never start against live data on this machine.
 */
import { spawn } from "node:child_process";
import { loadDevConfig } from "./lib/dev-db-env.mjs";
import { devUrl } from "./lib/dev-db-url.mjs";
import { joinCommand } from "./lib/shell.mjs";

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("usage: npm run with-dev-db -- <command ...>");
  process.exit(2);
}

const { raw, schema } = loadDevConfig();
console.log(`[with-dev-db] using schema "${schema}", not the live data`);

// The child (a dev server, a test run, a dependency's install script) gets the pinned dev address and nothing else:
// the raw server addresses from .env.databases are removed so no process in there can read the live URL.
const RAW_ADDRESS_KEYS = new Set(["LIVE_DATABASE_URL", "LIVE_DATABASE_URL_DIRECT", "TEST_DATABASE_URL"]);
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !RAW_ADDRESS_KEYS.has(key)));

const child = spawn(joinCommand(command), {
  stdio: "inherit",
  shell: true,
  env: { ...inherited, DATABASE_URL: devUrl(raw, schema) },
});
child.on("exit", (code) => process.exit(code ?? 1));
