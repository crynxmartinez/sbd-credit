import { NextRequest } from "next/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const acceptInvite = vi.fn(async () => undefined);
vi.mock("@/lib/server/services/portal-access", () => ({ acceptInvite: (...args: unknown[]) => acceptInvite(...(args as [])) }));

// Imported once. Each test uses its OWN address, so one test's attempts cannot count against another's.
const { POST } = (await import("./route")) as { POST: (request: NextRequest) => Promise<Response> };

const TOKEN = "A".repeat(43);
const post = (_post: unknown, body: unknown, address: string) =>
  POST(
    new NextRequest("http://app.example/api/portal/accept", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://app.example", host: "app.example", "x-forwarded-for": address },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  acceptInvite.mockClear();
});

describe("accepting an invitation", () => {
  test("a valid-looking link and password reach the service", async () => {
    const response = await post(POST, { token: TOKEN, password: "a-good-long-password-1" }, "203.0.113.21");
    expect(response.status).toBe(200);
    expect(acceptInvite).toHaveBeenCalledWith(TOKEN, "a-good-long-password-1");
  });

  test("anything that cannot be a real link is refused without touching the service (no database work, no hashing)", async () => {
    for (const token of ["", "short", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}!`, "A".repeat(43) + "\\n"]) {
      expect((await post(POST, { token, password: "a-good-long-password-1" }, "203.0.113.22")).status, JSON.stringify(token)).toBe(400);
    }
    expect(acceptInvite).not.toHaveBeenCalled();
  });

  test("one address gets 20 tries in ten minutes, then is told to wait: each try costs a password hash", async () => {
    for (let i = 0; i < 20; i += 1) expect((await post(POST, { token: TOKEN, password: "a-good-long-password-1" }, "203.0.113.23")).status).toBe(200);
    const blocked = await post(POST, { token: TOKEN, password: "a-good-long-password-1" }, "203.0.113.23");
    expect(blocked.status).toBe(429);
    expect(acceptInvite).toHaveBeenCalledTimes(20);
    expect((await post(POST, { token: TOKEN, password: "a-good-long-password-1" }, "198.51.100.7")).status).toBe(200); // someone else is fine
  });

  test("an IPv6 /64 shares one allowance", async () => {
    for (let i = 0; i < 20; i += 1) await post(POST, { token: TOKEN, password: "a-good-long-password-1" }, `2001:db8:9:9::${i + 1}`);
    expect((await post(POST, { token: TOKEN, password: "a-good-long-password-1" }, "2001:db8:9:9:aaaa::1")).status).toBe(429);
  });

  test("a request from another site is refused", async () => {
    const response = await POST(
      new NextRequest("http://app.example/api/portal/accept", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example", host: "app.example" },
        body: JSON.stringify({ token: TOKEN, password: "a-good-long-password-1" }),
      }),
    );
    expect(response.status).toBe(403);
  });
});
