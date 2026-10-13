import { describe, expect, test } from "vitest";
import { formatCents, parseMoneyToCents, sumCents } from "./money";

describe("parseMoneyToCents", () => {
  test.each([
    ["1234", 123400],
    ["1,234.56", 123456],
    ["$1,234.5", 123450],
    ["  0.07 ", 7],
    ["0", 0],
    [".5", 50],
    [12.34, 1234],
    [0.1 + 0.2, 30], // float noise must not leak into stored cents
    [1000, 100000],
  ])("parses %s as %i cents", (input, expected) => {
    expect(parseMoneyToCents(input)).toBe(expected);
  });

  test.each(["", "   ", "abc", "1.234", "1,23,4x", "$", "1e5", "--5", null, undefined, NaN, Infinity])(
    "rejects %s",
    (input) => {
      expect(parseMoneyToCents(input as never)).toBeNull();
    },
  );

  test.each(["1,23,4", "12,34", "1,2345", ",100", "1,,000"])("rejects misplaced thousands separators in %s", (input) => {
    expect(parseMoneyToCents(input)).toBeNull();
  });

  test.each([
    ["1,234", 123400],
    ["1,234,567.89", 123456789],
    ["999", 99900],
  ])("accepts well-formed thousands separators in %s", (input, cents) => {
    expect(parseMoneyToCents(input)).toBe(cents);
  });

  test("rejects negatives unless allowed", () => {
    expect(parseMoneyToCents("-5")).toBeNull();
    expect(parseMoneyToCents("-5.25", { allowNegative: true })).toBe(-525);
    expect(parseMoneyToCents(-5.25, { allowNegative: true })).toBe(-525);
  });

  test("rejects amounts above the cap", () => {
    expect(parseMoneyToCents("10000000.00")).toBe(1_000_000_000);
    expect(parseMoneyToCents("10000000.01")).toBeNull();
  });
});

describe("formatCents", () => {
  test("drops .00 for whole dollars by default", () => {
    expect(formatCents(2500000)).toBe("$25,000");
    expect(formatCents(0)).toBe("$0");
  });

  test("keeps real cents", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(5)).toBe("$0.05");
  });

  test("fixed mode always shows two decimals", () => {
    expect(formatCents(2500000, { fixed: true })).toBe("$25,000.00");
  });

  test("formats negatives with a leading sign", () => {
    expect(formatCents(-1250)).toBe("-$12.50");
  });

  test("shows a dash for a broken amount instead of passing it off as $0", () => {
    expect(formatCents(NaN)).toBe("—");
    expect(formatCents(Infinity)).toBe("—");
    expect(formatCents(0)).toBe("$0");
  });
});

describe("sumCents", () => {
  test("adds without float drift", () => {
    expect(sumCents([10, 20])).toBe(30);
    expect(sumCents([])).toBe(0);
  });
});
