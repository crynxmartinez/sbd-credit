import { describe, expect, test } from "vitest";
import { can, isRole, type Role } from "./roles";
import { applyDecision, canTransition, type DecisionAction } from "./status";

describe("canTransition", () => {
  test.each([
    ["submitted", "under_review", true],
    ["submitted", "approved", true],
    ["submitted", "denied", true],
    ["submitted", "suspended", false],
    ["under_review", "approved", true],
    ["under_review", "denied", true],
    ["under_review", "submitted", false],
    ["approved", "suspended", true],
    ["approved", "denied", false],
    ["approved", "under_review", false],
    ["denied", "under_review", true],
    ["denied", "approved", false],
    ["suspended", "under_review", true],
    ["suspended", "approved", false],
    ["approved", "approved", false],
  ] as const)("%s -> %s is %s", (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected);
  });
});

describe("applyDecision", () => {
  test.each<[DecisionAction, "submitted" | "under_review" | "approved" | "denied" | "suspended", string]>([
    ["start_review", "submitted", "under_review"],
    ["approve", "under_review", "approved"],
    ["approve", "submitted", "approved"],
    ["deny", "under_review", "denied"],
    ["suspend", "approved", "suspended"],
    ["reopen", "denied", "under_review"],
    ["reopen", "suspended", "under_review"],
  ])("%s from %s lands on %s", (action, from, to) => {
    expect(applyDecision(from, action)).toEqual({ ok: true, to });
  });

  test("start_review is only for a fresh application, so it cannot undo a denial or suspension", () => {
    expect(applyDecision("denied", "start_review")).toMatchObject({ ok: false });
    expect(applyDecision("suspended", "start_review")).toMatchObject({ ok: false });
    expect(applyDecision("approved", "start_review")).toMatchObject({ ok: false });
    expect(applyDecision("under_review", "start_review")).toMatchObject({ ok: false });
  });

  test("reopen is only for a denied or suspended customer", () => {
    expect(applyDecision("submitted", "reopen")).toMatchObject({ ok: false });
    expect(applyDecision("under_review", "reopen")).toMatchObject({ ok: false });
    expect(applyDecision("approved", "reopen")).toMatchObject({ ok: false });
  });

  test("rejects an action that does not fit the current status", () => {
    expect(applyDecision("approved", "approve")).toEqual({
      ok: false,
      reason: expect.stringContaining("Approved"),
    });
    expect(applyDecision("denied", "suspend")).toMatchObject({ ok: false });
  });
});

describe("roles", () => {
  test("recognizes the three roles only", () => {
    expect(isRole("EMPLOYEE")).toBe(true);
    expect(isRole("ADMIN")).toBe(true);
    expect(isRole("SUPERADMIN")).toBe(true);
    expect(isRole("admin")).toBe(false);
    expect(isRole("")).toBe(false);
  });

  const everyoneCan = ["customer.create", "customer.edit", "ledger.record", "decision.start_review"] as const;
  const adminOnly = [
    "decision.approve",
    "decision.deny",
    "decision.suspend",
    "decision.reopen",
    "customer.change_credit",
    "ledger.void",
    "ledger.adjust",
    "export",
  ] as const;

  test.each(everyoneCan)("an employee can %s", (action) => {
    expect(can("EMPLOYEE", action)).toBe(true);
  });

  test.each(adminOnly)("%s needs an admin", (action) => {
    expect(can("EMPLOYEE", action)).toBe(false);
    for (const role of ["ADMIN", "SUPERADMIN"] as Role[]) expect(can(role, action)).toBe(true);
  });

  test("only a superadmin manages users", () => {
    expect(can("ADMIN", "users.manage")).toBe(false);
    expect(can("SUPERADMIN", "users.manage")).toBe(true);
  });
});
