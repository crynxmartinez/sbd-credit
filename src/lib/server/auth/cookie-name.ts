import type { SessionKind } from "./token";

/**
 * The cookie each kind of session lives in. In production the "__Host-" prefix makes the browser refuse the cookie
 * unless it is Secure, set for this exact host, with no Domain attribute, so a sibling subdomain cannot set one.
 */
export function cookieNameFor(kind: SessionKind, production: boolean): string {
  const base = kind === "staff" ? "credit_session" : "credit_portal_session";
  return production ? `__Host-${base}` : base;
}
