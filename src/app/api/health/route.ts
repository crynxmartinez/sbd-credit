import { prisma } from "@/lib/server/db";
import { log } from "@/lib/server/log";

const DATABASE_TIMEOUT_MS = 3_000;

/**
 * For uptime monitors and deploy checks. Public on purpose, so it says only whether the app can reach its database:
 * no versions, hostnames, counts or error text.
 */
export async function GET() {
  let database: "ok" | "error" = "error";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), DATABASE_TIMEOUT_MS);
      }),
    ]);
    database = "ok";
  } catch (error) {
    log("error", "health.database_unreachable", { error });
  } finally {
    clearTimeout(timer);
  }

  const healthy = database === "ok";
  return Response.json(
    { status: healthy ? "ok" : "degraded", checks: { database } },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
