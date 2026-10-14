import type { CustomerSummary, DashboardDto } from "../types";
import { computeAlerts } from "./alerts";
import { AGING_BUCKETS, type AgingBucket } from "./constants";

const RECENT_LIMIT = 5;

function emptyBuckets(): Record<AgingBucket, number> {
  return Object.fromEntries(AGING_BUCKETS.map((bucket) => [bucket, 0])) as Record<AgingBucket, number>;
}

export function buildDashboard(customers: readonly CustomerSummary[], asOf: string): DashboardDto {
  const alerts = computeAlerts(customers, asOf);
  const approved = customers.filter((customer) => customer.status === "approved");

  const aging = customers.reduce((totals, customer) => {
    const next = { ...totals };
    for (const bucket of AGING_BUCKETS) next[bucket] += customer.buckets[bucket];
    return next;
  }, emptyBuckets());

  const recent = [...customers].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_LIMIT);

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
