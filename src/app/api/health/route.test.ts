import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const queries: string[] = [];
let behaviour: "ok" | "fail" | "hang" = "ok";
vi.mock("@/lib/server/db", () => ({
  prisma: {
    $queryRaw: (strings: TemplateStringsArray) => {
      queries.push(strings.join("?"));
      if (behaviour === "fail") return Promise.reject(new Error('relation "LedgerEntry" does not exist at db.internal.example:5432'));
      if (behaviour === "hang") return new Promise(() => undefined);
      return Promise.resolve([{}]);
    },
  },
}));
const logged: Array<{ event: string }> = [];
vi.mock("@/lib/server/log", () => ({ log: (_level: string, event: string) => logged.push({ event }) }));

import { resetHealthCacheForTests } from "@/lib/server/health";
import { GET } from "./route";

beforeEach(() => {
  queries.length = 0;
  logged.length = 0;
  behaviour = "ok";
  resetHealthCacheForTests();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("GET /api/health", () => {
  test("is healthy when the database answers a query on the tables the app actually uses (not just SELECT 1)", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", checks: { database: "ok" } });
    // A database with no migrations applied, or with a grant missing, must NOT look healthy.
    expect(queries[0]).toContain('"AppUser"');
    expect(queries[0]).toContain('"LedgerEntry"');
    expect(queries[0]).toContain('"CustomerUser"');
  });

  test("is 503 with exactly the degraded body, and no error text, when the query fails", async () => {
    behaviour = "fail";
    const response = await GET();
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: "degraded", checks: { database: "error" } });
    expect(text).not.toMatch(/LedgerEntry|db\.internal|relation/); // nothing about the database leaks
    expect(logged.map((entry) => entry.event)).toContain("health.database_unreachable");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("is 503 after the time limit when the database never answers, instead of hanging", async () => {
    behaviour = "hang";
    const pending = GET();
    await vi.advanceTimersByTimeAsync(3_001);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "degraded", checks: { database: "error" } });
  });

  test("a crowd of probes costs ONE query: the answer is shared for a few seconds", async () => {
    await Promise.all(Array.from({ length: 20 }, () => GET()));
    await GET();
    expect(queries).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_001);
    await GET();
    expect(queries).toHaveLength(2);
  });

  test("a failure is shared too, but only briefly, so recovery is noticed quickly", async () => {
    behaviour = "fail";
    await GET();
    await GET();
    expect(queries).toHaveLength(1);
    behaviour = "ok";
    await vi.advanceTimersByTimeAsync(2_001);
    expect((await GET()).status).toBe(200);
  });
});
