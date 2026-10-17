import { describe, expect, test } from "vitest";
import { ALERT_FAILURES, ALERT_WINDOW_MS, afterSuccess, createFailureWatch, isLocked } from "./lockout";

const NOW = new Date("2026-10-13T12:00:00Z");

describe("lockout", () => {
  test("a lock that is already on a row is honoured until it runs out, and no lock means not locked", () => {
    expect(isLocked({ failedLogins: 0, lockedUntil: null }, NOW)).toBe(false);
    expect(isLocked({ failedLogins: 5, lockedUntil: new Date(NOW.getTime() + 1) }, NOW)).toBe(true);
    expect(isLocked({ failedLogins: 5, lockedUntil: new Date(NOW.getTime()) }, NOW)).toBe(false);
    expect(isLocked({ failedLogins: 5, lockedUntil: new Date(NOW.getTime() - 1) }, NOW)).toBe(false);
  });

  test("a successful sign-in clears the count and any lock", () => {
    expect(afterSuccess()).toEqual({ failedLogins: 0, lockedUntil: null });
  });

  describe("createFailureWatch: a guessing run against ONE account is noticed from any number of addresses", () => {
    const clock = () => {
      let now = 1_000_000;
      return { now: () => now, advance: (ms: number) => { now += ms; } };
    };

    test("raises the alarm when an account has failed enough times within the window, never on the first few", () => {
      const time = clock();
      const watch = createFailureWatch({ now: time.now });
      for (let i = 1; i < ALERT_FAILURES; i += 1) expect(watch.record("dana")).toBe(false);
      expect(watch.record("dana")).toBe(true);
    });

    test("says so once per window, not on every failure after it", () => {
      const time = clock();
      const watch = createFailureWatch({ now: time.now });
      for (let i = 0; i < ALERT_FAILURES; i += 1) watch.record("dana");
      for (let i = 0; i < 50; i += 1) expect(watch.record("dana")).toBe(false);
      time.advance(ALERT_WINDOW_MS + 1);
      for (let i = 1; i < ALERT_FAILURES; i += 1) expect(watch.record("dana")).toBe(false);
      expect(watch.record("dana")).toBe(true); // a new run, a new alarm
    });

    test("slow, scattered failures never add up: only a burst inside the window counts", () => {
      const time = clock();
      const watch = createFailureWatch({ now: time.now });
      for (let i = 0; i < ALERT_FAILURES * 3; i += 1) {
        expect(watch.record("dana")).toBe(false);
        time.advance(ALERT_WINDOW_MS / (ALERT_FAILURES - 2));
      }
    });

    test("accounts are counted separately, and a good sign-in clears the count", () => {
      const watch = createFailureWatch({ now: clock().now });
      for (let i = 1; i < ALERT_FAILURES; i += 1) watch.record("dana");
      expect(watch.record("someone-else")).toBe(false);
      watch.clear("dana");
      expect(watch.record("dana")).toBe(false);
    });

    test("memory is bounded", () => {
      const watch = createFailureWatch({ now: clock().now, maxKeys: 3 });
      for (const key of ["a", "b", "c", "d"]) watch.record(key);
      expect(watch.size()).toBe(3);
    });
  });
});
