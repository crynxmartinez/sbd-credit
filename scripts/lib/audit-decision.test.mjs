import { describe, expect, test } from "vitest";
import { decideAudit } from "./audit-decision.mjs";

const vuln = (severity, range = "<1.0.0") => ({ severity, range });

describe("decideAudit", () => {
  test("passes when nothing is found", () => {
    expect(decideAudit({ vulnerabilities: {} })).toMatchObject({ ok: true, blocking: [] });
  });

  test("FAILS when npm audit itself failed: an error report is not 'nothing found'", () => {
    expect(decideAudit({ error: { code: "ENOTFOUND", summary: "registry unreachable" } })).toMatchObject({ ok: false, reason: expect.stringContaining("registry unreachable") });
    expect(decideAudit({ error: "boom" })).toMatchObject({ ok: false });
  });

  test("FAILS when there is no vulnerability list at all, or the report is not an object", () => {
    expect(decideAudit({})).toMatchObject({ ok: false });
    expect(decideAudit({ vulnerabilities: null })).toMatchObject({ ok: false });
    expect(decideAudit(null)).toMatchObject({ ok: false });
    expect(decideAudit("text")).toMatchObject({ ok: false });
  });

  test("blocks a high or critical problem in any runtime dependency", () => {
    const result = decideAudit({ vulnerabilities: { next: vuln("high"), zod: vuln("critical") } });
    expect(result.ok).toBe(false);
    expect(result.blocking.map((item) => item.name)).toEqual(["next", "zod"]);
  });

  test("tolerates a HIGH problem that is only the Prisma command-line tool chain, and says so", () => {
    const result = decideAudit({ vulnerabilities: { prisma: vuln("high"), mysql2: vuln("high"), "deepmerge-ts": vuln("high"), "@prisma/config": vuln("high") } });
    expect(result).toMatchObject({ ok: true, blocking: [] });
    expect(result.tolerated).toEqual(["prisma", "mysql2", "deepmerge-ts", "@prisma/config"]);
  });

  test("a CRITICAL problem is never tolerated, even in the Prisma tool chain", () => {
    expect(decideAudit({ vulnerabilities: { prisma: vuln("critical") } }).ok).toBe(false);
  });

  test("moderate and low findings do not block", () => {
    expect(decideAudit({ vulnerabilities: { a: vuln("moderate"), b: vuln("low") } }).ok).toBe(true);
  });
});
