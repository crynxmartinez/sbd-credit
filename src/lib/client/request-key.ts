/**
 * A fresh, unguessable key for one form submission. `crypto.randomUUID` exists only in a secure context (https, localhost), so
 * opening the app by a LAN address over http (testing the phone layout) threw as soon as a form opened. This falls back to
 * building a version 4 UUID from getRandomValues, which works everywhere.
 */
export function newRequestKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
