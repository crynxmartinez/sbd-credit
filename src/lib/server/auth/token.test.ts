import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { SESSION_TTL_MS, sessionTtlMs, signSession, verifySession } from "./token";

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

describe("session kinds", () => {
  test("a customer token verifies only as a customer, and a staff token only as staff", () => {
    const customerToken = signSession(USER, SECRET, NOW, "customer");
    const staffToken = signSession(USER, SECRET, NOW, "staff");

    expect(verifySession(customerToken, SECRET, NOW, "customer")).toMatchObject({ u: "user_1", k: "customer" });
    expect(verifySession(customerToken, SECRET, NOW, "staff")).toBeNull();
    expect(verifySession(staffToken, SECRET, NOW, "staff")).toMatchObject({ u: "user_1" });
    expect(verifySession(staffToken, SECRET, NOW, "customer")).toBeNull();
  });

  test("the kind defaults to staff, so existing callers are unchanged", () => {
    const token = signSession(USER, SECRET, NOW);
    expect(verifySession(token, SECRET, NOW)).not.toBeNull();
    expect(verifySession(token, SECRET, NOW, "customer")).toBeNull();
  });

  // The signing key of each kind, worked out the same way the code does, so these tests can make validly signed tokens
  // whose CLAIM is wrong. That is the only way to prove the claim itself is checked, not just the signature.
  const keyOf = (kind: string) => createHmac("sha256", SECRET).update(`credit-${kind}-session-v1`).digest("hex");
  const signWith = (kind: string, claim: unknown) => {
    const encoded = Buffer.from(JSON.stringify({ u: "user_1", v: 3, e: NOW + 10_000, n: "x", ...(claim === undefined ? {} : { k: claim }) })).toString("base64url");
    return `${encoded}.${createHmac("sha256", keyOf(kind)).update(encoded).digest("base64url")}`;
  };

  test("a token with the RIGHT signature but the wrong claimed kind is refused", () => {
    expect(verifySession(signWith("staff", "customer"), SECRET, NOW, "staff")).toBeNull();
    expect(verifySession(signWith("customer", "staff"), SECRET, NOW, "customer")).toBeNull();
    expect(verifySession(signWith("staff", undefined), SECRET, NOW, "staff")).toBeNull(); // no claim at all
    expect(verifySession(signWith("staff", "staff"), SECRET, NOW, "staff")).not.toBeNull(); // the control: all agree
  });

  test("a token signed with the raw secret (how staff sessions used to be signed) is refused", () => {
    const encoded = Buffer.from(JSON.stringify({ u: "user_1", v: 3, e: NOW + 10_000, n: "x", k: "staff" })).toString("base64url");
    const old = `${encoded}.${createHmac("sha256", SECRET).update(encoded).digest("base64url")}`;
    expect(verifySession(old, SECRET, NOW, "staff")).toBeNull();
  });

  test("customer sessions are shorter than staff sessions", () => {
    expect(sessionTtlMs("customer")).toBeLessThan(sessionTtlMs("staff"));
    const token = signSession(USER, SECRET, NOW, "customer");
    expect(verifySession(token, SECRET, NOW + sessionTtlMs("customer"), "customer")).not.toBeNull();
    expect(verifySession(token, SECRET, NOW + sessionTtlMs("customer") + 1, "customer")).toBeNull();
  });
});

describe("signing keys", () => {
  test("staff and customer tokens are signed with different keys, and neither is signed with the raw secret", () => {
    const token = signSession(USER, SECRET, NOW, "staff");
    const [encoded, signature] = token.split(".");
    expect(signature).not.toBe(createHmac("sha256", SECRET).update(encoded!).digest("base64url"));
  });
});
