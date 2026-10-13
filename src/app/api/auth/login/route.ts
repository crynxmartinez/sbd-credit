import type { NextRequest } from "next/server";
import { startSession } from "@/lib/server/auth/current-user";
import { clientAddress, trustedHopsFromEnv } from "@/lib/server/auth/client-address";
import { authenticate } from "@/lib/server/auth/login";
import { createRateLimiter } from "@/lib/server/auth/rate-limit";
import { ApiError, assertSameOrigin, ok, readJson, route } from "@/lib/server/http";
import type { SessionUser } from "@/lib/types";
import { loginSchema } from "@/lib/validation";

const DEFAULT_ATTEMPTS_PER_ADDRESS = 20;
const configuredAttempts = Number(process.env.LOGIN_ATTEMPTS_PER_ADDRESS);
// A whole number from the environment, otherwise the default. Raised only for automated test runs.
const ATTEMPTS_PER_ADDRESS = Number.isInteger(configuredAttempts) && configuredAttempts > 0 ? configuredAttempts : DEFAULT_ATTEMPTS_PER_ADDRESS;
const ATTEMPT_WINDOW_MS = 10 * 60_000;

/** Per client address, per running server. Blunts a guessing run and the cost of hashing on every request. */
const limiter = createRateLimiter({ limit: ATTEMPTS_PER_ADDRESS, windowMs: ATTEMPT_WINDOW_MS });
const TRUSTED_HOPS = trustedHopsFromEnv(process.env.TRUSTED_PROXY_HOPS);

export function POST(request: NextRequest) {
  return route(async () => {
    assertSameOrigin(request);
    if (!limiter.take(clientAddress(request.headers, TRUSTED_HOPS))) {
      throw new ApiError(429, "rate_limited", "Too many attempts. Please wait a few minutes and try again.");
    }
    const { username, password } = await readJson(request, loginSchema);

    const user = await authenticate(username, password);
    await startSession(user);

    // authenticate() already refused any account whose role is not a known one.
    const body: SessionUser = { id: user.id, username: user.username, name: user.name, role: user.role as SessionUser["role"] };
    return ok(body);
  });
}
