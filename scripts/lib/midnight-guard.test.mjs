import { describe, expect, test } from "vitest";
import { isTooCloseToMidnight, msUntilBusinessMidnight } from "./midnight-guard.mjs";

// 2026-10-20 is Central Daylight Time (UTC-5).
describe("msUntilBusinessMidnight", () => {
  test("counts to midnight in the business zone, not the machine's", () => {
    expect(msUntilBusinessMidnight(new Date("2026-10-21T04:59:00Z"), "America/Chicago")).toBe(60_000);
    expect(msUntilBusinessMidnight(new Date("2026-10-20T05:00:00Z"), "America/Chicago")).toBe(24 * 3600_000);
    expect(msUntilBusinessMidnight(new Date("2026-10-20T17:00:00Z"), "America/Chicago")).toBe(12 * 3600_000);
  });
  test("is exact to the millisecond", () => {
    expect(msUntilBusinessMidnight(new Date("2026-10-21T04:59:59.250Z"), "America/Chicago")).toBe(750);
  });
});

describe("isTooCloseToMidnight", () => {
  test("is true inside the window and false outside it", () => {
    expect(isTooCloseToMidnight(new Date("2026-10-21T04:55:00Z"), 10 * 60_000, "America/Chicago")).toBe(true);
    expect(isTooCloseToMidnight(new Date("2026-10-21T04:45:00Z"), 10 * 60_000, "America/Chicago")).toBe(false);
  });
  test("just after midnight is a whole day away", () => {
    expect(isTooCloseToMidnight(new Date("2026-10-21T05:01:00Z"), 10 * 60_000, "America/Chicago")).toBe(false);
  });
});
