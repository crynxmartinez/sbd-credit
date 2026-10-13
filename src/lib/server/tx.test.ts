import { describe, expect, test } from "vitest";
import { isTransientError } from "./tx";

describe("isTransientError", () => {
  test.each(["P2028", "P2034", "P1001", "P1002", "P1008", "P1017"])("treats Prisma code %s as try-again", (code) => {
    expect(isTransientError({ code })).toBe(true);
  });

  test.each(["55P03", "57014", "40P01", "40001"])("treats SQLSTATE %s (lock timeout, cancelled, deadlock, serialization) as try-again", (sqlstate) => {
    expect(isTransientError({ code: "P2010", meta: { code: sqlstate } })).toBe(true);
    expect(isTransientError({ code: sqlstate })).toBe(true);
  });

  test.each([
    "canceling statement due to lock timeout",
    "canceling statement due to statement timeout",
    "deadlock detected",
    "Transaction already closed: A query cannot be executed on an expired transaction.",
    "Timed out fetching a new connection from the connection pool",
    "terminating connection due to administrator command",
  ])("recognises the message %j", (message) => {
    expect(isTransientError(new Error(message))).toBe(true);
  });

  test.each([
    ["a unique violation", { code: "P2002" }],
    ["a record not found", { code: "P2025" }],
    ["an append-only violation", { code: "P2010", meta: { code: "23001" } }],
    ["an ordinary bug", new TypeError("x is undefined")],
    ["null", null],
    ["a string", "boom"],
  ])("does NOT retry %s: it would fail the same way again", (_name, error) => {
    expect(isTransientError(error)).toBe(false);
  });
});
