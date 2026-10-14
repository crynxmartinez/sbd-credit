import { describe, expect, test } from "vitest";
import { hashInviteToken, newInviteToken } from "./invite-token";

describe("invite tokens", () => {
  test("are long, URL-safe and different every time", () => {
    const a = newInviteToken();
    const b = newInviteToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes
    expect(a.token).not.toBe(b.token);
  });

  test("only a hash is kept: it is deterministic, and is not the token", () => {
    const { token, hash } = newInviteToken();
    expect(hashInviteToken(token)).toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
  });

  test("a different token never has the same hash", () => {
    expect(hashInviteToken("a")).not.toBe(hashInviteToken("b"));
  });
});
