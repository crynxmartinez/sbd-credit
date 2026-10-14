import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import { classifyDbError } from "./db-errors";
import { ApiError } from "./http";
import { log } from "./log";

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

export const busyError = () =>
  new ApiError(503, "busy", "The system is busy and nothing was saved. Please try again in a moment.");

/** The connection dropped while saving. The commit may have reached the database, so "nothing was saved" would be a guess. */
export const interruptedError = () =>
  new ApiError(503, "interrupted", "The connection to the database was interrupted. This may or may not have been saved: check the customer's record before entering it again.");
export async function transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true), set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`;
      return work(tx);
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    const outcome = classifyDbError(error);
    // Without this the operator sees nothing: the person is told "busy" and the log stays quiet.
    if (outcome !== "other") log("warn", "tx.connection_problem", { outcome, error });
    if (outcome === "not_saved") throw busyError();
    if (outcome === "unknown_outcome") throw interruptedError();
    throw error;
  }
}
