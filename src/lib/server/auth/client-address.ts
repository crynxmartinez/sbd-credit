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
  // If fewer entries arrived than the number of proxies we expect, the setting is wrong. Never fall back to the FIRST entry,
  // which the client wrote: use the last, the one our nearest proxy added.
  return stripPort(entries[entries.length - trustedHops] ?? entries[entries.length - 1] ?? "local");
}

/** Some proxies append "1.2.3.4:5678" or "[2001:db8::1]:443". The port changes per connection, so it must not be part of the key. */
function stripPort(entry: string): string {
  const bracketed = /^\[([0-9a-f:.]+)\](?::\d+)?$/i.exec(entry);
  if (bracketed) return bracketed[1]!;
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(entry);
  return v4 ? v4[1]! : entry;
}

const IPV6 = /^[0-9a-f:]+$/i;

/** Expands "2001:db8::1" into eight 16-bit groups, or null if it is not an IPv6 address. */
function ipv6Groups(address: string): string[] | null {
  if (!address.includes(":") || !IPV6.test(address) || (address.match(/::/g) ?? []).length > 1) return null;
  const [head, tail] = address.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const missing = 8 - front.length - back.length;
  if (address.includes("::") ? missing < 1 : missing !== 0) return null;
  const groups = [...front, ...Array<string>(address.includes("::") ? missing : 0).fill("0"), ...back];
  return groups.length === 8 && groups.every((group) => group.length >= 1 && group.length <= 4) ? groups : null;
}

/**
 * What a rate limit counts as ONE person. An IPv4 address is itself. A whole IPv6 /64 (the block an ordinary home or
 * office connection is given, billions of addresses) is one bucket, so rotating through addresses in it gains nothing.
 */
export function addressBucket(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1]!;
  const groups = ipv6Groups(address);
  if (!groups) return address;
  return `${groups.slice(0, 4).map((group) => group.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** TRUSTED_PROXY_HOPS from the environment: a small whole number, defaulting to one proxy. */
export function trustedHopsFromEnv(value: string | undefined): number {
  const parsed = Number(value ?? "1");
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 5 ? parsed : 1;
}

/** True when a proxy is expected but the request carries no usable address: the limits would treat every visitor as one. */
export function forwardedAddressMissing(headers: { get(name: string): string | null }, trustedHops = 1): boolean {
  if (trustedHops <= 0) return false;
  const forwarded = headers.get("x-forwarded-for");
  return !forwarded || forwarded.split(",").every((entry) => entry.trim() === "");
}
