import { beforeEach, describe, expect, test, vi } from "vitest";

let answer: () => Promise<unknown[]> = async () => [];
vi.mock("./db", () => ({ prisma: { $queryRaw: () => answer() } }));

import { checkDatabaseRole, roleProblems, type RoleFacts } from "./role-check";

const RESTRICTED: RoleFacts = {
  rolsuper: false, rolcreaterole: false, rolcreatedb: false,
  canCreate: false, canDelete: false, canTruncate: false, canTrigger: false, canUpdateAudit: false, ownsTables: false, serverEncoding: "UTF8",
};

describe("roleProblems", () => {
  test("the role the runbook describes (reads, adds and updates; owns nothing) has no problems", () => {
    expect(roleProblems(RESTRICTED)).toEqual([]);
  });

  test.each([
    ["a superuser", { rolsuper: true }, /superuser/],
    ["a role that can create roles", { rolcreaterole: true }, /create roles/],
    ["a role that can create databases", { rolcreatedb: true }, /create databases/],
    ["a role that can create objects in the schema", { canCreate: true }, /create objects/],
    ["a role that can delete ledger rows", { canDelete: true }, /DELETE/],
    ["a role that can truncate the ledger", { canTruncate: true }, /TRUNCATE/],
    ["a role that can switch triggers off", { canTrigger: true }, /TRIGGER/],
    ["a role that can edit the audit log", { canUpdateAudit: true }, /audit/i],
    ["the role that owns the tables", { ownsTables: true }, /owns/],
    ["a database that is not UTF8", { serverEncoding: "WIN1252" }, /WIN1252.*not UTF8/],
  ] as const)("refuses %s", (_name, facts, pattern) => {
    const problems = roleProblems({ ...RESTRICTED, ...facts });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(pattern);
  });

  test("reports every problem at once", () => {
    expect(roleProblems({ ...RESTRICTED, rolsuper: true, canDelete: true, ownsTables: true }).length).toBe(3);
  });

  test("a missing fact is treated as a problem, not as a pass (a query that learned nothing must not look safe)", () => {
    expect(roleProblems({ ...RESTRICTED, canDelete: null as unknown as boolean }).length).toBeGreaterThan(0);
  });
});

describe("checkDatabaseRole", () => {
  beforeEach(() => {
    answer = async () => [RESTRICTED];
  });

  test("ok for the restricted login", async () => {
    expect(await checkDatabaseRole()).toEqual({ status: "ok" });
  });

  test("unsafe, with the reasons, for a login that could undo the append-only promises", async () => {
    answer = async () => [{ ...RESTRICTED, canDelete: true, ownsTables: true }];
    const result = await checkDatabaseRole();
    expect(result.status).toBe("unsafe");
    expect(result.status === "unsafe" && result.problems).toHaveLength(2);
  });

  test("unknown (not unsafe, not ok) when the database does not answer or knows no such login", async () => {
    answer = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432\n at somewhere");
    };
    expect(await checkDatabaseRole()).toEqual({ status: "unknown", reason: "connect ECONNREFUSED 127.0.0.1:5432" });
    answer = async () => [];
    expect((await checkDatabaseRole()).status).toBe("unknown");
  });

  test("unknown after the time limit when the database never answers", async () => {
    answer = () => new Promise(() => undefined);
    expect(await checkDatabaseRole(20)).toEqual({ status: "unknown", reason: "timed out" });
  });
});
