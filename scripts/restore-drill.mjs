/**
 * A restore drill: proves a backup can actually be restored, instead of hoping.
 *
 *   npm run restore-drill                 uses the credit_dev schema as the source
 *   npm run restore-drill -- credit_test_e2e
 *
 * 1. takes a backup of the SOURCE schema,
 * 2. restores it into a throwaway schema (credit_test_restore) built from the migrations,
 * 3. backs that restored copy up again and compares it with the first, row by row,
 * 4. deletes the throwaway schema and both files (they hold customer details).
 *
 * It also restores an OLD-FORMAT copy (no allocations section, as backups from before write-offs named their charges) into a second
 * scratch schema, and checks that every balance is unchanged and every write-off in force ends up allocated to charges.
 *
 * It exits 0 only if the restored copy is identical (customers, ledger, audit, allocations, contacts, accounts). Run it after any change to
 * the schema, backup or restore code, and on a schedule. It works on credit_dev / credit_test* schemas only: for production,
 * see docs/PRODUCTION.md (a database-level dump restored into a scratch schema).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { joinCommand } from "./lib/shell.mjs";

const source = process.argv[2] ?? "credit_dev";
const SCRATCH = "credit_test_restore";
const SCRATCH_OLD = "credit_test_restore_old";
const fail = (message) => {
  console.error(`\n[restore-drill] FAILED: ${message}`);
  process.exit(1);
};

function run(label, args, schema, { capture = false } = {}) {
  console.log(`\n[restore-drill] ${label}`);
  const result = spawnSync(joinCommand(args), {
    shell: true,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    env: { ...process.env, CREDIT_DEV_SCHEMA: schema },
  });
  if (result.status !== 0) fail(`${label} did not succeed`);
  if (capture) process.stdout.write(result.stdout);
  return result.stdout ?? "";
}

const backupPath = (output) => {
  const match = /backup written: (\S+\.json)/.exec(output);
  if (!match) fail("could not find the backup file name in the backup output");
  return match[1];
};

const files = [];
try {
  const first = backupPath(run(`back up "${source}"`, ["node", "scripts/with-dev-db.mjs", "npx", "tsx", "scripts/backup.ts"], source, { capture: true }));
  files.push(first);

  run("reset the scratch schema", ["node", "scripts/dev-db.mjs", "reset"], SCRATCH);
  run("build the scratch schema from the migrations", ["node", "scripts/with-dev-db.mjs", "npx", "prisma", "migrate", "deploy"], SCRATCH);
  run("restore into it", ["node", "scripts/with-dev-db.mjs", "npx", "tsx", "scripts/restore.ts", first], SCRATCH);
  const second = backupPath(run("back the restored copy up again", ["node", "scripts/with-dev-db.mjs", "npx", "tsx", "scripts/backup.ts"], SCRATCH, { capture: true }));
  files.push(second);

  // The same backup as an OLDER version would have written it: no allocations section, and no flag on the ledger rows.
  const legacyFile = first.replace(/\.json$/, "-legacy.json");
  const original = JSON.parse(readFileSync(first, "utf8"));
  const old = structuredClone(original);
  delete old.writeOffAllocations;
  delete old.counts.writeOffAllocations;
  for (const row of old.ledger) delete row.allocationsRequired;
  writeFileSync(legacyFile, JSON.stringify(old));
  files.push(legacyFile);
  run("reset the second scratch schema", ["node", "scripts/dev-db.mjs", "reset"], SCRATCH_OLD);
  run("build it from the migrations", ["node", "scripts/with-dev-db.mjs", "npx", "prisma", "migrate", "deploy"], SCRATCH_OLD);
  run("restore the OLD-FORMAT copy into it", ["node", "scripts/with-dev-db.mjs", "npx", "tsx", "scripts/restore.ts", legacyFile], SCRATCH_OLD);
  const third = backupPath(run("back the old-format restore up", ["node", "scripts/with-dev-db.mjs", "npx", "tsx", "scripts/backup.ts"], SCRATCH_OLD, { capture: true }));
  files.push(third);

  const a = JSON.parse(readFileSync(first, "utf8"));
  const b = JSON.parse(readFileSync(second, "utf8"));
  const c = JSON.parse(readFileSync(third, "utf8"));
  const byId = (rows) => Object.fromEntries(rows.map((row) => [row.id, row]));
  const problems = [];

  for (const table of ["customers", "ledger", "audit", "writeOffAllocations"]) {
    if (JSON.stringify(byId(a[table] ?? [])) !== JSON.stringify(byId(b[table] ?? []))) problems.push(`${table} differ (${(a[table] ?? []).length} -> ${(b[table] ?? []).length} rows)`);
    else console.log(`  ${table.padEnd(19)} ${(a[table] ?? []).length} rows identical`);
  }
  // A restored contact comes back with its session version raised by one, on purpose: any cookie from before is dead.
  const contactsA = byId(a.portalContacts ?? []);
  const contactsB = byId(b.portalContacts ?? []);
  const contactsMatch =
    Object.keys(contactsA).length === Object.keys(contactsB).length &&
    Object.entries(contactsA).every(([id, row]) => contactsB[id] && JSON.stringify({ ...row, sessionVersion: 0 }) === JSON.stringify({ ...contactsB[id], sessionVersion: 0 }) && contactsB[id].sessionVersion >= Math.max(row.sessionVersion + 1, Math.floor(Date.parse(a.takenAt) / 1000)));
  if (!contactsMatch) problems.push("customer contacts differ");
  else console.log(`  contacts  ${Object.keys(contactsA).length} rows identical (session versions raised past anything they had reached)`);
  // Every staff session must end with a restore: the restored account's session version is exactly one higher.
  const usersA = byId(a.users ?? []);
  const usersB = byId(b.users ?? []);
  const sameAccount = (id, row) =>
    usersB[id] &&
    JSON.stringify({ ...row, sessionVersion: 0 }) === JSON.stringify({ ...usersB[id], sessionVersion: 0 }) &&
    usersB[id].sessionVersion >= Math.max(row.sessionVersion + 1, Math.floor(Date.parse(a.takenAt) / 1000));
  if (Object.keys(usersA).length !== Object.keys(usersB).length || !Object.entries(usersA).every(([id, row]) => sameAccount(id, row))) {
    problems.push("sign-in accounts differ, or a session version was not raised by one");
  } else console.log(`  accounts  ${Object.keys(usersA).length} rows identical (session versions raised past anything they had reached)`);

  const balances = (ledger) => {
    const totals = {};
    for (const row of ledger) {
      if (row.voidedAt) continue;
      const sign = row.type === "PAYMENT" || row.type === "WRITE_OFF" ? -1 : 1;
      totals[row.customerId] = (totals[row.customerId] ?? 0) + sign * row.amountCents;
    }
    return JSON.stringify(Object.entries(totals).sort());
  };
  if (balances(a.ledger) !== balances(b.ledger)) problems.push("a customer balance differs");
  else console.log("  every customer's balance identical");

  // The old-format restore: balances never change, and every write-off still in force is allocated to charges in full.
  if (balances(a.ledger) !== balances(c.ledger)) problems.push("a balance differs after restoring the old-format copy");
  const reversedIds = new Set(c.ledger.filter((row) => row.type === "REVERSAL" && !row.voidedAt && row.reversesEntryId).map((row) => row.reversesEntryId));
  const allocatedTo = {};
  for (const row of c.writeOffAllocations ?? []) allocatedTo[row.writeOffEntryId] = (allocatedTo[row.writeOffEntryId] ?? 0) + row.amountCents;
  const writeOffsInForce = c.ledger.filter((row) => row.type === "WRITE_OFF" && !row.voidedAt && !reversedIds.has(row.id));
  const unallocated = writeOffsInForce.filter((row) => allocatedTo[row.id] !== row.amountCents);
  if (unallocated.length > 0) problems.push(`${unallocated.length} write-off(s) in force were not allocated after restoring the old-format copy`);
  else console.log(`  old-format restore: balances identical, ${writeOffsInForce.length} write-off(s) in force all allocated`);
  if (JSON.stringify(a).includes("passwordHash") || JSON.stringify(b).includes("passwordHash")) problems.push("a backup file contains a password hash");

  if (problems.length > 0) fail(problems.join("; "));
  console.log("\n[restore-drill] PASSED: the backup restores to an identical copy.");
} finally {
  for (const file of files) rmSync(file, { force: true });
  for (const schema of [SCRATCH, SCRATCH_OLD]) {
    spawnSync(joinCommand(["node", "scripts/dev-db.mjs", "drop"]), { shell: true, stdio: "ignore", env: { ...process.env, CREDIT_DEV_SCHEMA: schema } });
  }
}
