"use client";

import { memo } from "react";
import { PHONE_QUERY, useMediaQuery } from "@/lib/client/media";
import type { SortDirection, SortKey } from "@/lib/domain/customer-list";
import { formatCents } from "@/lib/domain/money";
import { dateInZone, formatDate } from "@/lib/domain/dates";
import { useBusinessTimeZone } from "@/lib/client/queries";
import { hasCreditLine } from "@/lib/domain/status";
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
  { key: "limit", label: "Credit limit", numeric: true },
  { key: "balance", label: "Balance", numeric: true },
  { key: "utilization", label: "Utilization" },
  { key: "nextDue", label: "Next payment due" },
];

const RECENT_COLUMNS = ["Business", "Status", "Credit limit", "Balance", "Updated"] as const;

function ariaSort(sort: SortState | undefined, key: SortKey): "ascending" | "descending" | "none" {
  if (!sort || sort.key !== key) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
}

/** An empty cell: a dash for the eye, and the word "none" for a screen reader (which would read a dash as nothing or "dash"). */
function None() {
  return (
    <span style={{ color: "var(--text-faint)" }}>
      <span aria-hidden="true">—</span>
      <span className="sr-only">none</span>
    </span>
  );
}

/**
 * The next due date (only for an account with a credit line) and any overdue amount. Overdue money is shown WHATEVER the status:
 * a denied or reopened customer who still owes it is exactly who someone needs to see. The table and the phone cards share this.
 */
function NextDue({ customer }: { customer: CustomerSummary }) {
  const due = hasCreditLine(customer.status) && customer.nextDueDate ? customer.nextDueDate : null;
  if (!due && customer.overdueCents <= 0) return <None />;
  return (
    <>
      {due ? <div>{formatDate(due)}</div> : <None />}
      {customer.overdueCents > 0 ? (
        <div className="cust-contact" style={{ color: "var(--red)", fontWeight: 600 }}>
          {formatCents(customer.overdueCents)} overdue
        </div>
      ) : null}
    </>
  );
}

const Row = memo(function Row({ customer, variant, timeZone }: { customer: CustomerSummary; variant: Props["variant"]; timeZone: string }) {
  const { openCustomer } = useUi();
  return (
    <tr onClick={() => openCustomer(customer.id)}>
      <th scope="row" className="row-head">
        <button type="button" className="row-link">
          {customer.businessName}
        </button>
        {customer.contactName ? <div className="cust-contact">{customer.contactName}</div> : null}
      </th>
      <td>
        <StatusBadge status={customer.status} />
      </td>
      <td className="mono num">{customer.creditLimitCents ? formatCents(customer.creditLimitCents) : <None />}</td>
      <td className="mono num">{formatCents(customer.balanceCents)}</td>
      {variant === "recent" ? (
        <td style={{ color: "var(--text-dim)", fontSize: 12 }}>{formatDate(dateInZone(new Date(customer.updatedAt), timeZone))}</td>
      ) : (
        <>
          <td>
            {customer.status === "approved" && customer.creditLimitCents ? (
              <UtilBar pct={customer.utilizationPct} level={customer.utilizationLevel} />
            ) : (
              <None />
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

/** One customer as a card. Memoized like the table row, so typing in the search box does not rebuild every card. */
const CardItem = memo(function CardItem({ customer }: { customer: CustomerSummary }) {
  const { openCustomer } = useUi();
  return (
    <li>
      <button type="button" className="cust-card" onClick={() => openCustomer(customer.id)}>
        <span className="cust-card-top">
          <b>{customer.businessName}</b>
          <StatusBadge status={customer.status} />
        </span>
        <span className="cust-card-grid">
          <span>
            <span className="kv-label">Balance</span>
            <span className="mono">{formatCents(customer.balanceCents)}</span>
          </span>
          <span>
            <span className="kv-label">Credit limit</span>
            <span className="mono">{customer.creditLimitCents ? formatCents(customer.creditLimitCents) : "none"}</span>
          </span>
          <span>
            <span className="kv-label">Next payment due</span>
            <span>
              <NextDue customer={customer} />
            </span>
          </span>
        </span>
      </button>
    </li>
  );
});

/** On a phone the table is replaced by a card per customer: the columns that matter, with no sideways scrolling. */
function CustomerCards({ customers, caption }: { customers: readonly CustomerSummary[]; caption: string }) {
  return (
    <ul className="cust-cards" aria-label={caption}>
      {customers.length === 0 ? <li className="cust-empty">No customers to show.</li> : null}
      {customers.map((customer) => (
        <CardItem key={customer.id} customer={customer} />
      ))}
    </ul>
  );
}

export function CustomerTable({ customers, variant, loading, sort, onSort, caption }: Props) {
  const timeZone = useBusinessTimeZone();
  const columns = variant === "full" ? FULL_COLUMNS.length : RECENT_COLUMNS.length;
  const phone = useMediaQuery(PHONE_QUERY);
  // ONE layout is built, not both with CSS hiding one: on a long list every customer used to be in the page twice.
  if (phone && !loading) return <CustomerCards customers={customers} caption={caption} />;
  return (
    <>
    <div className="table-wrap">
      <table aria-busy={loading ? true : undefined}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {variant === "full"
              ? FULL_COLUMNS.map((column) => (
                  <th key={column.key} scope="col" className={column.numeric ? "num" : undefined} aria-sort={ariaSort(sort, column.key)}>
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
          {loading ? <SkeletonRows columns={columns} /> : customers.map((customer) => <Row key={customer.id} customer={customer} variant={variant} timeZone={timeZone} />)}
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
    </>
  );
}
