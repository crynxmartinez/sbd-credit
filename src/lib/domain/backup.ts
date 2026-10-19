/**
 * The shape of a backup file and the checks that make a restore trustworthy. Pure: no database, no files.
 *
 * JSON has no date type, so dates are written as strings and must be turned back into real dates on the way in.
 * Doing that by named column (not "anything that looks like a date") means free text such as a note or a business
 * name can never be mistaken for one.
 */
import { PAYMENT_TERMS } from "./constants";

export const BACKUP_FORMAT = 1;

const DATE_FIELDS = {
  customers: ["dateApplied", "statusChangedOn", "creditStartDate", "createdAt", "updatedAt"],
  ledger: ["entryDate", "dueDate", "createdAt", "voidedAt"],
  audit: ["createdAt"],
  portalContacts: ["lastLoginAt", "createdAt", "updatedAt"],
  writeOffAllocations: ["createdAt"],
} as const;

/**
 * The columns of a customer contact that a backup keeps. Passwords, failure counts and locks are never among them, so a
 * backup file holds no credential, and a restored contact comes back "invited": an admin sends a new link.
 */
const PORTAL_CONTACT_FIELDS = ["id", "customerId", "email", "name", "active", "sessionVersion", "lastLoginAt", "createdBy", "createdById", "createdAt", "updatedAt"] as const;

type Row = Record<string, unknown>;

export interface BackupFile {
  format: number;
  schema: string;
  takenAt: string;
  counts: { customers: number; ledger: number; audit: number; portalContacts: number; writeOffAllocations?: number; users?: number };
  customers: Row[];
  ledger: Row[];
  audit: Row[];
  /** People at a customer who could sign in to the customer portal. No password hashes and no invitation links. */
  portalContacts: Row[];
  /** Which charges each write-off covers. Backups from before allocations existed have none; see `allocationsIncluded`. */
  writeOffAllocations: Row[];
  /**
   * True when the file has an allocations section (even an empty one). False for an older backup: the write-offs in it were
   * never allocated, so a restore must allocate them (the database function does, using the same oldest-due-first rule).
   */
  allocationsIncluded: boolean;
  /** Who could sign in. Never includes password hashes, so a backup file is not a credential leak. */
  users: Array<{ id: string; username: string; name: string; role: string; active: boolean; sessionVersion: number }>;
}

function isRows(value: unknown): value is Row[] {
  return Array.isArray(value) && value.every((row) => typeof row === "object" && row !== null && !Array.isArray(row));
}

function reviveDates(rows: Row[], fields: readonly string[], table: string): Row[] {
  return rows.map((row, index) => {
    const revived: Row = { ...row };
    for (const field of fields) {
      const value = row[field];
      if (value === null || value === undefined) continue;
      if (typeof value !== "string") throw new Error(`${table}[${index}].${field} should be a date string`);
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new Error(`${table}[${index}].${field} is not a valid date: ${value}`);
      revived[field] = date;
    }
    return revived;
  });
}

/**
 * The session version a restored account gets. A cookie is valid only while the account's version equals the one in it, and
 * every sign-out adds one, so "one more than the backed-up version" may be a number a cookie ALREADY carries (the backup was
 * taken at 5, someone signed out and in again at 6, and the restored account would be at 6). A version drawn from the clock
 * is higher than any the account could have reached since, so no earlier cookie can match. (Seconds since 1970 fit the
 * column until 2038.)
 */
export function sessionVersionAfterRestore(previous: unknown, nowMs: number): number {
  const base = typeof previous === "number" && Number.isInteger(previous) ? previous : 1;
  return Math.max(base + 1, Math.floor(nowMs / 1000));
}

/**
 * Keeps only the whitelisted contact columns, restores their dates, and raises the session version by one, so a cookie
 * issued before the backup (when the version was lower or equal) can never be accepted by the restored account.
 */
function reviveContacts(rows: Row[], nowMs: number): Row[] {
  const dated = reviveDates(rows, DATE_FIELDS.portalContacts, "portalContacts");
  return dated.map((row) => {
    const kept = Object.fromEntries(PORTAL_CONTACT_FIELDS.filter((field) => field in row).map((field) => [field, row[field]]));
    return { ...kept, sessionVersion: sessionVersionAfterRestore(row.sessionVersion, nowMs) };
  });
}

const KNOWN_ROLES: ReadonlySet<unknown> = new Set(["EMPLOYEE", "ADMIN", "SUPERADMIN"]);

/** Only the columns a restored account needs, checked, so a damaged file cannot create an account that cannot be reasoned about. */
function reviveUsers(raw: unknown, nowMs: number): BackupFile["users"] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("The backup's users section is damaged.");
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const row = entry as Record<string, unknown>;
    if (typeof row?.id !== "string" || row.id === "") throw new Error(`users[${index}] has no id.`);
    if (typeof row.username !== "string" || row.username === "") throw new Error(`users[${index}] has no username.`);
    if (!KNOWN_ROLES.has(row.role)) throw new Error(`users[${index}] has an unknown role.`);
    if (seen.has(row.username)) throw new Error(`users[${index}] has the same username as an earlier account.`);
    seen.add(row.username);
    // One higher than the backed-up version, exactly as for customer contacts: a cookie issued before the restore carries the
    // old number and is refused, so a restore signs every staff member out.
    return { id: row.id, username: row.username, name: String(row.name ?? row.username), role: String(row.role), active: row.active === true, sessionVersion: sessionVersionAfterRestore(row.sessionVersion, nowMs) };
  });
}

/**
 * Validates a parsed backup and returns it with real Date objects. Throws a specific message on anything wrong, so a
 * damaged or truncated file is refused before a single row is written.
 */
export function reviveBackup(raw: unknown, nowMs: number = Date.now()): BackupFile {
  if (typeof raw !== "object" || raw === null) throw new Error("The backup file is not a JSON object.");
  const file = raw as Record<string, unknown>;
  if (file.format !== BACKUP_FORMAT) throw new Error(`Unsupported backup format ${String(file.format)} (expected ${BACKUP_FORMAT}).`);
  if (!isRows(file.customers) || !isRows(file.ledger) || !isRows(file.audit)) {
    throw new Error("The backup is missing customers, ledger or audit rows.");
  }

  // Older backups have no portal section: that means no contacts, not a damaged file.
  const rawContacts = file.portalContacts === undefined ? [] : file.portalContacts;
  if (!isRows(rawContacts)) throw new Error("The backup's portal contacts section is damaged.");

  // The same: an older backup simply has no allocations section.
  const rawAllocations = file.writeOffAllocations === undefined ? [] : file.writeOffAllocations;
  if (!isRows(rawAllocations)) throw new Error("The backup's write-off allocations section is damaged.");

  const counts = file.counts as Record<string, unknown> | undefined;
  const actual = { customers: file.customers.length, ledger: file.ledger.length, audit: file.audit.length, portalContacts: rawContacts.length };
  for (const table of ["customers", "ledger", "audit"] as const) {
    if (counts?.[table] !== actual[table]) {
      throw new Error(`The backup is incomplete: it says ${String(counts?.[table])} ${table} rows but contains ${actual[table]}.`);
    }
  }

  // Only checked when the file says it has contacts: older files simply did not count them.
  if (file.portalContacts !== undefined && counts?.portalContacts !== actual.portalContacts) {
    throw new Error(`The backup is incomplete: it says ${String(counts?.portalContacts)} portalContacts rows but contains ${actual.portalContacts}.`);
  }

  // Accounts are counted too, by files written since that was added: a missing or cut-short section is then caught, instead of
  // restoring fewer sign-ins and still exiting cleanly. (An older file has no such count and is not held to one.)
  if (counts?.users !== undefined) {
    const present = Array.isArray(file.users) ? file.users.length : 0;
    if (counts.users !== present) throw new Error(`The backup is incomplete: it says ${String(counts.users)} users but contains ${present}.`);
  }

  if (file.writeOffAllocations !== undefined && counts?.writeOffAllocations !== rawAllocations.length) {
    throw new Error(`The backup is incomplete: it says ${String(counts?.writeOffAllocations)} writeOffAllocations rows but contains ${rawAllocations.length}.`);
  }

  for (const [index, row] of file.customers.entries()) {
    // Not reachable through the app (the form offers a fixed list), so only a damaged or hand-edited file gets here: refuse it, rather
    // than let an unknown value quietly turn every due date into Net 30.
    if (row.paymentTerms !== undefined && !(PAYMENT_TERMS as readonly unknown[]).includes(row.paymentTerms)) {
      throw new Error(`customers[${index}].paymentTerms is not a known payment term: ${String(row.paymentTerms)}`);
    }
  }

  const customerIds = new Set(file.customers.map((row) => row.id));
  const ledgerIds = new Set(file.ledger.map((row) => row.id));
  for (const [index, row] of rawAllocations.entries()) {
    if (!ledgerIds.has(row.writeOffEntryId) || !ledgerIds.has(row.chargeEntryId)) {
      throw new Error(`writeOffAllocations[${index}] refers to a ledger entry that is not in the backup.`);
    }
  }
  for (const [index, row] of file.ledger.entries()) {
    if (!customerIds.has(row.customerId)) throw new Error(`ledger[${index}] belongs to a customer that is not in the backup.`);
  }
  const seenEmails = new Set<unknown>();
  for (const [index, row] of rawContacts.entries()) {
    if (!customerIds.has(row.customerId)) throw new Error(`portalContacts[${index}] belongs to a customer that is not in the backup.`);
    if (seenEmails.has(row.email)) throw new Error(`portalContacts[${index}] has the same email as an earlier contact.`);
    seenEmails.add(row.email);
  }
  for (const [index, row] of file.audit.entries()) {
    if (!customerIds.has(row.customerId)) throw new Error(`audit[${index}] belongs to a customer that is not in the backup.`);
    if (row.ledgerEntryId && !ledgerIds.has(row.ledgerEntryId)) throw new Error(`audit[${index}] refers to a ledger entry that is not in the backup.`);
  }

  return {
    format: BACKUP_FORMAT,
    schema: String(file.schema ?? ""),
    takenAt: String(file.takenAt ?? ""),
    counts: {
      ...(file.writeOffAllocations === undefined ? actual : { ...actual, writeOffAllocations: rawAllocations.length }),
      ...(counts?.users === undefined ? {} : { users: counts.users as number }),
    },
    customers: reviveDates(file.customers, DATE_FIELDS.customers, "customers"),
    ledger: reviveDates(file.ledger, DATE_FIELDS.ledger, "ledger"),
    audit: reviveDates(file.audit, DATE_FIELDS.audit, "audit"),
    portalContacts: reviveContacts(rawContacts, nowMs),
    writeOffAllocations: reviveDates(rawAllocations, DATE_FIELDS.writeOffAllocations, "writeOffAllocations"),
    allocationsIncluded: file.writeOffAllocations !== undefined,
    users: reviveUsers(file.users, nowMs),
  };
}

/** Splits rows into batches so one INSERT never grows past what the database comfortably accepts. */
export function inBatches<T>(rows: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < rows.length; start += size) batches.push(rows.slice(start, start + size));
  return batches;
}
