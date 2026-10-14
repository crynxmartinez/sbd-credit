import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed session token:
 *   base64url(JSON{ u, v, e, n, k }) + "." + base64url(HMAC-SHA256(payload, key-for-kind))
 * `e` is a real server-enforced expiry, `v` is compared to the user's sessionVersion (bump it to sign everyone out),
 * `n` makes every issued token unique, and `k` names the kind of session (staff or customer).
 *
 * The key is derived from SESSION_SECRET for each kind, never the secret itself. That is deliberate: a token made by
 * anything else that knows the secret (the shipper app included) does not verify here, so sharing sign-in with it would
 * need its own, explicit design.
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
  /** Who the session is for. Must match the kind it is verified as. */
  k: SessionKind;
}

/**
 * Staff and customers are different kinds of session. Each kind is signed with its own key, derived from the one secret,
 * so a token made for one kind can never verify as the other, whatever it claims inside.
 */
export type SessionKind = "staff" | "customer";

const TTL_MS: Readonly<Record<SessionKind, number>> = {
  staff: 12 * 60 * 60 * 1000,
  customer: 4 * 60 * 60 * 1000,
};

export const sessionTtlMs = (kind: SessionKind): number => TTL_MS[kind];
export const SESSION_TTL_MS = TTL_MS.staff;
const MIN_SECRET_LENGTH = 32;

function hmac(encoded: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(encoded).digest();
}

/**
 * Each kind of session gets its own key, derived from the one secret and a label. The raw secret is never used to sign,
 * so a token made for staff, for a customer, or by anything else that knows the secret (the shipper app, say) cannot
 * verify as another kind.
 */
function keyFor(secret: string, kind: SessionKind): string {
  return createHmac("sha256", secret).update(`credit-${kind}-session-v1`).digest("hex");
}

function assertSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
}

export function signSession(user: { id: string; sessionVersion: number }, secret: string, now: number, kind: SessionKind = "staff"): string {
  assertSecret(secret);
  const payload: SessionPayload = {
    u: user.id,
    v: user.sessionVersion,
    e: now + TTL_MS[kind],
    n: randomBytes(6).toString("hex"),
    k: kind,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${hmac(encoded, keyFor(secret, kind)).toString("base64url")}`;
}

/** Returns the payload when the token is genuine and unexpired, otherwise null. Never throws on bad input. */
export function verifySession(token: string, secret: string, now: number, kind: SessionKind = "staff"): SessionPayload | null {
  assertSecret(secret);
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;

  const encoded = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = hmac(encoded, keyFor(secret, kind));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SessionPayload>;
    const valid =
      typeof payload.u === "string" &&
      typeof payload.v === "number" &&
      typeof payload.e === "number" &&
      typeof payload.n === "string";
    if (!valid || now > (payload.e as number)) return null;
    // The signature already proves the kind; this also refuses a validly signed payload whose own claim disagrees with it.
    if (payload.k !== kind) return null;
    return payload as SessionPayload;
  } catch {
    return null;
  }
}
