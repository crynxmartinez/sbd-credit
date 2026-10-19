import { describe, expect, test } from "vitest";
import { classifyDbError, isTransientError } from "./db-errors";

describe("classifyDbError", () => {
  test.each([
    "canceling statement due to lock timeout",
    "canceling statement due to statement timeout",
    "deadlock detected",
    "could not serialize access due to concurrent update",
    "Timed out fetching a new connection from the connection pool",
    "Unable to start a transaction in the given time",
    "Transaction already closed: A query cannot be executed on an expired transaction.",
    "timeout exceeded when trying to connect",
    "connect ECONNREFUSED 10.0.0.5:5432",
    "getaddrinfo ENOTFOUND db.example.com",
  ])("%j failed BEFORE anything was written: nothing was saved", (message) => {
    expect(classifyDbError(new Error(message))).toBe("not_saved");
  });

  test.each(["P2028", "P2034", "P1001", "P1002", "P1008"])("Prisma code %s means nothing was saved", (code) => {
    expect(classifyDbError({ code })).toBe("not_saved");
  });

  test.each(["55P03", "57014", "40P01", "40001", "53300", "57P03"])("SQLSTATE %s (lock timeout, cancelled, deadlock, serialization, too many connections, starting up) means nothing was saved", (sqlstate) => {
    expect(classifyDbError({ code: "P2010", meta: { code: sqlstate } })).toBe("not_saved");
    expect(classifyDbError({ code: sqlstate })).toBe("not_saved");
  });

  test.each([
    "terminating connection due to administrator command",
    "Connection terminated unexpectedly",
    "read ECONNRESET",
    "Server has closed the connection.",
    "write EPIPE",
  ])("%j can happen AFTER the commit was sent: we cannot say whether it was saved", (message) => {
    expect(classifyDbError(new Error(message))).toBe("unknown_outcome");
  });

  test.each(["P1017"])("Prisma code %s (server closed the connection) is an unknown outcome", (code) => {
    expect(classifyDbError({ code })).toBe("unknown_outcome");
  });

  test.each(["57P01", "57P02"])("SQLSTATE %s (admin shutdown, crash) is an unknown outcome", (sqlstate) => {
    expect(classifyDbError({ code: sqlstate })).toBe("unknown_outcome");
    expect(classifyDbError({ code: "P2010", meta: { code: sqlstate } })).toBe("unknown_outcome");
  });

  test.each([
    ["a unique violation", { code: "P2002" }],
    ["a record not found", { code: "P2025" }],
    ["an append-only violation", { code: "P2010", meta: { code: "23001" } }],
    ["an ordinary bug", new TypeError("x is undefined")],
    ["null", null],
    ["a string", "boom"],
  ])("%s is not a connection problem: it would fail the same way again", (_name, error) => {
    expect(classifyDbError(error)).toBe("other");
  });
});

describe("isTransientError", () => {
  test("is any connection-level problem, whether or not it was saved", () => {
    expect(isTransientError(new Error("deadlock detected"))).toBe(true);
    expect(isTransientError(new Error("read ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("boom"))).toBe(false);
  });
});

describe("the driver's own wording for a connection that never opened", () => {
  test("\"Connection terminated due to connection timeout\" is NOT an unknown outcome: the connection never existed, so nothing was written", () => {
    expect(classifyDbError(new Error("Connection terminated due to connection timeout"))).toBe("not_saved");
  });
  test("a connection that WAS open and then dropped still is", () => {
    expect(classifyDbError(new Error("Connection terminated unexpectedly"))).toBe("unknown_outcome");
  });
});
