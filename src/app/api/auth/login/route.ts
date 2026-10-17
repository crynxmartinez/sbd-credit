import type { NextRequest } from "next/server";
import { startCustomerSession } from "@/lib/server/auth/customer-session";
import { startSession } from "@/lib/server/auth/current-user";
import { addressBucket, clientAddress, trustedHopsFromEnv } from "@/lib/server/auth/client-address";
import { attemptLimit } from "@/lib/server/auth/limits";
import { authenticateAny, LoginFailure } from "@/lib/server/auth/login";
import { createRateLimiter } from "@/lib/server/auth/rate-limit";
import { FREE_FAILURES, createLoginThrottle } from "@/lib/domain/login-throttle";
import { normalizeIdentifier } from "@/lib/domain/users";
import { ApiError, assertSameOrigin, ok, readJson, route } from "@/lib/server/http";
import { log } from "@/lib/server/log";
import { loginSchema } from "@/lib/validation";

const production = process.env.NODE_ENV === "production";
// Whole numbers from the environment, otherwise the defaults. Raised only for automated test runs, and ignored in production.
const ATTEMPTS_PER_ADDRESS = attemptLimit(process.env.LOGIN_ATTEMPTS_PER_ADDRESS, 20, production);
const ATTEMPTS_PER_ACCOUNT_AND_ADDRESS = attemptLimit(process.env.LOGIN_ATTEMPTS_PER_ACCOUNT, 10, production);
// Wrong passwords per (address, name) before the wait starts. Raised only for automated test runs, and ignored in production.
const FREE_FAILURES_PER_ACCOUNT_AND_ADDRESS = attemptLimit(process.env.LOGIN_FREE_FAILURES, FREE_FAILURES, production);
const ADDRESS_WINDOW_MS = 10 * 60_000;
const ACCOUNT_WINDOW_MS = 15 * 60_000;

/** Per client address, per running server. Blunts a guessing run and the cost of hashing on every request. */
const addressLimiter = createRateLimiter({ limit: ATTEMPTS_PER_ADDRESS, windowMs: ADDRESS_WINDOW_MS });
/**
 * Per account AND address. One person hammering one account from one place is stopped without anyone else being able to
 * lock that account out for everybody, which matters for customers because their sign-in name is just their email.
 */
const accountLimiter = createRateLimiter({ limit: ATTEMPTS_PER_ACCOUNT_AND_ADDRESS, windowMs: ACCOUNT_WINDOW_MS });
/**
 * Per (address, name): after a few wrong passwords the next try must wait, and the wait doubles. Nobody is ever locked out of
 * an account, because anyone who knows a name could otherwise lock that person out; a guesser only slows himself, and the
 * real person, from their own address, starts with a clean count. See domain/login-throttle.ts.
 */
const failureThrottle = createLoginThrottle({ freeFailures: FREE_FAILURES_PER_ACCOUNT_AND_ADDRESS });
const TRUSTED_HOPS = trustedHopsFromEnv(process.env.TRUSTED_PROXY_HOPS);

const tooSoon = (retryAfterMs: number) =>
  new ApiError(429, "rate_limited", `Too many attempts. Please wait ${Math.max(1, Math.ceil(retryAfterMs / 1000))} seconds before trying again.`);
const tooMany = () => new ApiError(429, "rate_limited", "Too many attempts. Please wait a few minutes and try again.");

export function POST(request: NextRequest) {
  return route(async () => {
    assertSameOrigin(request);
    // An IPv6 /64 is one bucket: a person has billions of addresses inside it, and counting each separately would be no limit.
    const address = addressBucket(clientAddress(request.headers, TRUSTED_HOPS));
    if (!addressLimiter.take(address)) throw tooMany();

    // "username" holds a staff username or a customer's email address.
    const { username: identifier, password } = await readJson(request, loginSchema);
    const accountKey = `${address}|${normalizeIdentifier(identifier)}`;
    if (!accountLimiter.take(accountKey)) throw tooMany();
    // The wait applies to ANY name typed, real or not, so it reveals nothing about which names exist.
    const turn = failureThrottle.check(accountKey);
    if (!turn.allowed) throw tooSoon(turn.retryAfterMs);

    // Counted as a failure BEFORE the (slow) password check and cleared on success, so a burst of parallel guesses is slowed
    // too: all of them would otherwise pass the check above before any one had finished and been counted.
    failureThrottle.fail(accountKey);
    let who: Awaited<ReturnType<typeof authenticateAny>>;
    try {
      who = await authenticateAny(identifier, password);
    } catch (error) {
      // The reason is for the operator only. The identifier typed is never logged: people paste passwords into that box.
      if (error instanceof LoginFailure) log("warn", "auth.login_failed", { reason: error.reason, kind: error.kind, userId: error.userId, address });
      throw error;
    }
    failureThrottle.succeed(accountKey);

    log("info", "auth.login_ok", { kind: who.kind, userId: who.user.id, address });
    if (who.kind === "staff") {
      await startSession(who.user);
      return ok({ kind: "staff" as const, name: who.user.name });
    }
    await startCustomerSession(who.user);
    return ok({ kind: "customer" as const, name: who.user.name });
  });
}
