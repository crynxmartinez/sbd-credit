import type { CustomerSummary, DashboardDto } from "../types";
import { computeAlerts } from "./alerts";
import { AGING_BUCKETS, type AgingBucket } from "./constants";
import { compareText } from "./dates";

const RECENT_LIMIT = 5;

function emptyBuckets(): Record<AgingBucket, number> {
  return Object.fromEntries(AGING_BUCKETS.map((bucket) => [bucket, 0])) as Record<AgingBucket, number>;
}

/** The few most recently updated customers, found in one pass (sorting every customer to keep five was the cost on a long list). */
function newestFirst(customers: readonly CustomerSummary[], limit: number): CustomerSummary[] {
  const top: CustomerSummary[] = [];
  for (const customer of customers) {
    const index = top.findIndex((kept) => compareText(customer.updatedAt, kept.updatedAt) > 0);
    if (index === -1) {
      if (top.length < limit) top.push(customer);
    } else {
      top.splice(index, 0, customer);
      if (top.length > limit) top.pop();
    }
  }
  return top;
}

export function buildDashboard(customers: readonly CustomerSummary[], asOf: string): DashboardDto {
  const alerts = computeAlerts(customers, asOf);
  const approved = customers.filter((customer) => customer.status === "approved");

  const aging = customers.reduce((totals, customer) => {
    const next = { ...totals };
    for (const bucket of AGING_BUCKETS) next[bucket] += customer.buckets[bucket];
    return next;
  }, emptyBuckets());

  const recent = newestFirst(customers, RECENT_LIMIT);

  return {
    stats: {
      totalCustomers: customers.length,
      pendingApplications: customers.filter((c) => c.status === "submitted" || c.status === "under_review").length,
      activeAccounts: approved.length,
      totalExtendedCents: approved.reduce((sum, c) => sum + c.creditLimitCents, 0),
      totalOutstandingCents: customers.reduce((sum, c) => sum + Math.max(0, c.balanceCents), 0),
      totalOverdueCents: customers.reduce((sum, c) => sum + c.overdueCents, 0),
      totalWrittenOffCents: customers.reduce((sum, c) => sum + c.writtenOffCents, 0),
      needsAttention: alerts.length,
    },
    alerts,
    aging,
    recent,
  };
}
