/**
 * Fails the build if a runtime dependency has a known high or critical problem, EXCEPT the Prisma command-line tool chain.
 * (The decision itself is in scripts/lib/audit-decision.mjs and is tested.)
 *
 * `prisma` (the migration tool, not code the running app executes) is an optional peer of @prisma/client, so `npm audit
 * --omit=dev` still reports it, together with what it pulls in. Those packages are allowed on purpose: each is reachable
 * only when an administrator runs a migration, and the fix is a Prisma upgrade (see docs/PRODUCTION.md). It also fails if
 * the audit itself could not run, so an unreachable registry never looks like a clean bill of health.
 */
import { spawnSync } from "node:child_process";
import { decideAudit } from "./lib/audit-decision.mjs";

const result = spawnSync("npm audit --omit=dev --json", { shell: true, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
let report = null;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error("[audit] could not read the audit report:", (result.stderr || result.stdout || "").slice(0, 500));
  process.exit(1);
}

const decision = decideAudit(report);
if (decision.tolerated.length) console.log(`[audit] known, documented (Prisma command-line tool only): ${decision.tolerated.join(", ")}`);
if (!decision.ok) {
  console.error(`[audit] FAILED: ${decision.reason}`);
  for (const item of decision.blocking) console.error(`[audit] ${item.severity}: ${item.name} (${item.range})`);
  process.exit(1);
}
console.log("[audit] no other high or critical problems in runtime dependencies");
