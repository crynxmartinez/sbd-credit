import "server-only";
import { prepareLoginTiming } from "./auth/login";
import { prisma } from "./db";
import { log } from "./log";

/**
 * Work the first request would otherwise pay for: opening the first database connection (several round trips to a remote
 * server) and computing the hash that every sign-in for an unknown name is compared against. The second also removes a
 * timing difference: the very first unknown-name sign-in used to take twice as long as a wrong password, which says
 * "this name does not exist".
 *
 * Never throws: a database that is not up yet must not stop the app from starting (the health check reports it).
 */
export async function warmUp(): Promise<void> {
  await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`.catch((error: unknown) => log("warn", "startup.database_not_ready", { error })),
    prepareLoginTiming(),
  ]);
}
