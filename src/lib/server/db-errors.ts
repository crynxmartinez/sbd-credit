/**
 * What a database failure means for the person who was saving something. The distinction matters: "nothing was saved,
 * try again" is a promise, and it is only true if the failure happened BEFORE the write could have committed.
 *
 *   not_saved        timeouts, deadlocks, no connection available, could not connect: the transaction never committed
 *   unknown_outcome  the connection dropped mid-flight: the commit may or may not have reached the database
 *   other            not a connection problem (a constraint, a bug): retrying would fail the same way
 */
export type DbOutcome = "not_saved" | "unknown_outcome" | "other";

const NOT_SAVED_SQLSTATES = new Set(["55P03", "57014", "40P01", "40001", "53300", "57P03"]);
const UNKNOWN_SQLSTATES = new Set(["57P01", "57P02"]);
const NOT_SAVED_PRISMA = new Set(["P2028", "P2034", "P1001", "P1002", "P1008"]);
const UNKNOWN_PRISMA = new Set(["P1017"]);

const NOT_SAVED_MESSAGE =
  /lock timeout|statement timeout|deadlock detected|could not serialize|Transaction already closed|Unable to start a transaction|Timed out fetching a new connection|timeout exceeded when trying to connect|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i;
const UNKNOWN_MESSAGE = /terminating connection|Connection terminated|ECONNRESET|Server has closed the connection|EPIPE/i;

export function classifyDbError(error: unknown): DbOutcome {
  if (!error || typeof error !== "object") return "other";
  const { code, meta, message } = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  const sqlstates = [typeof code === "string" ? code : undefined, typeof meta?.code === "string" ? meta.code : undefined];

  // pg's own words for "the connection never opened" also contain "Connection terminated": nothing could have been written yet.
  if (typeof message === "string" && /Connection terminated due to connection timeout/i.test(message)) return "not_saved";
  // A dropped connection is checked first: it is the one case where "nothing was saved" would be a guess.
  if ((typeof code === "string" && UNKNOWN_PRISMA.has(code)) || sqlstates.some((value) => value !== undefined && UNKNOWN_SQLSTATES.has(value))) {
    return "unknown_outcome";
  }
  if (typeof message === "string" && UNKNOWN_MESSAGE.test(message)) return "unknown_outcome";

  if ((typeof code === "string" && NOT_SAVED_PRISMA.has(code)) || sqlstates.some((value) => value !== undefined && NOT_SAVED_SQLSTATES.has(value))) {
    return "not_saved";
  }
  if (typeof message === "string" && NOT_SAVED_MESSAGE.test(message)) return "not_saved";
  return "other";
}

/** Any connection-level problem, whether or not a write got through. */
export const isTransientError = (error: unknown): boolean => classifyDbError(error) !== "other";
