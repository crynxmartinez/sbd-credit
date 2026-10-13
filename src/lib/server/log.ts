import { randomUUID } from "node:crypto";

/**
 * One JSON object per line, so a log search can filter on fields and nothing needs parsing by eye.
 * Anything that could be a credential is replaced before the line is written, whatever it was called by the caller.
 */
type Level = "info" | "warn" | "error";
type Fields = Readonly<Record<string, unknown>>;

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|hash|session|connection|database_?url/i;
const MAX_STRING = 500;
const MAX_DEPTH = 4;

/**
 * Any address with a username and password in it (postgres://user:secret@host/db) is replaced wholesale. Applied to every
 * string that is logged, because a secret can arrive anywhere: in a message, in a stack trace (which repeats the
 * message), or in a field a caller thought was harmless. Plain links without credentials are left readable.
 */
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"@/]+@[^\s'"]+/gi;
export const scrubUrls = (text: string): string => text.replace(CREDENTIAL_URL, "[url]");

function redact(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return describeError(value);
  if (typeof value === "string") {
    const scrubbed = scrubUrls(value);
    return scrubbed.length > MAX_STRING ? `${scrubbed.slice(0, MAX_STRING)}…` : scrubbed;
  }
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [key, SENSITIVE_KEY.test(key) ? "[redacted]" : redact(inner, depth + 1)]),
  );
}

export function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: scrubUrls(String(error)).slice(0, MAX_STRING) };
  // A database error can quote the connection string, and the stack repeats the message, so both are scrubbed.
  const stack = error.stack?.split("\n").slice(0, 8).join("\n");
  return {
    name: error.name,
    message: scrubUrls(error.message).slice(0, MAX_STRING),
    stack: stack ? scrubUrls(stack) : undefined,
  };
}

export function formatLogLine(level: Level, event: string, fields: Fields = {}, now: Date = new Date()): string {
  return JSON.stringify({ time: now.toISOString(), level, event, ...(redact(fields) as Fields) });
}

export function log(level: Level, event: string, fields?: Fields): void {
  const line = formatLogLine(level, event, fields);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** A short reference shown to the user and written to the log, so "error 7f3a9c21" can be found later. */
export function newErrorId(): string {
  return randomUUID().slice(0, 8);
}
