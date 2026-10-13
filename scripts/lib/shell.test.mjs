import { describe, expect, test } from "vitest";
import { joinCommand, quoteArg } from "./shell.mjs";

describe("quoteArg", () => {
  test.each(["next", "-p", "3200", "scripts/users.ts", "C:/Code/file.ts", "--config=vitest.int.config.mts", "a_b-c.d"])(
    "leaves the plain argument %s alone",
    (argument) => {
      expect(quoteArg(argument)).toBe(argument);
    },
  );

  test("keeps an argument with spaces in one piece", () => {
    expect(quoteArg("E2E Admin")).toBe('"E2E Admin"');
    expect(quoteArg("a missing due date")).toBe('"a missing due date"');
  });

  test("escapes quotes and backslashes inside a quoted argument", () => {
    expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""');
  });

  test("quotes an empty argument and shell metacharacters so they cannot run anything", () => {
    expect(quoteArg("")).toBe('""');
    expect(quoteArg("a;b")).toBe('"a;b"');
    expect(quoteArg("a&b")).toBe('"a&b"');
    expect(quoteArg("$(x)")).toBe('"$(x)"');
  });
});

describe("joinCommand", () => {
  test("round-trips the case that used to break", () => {
    expect(joinCommand(["tsx", "scripts/users.ts", "create", "e2e.admin", "E2E Admin", "SUPERADMIN"])).toBe(
      'tsx scripts/users.ts create e2e.admin "E2E Admin" SUPERADMIN',
    );
  });
});
