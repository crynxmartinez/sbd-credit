export const ROLES = ["EMPLOYEE", "ADMIN", "SUPERADMIN"] as const;
export type Role = (typeof ROLES)[number];

export type Action =
  | "customer.create"
  | "customer.edit"
  | "customer.change_credit"
  | "ledger.record"
  | "ledger.void"
  | "ledger.adjust"
  | "decision.start_review"
  | "decision.approve"
  | "decision.deny"
  | "decision.suspend"
  | "decision.reopen"
  | "export"
  | "users.manage";

/** The lowest role that may perform each action. Roles match the shipper app. */
const MINIMUM_ROLE: Readonly<Record<Action, Role>> = {
  "customer.create": "EMPLOYEE",
  "customer.edit": "EMPLOYEE",
  "customer.change_credit": "ADMIN",
  "ledger.record": "EMPLOYEE",
  "ledger.void": "ADMIN",
  "ledger.adjust": "ADMIN",
  "decision.start_review": "EMPLOYEE",
  "decision.approve": "ADMIN",
  "decision.deny": "ADMIN",
  "decision.suspend": "ADMIN",
  "decision.reopen": "ADMIN",
  export: "ADMIN",
  "users.manage": "SUPERADMIN",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function can(role: Role, action: Action): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(MINIMUM_ROLE[action]);
}
