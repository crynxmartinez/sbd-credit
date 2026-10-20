/**
 * Checks the books against themselves (read-only). See src/lib/server/reconcile.ts for what is checked and why.
 *
 *   npm run reconcile            development schema
 *   npm run reconcile -- --json  machine-readable
 *
 * Exits 0 when every check passes and 1 when there is any finding, so it can run nightly and alert on a failure.
 * Against production, as the application's own login (it only reads):
 *   NODE_ENV=production DATABASE_URL="<app-url>" npx tsx scripts/reconcile.ts
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { dateInZone } from "../src/lib/domain/dates";
import { adapterFor } from "../src/lib/server/db-url";
import { reconcileBooks } from "../src/lib/server/reconcile";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set. Run this through `npm run reconcile`.");
const environment = process.env.NODE_ENV === "production" ? "production" : "development";
const prisma = new PrismaClient({ adapter: adapterFor(connectionString, environment) });
const json = process.argv.includes("--json");

async function main(): Promise<void> {
  const today = dateInZone(new Date(), process.env.BUSINESS_TIME_ZONE ?? "America/Chicago");
  const started = Date.now();
  const report = await reconcileBooks(prisma, today);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (json) {
    console.log(JSON.stringify({ ...report, seconds }, null, 2));
  } else {
    console.log(`Books as of ${report.today}: ${report.customers} customers, ${report.entries} ledger entries, ${report.amountsCrossChecked} amounts cross-checked against the history (${seconds}s).`);
    if (report.findings.length === 0) console.log("Every check passed.");
    for (const finding of report.findings) console.log(`  FINDING  ${finding.check}: ${finding.detail}`);
  }
  process.exitCode = report.findings.length === 0 ? 0 : 1;
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
