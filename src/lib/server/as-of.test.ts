import { describe, expect, test } from "vitest";
import { businessToday } from "./as-of";

const ZONE = "America/Chicago";
const NOW = new Date("2026-10-13T03:00:00Z"); // 10pm on 12 Oct in Chicago, already the 13th in UTC

describe("businessToday", () => {
  test("is the calendar day in the business time zone, not the UTC day", () => {
    expect(businessToday(NOW, ZONE)).toBe("2026-10-12");
    expect(businessToday(new Date("2026-10-13T06:00:00Z"), ZONE)).toBe("2026-10-13");
  });

  test("moves with the zone", () => {
    expect(businessToday(NOW, "Asia/Manila")).toBe("2026-10-13");
  });

  test("stays correct across the autumn clock change (Chicago falls back at 2:00 CDT = 07:00 UTC on 1 Nov 2026)", () => {
    expect(businessToday(new Date("2026-11-01T04:30:00Z"), ZONE)).toBe("2026-10-31"); // 11:30pm CDT
    expect(businessToday(new Date("2026-11-01T05:30:00Z"), ZONE)).toBe("2026-11-01"); // 12:30am CDT
    // After the change the offset is UTC-6, so the evening of the 1st lasts until 06:00 UTC on the 2nd.
    expect(businessToday(new Date("2026-11-02T05:59:00Z"), ZONE)).toBe("2026-11-01"); // 11:59pm CST
    expect(businessToday(new Date("2026-11-02T06:01:00Z"), ZONE)).toBe("2026-11-02"); // 12:01am CST
  });
});
