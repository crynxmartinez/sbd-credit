import { describe, expect, test } from "vitest";
import { correctionFor } from "./corrections";

const TODAY = "2026-10-13";
const entry = (overrides = {}) => ({ type: "CHARGE" as const, voided: false, reversed: false, entryDate: "2026-10-01", ...overrides });

describe("correctionFor", () => {
  test("this month's entry can be voided (a typo); an older one must be reversed", () => {
    expect(correctionFor(entry(), TODAY, "ADMIN")).toBe("void");
    expect(correctionFor(entry({ entryDate: "2026-09-30" }), TODAY, "ADMIN")).toBe("reverse");
    expect(correctionFor(entry({ entryDate: "2026-11-02" }), TODAY, "ADMIN")).toBe("void"); // dated ahead
  });

  test("an employee is offered neither", () => {
    expect(correctionFor(entry(), TODAY, "EMPLOYEE")).toBeNull();
    expect(correctionFor(entry({ entryDate: "2026-01-01" }), TODAY, "EMPLOYEE")).toBeNull();
  });

  test("voided, already-reversed and reversal entries cannot be corrected again", () => {
    expect(correctionFor(entry({ voided: true }), TODAY, "ADMIN")).toBeNull();
    expect(correctionFor(entry({ reversed: true }), TODAY, "ADMIN")).toBeNull();
    expect(correctionFor(entry({ type: "REVERSAL" }), TODAY, "ADMIN")).toBeNull();
  });

  test("matches what the service permits for every role", () => {
    for (const role of ["EMPLOYEE", "ADMIN", "SUPERADMIN"] as const) {
      for (const entryDate of ["2026-10-01", "2026-09-30"]) {
        const how = correctionFor(entry({ entryDate }), TODAY, role);
        if (role === "EMPLOYEE") expect(how).toBeNull();
        else expect(how).toBe(entryDate.startsWith("2026-10") ? "void" : "reverse");
      }
    }
  });
});
