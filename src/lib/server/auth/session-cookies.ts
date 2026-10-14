import "server-only";
import { cookies } from "next/headers";
import { cookieNameFor } from "./cookie-name";
import { sessionTtlMs, signSession, verifySession, type SessionKind, type SessionPayload } from "./token";

const production = () => process.env.NODE_ENV === "production";

export function sessionSecret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is not set. Add it to .env.local (see .env.example).");
  return value;
}

const otherKind = (kind: SessionKind): SessionKind => (kind === "staff" ? "customer" : "staff");

/**
 * The attributes every session cookie carries, whether it is being set or removed. In production the "__Host-" prefix
 * makes a browser refuse any Set-Cookie for the name that is not Secure, and that includes the one that removes it. The
 * ordinary cookies.delete() writes no Secure attribute, so in production it would silently fail to remove anything.
 */
function attributes(maxAgeSeconds: number) {
  return { httpOnly: true, sameSite: "lax" as const, secure: production(), path: "/", maxAge: maxAgeSeconds };
}

async function expire(kind: SessionKind): Promise<void> {
  (await cookies()).set(cookieNameFor(kind, production()), "", attributes(0));
}

/**
 * Starts a session of one kind. The other kind's cookie is removed in the same step, so signing in as a customer on a
 * computer where staff were signed in (or the reverse) never leaves two people's sessions side by side.
 */
export async function setSessionCookie(kind: SessionKind, user: { id: string; sessionVersion: number }): Promise<void> {
  await expire(otherKind(kind));
  (await cookies()).set(cookieNameFor(kind, production()), signSession(user, sessionSecret(), Date.now(), kind), attributes(sessionTtlMs(kind) / 1000));
}

/** The verified payload of this kind's cookie, or null. A token of the other kind never verifies here. */
export async function readSessionPayload(kind: SessionKind): Promise<SessionPayload | null> {
  const token = (await cookies()).get(cookieNameFor(kind, production()))?.value;
  return token ? verifySession(token, sessionSecret(), Date.now(), kind) : null;
}

export async function clearSessionCookie(kind: SessionKind): Promise<void> {
  await expire(kind);
}
