import type { NextRequest } from "next/server";
import { startCustomerSession } from "@/lib/server/auth/customer-session";
import { startSession } from "@/lib/server/auth/current-user";
import { clientAddress, trustedHopsFromEnv } from "@/lib/server/auth/client-address";
import { authenticateAny } from "@/lib/server/auth/login";
import { createRateLimiter } from "@/lib/server/auth/rate-limit";
import { normalizeIdentifier } from "@/lib/domain/users";
import { ApiError, assertSameOrigin, ok, readJson, route } from "@/lib/server/http";
import { loginSchema } from "@/lib/validation";

const wholeNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// Whole numbers from the environment, otherwise the defaults. Raised only for automated test runs.
const ATTEMPTS_PER_ADDRESS = wholeNumber(process.env.LOGIN_ATTEMPTS_PER_ADDRESS, 20);
const ATTEMPTS_PER_ACCOUNT_AND_ADDRESS = wholeNumber(process.env.LOGIN_ATTEMPTS_PER_ACCOUNT, 10);
const ADDRESS_WINDOW_MS = 10 * 60_000;
const ACCOUNT_WINDOW_MS = 15 * 60_000;

/** Per client address, per running server. Blunts a guessing run and the cost of hashing on every request. */
const addressLimiter = createRateLimiter({ limit: ATTEMPTS_PER_ADDRESS, windowMs: ADDRESS_WINDOW_MS });
/**
 * Per account AND address. One person hammering one account from one place is stopped without anyone else being able to
 * lock that account out for everybody, which matters for customers because their sign-in name is just their email.
 */
const accountLimiter = createRateLimiter({ limit: ATTEMPTS_PER_ACCOUNT_AND_ADDRESS, windowMs: ACCOUNT_WINDOW_MS });
const TRUSTED_HOPS = trustedHopsFromEnv(process.env.TRUSTED_PROXY_HOPS);

const tooMany = () => new ApiError(429, "rate_limited", "Too many attempts. Please wait a few minutes and try again.");

export function POST(request: NextRequest) {
  return route(async () => {
    assertSameOrigin(request);
    const address = clientAddress(request.headers, TRUSTED_HOPS);
    if (!addressLimiter.take(address)) throw tooMany();

    // "username" holds a staff username or a customer's email address.
    const { username: identifier, password } = await readJson(request, loginSchema);
    if (!accountLimiter.take(`${address}|${normalizeIdentifier(identifier)}`)) throw tooMany();

    const who = await authenticateAny(identifier, password);
    if (who.kind === "staff") {
      await startSession(who.user);
      return ok({ kind: "staff" as const, name: who.user.name });
    }
    await startCustomerSession(who.user);
    return ok({ kind: "customer" as const, name: who.user.name });
  });
}
