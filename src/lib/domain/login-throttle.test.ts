import { describe, expect, test } from "vitest";
import { COOLDOWN_CAP_MS, FREE_FAILURES, cooldownAfter, createLoginThrottle } from "./login-throttle";

describe("cooldownAfter", () => {
  test("the first few wrong passwords cost nothing extra: people mistype", () => {
    for (let failures = 0; failures <= FREE_FAILURES; failures += 1) expect(cooldownAfter(failures)).toBe(0);
  });

  test("after that each further failure doubles the wait, up to a ceiling", () => {
    expect(cooldownAfter(FREE_FAILURES + 1)).toBe(2_000);
    expect(cooldownAfter(FREE_FAILURES + 2)).toBe(4_000);
    expect(cooldownAfter(FREE_FAILURES + 3)).toBe(8_000);
    expect(cooldownAfter(FREE_FAILURES + 40)).toBe(COOLDOWN_CAP_MS);
    expect(cooldownAfter(1_000_000)).toBe(COOLDOWN_CAP_MS);
  });

  test("the free count can be raised (the automated tests sign in wrongly on purpose, many times)", () => {
    expect(cooldownAfter(50, 100)).toBe(0);
    expect(cooldownAfter(101, 100)).toBe(2_000);
  });
});

describe("createLoginThrottle", () => {
  function clock(start = 1_000_000) {
    let now = start;
    return { now: () => now, advance: (ms: number) => { now += ms; } };
  }

  test("a key is allowed until it has failed more than the free count", () => {
    const time = clock();
    const throttle = createLoginThrottle({ now: time.now });
    for (let i = 0; i < FREE_FAILURES; i += 1) {
      expect(throttle.check("a|dana").allowed).toBe(true);
      throttle.fail("a|dana");
    }
    expect(throttle.check("a|dana").allowed).toBe(true);
    throttle.fail("a|dana");
    expect(throttle.check("a|dana")).toEqual({ allowed: false, retryAfterMs: 2_000 });
  });

  test("the wait runs out by itself, and the next failure waits twice as long", () => {
    const time = clock();
    const throttle = createLoginThrottle({ now: time.now });
    for (let i = 0; i < FREE_FAILURES + 1; i += 1) throttle.fail("a|dana");
    time.advance(1_999);
    expect(throttle.check("a|dana").allowed).toBe(false);
    time.advance(1);
    expect(throttle.check("a|dana").allowed).toBe(true);
    throttle.fail("a|dana");
    expect(throttle.check("a|dana")).toEqual({ allowed: false, retryAfterMs: 4_000 });
  });

  test("a right password clears the history for that key", () => {
    const throttle = createLoginThrottle({ now: clock().now });
    for (let i = 0; i < 8; i += 1) throttle.fail("a|dana");
    throttle.succeed("a|dana");
    expect(throttle.check("a|dana").allowed).toBe(true);
  });

  test("one person's failures never slow down anyone else: the key is address AND name", () => {
    const throttle = createLoginThrottle({ now: clock().now });
    for (let i = 0; i < 20; i += 1) throttle.fail("attacker-address|dana");
    expect(throttle.check("attacker-address|dana").allowed).toBe(false);
    expect(throttle.check("dana-at-home|dana").allowed).toBe(true); // the real person, from their own address
    expect(throttle.check("attacker-address|someone-else").allowed).toBe(true);
  });

  test("failures are forgotten after a quiet period, so an old mistake does not follow someone around", () => {
    const time = clock();
    const throttle = createLoginThrottle({ now: time.now, forgetAfterMs: 60_000 });
    for (let i = 0; i < 10; i += 1) throttle.fail("a|dana");
    time.advance(COOLDOWN_CAP_MS + 60_001);
    expect(throttle.check("a|dana").allowed).toBe(true);
    throttle.fail("a|dana");
    expect(throttle.check("a|dana").allowed).toBe(true); // counting from one again
  });

  test("memory is bounded: a flood of different keys drops the oldest instead of growing", () => {
    const throttle = createLoginThrottle({ now: clock().now, maxKeys: 3 });
    for (const key of ["k1", "k2", "k3", "k4"]) throttle.fail(key);
    expect(throttle.size()).toBe(3);
  });

  test("checking a key never counts as a failure", () => {
    const throttle = createLoginThrottle({ now: clock().now });
    for (let i = 0; i < 50; i += 1) throttle.check("a|dana");
    expect(throttle.size()).toBe(0);
  });
});
