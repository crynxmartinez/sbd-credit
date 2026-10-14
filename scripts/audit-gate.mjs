/**
 * Fails the build if a runtime dependency has a known high or critical problem, EXCEPT the Prisma command-line tool chain.
 *
 * `prisma` (the migration tool, not code the running app executes) is an optional peer of @prisma/client, so `npm audit
 * --omit=dev` still reports it, together with what it pulls in. Those packages are listed here on purpose: each is
 * reachable only when an administrator runs a migration, and the fix is a Prisma upgrade (see docs/PRODUCTION.md).
 * Anything else, or a critical problem anywhere, still fails.
 */
import { spawnSync } from "node:child_process";

const PRISMA_TOOL_CHAIN = new Set(["prisma", "@prisma/config", "deepmerge-ts", "mysql2"]);

const result = spawnSync("npm audit --omit=dev --json", { shell: true, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error("[audit] could not read the audit report:", (result.stderr || result.stdout).slice(0, 500));
  process.exit(1);
}

const blocking = Object.entries(report.vulnerabilities ?? {}).filter(
  ([name, entry]) => ["high", "critical"].includes(entry.severity) && (entry.severity === "critical" || !PRISMA_TOOL_CHAIN.has(name)),
);
const tolerated = Object.keys(report.vulnerabilities ?? {}).filter((name) => PRISMA_TOOL_CHAIN.has(name));

if (tolerated.length) console.log(`[audit] known, documented (Prisma command-line tool only): ${tolerated.join(", ")}`);
if (blocking.length) {
  for (const [name, entry] of blocking) console.error(`[audit] ${entry.severity}: ${name} (${entry.range ?? "?"})`);
  process.exit(1);
}
console.log("[audit] no other high or critical problems in runtime dependencies");
