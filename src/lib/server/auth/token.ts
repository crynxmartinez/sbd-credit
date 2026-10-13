import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed session token, same shape as the shipper app so the two can share sign-in later:
 *   base64url(JSON{ u, v, e, n }) + "." + base64url(HMAC-SHA256(payload, secret))
 * `e` is a real server-enforced expiry, `v` is compared to the user's sessionVersion (bump it to sign everyone out),
 * and `n` makes every issued token unique.
 */
export interface SessionPayload {
  /** user id */
  u: string;
  /** sessionVersion at issue time */
  v: number;
  /** expiry, epoch ms */
  e: number;
  /** nonce */
  n: string;
}

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;

function hmac(encoded: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(encoded).digest();
}

function assertSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
}

export function signSession(user: { id: string; sessionVersion: number }, secret: string, now: number): string {
  assertSecret(secret);
  const payload: SessionPayload = {
    u: user.id,
    v: user.sessionVersion,
    e: now + SESSION_TTL_MS,
    n: randomBytes(6).toString("hex"),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${hmac(encoded, secret).toString("base64url")}`;
}

/** Returns the payload when the token is genuine and unexpired, otherwise null. Never throws on bad input. */
export function verifySession(token: string, secret: string, now: number): SessionPayload | null {
  assertSecret(secret);
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;

  const encoded = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = hmac(encoded, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SessionPayload>;
    const valid =
      typeof payload.u === "string" &&
      typeof payload.v === "number" &&
      typeof payload.e === "number" &&
      typeof payload.n === "string";
    if (!valid || now > (payload.e as number)) return null;
    return payload as SessionPayload;
  } catch {
    return null;
  }
}
