import { describe, expect, test } from "vitest";
import { SESSION_TTL_MS, signSession, verifySession } from "./token";

const SECRET = "test-secret-value-long-enough-for-hmac";
const USER = { id: "user_1", sessionVersion: 3 };
const NOW = 1_800_000_000_000;

describe("session token", () => {
  test("round-trips a signed token", () => {
    const token = signSession(USER, SECRET, NOW);
    expect(verifySession(token, SECRET, NOW + 1000)).toMatchObject({ u: "user_1", v: 3 });
  });

  test("every token is unique", () => {
    expect(signSession(USER, SECRET, NOW)).not.toBe(signSession(USER, SECRET, NOW));
  });

  test("expires after the session lifetime", () => {
    const token = signSession(USER, SECRET, NOW);
    expect(verifySession(token, SECRET, NOW + SESSION_TTL_MS)).not.toBeNull();
    expect(verifySession(token, SECRET, NOW + SESSION_TTL_MS + 1)).toBeNull();
  });

  test("rejects a token signed with another secret", () => {
    const token = signSession(USER, "a-completely-different-secret-value-x", NOW);
    expect(verifySession(token, SECRET, NOW)).toBeNull();
  });

  test("rejects a tampered payload", () => {
    const token = signSession(USER, SECRET, NOW);
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "admin", v: 1, e: NOW + 10_000, n: "x" })).toString("base64url");
    expect(verifySession(`${forged}.${signature}`, SECRET, NOW)).toBeNull();
  });

  test.each(["", "nodot", ".", "a.b", "....", "e30.AAAA"])("rejects malformed token %j", (token) => {
    expect(verifySession(token, SECRET, NOW)).toBeNull();
  });

  test("refuses a weak secret instead of signing with it", () => {
    expect(() => signSession(USER, "short", NOW)).toThrow(/SESSION_SECRET/);
    expect(() => verifySession("x.y", "short", NOW)).toThrow(/SESSION_SECRET/);
  });
});
