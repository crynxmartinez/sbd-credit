/**
 * JSON backup of every customer, ledger entry and audit event, taken as ONE consistent snapshot.
 *
 *   npm run backup
 *
 * Writes backups/credit-<schema>-<timestamp>.json (git-ignored). Sign-in accounts are listed WITHOUT password hashes,
 * so the file never holds a credential. The file is written under a temporary name and renamed when complete, so a
 * crash can never leave a half-written backup that looks like a real one.
 *
 * This is the portable export. For production, also take a database-level backup (pg_dump -Fc -n credit): see docs/PRODUCTION.md.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";
import { BACKUP_FORMAT, type BackupFile } from "../src/lib/domain/backup";
import { adapterFor, schemaFromUrl } from "../src/lib/server/db-url";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set. Run this through `npm run backup`.");
const environment = process.env.NODE_ENV === "production" ? "production" : "development";
const prisma = new PrismaClient({ adapter: adapterFor(connectionString, environment) });

async function main(): Promise<void> {
  // One REPEATABLE READ transaction: every table is read from the same instant, so a payment recorded while the backup
  // runs cannot appear in the ledger section yet be missing from the audit section.
  const snapshot = await prisma.$transaction(
    async (tx) => {
      const customers = await tx.customer.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      const ledger = await tx.ledgerEntry.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      const audit = await tx.auditEvent.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      const users = await tx.appUser.findMany({
        select: { id: true, username: true, name: true, role: true, active: true },
        orderBy: { username: "asc" },
      });
      return { customers, ledger, audit, users };
    },
    { isolationLevel: "RepeatableRead", timeout: 120_000 },
  );

  const schema = schemaFromUrl(connectionString as string) ?? "unknown";
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    schema,
    takenAt: new Date().toISOString(),
    counts: { customers: snapshot.customers.length, ledger: snapshot.ledger.length, audit: snapshot.audit.length },
    customers: snapshot.customers,
    ledger: snapshot.ledger,
    audit: snapshot.audit,
    users: snapshot.users,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = "backups";
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, `credit-${schema}-${stamp}.json`);
  const partialPath = `${finalPath}.partial`;
  writeFileSync(partialPath, JSON.stringify(file, null, 2));
  renameSync(partialPath, finalPath);

  console.log(`backup written: ${finalPath}`);
  console.log(`  ${file.counts.customers} customers, ${file.counts.ledger} ledger entries, ${file.counts.audit} audit events, ${file.users.length} users (no password hashes)`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
