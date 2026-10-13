import type { Instrumentation } from "next";

/**
 * Runs once when the server starts, before it takes requests. A misconfigured deployment stops here with a plain
 * list of what is wrong, instead of starting up and failing on the first sign-in.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // `next build` evaluates the app on a machine that has no database or secrets; only a running server needs them.
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { validateEnvironment } = await import("@/lib/server/env");
  const { log } = await import("@/lib/server/log");

  const problems = validateEnvironment(process.env);
  if (problems.length === 0) {
    log("info", "startup.ok", { environment: process.env.NODE_ENV });
    return;
  }
  log("error", "startup.invalid_environment", { problems });
  throw new Error(`Credit Tracker cannot start:\n - ${problems.join("\n - ")}`);
}

/** Every server error that reaches Next is written to the log with where it happened, never with headers or bodies. */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { log, describeError } = await import("@/lib/server/log");
  const digest = typeof error === "object" && error !== null && "digest" in error ? String((error as { digest: unknown }).digest) : undefined;
  log("error", "request.unhandled_error", {
    digest,
    method: request.method,
    path: request.path.split("?")[0],
    routePath: context.routePath,
    routeType: context.routeType,
    error: describeError(error),
  });
};
