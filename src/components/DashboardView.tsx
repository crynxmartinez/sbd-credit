"use client";

import { useMemo } from "react";
import { useCustomers } from "@/lib/client/queries";
import { AGING_BUCKETS, AGING_LABELS } from "@/lib/domain/constants";
import { buildDashboard } from "@/lib/domain/dashboard";
import { formatCents } from "@/lib/domain/money";
import { can } from "@/lib/domain/roles";
import type { DashboardDto } from "@/lib/types";
import { CustomerTable } from "./CustomerTable";
import { DataStatus } from "./DataStatus";
import { PlusIcon, WarningIcon } from "./icons";
import { useUi } from "./ui-context";

function StatCards({ stats }: { stats: DashboardDto["stats"] | undefined }) {
  const cards = [
    { label: "Total customers", value: stats?.totalCustomers },
    { label: "Pending applications", value: stats?.pendingApplications },
    { label: "Active credit accounts", value: stats?.activeAccounts },
    { label: "Total credit extended", value: stats && formatCents(stats.totalExtendedCents) },
    { label: "Total outstanding balance", value: stats && formatCents(stats.totalOutstandingCents) },
    { label: "Past due", value: stats && formatCents(stats.totalOverdueCents), alert: (stats?.totalOverdueCents ?? 0) > 0 },
    { label: "Needs attention", value: stats?.needsAttention, alert: (stats?.needsAttention ?? 0) > 0 },
  ];
  return (
    <div className="stats">
      {cards.map((card) => (
        <div key={card.label} className="stat-card">
          <div className="stat-label">{card.label}</div>
          <div className={`stat-value${card.alert ? " alert-num" : ""}`}>{card.value ?? "…"}</div>
        </div>
      ))}
    </div>
  );
}

function AgingStrip({ aging }: { aging: DashboardDto["aging"] }) {
  const total = AGING_BUCKETS.reduce((sum, bucket) => sum + aging[bucket], 0);
  return (
    <section className="panel" aria-labelledby="aging-heading">
      <h2 className="section-heading" id="aging-heading" style={{ margin: 0 }}>
        Receivables aging
      </h2>
      {total === 0 ? (
        <div className="alert-empty" style={{ padding: "10px 0 0 0" }}>No outstanding balances.</div>
      ) : (
        <>
          <div className="aging-bar" role="img" aria-label={`Outstanding ${formatCents(total)} split by how late it is`}>
            {AGING_BUCKETS.filter((bucket) => aging[bucket] > 0).map((bucket) => (
              <div key={bucket} className={`aging-seg ${bucket}`} style={{ width: `${(aging[bucket] / total) * 100}%` }} />
            ))}
          </div>
          <div className="aging-legend">
            {AGING_BUCKETS.map((bucket) => (
              <div key={bucket} className="aging-key">
                <span className={`aging-swatch aging-seg ${bucket}`} aria-hidden="true" />
                <div>
                  <div className="kv-label">{AGING_LABELS[bucket]}</div>
                  <div className="mono">{formatCents(aging[bucket])}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function DashboardView() {
  const { user, openNew, openCustomer } = useUi();
  const query = useCustomers();
  const { data, isLoading } = query;

  // Everything on the dashboard is derived from the customer list the server already computed, so the two screens
  // share one request and one cache, and always agree.
  const dashboard = useMemo(() => (data ? buildDashboard(data.customers, data.asOf) : null), [data]);
  const failed = query.isError && !data;

  return (
    <div>
      <div className="topbar">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <div className="page-sub">Credit applications, approvals, and balances at a glance.</div>
        </div>
        {can(user.role, "customer.create") ? (
          <button type="button" className="btn btn-primary" onClick={openNew}>
            <PlusIcon size={15} />
            New credit application
          </button>
        ) : null}
      </div>

      <DataStatus what="the dashboard" query={{ ...query, hasData: Boolean(data) }} />

      {failed ? null : (
        <>
          <StatCards stats={dashboard?.stats} />

          <h2 className="section-heading">
            <WarningIcon size={14} />
            Needs attention
          </h2>
          <div className="alerts-list">
            {isLoading ? <div className="skeleton" style={{ height: 44 }} /> : null}
            {dashboard && dashboard.alerts.length === 0 ? <div className="alert-empty">Nothing needs attention right now.</div> : null}
            {dashboard?.alerts.map((alert) => (
              <button
                key={`${alert.customerId}-${alert.kind}`}
                type="button"
                className={`alert-row sev-${alert.severity}`}
                onClick={() => openCustomer(alert.customerId)}
              >
                <span className="alert-dot" aria-hidden="true" />
                <span className="alert-text">
                  <span className="sr-only">{alert.severity === "high" ? "Urgent: " : "Attention: "}</span>
                  <b>{alert.businessName}</b> {alert.detail}
                </span>
              </button>
            ))}
          </div>

          {dashboard ? <AgingStrip aging={dashboard.aging} /> : null}

          <h2 className="section-heading">Recently updated</h2>
          <CustomerTable customers={dashboard?.recent ?? []} variant="recent" loading={isLoading} caption="Recently updated customers" />
        </>
      )}
    </div>
  );
}
