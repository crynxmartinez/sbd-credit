import { describe, expect, test } from "vitest";
import { describeError, formatLogLine, newErrorId, scrubUrls } from "./log";

const NOW = new Date("2026-10-14T00:00:00Z");
const parse = (line: string) => JSON.parse(line) as Record<string, unknown>;

describe("formatLogLine", () => {
  test("is one JSON object with time, level and event", () => {
    expect(parse(formatLogLine("info", "customer.created", { id: "c1" }, NOW))).toEqual({
      time: "2026-10-14T00:00:00.000Z",
      level: "info",
      event: "customer.created",
      id: "c1",
    });
  });

  test.each(["password", "passwordHash", "SESSION_SECRET", "authToken", "cookie", "Authorization", "databaseUrl", "connectionString"])(
    "redacts a field called %s",
    (key) => {
      expect(parse(formatLogLine("info", "x", { [key]: "hunter2" }, NOW))[key]).toBe("[redacted]");
    },
  );

  test("redacts inside nested objects and arrays", () => {
    const line = parse(formatLogLine("info", "x", { user: { name: "A", password: "p" }, list: [{ token: "t" }] }, NOW));
    expect(line).toMatchObject({ user: { name: "A", password: "[redacted]" }, list: [{ token: "[redacted]" }] });
  });

  test("scrubs a connection string wherever it appears in a logged field", () => {
    const line = formatLogLine("error", "x", { detail: "tried postgres://user:hunter2@host/db twice", nested: { more: ["mysql://a:b@h/x"] } }, NOW);
    expect(line).not.toContain("hunter2");
    expect(line).not.toContain(":b@");
  });

  test("truncates very long strings so a bad payload cannot flood the log", () => {
    const line = parse(formatLogLine("info", "x", { body: "a".repeat(5000) }, NOW));
    expect((line.body as string).length).toBeLessThan(600);
  });

  test("does not recurse forever on deep structures", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 20; i += 1) deep = { next: deep };
    expect(() => formatLogLine("info", "x", { deep }, NOW)).not.toThrow();
  });
});

describe("describeError", () => {
  test("keeps the name and message and a short stack", () => {
    const described = describeError(new TypeError("boom"));
    expect(described).toMatchObject({ name: "TypeError", message: "boom" });
    expect(String(described.stack).split("\n").length).toBeLessThanOrEqual(8);
  });

  test("scrubs connection strings out of error messages", () => {
    const described = describeError(new Error("connect failed for postgres://user:secret@db.example.com:5432/postgres?sslmode=require"));
    expect(String(described.message)).not.toContain("secret");
    expect(String(described.message)).toContain("[url]");
  });

  test("scrubs the stack trace too, because it repeats the message", () => {
    const error = new Error("connect failed for postgres://user:supersecret@db.example.com:5432/postgres");
    const described = describeError(error);
    expect(String(error.stack)).toContain("supersecret"); // the raw stack really does carry it
    expect(String(described.stack)).not.toContain("supersecret");
    expect(JSON.stringify(described)).not.toContain("supersecret");
  });

  test("copes with a thrown non-error, and scrubs it", () => {
    expect(describeError("plain string")).toEqual({ message: "plain string" });
    expect(String(describeError("failed: postgres://u:p@h/d").message)).not.toContain(":p@");
  });
});

describe("scrubUrls", () => {
  test("removes credentials from any scheme", () => {
    expect(scrubUrls("a postgres://u:p@h/d b")).toBe("a [url] b");
    expect(scrubUrls("redis://:pw@cache:6379")).toBe("[url]");
  });

  test("leaves ordinary links and text alone", () => {
    expect(scrubUrls("see https://example.com/docs?a=1 and user@example.com")).toBe("see https://example.com/docs?a=1 and user@example.com");
  });
});

describe("newErrorId", () => {
  test("is short and different each time", () => {
    expect(newErrorId()).toMatch(/^[0-9a-f]{8}$/);
    expect(newErrorId()).not.toBe(newErrorId());
  });
});
