import { STATUS_LABELS, type CustomerStatus } from "./constants";
import { can, type Role } from "./roles";

export type DecisionAction = "start_review" | "approve" | "deny" | "suspend" | "reopen";

const TRANSITIONS: Readonly<Record<CustomerStatus, readonly CustomerStatus[]>> = {
  submitted: ["under_review", "approved", "denied"],
  under_review: ["approved", "denied"],
  approved: ["suspended"],
  denied: ["under_review"],
  suspended: ["under_review"],
};

const ACTION_TARGET: Readonly<Record<DecisionAction, CustomerStatus>> = {
  start_review: "under_review",
  approve: "approved",
  deny: "denied",
  suspend: "suspended",
  reopen: "under_review",
};

/**
 * The statuses each action may start from. Two actions share a target (start_review and reopen both land on
 * under_review) but have different permissions, so each must only be reachable from its own starting points:
 * otherwise a role allowed to start a review could use it to undo a denial or a suspension.
 */
const ACTION_FROM: Readonly<Record<DecisionAction, readonly CustomerStatus[]>> = {
  start_review: ["submitted"],
  approve: ["submitted", "under_review"],
  deny: ["submitted", "under_review"],
  suspend: ["approved"],
  reopen: ["denied", "suspended"],
};

export function canTransition(from: CustomerStatus, to: CustomerStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export type DecisionResult = { ok: true; to: CustomerStatus } | { ok: false; reason: string };

export function applyDecision(from: CustomerStatus, action: DecisionAction): DecisionResult {
  const to = ACTION_TARGET[action];
  if (ACTION_FROM[action].includes(from) && canTransition(from, to)) return { ok: true, to };
  const label = action.replace("_", " ");
  return { ok: false, reason: `Cannot ${label}: the customer's status is ${STATUS_LABELS[from]}.` };
}

/** Approved and suspended accounts have (or had) a credit line. The one place this is decided. */
export function hasCreditLine(status: CustomerStatus): boolean {
  return status === "approved" || status === "suspended";
}

/**
 * Money can still be owed after a suspension, a denial or a reopening, so a payment is accepted wherever there is a
 * ledger, and always on an account with a credit line.
 */
export function canTakePayment(status: CustomerStatus, hasEntries: boolean): boolean {
  return hasCreditLine(status) || hasEntries;
}

/** The credit panel (balance and the buttons to record money) shows for a credit line, and for ANY account with a balance. */
export function showsCreditPanel(status: CustomerStatus, balanceCents: number): boolean {
  return hasCreditLine(status) || balanceCents !== 0;
}

const DECISION_ORDER: readonly DecisionAction[] = ["start_review", "approve", "deny", "suspend", "reopen"];

/** The decisions this role may make on an account in this status: exactly the ones the workflow would accept. */
export function availableDecisions(status: CustomerStatus, role: Role): DecisionAction[] {
  return DECISION_ORDER.filter((action) => ACTION_FROM[action].includes(status) && can(role, `decision.${action}`));
}
