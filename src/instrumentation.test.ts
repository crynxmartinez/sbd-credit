import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * register() runs once at startup. It is the only thing standing between a misconfigured deployment and a server that "works"
 * while doing the wrong thing, so each way it can stop (or not stop) the app is tested.
 */
const logged: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
let problems: string[] = [];
let roleResult: { status: "ok" } | { status: "unsafe"; problems: string[] } | { status: "unknown"; reason: string } = { status: "ok" };
const warmUp = vi.fn(async () => undefined);
const checkDatabaseRole = vi.fn(async () => roleResult);

vi.mock("@/lib/server/env", () => ({ validateEnvironment: () => problems }));
vi.mock("@/lib/server/log", () => ({
  log: (level: string, event: string, fields?: Record<string, unknown>) => logged.push({ level, event, fields }),
  describeError: (error: unknown) => String(error),
}));
vi.mock("@/lib/server/warm-up", () => ({ warmUp: () => warmUp() }));
vi.mock("@/lib/server/role-check", () => ({ checkDatabaseRole: () => checkDatabaseRole() }));

import { onRequestError, register } from "./instrumentation";

beforeEach(() => {
  logged.length = 0;
  problems = [];
  roleResult = { status: "ok" };
  warmUp.mockClear();
  checkDatabaseRole.mockClear();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NEXT_PHASE", "phase-production-server");
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => vi.unstubAllEnvs());

describe("register()", () => {
  test("does nothing on the edge runtime, and nothing while `next build` evaluates the app (no database or secrets there)", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    problems = ["would fail if it ran"];
    await expect(register()).resolves.toBeUndefined();
    expect(logged).toEqual([]);
    expect(checkDatabaseRole).not.toHaveBeenCalled();
  });

  test("REFUSES TO START on an invalid environment, with every problem listed", async () => {
    problems = ["DATABASE_URL is not set.", "SESSION_SECRET is not set."];
    await expect(register()).rejects.toThrow(/DATABASE_URL is not set[\s\S]*SESSION_SECRET is not set/);
    expect(logged.some((entry) => entry.event === "startup.invalid_environment")).toBe(true);
    expect(warmUp).not.toHaveBeenCalled();
  });

  test("in production, REFUSES TO START as a database login that could undo the append-only promises, and says which", async () => {
    roleResult = { status: "unsafe", problems: ["the database login can DELETE ledger rows", "the database login owns the tables"] };
    await expect(register()).rejects.toThrow(/DELETE ledger rows[\s\S]*owns the tables[\s\S]*docs\/PRODUCTION\.md/);
    expect(logged.some((entry) => entry.event === "startup.unsafe_database_role")).toBe(true);
    expect(warmUp).not.toHaveBeenCalled();
  });

  test("a database that cannot be asked yet does NOT stop the app (the health check reports it); it is logged", async () => {
    roleResult = { status: "unknown", reason: "timed out" };
    await expect(register()).resolves.toBeUndefined();
    expect(logged).toContainEqual(expect.objectContaining({ level: "warn", event: "startup.database_role_unchecked" }));
    expect(warmUp).toHaveBeenCalled();
  });

  test("a good production start logs startup.ok, checks the login, and warms up", async () => {
    await register();
    expect(logged.map((entry) => entry.event)).toContain("startup.ok");
    expect(checkDatabaseRole).toHaveBeenCalledTimes(1);
    expect(warmUp).toHaveBeenCalledTimes(1);
  });

  test("outside production the login is not checked (a developer's login is the owner's, by design)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await register();
    expect(checkDatabaseRole).not.toHaveBeenCalled();
    expect(warmUp).toHaveBeenCalled();
  });
});

describe("onRequestError()", () => {
  const request = { path: "/api/customers?search=acme&token=secret", method: "GET", headers: { cookie: "session=abc" } };
  const context = { routerKind: "App Router", routePath: "/api/customers", routeType: "route", renderSource: undefined, revalidateReason: undefined } as never;

  test("logs where it happened and what went wrong, never the query string, headers or cookies", async () => {
    await onRequestError(Object.assign(new Error("boom"), { digest: "d123" }), request as never, context);
    const entry = logged.find((item) => item.event === "request.unhandled_error");
    expect(entry?.fields).toMatchObject({ digest: "d123", method: "GET", path: "/api/customers", routePath: "/api/customers", routeType: "route" });
    expect(JSON.stringify(entry)).not.toMatch(/secret|session=abc|search=acme/);
  });

  test("does nothing on the edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await onRequestError(new Error("boom"), request as never, context);
    expect(logged).toEqual([]);
  });
});
