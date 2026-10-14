import { describe, expect, test } from "vitest";
import { centsToDecimal, toCsv } from "./csv";

describe("toCsv", () => {
  test("joins rows with CRLF and ends with a newline", () => {
    expect(toCsv([["a", "b"], ["c", "d"]])).toBe("a,b\r\nc,d\r\n");
  });

  test("quotes commas, quotes and line breaks", () => {
    expect(toCsv([['Smith, "Bob"', "line1\nline2"]])).toBe('"Smith, ""Bob""","line1\nline2"\r\n');
  });

  test("renders null and undefined as empty", () => {
    expect(toCsv([[null, undefined, 0]])).toBe(",,0\r\n");
  });

  test.each(["=SUM(A1)", "+1", "-1+2", "@cmd", "\tx"])("defuses the formula-looking text %j", (text) => {
    expect(toCsv([[text]]).startsWith(`'${text}`.replace(/^'(.*)$/, "'$1"))).toBe(true);
  });

  test("leaves real negative numbers alone, whether numbers or numeric strings", () => {
    expect(toCsv([[-5]])).toBe("-5\r\n");
    expect(toCsv([[centsToDecimal(-3000)]])).toBe("-30.00\r\n");
  });

  test("still defuses a minus sign followed by a formula", () => {
    expect(toCsv([["-1+2"]])).toBe("'-1+2\r\n");
    expect(toCsv([["-"]])).toBe("'-\r\n");
  });
});

describe("centsToDecimal", () => {
  test.each([
    [123456, "1234.56"],
    [5, "0.05"],
    [0, "0.00"],
    [-1250, "-12.50"],
  ])("%i -> %s", (cents, text) => expect(centsToDecimal(cents)).toBe(text));
});

describe("phone numbers", () => {
  test("a phone number that starts with + is data, not a formula, so it is left exactly as typed", () => {
    expect(toCsv([["+1 (555) 201-4410"]])).toBe("+1 (555) 201-4410\r\n");
    expect(toCsv([["+44 20 7946 0958"]])).toBe("+44 20 7946 0958\r\n");
  });

  test("but anything with a + that could be a formula is still defused", () => {
    expect(toCsv([["+1+2"]])).toBe("'+1+2\r\n");
    expect(toCsv([["+HYPERLINK(\"x\")"]]).startsWith("\"'+HYPERLINK")).toBe(true);
  });
});
