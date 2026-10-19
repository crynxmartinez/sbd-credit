/**
 * Restore a JSON backup into an EMPTY schema.
 *
 *   npm run restore -- backups/credit-credit_dev-<timestamp>.json
 *
 * It refuses to run if the target already holds any customers, ledger entries, audit events or portal contacts: a restore adds history
 * back, it never merges with or overwrites live data. Everything is written in one transaction, so a failure part-way
 * leaves the schema exactly as empty as it started.
 *
 * Sign-in accounts ARE restored, with their original ids (so every "created by" still points at someone) but WITHOUT a
 * password: a backup holds no hashes, so each gets a long random one that nobody knows. Set a real one for each person with
 * `npm run user -- reset-password <username>`. Their session version is raised by one, so every sign-in from before the
 * restore (staff and customers alike) ends by itself. Customer contacts likewise come back "invited": send each a new link.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";
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
      const existing =
        (await tx.customer.count()) + (await tx.ledgerEntry.count()) + (await tx.auditEvent.count()) + (await tx.customerUser.count()) + (await tx.appUser.count()) + (await tx.writeOffAllocation.count());
      if (existing > 0) {
        throw new Error("Refusing to restore: this schema is not empty. Restore only into a freshly created, empty schema.");
      }
      // Accounts first, with an unknowable password, so nobody can sign in until an administrator sets one.
      for (const user of backup.users) {
        await tx.appUser.create({ data: { ...user, passwordHash: await bcrypt.hash(randomBytes(24).toString("hex"), 4) } });
      }
      // Parents before children, so every foreign key already has something to point at.
      for (const batch of inBatches(backup.customers, BATCH_SIZE)) await tx.customer.createMany({ data: batch as never });
      // Contacts come back with no password, so they show as "invited" until an admin sends each a new link.
      for (const batch of inBatches(backup.portalContacts, BATCH_SIZE)) await tx.customerUser.createMany({ data: batch as never });
      for (const batch of inBatches(backup.ledger, BATCH_SIZE)) await tx.ledgerEntry.createMany({ data: batch as never });
      // Which charges each write-off covers. A backup from before allocations existed has no section: allocate its write-offs the
      // way the application would have (oldest-due charges first). One that has the section is put back exactly as it was.
      for (const batch of inBatches(backup.writeOffAllocations, BATCH_SIZE)) await tx.writeOffAllocation.createMany({ data: batch as never });
      if (!backup.allocationsIncluded) {
        const [done] = await tx.$queryRaw<{ allocated: number }[]>`SELECT credit_backfill_write_off_allocations() AS allocated`;
        // Anything it could not allocate stays an ordinary credit: balances are right, but say so, so it is not a surprise later.
        const [left] = await tx.$queryRaw<{ unallocated: number }[]>`
          SELECT count(*)::int AS unallocated FROM "LedgerEntry" w
          WHERE w."type" = 'WRITE_OFF' AND w."voidedAt" IS NULL
            AND NOT EXISTS (SELECT 1 FROM "LedgerEntry" r WHERE r."reversesEntryId" = w."id" AND r."voidedAt" IS NULL)
            AND NOT EXISTS (SELECT 1 FROM "WriteOffAllocation" a WHERE a."writeOffEntryId" = w."id")`;
        console.log(`  old-format backup: ${done?.allocated ?? 0} write-off(s) allocated to charges.`);
        if ((left?.unallocated ?? 0) > 0) console.log(`  ${left!.unallocated} write-off(s) could not be allocated and stay as ordinary credits (balances are unaffected).`);
      }
      for (const batch of inBatches(backup.audit, BATCH_SIZE)) await tx.auditEvent.createMany({ data: batch as never });

      // Prove what went in matches what the file promised, still inside the transaction: a mismatch rolls it all back.
      const restored = {
        customers: await tx.customer.count(),
        ledger: await tx.ledgerEntry.count(),
        audit: await tx.auditEvent.count(),
        portalContacts: await tx.customerUser.count(),
        writeOffAllocations: await tx.writeOffAllocation.count(),
      };
      const restoredUsers = await tx.appUser.count();
      if (restoredUsers !== backup.users.length) {
        throw new Error(`Restore check failed: ${restoredUsers} accounts, the backup has ${backup.users.length}.`);
      }
      // An older backup had none, so only a file that said it had allocations is held to its count.
      const checked = backup.allocationsIncluded ? (["customers", "ledger", "audit", "portalContacts", "writeOffAllocations"] as const) : (["customers", "ledger", "audit", "portalContacts"] as const);
      for (const table of checked) {
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
  console.log(`  ${backup.users.length} sign-in account(s) restored WITHOUT passwords: set each with npm run user -- reset-password <username>.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
