import { NextRequest } from "next/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The sign-in route's own behaviour: its two rate limits, what it logs, and what it starts. The password check itself is
 * replaced by a stand-in (it is tested against a real database elsewhere), so these run in milliseconds.
 */
const authenticateAny = vi.fn();
const startSession = vi.fn(async () => undefined);
const startCustomerSession = vi.fn(async () => undefined);
const logged: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];

vi.mock("@/lib/server/auth/login", async () => {
  const { ApiError } = await import("@/lib/server/http");
  class LoginFailure extends ApiError {
    constructor(readonly reason: string, readonly kind: string | null, readonly userId: string | null) {
      super(401, "bad_login", "Incorrect username or password, or too many recent attempts.");
    }
  }
  return { authenticateAny: (...args: unknown[]) => authenticateAny(...args), LoginFailure };
});
vi.mock("@/lib/server/auth/current-user", () => ({ startSession: (...args: unknown[]) => startSession(...(args as [])) }));
vi.mock("@/lib/server/auth/customer-session", () => ({ startCustomerSession: (...args: unknown[]) => startCustomerSession(...(args as [])) }));
vi.mock("@/lib/server/log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/log")>()),
  log: (level: string, event: string, fields: Record<string, unknown> = {}) => logged.push({ level, event, fields }),
}));

// Imported once. Each test uses its OWN address (and names), so one test's attempts cannot count against another's.
const { POST } = (await import("./route")) as { POST: (request: NextRequest) => Promise<Response> };

const attempt = (_post: unknown, username: string, address: string) =>
  POST(
    new NextRequest("http://app.example/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://app.example", host: "app.example", "x-forwarded-for": address },
      body: JSON.stringify({ username, password: "whatever-password-1" }),
    }),
  );

async function failingLogin() {
  const { LoginFailure } = await import("@/lib/server/auth/login");
  authenticateAny.mockImplementation(async () => {
    throw new (LoginFailure as unknown as new (reason: string, kind: string | null, userId: string | null) => Error)("bad_password", "staff", "u1");
  });
}

beforeEach(() => {
  authenticateAny.mockReset();
  startSession.mockClear();
  startCustomerSession.mockClear();
  logged.length = 0;
});

describe("sign-in rate limits", () => {
  test("the same address trying MANY accounts is stopped after 20 tries in total", async () => {
    await failingLogin();
    for (let i = 0; i < 20; i += 1) expect((await attempt(POST, `person${i}@example.com`, "203.0.113.12")).status).toBe(401);
    expect((await attempt(POST, "person99@example.com", "203.0.113.12")).status).toBe(429);
  });

  test("after a few wrong passwords the next try must WAIT, and the wait is told in seconds (nobody is locked out)", async () => {
    await failingLogin();
    const ip = "203.0.113.31";
    for (let i = 0; i < 4; i += 1) expect((await attempt(POST, "dana4@example.com", ip)).status).toBe(401);
    const waiting = await attempt(POST, "dana4@example.com", ip);
    expect(waiting.status).toBe(429);
    expect(((await waiting.json()) as { error: { message: string } }).error.message).toMatch(/wait \d+ seconds/);
    expect(authenticateAny).toHaveBeenCalledTimes(4); // the password check is not even run while waiting
  });

  test("the wait is per ADDRESS and name: a stranger's failures never slow the real person down", async () => {
    await failingLogin();
    for (let i = 0; i < 6; i += 1) await attempt(POST, "dana5@example.com", "203.0.113.32"); // the stranger, now waiting
    expect((await attempt(POST, "dana5@example.com", "203.0.113.32")).status).toBe(429);

    authenticateAny.mockResolvedValueOnce({ kind: "staff", user: { id: "s5", name: "Dana" } });
    const realPerson = await attempt(POST, "dana5@example.com", "198.51.100.32"); // same name, their own address
    expect(realPerson.status).toBe(200);
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  test("the wait is the same for a name that does not exist, so it tells a guesser nothing", async () => {
    await failingLogin();
    for (let i = 0; i < 4; i += 1) await attempt(POST, "no-such-person@example.com", "203.0.113.33");
    expect((await attempt(POST, "no-such-person@example.com", "203.0.113.33")).status).toBe(429);
  });

  test("a right password clears the count", async () => {
    await failingLogin();
    const ip = "203.0.113.34";
    for (let i = 0; i < 3; i += 1) await attempt(POST, "dana6@example.com", ip);
    authenticateAny.mockResolvedValueOnce({ kind: "staff", user: { id: "s6", name: "Dana" } });
    expect((await attempt(POST, "dana6@example.com", ip)).status).toBe(200);
    await failingLogin();
    for (let i = 0; i < 3; i += 1) expect((await attempt(POST, "dana6@example.com", ip)).status).toBe(401); // free again
  });

  test("another address is not affected by someone else's limit, and the account is not locked for everybody", async () => {
    await failingLogin();
    for (let i = 0; i < 11; i += 1) await attempt(POST, "dana2@example.com", "203.0.113.13");
    expect((await attempt(POST, "dana2@example.com", "198.51.100.14")).status).toBe(401); // reached the password check
  });

  test("every address in one IPv6 /64 is ONE person, so rotating through it does not dodge the limit", async () => {
    await failingLogin();
    for (let i = 0; i < 20; i += 1) await attempt(POST, `p${i}@example.com`, `2001:db8:1:2::${i + 1}`);
    expect((await attempt(POST, "p99@example.com", "2001:db8:1:2:ffff::1")).status).toBe(429);
    expect((await attempt(POST, "p99@example.com", "2001:db8:1:3::1")).status).toBe(401); // a different /64
  });
});

describe("what sign-in records", () => {
  test("a failure is logged with its reason and who, but NEVER the name that was typed", async () => {
    await failingLogin();
    await attempt(POST, "someone.secret@example.com", "203.0.113.15");
    const event = logged.find((entry) => entry.event === "auth.login_failed");
    expect(event).toMatchObject({ level: "warn", fields: { reason: "bad_password", kind: "staff", userId: "u1" } });
    expect(JSON.stringify(logged)).not.toContain("someone.secret");
    expect(JSON.stringify(logged)).not.toContain("whatever-password-1");
  });

  test("the response says the same thing whatever the reason", async () => {
    await failingLogin();
    const response = await attempt(POST, "dana3@example.com", "203.0.113.16");
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: "bad_login", message: "Incorrect username or password, or too many recent attempts." });
  });

  test("a staff sign-in starts a staff session, and a customer sign-in starts a customer one", async () => {
    authenticateAny.mockResolvedValueOnce({ kind: "staff", user: { id: "s1", name: "Dana" } });
    const staff = await attempt(POST, "dana", "203.0.113.17");
    expect(((await staff.json()) as { data: { kind: string } }).data.kind).toBe("staff");
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startCustomerSession).not.toHaveBeenCalled();

    authenticateAny.mockResolvedValueOnce({ kind: "customer", user: { id: "k1", name: "Pat" } });
    const customer = await attempt(POST, "pat@example.com", "203.0.113.18");
    expect(((await customer.json()) as { data: { kind: string } }).data.kind).toBe("customer");
    expect(startCustomerSession).toHaveBeenCalledTimes(1);
    expect(logged.filter((entry) => entry.event === "auth.login_ok")).toHaveLength(2);
  });

  test("a request from another site is refused before anything else happens", async () => {
    const response = await POST(
      new NextRequest("http://app.example/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example", host: "app.example" },
        body: JSON.stringify({ username: "dana", password: "x" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(authenticateAny).not.toHaveBeenCalled();
  });
});
