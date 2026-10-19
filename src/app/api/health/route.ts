import { healthAnswer } from "@/lib/server/health";

/**
 * For uptime monitors and deploy checks. Public on purpose, so it says only whether the app can use its database: no versions,
 * hostnames, counts or error text. It is answered from a short-lived shared result (and one probe at a time), because anyone can
 * call it, and each real check takes one of the few pooled connections that signed-in people need. (See lib/server/health.ts.)
 */
export async function GET() {
  const answer = await healthAnswer();
  return Response.json(
    { status: answer.healthy ? "ok" : "degraded", checks: { database: answer.healthy ? "ok" : "error" } },
    { status: answer.healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
