import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The attributes a session cookie carries are what keep it out of scripts (HttpOnly), out of cross-site requests (SameSite), and off
 * plain http (Secure, and the __Host- prefix). Nothing else would notice if one of them were dropped, so they are asserted here.
 */
interface Call {
  name: string;
  value: string;
  options: Record<string, unknown>;
}
const calls: Call[] = [];
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: (name: string, value: string, options: Record<string, unknown>) => calls.push({ name, value, options }),
  }),
}));

import { clearSessionCookie, setSessionCookie } from "./session-cookies";

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("SESSION_SECRET", "a-session-secret-long-enough-for-the-tests-1234");
});
afterEach(() => vi.unstubAllEnvs());

describe("a session cookie in PRODUCTION", () => {
  test("is HttpOnly, Secure, SameSite=Lax, path / and carries the __Host- prefix (which a browser enforces)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await setSessionCookie("staff", { id: "u1", sessionVersion: 1 });
    const set = calls.find((call) => call.value !== "")!;
    expect(set.name).toBe("__Host-credit_session");
    expect(set.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(set.options.domain).toBeUndefined(); // a __Host- cookie must not name a domain
  });

  test("a customer's cookie is separate, with its own name, the same attributes, and a shorter life", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await setSessionCookie("customer", { id: "k1", sessionVersion: 1 });
    const set = calls.find((call) => call.value !== "")!;
    expect(set.name).toBe("__Host-credit_portal_session");
    expect(set.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    const staff = (await (async () => {
      calls.length = 0;
      await setSessionCookie("staff", { id: "u1", sessionVersion: 1 });
      return calls.find((call) => call.value !== "")!;
    })());
    expect(set.options.maxAge as number).toBeLessThan(staff.options.maxAge as number);
  });

  test("removing a cookie carries the SAME attributes (a __Host- cookie can only be removed by a Secure Set-Cookie)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await clearSessionCookie("staff");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "__Host-credit_session", value: "" });
    expect(calls[0]!.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  });

  test("starting one kind of session removes the other kind's cookie in the same step", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await setSessionCookie("customer", { id: "k1", sessionVersion: 1 });
    expect(calls.some((call) => call.name === "__Host-credit_session" && call.value === "" && call.options.maxAge === 0)).toBe(true);
  });
});

describe("a session cookie in DEVELOPMENT", () => {
  test("is still HttpOnly and SameSite=Lax, but not Secure (plain http://127.0.0.1) and without the __Host- prefix", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await setSessionCookie("staff", { id: "u1", sessionVersion: 1 });
    const set = calls.find((call) => call.value !== "")!;
    expect(set.name).toBe("credit_session");
    expect(set.options).toMatchObject({ httpOnly: true, secure: false, sameSite: "lax", path: "/" });
  });
});
