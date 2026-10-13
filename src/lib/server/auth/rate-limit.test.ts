import { describe, expect, test } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  test("allows up to the limit, then refuses until the window passes", () => {
    let now = 1_000;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });

    expect([1, 2, 3].map(() => limiter.take("ip-a"))).toEqual([true, true, true]);
    expect(limiter.take("ip-a")).toBe(false);

    now += 60_001;
    expect(limiter.take("ip-a")).toBe(true);
  });

  test("counts each key separately", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("b")).toBe(true);
    expect(limiter.take("a")).toBe(false);
  });

  test("a sliding window frees capacity gradually", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 100, now: () => now });
    limiter.take("k");
    now = 60;
    limiter.take("k");
    expect(limiter.take("k")).toBe(false);
    now = 120; // the first hit has aged out, the second has not
    expect(limiter.take("k")).toBe(true);
    expect(limiter.take("k")).toBe(false);
  });

  test("forgets idle keys so memory cannot grow without bound", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 100, now: () => now, maxKeys: 3 });
    ["a", "b", "c"].forEach((key) => limiter.take(key));
    now = 500;
    limiter.take("d");
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });
});
