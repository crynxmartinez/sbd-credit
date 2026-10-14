import {
  DUE_SOON_DAYS,
  STALE_APPLICATION_DAYS,
  UTILIZATION_CRIT_PCT,
  UTILIZATION_DISPLAY_CAP_PCT,
  UTILIZATION_WARN_PCT,
  type CustomerStatus,
} from "./constants";
import { diffDays, formatDate } from "./dates";
import { formatCents } from "./money";

export type UtilizationLevel = "ok" | "warn" | "crit";
export type AlertSeverity = "high" | "med";
export type AlertKind = "over_limit" | "near_limit" | "overdue" | "due_soon" | "stale_application";

/** What the alert rules need to know about a customer: derived figures, never raw ledger rows. */
export interface AlertInput {
  id: string;
  businessName: string;
  status: CustomerStatus;
  creditLimitCents: number;
  balanceCents: number;
  overdueCents: number;
  oldestOverdueDays: number;
  nextDueDate: string | null;
  nextDueCents: number;
  /** The day the customer entered their current status. The review clock runs from here, not from the application date. */
  statusChangedDate: string;
}

export interface Alert {
  customerId: string;
  businessName: string;
  severity: AlertSeverity;
  kind: AlertKind;
  /** The sentence after the business name, so the UI can set the name in bold. */
  detail: string;
}

/** Rounded DOWN, so 99.6% never reads as 100% and a customer is never flagged for a threshold they have not reached. */
export function utilizationPct(balanceCents: number, limitCents: number): number {
  if (limitCents <= 0) return 0;
  // Whole-number arithmetic: (29 / 100) * 100 is 28.999... in floating point and would round down to 28.
  const pct = Math.floor((balanceCents * 100) / limitCents);
  return Math.max(0, Math.min(UTILIZATION_DISPLAY_CAP_PCT, pct));
}

export function utilizationLevel(pct: number): UtilizationLevel {
  if (pct >= UTILIZATION_CRIT_PCT) return "crit";
  if (pct >= UTILIZATION_WARN_PCT) return "warn";
  return "ok";
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

function make(input: AlertInput, severity: AlertSeverity, kind: AlertKind, detail: string): Alert {
  return { customerId: input.id, businessName: input.businessName, severity, kind, detail };
}

function limitAlerts(customer: AlertInput): Alert[] {
  const pct = utilizationPct(customer.balanceCents, customer.creditLimitCents);
  const limit = formatCents(customer.creditLimitCents);
  if (pct >= UTILIZATION_CRIT_PCT) {
    const used = formatCents(customer.balanceCents);
    return [make(customer, "high", "over_limit", `is over its credit limit — ${used} of ${limit} used (${pct}%).`)];
  }
  if (pct >= UTILIZATION_WARN_PCT) {
    return [make(customer, "med", "near_limit", `is at ${pct}% of its ${limit} credit limit.`)];
  }
  return [];
}

function paymentAlerts(customer: AlertInput, asOf: string): Alert[] {
  if (customer.overdueCents > 0) {
    const amount = formatCents(customer.overdueCents);
    const age = plural(customer.oldestOverdueDays, "day");
    return [make(customer, "high", "overdue", `has ${amount} overdue — oldest ${age} past due.`)];
  }
  if (customer.status !== "approved" || !customer.nextDueDate || customer.nextDueCents <= 0) return [];

  const days = diffDays(asOf, customer.nextDueDate);
  if (days < 0 || days > DUE_SOON_DAYS) return [];
  const when = days === 0 ? "due today" : `due in ${plural(days, "day")}`;
  const amount = formatCents(customer.nextDueCents);
  return [make(customer, "med", "due_soon", `payment of ${amount} is ${when} (${formatDate(customer.nextDueDate)}).`)];
}

function applicationAlerts(customer: AlertInput, asOf: string): Alert[] {
  const days = diffDays(customer.statusChangedDate, asOf);
  if (days < STALE_APPLICATION_DAYS) return [];
  const state = customer.status === "submitted" ? "awaiting review" : "under review";
  return [make(customer, "med", "stale_application", `has been ${state} for ${plural(days, "day")}.`)];
}

function alertsFor(customer: AlertInput, asOf: string): Alert[] {
  switch (customer.status) {
    case "approved":
      return [...limitAlerts(customer), ...paymentAlerts(customer, asOf)];
    case "suspended":
    case "denied":
      // Money can still be owed after a suspension, a denial or a reopening, so overdue amounts keep alerting.
      return paymentAlerts(customer, asOf);
    case "submitted":
      return applicationAlerts(customer, asOf);
    case "under_review":
      return [...applicationAlerts(customer, asOf), ...paymentAlerts(customer, asOf)];
  }
}

const SEVERITY_ORDER: Readonly<Record<AlertSeverity, number>> = { high: 0, med: 1 };

/** Every alert across the customer list, most severe first, then alphabetical. */
export function computeAlerts(customers: readonly AlertInput[], asOf: string): Alert[] {
  return customers
    .flatMap((customer) => alertsFor(customer, asOf))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.businessName.localeCompare(b.businessName),
    );
}
