import { MAX_POSTDATE_DAYS } from "./constants";
import { addDays, isInClosedMonth } from "./dates";
import { can, type Role } from "./roles";

/**
 * The dates an entry may carry. Anyone may post up to MAX_POSTDATE_DAYS ahead. Only an admin may post into a month that is
 * already closed: that changes figures which were reported, so it is not left to the lowest role. The form uses the same
 * window the service enforces.
 */
export function entryDateWindow(role: Role, today: string): { min: string | null; max: string } {
  return {
    min: can(role, "ledger.backdate") ? null : `${today.slice(0, 7)}-01`,
    max: addDays(today, MAX_POSTDATE_DAYS),
  };
}

export interface EntryDateIssue {
  /** too_far_ahead is a mistake to correct; closed_month is a permission the person does not have. */
  code: "too_far_ahead" | "closed_month";
  message: string;
}

/** Which rule dating an entry this way breaks, if any. */
export function entryDateIssue(role: Role, entryDate: string, today: string): EntryDateIssue | null {
  if (entryDate > addDays(today, MAX_POSTDATE_DAYS)) {
    return { code: "too_far_ahead", message: `An entry cannot be dated more than ${MAX_POSTDATE_DAYS} days ahead. Check the year.` };
  }
  if (isInClosedMonth(entryDate, today) && !can(role, "ledger.backdate")) {
    return { code: "closed_month", message: "That date is in a month that is already closed. Only an admin can post into a closed month." };
  }
  return null;
}

/** What is wrong with dating an entry this way, in words for the person, or null if it is fine. */
export function entryDateProblem(role: Role, entryDate: string, today: string): string | null {
  return entryDateIssue(role, entryDate, today)?.message ?? null;
}
