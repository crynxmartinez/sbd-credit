import "server-only";
import { prisma } from "./db";

/**
 * The database login the running app uses must be the restricted one the runbook describes (docs/PRODUCTION.md, "Use two database
 * roles"): it reads, adds and updates, owns nothing, and cannot delete, truncate, switch triggers off or edit the audit log. The
 * "append-only" promises of the ledger and the audit log rest on that, and nothing else would notice if the app were started with
 * the owner's URL by mistake (it would simply work). So in production the app asks the database who it is, once, at startup, and
 * refuses to start as anyone who could undo those promises.
 */
export interface RoleFacts {
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  /** May create objects in the app's schema. */
  canCreate: boolean;
  canDelete: boolean;
  canTruncate: boolean;
  canTrigger: boolean;
  canUpdateAudit: boolean;
  ownsTables: boolean;
}

/** What is wrong with this login for running the app, in words. Empty when it is the restricted role. Pure. */
export function roleProblems(facts: RoleFacts): string[] {
  const problems: string[] = [];
  // `!== false` so that an unknown answer (a null from a query that found nothing) counts against, never for.
  if (facts.rolsuper !== false) problems.push("the database login is a superuser");
  if (facts.rolcreaterole !== false) problems.push("the database login can create roles");
  if (facts.rolcreatedb !== false) problems.push("the database login can create databases");
  if (facts.canCreate !== false) problems.push("the database login can create objects in the app's schema");
  if (facts.canDelete !== false) problems.push("the database login can DELETE ledger rows");
  if (facts.canTruncate !== false) problems.push("the database login can TRUNCATE the ledger");
  if (facts.canTrigger !== false) problems.push("the database login can switch the ledger's TRIGGERs off");
  if (facts.canUpdateAudit !== false) problems.push("the database login can edit the audit log");
  if (facts.ownsTables !== false) problems.push("the database login owns the tables (use the separate owner login only for migrations)");
  return problems;
}

export async function readRoleFacts(): Promise<RoleFacts> {
  const [row] = await prisma.$queryRaw<RoleFacts[]>`
    SELECT r."rolsuper", r."rolcreaterole", r."rolcreatedb",
           has_schema_privilege(current_user, current_schema(), 'CREATE') AS "canCreate",
           has_table_privilege(current_user, '"LedgerEntry"', 'DELETE') AS "canDelete",
           has_table_privilege(current_user, '"LedgerEntry"', 'TRUNCATE') AS "canTruncate",
           has_table_privilege(current_user, '"LedgerEntry"', 'TRIGGER') AS "canTrigger",
           has_table_privilege(current_user, '"AuditEvent"', 'UPDATE') AS "canUpdateAudit",
           (SELECT t."tableowner" = current_user FROM pg_tables t WHERE t."schemaname" = current_schema() AND t."tablename" = 'LedgerEntry') AS "ownsTables"
    FROM pg_roles r WHERE r."rolname" = current_user`;
  if (!row) throw new Error("could not read the database login's privileges");
  return row;
}

export type RoleCheck = { status: "ok" } | { status: "unsafe"; problems: string[] } | { status: "unknown"; reason: string };

/** Asks the database who the app is running as. A database that cannot be reached is "unknown", not a refusal: the health check reports it. */
export async function checkDatabaseRole(timeoutMs = 10_000): Promise<RoleCheck> {
  try {
    const facts = await Promise.race([
      readRoleFacts(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs).unref()),
    ]);
    const problems = roleProblems(facts);
    return problems.length === 0 ? { status: "ok" } : { status: "unsafe", problems };
  } catch (error) {
    return { status: "unknown", reason: error instanceof Error ? error.message.split("\n")[0]! : "unknown error" };
  }
}
