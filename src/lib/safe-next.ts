/**
 * Where to send someone after they sign in. Only a path on this site is accepted: anything that could point elsewhere
 * (an absolute URL, a protocol-relative "//host", a backslash trick) falls back to the dashboard, so the sign-in
 * page cannot be used to bounce a person to another site.
 */
export function safeNextPath(value: string | null | undefined, fallback = "/"): string {
  // Next hands a repeated query key (?next=/a&next=/b) over as an array: not a destination, and not a reason to crash.
  if (typeof value !== "string" || !value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  // No control characters: they can hide a different destination from the check above.
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  // The sign-in page itself would loop.
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/login/")) return fallback;
  return value;
}

export type SignInKind = "staff" | "customer";

/**
 * Where a person lands after signing in, decided by what kind of person they are. A customer is only ever sent into
 * the customer pages and staff are never sent there. The path is resolved first, so "/portal/../customers" (which a
 * browser would treat as a staff page) is judged for what it really is.
 */
export function safeNextFor(kind: SignInKind, value: string | null | undefined): string {
  const home = kind === "customer" ? "/portal" : "/";
  const candidate = safeNextPath(value, "");
  if (!candidate || /%2e|%2f|%5c/i.test(candidate)) return home;

  let pathname: string;
  try {
    pathname = new URL(candidate, "http://local.invalid").pathname;
  } catch {
    return home;
  }
  const inPortal = pathname === "/portal" || pathname.startsWith("/portal/");
  if (kind === "customer") return inPortal ? candidate : home;
  return inPortal ? home : candidate;
}
