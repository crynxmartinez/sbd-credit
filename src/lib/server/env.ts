import { assertSafeTarget } from "./db-url";

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
    } catch (error) {
      problems.push(error instanceof Error ? error.message : "DATABASE_URL is not usable.");
    }
  }

  const secret = env.SESSION_SECRET;
  if (!secret) problems.push("SESSION_SECRET is not set.");
  else if (secret.length < MIN_SECRET_LENGTH) problems.push(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);

  // The shortcut that skips sign-in must never be on in a real deployment, even though the code also ignores it there.
  if (production && env.CREDIT_DEV_AUTOLOGIN) problems.push("CREDIT_DEV_AUTOLOGIN must not be set in production.");

  if (env.BUSINESS_TIME_ZONE) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: env.BUSINESS_TIME_ZONE });
    } catch {
      problems.push(`BUSINESS_TIME_ZONE "${env.BUSINESS_TIME_ZONE}" is not a valid time zone.`);
    }
  }
  return problems;
}
