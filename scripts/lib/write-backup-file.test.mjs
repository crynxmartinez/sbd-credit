import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { writeBackupJson } from "./write-backup-file.mjs";

const dir = mkdtempSync(join(tmpdir(), "backup-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("writeBackupJson", () => {
  const file = {
    format: 1,
    schema: "credit_test",
    takenAt: "2026-10-20T00:00:00.000Z",
    counts: { customers: 2, ledger: 0 },
    customers: [
      { id: "c1", businessName: 'Acme "Quoted" & Sons, Inc.', notes: "line one\nline two", createdAt: new Date("2026-10-01T10:00:00Z"), amount: 12345 },
      { id: "c2", businessName: "Ünïcödé — 日本語", notes: null, createdAt: new Date("2026-10-02T10:00:00Z"), amount: -5 },
    ],
    ledger: [],
    flag: true,
  };

  test("what is written reads back as exactly what JSON.stringify would have produced", () => {
    const path = join(dir, "a.json");
    writeBackupJson(path, file);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(JSON.stringify(file)));
  });

  test("an empty section and a section of one row are both valid", () => {
    const path = join(dir, "b.json");
    writeBackupJson(path, { empty: [], one: [{ id: 1 }], scalar: "x" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ empty: [], one: [{ id: 1 }], scalar: "x" });
  });

  test("no line is longer than one row, however many rows there are", () => {
    const path = join(dir, "c.json");
    const rows = Array.from({ length: 5_000 }, (_, i) => ({ id: `r${i}`, note: "x".repeat(50) }));
    writeBackupJson(path, { rows });
    const longest = Math.max(...readFileSync(path, "utf8").split("\n").map((line) => line.length));
    expect(longest).toBeLessThan(200);
    expect(JSON.parse(readFileSync(path, "utf8")).rows).toHaveLength(5_000);
  });

  test("the file is private to its owner (where the platform has permissions)", () => {
    const path = join(dir, "d.json");
    writeBackupJson(path, { a: [] });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0);
  });
});
