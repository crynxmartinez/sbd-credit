/**
 * Where to send someone after they sign in. Only a path on this site is accepted: anything that could point elsewhere
 * (an absolute URL, a protocol-relative "//host", a backslash trick) falls back to the dashboard, so the sign-in
 * page cannot be used to bounce a person to another site.
 */
export function safeNextPath(value: string | null | undefined, fallback = "/"): string {
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  // No control characters: they can hide a different destination from the check above.
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  // The sign-in page itself would loop.
  if (value === "/login" || value.startsWith("/login?") || value.startsWith("/login/")) return fallback;
  return value;
}
