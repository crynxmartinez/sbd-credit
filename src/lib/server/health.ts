import "server-only";
import { prisma } from "./db";
import { log } from "./log";

const DATABASE_TIMEOUT_MS = 3_000;
/** How long an answer is shared. A healthy answer for a few seconds; a failure only briefly, so recovery is noticed quickly. */
const OK_SHARED_MS = 5_000;
const FAILURE_SHARED_MS = 2_000;

export interface Answer {
  healthy: boolean;
  at: number;
}
let last: Answer | null = null;
let inflight: Promise<Answer> | null = null;

/** Test helper: forget what was learned. */
export function resetHealthCacheForTests(): void {
  last = null;
  inflight = null;
}

async function check(): Promise<Answer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let healthy = false;
  try {
    await Promise.race([
      // Not just "can I connect": a read of the tables the app uses. A database where the migrations were not applied, or where a
      // grant for the app's login is missing, answers SELECT 1 perfectly and makes every real request fail.
      prisma.$queryRaw`SELECT (SELECT 1 FROM "AppUser" LIMIT 1) AS a, (SELECT 1 FROM "CustomerUser" LIMIT 1) AS b, (SELECT 1 FROM "LedgerEntry" LIMIT 1) AS c, (SELECT 1 FROM "WriteOffAllocation" LIMIT 1) AS d`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), DATABASE_TIMEOUT_MS);
      }),
    ]);
    healthy = true;
  } catch (error) {
    log("error", "health.database_unreachable", { error });
  } finally {
    clearTimeout(timer);
  }
  return { healthy, at: Date.now() };
}

/** The health answer, shared for a few seconds and computed by one probe at a time (see the route for why). */
export async function healthAnswer(): Promise<Answer> {
  const now = Date.now();
  const fresh = last && now - last.at < (last.healthy ? OK_SHARED_MS : FAILURE_SHARED_MS) ? last : null;
  if (fresh) return fresh;
  inflight ??= check().finally(() => {
    inflight = null;
  });
  last = await inflight;
  return last;
}
