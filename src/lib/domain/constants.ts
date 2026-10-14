/** Business rules in one place. Change a threshold here, not in the code that uses it. */

export const CUSTOMER_STATUSES = ["submitted", "under_review", "approved", "denied", "suspended"] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const STATUS_LABELS: Readonly<Record<CustomerStatus, string>> = {
  submitted: "Submitted",
  under_review: "Under review",
  approved: "Approved",
  denied: "Denied",
  suspended: "Suspended",
};

export const PAYMENT_TERMS = ["Net 15", "Net 30", "Net 45", "Net 60", "Net 90", "Due on receipt", "COD"] as const;
export type PaymentTerms = (typeof PAYMENT_TERMS)[number];
export const DEFAULT_PAYMENT_TERMS: PaymentTerms = "Net 30";

/**
 * CHARGE adds to the balance; PAYMENT and WRITE_OFF reduce it (a write-off is debt given up on, not money received).
 * ADJUSTMENT is a signed correction posted by hand. REVERSAL is the signed offset of an earlier entry, made by the
 * system and dated today, so a correction never rewrites a past month.
 */
export const LEDGER_TYPES = ["CHARGE", "PAYMENT", "ADJUSTMENT", "WRITE_OFF", "REVERSAL"] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

/** The types a person can post directly. A reversal is only ever made by reversing an existing entry. */
export const POSTABLE_LEDGER_TYPES = ["CHARGE", "PAYMENT", "ADJUSTMENT", "WRITE_OFF"] as const;

/** A write-off or reversal always carries the reason, because it changes what the books say without new money moving. */
export const MIN_REASON_LENGTH = 3;

/** A credit line at or above this share of its limit is flagged. */
export const UTILIZATION_WARN_PCT = 80;
export const UTILIZATION_CRIT_PCT = 100;
/** Utilization is clamped for display so one bad entry cannot blow up the layout. */
export const UTILIZATION_DISPLAY_CAP_PCT = 200;

/** A payment due within this many days (and not yet overdue) is flagged. */
export const DUE_SOON_DAYS = 7;
/** An application waiting this many days without a decision is flagged. */
export const STALE_APPLICATION_DAYS = 5;

/** Upper bound for one ledger entry or one limit: $10,000,000.00. Each stored amount fits a 32-bit column. */
export const MAX_AMOUNT_CENTS = 1_000_000_000;

export const AGING_BUCKETS = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export const AGING_LABELS: Readonly<Record<AgingBucket, string>> = {
  current: "Not yet due",
  d1_30: "1–30 days",
  d31_60: "31–60 days",
  d61_90: "61–90 days",
  d90_plus: "90+ days",
};
