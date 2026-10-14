import { describe, expect, test } from "vitest";
import { can, isRole, type Role } from "./roles";
import { applyDecision, availableDecisions, canTakePayment, canTransition, hasCreditLine, showsCreditPanel, type DecisionAction } from "./status";

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

describe("hasCreditLine / canTakePayment / showsCreditPanel", () => {
  test("only approved and suspended accounts have a credit line", () => {
    expect(hasCreditLine("approved")).toBe(true);
    expect(hasCreditLine("suspended")).toBe(true);
    for (const status of ["submitted", "under_review", "denied"] as const) expect(hasCreditLine(status)).toBe(false);
  });

  test("a payment is taken wherever there is a ledger, and on any account with a credit line", () => {
    expect(canTakePayment("approved", false)).toBe(true);
    expect(canTakePayment("suspended", false)).toBe(true);
    expect(canTakePayment("denied", true)).toBe(true); // reopened or denied, but still owes money
    expect(canTakePayment("under_review", true)).toBe(true);
    expect(canTakePayment("denied", false)).toBe(false);
    expect(canTakePayment("submitted", false)).toBe(false);
  });

  test("the credit panel is shown for a credit line, and for ANY account that still owes or is owed money", () => {
    expect(showsCreditPanel("approved", 0)).toBe(true);
    expect(showsCreditPanel("denied", 0)).toBe(false);
    expect(showsCreditPanel("denied", 250_00)).toBe(true); // the gap the audit found: it owes, staff must be able to record a payment
    expect(showsCreditPanel("under_review", -40_00)).toBe(true); // a credit balance
    expect(showsCreditPanel("submitted", 0)).toBe(false);
  });
});

describe("availableDecisions", () => {
  test("a submitted application: staff can start a review, only an admin can decide", () => {
    expect(availableDecisions("submitted", "EMPLOYEE")).toEqual(["start_review"]);
    expect(availableDecisions("submitted", "ADMIN")).toEqual(["start_review", "approve", "deny"]);
  });

  test("under review: only admins decide", () => {
    expect(availableDecisions("under_review", "EMPLOYEE")).toEqual([]);
    expect(availableDecisions("under_review", "ADMIN")).toEqual(["approve", "deny"]);
  });

  test("approved can be suspended, denied and suspended can be reopened, by admins only", () => {
    expect(availableDecisions("approved", "ADMIN")).toEqual(["suspend"]);
    expect(availableDecisions("approved", "EMPLOYEE")).toEqual([]);
    expect(availableDecisions("denied", "SUPERADMIN")).toEqual(["reopen"]);
    expect(availableDecisions("suspended", "ADMIN")).toEqual(["reopen"]);
    expect(availableDecisions("suspended", "EMPLOYEE")).toEqual([]);
  });

  test("agrees with applyDecision: nothing offered is refused, and everything else is", () => {
    const statuses = ["submitted", "under_review", "approved", "denied", "suspended"] as const;
    const actions: DecisionAction[] = ["start_review", "approve", "deny", "suspend", "reopen"];
    for (const status of statuses) {
      const offered = availableDecisions(status, "SUPERADMIN");
      for (const action of actions) expect(applyDecision(status, action).ok, `${status}/${action}`).toBe(offered.includes(action));
    }
  });
});
