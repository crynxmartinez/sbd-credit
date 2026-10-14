import { assertSafeTarget, assertSecureTransport } from "./db-url";
import { publicBaseUrl } from "./public-url";

const MIN_SECRET_LENGTH = 32;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Everything the app needs to be set, checked once at startup so a bad deploy fails immediately and says why,
 * instead of failing on whichever request first touches the missing piece.
 * Returns a list of problems; empty means ready.
 */
export function validateEnvironment(env: Env): string[] {
  const problems: string[] = [];
  const production = env.NODE_ENV === "production";

  const url = env.DATABASE_URL;
  if (!url) {
    problems.push("DATABASE_URL is not set.");
  } else {
    try {
      assertSafeTarget(url, env.NODE_ENV);
      assertSecureTransport(url, env.NODE_ENV);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : "DATABASE_URL is not usable.");
    }
  }

  const secret = env.SESSION_SECRET;
  if (!secret) problems.push("SESSION_SECRET is not set.");
  else if (secret.length < MIN_SECRET_LENGTH) problems.push(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);

  // The shortcut that skips sign-in must never be on in a real deployment, even though the code also ignores it there.
  if (production && env.CREDIT_DEV_AUTOLOGIN) problems.push("CREDIT_DEV_AUTOLOGIN must not be set in production.");

  // Invitation links are built from this, never from the request, so a forged Host header cannot redirect a customer.
  if (production || env.PUBLIC_BASE_URL) {
    try {
      publicBaseUrl(env);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : "PUBLIC_BASE_URL is not usable.");
    }
  }

  // Overrides that exist only so the automated tests can sign in thousands of times. In production they would switch the
  // sign-in limits off, so a leftover setting is refused rather than obeyed.
  if (production) {
    for (const name of ["LOGIN_ATTEMPTS_PER_ADDRESS", "LOGIN_ATTEMPTS_PER_ACCOUNT", "ACCEPT_ATTEMPTS_PER_ADDRESS"]) {
      if (env[name] !== undefined) problems.push(`${name} must not be set in production: it weakens the sign-in limits.`);
    }
  }
  // The sign-in limits key on the address our proxy reports. A wrong guess here either switches them off (a visitor writes
  // the entry we trust) or makes everyone share one bucket, so production must say how many proxies there are.
  if (production && env.TRUSTED_PROXY_HOPS === undefined) {
    problems.push("TRUSTED_PROXY_HOPS must be set in production: how many proxies sit in front of the app (usually 1).");
  }
  if (env.TRUSTED_PROXY_HOPS !== undefined && !/^[0-5]$/.test(env.TRUSTED_PROXY_HOPS)) {
    problems.push("TRUSTED_PROXY_HOPS must be a whole number from 0 to 5 (how many proxies sit in front of the app).");
  }

  if (env.BUSINESS_TIME_ZONE !== undefined && env.BUSINESS_TIME_ZONE.trim() === "") {
    problems.push("BUSINESS_TIME_ZONE is set but empty. Remove it to use the default, or give a time zone such as America/Chicago.");
  } else if (env.BUSINESS_TIME_ZONE) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: env.BUSINESS_TIME_ZONE });
    } catch {
      problems.push(`BUSINESS_TIME_ZONE "${env.BUSINESS_TIME_ZONE}" is not a valid time zone.`);
    }
  }
  return problems;
}
