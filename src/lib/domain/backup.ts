/**
 * The shape of a backup file and the checks that make a restore trustworthy. Pure: no database, no files.
 *
 * JSON has no date type, so dates are written as strings and must be turned back into real dates on the way in.
 * Doing that by named column (not "anything that looks like a date") means free text such as a note or a business
 * name can never be mistaken for one.
 */
export const BACKUP_FORMAT = 1;

const DATE_FIELDS = {
  customers: ["dateApplied", "statusChangedOn", "creditStartDate", "createdAt", "updatedAt"],
  ledger: ["entryDate", "dueDate", "createdAt", "voidedAt"],
  audit: ["createdAt"],
} as const;

type Row = Record<string, unknown>;

export interface BackupFile {
  format: number;
  schema: string;
  takenAt: string;
  counts: { customers: number; ledger: number; audit: number };
  customers: Row[];
  ledger: Row[];
  audit: Row[];
  /** Who could sign in. Never includes password hashes, so a backup file is not a credential leak. */
  users: Array<{ id: string; username: string; name: string; role: string; active: boolean }>;
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
 * Validates a parsed backup and returns it with real Date objects. Throws a specific message on anything wrong, so a
 * damaged or truncated file is refused before a single row is written.
 */
export function reviveBackup(raw: unknown): BackupFile {
  if (typeof raw !== "object" || raw === null) throw new Error("The backup file is not a JSON object.");
  const file = raw as Record<string, unknown>;
  if (file.format !== BACKUP_FORMAT) throw new Error(`Unsupported backup format ${String(file.format)} (expected ${BACKUP_FORMAT}).`);
  if (!isRows(file.customers) || !isRows(file.ledger) || !isRows(file.audit)) {
    throw new Error("The backup is missing customers, ledger or audit rows.");
  }

  const counts = file.counts as Record<string, unknown> | undefined;
  const actual = { customers: file.customers.length, ledger: file.ledger.length, audit: file.audit.length };
  for (const table of ["customers", "ledger", "audit"] as const) {
    if (counts?.[table] !== actual[table]) {
      throw new Error(`The backup is incomplete: it says ${String(counts?.[table])} ${table} rows but contains ${actual[table]}.`);
    }
  }

  const customerIds = new Set(file.customers.map((row) => row.id));
  const ledgerIds = new Set(file.ledger.map((row) => row.id));
  for (const [index, row] of file.ledger.entries()) {
    if (!customerIds.has(row.customerId)) throw new Error(`ledger[${index}] belongs to a customer that is not in the backup.`);
  }
  for (const [index, row] of file.audit.entries()) {
    if (!customerIds.has(row.customerId)) throw new Error(`audit[${index}] belongs to a customer that is not in the backup.`);
    if (row.ledgerEntryId && !ledgerIds.has(row.ledgerEntryId)) throw new Error(`audit[${index}] refers to a ledger entry that is not in the backup.`);
  }

  return {
    format: BACKUP_FORMAT,
    schema: String(file.schema ?? ""),
    takenAt: String(file.takenAt ?? ""),
    counts: actual,
    customers: reviveDates(file.customers, DATE_FIELDS.customers, "customers"),
    ledger: reviveDates(file.ledger, DATE_FIELDS.ledger, "ledger"),
    audit: reviveDates(file.audit, DATE_FIELDS.audit, "audit"),
    users: Array.isArray(file.users) ? (file.users as BackupFile["users"]) : [],
  };
}

/** Splits rows into batches so one INSERT never grows past what the database comfortably accepts. */
export function inBatches<T>(rows: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < rows.length; start += size) batches.push(rows.slice(start, start + size));
  return batches;
}
