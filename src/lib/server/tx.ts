import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import { ApiError } from "./http";

/**
 * Every write runs through here. It gives each transaction two limits, so a stuck or overloaded database fails fast
 * with a clear message instead of holding one of the few pooled connections until the whole UI stalls:
 *
 *   lock_timeout       how long to wait for a row another writer holds (a hot customer, ten people at once)
 *   statement_timeout  how long any single statement may run
 */
const LOCK_TIMEOUT = "10s";
const STATEMENT_TIMEOUT = "15s";
export const TRANSACTION_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

const TRANSIENT_SQLSTATES = new Set(["55P03", "57014", "40P01", "40001"]);
const TRANSIENT_PRISMA_CODES = new Set(["P2028", "P2034", "P1001", "P1002", "P1008", "P1017"]);
const TRANSIENT_MESSAGE =
  /lock timeout|statement timeout|deadlock detected|could not serialize|Transaction already closed|Unable to start a transaction|Timed out fetching a new connection|terminating connection/i;

/** Timeouts, deadlocks and lost connections: failures where nothing was saved and trying again later is the right answer. */
export function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, meta, message } = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  if (typeof code === "string" && TRANSIENT_PRISMA_CODES.has(code)) return true;
  if (typeof meta?.code === "string" && TRANSIENT_SQLSTATES.has(meta.code)) return true;
  if (typeof code === "string" && TRANSIENT_SQLSTATES.has(code)) return true;
  return typeof message === "string" && TRANSIENT_MESSAGE.test(message);
}

export const busyError = () =>
  new ApiError(503, "busy", "The system is busy and nothing was saved. Please try again in a moment.");

export async function transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true), set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`;
      return work(tx);
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    if (isTransientError(error)) throw busyError();
    throw error;
  }
}
