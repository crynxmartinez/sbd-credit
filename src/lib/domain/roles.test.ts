import { describe, expect, test } from "vitest";
import { ROLES, can, isRole, type Action } from "./roles";

/**
 * What each role may do, written out as a table. This is the single place a person can read who may do what, and a change
 * to a permission has to change this table too, so it cannot happen by accident.
 */
const TABLE: Readonly<Record<Action, "EMPLOYEE" | "ADMIN" | "SUPERADMIN">> = {
  "customer.create": "EMPLOYEE",
  "customer.edit": "EMPLOYEE",
  "customer.change_credit": "ADMIN",
  "ledger.record": "EMPLOYEE",
  "ledger.void": "ADMIN",
  "ledger.reverse": "ADMIN",
  "ledger.adjust": "ADMIN",
  "ledger.write_off": "ADMIN",
  "ledger.backdate": "ADMIN",
  "decision.start_review": "EMPLOYEE",
  "decision.approve": "ADMIN",
  "decision.deny": "ADMIN",
  "decision.suspend": "ADMIN",
  "decision.reopen": "ADMIN",
  export: "ADMIN",
  "portal.manage": "ADMIN",
  "users.manage": "SUPERADMIN",
};

describe("can", () => {
  test.each(Object.entries(TABLE) as Array<[Action, (typeof ROLES)[number]]>)("%s needs at least %s", (action, lowest) => {
    for (const role of ROLES) expect(can(role, action), `${role} / ${action}`).toBe(ROLES.indexOf(role) >= ROLES.indexOf(lowest));
  });

  test("every action is in the table (so a new one cannot be added without deciding who may do it)", () => {
    expect(Object.keys(TABLE).length).toBeGreaterThanOrEqual(17);
  });

  test("a higher role may do everything a lower one may", () => {
    for (const action of Object.keys(TABLE) as Action[]) {
      if (can("EMPLOYEE", action)) expect(can("ADMIN", action)).toBe(true);
      if (can("ADMIN", action)) expect(can("SUPERADMIN", action)).toBe(true);
    }
  });
});

describe("isRole", () => {
  test("accepts exactly the three roles, spelled exactly", () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true);
    for (const wrong of ["admin", "OWNER", "", null, undefined, 1, {}]) expect(isRole(wrong)).toBe(false);
  });
});
