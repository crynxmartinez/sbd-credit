import { describe, expect, test } from "vitest";
import {
  addDays,
  dbDateToIso,
  diffDays,
  isInClosedMonth,
  dueDateFor,
  formatDate,
  isoToDbDate,
  isValidISODate,
  termDays,
  todayISO,
} from "./dates";

describe("todayISO", () => {
  test("uses the LOCAL calendar day, not the UTC day, whatever zone the tests run in", () => {
    // A stand-in for 11pm on 12 Oct in a UTC-5 zone: local parts say the 12th while the UTC instant is already the 13th.
    // An implementation built on toISOString() would answer the 13th and fail, even on a machine set to UTC.
    const lateEvening = {
      getFullYear: () => 2026,
      getMonth: () => 9,
      getDate: () => 12,
      toISOString: () => "2026-10-13T04:00:00.000Z",
    } as unknown as Date;
    expect(todayISO(lateEvening)).toBe("2026-10-12");
  });

  test("pads month and day", () => {
    expect(todayISO(new Date(2026, 0, 5, 9, 0, 0))).toBe("2026-01-05");
  });
});

describe("isValidISODate", () => {
  test.each(["2026-10-13", "2024-02-29"])("accepts %s", (v) => expect(isValidISODate(v)).toBe(true));
  test.each(["2026-02-30", "2026-13-01", "2026-1-1", "10/13/2026", "", "2026-10-13T00:00:00Z", "2025-02-29"])(
    "rejects %s",
    (v) => expect(isValidISODate(v)).toBe(false),
  );
});

describe("year bounds", () => {
  test("absurd dates cannot reach the database", () => {
    expect(isValidISODate("9999-12-31")).toBe(false);
    expect(isValidISODate("1999-12-31")).toBe(false);
    expect(isValidISODate("2000-01-01")).toBe(true);
    expect(isValidISODate("2100-12-31")).toBe(true);
  });
});

describe("addDays / diffDays", () => {
  test("adds across month and year boundaries", () => {
    expect(addDays("2026-10-13", 30)).toBe("2026-11-12");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  test("diffDays is signed and DST-proof", () => {
    expect(diffDays("2026-10-13", "2026-10-20")).toBe(7);
    expect(diffDays("2026-10-20", "2026-10-13")).toBe(-7);
    expect(diffDays("2026-03-07", "2026-03-09")).toBe(2); // spans a US DST change
    expect(diffDays("2026-10-13", "2026-10-13")).toBe(0);
  });
});

describe("termDays / dueDateFor", () => {
  test.each([
    ["Net 15", 15],
    ["Net 30", 30],
    ["Net 90", 90],
    ["Due on receipt", 0],
    ["COD", 0],
  ])("%s is %i days", (terms, days) => expect(termDays(terms)).toBe(days));

  test("unknown terms fall back to 30 days", () => {
    expect(termDays("Whatever")).toBe(30);
  });

  test("due date is entry date plus terms", () => {
    expect(dueDateFor("2026-10-13", "Net 30")).toBe("2026-11-12");
    expect(dueDateFor("2026-10-13", "COD")).toBe("2026-10-13");
  });
});

describe("formatDate", () => {
  test("formats without involving the time zone", () => {
    expect(formatDate("2026-10-13")).toBe("Oct 13, 2026");
    expect(formatDate("2026-01-05")).toBe("Jan 5, 2026");
  });

  test("shows a dash when empty", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("")).toBe("—");
  });
});

describe("database date mapping", () => {
  test("round-trips an ISO date through a UTC-midnight Date", () => {
    const stored = isoToDbDate("2026-10-13");
    expect(stored.toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(dbDateToIso(stored)).toBe("2026-10-13");
  });

  test("returns null for missing values", () => {
    expect(dbDateToIso(null)).toBeNull();
  });
});

describe("isInClosedMonth", () => {
  test("an entry from an earlier month is closed; this month and later are open", () => {
    expect(isInClosedMonth("2026-09-30", "2026-10-01")).toBe(true);
    expect(isInClosedMonth("2026-10-01", "2026-10-31")).toBe(false);
    expect(isInClosedMonth("2026-11-02", "2026-10-13")).toBe(false);
  });

  test("works across a year boundary", () => {
    expect(isInClosedMonth("2025-12-31", "2026-01-01")).toBe(true);
    expect(isInClosedMonth("2026-01-01", "2026-01-31")).toBe(false);
  });
});
