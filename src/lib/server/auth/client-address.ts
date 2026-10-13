/**
 * The address a request really came from, for rate limiting.
 *
 * x-forwarded-for is a list: every proxy the request passed through appends the address it received the request from.
 * Anything BEFORE the entries our own proxies added was written by the client and can be forged, so the first entry
 * (the old choice) is the one an attacker controls. The trustworthy entry is the one our nearest proxy appended: the
 * last, or the Nth from last if we run behind N proxies.
 *
 * `trustedHops` is how many proxies we run behind. 0 means none, so the header is ignored entirely.
 */
export function clientAddress(headers: { get(name: string): string | null }, trustedHops = 1): string {
  if (trustedHops <= 0) return "local";
  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return "local";
  const entries = forwarded.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries[entries.length - trustedHops] ?? entries[0] ?? "local";
}

/** TRUSTED_PROXY_HOPS from the environment: a small whole number, defaulting to one proxy. */
export function trustedHopsFromEnv(value: string | undefined): number {
  const parsed = Number(value ?? "1");
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 5 ? parsed : 1;
}
