import { describe, expect, test } from "vitest";
import { attemptLimit } from "./limits";

describe("attemptLimit", () => {
  test("uses the default when nothing is set, or the value is not a positive whole number", () => {
    for (const value of [undefined, "", "abc", "-5", "0", "2.5"]) expect(attemptLimit(value, 20, false), String(value)).toBe(20);
  });

  test("outside production a whole number overrides the default (the test suite signs in far more than a person does)", () => {
    expect(attemptLimit("10000", 20, false)).toBe(10000);
  });

  test("in production the override is IGNORED: a leftover test setting must not switch the limit off", () => {
    expect(attemptLimit("10000", 20, true)).toBe(20);
  });
});
