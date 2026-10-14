import { describe, expect, test } from "vitest";
import { MIN_PASSWORD_LENGTH, normalizeIdentifier, normalizeUsername, validateNewUser, validatePassword } from "./users";

const good = { username: "dana.whitfield", name: "Dana Whitfield", role: "ADMIN", password: "correct-horse-battery-9" };

describe("validateNewUser", () => {
  test("accepts a well-formed user", () => {
    expect(validateNewUser(good)).toEqual([]);
  });

  test.each(["ab", "has space", "UPPER_OK_BUT_TOO_LONG_" + "x".repeat(20), "-leading-dash", "semi;colon", "émile", ""])(
    "refuses the username %j",
    (username) => {
      expect(validateNewUser({ ...good, username }).join(" ")).toMatch(/username/);
    },
  );

  test("usernames are compared case-insensitively", () => {
    expect(validateNewUser({ ...good, username: "Dana.Whitfield" })).toEqual([]);
    expect(normalizeUsername("  Dana.Whitfield ")).toBe("dana.whitfield");
  });

  test("refuses an unknown role, including the wrong case", () => {
    expect(validateNewUser({ ...good, role: "OWNER" }).join(" ")).toMatch(/role/);
    expect(validateNewUser({ ...good, role: "admin" }).join(" ")).toMatch(/role/);
  });

  test("refuses an empty or oversized name", () => {
    expect(validateNewUser({ ...good, name: "  " }).join(" ")).toMatch(/name/);
    expect(validateNewUser({ ...good, name: "x".repeat(121) }).join(" ")).toMatch(/name/);
  });

  test("reports every problem at once", () => {
    expect(validateNewUser({ username: "x", name: "", role: "no", password: "short" }).length).toBeGreaterThanOrEqual(4);
  });
});

describe("validatePassword", () => {
  test(`needs at least ${MIN_PASSWORD_LENGTH} characters`, () => {
    expect(validatePassword("a1b2c3d4e5f", "u").join(" ")).toMatch(/at least/);
    expect(validatePassword("a1b2c3d4e5f6", "u")).toEqual([]);
  });

  test("must not contain the username", () => {
    expect(validatePassword("dana.whitfield-2026!", "dana.whitfield").join(" ")).toMatch(/username/);
    expect(validatePassword("DANA.WHITFIELD-2026!", "dana.whitfield").join(" ")).toMatch(/username/);
  });

  test("refuses a repetitive password", () => {
    expect(validatePassword("aaaaaaaaaaaaaaaa", "u").join(" ")).toMatch(/repetitive/);
    expect(validatePassword("abababababababab", "u").join(" ")).toMatch(/repetitive/);
  });

  test("refuses an absurdly long one", () => {
    expect(validatePassword("ab12".repeat(60), "u").join(" ")).toMatch(/at most/);
  });
});

describe("passwords longer than the hash can use", () => {
  test("a password over 72 bytes is refused: bcrypt would silently ignore the rest, so two long passwords could match", () => {
    expect(validatePassword("a1".repeat(36) + "x", "u").join(" ")).toMatch(/at most 72 bytes/);
    expect(validatePassword("a1b2c3d4e5f6".repeat(6), "u")).toEqual([]);
  });

  test("it counts bytes, not characters", () => {
    expect(validatePassword("é1".repeat(25) + "ab", "u").join(" ")).toMatch(/at most 72/);
  });
});

describe("normalizeIdentifier", () => {
  test("trims, lower-cases and folds look-alike characters, so one person is one account however it was typed", () => {
    expect(normalizeIdentifier("  Bob@X.com ")).toBe("bob@x.com");
    expect(normalizeIdentifier("ＢＯＢ＠Ｘ．ｃｏｍ")).toBe("bob@x.com");
    expect(normalizeIdentifier("Dana.Whitfield")).toBe("dana.whitfield");
  });
});
