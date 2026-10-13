import { STATUS_LABELS, type CustomerStatus } from "./constants";

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
