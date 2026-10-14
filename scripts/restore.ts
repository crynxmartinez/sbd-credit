/**
 * Restore a JSON backup into an EMPTY schema.
 *
 *   npm run restore -- backups/credit-credit_dev-<timestamp>.json
 *
 * It refuses to run if the target already holds any customers, ledger entries, audit events or portal contacts: a restore adds history
 * back, it never merges with or overwrites live data. Everything is written in one transaction, so a failure part-way
 * leaves the schema exactly as empty as it started.
 *
 * Sign-in accounts are not restored (a backup holds no password hashes). Recreate them with `npm run user -- create`.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "../src/generated/prisma/client";
import { inBatches, reviveBackup } from "../src/lib/domain/backup";
import { adapterFor } from "../src/lib/server/db-url";

const BATCH_SIZE = 500;

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run restore -- <backup.json>");
  process.exit(2);
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set. Run this through `npm run restore`.");
const environment = process.env.NODE_ENV === "production" ? "production" : "development";
const prisma = new PrismaClient({ adapter: adapterFor(connectionString, environment) });

async function main(): Promise<void> {
  const backup = reviveBackup(JSON.parse(readFileSync(file as string, "utf8")));

  await prisma.$transaction(
    async (tx) => {
      const existing = (await tx.customer.count()) + (await tx.ledgerEntry.count()) + (await tx.auditEvent.count()) + (await tx.customerUser.count());
      if (existing > 0) {
        throw new Error("Refusing to restore: this schema is not empty. Restore only into a freshly created, empty schema.");
      }
      // Parents before children, so every foreign key already has something to point at.
      for (const batch of inBatches(backup.customers, BATCH_SIZE)) await tx.customer.createMany({ data: batch as never });
      // Contacts come back with no password, so they show as "invited" until an admin sends each a new link.
      for (const batch of inBatches(backup.portalContacts, BATCH_SIZE)) await tx.customerUser.createMany({ data: batch as never });
      for (const batch of inBatches(backup.ledger, BATCH_SIZE)) await tx.ledgerEntry.createMany({ data: batch as never });
      for (const batch of inBatches(backup.audit, BATCH_SIZE)) await tx.auditEvent.createMany({ data: batch as never });

      // Prove what went in matches what the file promised, still inside the transaction: a mismatch rolls it all back.
      const restored = {
        customers: await tx.customer.count(),
        ledger: await tx.ledgerEntry.count(),
        audit: await tx.auditEvent.count(),
        portalContacts: await tx.customerUser.count(),
      };
      for (const table of ["customers", "ledger", "audit", "portalContacts"] as const) {
        if (restored[table] !== backup.counts[table]) {
          throw new Error(`Restore check failed: ${table} has ${restored[table]} rows, the backup has ${backup.counts[table]}.`);
        }
      }
    },
    { timeout: 300_000, maxWait: 30_000 },
  );

  console.log(`restored from ${file}`);
  console.log(`  ${backup.counts.customers} customers, ${backup.counts.ledger} ledger entries, ${backup.counts.audit} audit events, ${backup.counts.portalContacts} customer contacts`);
  if (backup.counts.portalContacts > 0) console.log("  Customer contacts were restored without passwords: send each a new link from the customer screen.");
  console.log(`  ${backup.users.length} user(s) were listed but not restored (no password hashes in a backup): recreate them with npm run user.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
