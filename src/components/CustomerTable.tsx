"use client";

import { memo } from "react";
import type { SortDirection, SortKey } from "@/lib/domain/customer-list";
import { formatCents } from "@/lib/domain/money";
import { formatDate, todayISO } from "@/lib/domain/dates";
import type { CustomerSummary } from "@/lib/types";
import { useUi } from "./ui-context";
import { StatusBadge, UtilBar } from "./ui";

interface SortState {
  key: SortKey;
  direction: SortDirection;
}

interface Props {
  customers: readonly CustomerSummary[];
  variant: "recent" | "full";
  loading?: boolean;
  sort?: SortState;
  onSort?: (key: SortKey) => void;
  caption: string;
}

const FULL_COLUMNS: ReadonlyArray<{ key: SortKey; label: string; numeric?: boolean }> = [
  { key: "name", label: "Business" },
  { key: "status", label: "Status" },
  { key: "limit", label: "Credit limit" },
  { key: "balance", label: "Balance" },
  { key: "utilization", label: "Utilization" },
  { key: "nextDue", label: "Next payment due" },
];

const RECENT_COLUMNS = ["Business", "Status", "Credit limit", "Balance", "Updated"] as const;

function ariaSort(sort: SortState | undefined, key: SortKey): "ascending" | "descending" | "none" {
  if (!sort || sort.key !== key) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
}

function NextDue({ customer }: { customer: CustomerSummary }) {
  const tracked = customer.status === "approved" || customer.status === "suspended";
  if (!tracked || !customer.nextDueDate) return <span style={{ color: "var(--text-faint)" }}>—</span>;
  return (
    <>
      <div>{formatDate(customer.nextDueDate)}</div>
      {customer.overdueCents > 0 ? (
        <div className="cust-contact" style={{ color: "var(--red)", fontWeight: 600 }}>
          {formatCents(customer.overdueCents)} overdue
        </div>
      ) : null}
    </>
  );
}

const Row = memo(function Row({ customer, variant }: { customer: CustomerSummary; variant: Props["variant"] }) {
  const { openCustomer } = useUi();
  return (
    <tr onClick={() => openCustomer(customer.id)}>
      <td>
        <button type="button" className="row-link">
          {customer.businessName}
        </button>
        {customer.contactName ? <div className="cust-contact">{customer.contactName}</div> : null}
      </td>
      <td>
        <StatusBadge status={customer.status} />
      </td>
      <td className="mono">{customer.creditLimitCents ? formatCents(customer.creditLimitCents) : "—"}</td>
      <td className="mono">{formatCents(customer.balanceCents)}</td>
      {variant === "recent" ? (
        <td style={{ color: "var(--text-dim)", fontSize: 12 }}>{formatDate(todayISO(new Date(customer.updatedAt)))}</td>
      ) : (
        <>
          <td>
            {customer.status === "approved" && customer.creditLimitCents ? (
              <UtilBar pct={customer.utilizationPct} level={customer.utilizationLevel} />
            ) : (
              <span style={{ color: "var(--text-faint)" }}>—</span>
            )}
          </td>
          <td>
            <NextDue customer={customer} />
          </td>
        </>
      )}
    </tr>
  );
});

function SkeletonRows({ columns }: { columns: number }) {
  return (
    <>
      {[0, 1, 2, 3].map((row) => (
        <tr key={row} aria-hidden="true" style={{ cursor: "default" }}>
          {Array.from({ length: columns }, (_, cell) => (
            <td key={cell}>
              <div className="skeleton" style={{ width: cell === 0 ? "70%" : "50%" }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function CustomerTable({ customers, variant, loading, sort, onSort, caption }: Props) {
  const columns = variant === "full" ? FULL_COLUMNS.length : RECENT_COLUMNS.length;
  return (
    <div className="table-wrap">
      <table aria-busy={loading ? true : undefined}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {variant === "full"
              ? FULL_COLUMNS.map((column) => (
                  <th key={column.key} scope="col" aria-sort={ariaSort(sort, column.key)}>
                    <button type="button" className="th-sort" onClick={() => onSort?.(column.key)}>
                      {column.label}
                      <span className="arrow" aria-hidden="true">
                        {sort?.key === column.key ? (sort.direction === "asc" ? "▲" : "▼") : ""}
                      </span>
                    </button>
                  </th>
                ))
              : RECENT_COLUMNS.map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
          </tr>
        </thead>
        <tbody>
          {loading ? <SkeletonRows columns={columns} /> : customers.map((customer) => <Row key={customer.id} customer={customer} variant={variant} />)}
          {!loading && customers.length === 0 ? (
            <tr style={{ cursor: "default" }}>
              <td colSpan={columns} style={{ color: "var(--text-faint)", textAlign: "center", padding: 26 }}>
                No customers to show.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
