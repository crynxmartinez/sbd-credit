import type { NextRequest } from "next/server";
import { startCustomerSession } from "@/lib/server/auth/customer-session";
import { startSession } from "@/lib/server/auth/current-user";
import { addressBucket, clientAddress, trustedHopsFromEnv } from "@/lib/server/auth/client-address";
import { attemptLimit } from "@/lib/server/auth/limits";
import { authenticateAny, LoginFailure } from "@/lib/server/auth/login";
import { createRateLimiter } from "@/lib/server/auth/rate-limit";
import { normalizeIdentifier } from "@/lib/domain/users";
import { ApiError, assertSameOrigin, ok, readJson, route } from "@/lib/server/http";
import { log } from "@/lib/server/log";
import { loginSchema } from "@/lib/validation";

const production = process.env.NODE_ENV === "production";
// Whole numbers from the environment, otherwise the defaults. Raised only for automated test runs, and ignored in production.
const ATTEMPTS_PER_ADDRESS = attemptLimit(process.env.LOGIN_ATTEMPTS_PER_ADDRESS, 20, production);
const ATTEMPTS_PER_ACCOUNT_AND_ADDRESS = attemptLimit(process.env.LOGIN_ATTEMPTS_PER_ACCOUNT, 10, production);
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
    // An IPv6 /64 is one bucket: a person has billions of addresses inside it, and counting each separately would be no limit.
    const address = addressBucket(clientAddress(request.headers, TRUSTED_HOPS));
    if (!addressLimiter.take(address)) throw tooMany();

    // "username" holds a staff username or a customer's email address.
    const { username: identifier, password } = await readJson(request, loginSchema);
    if (!accountLimiter.take(`${address}|${normalizeIdentifier(identifier)}`)) throw tooMany();

    let who: Awaited<ReturnType<typeof authenticateAny>>;
    try {
      who = await authenticateAny(identifier, password);
    } catch (error) {
      // The reason is for the operator only. The identifier typed is never logged: people paste passwords into that box.
      if (error instanceof LoginFailure) log("warn", "auth.login_failed", { reason: error.reason, kind: error.kind, userId: error.userId, address });
      throw error;
    }

    log("info", "auth.login_ok", { kind: who.kind, userId: who.user.id, address });
    if (who.kind === "staff") {
      await startSession(who.user);
      return ok({ kind: "staff" as const, name: who.user.name });
    }
    await startCustomerSession(who.user);
    return ok({ kind: "customer" as const, name: who.user.name });
  });
}
